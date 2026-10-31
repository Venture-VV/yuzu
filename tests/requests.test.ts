// 部门采购需求单与图片（v0.7.8，飞书需求 RQ-005 第二步，见 docs/REQUISITIONS.md）：
// 部门申购只能给本部门提、新产品必须有链接和图片、采购审核、转采购单与下单 / 到货 / 退货回写、
// 同一行需求不能被两张采购单转走、采购单行的规格与图片、员工所属部门、数据库兜底与自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 演示店主 linlan
let keeper: string; // 物资经办
let buyer: string; // 采购经办 + 对账付款（审核需求、转采购单）
let approver: string; // 负责人
let reqA: string; // 部门申购（采购部）
let reqNoDept: string; // 部门申购，没填所属部门
let reqB: string; // 部门申购（水吧）
let deptA: number;
let deptB: number;
let reqAId: number;
let supplierId: number;
let mat: { id: number; name: string };
let other: { id: number };
const q = (n: number) => Math.round(n * 1000);
// 最小的「JPEG」：文件头对就行（服务端只核对文件头与大小）
const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`yuzu-${seed}`)]).toString('base64');

const upload = async (cookie: string, seed: string) => (await api(ctx.app, cookie, 'POST', '/api/erp/images', { mime: 'image/jpeg', data: jpeg(seed) })).body as { id: number; url: string };

const newLine = (over: Record<string, unknown> = {}) => ({
  name: '香薰扩香石',
  purpose: '客用消耗',
  qtyMilli: q(10),
  unit: '个',
  link: 'https://example.com/item/1',
  details: '白色 6cm',
  refPriceCents: 1500,
  imageIds: [] as number[],
  ...over,
});

const submit = (cookie: string, lines: unknown[], body: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines, ...body });

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  await createStaff(ctx.sql, { username: 'appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  approver = await login(ctx.app, 'appr');
  const mk = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
  };
  deptA = await mk('采购部');
  deptB = await mk('水吧');
  reqAId = await createStaff(ctx.sql, { username: 'req_a', displayName: '采购部申购', role: 'backoffice', duties: ['request'], departmentId: deptA, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'req_none', displayName: '没部门', role: 'backoffice', duties: ['request'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'req_b', displayName: '水吧申购', role: 'backoffice', duties: ['request'], departmentId: deptB, password: PASSWORD, mustChangePassword: false });
  reqA = await login(ctx.app, 'req_a');
  reqNoDept = await login(ctx.app, 'req_none');
  reqB = await login(ctx.app, 'req_b');
  const sups = (await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; code: string }[];
  supplierId = sups.find((s) => s.code === 'S004')!.id;
  const mats = (await api(ctx.app, boss, 'GET', '/api/inventory/materials?all=1')).body as { id: number; code: string; name: string }[];
  mat = mats.find((m) => m.code === 'M016')!; // 一次性护理床单，1 箱 = 500 张
  other = mats.find((m) => m.code === 'M001')!;
}, 120_000);
afterAll(async () => ctx.close());

describe('图片', () => {
  it('核对文件头与大小；同一张图只存一份；要登录、要有权限才能看', async () => {
    const a = await upload(reqA, 'a');
    expect(a.url).toBe(`/api/erp/images/${a.id}`);
    expect((await upload(buyer, 'a')).id).toBe(a.id);
    const bad = await api(ctx.app, reqA, 'POST', '/api/erp/images', { mime: 'image/jpeg', data: Buffer.from('not an image at all').toString('base64') });
    expect(bad.body.error.code).toBe('IMAGE_INVALID');
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024 * 1024 + 10, 1)]).toString('base64');
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/images', { mime: 'image/jpeg', data: big })).status).toBeGreaterThanOrEqual(400);
    expect((await api(ctx.app, keeper, 'POST', '/api/erp/images', { mime: 'image/jpeg', data: jpeg('k') })).status).toBe(403);
    const res = await ctx.app.inject({ method: 'GET', url: a.url, headers: { cookie: keeper } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.rawPayload.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: a.url })).statusCode).toBe(401);
    expect((await api(ctx.app, ctx.clerk, 'GET', a.url)).status).toBe(403);
  });
});

describe('提需求单', () => {
  it('部门申购只能给本部门提；没填所属部门的提不了；新产品必须有链接和图片；用途是固定选项', async () => {
    const img = await upload(reqA, 'line-1');
    const noDept = await submit(reqNoDept, [newLine({ imageIds: [img.id] })]);
    expect(noDept.body.error.code).toBe('DEPARTMENT_REQUIRED');
    expect((await submit(reqA, [newLine({ imageIds: [img.id] })], { departmentId: deptB })).status).toBe(403);
    expect((await submit(reqA, [newLine({ link: '' , imageIds: [img.id] })])).body.error.code).toBe('LINK_REQUIRED');
    expect((await submit(reqA, [newLine()])).body.error.code).toBe('IMAGE_REQUIRED');
    expect((await submit(reqA, [newLine({ link: 'ftp://x', imageIds: [img.id] })])).body.error.code).toBe('LINK_REQUIRED');
    expect((await submit(reqA, [newLine({ purpose: '随便', imageIds: [img.id] })])).body.error.code).toBe('PURPOSE_INVALID');
    // 选了已有物料的可以不填链接和图片
    const ok = await submit(reqA, [newLine({ imageIds: [img.id] }), { materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: q(1), unit: '箱' }]);
    expect(ok.status).toBe(201);
    expect(ok.body.request).toMatchObject({ status: 'submitted', department: { id: deptA }, requester: { id: reqAId } });
    expect(ok.body.request.lines[0].images).toEqual([{ id: img.id, url: img.url }]);
    expect(ok.body.request.lines[1].progress.state).toBe('none');
    // 店主可以替任何部门提
    expect((await submit(boss, [newLine({ imageIds: [img.id] })], { departmentId: deptB })).body.request.department.id).toBe(deptB);
  });

  it('看得到：部门申购只看本部门的与自己提的；采购看全部；前台店员看不到', async () => {
    const img = await upload(reqB, 'b');
    const b = (await submit(reqB, [newLine({ name: '柠檬', imageIds: [img.id] })])).body.request;
    const listA = (await api(ctx.app, reqA, 'GET', '/api/erp/requests')).body;
    expect(listA.me).toMatchObject({ departmentId: deptA, canCreate: true, canReview: false });
    expect(listA.requests.every((r: { department: { id: number } }) => r.department.id === deptA)).toBe(true);
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/requests/${b.id}`)).status).toBe(404);
    const all = (await api(ctx.app, buyer, 'GET', '/api/erp/requests')).body;
    expect(all.me.canReview).toBe(true);
    expect(all.requests.some((r: { id: number }) => r.id === b.id)).toBe(true);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/requests')).status).toBe(403);
  });
});

describe('审核、转采购单、进度回写', () => {
  it('退回后改了再提交；通过后不能再改；转采购单后下单 / 到货 / 退货自动回写；采购单撤回后回到未下单', async () => {
    const img = await upload(reqA, 'flow');
    const created = (await submit(reqA, [newLine({ name: '一次性床单（新款）', materialId: mat.id, link: '', imageIds: [] , qtyMilli: q(2), unit: '箱' }), newLine({ imageIds: [img.id] })])).body.request;
    // 提单人不能审核
    expect((await api(ctx.app, reqA, 'POST', `/api/erp/requests/${created.id}/approve`, {})).status).toBe(403);
    const ret = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${created.id}/return`, { reason: '数量再确认' });
    expect(ret.body).toMatchObject({ status: 'returned', reason: '数量再确认' });
    // 别人不能改；提单人改了回到待审核
    expect((await api(ctx.app, reqB, 'PUT', `/api/erp/requests/${created.id}`, { lines: [newLine({ imageIds: [img.id] })] })).status).toBe(403);
    const edited = await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${created.id}`, {
      lines: [{ materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: q(2), unit: '箱' }, newLine({ imageIds: [img.id] })],
    });
    expect(edited.body).toMatchObject({ status: 'submitted' });
    const approved = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${created.id}/approve`, {});
    expect(approved.body).toMatchObject({ status: 'approved' });
    expect((await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${created.id}`, { lines: [newLine({ imageIds: [img.id] })] })).body.error.code).toBe('INVALID_STATE');
    expect((await api(ctx.app, reqA, 'POST', `/api/erp/requests/${created.id}/cancel`, { reason: '不要了' })).body.error.code).toBe('INVALID_STATE');
    await expect(ctx.sql`UPDATE purchase_request_lines SET qty_milli = 1 WHERE request_id = ${created.id}`).rejects.toThrow(/不能再改/);
    await expect(ctx.sql`DELETE FROM purchase_requests WHERE id = ${created.id}`).rejects.toThrow(/禁止删除/);

    const lineMat = approved.body.lines[0];
    const lineNew = approved.body.lines[1];
    const open = (await api(ctx.app, buyer, 'GET', '/api/erp/requests/open-lines')).body as { id: number }[];
    expect(open.map((l) => l.id)).toEqual(expect.arrayContaining([lineMat.id, lineNew.id]));
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/requests/open-lines')).status).toBe(403);

    const po = (lines: unknown[]) => api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, lines });
    // 物料对不上
    const mismatch = await po([{ materialId: other.id, purchaseQtyMilli: q(1), priceCents: 100, requestLineId: lineMat.id }]);
    expect(mismatch.body.error.code).toBe('REQUEST_MATERIAL_MISMATCH');
    // 新产品：采购选（或新建）一个物料
    const first = await po([
      { materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000, requestLineId: lineMat.id, spec: '白色 80×180', imageIds: [img.id] },
      { materialId: other.id, purchaseQtyMilli: q(1), priceCents: 1500, requestLineId: lineNew.id },
    ]);
    expect(first.status).toBe(201);
    const p1 = first.body.po;
    expect(p1.lines[0]).toMatchObject({ spec: '白色 80×180', requestLineId: lineMat.id, requestNo: created.docNo, images: [{ id: img.id, url: img.url }] });
    // 同一行需求不能被第二张采购单转走
    const dup = await po([{ materialId: mat.id, purchaseQtyMilli: q(1), priceCents: 45_000, requestLineId: lineMat.id }]);
    expect(dup.body.error.code).toBe('REQUEST_LINE_ORDERED');
    // 部门申购不能转采购单（也不能编采购单）
    expect((await api(ctx.app, reqA, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, lines: [{ materialId: mat.id, purchaseQtyMilli: q(1), priceCents: 1, requestLineId: lineMat.id }] })).status).toBe(403);

    let detail = (await api(ctx.app, reqA, 'GET', `/api/erp/requests/${created.id}`)).body;
    expect(detail.lines[0].progress).toMatchObject({ state: 'ordered', po: { id: p1.id, docNo: p1.docNo, status: 'submitted' }, orderedMilli: q(1000) });
    expect(detail.orderedLines).toBe(2);
    expect(((await api(ctx.app, buyer, 'GET', '/api/erp/requests/open-lines')).body as { id: number }[]).map((l) => l.id)).not.toContain(lineMat.id);

    // 采购单撤回：回到未下单，可以重新转
    await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${p1.id}/cancel`, { reason: '换供应商' });
    detail = (await api(ctx.app, reqA, 'GET', `/api/erp/requests/${created.id}`)).body;
    expect(detail.lines[0].progress.state).toBe('none');
    const second = (await po([{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000, requestLineId: lineMat.id }])).body.po;
    await api(ctx.app, approver, 'POST', `/api/purchase-orders/${second.id}/approve`, {});

    // 修改采购单（没带规格、图片）：保持原样；需求关联不变
    const withSpec = (await api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, action: 'save', lines: [{ materialId: other.id, purchaseQtyMilli: q(1), priceCents: 100, spec: '大号', imageIds: [img.id] }] })).body.po;
    const saved = await api(ctx.app, buyer, 'PUT', `/api/purchase-orders/${withSpec.id}`, { supplierId, orderDate: today, action: 'save', lines: [{ id: withSpec.lines[0].id, materialId: other.id, purchaseQtyMilli: q(2), priceCents: 100 }] });
    expect(saved.body.lines[0]).toMatchObject({ spec: '大号', images: [{ id: img.id }], purchaseQtyMilli: q(2) });

    // 收货：部分到货 → 到齐；退供应商回写退货数量
    const receive = (accepted: number) =>
      api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
        clientKey: randomUUID(),
        docType: 'receipt',
        docDate: today,
        supplierId,
        purchaseOrderId: second.id,
        lines: [{ materialId: mat.id, poLineId: second.lines[0].id, deliveredMilli: q(accepted), acceptedMilli: q(accepted) }],
      });
    const r1 = await receive(500);
    expect(r1.status).toBe(201);
    detail = (await api(ctx.app, reqA, 'GET', `/api/erp/requests/${created.id}`)).body;
    expect(detail.lines[0].progress).toMatchObject({ state: 'partial', receivedMilli: q(500), orderedMilli: q(1000) });
    await receive(500);
    const ret2 = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'supplier_return',
      docDate: today,
      sourceDocId: r1.body.doc.id,
      note: '破损',
      lines: [{ sourceLineId: r1.body.doc.lines[0].id, qtyMilli: q(20) }],
    });
    await api(ctx.app, approver, 'POST', `/api/inventory/docs/${ret2.body.doc.id}/approve`, {});
    detail = (await api(ctx.app, reqA, 'GET', `/api/erp/requests/${created.id}`)).body;
    expect(detail.lines[0].progress).toMatchObject({ state: 'received', receivedMilli: q(1000), returnedMilli: q(20) });
    expect(detail.receivedLines).toBe(1);
  });

  it('没通过的需求单不能转；不采购与撤回都要原因', async () => {
    const img = await upload(reqA, 'np');
    const r = (await submit(reqA, [newLine({ imageIds: [img.id] })])).body.request;
    const po = await api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, lines: [{ materialId: other.id, purchaseQtyMilli: q(1), priceCents: 1, requestLineId: r.lines[0].id }] });
    expect(po.body.error.code).toBe('REQUEST_NOT_APPROVED');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/reject`, {})).status).toBe(400);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/reject`, { reason: '已有库存' })).body).toMatchObject({ status: 'rejected', reason: '已有库存' });
    const r2 = (await submit(reqA, [newLine({ imageIds: [img.id] })])).body.request;
    expect((await api(ctx.app, reqA, 'POST', `/api/erp/requests/${r2.id}/cancel`, { reason: '重复了' })).body.status).toBe('cancelled');
  });

  it('同一操作编号只提交一次', async () => {
    const img = await upload(reqA, 'idem');
    const body = { clientKey: randomUUID(), lines: [newLine({ imageIds: [img.id] })] };
    const [a, b] = await Promise.all([api(ctx.app, reqA, 'POST', '/api/erp/requests', body), api(ctx.app, reqA, 'POST', '/api/erp/requests', body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.request.id).toBe(b.body.request.id);
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/requests/by-key/${body.clientKey}`)).body.id).toBe(a.body.request.id);
  });
});

describe('员工所属部门', () => {
  it('店主在员工档案里设所属部门；不存在的部门拒绝；不传保持原样', async () => {
    const staff = (await api(ctx.app, boss, 'GET', '/api/staff')).body as { id: number; username: string; displayName: string; role: string; duties: string[]; departmentId: number | null; departmentName: string | null }[];
    const none = staff.find((s) => s.username === 'req_none')!;
    const put = (body: Record<string, unknown>) =>
      api(ctx.app, boss, 'PUT', `/api/staff/${none.id}`, { displayName: none.displayName, role: none.role, duties: none.duties, active: true, ...body });
    expect((await put({ departmentId: 999_999 })).body.error.code).toBe('DEPARTMENT_INVALID');
    const set = (await put({ departmentId: deptB })).body.find((s: { id: number }) => s.id === none.id);
    expect(set).toMatchObject({ departmentId: deptB, departmentName: '水吧' });
    expect((await put({})).body.find((s: { id: number }) => s.id === none.id).departmentId).toBe(deptB);
    const img = await upload(reqNoDept, 'now');
    expect((await submit(reqNoDept, [newLine({ imageIds: [img.id] })])).body.request.department.id).toBe(deptB);
  });
});

describe('自检', () => {
  it('需求单与采购单一致；库存与费用自检照旧', async () => {
    const checks = (await api(ctx.app, buyer, 'GET', '/api/erp/requests/checks')).body;
    expect(checks.map((c: { key: string }) => c.key)).toEqual(['purchase_requests']);
    for (const c of checks) expect(c, c.label).toMatchObject({ ok: true });
    for (const c of (await api(ctx.app, boss, 'GET', '/api/inventory/checks')).body) expect(c, c.label).toMatchObject({ ok: true });
  });
});
