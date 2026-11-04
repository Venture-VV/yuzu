// 业务单据打到小票机（v0.7.28 ⑥，docs/SCHEDULE_FINISH.md 第 7 节，N7）：结账单、退款单、交班表、日结单（80mm 汇总）的 ESC/POS 版式。
// 内容与浏览器打印的 80mm 单据同一份数据（CheckoutPrint、RefundDetail、ShiftRecord、SettlementSummary），提交时排好、存在打印任务上；
// 末尾的走纸与切纸在发送时补上（finishSlip：等过打印机恢复的注明补打）。完整的 A4 日结单照旧用浏览器打印。

import { minutesText } from '@shared/benefits';
import { businessBreakdown, CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS, ticketTierLabel, type CheckoutMethod, type RefundDetail, type ShiftRecord, type ShiftSummary } from '@shared/checkout';
import { describeDate, PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from '@shared/labels';
import { formatYuan } from '@shared/money';
import type { CheckoutPrint } from '@shared/print';
import type { SettlementSummary } from '@shared/types';
import { columnsOf, EscPos, textWidth } from './escpos';

export interface SlipMeta {
  storeName: string;
  /** 实例标识（不是正式服时醒目标出：测试、影子、演示打出来的单不能当真） */
  instanceLabel: string;
  production: boolean;
  timeZone: string;
  paperWidth?: 58 | 80;
  /** 出单时间与经办（提交打印的人） */
  issuedAt: Date;
  issuedBy: string;
  /** 日结单：每天几点切换营业日 */
  businessDayStartHour?: number;
}

const yuan = formatYuan;
const methodLabel = (m: string) => CHECKOUT_METHOD_LABELS[m as CheckoutMethod] ?? PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS] ?? m;
const payLabel = (m: string) => PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS] ?? m;

/** 年月日 时:分，按门店时区（与浏览器打印的 stamp 一致） */
export function slipStamp(at: string | Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(typeof at === 'string' ? new Date(at) : at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 按显示宽度（半角 1、全角 2）折行 */
export function wrapByWidth(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    let w = 0;
    for (const ch of para) {
      const cw = textWidth(ch);
      if (w + cw > cols && line) {
        out.push(line);
        line = '';
        w = 0;
      }
      line += ch;
      w += cw;
    }
    out.push(line);
  }
  return out;
}

/** 一张小票：抬头、左右两栏、折行、分隔线、签字栏、出单信息 */
class Slip {
  readonly p = new EscPos().init();
  readonly cols: number;
  constructor(readonly meta: SlipMeta) {
    this.cols = columnsOf(meta.paperWidth);
  }
  header(title: string) {
    this.p.align(1).bold(true).size(1, 2);
    for (const l of wrapByWidth(this.meta.storeName, this.cols)) this.p.line(l);
    this.p.size(1, 1).line(title).bold(false);
    if (!this.meta.production) this.p.bold(true).line(`【${this.meta.instanceLabel} · 不是正式服】`).bold(false);
    this.p.align(0);
    return this;
  }
  text(s: string, indent = 0) {
    for (const l of wrapByWidth(s, this.cols - indent)) this.p.line(`${' '.repeat(indent)}${l}`);
    return this;
  }
  strong(s: string) {
    this.p.bold(true);
    this.text(s);
    this.p.bold(false);
    return this;
  }
  /** 左边说明、右边取值；放不下时左边折行、右边单独一行靠右 */
  pair(left: string, right: string, opts: { strong?: boolean; big?: boolean; indent?: number } = {}) {
    const indent = opts.indent ?? 0;
    const pad = ' '.repeat(indent);
    if (opts.strong || opts.big) this.p.bold(true);
    if (opts.big) this.p.size(1, 2);
    if (indent + textWidth(left) + 1 + textWidth(right) <= this.cols) this.p.pair(`${pad}${left}`, right, this.cols);
    else {
      for (const l of wrapByWidth(left, this.cols - indent)) this.p.line(`${pad}${l}`);
      this.p.line(`${' '.repeat(Math.max(0, this.cols - textWidth(right)))}${right}`);
    }
    if (opts.big) this.p.size(1, 1);
    if (opts.strong || opts.big) this.p.bold(false);
    return this;
  }
  rule(double = false) {
    this.p.rule(this.cols, double ? '=' : '-');
    return this;
  }
  sign(label: string, name?: string | null) {
    this.p.line(`${label}：${name ?? ''}`).newline().newline().rule(this.cols, '_');
    return this;
  }
  /** 出单信息（打印时间在发送时另记：补打的注明） */
  footer(jobNote?: string) {
    this.p.newline().align(1).line(`出单 ${slipStamp(this.meta.issuedAt, this.meta.timeZone)} · ${this.meta.issuedBy}`);
    if (jobNote) this.p.line(jobNote);
    this.p.align(0);
    return this;
  }
  bytes(): Buffer {
    return this.p.bytes();
  }
}

/** 发送时补上末尾：等过打印机恢复的注明补打与补打时间，然后走纸、切纸 */
export function finishSlip(body: Buffer, opts: { waitedSince: Date | null; now: Date; timeZone: string }): Buffer {
  const tail = new EscPos();
  if (opts.waitedSince) tail.align(1).line(`（打印机恢复后补打 ${slipStamp(opts.now, opts.timeZone)}）`).align(0);
  return Buffer.concat([body, tail.feed(4).cut().bytes()]);
}

// ───────────────────────── 结账单 ─────────────────────────

export function buildCheckoutSlip(d: CheckoutPrint, meta: SlipMeta): Buffer {
  const s = new Slip(meta).header('结 账 单');
  const tz = meta.timeZone;
  s.pair('单号', d.checkoutNo).pair('营业日', d.businessDate).pair('结账时间', slipStamp(d.createdAt, tz)).pair('收银', d.operatorName);
  if (d.backfill) s.strong(`补录 · 纸质单 ${d.backfill.slipNo}（${d.backfill.enteredByName} ${slipStamp(d.backfill.enteredAt, tz)} 补录）`);
  if (d.status === 'voided') {
    s.rule(true).strong('已反结账（本单作废）').text(`${d.voidedByName ?? ''} ${d.voidedAt ? slipStamp(d.voidedAt, tz) : ''}`.trim()).text(`原因：${d.voidReason ?? ''}`).rule(true);
  }
  s.rule();
  d.bills.forEach((b, i) => {
    if (i > 0) s.rule();
    s.pair(b.tableName !== null ? `桌台 ${b.tableName}` : `手牌 ${b.tagCode}`, b.memberName ? `会员 ${b.memberName}` : b.guestLabel || '散客', { strong: true });
    let stay = `${b.tableName !== null ? `用餐 ${b.guests} 人 · ` : '在店 '}${Math.floor(b.stayMinutes / 60)} 小时 ${b.stayMinutes % 60} 分`;
    if (b.ticketAmount === 0 && b.ticketSegments !== null) stay += ` · ${b.ticketName}（${ticketTierLabel(b.ticketSegments)}，免票）`;
    if (b.ticketExtensionMinutes > 0) stay += ` · 会员浴票延迟 ${minutesText(b.ticketExtensionMinutes)}`;
    s.text(stay);
    for (const l of b.lines) {
      s.pair(l.name, yuan(l.amount));
      if (l.technician) s.text(`技师 ${l.technician}`, 2);
      if (l.quantity > 1) s.text(`${l.quantity} × ${yuan(l.unitPrice)}`, 2);
    }
    if (b.lines.length === 0) s.text('（无消费）');
    if (b.linesTotal !== b.amount) s.strong(`明细合计 ${yuan(b.linesTotal)} 与结账金额不同，以结账金额为准`);
    s.pair('小计', yuan(b.amount), { strong: true });
  });
  s.rule(true).pair('应收合计', yuan(d.totalAmount), { big: true }).strong('收款');
  if (d.payments.length === 0) s.text('应收为 0，未收款');
  for (const p of d.payments) {
    s.pair(`${methodLabel(p.method)}${p.method === 'wallet' && p.memberName ? ` · ${p.memberName}` : ''}`, yuan(p.amount));
    if (p.method === 'wallet' && p.consumption) {
      s.text(`扣本金 ${yuan(p.consumption.principal)} · 扣赠金 ${yuan(p.consumption.bonus)}`, 2);
      if (p.balance) {
        s.text(`扣前 本金 ${yuan(p.balance.before.principal)} / 赠金 ${yuan(p.balance.before.bonus)}`, 2);
        s.text(`扣后 本金 ${yuan(p.balance.after.principal)} / 赠金 ${yuan(p.balance.after.bonus)}`, 2);
      }
      if (p.consumption.status === 'reversed') s.text('已随反结账撤销，储值已退回', 2);
    }
    if (p.method === 'coupon' && p.coupon) {
      s.text(`${COUPON_PLATFORM_LABELS[p.coupon.platform]}${p.coupon.dealName ? ` ${p.coupon.dealName}` : ''} · 券码尾号 ${p.coupon.code.slice(-4)}${p.coupon.status === 'voided' ? '（已作废）' : ''}`, 2);
    }
    if (p.method !== 'wallet' && p.method !== 'coupon' && p.ref) s.text(p.ref, 2);
    const approver = (p as { approvedByName?: string | null }).approvedByName;
    if (approver) s.text(`${approver} 当场授权`, 2);
  }
  if (d.note) s.text(`备注：${d.note}`);
  if (d.status === 'completed' && d.remainingMates.length > 0) s.text(`同行仍在店：${d.remainingMates.join('、')}（另行结账）`);
  s.rule().sign('客人签字');
  return s.footer().bytes();
}

// ───────────────────────── 退款单 ─────────────────────────

export function buildRefundSlip(d: RefundDetail, meta: SlipMeta): Buffer {
  const s = new Slip(meta).header('退 款 单');
  const tz = meta.timeZone;
  s.pair('单号', d.refundNo).pair('原结账单', d.checkoutNo);
  if (d.tagCodes.length > 0 || d.tableNames.length > 0) s.pair(d.tableNames.length ? '桌台' : '手牌', [...d.tagCodes, ...d.tableNames].join('、'));
  s.pair('营业日', d.businessDate).pair('退款时间', slipStamp(d.createdAt, tz)).pair('经办', d.operatorName);
  if (d.status === 'voided') {
    s.rule(true).strong('已作废（本单不算）').text(`${d.voidedByName ?? ''} ${d.voidedAt ? slipStamp(d.voidedAt, tz) : ''}`.trim()).text(`原因：${d.voidReason ?? ''}`).rule(true);
  }
  s.rule().strong('退的项目');
  for (const i of d.items) {
    s.pair(i.name, yuan(i.amount));
    s.text(`${i.category} · ${i.quantity > 0 ? `退 ${i.quantity} 份` : '只退钱、不退份数'}`, 2);
  }
  s.rule(true).pair('退款合计', yuan(d.amount), { big: true }).strong('退款方式');
  for (const p of d.payments) {
    s.pair(payLabel(p.method), yuan(p.amount));
    if (p.ref) s.text(p.method === 'other' ? p.ref : `退款单号 ${p.ref}`, 2);
    if (p.method === 'cash' && d.shift) s.text(`从 ${d.shift.staffName} 的钱箱退（班次 ${d.shift.shiftNo}）`, 2);
  }
  s.text(`原因：${d.reason}`).rule().sign('客人签字').sign('经办签字', d.operatorName);
  return s.footer().bytes();
}

// ───────────────────────── 交班表 ─────────────────────────

type Summary = ShiftSummary & { refunds?: ShiftSummary['refunds']; cash: ShiftSummary['cash'] };

export function buildShiftSlip(r: ShiftRecord, meta: SlipMeta): Buffer {
  const closed = r.status === 'closed';
  const s = new Slip(meta).header(closed ? '交 班 表' : '交班表（预览）');
  const tz = meta.timeZone;
  const sum = r.summary as Summary;
  if (!closed) s.strong('当班中，尚未交班');
  s.pair('班次', r.shiftNo).pair('交班人', r.staffName).pair('营业日', r.businessDate).pair('开班', slipStamp(r.startedAt, tz)).pair('交班', r.endedAt ? slipStamp(r.endedAt, tz) : '—');
  s.rule().pair('备用金', yuan(r.openingCash), { strong: true });
  s.strong(`前台结账 ${sum.checkouts.count} 张`);
  if (sum.checkoutByMethod.length === 0) s.text('无');
  for (const m of sum.checkoutByMethod) s.pair(`${methodLabel(m.method)} · ${m.count} 笔`, yuan(m.amount));
  s.pair('结账合计', yuan(sum.checkouts.total), { strong: true });
  if (sum.coupons.length > 0) s.text(`团购：${sum.coupons.map((c) => `${COUPON_PLATFORM_LABELS[c.platform]} ${c.count} 张 ${yuan(c.amount)}`).join('、')}`);
  s.strong(`会员充值 ${sum.recharges.count} 笔`);
  if (sum.recharges.byMethod.length === 0) s.text('无');
  for (const m of sum.recharges.byMethod) s.pair(`${payLabel(m.method)} · ${m.count} 笔`, yuan(m.amount));
  s.pair('充值实收', yuan(sum.recharges.paid), { strong: true }).pair('赠送赠金（不是收款）', yuan(sum.recharges.bonus));
  if (sum.deposits) {
    s.strong('客房押金（不算营业额）');
    for (const m of sum.deposits.received) s.pair(`收 ${payLabel(m.method)} · ${m.count} 笔`, yuan(m.amount));
    for (const m of sum.deposits.refunded) s.pair(`退 ${payLabel(m.method)} · ${m.count} 笔`, yuan(m.amount));
  }
  if (sum.countCards) {
    s.strong('次卡（收款，不算营业额）');
    for (const m of sum.countCards.sales.byMethod) s.pair(`卖 ${payLabel(m.method)} · ${m.count} 笔`, yuan(m.amount));
    for (const m of sum.countCards.refunds.byMethod) s.pair(`退 ${payLabel(m.method)} · ${m.count} 笔`, yuan(m.amount));
  }
  s.text(`会员工作台储值消费 ${sum.walletConsumes.count} 笔 ${yuan(sum.walletConsumes.total)}（不是现金）`);
  s.rule().strong('现金');
  s.pair('备用金', yuan(sum.cash.opening)).pair('+ 结账现金', yuan(sum.cash.checkout)).pair('+ 充值现金', yuan(sum.cash.recharge));
  if (sum.cash.refund) s.pair('− 反结账退现金', yuan(sum.cash.refund));
  if (sum.cash.deposit) s.pair(sum.cash.deposit > 0 ? '+ 押金现金（收 − 退）' : '− 押金现金（退 − 收）', yuan(Math.abs(sum.cash.deposit)));
  if (sum.cash.refundSlip) s.pair('− 退款单退现金', yuan(sum.cash.refundSlip));
  if (sum.cash.memberRefund) s.pair('− 储值退回的现金', yuan(sum.cash.memberRefund));
  if (sum.cash.countCard) s.pair(sum.cash.countCard > 0 ? '+ 次卡现金（卖 − 退）' : '− 次卡现金（退 − 卖）', yuan(Math.abs(sum.cash.countCard)));
  s.pair('= 应有现金', yuan(r.expectedCash ?? sum.cash.expected), { strong: true });
  if (closed && r.countedCash !== null) {
    const diff = r.countedCash - (r.expectedCash ?? sum.cash.expected);
    s.pair('实点现金', yuan(r.countedCash), { strong: true }).pair(diff === 0 ? '长短款' : diff > 0 ? '长款' : '短款', diff === 0 ? '无' : yuan(Math.abs(diff)), { big: true });
    if ((r.expectedCash ?? 0) < 0) s.text(`应有现金为负：反结账退的现金比本班收的多 ${yuan(-(r.expectedCash ?? 0))}，这部分从别的钱箱或保险柜拿出，记成长款，与出钱那个钱箱的短款相抵。`);
  }
  if (sum.voids.length > 0) {
    s.rule().strong(`本班次反结账 ${sum.voids.length} 张${sum.refunds ? ` · 退款 ${yuan(sum.refunds.total)}` : '（提醒）'}`);
    for (const v of sum.voids) s.text(`${v.checkoutNo} ${yuan(v.amount)} · ${v.reason}${v.voidedByName ? ` · ${v.voidedByName}反结账、从本班钱箱退` : ''}`);
    if (sum.refunds) s.text(`退款按原收款方式：${sum.refunds.byMethod.map((m) => `${methodLabel(m.method)} ${yuan(m.amount)}`).join('、')}。现金从本班钱箱退，已从应有现金里扣掉。`);
    else s.text('原单收过的现金不计入应有现金，请核对是否已退还或已重新收取。');
  }
  if (sum.refundSlips) {
    s.rule().strong(`退款单 ${sum.refundSlips.count} 张 · ${yuan(sum.refundSlips.total)}`);
    for (const x of sum.refundSlips.list) {
      const refs = x.refs.filter((f) => f.method !== 'cash').map((f) => ` · ${payLabel(f.method)} ${f.ref}`).join('');
      s.text(`${x.refundNo}（原单 ${x.checkoutNo}）${yuan(x.amount)} · ${x.reason}${x.operatorName ? ` · ${x.operatorName}从本班钱箱退` : ''}${refs}`);
    }
  }
  if (sum.memberRefunds) {
    s.rule().strong(`储值退回 ${sum.memberRefunds.count} 张 · ${yuan(sum.memberRefunds.total)}`);
    for (const x of sum.memberRefunds.list) s.text(`${x.refundNo} ${x.memberName} ${yuan(x.amount)} · ${x.reason}${x.operatorName ? ` · ${x.operatorName}从本班钱箱退` : ''}`);
  }
  if (r.note) s.text(`备注：${r.note}`);
  s.rule().sign('交班人签字').sign('接班人签字', r.handedToName);
  return s.footer().bytes();
}

// ───────────────────────── 日结单（80mm 汇总） ─────────────────────────

/** 实收合计按收款方式：充值 + 结账 − 退款单（与日结页、A4 日结单同一算法） */
export function receivedRows(s: SettlementSummary) {
  const rows = PAYMENT_METHODS.map((m) => {
    const recharge = s.recharge.byMethod.find((x) => x.method === m)?.amount ?? 0;
    const checkout = s.business.byMethod.find((x) => x.method === m)?.amount ?? 0;
    const refund = s.business.refunds?.byMethod.find((x) => x.method === m)?.amount ?? 0;
    return { method: m, recharge, checkout, refund, total: recharge + checkout - refund };
  }).filter((r) => r.recharge || r.checkout || r.refund);
  return { rows, total: rows.reduce((sum, r) => sum + r.total, 0) };
}

export function buildSettlementSlip(st: SettlementSummary, meta: SlipMeta): Buffer {
  const s = new Slip(meta).header('日 结 单');
  const tz = meta.timeZone;
  const b = st.business;
  const biz = businessBreakdown(b);
  const failed = st.checks.filter((c) => !c.ok);
  const d = describeDate(st.businessDate);
  s.p.align(1);
  s.text(`营业日 ${st.businessDate}（${d.weekday}）`);
  s.p.align(0);
  const status = st.closed
    ? st.closed.changedSinceClose
      ? `已确认日结（第 ${st.closed.revision} 次，${st.closed.closedByName} ${slipStamp(st.closed.closedAt, tz)}）· 确认后又有新的业务，需重新确认`
      : `已确认日结 · ${st.closed.closedByName} ${slipStamp(st.closed.closedAt, tz)}（第 ${st.closed.revision} 次）`
    : st.isToday
      ? '未确认日结 · 营业日尚未结束，是截至出单时的数'
      : '未确认日结';
  s.strong(status);
  if (st.closed?.note) s.text(`日结备注：${st.closed.note}`);
  s.strong(failed.length ? `✗ ${failed.length} 项核对不一致（见下方）` : `✓ ${st.checks.length} 项核对全部一致`);

  s.rule().strong('营业口径 · 前台结账');
  s.pair(`结账 ${b.checkouts.count} 张`, yuan(b.checkouts.total));
  if (b.voids.count > 0) s.pair(`反结账 ${b.voids.count} 张`, yuan(-b.voids.total));
  s.pair('应收（结账 − 反结账）', yuan(biz.receivable), { strong: true });
  s.pair('优惠 / 免单', yuan(-biz.discount));
  if (biz.coupon !== 0) s.pair('券抵扣', yuan(-biz.coupon));
  if (biz.memberDiscount !== 0) s.pair('会员折扣', yuan(-biz.memberDiscount));
  if (biz.refund !== 0) s.pair(`退款（退款单 ${b.refunds?.count ?? 0} 张）`, yuan(-biz.refund));
  s.pair('净营业额', yuan(biz.netRevenue), { strong: true });
  s.pair('实收（减去退款）', yuan(biz.received));
  s.pair('其中门票', yuan(b.ticket)).pair('其中项目与其他', yuan(b.items));
  s.strong('收款方式');
  if (b.byMethod.length === 0) s.text('无');
  for (const m of b.byMethod) s.pair(`${methodLabel(m.method)} · ${m.count} 笔${m.voidCount ? `，反结账 ${m.voidCount}` : ''}`, yuan(m.amount));
  for (const c of b.coupons) s.text(`团购 ${COUPON_PLATFORM_LABELS[c.platform]} ${c.count} 张 ${yuan(c.amount)}${c.voidCount ? `（作废 ${c.voidCount} 张）` : ''}`, 2);

  const received = receivedRows(st);
  s.rule().strong('实收合计 · 充值 + 结账 − 退款');
  if (received.rows.length === 0) s.text('无');
  for (const r of received.rows) s.pair(payLabel(r.method), yuan(r.total));
  s.pair('合计', yuan(received.total), { strong: true });

  s.rule().strong('会员储值');
  s.pair(`充值实收 · ${st.recharge.count} 笔`, yuan(st.recharge.paid), { strong: true });
  s.pair('赠送赠金（不是收款）', yuan(st.recharge.bonus));
  s.pair(`储值消费 · ${st.consume.count} 笔${st.consume.reversedCount ? `（已撤销 ${st.consume.reversedCount}）` : ''}`, yuan(st.consume.total));
  if (st.memberRefund.count > 0) s.pair(`储值退回 · ${st.memberRefund.count} 张（退本金）`, `-${yuan(st.memberRefund.principal)}`);
  s.pair('期末本金 / 赠金', `${yuan(st.balances.closing.principal)} / ${yuan(st.balances.closing.bonus)}`);

  if (st.deposits && (st.deposits.received.length > 0 || st.deposits.refunded.length > 0 || st.deposits.held !== 0)) {
    s.rule().strong('客房押金（负债，不算营业额）');
    for (const m of st.deposits.received) s.pair(`收 ${payLabel(m.method)} · ${m.count} 笔`, yuan(m.amount));
    for (const m of st.deposits.refunded) s.pair(`退 ${payLabel(m.method)} · ${m.count} 笔`, yuan(-m.amount));
    s.pair('当天结束时在住押金', yuan(st.deposits.held), { strong: true });
  }
  const cc = st.countCards;
  if (cc && (cc.sales.count || cc.refunds.count || cc.uses.count)) {
    s.rule().strong('次卡（卖卡是收款，用卡算营业额）');
    if (cc.sales.count) s.pair(`卖卡 ${cc.sales.count} 张`, yuan(cc.sales.amount));
    if (cc.refunds.count) s.pair(`退卡 ${cc.refunds.count} 张`, yuan(-cc.refunds.amount));
    if (cc.uses.count) s.pair(`结账使用 ${cc.uses.count} 次`, yuan(cc.uses.amount));
  }
  const pr = st.platformRedemptions;
  if (pr && (pr.count || pr.voidCount)) {
    s.rule().strong('平台核销补录（不结账，不算营业额）');
    s.pair(`补登记 ${pr.count} 张${pr.voidCount ? `，作废 ${pr.voidCount}` : ''}`, yuan(pr.face));
    s.pair('平台应结', yuan(pr.settle));
  }
  if (failed.length > 0) {
    s.rule().strong('核对不一致');
    for (const c of failed) s.text(`✗ ${c.label}：${c.detail}`);
  }
  s.rule().text(`异常与提醒 ${st.anomalies.length} 条${st.anomalies.length ? '（明细见日结页或 A4 日结单）' : ''}`);
  s.rule().sign('日结人', st.closed?.closedByName).sign('值班经理');
  return s.footer().bytes();
}
