// 8.0.17 采购流程图（docs/FLOW_V8017.md）：
//   · 推算函数（不碰数据库）：流程 A / B 怎么分、每个环节在各种单据状态下是什么、超期与卡住、几张单合在一起、看的人不能看金额时；
//   · 接口：一条与列表、谁看得到（部门同事只看自己看得到的需求单、不带金额）、与单据一步一步对得上。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPurchaseFlow, dayDiff, flowYuan, type FlowFacts, type FlowPoFact, type FlowRequestFact, type FlowSourcingFact, type PurchaseFlow } from '../src/shared/purchase-flow';
import { DEFAULT_PAYMENT_RULES, nextPayDay, payDaysLabel } from '../src/shared/payments';
import { DEFAULT_PURCHASE_RULES } from '../src/shared/purchasing';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

// ───────────────────────── 推算函数 ─────────────────────────

const NOW = '2026-11-13T04:00:00.000Z';
const TODAY = '2026-11-13';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
// 没有固定付款日（另有一条专门测付款日）
const RULES = { quoteThresholdCents: 100_000, minQuotes: 2, arrivalOverdueDays: 7, stallDays: 2, payDays: [] as number[] };

const req = (over: Partial<FlowRequestFact> = {}): FlowRequestFact => ({
  id: 1,
  docNo: 'XQ-0001',
  status: 'approved',
  departmentName: '浴区',
  requesterName: '林岚',
  submittedAt: hoursAgo(30),
  reviewedAt: hoursAgo(29),
  reviewedByName: '采购主管',
  reason: null,
  lockedToday: false,
  deptConfirm: { state: 'none', headName: null, confirmedByName: null, confirmedAt: null },
  lineCount: 1,
  summary: '沐浴露补充装',
  unorderedLines: 0,
  estimateCents: 80_000,
  pricedLines: 1,
  ...over,
});
const po = (over: Partial<FlowPoFact> = {}): FlowPoFact => ({
  id: 10,
  docNo: 'CG-0010',
  status: 'approved',
  supplierName: '清野饮品',
  summary: '沐浴露补充装',
  lineCount: 2,
  receivedLines: 0,
  totalCents: 80_000,
  orderDate: '2026-11-06',
  expectedDate: null,
  createdAt: hoursAgo(28),
  createdByName: '周一',
  submittedAt: hoursAgo(28),
  approvedAt: hoursAgo(27),
  approvedByName: '周一',
  returnedReason: null,
  closeReason: null,
  approval: null,
  receiving: 'none',
  receivedCents: 0,
  paidCents: 0,
  unpaidCents: 0,
  receipts: [],
  settlement: 'credit',
  unclaimedLines: 2,
  claimsPending: 0,
  ...over,
});
const src = (over: Partial<FlowSourcingFact> = {}): FlowSourcingFact => ({
  id: 5,
  docNo: 'XJ-0005',
  status: 'open',
  title: '苹果 Mac Mini',
  createdAt: hoursAgo(50),
  createdByName: '周一',
  activeQuotes: 1,
  lastQuoteAt: hoursAgo(40),
  lowestLandedCents: 899_900,
  singleSource: false,
  awardedAt: null,
  awardedByName: null,
  awardedSupplierName: null,
  ...over,
});
const facts = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  anchor: { kind: 'request', id: 1, docNo: 'XQ-0001' },
  requests: [req()],
  sourcing: null,
  pos: [],
  rules: RULES,
  now: NOW,
  today: TODAY,
  purchasing: true,
  ...over,
});
const keys = (f: PurchaseFlow) => f.nodes.map((n) => n.key);
const states = (f: PurchaseFlow) => f.nodes.map((n) => n.state[0]).join('');
const node = (f: PurchaseFlow, key: string) => f.nodes.find((n) => n.key === key)!;

describe('采购流程图 · 推算函数', () => {
  it('小工具：门槛写成 ¥1,000（有零头才带小数）；日期差', () => {
    expect(flowYuan(100_000)).toBe('¥1,000');
    expect(flowYuan(500_000)).toBe('¥5,000');
    expect(flowYuan(100_050)).toBe('¥1,000.50');
    expect(dayDiff('2026-11-13', '2026-11-06')).toBe(7);
    expect(dayDiff('2026-03-01', '2026-02-27')).toBe(2);
  });

  it('流程 A（店主图上的例子）：合计小于门槛免比价；提需求、审核、下单都做完，停在到货验收；过了「下单后几天」标超期', () => {
    const f = buildPurchaseFlow(facts({ pos: [po()] }));
    expect(f.variant).toBe('A');
    expect(f.variantText).toBe('< ¥1,000 · 免比价');
    // 不用人审的采购单：没有「采购单审批」这一环
    expect(keys(f)).toEqual(['request', 'review', 'order', 'receive', 'stockin', 'pay']);
    expect(states(f)).toBe('dddcpp');
    expect(node(f, 'request')).toMatchObject({ glyph: '部', role: '浴区 · 林岚', text: '已提交', link: { kind: 'request', id: 1 } });
    expect(node(f, 'review')).toMatchObject({ text: '已通过', role: '采购主管' });
    expect(node(f, 'order')).toMatchObject({ title: '采购下单', role: '采购 → 清野饮品', text: 'CG-0010 已下单', link: { kind: 'po', id: 10 } });
    // 11/6 下单，没填预计到货日：按 7 天算到 11/13，今天还不算超期
    expect(node(f, 'receive')).toMatchObject({ text: '供应商送货中', alert: null, waited: '7 天' });
    expect(f).toMatchObject({ stage: 'receive', alert: false, end: null, amountCents: 80_000, amountEstimated: false, title: '沐浴露补充装' });
    // 预计 11/11 到：超期 2 天，红条写等了多久与超期几天（到货不按「环节等了几天」标红）
    // 等了几天从下单日算（不看确认得早晚）
    const late = buildPurchaseFlow(facts({ pos: [po({ expectedDate: '2026-11-11', approvedAt: hoursAgo(1) })] }));
    expect(node(late, 'receive').alert).toBe('已等待 7 天 · 超期 2 天');
    expect(late.alert).toBe(true);
    const due = buildPurchaseFlow(facts({ pos: [po({ orderDate: '2026-11-04' })] }));
    expect(node(due, 'receive').alert).toContain('超期 2 天');
  });

  it('流程 B（图上的例子）：发起了询价的走 B；报价不够家数停在询价，等了超过天数写还缺几家；后面的环节都灰着', () => {
    const f = buildPurchaseFlow(facts({ anchor: { kind: 'sourcing', id: 5, docNo: 'XJ-0005' }, requests: [req({ departmentName: 'IT', estimateCents: 899_900 })], sourcing: src() }));
    expect(f.variant).toBe('B');
    expect(f.variantText).toBe('≥ ¥1,000 · 必须 ≥ 2 家比价 + 审批');
    expect(keys(f)).toEqual(['request', 'review', 'sourcing', 'award', 'approval', 'order', 'receive', 'stockin', 'pay']);
    expect(states(f)).toBe('ddcpppppp');
    expect(node(f, 'sourcing')).toMatchObject({ text: '已收 1 / 2 家报价', role: '采购 · 需 ≥ 2 家', alert: '已等待 2 天 · 缺 1 家报价', link: { kind: 'sourcing', id: 5 } });
    expect(node(f, 'award').text).toBe('待报价齐');
    expect(node(f, 'order').title).toBe('下单中标方');
    expect(f).toMatchObject({ stage: 'sourcing', alert: true, amountCents: 899_900, amountEstimated: true });
    // 才等了 3 小时：不标红，写等了多久
    const fresh = buildPurchaseFlow(facts({ requests: [], sourcing: src({ createdAt: hoursAgo(3) }) }));
    expect(node(fresh, 'sourcing')).toMatchObject({ alert: null, waited: '3 小时' });
    expect(keys(fresh)[0]).toBe('sourcing');
  });

  it('流程 B 往后走：报价齐了待定标 → 已定标待转采购单 → 草稿 → 待审批（第几级、等谁，审批中心标了超时）→ 退回 → 已确认', () => {
    const base = { anchor: { kind: 'sourcing' as const, id: 5, docNo: 'XJ-0005' }, requests: [] };
    const full = buildPurchaseFlow(facts({ ...base, sourcing: src({ activeQuotes: 2, lastQuoteAt: hoursAgo(5) }) }));
    expect(states(full)).toBe('dcppppp');
    expect(node(full, 'award')).toMatchObject({ text: '报价已齐，待定标', waited: '5 小时' });
    const awarded = src({ status: 'awarded', activeQuotes: 2, awardedAt: hoursAgo(4), awardedByName: '店主', awardedSupplierName: '苹果授权店' });
    const noPo = buildPurchaseFlow(facts({ ...base, sourcing: awarded }));
    expect(states(noPo)).toBe('ddcpppp');
    expect(node(noPo, 'award')).toMatchObject({ text: '中标：苹果授权店', role: '店主' });
    expect(node(noPo, 'approval')).toMatchObject({ text: '已定标，待转采购单并提交', link: { kind: 'sourcing' } });
    const draft = buildPurchaseFlow(facts({ ...base, sourcing: awarded, pos: [po({ status: 'draft', totalCents: 899_900, approvedAt: null, submittedAt: null })] }));
    expect(node(draft, 'approval')).toMatchObject({ state: 'current', text: '采购单草稿，待提交', role: '采购 · 周一' });
    expect(node(draft, 'order')).toMatchObject({ state: 'pending', text: '待审批后' });
    const pending = po({ status: 'submitted', totalCents: 899_900, approvedAt: null, approval: { requestId: 77, status: 'pending', currentLevel: 2, levels: 2, currentLabel: '店主', levelStartedAt: hoursAgo(26), overdue: true } });
    const inApproval = buildPurchaseFlow(facts({ ...base, sourcing: awarded, pos: [pending] }));
    expect(node(inApproval, 'approval')).toMatchObject({ text: '第 2 / 2 级 · 审批中', role: '店主', alert: '已等待 26 小时 · 审批超时', link: { kind: 'approval', id: 77 } });
    expect(inApproval.stage).toBe('approval');
    const returned = buildPurchaseFlow(facts({ ...base, sourcing: awarded, pos: [po({ status: 'returned', approvedAt: null, returnedReason: '价格再谈' })] }));
    expect(node(returned, 'approval')).toMatchObject({ state: 'current', alert: '已退回修改：价格再谈', text: '等采购修改后再提交' });
    const ok = buildPurchaseFlow(facts({ ...base, sourcing: awarded, pos: [po({ totalCents: 899_900, approvedByName: '店主' })] }));
    expect(states(ok)).toBe('ddddcpp');
    expect(node(ok, 'approval')).toMatchObject({ text: '已确认', role: '店主' });
    expect(node(ok, 'order')).toMatchObject({ title: '下单中标方', text: 'CG-0010 已下单' });
  });

  it('只有需求单时：待审核、截单后提交、退回（带原因）、不采购与撤回（流程结束，后面的都灰着）、通过后待转采购单', () => {
    const waiting = buildPurchaseFlow(facts({ requests: [req({ status: 'submitted', reviewedAt: null, reviewedByName: null, submittedAt: hoursAgo(2), unorderedLines: 1 })] }));
    expect(states(waiting)).toBe('dcpppp');
    expect(node(waiting, 'review')).toMatchObject({ text: '待审核', waited: '2 小时', alert: null });
    expect(node(waiting, 'order').text).toBe('待审核通过后');
    const stalled = buildPurchaseFlow(facts({ requests: [req({ status: 'submitted', reviewedAt: null, submittedAt: hoursAgo(72), unorderedLines: 1 })] }));
    expect(node(stalled, 'review').alert).toBe('已等待 3 天');
    // 「环节等了几天标红」设成 0：不标
    expect(node(buildPurchaseFlow(facts({ rules: { ...RULES, stallDays: 0 }, requests: [req({ status: 'submitted', reviewedAt: null, submittedAt: hoursAgo(72) })] })), 'review').alert).toBeNull();
    const locked = buildPurchaseFlow(facts({ requests: [req({ status: 'submitted', reviewedAt: null, lockedToday: true })] }));
    expect(node(locked, 'review').text).toBe('截单后提交，明天起可审核');
    const back = buildPurchaseFlow(facts({ requests: [req({ status: 'returned', reason: '请补规格' })] }));
    expect(node(back, 'review')).toMatchObject({ state: 'current', alert: '已退回：请补规格', role: '浴区 · 林岚' });
    const no = buildPurchaseFlow(facts({ requests: [req({ status: 'rejected', reason: '库里还有' })] }));
    expect(no).toMatchObject({ end: 'rejected', stage: null, alert: false });
    expect(node(no, 'review').alert).toBe('不采购：库里还有');
    expect(no.nodes.slice(2).every((n) => n.state === 'pending' && n.text === '—')).toBe(true);
    expect(buildPurchaseFlow(facts({ requests: [req({ status: 'cancelled' })] })).end).toBe('cancelled');
    const approved = buildPurchaseFlow(facts({ requests: [req({ unorderedLines: 1 })] }));
    expect(states(approved)).toBe('ddcppp');
    expect(node(approved, 'order')).toMatchObject({ text: '已通过，待转采购单', waited: '29 小时', link: { kind: 'request', id: 1 } });
  });

  it('部门主管确认（LC1）：要确认的多一环「部门确认」——等主管时球在主管那里、需求审核灰着；确认后轮到采购；主管退回标红；不用确认的没有这一环', () => {
    const pending = { state: 'pending' as const, headName: '王主管', confirmedByName: null, confirmedAt: null };
    const confirmed = { state: 'confirmed' as const, headName: '王主管', confirmedByName: '王主管', confirmedAt: hoursAgo(5) };
    const atHead = buildPurchaseFlow(facts({ requests: [req({ status: 'submitted', reviewedAt: null, reviewedByName: null, submittedAt: hoursAgo(6), unorderedLines: 1, deptConfirm: pending })] }));
    expect(keys(atHead)).toEqual(['request', 'confirm', 'review', 'order', 'receive', 'stockin', 'pay']);
    expect(states(atHead)).toBe('dcppppp');
    expect(node(atHead, 'confirm')).toMatchObject({ glyph: '确', title: '部门确认', role: '部门主管 · 王主管', text: '待主管确认', waited: '6 小时', alert: null });
    expect(node(atHead, 'review')).toMatchObject({ state: 'pending', text: '待主管确认后' });
    expect(atHead.stage).toBe('confirm');
    // 等了超过天数：标红
    expect(node(buildPurchaseFlow(facts({ requests: [req({ status: 'submitted', reviewedAt: null, submittedAt: hoursAgo(60), deptConfirm: pending })] })), 'confirm').alert).toBe('已等待 2 天');
    // 主管确认了：轮到采购审核
    const atBuyer = buildPurchaseFlow(facts({ requests: [req({ status: 'submitted', reviewedAt: null, reviewedByName: null, submittedAt: hoursAgo(6), unorderedLines: 1, deptConfirm: confirmed })] }));
    expect(states(atBuyer)).toBe('ddcpppp');
    expect(node(atBuyer, 'confirm')).toMatchObject({ state: 'done', text: '已确认', role: '王主管' });
    expect(node(atBuyer, 'review')).toMatchObject({ state: 'current', text: '待审核' });
    // 主管退回：红条在「部门确认」上
    const back = buildPurchaseFlow(facts({ requests: [req({ status: 'returned', reviewedAt: null, reason: '主管退回：数量太多', deptConfirm: pending })] }));
    expect(node(back, 'confirm')).toMatchObject({ state: 'current', alert: '已退回：主管退回：数量太多' });
    expect(node(back, 'review').state).toBe('pending');
    // 采购退回的（主管已经确认过）：红条在「需求审核」上
    const buyerBack = buildPurchaseFlow(facts({ requests: [req({ status: 'returned', reason: '请补规格', deptConfirm: confirmed })] }));
    expect(node(buyerBack, 'confirm').state).toBe('done');
    expect(node(buyerBack, 'review')).toMatchObject({ state: 'current', alert: '已退回：请补规格' });
    // 等主管确认时被定为不采购：流程结束
    const rejected = buildPurchaseFlow(facts({ requests: [req({ status: 'rejected', reason: '库里还有', deptConfirm: pending })] }));
    expect(rejected.end).toBe('rejected');
    expect(node(rejected, 'confirm')).toMatchObject({ state: 'pending', text: '没有确认' });
    // 走完的：部门确认是做完的一环
    const done = buildPurchaseFlow(facts({ requests: [req({ deptConfirm: confirmed })], pos: [po()] }));
    expect(keys(done)).toEqual(['request', 'confirm', 'review', 'order', 'receive', 'stockin', 'pay']);
    expect(states(done)).toBe('ddddcpp');
    // 不用确认的没有这一环
    expect(keys(buildPurchaseFlow(facts({ pos: [po()] })))).not.toContain('confirm');
  });

  it('分流：按参考价估；没填参考价的先按 A 画并注明；达到门槛、还没询价的走 B「待发起询价」；门槛 0 都走 A；采购单提交过了就不再改判', () => {
    const est = buildPurchaseFlow(facts({ requests: [req({ unorderedLines: 1 })] }));
    expect(est).toMatchObject({ variant: 'A', amountCents: 80_000, amountEstimated: true });
    const unknown = buildPurchaseFlow(facts({ requests: [req({ pricedLines: 0, estimateCents: 0, unorderedLines: 1 })] }));
    expect(unknown).toMatchObject({ variant: 'A', amountCents: null, variantText: '金额未定 · 下单时合计 ≥ ¥1,000 要先询价' });
    const big = buildPurchaseFlow(facts({ requests: [req({ estimateCents: 250_000, unorderedLines: 1 })] }));
    expect(big.variant).toBe('B');
    expect(node(big, 'sourcing')).toMatchObject({ state: 'current', text: '待发起询价' });
    expect(node(buildPurchaseFlow(facts({ requests: [req({ status: 'submitted', reviewedAt: null, estimateCents: 250_000 })] })), 'sourcing')).toMatchObject({ state: 'pending', text: '待审核通过后' });
    expect(buildPurchaseFlow(facts({ rules: { ...RULES, quoteThresholdCents: 0 }, requests: [req({ estimateCents: 9_999_900, unorderedLines: 1 })] }))).toMatchObject({ variant: 'A', variantText: '免比价（采购规则没设询价门槛）' });
    // 达到门槛的草稿采购单、还没询价：提交时会被拦下，图上先去询价
    const draft = buildPurchaseFlow(facts({ anchor: { kind: 'po', id: 10, docNo: 'CG-0010' }, requests: [], pos: [po({ status: 'draft', totalCents: 250_000, approvedAt: null, submittedAt: null })] }));
    expect(draft.variant).toBe('B');
    expect(node(draft, 'sourcing')).toMatchObject({ state: 'current', text: '待发起询价', link: { kind: 'po', id: 10 } });
    expect(node(draft, 'approval')).toMatchObject({ state: 'pending', text: '待定标后' });
    // 已经确认的（补单、门槛后来才改小）：照实画 A
    expect(buildPurchaseFlow(facts({ anchor: { kind: 'po', id: 10, docNo: 'CG-0010' }, requests: [], pos: [po({ totalCents: 250_000 })] })).variant).toBe('A');
    // 询价单撤销了：不算
    expect(buildPurchaseFlow(facts({ requests: [req({ unorderedLines: 1 })], sourcing: src({ status: 'cancelled' }) })).variant).toBe('A');
  });

  it('流程 A 里的采购单审批：要人审的才有这一环（待负责人确认、退回）；草稿不用人审的停在「采购下单」', () => {
    const base = { anchor: { kind: 'po' as const, id: 10, docNo: 'CG-0010' }, requests: [] };
    const submitted = buildPurchaseFlow(facts({ ...base, pos: [po({ status: 'submitted', approvedAt: null })] }));
    expect(keys(submitted)).toEqual(['approval', 'order', 'receive', 'stockin', 'pay']);
    expect(node(submitted, 'approval')).toMatchObject({ state: 'current', text: '待负责人确认', role: '负责人' });
    const draft = buildPurchaseFlow(facts({ ...base, pos: [po({ status: 'draft', approvedAt: null, submittedAt: null })] }));
    expect(keys(draft)).toEqual(['order', 'receive', 'stockin', 'pay']);
    expect(node(draft, 'order')).toMatchObject({ state: 'current', text: '采购单草稿，待提交' });
    // 走过审批中心的，确认以后这一环留着（写谁确认的）
    const done = buildPurchaseFlow(facts({ ...base, pos: [po({ approvedByName: '负责人', approval: { requestId: 3, status: 'approved', currentLevel: 1, levels: 1, currentLabel: '负责人', levelStartedAt: hoursAgo(30), overdue: false } })] }));
    expect(keys(done)[0]).toBe('approval');
    expect(node(done, 'approval')).toMatchObject({ state: 'done', role: '负责人' });
  });

  it('到货、入库、付款：收货单登记了没确认 → 球在入库；部分到货；到齐后挂账的看已付未付、现付的看报销；全部做完流程结束', () => {
    const base = { anchor: { kind: 'po' as const, id: 10, docNo: 'CG-0010' }, requests: [] };
    const registered = buildPurchaseFlow(facts({ ...base, pos: [po({ receipts: [{ id: 31, docNo: 'SH-0031', status: 'submitted', docDate: '2026-11-10' }] })] }));
    expect(states(registered)).toBe('ddcp');
    expect(node(registered, 'receive')).toMatchObject({ text: '已登记收货 SH-0031', link: { kind: 'receipt', id: 31 } });
    expect(node(registered, 'stockin')).toMatchObject({ text: '收货单 SH-0031 待确认', role: '仓库 / 负责人', waited: '3 天', alert: '已等待 3 天' });
    const partial = buildPurchaseFlow(facts({ ...base, pos: [po({ receiving: 'partial', receivedLines: 1, receivedCents: 40_000, unpaidCents: 40_000, receipts: [{ id: 31, docNo: 'SH-0031', status: 'confirmed', docDate: '2026-11-10' }] })] }));
    expect(states(partial)).toBe('dcpp');
    expect(node(partial, 'receive').text).toBe('部分到货（1 / 2 行到齐）');
    expect(node(partial, 'stockin').text).toBe('已入库 1 / 2 行');
    expect(node(partial, 'pay')).toMatchObject({ state: 'pending', text: '已付 ¥0.00 · 未付 ¥400.00' });
    const full = { receiving: 'full' as const, receivedLines: 2, receivedCents: 80_000, receipts: [{ id: 31, docNo: 'SH-0031', status: 'confirmed' as const, docDate: '2026-11-10' }] };
    const unpaid = buildPurchaseFlow(facts({ ...base, pos: [po({ ...full, paidCents: 30_000, unpaidCents: 50_000 })] }));
    expect(states(unpaid)).toBe('dddc');
    expect(node(unpaid, 'receive')).toMatchObject({ text: '已到齐', at: '2026-11-10' });
    // 付款不按天数标红（期限在「本周应付」里看）
    expect(node(unpaid, 'pay')).toMatchObject({ text: '已付 ¥300.00 · 未付 ¥500.00', alert: null, waited: '3 天' });
    expect(unpaid).toMatchObject({ stage: 'pay', alert: false });
    const paid = buildPurchaseFlow(facts({ ...base, pos: [po({ ...full, paidCents: 80_000, unpaidCents: 0 })] }));
    expect(states(paid)).toBe('dddd');
    expect(paid).toMatchObject({ end: 'done', endText: '全部完成', stage: null });
    // 现付：没报销完的写还有几行
    const cash = buildPurchaseFlow(facts({ ...base, pos: [po({ ...full, settlement: 'cash', unclaimedLines: 1 })] }));
    expect(node(cash, 'pay')).toMatchObject({ state: 'current', text: '现付 · 还有 1 行没报销' });
    expect(node(buildPurchaseFlow(facts({ ...base, pos: [po({ ...full, settlement: 'cash', unclaimedLines: 0, claimsPending: 1 })] })), 'pay').text).toBe('报销单待确认');
    expect(buildPurchaseFlow(facts({ ...base, pos: [po({ ...full, settlement: 'cash', unclaimedLines: 0 })] })).end).toBe('done');
    // 关闭的采购单：没到的不再到，付清以后算「采购单关闭」
    const closed = buildPurchaseFlow(facts({ ...base, pos: [po({ status: 'closed', closeReason: '供应商断货', receiving: 'partial', receivedLines: 1, receivedCents: 40_000, paidCents: 40_000, unpaidCents: 0, receipts: full.receipts })] }));
    expect(node(closed, 'receive').text).toBe('采购单已关闭，没到的不再到');
    expect(closed).toMatchObject({ end: 'closed', endText: '采购单已关闭：供应商断货' });
  });

  it('固定付款日（LC7）：没到货的写每月几号付款；到齐没付清的写下个付款日；过了入库以后的第一个付款日还没付清标红；月底的日子按月底算', () => {
    expect(nextPayDay('2026-11-13', [15, 30])).toBe('2026-11-15');
    expect(nextPayDay('2026-11-15', [15, 30])).toBe('2026-11-15');
    expect(nextPayDay('2026-11-15', [15, 30], true)).toBe('2026-11-30');
    expect(nextPayDay('2026-11-30', [30, 15], true)).toBe('2026-12-15');
    // 二月没有 30 号：按月底；跨年
    expect(nextPayDay('2027-02-16', [15, 30])).toBe('2027-02-28');
    expect(nextPayDay('2026-12-31', [15, 30], true)).toBe('2027-01-15');
    expect(nextPayDay('2026-11-13', [])).toBeNull();
    expect(payDaysLabel([15, 30])).toBe('每月 15 / 30 号');
    const rules = { ...RULES, payDays: [15, 30] };
    const base = { anchor: { kind: 'po' as const, id: 10, docNo: 'CG-0010' }, requests: [], rules };
    const waiting = buildPurchaseFlow(facts({ ...base, pos: [po()] }));
    expect(node(waiting, 'pay')).toMatchObject({ state: 'pending', role: '财务 · 每月 15 / 30 号', text: '到货后付款' });
    // 11/10 入库、今天 11/13：下个付款日 11/15，还没过
    const full = { receiving: 'full' as const, receivedLines: 2, receivedCents: 80_000, paidCents: 0, unpaidCents: 80_000, receipts: [{ id: 31, docNo: 'SH-0031', status: 'confirmed' as const, docDate: '2026-11-10' }] };
    const due = buildPurchaseFlow(facts({ ...base, pos: [po(full)] }));
    expect(node(due, 'pay')).toMatchObject({ state: 'current', text: '已付 ¥0.00 · 未付 ¥800.00 · 下个付款日 11/15', alert: null });
    expect(due.alert).toBe(false);
    // 10/20 入库：第一个付款日是 10/30，今天 11/13 已经过了 14 天
    const late = buildPurchaseFlow(facts({ ...base, pos: [po({ ...full, receipts: [{ id: 31, docNo: 'SH-0031', status: 'confirmed', docDate: '2026-10-20' }] })] }));
    expect(node(late, 'pay')).toMatchObject({ state: 'current', text: '已付 ¥0.00 · 未付 ¥800.00', alert: '已过付款日 10/30 · 超 14 天' });
    expect(late).toMatchObject({ stage: 'pay', alert: true });
    // 入库当天就是付款日：算下一个（当天来不及对账）
    const sameDay = buildPurchaseFlow(facts({ ...base, today: '2026-11-16', pos: [po({ ...full, receipts: [{ id: 31, docNo: 'SH-0031', status: 'confirmed', docDate: '2026-11-15' }] })] }));
    expect(node(sameDay, 'pay')).toMatchObject({ alert: null, text: '已付 ¥0.00 · 未付 ¥800.00 · 下个付款日 11/30' });
    // 现付的看报销，不按付款日
    expect(node(buildPurchaseFlow(facts({ ...base, pos: [po({ ...full, settlement: 'cash', unclaimedLines: 1, receipts: [{ id: 31, docNo: 'SH-0031', status: 'confirmed', docDate: '2026-10-20' }] })] })), 'pay').alert).toBeNull();
    // 看的人不能看金额：只写还没付清与付款日
    expect(node(buildPurchaseFlow(facts({ ...base, purchasing: false, pos: [po(full)] })), 'pay').text).toBe('还没付清 · 下个付款日 11/15');
  });

  it('几张单合在一起：一张需求拆成两张采购单（一张到齐、一张没到）；还有行没下单；几张需求并成一张采购单', () => {
    const a = po({ id: 10, docNo: 'CG-0010', receiving: 'full', receivedLines: 2, receivedCents: 80_000, paidCents: 80_000, unpaidCents: 0, receipts: [{ id: 31, docNo: 'SH-0031', status: 'confirmed', docDate: '2026-11-10' }] });
    const b = po({ id: 11, docNo: 'CG-0011', supplierName: '山田洗护', totalCents: 10_000 });
    const split = buildPurchaseFlow(facts({ pos: [a, b] }));
    // 只有「到货验收」在等（没到的那张）；入库、付款有一张做完了，先灰着、字里写 1 / 2
    expect(states(split)).toBe('dddcpp');
    expect(node(split, 'order')).toMatchObject({ text: '2 张采购单 已下单', role: '采购 → 清野饮品、山田洗护' });
    expect(node(split, 'receive')).toMatchObject({ text: '1 / 2 张采购单已到齐', link: { kind: 'po', id: 11 } });
    expect(node(split, 'stockin').text).toBe('1 / 2 张采购单已入库');
    expect(node(split, 'pay')).toMatchObject({ state: 'pending', text: '1 / 2 张采购单已付清' });
    expect(split.amountCents).toBe(90_000);
    // 需求单还有一行没下单：下单这一环还在等
    const more = buildPurchaseFlow(facts({ requests: [req({ lineCount: 3, unorderedLines: 1 })], pos: [a] }));
    expect(node(more, 'order')).toMatchObject({ state: 'current', text: 'CG-0010 已下单 · 还有 1 行没下单' });
    expect(more.end).toBeNull();
    // 从采购单看：三张需求单并成一张
    const merged = buildPurchaseFlow(
      facts({ anchor: { kind: 'po', id: 10, docNo: 'CG-0010' }, requests: [req(), req({ id: 2, docNo: 'XQ-0002', departmentName: 'IT' }), req({ id: 3, docNo: 'XQ-0003', departmentName: '水吧', unorderedLines: 2 })], pos: [po()] }),
    );
    expect(node(merged, 'request')).toMatchObject({ text: '3 张需求单', role: '浴区、IT、水吧' });
    // 从采购单看不管别的需求行下没下单
    expect(node(merged, 'order')).toMatchObject({ state: 'done', text: 'CG-0010 已下单' });
  });

  it('看的人没有「查看库存」：不带金额、付款只写还没付清、采购单与询价单不给链接（需求单的留着）', () => {
    const full = { receiving: 'full' as const, receivedLines: 2, receivedCents: 80_000, paidCents: 0, unpaidCents: 80_000, receipts: [{ id: 31, docNo: 'SH-0031', status: 'confirmed' as const, docDate: '2026-11-10' }] };
    const f = buildPurchaseFlow(facts({ purchasing: false, pos: [po(full)] }));
    expect(f.amountCents).toBeNull();
    expect(node(f, 'pay').text).toBe('还没付清');
    expect(node(f, 'request').link).toMatchObject({ kind: 'request' });
    expect(f.nodes.filter((n) => n.key !== 'request' && n.key !== 'review').every((n) => n.link === null)).toBe(true);
    expect(JSON.stringify(f)).not.toContain('¥800');
  });
});

// ───────────────────────── 接口 ─────────────────────────

let ctx: TestContext;
let today: string;
let boss: string;
let keeper: string;
let buyer: string;
let buyerId: number;
let approver: string;
let reqA: string;
let reqB: string;
let supplierId: number;
let mat: { id: number; name: string };
const q = (n: number) => Math.round(n * 1000);
const one = (cookie: string, kind: string, id: number) => api(ctx.app, cookie, 'GET', `/api/purchase-flow/one?kind=${kind}&id=${id}`);
const list = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/purchase-flow/list')).body as { flows: PurchaseFlow[]; rules: Record<string, number>; truncated: boolean };
const find = (flows: PurchaseFlow[], kind: string, id: number) => flows.find((f) => f.anchor.kind === kind && f.anchor.id === id);

describe('采购流程图 · 接口', () => {
  beforeAll(async () => {
    ctx = await setup();
    today = todayIn(ctx.config.timezone);
    expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
    boss = await login(ctx.app, 'linlan', 'yuzu2026');
    keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
    buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
    buyerId = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id;
    await createStaff(ctx.sql, { username: 'appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
    approver = await login(ctx.app, 'appr');
    const mk = async (name: string) => {
      await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
      return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
    };
    const deptA = await mk('浴区');
    const deptB = await mk('水吧');
    await createStaff(ctx.sql, { username: 'req_a', displayName: '浴区申购', role: 'backoffice', duties: ['request'], departmentId: deptA, password: PASSWORD, mustChangePassword: false });
    await createStaff(ctx.sql, { username: 'req_b', displayName: '水吧申购', role: 'backoffice', duties: ['request'], departmentId: deptB, password: PASSWORD, mustChangePassword: false });
    reqA = await login(ctx.app, 'req_a');
    reqB = await login(ctx.app, 'req_b');
    supplierId = ((await api(ctx.app, boss, 'GET', '/api/inventory/suppliers?all=1')).body as { id: number; code: string }[]).find((s) => s.code === 'S004')!.id;
    mat = ((await api(ctx.app, boss, 'GET', '/api/inventory/materials?all=1')).body as { id: number; code: string; name: string }[]).find((m) => m.code === 'M016')!;
  }, 120_000);
  afterAll(async () => ctx.close());

  it('采购规则多一项「一个环节等了几天标红」：默认 2 天，0 到 30；流程进度页顶上的规则读的就是采购规则', async () => {
    expect(DEFAULT_PURCHASE_RULES.flowStallDays).toBe(2);
    expect((await api(ctx.app, boss, 'GET', '/api/inventory/purchase-rules')).body.flowStallDays).toBe(2);
    expect((await api(ctx.app, boss, 'PUT', '/api/inventory/purchase-rules', { flowStallDays: 31 })).status).toBe(400);
    expect((await api(ctx.app, boss, 'PUT', '/api/inventory/purchase-rules', { flowStallDays: 3 })).body.flowStallDays).toBe(3);
    expect((await list(buyer)).rules).toEqual({ quoteThresholdCents: DEFAULT_PURCHASE_RULES.quoteThresholdCents, minQuotes: DEFAULT_PURCHASE_RULES.minQuotes, arrivalOverdueDays: DEFAULT_PURCHASE_RULES.arrivalOverdueDays, stallDays: 3, payDays: [15, 30] });
    expect(DEFAULT_PAYMENT_RULES.payDays).toEqual([15, 30]);
    await api(ctx.app, boss, 'PUT', '/api/inventory/purchase-rules', { flowStallDays: 2 });
  });

  it('一条需求从提到付：每一步图都跟着单据走；部门同事只看自己看得到的需求单、不带金额；列表里做完的不列', async () => {
    // ① 提需求：停在需求审核
    const created = (await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines: [{ materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: q(2), unit: '箱', refPriceCents: 45_000 }] })).body.request;
    let mine = await one(reqA, 'request', created.id);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ anchor: { kind: 'request', id: created.id, docNo: created.docNo }, variant: 'A', stage: 'review', amountCents: null, end: null });
    expect((mine.body as PurchaseFlow).nodes.map((n) => `${n.key}:${n.state}`)).toEqual(['request:done', 'review:current', 'order:pending', 'receive:pending', 'stockin:pending', 'pay:pending']);
    expect((mine.body as PurchaseFlow).nodes[0]).toMatchObject({ role: '浴区 · 浴区申购', text: '已提交' });
    // 采购看得到金额（按参考价估：2 箱 × ¥450）
    expect((await one(buyer, 'request', created.id)).body).toMatchObject({ amountCents: 90_000, amountEstimated: true, variantText: '< ¥1,000 · 免比价' });
    // 别的部门的同事看不到这张；店员没有权限；部门同事不能直接看采购单、询价单的流程，也没有列表
    expect((await one(reqB, 'request', created.id)).status).toBe(404);
    expect((await one(ctx.clerk, 'request', created.id)).status).toBe(403);
    expect((await one(reqA, 'po', 1)).status).toBe(403);
    expect((await one(reqA, 'sourcing', 1)).status).toBe(403);
    expect((await api(ctx.app, reqA, 'GET', '/api/purchase-flow/list')).status).toBe(403);
    expect((await one(buyer, 'request', 999_999)).status).toBe(404);
    expect((await api(ctx.app, buyer, 'GET', '/api/purchase-flow/one?kind=claim&id=1')).status).toBe(400);
    expect(find((await list(buyer)).flows, 'request', created.id)).toMatchObject({ stage: 'review' });

    // ② 审核通过：停在「待转采购单」
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${created.id}/approve`, {})).status).toBe(200);
    mine = await one(reqA, 'request', created.id);
    expect(mine.body).toMatchObject({ stage: 'order' });
    expect((mine.body as PurchaseFlow).nodes[1]).toMatchObject({ state: 'done', text: '已通过', role: expect.stringContaining('周一') });
    expect((mine.body as PurchaseFlow).nodes[2]).toMatchObject({ state: 'current', text: '已通过，待转采购单' });

    // ③ 转采购单并确认：从需求单、从采购单看是同一条；需求单全部下单以后列表里由采购单那一条代表
    const detail = (await api(ctx.app, buyer, 'GET', `/api/erp/requests/${created.id}`)).body;
    let p = (await api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, action: 'submit', lines: [{ materialId: mat.id, purchaseQtyMilli: q(2), priceCents: 45_000, requestLineIds: [detail.lines[0].id] }] })).body.po;
    if (p.status === 'submitted') p = (await api(ctx.app, approver, 'POST', `/api/purchase-orders/${p.id}/approve`, {})).body;
    expect(p.status).toBe('approved');
    const byPo = (await one(buyer, 'po', p.id)).body as PurchaseFlow;
    expect(byPo).toMatchObject({ anchor: { kind: 'po', id: p.id }, variant: 'A', stage: 'receive', amountCents: 90_000, amountEstimated: false });
    expect(byPo.nodes.find((n) => n.key === 'request')).toMatchObject({ state: 'done', role: '浴区 · 浴区申购', link: { kind: 'request', id: created.id } });
    expect(byPo.nodes.find((n) => n.key === 'order')).toMatchObject({ state: 'done', text: `${p.docNo} 已下单`, link: { kind: 'po', id: p.id } });
    expect(byPo.nodes.find((n) => n.key === 'receive')).toMatchObject({ state: 'current', text: '供应商送货中', alert: null });
    mine = await one(reqA, 'request', created.id);
    expect(mine.body).toMatchObject({ stage: 'receive', amountCents: null });
    // 部门同事：下游的环节看得到状态，采购单不给链接
    expect((mine.body as PurchaseFlow).nodes.find((n) => n.key === 'order')).toMatchObject({ state: 'done', link: null });
    let flows = (await list(buyer)).flows;
    expect(find(flows, 'request', created.id)).toBeUndefined();
    expect(find(flows, 'po', p.id)).toMatchObject({ stage: 'receive', alert: false });

    // ④ 过了预计到货日：到货验收标超期，列表里排到前面
    await ctx.sql`UPDATE purchase_orders SET expected_date = ${today}::date - 3 WHERE id = ${p.id}`;
    const late = (await one(buyer, 'po', p.id)).body as PurchaseFlow;
    expect(late.nodes.find((n) => n.key === 'receive')!.alert).toMatch(/超期 3 天$/);
    flows = (await list(buyer)).flows;
    expect(flows[0]).toMatchObject({ alert: true });
    expect(find(flows, 'po', p.id)).toMatchObject({ alert: true });

    // ⑤ 收货到齐：到货、入库做完，停在付款；数与采购单页一样
    const receipt = await api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId,
      purchaseOrderId: p.id,
      coAcceptorId: buyerId,
      lines: [{ materialId: mat.id, poLineId: p.lines[0].id, deliveredMilli: p.lines[0].baseQtyMilli, acceptedMilli: p.lines[0].baseQtyMilli }],
    });
    expect(receipt.status).toBe(201);
    const poNow = (await api(ctx.app, buyer, 'GET', `/api/purchase-orders/${p.id}`)).body;
    expect(poNow.receiving).toBe('full');
    const received = (await one(buyer, 'po', p.id)).body as PurchaseFlow;
    expect(received.nodes.filter((n) => ['receive', 'stockin'].includes(n.key)).map((n) => `${n.state}:${n.text}`)).toEqual(['done:已到齐', 'done:已入库']);
    expect(received.alert).toBe(false);
    const pay = received.nodes.find((n) => n.key === 'pay')!;
    if (poNow.reimbursement.settlement === 'credit') {
      expect(pay).toMatchObject({ state: 'current' });
      // 今天入库：下个付款日（默认每月 15、30 号）还没过
      expect(pay.text).toMatch(new RegExp(`^已付 ¥${(poNow.paidCents / 100).toFixed(2)} · 未付 ¥${(poNow.unpaidCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} · 下个付款日 \\d+/\\d+$`));
      expect(pay.alert).toBeNull();
      // 部门同事看不到钱
      const hidden = (await one(reqA, 'request', created.id)).body as PurchaseFlow;
      expect(hidden.nodes.find((n) => n.key === 'pay')!.text).toMatch(/^还没付清 · 下个付款日 \d+\/\d+$/);
      // 这张单的钱一个数都不带（分流规则里的门槛金额是规则，不是这张单的钱）
      expect(JSON.stringify({ ...hidden, variantText: '' })).not.toContain('¥');
    } else {
      expect(pay.text).toContain('报销');
    }
    expect(received.stage).toBe('pay');
    expect(find((await list(buyer)).flows, 'po', p.id)).toMatchObject({ stage: 'pay' });

    // 撤回的采购单：没有这条流程
    const gone = (await api(ctx.app, buyer, 'POST', '/api/purchase-orders', { clientKey: randomUUID(), supplierId, orderDate: today, action: 'save', lines: [{ materialId: mat.id, purchaseQtyMilli: q(1), priceCents: 100 }] })).body.po;
    expect((await one(buyer, 'po', gone.id)).body).toMatchObject({ stage: 'order' });
    expect((await api(ctx.app, buyer, 'POST', `/api/purchase-orders/${gone.id}/cancel`, { reason: '不买了' })).status).toBe(200);
    expect((await one(buyer, 'po', gone.id)).status).toBe(404);
  });

  it('流程 B：询价门槛默认就是 ¥1,000（店主图上的数，LC2），估价达到门槛的需求通过后停在「待发起询价」', async () => {
    expect((await api(ctx.app, boss, 'GET', '/api/inventory/purchase-rules')).body.quoteThresholdCents).toBe(100_000);
    const r = (await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines: [{ materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: q(4), unit: '箱', refPriceCents: 45_000 }] })).body.request;
    await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/approve`, {});
    const f = (await one(buyer, 'request', r.id)).body as PurchaseFlow;
    expect(f).toMatchObject({ variant: 'B', variantText: '≥ ¥1,000 · 必须 ≥ 2 家比价 + 审批', stage: 'sourcing', amountCents: 180_000 });
    expect(f.nodes.map((n) => n.key)).toEqual(['request', 'review', 'sourcing', 'award', 'approval', 'order', 'receive', 'stockin', 'pay']);
    expect(f.nodes[2]).toMatchObject({ state: 'current', text: '待发起询价' });
    expect((await list(buyer)).rules.quoteThresholdCents).toBe(100_000);
  });
});
