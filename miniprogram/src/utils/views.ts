// 列表上一行显示的字：流水、券。数字由门店系统给，这里只排版。
import type { MpCoupon, MpLedgerRow } from '../../../src/shared/mp';
import { shopTime, yuan } from './format';

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

export function ledgerRow(r: MpLedgerRow): LedgerView {
  const total = r.principalDelta + r.bonusDelta;
  let split = '';
  if (r.principalDelta && r.bonusDelta) split = '本金 ' + yuan(r.principalDelta, true) + ' · 赠金 ' + yuan(r.bonusDelta, true);
  else if (r.bonusDelta) split = '赠金';
  return {
    id: r.id,
    title: r.kindLabel,
    when: r.businessDate + ' ' + shopTime(r.createdAt),
    summary: r.summary,
    amount: yuan(total, true),
    pos: total > 0,
    split,
    after: '余额 ' + yuan(r.principalAfter + r.bonusAfter),
  };
}


const KIND_LABELS: Record<string, string> = { cash: '代金券', discount: '折扣券', exchange: '兑换券' };
const STATE_LABELS: Record<string, string> = { available: '可用', pending: '还没生效', expired: '已过期', used: '已使用', voided: '已作废' };

export interface CouponView {
  code: string;
  name: string;
  /** 券面上大字：¥50、8.8 折、兑换 */
  big: string;
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

export function couponView(c: MpCoupon): CouponView {
  // 门店系统给的一句话说明：「代金券 ¥50.00 · 满 ¥200.00 可用 · 限门票」「8.8 折 · 最多减 ¥30.00」「兑换 搓澡 1 份」
  const parts = c.summary.split(' · ');
  const head = parts[0] || '';
  let big = KIND_LABELS[c.kind] || '券';
  let terms = parts.slice(1);
  if (c.kind === 'cash' && /^代金券 /.test(head)) big = head.replace(/^代金券 /, '').replace(/\.00$/, '');
  else if (c.kind === 'discount' && /折$/.test(head)) big = head;
  else if (c.kind === 'exchange') {
    big = '兑换';
    terms = [head].concat(terms);
  }
  return {
    code: couponCode(c.code),
    name: c.name,
    big,
    kind: KIND_LABELS[c.kind] || '',
    terms: terms.join(' · ').replace(/\.00(?=\D|$)/g, ''),
    valid: c.validFrom === c.validTo ? c.validTo + ' 当天有效' : c.validFrom + ' 至 ' + c.validTo,
    state: c.state,
    stateLabel: STATE_LABELS[c.state] || c.state,
    usable: c.state === 'available',
  };
}
