// v0.7.31 合同与法务审查（docs/CONTRACTS.md，C1–C12 待确认）：
//   · 起草（操作编号重提返回原来那份）、提交前要齐的（付款节点 100%、采购合同要有单价表）；
//   · 审查走审批中心：默认 财务 → 法务 → 负责人；法务那一级没有审查清单、有「要修改」不能同意，退回可以只填有问题的几条；
//     改了再提交是新的一份提交记录，从第一级重新走；同一个人按原内容重提已审过的一级不重复记清单；
//   · 审批通过 → 签署 → 用印申请（默认一级店主）→ 上传扫描件 → 归档；
//   · 变更单：同样走审查，同意后版本号加 1、单价表按新的一版，旧版本留着；
//   · 采购单按合同核对（超价、超量）；到期前 60 天的提醒（续签生效的不提醒）；
//   · 合同类不能批量同意；合同的审批规则要有且只有一级「法务」；部门账号看不到合同；自检一致。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalChecks } from '../src/server/modules/approvals/engine';
import { contractChecks } from '../src/server/modules/contracts/ledger';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { DEFAULT_PAYMENT_TERMS, LEGAL_ITEM_KEYS, type ContractDetail } from '../src/shared/contracts';
import { shiftDate } from '../src/shared/labels';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string; // 店主
let buyer: string; // 采购经办（维护合同）
let payer: string; // 对账付款（财务）
let lawyer: string; // 法务
let mgr: string; // 负责人
let dept: string; // 部门申购
let supplierId: number;
let mat: { id: number; name: string; purchaseUnit: string };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnxEJMAIAJF4C/3FpsJcAAAAASUVORK5CYII=', 'base64');
/** 另一张图（与上面那张内容不同，不会按内容去重） */
const PNG2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const content = (over: Record<string, unknown> = {}) => ({
  title: '洗浴用品年度采购',
  startDate: today,
  endDate: shiftDate(today, 365),
  totalCents: 12_000_00,
  taxRateBp: 1300,
  freightBearer: 'supplier',
  unloadingBearer: 'supplier',
  paymentTerms: DEFAULT_PAYMENT_TERMS,
  warranty: { basis: 'acceptance', months: 12 },
  acceptance: { method: '按样品验收', signer: '仓库经办', penalty: '不合格的退换' },
  note: '',
  lines: [{ materialId: mat.id, itemName: '', spec: '500ml', unit: '', priceCents: 50_00, taxRateBp: 1300, qtyMilli: 100_000 }],
  ...over,
});
const allPass = () => LEGAL_ITEM_KEYS.map((key) => ({ key, verdict: 'pass', note: '' }));
const get = async (id: number, cookie = buyer) => {
  const r = await api(ctx.app, cookie, 'GET', `/api/erp/contracts/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as ContractDetail;
};
const create = async (body: Record<string, unknown> = {}) => {
  const r = await api(ctx.app, buyer, 'POST', '/api/erp/contracts', { clientKey: randomUUID(), category: 'purchase', supplierId, counterparty: '', content: content(), ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.contract as ContractDetail;
};
const op = async (id: number, action: string, body: Record<string, unknown>, cookie = buyer) => {
  const r = await api(ctx.app, cookie, 'POST', `/api/erp/contracts/${id}/${action}`, body);
  return r;
};
/** 走审批中心：按审批单号与级别同意 */
const approveAt = (cookie: string, requestId: number, level: number, extra: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', `/api/approvals/${requestId}/approve`, { level, comment: '', ...extra });

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  payer = await login(ctx.app, 'qianfen', 'yuzu2026');
  const staff = async (username: string, displayName: string, duties: ('approve' | 'legal' | 'request')[], departmentId: number | null = null) => {
    await createStaff(ctx.sql, { username, displayName, role: 'backoffice', duties, departmentId, password: PASSWORD, mustChangePassword: false });
    return login(ctx.app, username);
  };
  lawyer = await staff('legal_wu', '法务吴', ['legal']);
  mgr = await staff('mgr_c', '负责人丙', ['approve']);
  const [d] = await ctx.sql<{ id: number }[]>`SELECT id FROM departments ORDER BY id LIMIT 1`;
  dept = await staff('dept_d', '部门丁', ['request'], Number(d!.id));
  const suppliers = (await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; active: boolean }[];
  supplierId = suppliers.find((s) => s.active)!.id;
  const materials = (await api(ctx.app, boss, 'GET', '/api/inventory/materials?all=1')).body as { id: number; name: string; purchaseUnit: string; active: boolean; tracked: boolean }[];
  mat = materials.find((m) => m.active && m.tracked)!;
});
afterAll(async () => ctx.close());

describe('合同与法务审查', () => {
  let c: ContractDetail;

  it('起草：操作编号重提返回原来那份；提交前付款节点要加起来 100%', async () => {
    const clientKey = randomUUID();
    const body = { clientKey, category: 'purchase', supplierId, counterparty: '', content: content() };
    const a = await api(ctx.app, buyer, 'POST', '/api/erp/contracts', body);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await api(ctx.app, buyer, 'POST', '/api/erp/contracts', body);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.contract.id).toBe(a.body.contract.id);
    c = a.body.contract;
    expect(c.status).toBe('draft');
    expect(c.contractNo).toMatch(/^HT\d{8}-\d{4}$/);
    expect(c.counterparty).not.toBe('');
    // 单价表的品名、单位没填的取物料档案
    expect(c.content.lines[0]).toMatchObject({ itemName: mat.name, unit: mat.purchaseUnit });

    // 付款节点加起来 90%：存草稿可以，提交审查不行
    const terms = DEFAULT_PAYMENT_TERMS.map((t) => (t.stage === 'prepay' ? { ...t, percentBp: 2000 } : t));
    const saved = await api(ctx.app, buyer, 'PUT', `/api/erp/contracts/${c.id}`, { version: c.version, category: 'purchase', supplierId, content: content({ paymentTerms: terms }) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const bad = await op(c.id, 'submit', { version: saved.body.version });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('CONTRACT_PAYMENT_TERMS');
    // 版本号对不上拒绝
    const stale = await api(ctx.app, buyer, 'PUT', `/api/erp/contracts/${c.id}`, { version: c.version, category: 'purchase', supplierId, content: content() });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const fixed = await api(ctx.app, buyer, 'PUT', `/api/erp/contracts/${c.id}`, { version: saved.body.version, category: 'purchase', supplierId, content: content() });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    c = fixed.body;
  });

  it('审查：财务 → 法务（审查清单）→ 负责人；法务退回后改了再提交从第一级重新走', async () => {
    const sub = await op(c.id, 'submit', { version: c.version });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    c = sub.body;
    expect(c.status).toBe('reviewing');
    expect(c.approval).toMatchObject({ levels: 3, currentLevel: 1, stepLabels: ['财务', '法务', '负责人'] });
    expect(c.revisions).toHaveLength(1);
    const rid = c.approval!.requestId;

    // 起草的人（采购）不在财务这一级
    expect((await approveAt(buyer, rid, 1)).status).toBe(403);
    expect((await approveAt(payer, rid, 1)).status).toBe(200);
    // 法务：没有清单、有「要修改」都不能同意
    const none = await approveAt(lawyer, rid, 2);
    expect(none.body.error.code).toBe('LEGAL_CHECKLIST_REQUIRED');
    const partial = await approveAt(lawyer, rid, 2, { checklist: allPass().slice(0, 5) });
    expect(partial.body.error.code).toBe('LEGAL_CHECKLIST_REQUIRED');
    const revise = allPass().map((i) => (i.key === 'liability' ? { ...i, verdict: 'revise', note: '违约金比例太低' } : i));
    expect((await approveAt(lawyer, rid, 2, { checklist: revise })).body.error.code).toBe('LEGAL_CHECKLIST_REVISE');
    const riskNoNote = allPass().map((i) => (i.key === 'dispute' ? { ...i, verdict: 'risk' } : i));
    expect((await approveAt(lawyer, rid, 2, { checklist: riskNoNote })).body.error.code).toBe('LEGAL_CHECKLIST_NOTE');
    // 负责人不在法务这一级
    expect((await approveAt(mgr, rid, 2, { checklist: allPass() })).status).toBe(403);
    // 法务退回：只填有问题的那一条
    const ret = await api(ctx.app, lawyer, 'POST', `/api/approvals/${rid}/return`, {
      level: 2,
      reason: '违约责任要补',
      checklist: [{ key: 'liability', verdict: 'revise', note: '违约金比例太低' }],
    });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    c = await get(c.id);
    expect(c.status).toBe('returned');
    expect(c.revisions[0]!.reviews).toEqual([expect.objectContaining({ level: 2, action: 'return', reviewerName: '法务吴', items: [{ key: 'liability', verdict: 'revise', note: '违约金比例太低' }] })]);

    // 改了再提交：新的一份提交记录，从第一级重新走
    const edited = await api(ctx.app, buyer, 'PUT', `/api/erp/contracts/${c.id}`, {
      version: c.version,
      category: 'purchase',
      supplierId,
      content: content({ acceptance: { method: '按样品验收', signer: '仓库经办', penalty: '不合格的退换，并按货款 5% 付违约金' } }),
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    c = (await op(c.id, 'submit', { version: edited.body.version })).body;
    expect(c.revisions.map((r) => r.seq)).toEqual([2, 1]);
    const rid2 = c.approval!.requestId;
    expect(rid2).not.toBe(rid);
    expect(c.approval!.currentLevel).toBe(1);
    expect((await approveAt(payer, rid2, 1)).status).toBe(200);
    const risk = allPass().map((i) => (i.key === 'dispute' ? { ...i, verdict: 'risk', note: '管辖法院在对方所在地' } : i));
    expect((await approveAt(lawyer, rid2, 2, { checklist: risk })).status).toBe(200);
    // 同一个人按原内容重提已审过的一级：按已同意处理，不重复记清单
    expect((await approveAt(lawyer, rid2, 2, { checklist: risk })).status).toBe(200);
    // 合同类不能批量同意
    const batch = await api(ctx.app, mgr, 'POST', '/api/approvals/batch-approve', { items: [{ id: rid2, level: 3 }], comment: '' });
    expect(batch.body.results[0]).toMatchObject({ ok: false, code: 'APPROVAL_NO_BATCH' });
    // 审批中心的详情：合同要点、单价表、法务的结论
    const detail = await api(ctx.app, mgr, 'GET', `/api/approvals/${rid2}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.doc.contract).toMatchObject({ kind: 'contract', contractId: c.id });
    // 「打开原单据」直达合同详情（Codex 自动审查 9d5272b）
    expect(detail.body.doc.link).toBe(`/erp/contracts/${c.id}`);
    expect(detail.body.doc.contract.reviews).toHaveLength(1);
    expect(detail.body.doc.lines[0]).toMatchObject({ name: mat.name, priceCents: 50_00 });
    expect((await approveAt(mgr, rid2, 3)).status).toBe(200);
    c = await get(c.id);
    expect(c.status).toBe('approved');
    expect(c.currentVersion).toBe(1);
    expect(c.revisions[0]).toMatchObject({ seq: 2, versionNo: 1 });
    expect(c.revisions[0]!.reviews).toEqual([expect.objectContaining({ level: 2, action: 'approve', items: expect.arrayContaining([{ key: 'dispute', verdict: 'risk', note: '管辖法院在对方所在地' }]) })]);
    expect(c.revisions[1]).toMatchObject({ seq: 1, versionNo: null });
  });

  it('签署、用印（默认一级店主）、扫描件、归档', async () => {
    // 没签署不能归档
    expect((await op(c.id, 'archive', { version: c.version, archiveLocation: '财务室 1 号柜' })).body.error.code).toBe('INVALID_STATE');
    const signed = await op(c.id, 'sign', { version: c.version, signedOn: today, ourSignatory: '林岚', theirSignatory: '王经理' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    c = signed.body;
    expect(c.status).toBe('signed');
    // 用印申请：提交即走审批，默认一级店主
    const seal = await api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/seals`, {
      clientKey: randomUUID(),
      sealType: 'contract',
      copies: 2,
      operatorId: c.handlerId,
      sealDate: today,
      purpose: '合同盖章',
    });
    expect(seal.status, JSON.stringify(seal.body)).toBe(201);
    expect(seal.body.seal).toMatchObject({ status: 'reviewing', approval: expect.objectContaining({ stepLabels: ['店主'] }) });
    // 有了没生效的用印登记，归档也不行
    expect((await op(c.id, 'archive', { version: c.version, archiveLocation: '财务室 1 号柜' })).body.error.code).toBe('CONTRACT_SEAL_REQUIRED');
    expect((await approveAt(mgr, seal.body.seal.approval.requestId, 1)).status).toBe(403);
    expect((await approveAt(boss, seal.body.seal.approval.requestId, 1)).status).toBe(200);
    c = await get(c.id);
    expect(c.seals[0]!.status).toBe('approved');
    // 没有扫描件不能归档
    expect((await op(c.id, 'archive', { version: c.version, archiveLocation: '财务室 1 号柜' })).body.error.code).toBe('CONTRACT_FILE_REQUIRED');
    const file = await api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/files`, { mime: 'image/png', data: PNG.toString('base64') });
    expect(file.status, JSON.stringify(file.body)).toBe(201);
    c = file.body;
    expect(c.files).toHaveLength(1);
    // 没收到结果、同一张图重新上传：不另记一份
    const again = await api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/files`, { mime: 'image/png', data: PNG.toString('base64') });
    expect(again.status).toBe(201);
    expect(again.body.files.map((f: { id: number }) => f.id)).toEqual(c.files.map((f) => f.id));
    c = again.body;
    const img = await api(ctx.app, lawyer, 'GET', c.files[0]!.url);
    expect(img.status).toBe(200);
    const archived = await op(c.id, 'archive', { version: c.version, archiveLocation: '财务室 1 号柜' });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    c = archived.body;
    expect(c.status).toBe('archived');
    expect(c.archiveNo).toMatch(/^GD\d{8}-\d{4}$/);
    // 归档以后扫描件不能删
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/contracts/files/${c.files[0]!.id}/remove`, {})).body.error.code).toBe('INVALID_STATE');
  });

  it('变更单：改价走审查，同意后版本号加 1、单价表按新的一版，旧版本留着', async () => {
    const x = await api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/changes`, {
      clientKey: randomUUID(),
      kinds: ['price'],
      reason: '原材料涨价，单价调到 55 元',
      content: { ...content({ totalCents: 13_200_00 }), lines: [{ ...content().lines[0], priceCents: 55_00 }] },
    });
    expect(x.status, JSON.stringify(x.body)).toBe(201);
    expect(x.body.change).toMatchObject({ status: 'draft', baseVersion: 1, deltaCents: 1_200_00 });
    // 同一合同同时只有一张没结束的变更单
    const dup = await api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/changes`, { clientKey: randomUUID(), kinds: ['other'], reason: '再开一张', content: content() });
    expect(dup.body.error.code).toBe('CONTRACT_CHANGE_OPEN');
    const sub = await api(ctx.app, buyer, 'POST', `/api/erp/contracts/changes/${x.body.change.id}/submit`, { version: x.body.change.version });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const ch = (sub.body as ContractDetail).changes[0]!;
    expect(ch.status).toBe('reviewing');
    const rid = ch.approval!.requestId;
    expect((await approveAt(payer, rid, 1)).status).toBe(200);
    expect((await approveAt(lawyer, rid, 2)).body.error.code).toBe('LEGAL_CHECKLIST_REQUIRED');
    expect((await approveAt(lawyer, rid, 2, { checklist: allPass() })).status).toBe(200);
    expect((await approveAt(mgr, rid, 3)).status).toBe(200);
    c = await get(c.id);
    expect(c.currentVersion).toBe(2);
    expect(c.totalCents).toBe(13_200_00);
    expect(c.content.lines[0]!.priceCents).toBe(55_00);
    expect(c.changes[0]).toMatchObject({ status: 'approved', resultVersion: 2 });
    expect(c.revisions.filter((r) => r.versionNo !== null).map((r) => r.versionNo)).toEqual([2, 1]);
    expect(c.revisions.find((r) => r.versionNo === 1)!.lines[0]!.priceCents).toBe(50_00);
  });

  it('采购单按合同核对：超价、超量标出来；选合同只列同一供应商、生效中的', async () => {
    const options = await api(ctx.app, buyer, 'GET', `/api/erp/contracts/options?supplierId=${supplierId}`);
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(options.body.map((o: { id: number }) => o.id)).toContain(c.id);
    const check = await api(ctx.app, buyer, 'POST', '/api/erp/contracts/check', {
      contractId: c.id,
      lines: [{ lineNo: 1, materialId: mat.id, purchaseUnit: mat.purchaseUnit, purchaseQtyMilli: 120_000, priceCents: 60_00 }],
    });
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body).toMatchObject({ exceeded: true, lines: [{ contractPriceCents: 55_00, priceOverCents: 5_00, remainingMilli: 100_000, overQtyMilli: 20_000 }] });
    const ok = await api(ctx.app, buyer, 'POST', '/api/erp/contracts/check', {
      contractId: c.id,
      lines: [{ lineNo: 1, materialId: mat.id, purchaseUnit: mat.purchaseUnit, purchaseQtyMilli: 10_000, priceCents: 55_00 }],
    });
    expect(ok.body.exceeded).toBe(false);
  });

  it('采购单挂合同：超价时提交要写原因，审批中心看得到；合同不是这家供应商的、不在生效中的挂不上', async () => {
    const line = { materialId: mat.id, purchaseQtyMilli: 10_000, priceCents: 60_00 };
    const draft = await api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, action: 'save', contractId: c.id, lines: [line] });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const po = draft.body.po;
    expect(po.contract).toMatchObject({ id: c.id, contractNo: c.contractNo });
    expect(po.contractCheck).toMatchObject({ exceeded: true, lines: [{ priceOverCents: 5_00, overQtyMilli: 0 }] });
    // 超价没写原因：提交拒绝
    const noReason = await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${po.id}/submit`, {});
    expect(noReason.body.error.code).toBe('CONTRACT_DEVIATION_REASON_REQUIRED');
    // 写了原因再提交
    const withReason = await api(ctx.app, buyer, 'PUT', `/api/purchase-orders/${po.id}`, {
      supplierId,
      orderDate: today,
      action: 'submit',
      contractNote: '急用，按现价补一批',
      lines: [{ ...line, id: po.lines[0].id }],
    });
    expect(withReason.status, JSON.stringify(withReason.body)).toBe(200);
    expect(withReason.body).toMatchObject({ status: 'submitted', contractNote: '急用，按现价补一批', contract: { id: c.id } });
    const detail = await api(ctx.app, mgr, 'GET', `/api/approvals/${withReason.body.approval.requestId}`);
    expect(detail.body.doc.facts).toEqual(expect.arrayContaining([expect.objectContaining({ label: '超出原因', value: '急用，按现价补一批' })]));
    // 已提交的采购单的数量算进合同的已下单：剩余量变少
    const after = await api(ctx.app, buyer, 'POST', '/api/erp/contracts/check', {
      contractId: c.id,
      lines: [{ lineNo: 1, materialId: mat.id, purchaseUnit: mat.purchaseUnit, purchaseQtyMilli: 95_000, priceCents: 55_00 }],
    });
    expect(after.body.lines[0]).toMatchObject({ remainingMilli: 90_000, overQtyMilli: 5_000 });
    // 别的供应商的合同挂不上
    const others = (await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; active: boolean }[];
    const other = others.find((x) => x.active && x.id !== supplierId)!;
    const mismatch = await api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId: other.id, orderDate: today, action: 'save', contractId: c.id, lines: [line] });
    expect(mismatch.body.error.code).toBe('CONTRACT_MISMATCH');
  });

  it('到期前 60 天提醒；续签的新合同签署以后不再提醒；终止要写原因', async () => {
    // 一份 30 天后到期的服务合同（只写相对方名称）
    let s = await create({ category: 'service', supplierId: null, counterparty: '保洁外包公司', content: content({ title: '保洁服务', endDate: shiftDate(today, 30), lines: [] }) });
    s = (await op(s.id, 'submit', { version: s.version })).body;
    expect((await approveAt(payer, s.approval!.requestId, 1)).status).toBe(200);
    expect((await approveAt(lawyer, s.approval!.requestId, 2, { checklist: allPass() })).status).toBe(200);
    expect((await approveAt(mgr, s.approval!.requestId, 3)).status).toBe(200);
    s = await get(s.id);
    s = (await op(s.id, 'sign', { version: s.version, signedOn: today, ourSignatory: '林岚', theirSignatory: '张总' })).body;
    const due = await api(ctx.app, buyer, 'GET', '/api/erp/contracts/expiring');
    expect(due.body.find((d: { id: number }) => d.id === s.id)).toMatchObject({ daysLeft: 30, renewal: null });
    // 续签的新合同起草中：还在提醒，标「续签中」
    const renewal = await create({ category: 'service', supplierId: null, counterparty: '保洁外包公司', renewalOf: s.id, content: content({ title: '保洁服务（续签）', lines: [] }) });
    const due2 = await api(ctx.app, buyer, 'GET', '/api/erp/contracts/expiring');
    expect(due2.body.find((d: { id: number }) => d.id === s.id).renewal).toMatchObject({ id: renewal.id, status: 'draft' });
    // 终止要写原因
    expect((await op(s.id, 'terminate', { version: s.version, closedOn: today, reason: '' })).status).toBe(400);
    const t = await op(s.id, 'terminate', { version: s.version, closedOn: today, reason: '服务不满意，提前解约' });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect((await api(ctx.app, buyer, 'GET', '/api/erp/contracts/expiring')).body.find((d: { id: number }) => d.id === s.id)).toBeUndefined();
  });

  it('审批规则：合同的审批链要有且只有一级「法务」，别的单据不能用「法务」', async () => {
    const noLegal = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: randomUUID(), docType: 'contract', steps: [{ group: 'manager' }] });
    expect(noLegal.body.error.code).toBe('RULE_LEGAL_REQUIRED');
    const misuse = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: randomUUID(), docType: 'purchase_order', steps: [{ group: 'legal' }] });
    expect(misuse.body.error.code).toBe('RULE_LEGAL_NOT_ALLOWED');
    const ok = await api(ctx.app, boss, 'POST', '/api/approvals/rules', { clientKey: randomUUID(), docType: 'contract', minCents: 50_000_00, steps: [{ group: 'legal' }, { group: 'owner' }], note: '大额合同' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('权限：部门账号看不到合同，法务能看；自检一致', async () => {
    expect((await api(ctx.app, dept, 'GET', '/api/erp/contracts')).status).toBe(403);
    expect((await api(ctx.app, dept, 'GET', `/api/erp/contracts/${c.id}`)).status).toBe(403);
    expect((await api(ctx.app, lawyer, 'GET', '/api/erp/contracts')).status).toBe(200);
    // 法务不能起草（维护合同是店主、店总，采购、法务；这里法务能起草）
    expect((await api(ctx.app, payer, 'POST', '/api/erp/contracts', { clientKey: randomUUID(), category: 'other', counterparty: 'X', content: content({ lines: [] }) })).status).toBe(403);
    expect(await contractChecks(ctx.sql)).toEqual([expect.objectContaining({ ok: true })]);
    expect(await approvalChecks(ctx.sql)).toMatchObject({ ok: true });
  });

  it('归档后终止：扫描件照样只能追加、不能删（Codex 自动审查 9d5272b）', async () => {
    c = await get(c.id);
    expect(c.status).toBe('archived');
    const fileIds = c.files.map((f) => f.id);
    expect(fileIds.length).toBeGreaterThan(0);
    const t = await op(c.id, 'terminate', { version: c.version, closedOn: today, reason: '供应商停产，提前终止' });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    c = t.body;
    expect(c).toMatchObject({ status: 'terminated', archiveNo: expect.stringMatching(/^GD/) });
    const removed = await api(ctx.app, buyer, 'POST', `/api/erp/contracts/files/${fileIds[0]}/remove`, {});
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('INVALID_STATE');
    expect((await get(c.id)).files.map((f) => f.id)).toEqual(fileIds);
    // 追加照样可以
    const more = await api(ctx.app, buyer, 'POST', `/api/erp/contracts/${c.id}/files`, { mime: 'image/png', data: PNG2.toString('base64') });
    expect(more.status, JSON.stringify(more.body)).toBe(201);
    expect(more.body.files).toHaveLength(fileIds.length + 1);
    expect(await contractChecks(ctx.sql)).toEqual([expect.objectContaining({ ok: true })]);
  });
});
