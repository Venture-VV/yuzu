// 8.0.1 采购组整改（docs/PURCHASING_V801.md）：需求单的采购优先级与待审核排序（02）、每日截单（03）、
// 需求单转的采购单提交即确认与撤回（04）、「到货超期天数」挪到采购规则（01）、签约供应商的合同 PDF（08）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/labels';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { readXlsx } from '../src/server/lib/xlsx-read';
import { REQUEST_IMPORT_COLUMNS } from '../src/shared/requests';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 演示店主 linlan
let buyer: string; // 采购经办 zhouyi：审核需求单、编采购单
let keeper: string; // 物资经办 lixiao
let approver: string; // 负责人
let reqA: string; // 部门申购（客房部）
let supplierId: number;
let mat: { id: number; name: string };
let other: { id: number; name: string };
const q = (n: number) => Math.round(n * 1000);

const setRules = async (patch: Record<string, unknown>) => {
  const res = await api(ctx.app, boss, 'PUT', '/api/inventory/purchase-rules', patch);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const line = (over: Record<string, unknown> = {}) => ({ materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: q(2), unit: '箱', ...over });
const submit = async (body: Record<string, unknown> = {}, lines = [line()]) => {
  const res = await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.request as { id: number; docNo: string; priority: string; approvableOn: string | null; lockedToday: boolean; lines: { id: number }[] };
};
const approve = async (id: number) => {
  const res = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${id}/approve`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: number; lines: { id: number }[] };
};
const po = (lines: unknown[], body: Record<string, unknown> = {}) =>
  api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, lines, ...body });
const openIds = async () => ((await api(ctx.app, buyer, 'GET', '/api/erp/requests/open-lines')).body as { id: number }[]).map((l) => l.id);

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  await createStaff(ctx.sql, { username: 'appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  approver = await login(ctx.app, 'appr');
  await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name: '客房部' });
  const deptA = ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === '客房部')!.id;
  await createStaff(ctx.sql, { username: 'req_a', displayName: '客房部申购', role: 'backoffice', duties: ['request'], departmentId: deptA, password: PASSWORD, mustChangePassword: false });
  reqA = await login(ctx.app, 'req_a');
  const sups = (await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; code: string }[];
  supplierId = sups.find((s) => s.code === 'S004')!.id;
  const mats = (await api(ctx.app, boss, 'GET', '/api/inventory/materials?all=1')).body as { id: number; code: string; name: string }[];
  mat = mats.find((m) => m.code === 'M016')!; // 一次性护理床单，1 箱 = 500 张
  other = mats.find((m) => m.code === 'M001')!;
}, 120_000);
afterAll(async () => ctx.close());

describe('需求单：采购优先级与待审核排序（02）、每日截单（03）', () => {
  it('紧急在前、期望到货日期早的在前、提交早的在前；待转采购单同样排序', async () => {
    const later = shiftDate(today, 5);
    const sooner = shiftDate(today, 2);
    const n1 = await submit({ needBy: sooner });
    const u1 = await submit({ priority: 'urgent', needBy: later });
    const n2 = await submit({ needBy: null });
    const u2 = await submit({ priority: 'urgent', needBy: sooner });
    const n3 = await submit({ needBy: sooner });
    expect(u1.priority).toBe('urgent');
    expect(n1.priority).toBe('normal');
    const list = (await api(ctx.app, buyer, 'GET', '/api/erp/requests?status=submitted')).body.requests as { id: number; priority: string }[];
    const ours = list.filter((r) => [n1, u1, n2, u2, n3].some((x) => x.id === r.id)).map((r) => r.id);
    expect(ours).toEqual([u2.id, u1.id, n1.id, n3.id, n2.id]);
    // 部门申购改优先级：退回后改成紧急再提交
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${n2.id}/return`, { reason: '写上期望到货日期' })).status).toBe(200);
    const edited = await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${n2.id}`, { priority: 'urgent', needBy: today, lines: [line()] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ status: 'submitted', priority: 'urgent' });
    const again = (await api(ctx.app, buyer, 'GET', '/api/erp/requests?status=submitted')).body.requests as { id: number }[];
    expect(again.filter((r) => [n1, u1, n2, u2, n3].some((x) => x.id === r.id)).map((r) => r.id)).toEqual([n2.id, u2.id, u1.id, n1.id, n3.id]);
    // 通过后进待转采购单，按同样的顺序（改过的需求单，行是重新写的）
    const approved: { id: number; lines: { id: number }[] }[] = [];
    for (const r of [n1, u1, n2, u2, n3]) approved.push(await approve(r.id));
    const lineOf = new Map(approved.map((r) => [r.lines[0]!.id, r.id]));
    const open = (await openIds()).filter((id) => lineOf.has(id)).map((id) => lineOf.get(id));
    expect(open).toEqual([n2.id, u2.id, u1.id, n1.id, n3.id]);
    const openLine = ((await api(ctx.app, buyer, 'GET', '/api/erp/requests/open-lines')).body as { id: number; priority: string; needBy: string | null }[]).find((l) => l.id === approved[2]!.lines[0]!.id);
    expect(openLine).toMatchObject({ priority: 'urgent', needBy: today });
    // 优先级只能是紧急 / 普通
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), priority: 'asap', lines: [line()] })).status).toBe(400);
  });

  it('截单打开后：截单以后提交的照常提交，当天不能审核通过（退回、不采购可以），截单关了以后可以通过', async () => {
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/requests/meta')).body.cutoff).toEqual({ enabled: false, time: '17:00' });
    // 截单时间 00:00：任何时候提交都在截单以后
    await setRules({ cutoffEnabled: true, cutoffTime: '00:00' });
    expect((await api(ctx.app, reqA, 'GET', '/api/erp/requests/meta')).body.cutoff).toEqual({ enabled: true, time: '00:00' });
    const late = await submit();
    expect(late).toMatchObject({ approvableOn: shiftDate(today, 1), lockedToday: true });
    const blocked = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${late.id}/approve`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'CUTOFF_LOCKED', details: { approvableOn: shiftDate(today, 1) } });
    const listed = (await api(ctx.app, buyer, 'GET', '/api/erp/requests?status=submitted')).body.requests.find((r: { id: number }) => r.id === late.id);
    expect(listed).toMatchObject({ lockedToday: true, approvableOn: shiftDate(today, 1) });
    // 退回、不采购不受截单限制
    const other1 = await submit();
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${other1.id}/return`, { reason: '数量再核一下' })).body.status).toBe('returned');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${other1.id}/reject`, { reason: '库存够用' })).body.status).toBe('rejected');
    // 截单时间 23:59 以前提交的当天可以通过（除非正好在 23:59 这一分钟提交）
    await setRules({ cutoffTime: '23:59' });
    const early = await submit();
    if (early.approvableOn === null) {
      expect(early.lockedToday).toBe(false);
      await approve(early.id);
    }
    // 截单关了以后：之前截单后提交的当天也能通过
    await setRules({ cutoffEnabled: false });
    expect((await api(ctx.app, buyer, 'GET', `/api/erp/requests/${late.id}`)).body.lockedToday).toBe(false);
    await approve(late.id);
    // 截单时间要写成 HH:MM
    expect((await api(ctx.app, boss, 'PUT', '/api/inventory/purchase-rules', { cutoffTime: '5pm' })).status).toBe(400);
  });
});

describe('需求单转的采购单（04）', () => {
  it('行都来自审核过的需求单：超过免确认门槛也提交即确认；夹了别的行、或在采购规则里关掉时照旧等负责人确认', async () => {
    const r1 = await approve((await submit({}, [line({ qtyMilli: q(7) })])).id);
    // 7 箱 × 450 元 = 3,150 元：超过免确认门槛（2,000 元），没到询价门槛（5,000 元）
    const direct = await po([{ materialId: mat.id, purchaseQtyMilli: q(7), priceCents: 45_000, requestLineIds: [r1.lines[0]!.id] }]);
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);
    expect(direct.body.po).toMatchObject({ status: 'approved', totalCents: 315_000, withdrawable: true });
    expect(direct.body.po.approvals.map((a: { action: string; reason: string }) => [a.action, a.reason])).toEqual([
      ['create', ''],
      ['submit', ''],
      ['approve', '需求单转的采购单：供应链审核需求单即可采购，提交即确认'],
    ]);
    // 夹了一行不是需求单的：照旧等负责人确认
    const r2 = await approve((await submit({}, [line({ qtyMilli: q(4) })])).id);
    const mixed = await po([
      { materialId: mat.id, purchaseQtyMilli: q(4), priceCents: 45_000, requestLineIds: [r2.lines[0]!.id] },
      { materialId: other.id, purchaseQtyMilli: q(1), priceCents: 1_500 },
    ]);
    expect(mixed.body.po).toMatchObject({ status: 'submitted' });
    expect((await api(ctx.app, approver, 'POST', `/api/purchase-orders/${mixed.body.po.id}/approve`, {})).body.status).toBe('approved');
    // 人审批过的已确认采购单不能撤回（不再到货请关闭）
    const refused = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${mixed.body.po.id}/cancel`, { reason: '换供应商' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INVALID_STATE');
    expect((await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${mixed.body.po.id}`)).body.withdrawable).toBe(false);
    // 采购规则里关掉：需求单转的也等负责人确认
    await setRules({ requestPoDirect: false });
    const r3 = await approve((await submit({}, [line({ qtyMilli: q(5) })])).id);
    const off = await po([{ materialId: mat.id, purchaseQtyMilli: q(5), priceCents: 45_000, requestLineIds: [r3.lines[0]!.id] }]);
    expect(off.body.po).toMatchObject({ status: 'submitted' });
    await setRules({ requestPoDirect: true });
  });

  it('提交即确认的采购单：还没有收货、报销、发票时经办人可以撤回，需求行回到待转采购单；收了货就不能撤回', async () => {
    const r = await approve((await submit({}, [line({ qtyMilli: q(6) })])).id);
    const lineId = r.lines[0]!.id;
    const p1 = (await po([{ materialId: mat.id, purchaseQtyMilli: q(6), priceCents: 45_000, requestLineIds: [lineId] }])).body.po;
    expect(p1.status).toBe('approved');
    expect(await openIds()).not.toContain(lineId);
    // 别人（不是创建人、也不能确认采购单）不能撤回
    expect((await api(ctx.app, keeper, 'POST', `/api/purchase-orders/${p1.id}/cancel`, { reason: '换供应商' })).status).toBe(403);
    const cancelled = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${p1.id}/cancel`, { reason: '换供应商' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', withdrawable: false });
    expect(await openIds()).toContain(lineId);
    // 重新转一张、收了货：不能撤回
    const p2 = (await po([{ materialId: mat.id, purchaseQtyMilli: q(6), priceCents: 45_000, requestLineIds: [lineId] }])).body.po;
    expect(p2.status).toBe('approved');
    const rc = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId,
      purchaseOrderId: p2.id,
      coAcceptorId: (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id,
      lines: [{ materialId: mat.id, poLineId: p2.lines[0].id, deliveredMilli: q(3000), acceptedMilli: q(3000), priceCents: 45_000 }],
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    const after = (await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${p2.id}`)).body;
    expect(after.withdrawable).toBe(false);
    const refused = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${p2.id}/cancel`, { reason: '换供应商' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PO_HAS_RECEIPTS');
  });
});

describe('采购规则（01）', () => {
  it('「下单后几天没到货算超期」：采购规则里没存过的沿用费用报销规则里原来的值；保存费用报销规则不会冲掉它；默认只有店主能改采购规则', async () => {
    // 模拟 8.0.0 的数据：到货超期天数存在费用报销规则里，采购规则还没存过
    await ctx.sql`DELETE FROM settings WHERE key = 'purchase_rules'`;
    await ctx.sql`
      INSERT INTO settings (key, value) VALUES ('expense_rules', ${ctx.sql.json({ approvalThresholdCents: 200_000, overdueDays: 7, arrivalOverdueDays: 12 } as never)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    expect((await api(ctx.app, buyer, 'GET', '/api/inventory/purchase-rules')).body.arrivalOverdueDays).toBe(12);
    // 保存费用报销规则（页面不再带这一项）：原来的值留着
    const expense = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/rules')).body;
    const saved = await api(ctx.app, boss, 'PUT', '/api/erp/expenses/rules', { approvalThresholdCents: expense.approvalThresholdCents, overdueDays: 5, purposes: expense.purposes, invoiceTypes: expense.invoiceTypes });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await api(ctx.app, buyer, 'GET', '/api/inventory/purchase-rules')).body.arrivalOverdueDays).toBe(12);
    // 在采购规则里改了以后按采购规则
    expect((await setRules({ arrivalOverdueDays: 9 })).arrivalOverdueDays).toBe(9);
    expect((await api(ctx.app, buyer, 'GET', '/api/inventory/purchase-rules')).body).toMatchObject({ arrivalOverdueDays: 9, cutoffEnabled: false, requestPoDirect: true });
    // 采购经办看得到、改不了（「维护采购规则」默认只有店主）
    expect((await api(ctx.app, buyer, 'PUT', '/api/inventory/purchase-rules', { arrivalOverdueDays: 3 })).status).toBe(403);
    // 采购途径固定三类：存的旧途径字典不再用，传了也不改
    const channels = (await setRules({ channels: [{ key: 'market', label: '批发市场', needsNote: true }] })).channels.map((c: { key: string }) => c.key);
    expect(channels).toEqual(['online', 'self', 'supplier']);
  });
});

describe('签约供应商的合同 PDF（08）', () => {
  const pdf = (seed: string) => Buffer.from(`%PDF-1.4\n% yuzu ${seed}\n%%EOF\n`).toString('base64');

  it('未签约的不能传；签约后可以传多份、下载、撤下（撤下保留记录）；只能传 PDF；同一份不重复挂', async () => {
    const sup = (await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body.find((s: { code: string }) => s.code === 'S004');
    expect(sup).toMatchObject({ contracted: false, contractFiles: 0 });
    const upload = (cookie: string, data: string, name = '2026 年供货合同') =>
      api(ctx.app, cookie, 'POST', `/api/inventory/suppliers/${sup.id}/contract-files`, { name, mime: 'application/pdf', data });
    const notYet = await upload(boss, pdf('a'));
    expect(notYet.status).toBe(422);
    expect(notYet.body.error.code).toBe('SUPPLIER_NOT_CONTRACTED');
    // 改成签约（只改这一项，其他照原样）
    const { id: _id, contractFiles: _f, ...rest } = sup;
    const updated = await api(ctx.app, boss, 'PUT', `/api/inventory/suppliers/${sup.id}`, { ...rest, contracted: true });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const first = await upload(boss, pdf('a'));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toEqual([expect.objectContaining({ name: '2026 年供货合同', sizeBytes: Buffer.from(pdf('a'), 'base64').length, uploadedByName: expect.any(String) })]);
    // 同一份文件再传不重复挂；另一份可以
    expect((await upload(boss, pdf('a'), '重复')).body).toHaveLength(1);
    const two = await upload(boss, pdf('b'), '补充协议');
    expect(two.body.map((f: { name: string }) => f.name)).toEqual(['2026 年供货合同', '补充协议']);
    // 不是 PDF、没有权限
    const notPdf = await upload(boss, Buffer.from('hello, not a pdf').toString('base64'));
    expect(notPdf.status).toBe(422);
    expect(notPdf.body.error.code).toBe('FILE_NOT_PDF');
    expect((await upload(ctx.clerk, pdf('c'))).status).toBe(403);
    // 供应商列表里有几份；有库存查看权限的能看、能下载
    const listed = (await api(ctx.app, keeper, 'GET', '/api/inventory/suppliers?all=1')).body.find((s: { id: number }) => s.id === sup.id);
    expect(listed).toMatchObject({ contracted: true, contractFiles: 2 });
    const files = (await api(ctx.app, keeper, 'GET', `/api/inventory/suppliers/${sup.id}/contract-files`)).body as { id: number; url: string }[];
    const dl = await ctx.app.inject({ method: 'GET', url: files[0]!.url, headers: { cookie: keeper } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.rawPayload.equals(Buffer.from(pdf('a'), 'base64'))).toBe(true);
    // 撤下：列表里没了，下载提示已撤下，记录还在
    const removed = await api(ctx.app, boss, 'POST', `/api/inventory/supplier-contract-files/${files[0]!.id}/remove`, {});
    expect(removed.body.map((f: { name: string }) => f.name)).toEqual(['补充协议']);
    const gone = await ctx.app.inject({ method: 'GET', url: files[0]!.url, headers: { cookie: keeper } });
    expect(gone.statusCode).toBe(409);
    const [kept] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM supplier_contract_files WHERE supplier_id = ${sup.id}`;
    expect(kept!.n).toBe(2);
    // 数据库兜底：文件与挂接记录只追加
    await expect(ctx.sql`DELETE FROM supplier_contract_files WHERE id = ${files[0]!.id}`).rejects.toThrow();
    await expect(ctx.sql`UPDATE erp_files SET size_bytes = size_bytes WHERE scope = 'supplier_contract'`).rejects.toThrow();
  });
});

describe('收货附件推送到财务待报销（11）', () => {
  const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`yuzu-${seed}`)]).toString('base64');
  const pdf = (seed: string) => Buffer.from(`%PDF-1.4\n% receipt ${seed}\n%%EOF\n`).toString('base64');

  it('收货单挂照片与 PDF（最多 9 份、只追加）；现付采购单收货生效后待报销标已收货、带附件数；报销单上看得到附件', async () => {
    const coster = boss; // 店主：费用与备用金能看能登记
    const sups = (await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; code: string; name: string }[];
    const cash = sups.find((x) => x.code === 'S005')!;
    expect((await api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${cash.id}`, { code: cash.code, name: cash.name, settlement: 'cash' })).status).toBe(200);
    const created = (await po([{ materialId: mat.id, purchaseQtyMilli: q(1), priceCents: 45_000 }], { supplierId: cash.id, approveNow: false })).body.po;
    const order = (await api(ctx.app, approver, 'POST', `/api/purchase-orders/${created.id}/approve`, {})).body;
    expect(order.status).toBe('approved');
    const before = (await api(ctx.app, coster, 'GET', '/api/erp/expenses/to-claim')).body.find((r: { id: number }) => r.id === order.id);
    expect(before).toMatchObject({ receiving: 'none', receipts: [] });
    const receivedBefore = (await api(ctx.app, coster, 'GET', '/api/erp/expenses/to-claim/count')).body.received;

    const buyerId = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id;
    const rc = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId: cash.id,
      purchaseOrderId: order.id,
      coAcceptorId: buyerId,
      lines: [{ materialId: mat.id, poLineId: order.lines[0].id, deliveredMilli: q(500), acceptedMilli: q(500) }],
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    const docId = rc.body.doc.id as number;
    const attach = (cookie: string, body: Record<string, unknown>, id = docId) => api(ctx.app, cookie, 'POST', `/api/inventory/docs/${id}/attachments`, body);
    // 仓库挂一张照片、采购挂一份 PDF；同一份再挂不重复
    expect((await attach(keeper, { name: '送货单', mime: 'image/jpeg', data: jpeg('a') })).status).toBe(201);
    const two = await attach(buyer, { name: '小票', mime: 'application/pdf', data: pdf('a') });
    expect(two.status, JSON.stringify(two.body)).toBe(201);
    expect(two.body.map((a: { kind: string; name: string }) => [a.kind, a.name])).toEqual([
      ['image', '送货单'],
      ['pdf', '小票'],
    ]);
    expect((await attach(keeper, { name: '送货单', mime: 'image/jpeg', data: jpeg('a') })).body).toHaveLength(2);
    // 不是 PDF、没有权限、不是收货单
    expect((await attach(keeper, { mime: 'application/pdf', data: Buffer.from('not a pdf at all').toString('base64') })).body.error.code).toBe('FILE_NOT_PDF');
    expect((await attach(ctx.clerk, { mime: 'image/jpeg', data: jpeg('b') })).status).toBe(403);
    // 单据详情带附件；PDF 能下载
    const detail = (await api(ctx.app, keeper, 'GET', `/api/inventory/docs/${docId}`)).body;
    expect(detail.attachments).toHaveLength(2);
    const dl = await ctx.app.inject({ method: 'GET', url: detail.attachments[1].url, headers: { cookie: coster } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // 最多 9 份
    for (let i = 0; i < 7; i++) expect((await attach(keeper, { mime: 'image/jpeg', data: jpeg(`more-${i}`) })).status).toBe(201);
    const tenth = await attach(keeper, { mime: 'image/jpeg', data: jpeg('tenth') });
    expect(tenth.status).toBe(409);
    expect(tenth.body.error.code).toBe('ATTACHMENT_LIMIT');
    // 只追加
    await expect(ctx.sql`DELETE FROM inv_doc_attachments WHERE doc_id = ${docId}`).rejects.toThrow();

    // 待报销：已收货，带收货单与附件份数；导航上的数字加一
    const after = (await api(ctx.app, coster, 'GET', '/api/erp/expenses/to-claim')).body.find((r: { id: number }) => r.id === order.id);
    expect(after).toMatchObject({ receiving: 'full', receipts: [{ id: docId, attachmentCount: 9 }] });
    expect((await api(ctx.app, coster, 'GET', '/api/erp/expenses/to-claim/count')).body.received).toBe(receivedBefore + 1);
    // 转报销页带出收货单与附件；登记后报销单上也看得到
    const forClaim = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${order.id}`)).body;
    expect(forClaim.receipts).toEqual([expect.objectContaining({ id: docId, attachments: expect.any(Array) })]);
    expect(forClaim.receipts[0].attachments).toHaveLength(9);
    const pl = forClaim.lines[0];
    const claim = await api(ctx.app, coster, 'POST', '/api/erp/expenses', {
      clientKey: randomUUID(),
      expenseDate: today,
      departmentId: (await ctx.sql<{ id: number }[]>`SELECT id FROM departments ORDER BY id LIMIT 1`)[0]!.id,
      handlerId: buyerId,
      purpose: '客用消耗',
      paySource: 'company',
      invoiceType: 'receipt',
      taxRateBp: 0,
      purchaseOrderId: order.id,
      lines: [{ name: pl.name, category: 'low_value', unit: pl.unit, boughtMilli: pl.boughtMilli, receivedMilli: pl.receivedMilli, amountCents: 45_000, poLineId: pl.poLineId }],
    });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    expect(claim.body.claim.receipts).toEqual([expect.objectContaining({ id: docId, docNo: rc.body.doc.docNo })]);
  });
});

describe('集采模板与一键导入（06）', () => {
  it('下载模板；预览逐行核对；有错整份不导；按部门 + 优先级 + 期望到货日期合成已通过的需求单；同一份文件只能导一次', async () => {
    // 模板：一张「集采需求表」，表头与采购组的一样
    const tpl = await ctx.app.inject({ method: 'GET', url: '/api/erp/requests/import/template', headers: { cookie: buyer } });
    expect(tpl.statusCode).toBe(200);
    const book = readXlsx(tpl.rawPayload);
    expect(book.sheets[0]!.name).toBe('集采需求表');
    const rows = book.sheets[0]!.rows;
    const head = rows.get(Math.min(...rows.keys()))!;
    expect(REQUEST_IMPORT_COLUMNS.map((_, c) => head.get(c)?.value)).toEqual([...REQUEST_IMPORT_COLUMNS]);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/erp/requests/import/template', headers: { cookie: reqA } })).statusCode).toBe(403);

    const sups = (await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { code: string; name: string; id: number }[];
    const s4 = sups.find((x) => x.code === 'S004')!;
    const later = shiftDate(today, 3);
    const header = REQUEST_IMPORT_COLUMNS.join(',');
    const good = [
      `1,客房部,小李,${mat.name},箱,2,紧急,${later},供应商,${s4.name},加厚`,
      `2,客房部,小王,香薰扩香石,个,10,紧急,${later},网购,,白色`,
      `3,客房部,小李,一次性牙刷,支,300,普通,,自采（现采/零采）,,`,
    ];
    const bad = [
      `4,不存在的部门,小李,纸巾,包,1,普通,,,,`,
      `5,客房部,小李,纸巾,包,abc,普通,,,,`,
      `6,客房部,小李,纸巾,包,1,很急,,,,`,
      `7,客房部,小李,纸巾,包,1,普通,,快递,,`,
      `8,客房部,小李,纸巾,包,1,普通,,供应商,没有这家,`,
      `9,客房部,小李,纸巾,包,1,普通,${shiftDate(today, -1)},,,`,
    ];
    const preview = (csv: string, name = '集采-11月.csv') => api(ctx.app, buyer, 'POST', '/api/erp/requests/import/preview', { fileName: name, csv });
    const p1 = (await preview([header, ...good, ...bad].join('\n'))).body;
    expect(p1.rows).toHaveLength(9);
    expect(p1.issueCount).toBe(6);
    const issueOf = (row: number) => p1.rows.find((r: { row: number }) => r.row === row).issues[0] as string;
    expect(issueOf(5)).toContain('不在部门档案里');
    expect(issueOf(6)).toContain('数量');
    expect(issueOf(7)).toContain('采购优先级');
    expect(issueOf(8)).toContain('采购途径');
    expect(issueOf(9)).toContain('不在供应商档案里');
    expect(issueOf(10)).toContain('不能早于今天');
    // 物品名称与物料档案一样的带上物料；供应商按名称找
    expect(p1.rows[0]).toMatchObject({ material: { id: mat.id }, supplier: { id: s4.id }, channel: 'supplier', priority: 'urgent', needBy: later, applicant: '小李' });
    expect(p1.rows[1]).toMatchObject({ material: null, channel: 'online' });
    // 有错整份不导
    const refused = await api(ctx.app, buyer, 'POST', '/api/erp/requests/import', { clientKey: randomUUID(), fileName: '集采-11月.csv', csv: [header, ...good, ...bad].join('\n') });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('IMPORT_INVALID');

    // 改好的文件：两张需求单（紧急 + 期望日期一张，普通一张），已通过，进待转采购单
    const csv = [header, ...good].join('\n');
    const p2 = (await preview(csv)).body;
    expect(p2).toMatchObject({ issueCount: 0, duplicate: null });
    expect(p2.groups).toEqual([
      { department: '客房部', priority: 'urgent', needBy: later, lines: 2 },
      { department: '客房部', priority: 'normal', needBy: null, lines: 1 },
    ]);
    const key = randomUUID();
    const done = await api(ctx.app, buyer, 'POST', '/api/erp/requests/import', { clientKey: key, fileName: '集采-11月.csv', csv });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.import).toMatchObject({ rowCount: 3, requestCount: 2 });
    expect(done.body.requests.map((r: { priority: string; lineCount: number }) => [r.priority, r.lineCount])).toEqual([
      ['urgent', 2],
      ['normal', 1],
    ]);
    const first = (await api(ctx.app, buyer, 'GET', `/api/erp/requests/${done.body.requests[0].id}`)).body;
    expect(first).toMatchObject({ status: 'approved', source: 'import', priority: 'urgent', needBy: later });
    expect(first.lines.map((l: { name: string; applicant: string; channel: string; supplier: { id: number } | null }) => [l.name, l.applicant, l.channel, l.supplier?.id ?? null])).toEqual([
      [mat.name, '小李', 'supplier', s4.id],
      ['香薰扩香石', '小王', 'online', null],
    ]);
    const open = await openIds();
    for (const l of first.lines) expect(open).toContain(l.id);
    // 导入的新产品不要求链接和图片：需求单自检、账目自检第 12 条照常 ✓
    expect(((await api(ctx.app, buyer, 'GET', '/api/erp/requests/checks')).body as { ok: boolean }[]).every((c) => c.ok)).toBe(true);
    const audit = (await api(ctx.app, boss, 'GET', '/api/erp/audit')).body;
    expect(audit.rules.find((r: { no: number }) => r.no === 12)).toMatchObject({ ok: true });

    // 同一个操作编号重提：原来那次的结果；同一份文件换编号再导：拒绝
    const again = await api(ctx.app, buyer, 'POST', '/api/erp/requests/import', { clientKey: key, fileName: '集采-11月.csv', csv });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, import: { id: done.body.import.id } });
    expect((await preview(csv)).body.duplicate).toMatchObject({ id: done.body.import.id });
    const dup = await api(ctx.app, buyer, 'POST', '/api/erp/requests/import', { clientKey: randomUUID(), fileName: '集采-11月-副本.csv', csv });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('IMPORT_DUPLICATE');
    // 部门申购不能导入
    expect((await api(ctx.app, reqA, 'POST', '/api/erp/requests/import/preview', { fileName: 'x.csv', csv })).status).toBe(403);
    // 表头不对
    const wrong = await preview('名称,数量\n纸巾,1');
    expect(wrong.body.error.code).toBe('IMPORT_COLUMNS');
  });
});
