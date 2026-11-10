// 列表上一行显示的字：流水、券、本月可享。数字由门店系统给，这里只排版。
import type { MpBenefitItem, MpBenefits, MpCoupon, MpLedgerRow } from '../../../src/shared/mp';
import { shopDateTime, yuan } from './format';

export interface LedgerView {
  id: number;
  title: string;
  when: string;
  summary: string;
  amount: string;
  pos: boolean;
  split: string;
  after: string;
}

function whenOf(r: MpLedgerRow): string {
  const at = shopDateTime(r.createdAt);
  if (!at) return r.businessDate;
  return at.slice(0, 10) === r.businessDate ? at : at + '（营业日 ' + r.businessDate.slice(5) + '）';
}

export function ledgerRow(r: MpLedgerRow): LedgerView {
  const total = r.principalDelta + r.bonusDelta;
  let split = '';
  if (r.principalDelta && r.bonusDelta) split = '本金 ' + yuan(r.principalDelta, true) + ' · 赠金 ' + yuan(r.bonusDelta, true);
  else if (r.bonusDelta) split = '赠金';
  return {
    id: r.id,
    title: r.kindLabel,
    // 记账的日期与时刻都按 createdAt（北京时间）；营业日切换（默认早上 6 点）之前记的，营业日是前一天，另外写出来
    when: whenOf(r),
    summary: r.summary,
    amount: yuan(total, true),
    pos: total > 0,
    split,
    after: '余额 ' + yuan(r.principalAfter + r.bonusAfter),
  };
}


/** 认得的券种类（买一赠一券 bogo 是 8.0.4 起的）；认不得的券面写「券」，说明照门店系统给的整句显示 */
const KIND_LABELS: Record<string, string> = { cash: '代金券', discount: '折扣券', exchange: '兑换券', bogo: '买一赠一券' };
const STATE_LABELS: Record<string, string> = { available: '可用', pending: '还没生效', expired: '已过期', used: '已使用', voided: '已作废' };

export interface CouponView {
  code: string;
  name: string;
  /** 券面上大字：¥50、8.8 折、兑换、买一赠一 */
  big: string;
  /** 大字放不下一行（「买一赠一」、¥100.50 这样长的金额）时小一号 */
  bigLong: boolean;
  kind: string;
  /** 其余条件：满 ¥200 可用 · 限门票 */
  terms: string;
  valid: string;
  state: string;
  stateLabel: string;
  usable: boolean;
}

/** 券码每 4 位一段（与前台打印的一样） */
export const couponCode = (code: string) => code.replace(/(.{4})(?=.)/g, '$1-');

/** 券面左边一行大约放得下 3.6 个汉字宽：汉字算 1 个，数字、字母、符号算 0.6 个 */
const faceWidth = (s: string) => s.split('').reduce((w, ch) => w + (/[㐀-鿿]/.test(ch) ? 1 : 0.6), 0);

/**
 * 券面左边的大字与说明：门店系统给的一句话说明「代金券 ¥50.00 · 满 ¥200.00 可用 · 限门票」「8.8 折 · 最多减 ¥30.00」「兑换 搓澡 1 份」
 * 「买一赠一 · 买 拿铁 送 拿铁 1 份 · 最多抵 ¥30.00」拆成大字（¥50、8.8 折、兑换、买一赠一）与其余的说明（我的券、领券中心共用）。
 * 第一段不是预期的样子、或者认不得这个种类时，大字写种类（认不得写「券」），说明照整句显示，不丢字。
 */
export function couponFace(kind: string, summary: string): { big: string; bigLong: boolean; kind: string; terms: string } {
  const parts = summary.split(' · ');
  const head = parts[0] || '';
  let big = KIND_LABELS[kind] || '券';
  let terms = parts.slice(1);
  if (kind === 'cash' && /^代金券 /.test(head)) big = head.replace(/^代金券 /, '').replace(/\.00$/, '');
  else if (kind === 'discount' && /折$/.test(head)) big = head;
  else if (kind === 'exchange') {
    big = '兑换';
    terms = [head].concat(terms);
  } else if (kind === 'bogo') {
    // 「买 X 送 Y 1 份」与「最多抵」留在说明里
    big = '买一赠一';
    if (head !== '买一赠一') terms = parts;
  } else terms = parts;
  return {
    big,
    bigLong: faceWidth(big) > 3.6,
    kind: KIND_LABELS[kind] || '',
    terms: terms.filter((t) => t !== '').join(' · ').replace(/\.00(?=\D|$)/g, ''),
  };
}

export function couponView(c: MpCoupon): CouponView {
  const face = couponFace(c.kind, c.summary);
  return {
    code: couponCode(c.code),
    name: c.name,
    big: face.big,
    bigLong: face.bigLong,
    kind: face.kind,
    terms: face.terms,
    valid: c.validFrom === c.validTo ? c.validTo + ' 当天有效' : c.validFrom + ' 至 ' + c.validTo,
    state: c.state,
    stateLabel: STATE_LABELS[c.state] || c.state,
    usable: c.state === 'available',
  };
}

// ── 本月可享 ──

export interface BenefitItemView {
  code: string;
  name: string;
  /** 次数与张数：「每月 2 次 · 本月已用 1 次」「每月 1 张 · 能用 1 张」「不限次」 */
  meta: string;
  content: string;
  conditions: string;
}

export interface BenefitsView {
  /** 「11 月」 */
  month: string;
  label: string;
  groups: { key: string; title: string; en: string; items: BenefitItemView[] }[];
  upcoming: { name: string; start: string }[];
  /** 有券类或礼遇：页面上给「我的券」的入口 */
  hasCoupons: boolean;
}

const BENEFIT_GROUPS: [MpBenefitItem['category'], string, string][] = [
  ['service', '服务与资格', 'Services'],
  ['coupon', '每期的券', 'Coupons'],
  ['event', '礼遇', 'Gifts'],
  ['discount', '折扣', 'Discounts'],
  ['extension', '浴票延迟', 'Extra Time'],
  ['info', '说明', 'Notes'],
];
const PERIOD_NOW: Record<string, string> = { day: '今天', month: '本月', year: '今年' };

export function benefitMeta(i: MpBenefitItem): string {
  if (i.category === 'service') {
    if (i.limit !== null && PERIOD_NOW[i.period]) return `${i.allowance} · ${PERIOD_NOW[i.period]}已用 ${i.used || 0} 次`;
    return i.used ? `${i.allowance} · 本月用了 ${i.used} 次` : i.allowance;
  }
  if (i.category === 'coupon' || i.category === 'event') return i.available > 0 ? `${i.allowance} · 能用 ${i.available} 张` : i.allowance;
  return i.allowance;
}

export function benefitsView(b: MpBenefits): BenefitsView {
  const groups = BENEFIT_GROUPS.map(([key, title, en]) => ({
    key,
    title,
    en,
    items: b.items.filter((i) => i.category === key).map((i) => ({ code: i.code, name: i.name, meta: benefitMeta(i), content: i.content, conditions: i.conditions })),
  })).filter((g) => g.items.length > 0);
  return {
    month: `${Number(b.month.slice(5, 7))} 月`,
    label: b.label,
    groups,
    upcoming: b.upcoming.map((u) => ({ name: u.name, start: `${u.startLabel} 起` })),
    hasCoupons: b.items.some((i) => i.category === 'coupon' || i.category === 'event'),
  };
}
