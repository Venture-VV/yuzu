// 采购流程图（8.0.17，docs/FLOW_V8017.md）：从提需求到付款，每个环节的状态都从现有的单据算出来。
// 这里是不碰数据库的那一半：服务端把需求单、询价单、采购单取成「事实」，buildPurchaseFlow 算出一排环节；
// 前端只管画。图是只读的——没有另存的状态，单据往前走一步，图自己跟着变。
//
// 要部门主管确认的需求单（8.0.17，LC1）在「部门提需求」后面多一环「部门确认」。
//   流程 A（免比价）：部门提需求 → 需求审核 →（采购单审批）→ 采购下单 → 到货验收 → 入库 → 财务付款
//   流程 B（比价 + 审批）：部门提需求 → 需求审核 → 询价比价 → 比价定标 → 采购单审批 → 下单中标方 → 到货验收 → 入库 → 财务付款
// 走哪条读采购规则里的询价门槛（LC2）；超期与卡住的口径见 LC4。

import type { ApprovalStatus } from './approvals';
import type { InvDocStatus } from './inventory';
import { shiftDate } from './labels';
import { formatYuan } from './money';
import { nextPayDay, payDaysLabel } from './payments';
import type { PoStatus, ReceivingState, SourcingStatus } from './purchasing';
import type { RequestStatus } from './requests';

export type FlowNodeKey = 'request' | 'confirm' | 'review' | 'sourcing' | 'award' | 'approval' | 'order' | 'receive' | 'stockin' | 'pay';
/** done 做完（绿勾）；current 正在等（橙点）；pending 还没到（灰） */
export type FlowNodeState = 'done' | 'current' | 'pending';
export type FlowLinkKind = 'request' | 'sourcing' | 'po' | 'approval' | 'receipt';
export type FlowAnchorKind = 'request' | 'po' | 'sourcing';

export interface FlowLink {
  kind: FlowLinkKind;
  id: number;
  docNo: string;
}

export interface FlowNode {
  key: FlowNodeKey;
  /** 圆点里的一个字 */
  glyph: string;
  title: string;
  /** 谁：部门 · 人、采购、仓库、财务 */
  role: string;
  state: FlowNodeState;
  /** 状态的一句话（不带时间；时间在 at） */
  text: string;
  /** 做完的时间（时刻，或只有日期的 YYYY-MM-DD） */
  at: string | null;
  /** 正在等的：等了多久（12 分钟、3 小时、2 天） */
  waited: string | null;
  /** 红底的一条：超期、卡住、退回（带原因） */
  alert: string | null;
  /** 点这个环节去哪张单据；看的人打不开的为空 */
  link: FlowLink | null;
}

export interface PurchaseFlow {
  anchor: { kind: FlowAnchorKind; id: number; docNo: string };
  variant: 'A' | 'B';
  /** 为什么走这条：< ¥1,000 · 免比价 */
  variantText: string;
  /** 买的是什么：前几行的名称 */
  title: string;
  /** 金额（看的人不能看金额时为空） */
  amountCents: number | null;
  /** 金额是按参考价、报价估的（还没有采购单） */
  amountEstimated: boolean;
  nodes: FlowNode[];
  /** 流程结束了：done 全部做完；rejected 不采购；cancelled 需求单撤回；closed 采购单关闭 */
  end: 'done' | 'rejected' | 'cancelled' | 'closed' | null;
  endText: string | null;
  /** 现在停在哪个环节（第一个正在等的）；结束了、或都还没到的为空 */
  stage: FlowNodeKey | null;
  /** 有环节超期或卡住 */
  alert: boolean;
  /** 这条流程最近一次往前走的时间（列表按它排） */
  movedAt: string | null;
}

export interface PurchaseFlowList {
  flows: PurchaseFlow[];
  /** 现在的分流规则（页面顶上那一句） */
  rules: { quoteThresholdCents: number; minQuotes: number; stallDays: number; arrivalOverdueDays: number; payDays: number[] };
  /** 超过上限没列全 */
  truncated: boolean;
}

// ───────────────────────── 事实（服务端从单据取出来的） ─────────────────────────

export interface FlowRequestFact {
  id: number;
  docNo: string;
  status: RequestStatus;
  departmentName: string;
  requesterName: string;
  submittedAt: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reason: string | null;
  /** 截单后提交、今天还不能通过 */
  lockedToday: boolean;
  /** 部门主管确认（8.0.17，LC1）：none 不用；pending 等主管；confirmed 已确认 */
  deptConfirm: { state: 'none' | 'pending' | 'confirmed'; headName: string | null; confirmedByName: string | null; confirmedAt: string | null };
  lineCount: number;
  summary: string;
  /** 还没有有效采购单的行数 */
  unorderedLines: number;
  /** 各行「参考价 × 数量」的合计，与填了参考价的行数 */
  estimateCents: number;
  pricedLines: number;
}

export interface FlowSourcingFact {
  id: number;
  docNo: string;
  status: SourcingStatus;
  title: string;
  createdAt: string;
  createdByName: string;
  /** 有效报价的家数 */
  activeQuotes: number;
  lastQuoteAt: string | null;
  /** 有效报价里最低的综合到价 */
  lowestLandedCents: number | null;
  singleSource: boolean;
  awardedAt: string | null;
  awardedByName: string | null;
  awardedSupplierName: string | null;
}

export interface FlowPoFact {
  id: number;
  docNo: string;
  /** 撤回的采购单不算（服务端不取） */
  status: PoStatus;
  supplierName: string;
  summary: string;
  lineCount: number;
  /** 到齐的行数 */
  receivedLines: number;
  totalCents: number;
  orderDate: string;
  expectedDate: string | null;
  createdAt: string;
  createdByName: string;
  /** 这一轮提交的时间（没提交过为空） */
  submittedAt: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  returnedReason: string | null;
  closeReason: string | null;
  /** 审批中心的审批单（在审的，没有在审的取最近一张；没走过为空） */
  approval: { requestId: number; status: ApprovalStatus; currentLevel: number; levels: number; currentLabel: string; levelStartedAt: string; overdue: boolean } | null;
  receiving: ReceivingState;
  receivedCents: number;
  paidCents: number;
  unpaidCents: number;
  receipts: { id: number; docNo: string; status: InvDocStatus; docDate: string }[];
  settlement: 'credit' | 'cash';
  /** 现付：还没进有效报销单的行、还没确认的报销单 */
  unclaimedLines: number;
  claimsPending: number;
}

export interface FlowRules {
  quoteThresholdCents: number;
  minQuotes: number;
  arrivalOverdueDays: number;
  /** 一个环节等了几天标红；0 = 不标 */
  stallDays: number;
  /** 固定付款日（付款规则，LC7）：每月几号；空 = 没有 */
  payDays: number[];
}

export interface FlowFacts {
  anchor: { kind: FlowAnchorKind; id: number; docNo: string };
  requests: FlowRequestFact[];
  sourcing: FlowSourcingFact | null;
  pos: FlowPoFact[];
  rules: FlowRules;
  /** 现在（ISO 时刻）与门店的今天（YYYY-MM-DD） */
  now: string;
  today: string;
  /** 看的人能不能看金额、打开采购单（有「查看库存」） */
  purchasing: boolean;
}

// ───────────────────────── 小工具 ─────────────────────────

export const FLOW_GLYPHS: Record<FlowNodeKey, string> = { request: '部', confirm: '确', review: '审', sourcing: '价', award: '定', approval: '批', order: '订', receive: '收', stockin: '入', pay: '付' };
export const FLOW_STAGE_LABELS: Record<FlowNodeKey, string> = {
  request: '提需求',
  confirm: '待主管确认',
  review: '待审核',
  sourcing: '询价中',
  award: '待定标',
  approval: '待审批',
  order: '待下单',
  receive: '待到货',
  stockin: '待入库',
  pay: '待付款',
};

/** 门槛这类整数金额：¥1,000（有零头的才带小数） */
export const flowYuan = (cents: number): string => (cents % 100 === 0 ? `${cents < 0 ? '-' : ''}¥${Math.abs(cents / 100).toLocaleString('en-US')}` : formatYuan(cents));

const DAY = 86_400_000;
/** 2026-11-15 → 11/15 */
const monthDay = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
/** 两个日期（YYYY-MM-DD）差几天：a − b */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
}

/** 从 since 等到现在：整天数与一句话。since 是时刻，或只有日期（按门店的今天算） */
function waitedOf(since: string | null, f: Pick<FlowFacts, 'now' | 'today'>): { days: number; text: string } | null {
  if (!since) return null;
  if (isDateOnly(since)) {
    const days = Math.max(0, dayDiff(f.today, since));
    return { days, text: days === 0 ? '今天' : `${days} 天` };
  }
  const ms = Math.max(0, Date.parse(f.now) - Date.parse(since));
  if (Number.isNaN(ms)) return null;
  const min = Math.floor(ms / 60_000);
  const days = Math.floor(ms / DAY);
  return { days, text: min < 60 ? `${min} 分钟` : min < 48 * 60 ? `${Math.floor(min / 60)} 小时` : `${days} 天` };
}

const latest = (values: (string | null | undefined)[]): string | null => {
  const xs = values.filter((v): v is string => !!v).sort((a, b) => Date.parse(isDateOnly(a) ? `${a}T00:00:00Z` : a) - Date.parse(isDateOnly(b) ? `${b}T00:00:00Z` : b));
  return xs[xs.length - 1] ?? null;
};
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
const names = (xs: string[], max = 3) => {
  const u = uniq(xs);
  return u.length > max ? `${u.slice(0, max).join('、')} 等` : u.join('、');
};

const PENDING_RECEIPT: readonly InvDocStatus[] = ['draft', 'submitted', 'returned', 'awaiting_supplier'];
const ordered = (p: FlowPoFact) => p.status === 'approved' || p.status === 'closed';

interface Draft {
  key: FlowNodeKey;
  title: string;
  role: string;
  state: FlowNodeState;
  text: string;
  at?: string | null;
  /** 正在等：从什么时候开始等 */
  since?: string | null;
  /** 已经确定的红条（退回、审批超时、到货超期）；没给的按「环节等了几天标红」算 */
  alert?: string | null;
  /** 按天数标红时接在后面的话（缺 1 家报价） */
  stallExtra?: string;
  /** 这个环节不按天数标红（付款） */
  noStall?: boolean;
  link?: FlowLink | null;
}

// ───────────────────────── 算一条流程 ─────────────────────────

export function buildPurchaseFlow(f: FlowFacts): PurchaseFlow {
  const reqs = f.requests;
  const sourcing = f.sourcing && f.sourcing.status !== 'cancelled' ? f.sourcing : null;
  const pos = f.pos.filter((p) => p.status !== 'cancelled');
  const op = pos.filter(ordered);
  const { quoteThresholdCents: threshold, minQuotes } = f.rules;
  const unorderedLines = f.anchor.kind === 'request' ? reqs.reduce((s, r) => s + r.unorderedLines, 0) : 0;

  // 金额：有采购单用采购单合计；没有的用最低报价、再不行按参考价估
  let amount: number | null = null;
  let estimated = false;
  if (pos.length) amount = pos.reduce((s, p) => s + p.totalCents, 0);
  else if (sourcing?.lowestLandedCents != null) [amount, estimated] = [sourcing.lowestLandedCents, true];
  else if (reqs.some((r) => r.pricedLines > 0)) [amount, estimated] = [reqs.reduce((s, r) => s + r.estimateCents, 0), true];

  // 走哪条：发起了询价的走 B；合计达到门槛、采购单还没提交过的走 B（提交时会被拦下来要求先询价）
  const overThreshold = threshold > 0 && amount !== null && amount >= threshold;
  const variant: 'A' | 'B' = sourcing || (overThreshold && !pos.some((p) => p.status !== 'draft')) ? 'B' : 'A';
  const variantText =
    variant === 'B'
      ? overThreshold || !sourcing
        ? `≥ ${flowYuan(threshold)} · 必须 ≥ ${minQuotes} 家比价 + 审批`
        : `已发起询价 · ≥ ${minQuotes} 家比价 + 审批`
      : threshold <= 0
        ? '免比价（采购规则没设询价门槛）'
        : amount === null
          ? `金额未定 · 下单时合计 ≥ ${flowYuan(threshold)} 要先询价`
          : `< ${flowYuan(threshold)} · 免比价`;

  const one = reqs.length === 1 ? reqs[0]! : null;
  const rejected = reqs.length > 0 && pos.length === 0 && !sourcing && reqs.every((r) => r.status === 'rejected');
  const cancelled = reqs.length > 0 && pos.length === 0 && !sourcing && reqs.every((r) => r.status === 'cancelled');
  const approvedAll = reqs.every((r) => r.status === 'approved');
  /** 需求都通过的时间（下游从这时开始等） */
  const reviewedAt = reqs.length && approvedAll ? latest(reqs.map((r) => r.reviewedAt)) : null;
  const reqLink = (r: FlowRequestFact): FlowLink => ({ kind: 'request', id: r.id, docNo: r.docNo });
  const poLink = (p: FlowPoFact): FlowLink => ({ kind: 'po', id: p.id, docNo: p.docNo });

  const drafts: Draft[] = [];

  // ① 部门提需求、② 需求审核
  if (reqs.length) {
    drafts.push(
      one
        ? { key: 'request', title: '部门提需求', role: `${one.departmentName} · ${one.requesterName}`, state: 'done', text: '已提交', at: one.submittedAt, link: reqLink(one) }
        : { key: 'request', title: '部门提需求', role: names(reqs.map((r) => r.departmentName)), state: 'done', text: `${reqs.length} 张需求单`, at: latest(reqs.map((r) => r.submittedAt)), link: reqLink(reqs[0]!) },
    );
    const waiting = reqs.find((r) => r.status !== 'approved');
    // ①′ 部门确认（要主管确认的才有这一环）：等主管确认时球在主管那里，「需求审核」先灰着
    const confirming = reqs.filter((r) => r.deptConfirm.state !== 'none');
    const atHead = !!waiting && waiting.deptConfirm.state === 'pending' && (waiting.status === 'submitted' || waiting.status === 'returned');
    if (confirming.length) {
      const c = waiting && waiting.deptConfirm.state !== 'none' ? waiting : confirming[0]!;
      const head = `部门主管${c.deptConfirm.headName ? ` · ${c.deptConfirm.headName}` : ''}`;
      if (atHead && waiting!.status === 'submitted') {
        drafts.push({ key: 'confirm', title: '部门确认', role: head, state: 'current', text: '待主管确认', since: waiting!.submittedAt, link: reqLink(waiting!) });
      } else if (atHead) {
        drafts.push({ key: 'confirm', title: '部门确认', role: head, state: 'current', text: '等部门修改后再提交', since: waiting!.submittedAt, alert: `已退回${waiting!.reason ? `：${waiting!.reason}` : ''}`, link: reqLink(waiting!) });
      } else if (confirming.every((r) => r.deptConfirm.state === 'confirmed')) {
        drafts.push({ key: 'confirm', title: '部门确认', role: names(confirming.map((r) => r.deptConfirm.confirmedByName ?? '')) || head, state: 'done', text: '已确认', at: latest(confirming.map((r) => r.deptConfirm.confirmedAt)), link: reqLink(c) });
      } else {
        // 等主管确认的时候被采购定了不采购、被提单人撤回
        drafts.push({ key: 'confirm', title: '部门确认', role: head, state: 'pending', text: '没有确认', link: reqLink(c) });
      }
    }
    if (atHead) {
      drafts.push({ key: 'review', title: '需求审核', role: '采购审核', state: 'pending', text: '待主管确认后', link: reqLink(waiting!) });
    } else if (!waiting) {
      drafts.push({ key: 'review', title: '需求审核', role: names(reqs.map((r) => r.reviewedByName ?? '')) || '采购', state: 'done', text: '已通过', at: reviewedAt, link: reqLink(reqs[0]!) });
    } else if (waiting.status === 'submitted') {
      drafts.push({ key: 'review', title: '需求审核', role: '采购审核', state: 'current', text: waiting.lockedToday ? '截单后提交，明天起可审核' : '待审核', since: waiting.submittedAt, link: reqLink(waiting) });
    } else if (waiting.status === 'returned') {
      drafts.push({
        key: 'review',
        title: '需求审核',
        role: `${waiting.departmentName} · ${waiting.requesterName}`,
        state: 'current',
        text: '等部门修改后再提交',
        since: waiting.reviewedAt ?? waiting.submittedAt,
        alert: `已退回${waiting.reason ? `：${waiting.reason}` : ''}`,
        link: reqLink(waiting),
      });
    } else if (waiting.status === 'rejected') {
      drafts.push({ key: 'review', title: '需求审核', role: waiting.reviewedByName ?? '采购', state: 'current', text: '不采购', at: waiting.reviewedAt, alert: `不采购${waiting.reason ? `：${waiting.reason}` : ''}`, noStall: true, link: reqLink(waiting) });
    } else {
      drafts.push({ key: 'review', title: '需求审核', role: '采购审核', state: 'pending', text: '需求单已撤回', link: reqLink(waiting) });
    }
  }
  /** 上游都好了（没有需求单的从采购开始，算好了） */
  const upstream = reqs.length === 0 || approvedAll;

  // ③ 询价比价、④ 比价定标（流程 B）
  if (variant === 'B') {
    if (sourcing) {
      const link: FlowLink = { kind: 'sourcing', id: sourcing.id, docNo: sourcing.docNo };
      const got = `已收 ${sourcing.activeQuotes} 家报价${sourcing.singleSource ? ' · 单一来源' : ''}`;
      if (sourcing.status === 'awarded') {
        drafts.push({ key: 'sourcing', title: '询价比价', role: `采购 · ${sourcing.createdByName}`, state: 'done', text: got, at: sourcing.lastQuoteAt ?? sourcing.createdAt, link });
        drafts.push({ key: 'award', title: '比价定标', role: sourcing.awardedByName ?? '采购', state: 'done', text: sourcing.awardedSupplierName ? `中标：${sourcing.awardedSupplierName}` : '已定标', at: sourcing.awardedAt, link });
      } else if (sourcing.activeQuotes < minQuotes) {
        drafts.push({
          key: 'sourcing',
          title: '询价比价',
          role: `采购 · 需 ≥ ${minQuotes} 家`,
          state: 'current',
          text: `已收 ${sourcing.activeQuotes} / ${minQuotes} 家报价`,
          since: sourcing.createdAt,
          stallExtra: `缺 ${minQuotes - sourcing.activeQuotes} 家报价`,
          link,
        });
        drafts.push({ key: 'award', title: '比价定标', role: '采购', state: 'pending', text: '待报价齐', link });
      } else {
        drafts.push({ key: 'sourcing', title: '询价比价', role: `采购 · ${sourcing.createdByName}`, state: 'done', text: got, at: sourcing.lastQuoteAt ?? sourcing.createdAt, link });
        drafts.push({ key: 'award', title: '比价定标', role: '采购', state: 'current', text: '报价已齐，待定标', since: sourcing.lastQuoteAt ?? sourcing.createdAt, link });
      }
    } else {
      const start = upstream && !rejected && !cancelled;
      drafts.push({
        key: 'sourcing',
        title: '询价比价',
        role: `采购 · 需 ≥ ${minQuotes} 家`,
        state: start ? 'current' : 'pending',
        text: start ? '待发起询价' : '待审核通过后',
        since: start ? (pos[0]?.createdAt ?? reviewedAt) : null,
        link: start && pos[0] ? poLink(pos[0]) : null,
      });
      drafts.push({ key: 'award', title: '比价定标', role: '采购', state: 'pending', text: '待报价齐' });
    }
  }
  const sourced = variant === 'A' || sourcing?.status === 'awarded';

  // ⑤ 采购单审批：流程 B 都有；流程 A 只在这张采购单确实要人审时才有
  const approvalShown = variant === 'B' || pos.some((p) => p.approval !== null || p.status === 'submitted' || p.status === 'returned');
  if (approvalShown) {
    const open = pos.find((p) => !ordered(p));
    if (pos.length === 0) {
      const start = variant === 'B' && sourcing?.status === 'awarded';
      drafts.push({
        key: 'approval',
        title: '采购单审批',
        role: '采购',
        state: start ? 'current' : 'pending',
        text: start ? '已定标，待转采购单并提交' : variant === 'B' ? '待定标后' : '待下单后',
        since: start ? sourcing!.awardedAt : null,
        link: start ? { kind: 'sourcing', id: sourcing!.id, docNo: sourcing!.docNo } : null,
      });
    } else if (!open) {
      const p = pos[pos.length - 1]!;
      drafts.push({ key: 'approval', title: '采购单审批', role: names(pos.map((x) => x.approvedByName ?? '')) || '负责人', state: 'done', text: pos.length > 1 ? `${pos.length} 张采购单已确认` : '已确认', at: latest(pos.map((x) => x.approvedAt)), link: poLink(p) });
    } else if (!sourced) {
      // 合计达到门槛、还没询价的草稿：先去询价
      drafts.push({ key: 'approval', title: '采购单审批', role: '采购', state: 'pending', text: '待定标后', link: poLink(open) });
    } else if (open.status === 'draft') {
      drafts.push({ key: 'approval', title: '采购单审批', role: `采购 · ${open.createdByName}`, state: 'current', text: '采购单草稿，待提交', since: open.createdAt, link: poLink(open) });
    } else if (open.status === 'returned') {
      drafts.push({
        key: 'approval',
        title: '采购单审批',
        role: `采购 · ${open.createdByName}`,
        state: 'current',
        text: '等采购修改后再提交',
        since: open.submittedAt ?? open.createdAt,
        alert: `已退回修改${open.returnedReason ? `：${open.returnedReason}` : ''}`,
        link: poLink(open),
      });
    } else {
      const a = open.approval?.status === 'pending' ? open.approval : null;
      const since = a?.levelStartedAt ?? open.submittedAt ?? open.createdAt;
      const w = waitedOf(since, f);
      drafts.push({
        key: 'approval',
        title: '采购单审批',
        role: a ? a.currentLabel : '负责人',
        state: 'current',
        text: a ? (a.levels > 1 ? `第 ${a.currentLevel} / ${a.levels} 级 · 审批中` : '审批中') : '待负责人确认',
        since,
        alert: a?.overdue ? `已等待 ${w?.text ?? ''} · 审批超时` : null,
        link: a && f.purchasing ? { kind: 'approval', id: a.requestId, docNo: open.docNo } : poLink(open),
      });
    }
  }

  // ⑥ 采购下单 / 下单中标方
  const orderTitle = variant === 'B' ? '下单中标方' : '采购下单';
  if (pos.length === 0) {
    const start = !approvalShown && reqs.length > 0 && upstream;
    drafts.push({ key: 'order', title: orderTitle, role: '采购', state: start ? 'current' : 'pending', text: start ? '已通过，待转采购单' : approvalShown ? '待审批后' : '待审核通过后', since: start ? reviewedAt : null, link: start && one ? reqLink(one) : null });
  } else {
    const open = pos.find((p) => !ordered(p));
    const suppliers = names(pos.map((p) => p.supplierName));
    if (!open) {
      const more = unorderedLines > 0;
      drafts.push({
        key: 'order',
        title: orderTitle,
        role: `采购 → ${suppliers}`,
        state: more ? 'current' : 'done',
        text: `${pos.length > 1 ? `${pos.length} 张采购单` : pos[0]!.docNo} 已下单${more ? ` · 还有 ${unorderedLines} 行没下单` : ''}`,
        at: more ? null : latest(pos.map((p) => p.approvedAt ?? p.orderDate)),
        since: more ? reviewedAt : null,
        link: poLink(pos[pos.length - 1]!),
      });
    } else if (approvalShown) {
      drafts.push({ key: 'order', title: orderTitle, role: `采购 → ${suppliers}`, state: 'pending', text: op.length ? `${op.length} / ${pos.length} 张采购单已下单` : '待审批后', link: poLink(open) });
    } else {
      // 流程 A、不用人审的采购单还是草稿
      drafts.push({ key: 'order', title: orderTitle, role: `采购 · ${open.createdByName}`, state: 'current', text: '采购单草稿，待提交', since: open.createdAt, link: poLink(open) });
    }
  }

  // ⑦ 到货验收、⑧ 入库、⑨ 财务付款：按已下单的采购单算，几张的合在一起
  const tail = (key: 'receive' | 'stockin' | 'pay', title: string, role: string, doneWord: string, idle: string, per: (p: FlowPoFact) => Draft) => {
    if (op.length === 0) return drafts.push({ key, title, role, state: 'pending', text: idle });
    const each = op.map(per);
    if (each.length === 1) return drafts.push(each[0]!);
    const done = each.filter((d) => d.state === 'done').length;
    const cur = each.find((d) => d.state === 'current');
    const first = each.findIndex((d) => d.state !== 'done');
    drafts.push({
      key,
      title,
      role,
      // 都做完才算做完；有一张正在等就是正在等；其余的（有的做完、有的还没到）先灰着，字里写几张做完了
      state: done === each.length ? 'done' : cur ? 'current' : 'pending',
      text: `${done} / ${each.length} 张采购单${doneWord}`,
      at: done === each.length ? latest(each.map((d) => d.at)) : null,
      since: cur?.since ?? null,
      alert: each.find((d) => d.alert)?.alert ?? null,
      noStall: each.every((d) => d.noStall),
      link: (first >= 0 ? each[first]!.link : each[each.length - 1]!.link) ?? null,
    });
  };
  const pendingReceipt = (p: FlowPoFact) => p.receipts.find((r) => PENDING_RECEIPT.includes(r.status));
  const lastConfirmed = (p: FlowPoFact) => latest(p.receipts.filter((r) => r.status === 'confirmed').map((r) => r.docDate));
  const receiptLink = (r: { id: number; docNo: string }): FlowLink => ({ kind: 'receipt', id: r.id, docNo: r.docNo });
  /** 到货这一环做完：到齐了，或采购单关闭（没到的不再到） */
  const arrived = (p: FlowPoFact) => p.receiving === 'full' || p.status === 'closed';

  tail('receive', '到货验收', '仓库', '已到齐', '待下单后', (p) => {
    const base = { key: 'receive' as const, title: '到货验收', role: '仓库' };
    if (p.receiving === 'full') return { ...base, state: 'done', text: '已到齐', at: lastConfirmed(p), link: poLink(p) };
    if (p.status === 'closed') return { ...base, state: 'done', text: p.receiving === 'none' ? '采购单已关闭，没有到货' : '采购单已关闭，没到的不再到', at: lastConfirmed(p), link: poLink(p) };
    const pr = pendingReceipt(p);
    // 收货单登记了、还没确认：验收这一步算做了，球在「入库」那一环
    if (pr) return { ...base, state: 'done', text: `已登记收货 ${pr.docNo}`, at: pr.docDate, link: receiptLink(pr) };
    // 从下单日算等了几天（补录的采购单确认得晚，按确认时间算会写成「等了 0 分钟、超期 3 天」）
    const since = p.orderDate;
    const due = p.expectedDate ?? shiftDate(p.orderDate, f.rules.arrivalOverdueDays);
    const late = dayDiff(f.today, due);
    const w = waitedOf(since, f);
    return {
      ...base,
      state: 'current',
      text: p.receiving === 'partial' ? `部分到货（${p.receivedLines} / ${p.lineCount} 行到齐）` : '供应商送货中',
      since,
      alert: late > 0 ? `已等待 ${w?.text ?? ''} · 超期 ${late} 天` : null,
      noStall: true,
      link: poLink(p),
    };
  });
  tail('stockin', '入库', '仓库', '已入库', '待验收后入库', (p) => {
    const base = { key: 'stockin' as const, title: '入库', role: '仓库' };
    const pr = pendingReceipt(p);
    if (pr) return { ...base, role: '仓库 / 负责人', state: 'current', text: `收货单 ${pr.docNo} 待确认`, since: pr.docDate, link: receiptLink(pr) };
    if (p.receiving === 'full') return { ...base, state: 'done', text: '已入库', at: lastConfirmed(p), link: poLink(p) };
    if (p.status === 'closed') return { ...base, state: 'done', text: p.receiving === 'none' ? '没有到货' : '到的已入库', at: lastConfirmed(p), link: poLink(p) };
    return { ...base, state: 'pending', text: p.receiving === 'partial' ? `已入库 ${p.receivedLines} / ${p.lineCount} 行` : '待验收后入库', link: poLink(p) };
  });
  tail('pay', '财务付款', payDaysLabel(f.rules.payDays) ? `财务 · ${payDaysLabel(f.rules.payDays)}` : '财务', '已付清', '到货后付款', (p) => {
    const base = { key: 'pay' as const, title: '财务付款', role: '财务', noStall: true, link: poLink(p) };
    const allIn = arrived(p) && !pendingReceipt(p);
    if (p.settlement === 'cash') {
      if (p.receivedCents <= 0 && !allIn) return { ...base, state: 'pending', text: '现付 · 到货后报销' };
      if (p.unclaimedLines === 0 && p.claimsPending === 0) return allIn ? { ...base, state: 'done', text: '已报销', at: lastConfirmed(p) } : { ...base, state: 'pending', text: '到的已报销' };
      return { ...base, state: allIn ? 'current' : 'pending', text: p.unclaimedLines > 0 ? `现付 · 还有 ${p.unclaimedLines} 行没报销` : '报销单待确认', since: allIn ? lastConfirmed(p) : null };
    }
    // 固定付款日（LC7、LC14）：还没到货的写每月几号付款；到齐入库、没付清的写下个付款日，过了入库以后的第一个付款日还没付清的标红
    const days = payDaysLabel(f.rules.payDays);
    if (p.receivedCents <= 0) return allIn ? { ...base, state: 'done', text: '没有到货，不用付款' } : { ...base, role: days ? `财务 · ${days}` : '财务', state: 'pending', text: '到货后付款' };
    if (p.unpaidCents <= 0) return allIn ? { ...base, state: 'done', text: '已付清', at: lastConfirmed(p) } : { ...base, state: 'pending', text: '到的已付清' };
    const money = f.purchasing ? `已付 ${formatYuan(p.paidCents)} · 未付 ${formatYuan(p.unpaidCents)}` : '还没付清';
    if (!allIn) return { ...base, state: 'pending', text: money };
    const inAt = lastConfirmed(p);
    const due = inAt ? nextPayDay(inAt, f.rules.payDays, true) : null;
    const late = due ? dayDiff(f.today, due) : 0;
    const next = nextPayDay(f.today, f.rules.payDays);
    return {
      ...base,
      role: days ? `财务 · ${days}` : '财务',
      state: 'current',
      text: late <= 0 && next ? `${money} · 下个付款日 ${monthDay(next)}` : money,
      since: inAt,
      alert: late > 0 && due ? `已过付款日 ${monthDay(due)} · 超 ${late} 天` : null,
    };
  });

  // ── 收尾：结束的流程后面的环节都灰着；按天数标红；看的人打不开的不给链接 ──
  let end: PurchaseFlow['end'] = null;
  let endText: string | null = null;
  if (rejected) [end, endText] = ['rejected', '需求单定为不采购，流程结束'];
  else if (cancelled) [end, endText] = ['cancelled', '需求单已撤回，流程结束'];
  const stopAt = end ? drafts.findIndex((d) => d.key === 'review') : -1;

  const nodes: FlowNode[] = drafts.map((d, i) => {
    const stopped = stopAt >= 0 && i > stopAt;
    const state: FlowNodeState = stopped ? 'pending' : d.state;
    const w = state === 'current' ? waitedOf(d.since ?? null, f) : null;
    let alert = stopped ? null : (d.alert ?? null);
    if (!alert && state === 'current' && !d.noStall && w && f.rules.stallDays > 0 && w.days >= f.rules.stallDays) alert = `已等待 ${w.text}${d.stallExtra ? ` · ${d.stallExtra}` : ''}`;
    const link = d.link && (f.purchasing || d.link.kind === 'request') ? d.link : null;
    return { key: d.key, glyph: FLOW_GLYPHS[d.key], title: d.title, role: d.role, state, text: stopped ? '—' : d.text, at: stopped ? null : (d.at ?? null), waited: w?.text ?? null, alert, link };
  });

  if (!end && nodes.every((n) => n.state === 'done')) {
    const closed = pos.length > 0 && pos.every((p) => p.status === 'closed');
    [end, endText] = closed ? ['closed', `采购单已关闭${pos[0]!.closeReason ? `：${pos[0]!.closeReason}` : ''}`] : ['done', '全部完成'];
  }
  const current = end ? null : (nodes.find((n) => n.state === 'current') ?? null);
  const summary = uniq([...pos.map((p) => p.summary), sourcing?.title ?? '', ...reqs.map((r) => r.summary)])[0] ?? f.anchor.docNo;

  return {
    anchor: f.anchor,
    variant,
    variantText,
    title: summary,
    amountCents: f.purchasing ? amount : null,
    amountEstimated: estimated,
    nodes,
    end,
    endText,
    stage: current?.key ?? null,
    alert: !end && nodes.some((n) => n.alert !== null),
    movedAt: latest([...nodes.map((n) => n.at), ...reqs.map((r) => r.submittedAt), sourcing?.createdAt, ...pos.map((p) => p.createdAt)]),
  };
}
