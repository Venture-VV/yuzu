// v0.7.29 ERP 采购五项（docs/ERP_PURCHASING.md）：①采购途径、②采购单一键转报销、③部门备用金台账、④补货建议、⑤询价比价与定标。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PURCHASE_RULES } from '../src/shared/purchasing';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 演示店主 linlan
let keeper: string; // 物资经办 lixiao
let buyer: string; // 采购经办 zhouyi
let buyerId: number;
let coster: string; // 成本核算（登记报销）
let costerId: number;
let approver: string; // 负责人
let deptA: number;
const q = (n: number) => Math.round(n * 1000);

const supplier = async (code: string) =>
  (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/suppliers?all=1')).body.find((s: { code: string }) => s.code === code);
const material = async (code: string) =>
  (await api(ctx.app, ctx.owner, 'GET', '/api/inventory/materials?all=1')).body.find((m: { code: string }) => m.code === code);
const rules = async () => (await api(ctx.app, boss, 'GET', '/api/inventory/purchase-rules')).body;
const saveRules = (cookie: string, body: object) => api(ctx.app, cookie, 'PUT', '/api/inventory/purchase-rules', body as Record<string, unknown>);

/** 采购单：默认 M016 两箱、每箱 ¥450（¥900，不超过免确认门槛，提交即确认） */
const newPo = (body: Record<string, unknown>) =>
  api(ctx.app, buyer, 'POST', '/api/purchase-orders', {
    clientKey: randomUUID(),
    orderDate: today,
    action: 'submit',
    ...body,
  });

const claim = (body: Record<string, unknown> = {}) =>
  api(ctx.app, coster, 'POST', '/api/erp/expenses', {
    clientKey: randomUUID(),
    expenseDate: today,
    departmentId: deptA,
    handlerId: costerId,
    purpose: '办公',
    paySource: 'company',
    invoiceType: 'receipt',
    taxRateBp: 0,
    lines: [{ name: '打印纸', category: 'office', unit: '包', boughtMilli: q(2), receivedMilli: q(2), amountCents: 6_000 }],
    ...body,
  });

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  buyerId = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id;
  costerId = await createStaff(ctx.sql, { username: 'coster', displayName: '成本岗', role: 'backoffice', duties: ['cost'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  coster = await login(ctx.app, 'coster');
  approver = await login(ctx.app, 'appr');
  await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name: '采购部' });
  deptA = (await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body.find((d: { name: string }) => d.name === '采购部').id;
}, 120_000);
afterAll(async () => ctx.close());

describe('① 采购途径（E1）', () => {
  it('规则：默认五个途径；店主可改名、加途径，键重复拒绝；没有门店设置权限的不能改', async () => {
    expect(await rules()).toEqual(DEFAULT_PURCHASE_RULES);
    expect((await api(ctx.app, coster, 'GET', '/api/inventory/purchase-rules')).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/inventory/purchase-rules')).status).toBe(403);
    const changed = { ...DEFAULT_PURCHASE_RULES, channels: [...DEFAULT_PURCHASE_RULES.channels, { key: 'custom_live', label: '直播间', needsNote: true }] };
    expect((await saveRules(buyer, changed)).status).toBe(403);
    const dup = { ...changed, channels: [...changed.channels, { key: 'online', label: '又一个网购', needsNote: false }] };
    expect((await saveRules(boss, dup)).status).toBe(400);
    expect((await saveRules(boss, { ...DEFAULT_PURCHASE_RULES, reorderDays: 14, targetDays: 7 })).status).toBe(400);
    const ok = await saveRules(boss, changed);
    expect(ok.status).toBe(200);
    expect(ok.body.channels.at(-1)).toEqual({ key: 'custom_live', label: '直播间', needsNote: true });
    // 后台规则总表里也看得到
    const catalog = (await api(ctx.app, boss, 'GET', '/api/admin/rules')).body as { key: string; value: string }[];
    expect(catalog.find((r) => r.key === 'purchase_rules.channels')?.value).toContain('直播间（写说明）');
    expect((await saveRules(boss, DEFAULT_PURCHASE_RULES)).status).toBe(200);
  });

  it('供应商的默认途径带进新建的采购单；明确选了要写说明的途径必须写；修改不传保持原样；改名不影响已有单据', async () => {
    const s = await supplier('S002');
    const mat = await material('M016');
    expect((await api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s.id}`, { code: s.code, name: s.name, defaultChannel: 'bogus' })).body.error.code).toBe('CHANNEL_INVALID');
    expect((await api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s.id}`, { code: s.code, name: s.name, defaultChannel: 'wholesale' })).status).toBe(200);
    expect(await supplier('S002')).toMatchObject({ defaultChannel: 'wholesale' });
    // 只改别的字段时默认途径保持原样
    expect((await api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s.id}`, { code: s.code, name: s.name, note: '批发' })).status).toBe(200);
    expect(await supplier('S002')).toMatchObject({ defaultChannel: 'wholesale', note: '批发' });

    const lines = [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000 }];
    // 不传：按供应商的默认带出，带出的不强制写说明
    const byDefault = await newPo({ supplierId: s.id, lines });
    expect(byDefault.status).toBe(201);
    expect(byDefault.body.po.channel).toEqual({ key: 'wholesale', label: '批发市场', note: '' });
    // 明确选了要写说明的：不写拒绝，写了照记
    expect((await newPo({ supplierId: s.id, lines, channel: 'online' })).body.error.code).toBe('CHANNEL_NOTE_REQUIRED');
    expect((await newPo({ supplierId: s.id, lines, channel: 'nope' })).body.error.code).toBe('CHANNEL_INVALID');
    expect((await newPo({ supplierId: s.id, lines, channel: 'Bad Key' })).status).toBe(400);
    const online = await newPo({ supplierId: s.id, lines, channel: 'online', channelNote: '某平台某某旗舰店', action: 'save' });
    expect(online.status).toBe(201);
    expect(online.body.po.channel).toEqual({ key: 'online', label: '网购平台', note: '某平台某某旗舰店' });
    // 修改：不传途径保持原样；传了按传的
    const po = online.body.po;
    const body = { supplierId: s.id, orderDate: today, lines: [{ id: po.lines[0].id, materialId: mat.id, purchaseQtyMilli: q(3), priceCents: 45_000 }] };
    const kept = await api(ctx.app, buyer, 'PUT', `/api/purchase-orders/${po.id}`, { ...body, action: 'save' });
    expect(kept.body.channel).toEqual({ key: 'online', label: '网购平台', note: '某平台某某旗舰店' });
    const moved = await api(ctx.app, buyer, 'PUT', `/api/purchase-orders/${po.id}`, { ...body, action: 'save', channel: 'supplier' });
    expect(moved.body.channel).toEqual({ key: 'supplier', label: '供应商配送', note: '' });
    // 列表也带途径
    const list = (await api(ctx.app, buyer, 'GET', `/api/purchase-orders?q=${po.docNo}`)).body;
    expect(list[0].channel).toMatchObject({ key: 'supplier' });

    // 改名：之后的单据按新名称，已有单据保留当时的名称
    const renamed = { ...DEFAULT_PURCHASE_RULES, channels: DEFAULT_PURCHASE_RULES.channels.map((c) => (c.key === 'wholesale' ? { ...c, label: '农批市场' } : c)) };
    expect((await saveRules(boss, renamed)).status).toBe(200);
    const after = await newPo({ supplierId: s.id, lines });
    expect(after.body.po.channel.label).toBe('农批市场');
    expect((await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${byDefault.body.po.id}`)).body.channel.label).toBe('批发市场');
    expect((await saveRules(boss, DEFAULT_PURCHASE_RULES)).status).toBe(200);
  });

  it('报销：按次报销记选的途径；按采购单报销照采购单；台账、下单物料、报销与台账导出都带途径', async () => {
    expect((await claim({ channel: 'store' })).body.error.code).toBe('CHANNEL_NOTE_REQUIRED');
    const adhoc = await claim({ channel: 'store', channelNote: '楼下便利店' });
    expect(adhoc.status).toBe(201);
    expect(adhoc.body.claim.channel).toEqual({ key: 'store', label: '商超门店', note: '楼下便利店' });
    // 不传（旧调用）记「未填」
    expect((await claim()).body.claim.channel).toBeNull();

    // 现付供应商的采购单：报销照采购单的途径，忽略页面传的
    const s = await supplier('S004');
    expect((await api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s.id}`, { code: s.code, name: s.name, settlement: 'cash' })).status).toBe(200);
    const mat = await material('M016');
    const created = (await newPo({ supplierId: s.id, channel: 'online', channelNote: '某某专营店', lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000 }] })).body.po;
    const po = (await api(ctx.app, approver, 'POST', `/api/purchase-orders/${created.id}/approve`, {})).body;
    expect(po.status).toBe('approved');
    const forClaim = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${po.id}`)).body;
    expect(forClaim.channel).toEqual({ key: 'online', label: '网购平台', note: '某某专营店' });
    const pl = forClaim.lines[0];
    const byPo = await claim({
      purchaseOrderId: po.id,
      purpose: '客用消耗',
      channel: 'store',
      channelNote: '页面传的不算',
      lines: [{ name: pl.name, category: 'low_value', unit: pl.unit, boughtMilli: pl.boughtMilli, receivedMilli: pl.receivedMilli, amountCents: 90_000, poLineId: pl.poLineId, diffReason: '还没到货' }],
    });
    expect(byPo.status).toBe(201);
    expect(byPo.body.claim.channel).toEqual({ key: 'online', label: '网购平台', note: '某某专营店' });

    // 采购台账：支出一行带途径；导出多一列
    const ledger = (await api(ctx.app, coster, 'GET', `/api/erp/ledger?from=${today}&to=${today}`)).body;
    const entries = ledger.days.flatMap((d: { entries: unknown[] }) => d.entries) as { docNo: string; channel: string | null }[];
    expect(entries.find((e) => e.docNo === adhoc.body.claim.docNo)?.channel).toBe('商超门店 · 楼下便利店');
    expect(entries.find((e) => e.docNo === byPo.body.claim.docNo)?.channel).toBe('网购平台 · 某某专营店');
    const ledgerCsv = String((await api(ctx.app, coster, 'GET', `/api/erp/ledger/export?from=${today}&to=${today}`)).body);
    expect(ledgerCsv).toContain('采购途径');
    expect(ledgerCsv).toContain('网购平台 · 某某专营店');
    // 报销导出：两列
    const claimsCsv = String((await api(ctx.app, approver, 'GET', `/api/erp/expenses/export?from=${today}&to=${today}`)).body);
    expect(claimsCsv).toContain('途径说明');
    expect(claimsCsv).toContain('楼下便利店');
    // 下单物料：页面与导出
    const ordered = (await api(ctx.app, keeper, 'GET', `/api/purchase-orders/ordered-lines?from=${today}&to=${today}`)).body;
    expect(ordered.lines.find((l: { poId: number }) => l.poId === po.id)?.channel).toBe('网购平台 · 某某专营店');
    const orderedCsv = String((await api(ctx.app, keeper, 'GET', `/api/purchase-orders/ordered-lines/export.csv?from=${today}&to=${today}`)).body);
    expect(orderedCsv.split('\n')[0]).toContain('供应商,采购途径,物料编码');
    // 收货不受影响
    const rc = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId: s.id,
      purchaseOrderId: po.id,
      coAcceptorId: buyerId,
      lines: [{ materialId: mat.id, poLineId: po.lines[0].id, deliveredMilli: q(1000), acceptedMilli: q(1000) }],
    });
    expect(rc.status).toBe(201);
  });
});

describe('② 采购单一键转报销（E2）', () => {
  it('现付采购单确认后进「待报销」；带出经办人、部门、最早没平的打款、上次的科目与用途；报完从待报销里消失，采购单上看得到报销单', async () => {
    const s = await supplier('S005');
    expect((await api(ctx.app, buyer, 'PUT', `/api/inventory/suppliers/${s.id}`, { code: s.code, name: s.name, settlement: 'cash', defaultChannel: 'wholesale' })).status).toBe(200);
    const mat = await material('M016');
    // 采购经办的档案部门 = 采购部；他在采购部有两笔没平的打款，最早的那笔被带出
    await ctx.sql`UPDATE staff SET department_id = ${deptA} WHERE id = ${buyerId}`;
    const adv = async (advanceDate: string) =>
      (await api(ctx.app, coster, 'POST', '/api/erp/petty/advances', {
        clientKey: randomUUID(),
        departmentId: deptA,
        handlerId: buyerId,
        advanceDate,
        amountCents: 200_000,
        method: 'wechat',
        evidence: '转账尾号 0002',
      })).body.advance;
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const older = await adv(yesterday);
    await adv(today);

    const mkPo = async () => {
      const created = (await newPo({ supplierId: s.id, channelNote: '3 号档', lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000 }] })).body.po;
      return (await api(ctx.app, approver, 'POST', `/api/purchase-orders/${created.id}/approve`, {})).body;
    };
    const po = await mkPo();
    expect(po.reimbursement).toEqual({ settlement: 'cash', claims: [], unclaimedLines: 1 });

    const list = (await api(ctx.app, keeper, 'GET', '/api/erp/expenses/to-claim')).body as { id: number }[];
    const row = list.find((r) => r.id === po.id);
    expect(row).toMatchObject({
      docNo: po.docNo,
      channel: { key: 'wholesale', label: '批发市场', note: '3 号档' },
      createdBy: { id: buyerId },
      departments: ['采购部'],
      openLines: 1,
      lineCount: 1,
      openCents: 90_000,
      receiving: 'none',
      ageDays: 0,
    });
    // 物资经办能看待报销，不能读带出的默认值（要能登记报销）
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/expenses/po/${po.id}/prefill`)).status).toBe(403);

    const first = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${po.id}/prefill`)).body;
    const lineId = first.po.lines[0].poLineId;
    expect(first.prefill).toMatchObject({
      handlerId: buyerId,
      departmentId: deptA,
      paySource: 'petty',
      advanceId: older.id,
      purpose: null,
      invoiceType: null,
      categories: { [lineId]: 'low_value' },
    });
    expect(first.prefill.basis.join('；')).toContain(older.docNo);

    // 按带出的报（科目改成办公费、用途选客用消耗），之后从待报销里消失
    const pl = first.po.lines[0];
    const done = await claim({
      purchaseOrderId: po.id,
      departmentId: first.prefill.departmentId,
      handlerId: first.prefill.handlerId,
      paySource: 'petty',
      advanceId: first.prefill.advanceId,
      purpose: '客用消耗',
      invoiceType: 'vat_normal',
      taxRateBp: 300,
      invoiceNo: 'FP-0001',
      lines: [{ name: pl.name, category: 'office', unit: pl.unit, boughtMilli: pl.boughtMilli, receivedMilli: pl.receivedMilli, amountCents: pl.amountCents, poLineId: pl.poLineId, diffReason: '货在路上' }],
    });
    expect(done.status).toBe(201);
    expect(done.body.claim.channel).toMatchObject({ key: 'wholesale', note: '3 号档' });
    expect(((await api(ctx.app, keeper, 'GET', '/api/erp/expenses/to-claim')).body as { id: number }[]).some((r) => r.id === po.id)).toBe(false);
    const after = (await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${po.id}`)).body;
    expect(after.reimbursement).toMatchObject({ settlement: 'cash', unclaimedLines: 0, claims: [{ id: done.body.claim.id, docNo: done.body.claim.docNo, status: 'confirmed', amountCents: 90_000 }] });

    // 同一供应商、同一物料的下一张：用途、发票、科目照上一张
    const po2 = await mkPo();
    const second = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${po2.id}/prefill`)).body;
    expect(second.prefill).toMatchObject({ purpose: '客用消耗', invoiceType: 'vat_normal', taxRateBp: 300, categories: { [second.po.lines[0].poLineId]: 'office' } });
    expect(second.prefill.basis.join('；')).toContain(done.body.claim.docNo);

    // 挂账的采购单不能转报销
    const credit = await supplier('S001');
    const creditPo = (await newPo({ supplierId: credit.id, lines: [{ materialId: mat.id, purchaseQtyMilli: q(1), priceCents: 45_000 }] })).body.po;
    await api(ctx.app, approver, 'POST', `/api/purchase-orders/${creditPo.id}/approve`, {});
    expect((await api(ctx.app, coster, 'GET', `/api/erp/expenses/po/${creditPo.id}/prefill`)).body.error.code).toBe('CREDIT_SUPPLIER');
    expect((await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${creditPo.id}`)).body.reimbursement.settlement).toBe('credit');
  });
});

describe('③ 部门备用金台账（E3）', () => {
  it('看板：余额、在手、待补付、待确认、本月支出、建议补足；台账逐笔带余额、期初期末、明细与途径；设置带版本号；自检一致', async () => {
    const { pettyAccountChecks } = await import('../src/server/modules/petty-accounts');
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name: '水吧' });
    const deptB = (await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body.find((d: { name: string }) => d.name === '水吧').id as number;
    const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

    // 设置：只有能登记打款的人能改；版本号对不上的拒绝
    expect((await api(ctx.app, keeper, 'PUT', `/api/erp/petty/accounts/${deptB}`, { custodianId: costerId, limitCents: 300_000, version: 0 })).status).toBe(403);
    const set = await api(ctx.app, coster, 'PUT', `/api/erp/petty/accounts/${deptB}`, { custodianId: costerId, limitCents: 300_000, note: '水吧零用', version: 0 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ custodian: { id: costerId }, limitCents: 300_000, note: '水吧零用', version: 1 });
    expect((await api(ctx.app, coster, 'PUT', `/api/erp/petty/accounts/${deptB}`, { custodianId: null, limitCents: 300_000, version: 0 })).body.error.code).toBe('VERSION_CONFLICT');
    expect((await api(ctx.app, coster, 'PUT', `/api/erp/petty/accounts/${deptB}`, { custodianId: costerId, limitCents: 0, version: 1 })).status).toBe(400);

    const advance = async (advanceDate: string, amountCents: number) =>
      (await api(ctx.app, coster, 'POST', '/api/erp/petty/advances', {
        clientKey: randomUUID(),
        departmentId: deptB,
        handlerId: costerId,
        advanceDate,
        amountCents,
        method: 'cash',
        evidence: '现金当面点清',
      })).body.advance;
    const old = await advance(daysAgo(3), 30_000);
    const a1 = await advance(today, 200_000);
    const pettyClaim = (advanceId: number, amountCents: number, body: Record<string, unknown> = {}) =>
      claim({ departmentId: deptB, paySource: 'petty', advanceId, lines: [{ name: '柠檬', category: 'low_value', unit: '斤', boughtMilli: q(5), receivedMilli: q(5), amountCents }], ...body });
    const c1 = (await pettyClaim(a1.id, 50_000, { channel: 'wholesale', channelNote: '水果档' })).body.claim;
    expect(c1.status).toBe('confirmed');
    // 超过确认门槛（¥2,000）的待确认，不算进余额
    const c2 = (await pettyClaim(a1.id, 210_000)).body.claim;
    expect(c2.status).toBe('submitted');
    // 旧的那笔花超了：经办人垫了 ¥100，等公司补付
    const c3 = (await pettyClaim(old.id, 40_000, { expenseDate: daysAgo(2) })).body.claim;
    expect(c3.status).toBe('confirmed');
    const ret = await api(ctx.app, coster, 'POST', '/api/erp/petty/settlements', {
      clientKey: randomUUID(),
      advanceId: a1.id,
      kind: 'return',
      settleDate: today,
      amountCents: 50_000,
      method: 'cash',
      evidence: '退回现金',
    });
    expect(ret.status).toBe(201);

    // 看板：a1 未退回 200,000 − 50,000 − 50,000 = 100,000；旧的 30,000 − 40,000 = −10,000
    const board = (await api(ctx.app, keeper, 'GET', '/api/erp/petty/accounts')).body as { department: { id: number } }[];
    expect(board.find((r) => r.department.id === deptB)).toMatchObject({
      custodian: { id: costerId },
      limitCents: 300_000,
      balanceCents: 90_000,
      inHandCents: 100_000,
      owedCents: 10_000,
      pendingCents: 210_000,
      monthSpentCents: today.slice(0, 7) === daysAgo(2).slice(0, 7) ? 90_000 : 50_000,
      openAdvances: 2,
      overdue: 0,
      topUpCents: 210_000,
      lastDate: today,
    });

    // 台账：今天这一段的期初 = 之前的 30,000 − 40,000；逐笔带余额
    const j = (await api(ctx.app, keeper, 'GET', `/api/erp/petty/accounts/${deptB}/journal?from=${today}&to=${today}`)).body;
    expect(j).toMatchObject({ openingCents: -10_000, inCents: 200_000, outCents: 100_000, closingCents: 90_000, limitCents: 300_000, truncated: false });
    expect(j.entries.map((e: { kind: string; deltaCents: number; balanceCents: number }) => [e.kind, e.deltaCents, e.balanceCents])).toEqual([
      ['advance', 200_000, 190_000],
      ['expense', -50_000, 140_000],
      ['return', -50_000, 90_000],
    ]);
    const exp = j.entries.find((e: { kind: string }) => e.kind === 'expense');
    expect(exp).toMatchObject({ docNo: c1.docNo, description: '办公', channel: '批发市场 · 水果档', items: [{ name: '柠檬', boughtMilli: q(5), unit: '斤', amountCents: 50_000 }] });
    expect(j.pending.map((c: { id: number }) => c.id)).toEqual([c2.id]);
    // 整段：期初 0，期末与看板相同
    const all = (await api(ctx.app, keeper, 'GET', `/api/erp/petty/accounts/${deptB}/journal?from=${daysAgo(5)}&to=${today}`)).body;
    expect(all).toMatchObject({ openingCents: 0, closingCents: 90_000 });
    expect(all.entries).toHaveLength(5);

    // 导出：要导出权限
    expect((await api(ctx.app, keeper, 'GET', `/api/erp/petty/accounts/${deptB}/journal/export?from=${today}&to=${today}`)).status).toBe(403);
    const csv = String((await api(ctx.app, approver, 'GET', `/api/erp/petty/accounts/${deptB}/journal/export?from=${today}&to=${today}`)).body);
    expect(csv).toContain('期初余额');
    expect(csv).toContain(c1.docNo);
    expect(csv).toContain('柠檬 5斤');

    for (const c of await pettyAccountChecks(ctx.sql)) expect(c, c.detail).toMatchObject({ ok: true });
  });
});

describe('④ 补货建议（E4）', () => {
  it('取整与目标天数：按采购单位向上取整，换算后不是整库存单位的再多加一包；提醒天数不短于目标天数时补到提醒天数 + 7', async () => {
    const { packsFor, targetDaysFor } = await import('../src/server/modules/inventory/replenish');
    expect(packsFor(q(13), q(12), 0)).toEqual({ purchaseMilli: q(2), baseMilli: q(24) });
    expect(packsFor(q(1), q(12), 0)).toEqual({ purchaseMilli: q(1), baseMilli: q(12) });
    // 半箱 = 0.5 个：库存单位不带小数时一箱不够整，取 2 箱
    expect(packsFor(q(0.3), q(0.5), 0)).toEqual({ purchaseMilli: q(2), baseMilli: q(1) });
    expect(targetDaysFor(7, 14)).toBe(14);
    expect(targetDaysFor(20, 14)).toBe(27);
  });

  it('没有用量的按低库存提醒数量补；有用量的按可用天数（含在途）补到目标天数；按默认供应商、最近收货的供应商分组；草稿算在途', async () => {
    const s3 = await supplier('S003');
    const s4 = await supplier('S004');
    const mkMaterial = async (body: Record<string, unknown>) => {
      const res = await api(ctx.app, buyer, 'POST', '/api/inventory/materials', { category: '测试', ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return (await material(body.code as string)) as { id: number };
    };
    const x = await mkMaterial({ code: 'RX01', name: '矿泉水（补货）', inventoryUnit: '瓶', purchaseUnit: '箱', purchaseFactorMilli: q(12), refPriceCents: 6_000, defaultSupplierId: s3.id, lowStockMilli: q(24) });
    const y = await mkMaterial({ code: 'RY01', name: '纸巾（补货）', inventoryUnit: '包', purchaseUnit: '包', purchaseFactorMilli: q(1), refPriceCents: 500, coverDays: 5 });
    const suggest = async () => (await api(ctx.app, keeper, 'GET', '/api/purchase-suggestions')).body;
    const lineOf = (d: { groups: { supplier: { id: number } | null; lines: { materialId: number }[] }[] }, id: number) => {
      for (const g of d.groups) {
        const l = g.lines.find((x) => x.materialId === id);
        if (l) return { supplierId: g.supplier?.id ?? null, line: l as Record<string, unknown> };
      }
      return null;
    };

    // X：没有用量、结存 0 低于 24 瓶 → 补 2 箱，参考价，归默认供应商
    let d = await suggest();
    expect(d).toMatchObject({ windowDays: 28, reorderDays: 7, targetDays: 14 });
    expect(lineOf(d, x.id)).toEqual({
      supplierId: s3.id,
      line: expect.objectContaining({ reason: 'low_stock', stockMilli: 0, inTransitMilli: 0, suggestedPurchaseMilli: q(2), suggestedBaseMilli: q(24), priceCents: 6_000, priceSource: 'ref', amountCents: 12_000 }),
    });
    // Y 没有用量、也没设提醒数量：不建议
    expect(lineOf(d, y.id)).toBeNull();

    // 草稿 1 箱算在途：只差 1 箱
    const draft = (await newPo({ supplierId: s3.id, action: 'save', lines: [{ materialId: x.id, purchaseQtyMilli: q(1), priceCents: 6_000 }] })).body.po;
    d = await suggest();
    expect(lineOf(d, x.id)?.line).toMatchObject({ inTransitMilli: q(12), openPos: [draft.docNo], suggestedPurchaseMilli: q(1) });

    // Y：从 S004 收 30 包、领走 28 包 → 日均 1 包，够用 2 天 < 5 天 → 补到 14 天：14 − 2 = 12 包，最近成交价，归最近收货的供应商
    const yPo = (await newPo({ supplierId: s4.id, lines: [{ materialId: y.id, purchaseQtyMilli: q(30), priceCents: 450 }] })).body.po;
    await api(ctx.app, approver, 'POST', `/api/purchase-orders/${yPo.id}/approve`, {});
    const rc = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId: s4.id,
      purchaseOrderId: yPo.id,
      coAcceptorId: buyerId,
      lines: [{ materialId: y.id, poLineId: yPo.lines[0].id, deliveredMilli: q(30), acceptedMilli: q(30) }],
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    const issue = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'issue',
      docDate: today,
      departmentId: deptA,
      handler: '采购部',
      lines: [{ materialId: y.id, qtyMilli: q(28) }],
    });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);
    d = await suggest();
    expect(lineOf(d, y.id)).toEqual({
      supplierId: s4.id,
      line: expect.objectContaining({
        reason: 'cover',
        stockMilli: q(2),
        dailyUsageMilli: q(1),
        daysOfCover: 2,
        triggerDays: 5,
        targetDays: 14,
        suggestedPurchaseMilli: q(12),
        priceCents: 450,
        priceSource: 'last',
        amountCents: 5_400,
      }),
    });
    expect(d.count).toBe(d.groups.reduce((t: number, g: { lines: unknown[] }) => t + g.lines.length, 0));
    // 店员看不到
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/purchase-suggestions')).status).toBe(403);
  });
});

describe('⑤ 询价比价与定标（E5–E8）', () => {
  it('询价门槛：合计 ≥ ¥5,000 的采购单直接提交被拒，可以存草稿；门槛设 0 不要求', async () => {
    const s1 = await supplier('S001');
    const mat = await material('M016');
    const big = { supplierId: s1.id, lines: [{ materialId: mat.id, purchaseQtyMilli: q(20), priceCents: 45_000 }] };
    const rejected = await newPo(big);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('QUOTES_REQUIRED');
    expect(rejected.body.error.message).toContain('¥5,000.00');
    const draft = (await newPo({ ...big, action: 'save' })).body.po;
    expect(draft.status).toBe('draft');
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${draft.id}/submit`, {})).body.error.code).toBe('QUOTES_REQUIRED');
    // ¥5,000 以下照常
    expect((await newPo({ supplierId: s1.id, lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000 }] })).status).toBe(201);
    // 门槛设 0：不要求
    expect((await saveRules(boss, { ...DEFAULT_PURCHASE_RULES, quoteThresholdCents: 0 })).status).toBe(200);
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${draft.id}/submit`, {})).body.status).toBe('submitted');
    expect((await saveRules(boss, DEFAULT_PURCHASE_RULES)).status).toBe(200);
  });

  it('询价 → 两家报价比价 → 定标 → 转采购单 → 提交过门槛；单一来源要负责人；价格曲线带成交价与报价', async () => {
    const s1 = await supplier('S001');
    const s2 = await supplier('S002');
    const s3 = await supplier('S003');
    const mat = await material('M016');
    const create = (body: Record<string, unknown>, cookie = buyer) => api(ctx.app, cookie, 'POST', '/api/purchase-sourcing', { clientKey: randomUUID(), ...body });
    const quote = (eventId: number, body: Record<string, unknown>) =>
      api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${eventId}/quotes`, { clientKey: randomUUID(), payTerms: '月结 30 天', ...body });

    expect((await create({ title: '护理床单 20 箱', lines: [{ materialId: mat.id, purchaseQtyMilli: q(20) }] }, keeper)).status).toBe(403);
    const key = randomUUID();
    const made = await api(ctx.app, buyer, 'POST', '/api/purchase-sourcing', { clientKey: key, title: '护理床单 20 箱', needBy: today, lines: [{ materialId: mat.id, purchaseQtyMilli: q(20) }] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // 同一编号重提：返回原询价单
    const again = await api(ctx.app, buyer, 'POST', '/api/purchase-sourcing', { clientKey: key, title: '护理床单 20 箱', needBy: today, lines: [{ materialId: mat.id, purchaseQtyMilli: q(20) }] });
    expect(again.status).toBe(200);
    expect(again.body.event.id).toBe(made.body.event.id);
    const e1 = made.body.event;
    expect(e1).toMatchObject({ status: 'open', minQuotes: 2, lines: [{ materialId: mat.id, purchaseQtyMilli: q(20), baseQtyMilli: q(10_000), purchaseUnit: '箱' }] });
    const lineId = e1.lines[0].id;

    // 报价：甲 ¥450/箱、无运费；乙 ¥440/箱 + 运费 ¥300（综合到价更高）
    const a = await quote(e1.id, { supplierId: s1.id, prices: [{ lineId, priceCents: 45_000 }], creditDays: 30 });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const b = await quote(e1.id, { supplierId: s2.id, freightCents: 30_000, payTerms: '预付 50%', prices: [{ lineId, priceCents: 44_000 }] });
    expect(b.status).toBe(200);
    expect((await quote(e1.id, { supplierId: s1.id, prices: [{ lineId, priceCents: 1 }] })).body.error.code).toBe('QUOTE_EXISTS');
    expect((await quote(e1.id, { supplierId: s3.id, prices: [{ lineId: lineId + 9999, priceCents: 1 }] })).body.error.code).toBe('QUOTE_LINES');
    expect((await quote(e1.id, { supplierId: s3.id, validUntil: '2020-01-01', prices: [{ lineId, priceCents: 1 }] })).body.error.code).toBe('QUOTE_EXPIRED');
    const ev = (await api(ctx.app, keeper, 'GET', `/api/purchase-sourcing/${e1.id}`)).body;
    const qa = ev.quotes.find((x: { supplier: { id: number } }) => x.supplier.id === s1.id);
    const qb = ev.quotes.find((x: { supplier: { id: number } }) => x.supplier.id === s2.id);
    expect(qa).toMatchObject({ goodsCents: 900_000, freightCents: 0, landedCents: 900_000, rank: 1, payTerms: '月结 30 天', creditDays: 30 });
    expect(qb).toMatchObject({ goodsCents: 880_000, freightCents: 30_000, landedCents: 910_000, rank: 2 });
    // 单行最低的是乙
    expect(ev.lowest).toEqual({ [lineId]: qb.id });
    expect(ev.lines[0].baseline).not.toBeNull();
    const list = (await api(ctx.app, keeper, 'GET', '/api/purchase-sourcing?status=open')).body;
    expect(list.find((x: { id: number }) => x.id === e1.id)).toMatchObject({ quoteCount: 2, lowestLandedCents: 900_000, summary: mat.name });

    // 定标甲（理由必填）；定标后不能再报价
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e1.id}/award`, { quoteId: qa.id, reason: '' })).status).toBe(400);
    const awarded = await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e1.id}/award`, { quoteId: qa.id, reason: '综合到价最低，月结' });
    expect(awarded.body).toMatchObject({ status: 'awarded', awardedQuoteId: qa.id, awardReason: '综合到价最低，月结', singleSource: false });
    expect((await quote(e1.id, { supplierId: s3.id, prices: [{ lineId, priceCents: 1 }] })).body.error.code).toBe('INVALID_STATE');

    // 转采购单：草稿、按中标价、记下询价单；同一张询价单不能再转
    const ordered = await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e1.id}/order`, { clientKey: randomUUID() });
    expect(ordered.status, JSON.stringify(ordered.body)).toBe(201);
    const po = ordered.body.po;
    expect(po).toMatchObject({ status: 'draft', supplier: { id: s1.id }, totalCents: 900_000, sourcing: { id: e1.id, docNo: e1.docNo, status: 'awarded' }, expectedDate: today });
    expect(po.note).toContain(e1.docNo);
    expect(po.lines[0]).toMatchObject({ materialId: mat.id, purchaseQtyMilli: q(20), priceCents: 45_000 });
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e1.id}/order`, { clientKey: randomUUID() })).body.error.code).toBe('SOURCING_ORDERED');
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e1.id}/reopen`, { reason: '想换一家' })).body.error.code).toBe('SOURCING_ORDERED');
    // 提交：来自已定标的询价单，过门槛（超过 ¥2,000 等负责人确认）
    const submitted = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/submit`, {});
    expect(submitted.body.status).toBe('submitted');

    // 单一来源：只有一家报价，采购不能定标，负责人写清原因可以
    const e2 = (await create({ title: '指定品牌洗发水', lines: [{ materialId: mat.id, purchaseQtyMilli: q(30) }] })).body.event;
    const only = (await quote(e2.id, { supplierId: s3.id, prices: [{ lineId: e2.lines[0].id, priceCents: 40_000 }] })).body.quotes[0];
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e2.id}/award`, { quoteId: only.id, reason: '只有一家' })).body.error.code).toBe('QUOTES_NOT_ENOUGH');
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e2.id}/award`, { quoteId: only.id, reason: '品牌指定只此一家', singleSource: true })).status).toBe(403);
    expect((await api(ctx.app, approver, 'POST', `/api/purchase-sourcing/${e2.id}/award`, { quoteId: only.id, reason: '只此家', singleSource: true })).body.error.code).toBe('REASON_TOO_SHORT');
    const single = await api(ctx.app, approver, 'POST', `/api/purchase-sourcing/${e2.id}/award`, { quoteId: only.id, reason: '品牌指定只此一家', singleSource: true });
    expect(single.body).toMatchObject({ status: 'awarded', singleSource: true });
    // 转出的草稿改了供应商：提交被拒；撤回采购单后可以撤销定标、撤销询价单
    const po2 = (await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e2.id}/order`, { clientKey: randomUUID() })).body.po;
    const changed = await api(ctx.app, buyer, 'PUT', `/api/purchase-orders/${po2.id}`, {
      supplierId: s2.id,
      orderDate: today,
      action: 'submit',
      lines: [{ id: po2.lines[0].id, materialId: mat.id, purchaseQtyMilli: q(30), priceCents: 40_000 }],
    });
    expect(changed.body.error.code).toBe('QUOTES_REQUIRED');
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po2.id}/cancel`, { reason: '换供应商' })).body.status).toBe('cancelled');
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e2.id}/reopen`, { reason: '重新询价' })).body).toMatchObject({ status: 'open', awardedQuoteId: null });
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-sourcing/${e2.id}/cancel`, { reason: '不买了' })).body).toMatchObject({ status: 'cancelled', cancelReason: '不买了' });

    // 价格曲线：近 12 个月的成交价与报价（撤销的询价单不算）
    const hist = (await api(ctx.app, keeper, 'GET', `/api/purchase-price-history?materialId=${mat.id}`)).body;
    expect(hist.materialName).toBe(mat.name);
    const quotes = hist.points.filter((p: { source: string }) => p.source === 'quote');
    expect(quotes.map((p: { docNo: string; priceCents: number }) => [p.docNo, p.priceCents]).sort()).toEqual([
      [e1.docNo, 44_000],
      [e1.docNo, 45_000],
    ]);
    expect(hist.points.some((p: { source: string }) => p.source === 'receipt')).toBe(true);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/purchase-price-history?materialId=${mat.id}`)).status).toBe(403);
  });
});
