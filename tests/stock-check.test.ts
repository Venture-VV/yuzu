// 8.1.10 核库转领用（docs/ERP_V8110.md 第 2 节，PENDING_DECISIONS CK8–CK17；迁移 185）：
//   · 提交（要主管确认的在主管确认以后）时：选了物料、总仓有货的进「待核库」；标了急的、手填新品、总仓没货的、开关关着的不核；
//   · 核库没完采购不能通过、不能退回，也不在待审核里；库管（物资经办）看得到、核得了，部门申购核不了；
//   · 库管逐行领用（能只领一部分）、替代、转采购：领用的行一起开一张部门领料单、马上生效；全部领用的变成「已转领用」；
//   · 部门答复替代：同意开领料单（经办人记提议的库管），总仓不够了改成转采购；不用照原来买；
//   · 超时：没核完的转采购，替代没答复的照原来买；领用过的行不能再改、不能退回修改；领料单冲销了的照原来买；
//   · 操作编号：原样重提照旧，内容不同拒绝，确认作废以后不登记；并发核库只有一个成。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PurchaseRequest, RequestsList } from '../src/shared/requests';
import { requestStatusLabel } from '../src/shared/requests';
import type { PurchaseFlow } from '../src/shared/purchase-flow';
import { todayIn } from '../src/server/modules/inventory/common';
import { sweepStockChecks } from '../src/server/modules/request-stock';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string; // 李晓（物资）：核库
let keeperId: number;
let buyer: string; // 周一（采购）：审核、转采购单
let req: string; // 前厅申购
let other: string; // 别的部门的申购
let deptId: number;
let supplierId: number;
const mats: Record<'A' | 'B' | 'C' | 'S', { id: number; name: string }> = {} as never;
const q = (n: number) => Math.round(n * 1000);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function ok<T = any>(res: Promise<{ status: number; body: any }>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
}
const setRules = (patch: Record<string, unknown>) => ok(api(ctx.app, ctx.owner, 'PUT', '/api/inventory/purchase-rules', patch));
type Line = { materialId: number | null; name: string; qtyMilli: number; unit: string; link?: string; imageIds?: number[] };
const submit = async (lines: Line[], extra: Record<string, unknown> = {}, cookie = req) =>
  (await ok<{ request: PurchaseRequest }>(api(ctx.app, cookie, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines: lines.map((l) => ({ purpose: '客用消耗', ...l })), ...extra }), 201))
    .request;
const get = (cookie: string, id: number) => ok<PurchaseRequest>(api(ctx.app, cookie, 'GET', `/api/erp/requests/${id}`));
const check = (id: number, lines: unknown[], key = randomUUID(), cookie = keeper) => api(ctx.app, cookie, 'POST', `/api/erp/requests/${id}/stock-check`, { clientKey: key, lines });
const answer = (id: number, lineId: number, accept: boolean, cookie = req, key = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/erp/requests/${id}/lines/${lineId}/substitute`, { clientKey: key, accept });
const act = (cookie: string, id: number, action: string, body: Record<string, unknown> = {}) => api(ctx.app, cookie, 'POST', `/api/erp/requests/${id}/${action}`, body);
const central = async (id: number) => Number((await ctx.sql<{ s: number }[]>`SELECT stock_milli AS s FROM materials WHERE id = ${id}`)[0]!.s);
const deptStock = async (materialId: number) =>
  Number(
    (
      await ctx.sql<{ s: number }[]>`
        SELECT coalesce((SELECT ws.stock_milli FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
                         WHERE w.department_id = ${deptId} AND ws.material_id = ${materialId}), 0) AS s`
    )[0]!.s,
  );
const purchase = (l: { id: number }) => ({ lineId: l.id, decision: 'purchase' });

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  // 这里验证核库：把用例基线里关着的「提需核库」打开
  await setRules({ stockCheckEnabled: true });
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  keeperId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'lixiao'`)[0]!.id);
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  await api(ctx.app, ctx.owner, 'POST', '/api/inventory/departments', { name: '前厅' });
  await api(ctx.app, ctx.owner, 'POST', '/api/inventory/departments', { name: '核库别的部门' });
  const depts = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[];
  deptId = depts.find((d) => d.name === '前厅')!.id;
  const otherDept = depts.find((d) => d.name === '核库别的部门')!.id;
  await createStaff(ctx.sql, { username: 'sc_req', displayName: '前厅阿美', role: 'backoffice', duties: ['request'], departmentId: deptId, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'sc_other', displayName: '别部门小王', role: 'backoffice', duties: ['request'], departmentId: otherDept, password: PASSWORD, mustChangePassword: false });
  req = await login(ctx.app, 'sc_req');
  other = await login(ctx.app, 'sc_other');
  const mat = async (key: 'A' | 'B' | 'C' | 'S', code: string, name: string, inventoryUnit: string, purchaseUnit: string, factor: number, stock: number) => {
    const m = await ok<{ id: number }>(api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code, name, inventoryUnit, purchaseUnit, purchaseFactorMilli: q(factor) }), 201);
    mats[key] = { id: m.id, name };
    if (stock > 0) {
      const d = await ok<{ doc: { status: string } }>(
        api(ctx.app, ctx.owner, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docType: 'opening', docDate: today, approveNow: true, lines: [{ materialId: m.id, qtyMilli: q(stock) }] }),
        201,
      );
      expect(d.doc.status).toBe('confirmed');
    }
  };
  await mat('A', 'SC-A', '核库纸巾', '包', '箱', 20, 200); // 1 箱 = 20 包，总仓 200 包
  await mat('B', 'SC-B', '核库洗手液', '瓶', '瓶', 1, 30);
  await mat('C', 'SC-C', '核库拖鞋', '双', '包', 10, 0); // 总仓没有
  await mat('S', 'SC-S', '核库替代纸巾', '包', '包', 1, 60);
  const list = (await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'SC01', name: '核库测试供应商' })).body as { id: number; code: string }[];
  supplierId = list.find((x) => x.code === 'SC01')!.id;
}, 120_000);
afterAll(async () => ctx.close());

describe('什么时候核库（CK13）', () => {
  it('选了物料、总仓有货的进待核库；标了急的、手填新品、总仓没货的、开关关着的直接待审核；总仓结存部门也看得到', async () => {
    const r = await submit([{ materialId: mats.A.id, name: mats.A.name, qtyMilli: q(2), unit: '箱' }]);
    expect(r).toMatchObject({ status: 'submitted', stockCheck: 'pending', canStockCheck: false, canAnswerSubstitute: false });
    expect(r.stockCheckSince).not.toBeNull();
    expect(requestStatusLabel(r)).toBe('待核库');
    // 200 包 = 10 箱
    expect(r.lines[0]!.centralStock).toEqual({ stockMilli: q(200), inventoryUnit: '包', purchaseUnit: '箱', factorMilli: q(20), convertible: true, lineQtyMilli: q(10) });

    expect((await submit([{ materialId: mats.A.id, name: mats.A.name, qtyMilli: q(2), unit: '箱' }], { priority: 'urgent' })).stockCheck).toBe('skipped');
    expect((await submit([{ materialId: mats.C.id, name: mats.C.name, qtyMilli: q(1), unit: '包' }])).stockCheck).toBe('skipped');
    const image = await ok<{ id: number }>(api(ctx.app, req, 'POST', '/api/erp/images', { mime: 'image/png', data: PNG }), 201);
    const fresh = await submit([{ materialId: null, name: '香薰石', qtyMilli: q(1), unit: '个', link: 'https://example.com/x', imageIds: [image.id] }]);
    expect(fresh.stockCheck).toBe('skipped');
    expect(fresh.lines[0]!.centralStock).toBeNull();
    await setRules({ stockCheckEnabled: false });
    expect((await submit([{ materialId: mats.A.id, name: mats.A.name, qtyMilli: q(2), unit: '箱' }])).stockCheck).toBe('skipped');
    await setRules({ stockCheckEnabled: true });
  });

  it('要主管确认的：主管确认以后才进待核库', async () => {
    const [dept] = (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/departments?all=1')).body.filter((d: { id: number }) => d.id === deptId);
    const headId = await createStaff(ctx.sql, { username: 'sc_head', displayName: '前厅主管', role: 'backoffice', duties: ['request'], password: PASSWORD, mustChangePassword: false });
    await ok(api(ctx.app, ctx.owner, 'PUT', `/api/inventory/departments/${deptId}`, { name: dept.name, active: true, sortOrder: dept.sortOrder, headId }));
    await setRules({ deptConfirm: 'all' });
    try {
      const r = await submit([{ materialId: mats.B.id, name: mats.B.name, qtyMilli: q(1), unit: '瓶' }]);
      expect(r).toMatchObject({ stockCheck: 'none', deptConfirm: { state: 'pending' } });
      expect(requestStatusLabel(r)).toBe('待主管确认');
      const head = await login(ctx.app, 'sc_head');
      const confirmed = await ok<PurchaseRequest>(act(head, r.id, 'dept-confirm'));
      expect(confirmed).toMatchObject({ stockCheck: 'pending', deptConfirm: { state: 'confirmed' } });
    } finally {
      await setRules({ deptConfirm: 'off' });
      await ok(api(ctx.app, ctx.owner, 'PUT', `/api/inventory/departments/${deptId}`, { name: dept.name, active: true, sortOrder: dept.sortOrder, headId: null }));
    }
  });

  it('核库没完：采购通过、退回都拦，待审核里没有、待核库里有；库管看得到（别的部门的也看得到）、核得了，部门申购核不了；待办数', async () => {
    const r = await submit([{ materialId: mats.A.id, name: mats.A.name, qtyMilli: q(1), unit: '箱' }]);
    expect((await act(buyer, r.id, 'approve')).body.error.code).toBe('STOCK_CHECK_PENDING');
    expect((await act(buyer, r.id, 'return', { reason: '先退回' })).body.error.code).toBe('STOCK_CHECK_PENDING');
    const review = await ok<RequestsList>(api(ctx.app, buyer, 'GET', '/api/erp/requests?status=submitted'));
    expect(review.requests.some((x) => x.id === r.id)).toBe(false);
    const queue = await ok<RequestsList>(api(ctx.app, keeper, 'GET', '/api/erp/requests?stock=open'));
    expect(queue.requests.find((x) => x.id === r.id)).toMatchObject({ stockCheck: 'pending' });
    expect(queue.me.canStock).toBe(true);
    expect((await get(keeper, r.id)).canStockCheck).toBe(true);
    expect((await get(buyer, r.id)).canStockCheck).toBe(false);
    // 部门申购（没有核库权限）：核不了，也看不到别的部门的需求单
    expect((await check(r.id, [purchase(r.lines[0]!)], randomUUID(), req)).status).toBe(403);
    expect((await api(ctx.app, other, 'GET', `/api/erp/requests/${r.id}`)).status).toBe(404);
    expect((await ok<{ stockChecks: number }>(api(ctx.app, keeper, 'GET', '/api/inventory/supply-todo'))).stockChecks).toBeGreaterThanOrEqual(1);
  });
});

describe('库管核库（CK14）', () => {
  it('领用（按采购单位只领一部分）、整行领用、转采购：开一张部门领料单马上生效，剩下的进采购审核；待转采购单默认买剩下的，整行领用的不能再转采购单', async () => {
    const r = await submit([
      { materialId: mats.A.id, name: mats.A.name, qtyMilli: q(3), unit: '箱' },
      { materialId: mats.B.id, name: mats.B.name, qtyMilli: q(4), unit: '瓶' },
      { materialId: mats.C.id, name: mats.C.name, qtyMilli: q(2), unit: '包' },
    ]);
    expect(r.stockCheck).toBe('pending');
    const [la, lb, lc] = r.lines;
    const a0 = await central(mats.A.id);
    const b0 = await central(mats.B.id);
    const done = (await ok<{ request: PurchaseRequest }>(check(r.id, [{ lineId: la!.id, decision: 'issue', qtyMilli: q(2) }, { lineId: lb!.id, decision: 'issue', qtyMilli: q(4) }, purchase(lc!)])))
      .request;
    expect(done).toMatchObject({ status: 'submitted', stockCheck: 'done', stockCheckedByName: '李晓（物资）' });
    expect(requestStatusLabel(done)).toBe('待审核');
    const doc = done.lines[0]!.stock!.issueDoc!;
    expect(done.lines[0]!.stock).toMatchObject({ decision: 'issue', issuedQtyMilli: q(2), issueDoc: { docNo: expect.stringMatching(/^LY/), voided: false } });
    expect(done.lines[1]!.stock).toMatchObject({ decision: 'issue', issuedQtyMilli: q(4), issueDoc: { id: doc.id } });
    expect(done.lines[2]!.stock).toMatchObject({ decision: 'purchase', issuedQtyMilli: 0, issueDoc: null });
    expect(done.lines[1]!.progress.state).toBe('issued');
    expect(done.lines[0]!.progress.state).toBe('none');
    // 领料单：总仓出、前厅小仓进；2 箱 = 40 包，记着录入的 2 箱；领料人是提单人
    expect(await central(mats.A.id)).toBe(a0 - q(40));
    expect(await central(mats.B.id)).toBe(b0 - q(4));
    expect(await deptStock(mats.A.id)).toBe(q(40));
    const [d] = await ctx.sql<{ status: string; docType: string; departmentId: number; handler: string; createdBy: number }[]>`
      SELECT status, doc_type, department_id, handler, created_by FROM inv_docs WHERE id = ${doc.id}`;
    expect(d).toMatchObject({ status: 'confirmed', docType: 'issue', handler: '前厅阿美' });
    expect(Number(d!.departmentId)).toBe(deptId);
    expect(Number(d!.createdBy)).toBe(keeperId);
    const docLines = await ctx.sql<{ materialId: number; qtyMilli: number; enteredQtyMilli: number | null; enteredUnit: string | null }[]>`
      SELECT material_id, qty_milli, entered_qty_milli, entered_unit FROM inv_doc_lines WHERE doc_id = ${doc.id} ORDER BY line_no`;
    expect(docLines.map((x) => [Number(x.materialId), Number(x.qtyMilli), x.enteredQtyMilli === null ? null : Number(x.enteredQtyMilli), x.enteredUnit])).toEqual([
      [mats.A.id, q(40), q(2), '箱'],
      [mats.B.id, q(4), null, null],
    ]);
    expect(done.approvals.at(-1)).toMatchObject({ action: 'stock', actorName: '李晓（物资）', reason: expect.stringContaining(doc.docNo) });

    // 采购通过；待转采购单：A 还要买 1 箱（已领 2），B 整行领用了不再列，C 照原来
    await ok(act(buyer, r.id, 'approve'));
    const open = await ok<{ id: number; issuedQtyMilli: number; qtyMilli: number }[]>(api(ctx.app, buyer, 'GET', `/api/erp/requests/open-lines?ids=${r.lines.map((l) => l.id).join(',')}`));
    expect(open.map((o) => [o.id, o.issuedQtyMilli])).toEqual([
      [la!.id, q(2)],
      [lc!.id, 0],
    ]);
    const po = await api(ctx.app, buyer, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId,
      orderDate: today,
      lines: [{ materialId: mats.B.id, purchaseQtyMilli: q(4), priceCents: 1_000, requestLineIds: [lb!.id] }],
    });
    expect(po.body.error?.code, JSON.stringify(po.body)).toBe('REQUEST_LINE_ISSUED');
    // 部分领用的行照常能转采购单
    const po2 = await api(ctx.app, buyer, 'POST', '/api/purchase-orders', {
      clientKey: randomUUID(),
      supplierId,
      orderDate: today,
      lines: [{ materialId: mats.A.id, purchaseQtyMilli: q(1), priceCents: 1_000, requestLineIds: [la!.id] }],
    });
    expect(po2.status, JSON.stringify(po2.body)).toBe(201);
  });

  it('全部领用：变成「已转领用」，不再进采购，不能再改；单位换算不了的整行领用、按库存单位填；流程结束', async () => {
    const r = await submit([
      { materialId: mats.B.id, name: mats.B.name, qtyMilli: q(2), unit: '瓶' },
      { materialId: mats.B.id, name: '洗手液（按盒）', qtyMilli: q(1), unit: '盒' },
    ]);
    expect(r.lines[1]!.centralStock).toMatchObject({ convertible: false, lineQtyMilli: null });
    const done = (
      await ok<{ request: PurchaseRequest }>(
        check(r.id, [
          { lineId: r.lines[0]!.id, decision: 'issue', qtyMilli: q(2) },
          { lineId: r.lines[1]!.id, decision: 'issue', qtyMilli: q(3) }, // 1 盒按 3 瓶领
        ]),
      )
    ).request;
    expect(done).toMatchObject({ status: 'issued', stockCheck: 'done' });
    expect(requestStatusLabel(done)).toBe('已转领用');
    expect(done.lines[1]!.stock).toMatchObject({ issuedQtyMilli: q(1) });
    expect(done.lines.map((l) => l.progress.state)).toEqual(['issued', 'issued']);
    expect(done.approvals.at(-1)!.reason).toContain('全部领用');
    expect((await act(buyer, r.id, 'approve')).body.error.code).toBe('INVALID_STATE');
    const edit = await api(ctx.app, req, 'PUT', `/api/erp/requests/${r.id}`, { lines: [{ materialId: mats.B.id, name: mats.B.name, purpose: '客用消耗', qtyMilli: q(1), unit: '瓶' }] });
    expect(edit.status).toBe(409);
    expect((await ok<RequestsList>(api(ctx.app, req, 'GET', '/api/erp/requests?status=issued'))).requests.some((x) => x.id === r.id)).toBe(true);
    const flow = await ok<PurchaseFlow>(api(ctx.app, buyer, 'GET', `/api/purchase-flow/one?kind=request&id=${r.id}`));
    expect(flow.end).toBe('done');
    expect(flow.endText).toContain('领用');
  });

  it('校验：每一行都要选；领的不超过申请数量与总仓结存；替代要换一种物料；手填新品不核', async () => {
    const r = await submit([
      { materialId: mats.A.id, name: mats.A.name, qtyMilli: q(1), unit: '箱' },
      { materialId: mats.B.id, name: mats.B.name, qtyMilli: q(500), unit: '瓶' },
    ]);
    const [la, lb] = r.lines;
    expect((await check(r.id, [purchase(la!)])).body.error.code).toBe('STOCK_LINE_MISSING');
    expect((await check(r.id, [{ lineId: la!.id, decision: 'issue', qtyMilli: q(2) }, purchase(lb!)])).body.error.code).toBe('ISSUE_EXCEEDS_REQUEST');
    expect((await check(r.id, [purchase(la!), { lineId: lb!.id, decision: 'issue', qtyMilli: q(400) }])).body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await check(r.id, [{ lineId: la!.id, decision: 'substitute', materialId: mats.A.id, qtyMilli: q(10) }, purchase(lb!)])).status).toBe(400);
    expect((await check(r.id, [{ lineId: 999_999, decision: 'purchase' }, purchase(la!), purchase(lb!)])).body.error.code).toBe('STOCK_LINES_CHANGED');
    // 都没写进去：还是待核库
    expect((await get(keeper, r.id)).stockCheck).toBe('pending');
  });
});

describe('部门答复替代（CK15）', () => {
  it('同意：按提议开领料单（经办人记提议的库管）；不用：照原来买；都答复以后进采购审核；别的部门、采购答复不了', async () => {
    const r = await submit([
      { materialId: mats.A.id, name: mats.A.name, qtyMilli: q(1), unit: '箱' },
      { materialId: mats.B.id, name: mats.B.name, qtyMilli: q(1), unit: '瓶' },
    ]);
    const [la, lb] = r.lines;
    const proposed = (
      await ok<{ request: PurchaseRequest }>(
        check(r.id, [
          { lineId: la!.id, decision: 'substitute', materialId: mats.S.id, qtyMilli: q(20) },
          { lineId: lb!.id, decision: 'substitute', materialId: mats.S.id, qtyMilli: q(5) },
        ]),
      )
    ).request;
    expect(proposed.stockCheck).toBe('confirming');
    expect(requestStatusLabel(proposed)).toBe('待部门确认替代');
    expect(proposed.lines[0]!.stock).toMatchObject({ decision: 'substitute', substitute: { materialId: mats.S.id, qtyMilli: q(20), unit: '包', state: 'pending' } });
    expect((await get(req, r.id)).canAnswerSubstitute).toBe(true);
    expect((await get(buyer, r.id)).canAnswerSubstitute).toBe(false);
    expect((await act(buyer, r.id, 'approve')).body.error.code).toBe('STOCK_CHECK_PENDING');
    expect((await answer(r.id, la!.id, true, buyer)).status).toBe(403);
    expect((await answer(r.id, la!.id, true, other)).status).toBe(403);
    // 再核一次被拒（已经核过）
    expect((await check(r.id, [purchase(la!), purchase(lb!)])).body.error.code).toBe('STOCK_CHECK_CLOSED');

    const s0 = await central(mats.S.id);
    const yes = await ok<{ outcome: string; request: PurchaseRequest }>(answer(r.id, la!.id, true));
    expect(yes.outcome).toBe('accepted');
    expect(yes.request.stockCheck).toBe('confirming');
    expect(yes.request.lines[0]!.stock).toMatchObject({ substitute: { state: 'accepted' }, issuedQtyMilli: q(1), answeredByName: '前厅阿美' });
    expect(await central(mats.S.id)).toBe(s0 - q(20));
    const docId = yes.request.lines[0]!.stock!.issueDoc!.id;
    expect(Number((await ctx.sql<{ c: number }[]>`SELECT created_by AS c FROM inv_docs WHERE id = ${docId}`)[0]!.c)).toBe(keeperId);
    // 同一行再答复一次（换一个操作编号）被拒
    expect((await answer(r.id, la!.id, false)).body.error.code).toBe('SUBSTITUTE_ANSWERED');

    const no = await ok<{ outcome: string; request: PurchaseRequest }>(answer(r.id, lb!.id, false));
    expect(no.outcome).toBe('declined');
    expect(no.request).toMatchObject({ status: 'submitted', stockCheck: 'done' });
    expect(no.request.lines[1]!.stock).toMatchObject({ substitute: { state: 'declined' }, issuedQtyMilli: 0 });
    expect(no.request.lines[0]!.progress.state).toBe('issued');
    await ok(act(buyer, r.id, 'approve'));
  });

  it('同意时总仓不够了：这一行改成转采购（结果写原因），需求单照常往下走', async () => {
    const r = await submit([{ materialId: mats.A.id, name: mats.A.name, qtyMilli: q(1), unit: '箱' }]);
    await ok(check(r.id, [{ lineId: r.lines[0]!.id, decision: 'substitute', materialId: mats.S.id, qtyMilli: q(20) }]));
    // 别的领用先把替代品领到只剩 5 包
    const left = await central(mats.S.id);
    await ok(
      api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
        clientKey: randomUUID(),
        docType: 'issue',
        docDate: today,
        departmentId: deptId,
        handler: '前厅阿美',
        lines: [{ materialId: mats.S.id, qtyMilli: left - q(5) }],
      }),
      201,
    );
    const res = await ok<{ outcome: string; message: string; request: PurchaseRequest }>(answer(r.id, r.lines[0]!.id, true));
    expect(res.outcome).toBe('failed');
    expect(res.message).toContain('库存不足');
    expect(res.request).toMatchObject({ status: 'submitted', stockCheck: 'done' });
    expect(res.request.lines[0]!.stock).toMatchObject({ substitute: { state: 'failed' }, issueDoc: null, issuedQtyMilli: 0 });
    expect(await central(mats.S.id)).toBe(q(5));
  });
});

describe('操作编号', () => {
  it('原样重提照旧，内容不同拒绝；确认作废以后不登记；两个人同时核库只有一个成', async () => {
    const r = await submit([{ materialId: mats.B.id, name: mats.B.name, qtyMilli: q(1), unit: '瓶' }]);
    const l = r.lines[0]!;
    // 确认作废的编号不登记
    const fenced = randomUUID();
    await ok(api(ctx.app, keeper, 'POST', `/api/erp/ops/${fenced}/abandon`, { type: 'request_stock' }));
    expect((await check(r.id, [purchase(l)], fenced)).body.error.code).toBe('OP_ABANDONED');

    const key = randomUUID();
    const first = await ok<{ request: PurchaseRequest }>(check(r.id, [{ lineId: l.id, decision: 'issue', qtyMilli: q(1) }], key));
    const b1 = await central(mats.B.id);
    const again = await ok<{ request: PurchaseRequest }>(check(r.id, [{ lineId: l.id, decision: 'issue', qtyMilli: q(1) }], key));
    expect(again.request.lines[0]!.stock!.issueDoc!.id).toBe(first.request.lines[0]!.stock!.issueDoc!.id);
    expect(await central(mats.B.id)).toBe(b1);
    expect((await check(r.id, [purchase(l)], key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const found = await ok<{ found: boolean; refId: number }>(api(ctx.app, keeper, 'GET', `/api/erp/ops/${key}?type=request_stock`));
    expect(found).toMatchObject({ found: true, refId: r.id });

    const r2 = await submit([{ materialId: mats.B.id, name: mats.B.name, qtyMilli: q(1), unit: '瓶' }]);
    const both = await Promise.all([check(r2.id, [purchase(r2.lines[0]!)]), check(r2.id, [purchase(r2.lines[0]!)], randomUUID(), ctx.owner)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(both.find((x) => x.status === 409)!.body.error.code).toBe('STOCK_CHECK_CLOSED');
    expect(Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM request_line_stock WHERE request_id = ${r2.id}`)[0]!.n)).toBe(1);
  });
});

describe('超时、修改、退回、撤回、冲销', () => {
  it('超过核库时限没核完的转采购（系统记一笔），替代没答复的照原来买', async () => {
    const r = await submit([{ materialId: mats.B.id, name: mats.B.name, qtyMilli: q(1), unit: '瓶' }]);
    await ctx.sql`UPDATE purchase_requests SET stock_check_since = now() - interval '25 hours' WHERE id = ${r.id}`;
    const s = await submit([{ materialId: mats.A.id, name: mats.A.name, qtyMilli: q(1), unit: '箱' }]);
    await ok(check(s.id, [{ lineId: s.lines[0]!.id, decision: 'substitute', materialId: mats.S.id, qtyMilli: q(1) }]));
    await ctx.sql`UPDATE request_line_stock SET decided_at = now() - interval '25 hours' WHERE request_id = ${s.id}`;
    const run = await sweepStockChecks({ sql: ctx.sql });
    expect(run.timedOut).toBeGreaterThanOrEqual(1);
    expect(run.expired).toBeGreaterThanOrEqual(1);
    const timedOut = await get(buyer, r.id);
    expect(timedOut).toMatchObject({ stockCheck: 'timeout', status: 'submitted' });
    expect(timedOut.approvals.at(-1)).toMatchObject({ action: 'stock', reason: expect.stringContaining('24 小时') });
    await ok(act(buyer, r.id, 'approve'));
    const expired = await get(buyer, s.id);
    expect(expired.stockCheck).toBe('done');
    expect(expired.lines[0]!.stock!.substitute!.state).toBe('expired');
    // 再跑一次什么都不做
    expect(await sweepStockChecks({ sql: ctx.sql })).toEqual({ timedOut: 0, expired: 0 });
  });

  it('待核库、待确认替代时提单人改了：核库结果清掉、重新进待核库；领用过的不能改、不能退回修改（可以不采购）；撤回时收掉核库', async () => {
    const r = await submit([{ materialId: mats.A.id, name: mats.A.name, qtyMilli: q(1), unit: '箱' }]);
    await ok(check(r.id, [{ lineId: r.lines[0]!.id, decision: 'substitute', materialId: mats.S.id, qtyMilli: q(1) }]));
    const edited = await ok<PurchaseRequest>(
      api(ctx.app, req, 'PUT', `/api/erp/requests/${r.id}`, { lines: [{ materialId: mats.A.id, name: mats.A.name, purpose: '客用消耗', qtyMilli: q(2), unit: '箱' }] }),
    );
    expect(edited.stockCheck).toBe('pending');
    expect(edited.lines[0]!.stock).toBeNull();

    // 部分领用以后：改、退回都拦；不采购可以
    await ok(check(r.id, [{ lineId: edited.lines[0]!.id, decision: 'issue', qtyMilli: q(1) }]));
    const locked = await api(ctx.app, req, 'PUT', `/api/erp/requests/${r.id}`, { lines: [{ materialId: mats.A.id, name: mats.A.name, purpose: '客用消耗', qtyMilli: q(1), unit: '箱' }] });
    expect(locked.body.error.code).toBe('STOCK_ISSUED_LOCKED');
    expect((await act(buyer, r.id, 'return', { reason: '数量不对' })).body.error.code).toBe('STOCK_ISSUED_LOCKED');
    const rejected = await ok<PurchaseRequest>(act(buyer, r.id, 'reject', { reason: '剩下的不买了' }));
    expect(rejected.status).toBe('rejected');
    expect(rejected.lines[0]!.stock!.issueDoc).not.toBeNull();

    // 待核库时撤回：核库收掉（不用核了），不再出现在待核库里
    const c = await submit([{ materialId: mats.B.id, name: mats.B.name, qtyMilli: q(1), unit: '瓶' }]);
    const cancelled = await ok<PurchaseRequest>(act(req, c.id, 'cancel', { reason: '不要了' }));
    expect(cancelled).toMatchObject({ status: 'cancelled', stockCheck: 'skipped' });
    expect((await ok<RequestsList>(api(ctx.app, keeper, 'GET', '/api/erp/requests?stock=open'))).requests.some((x) => x.id === c.id)).toBe(false);
    // 待确认替代时撤回：没答复的替代记成没回
    const d = await submit([{ materialId: mats.A.id, name: mats.A.name, qtyMilli: q(1), unit: '箱' }]);
    await ok(check(d.id, [{ lineId: d.lines[0]!.id, decision: 'substitute', materialId: mats.S.id, qtyMilli: q(1) }]));
    const dc = await ok<PurchaseRequest>(act(req, d.id, 'cancel', { reason: '不要了' }));
    expect(dc).toMatchObject({ status: 'cancelled', stockCheck: 'done' });
    expect(dc.lines[0]!.stock!.substitute!.state).toBe('expired');
  });

  it('领料单冲销了：这一行不再算领用，转采购单照原来的数量；需求单上写着冲销了；已领用的核库结果数据库不让改', async () => {
    const r = await submit([{ materialId: mats.A.id, name: mats.A.name, qtyMilli: q(2), unit: '箱' }]);
    const done = (await ok<{ request: PurchaseRequest }>(check(r.id, [{ lineId: r.lines[0]!.id, decision: 'issue', qtyMilli: q(1) }]))).request;
    await ok(act(buyer, r.id, 'approve'));
    const docId = done.lines[0]!.stock!.issueDoc!.id;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/inventory/docs/${docId}/void`, { reason: '领错了' })).status).toBe(200);
    const after = await get(buyer, r.id);
    expect(after.lines[0]!.stock!.issueDoc!.voided).toBe(true);
    const open = await ok<{ id: number; issuedQtyMilli: number }[]>(api(ctx.app, buyer, 'GET', `/api/erp/requests/open-lines?ids=${r.lines[0]!.id}`));
    expect(open).toEqual([expect.objectContaining({ id: r.lines[0]!.id, issuedQtyMilli: 0 })]);
    await expect(ctx.sql`UPDATE request_line_stock SET issued_qty_milli = 0 WHERE request_line_id = ${r.lines[0]!.id}`).rejects.toThrow(/已经从库存领用/);
    await expect(ctx.sql`DELETE FROM purchase_request_lines WHERE id = ${r.lines[0]!.id}`).rejects.toThrow();
  });
});
