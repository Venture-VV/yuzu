// 结账单（页面上的那一份）：结账完成的确认页、「结账记录」里的结账单详情、桌台结账的完成页、
// 「流水」里的订单详情（8.1.17 BW-12）都用这一个部件——抬头（单号、时间、收银）、所结手牌（桌台）与门票、
// 「优惠与赠送」一栏（每笔写经办人：发放、授权、渠道）、收款与合计。
// 带着逐行明细的（「流水」取的是打印的那一份，每张手牌下面有结账那一刻的明细）在每张手牌下面列出明细，
// 被签赠、券、会员折扣抵到的行标「赠」「券」「折」（与 80mm 小票同一个标法），「流水」另带所属部门与摊到这一行的优惠。
// 8.1.17 从 CheckoutDialog.tsx 搬出来单放：「流水」只引这一个文件，不连带结账对话框。

import { Fragment, type ReactNode } from 'react';
import { Gift, ReceiptText, Undo2 } from 'lucide-react';
import { minutesText } from '@shared/benefits';
import { CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS, PERK_KIND_LABELS, PERK_MARKS, perkOperatorsText, perksTotal, type CheckoutDetail, type CheckoutPerk, type PerkKind } from '@shared/checkout';
import { formatYuan } from '@shared/money';
import type { CheckoutPrintLine, WalletBalance } from '@shared/print';
import { formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge, Notice } from '../../components/ui';

/** 结账单结的是餐饮桌台（S5 第二步）：反结账后恢复的是桌台，不是在店客人 */
export const isTableCheckout = (d: Pick<CheckoutDetail, 'bills'>) => d.bills.some((b) => b.tableSessionId !== null);

/** 一笔优惠 / 赠送：类别、名称、减了多少，下面一行是说明与经办人（发放、授权、渠道） */
export function PerkRow({ perk }: { perk: CheckoutPerk }) {
  const sub = [perk.name ? perk.detail : '', perkOperatorsText(perk)].filter(Boolean).join(' · ');
  return (
    <div data-testid={`checkout-perk-${perk.kind}`}>
      <p className="flex items-baseline gap-2">
        <Badge tone={perk.kind === 'gift' ? 'yuzu' : perk.kind === 'discount' ? 'clay' : 'pine'}>{PERK_KIND_LABELS[perk.kind]}</Badge>
        <span className="min-w-0 flex-1 truncate font-semibold">{perk.name || perk.detail}</span>
        <span className="num shrink-0 font-bold">
          −<Money cents={perk.amount} />
        </span>
      </p>
      {sub && <p className="mt-0.5 text-[12px] break-all text-ink-3">{sub}</p>}
    </div>
  );
}

/** 行上的标记：赠（签赠，柚黄）、券（券抵扣，湖蓝）、折（会员折扣，松绿）；颜色之外都写着字 */
const MARK_TONE: Record<PerkKind, 'yuzu' | 'lake' | 'pine' | 'clay'> = { gift: 'yuzu', coupon: 'lake', member_discount: 'pine', discount: 'clay' };

export function PerkMarks({ perks }: { perks: readonly PerkKind[] }) {
  if (perks.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 gap-1 align-middle" data-testid="receipt-line-marks">
      {perks.map((k) => (
        <span key={k} title={PERK_KIND_LABELS[k]} aria-label={`${PERK_KIND_LABELS[k]}抵到这一行`}>
          <Badge tone={MARK_TONE[k]}>{PERK_MARKS[k]}</Badge>
        </span>
      ))}
    </span>
  );
}

/** 结账那一刻的一行明细（打印的那一份）；「流水」另带所属部门与摊到这一行的优惠 */
export type ReceiptLine = CheckoutPrintLine;
type ReceiptBill = CheckoutDetail['bills'][number] & { lines?: ReceiptLine[] };
type ReceiptPayment = CheckoutDetail['payments'][number] & { balance?: { before: WalletBalance; after: WalletBalance } | null };
/** 结账单详情（frontdesk 的结账单），或带逐行明细与储值余额的打印那一份（「流水」） */
export type ReceiptDetail = Omit<CheckoutDetail, 'bills' | 'payments'> & { bills: ReceiptBill[]; payments: ReceiptPayment[] };

/** 一张手牌（桌台）下面的明细：名称与标记、技师、所属部门、数量 × 单价、金额、摊到的优惠 */
function BillLines({ lines }: { lines: ReceiptLine[] }) {
  if (lines.length === 0) return <p className="text-[12px] text-ink-3">没有消费明细（免票）</p>;
  return (
    <ul className="divide-y divide-line/60" data-testid="receipt-lines">
      {lines.map((l) => (
        <li key={l.id} className="flex items-start gap-3 py-1.5" data-testid="receipt-line" data-perks={l.perks.join(',')}>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="font-semibold break-words">{l.name}</span>
              <PerkMarks perks={l.perks} />
            </p>
            <p className="text-[12px] text-ink-3">{[l.category, `${l.quantity} × ${formatYuan(l.unitPrice)}`, l.technician].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="shrink-0 text-right">
            <Money cents={l.amount} className="font-bold" />
            {(l.discount ?? 0) > 0 && (
              <p className="text-[12px] text-ember-deep">
                优惠 <Money cents={-(l.discount ?? 0)} />
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

const yuan = formatYuan;

/** 一笔收款的说明：储值写会员与消费单（本金 / 赠金），团购写平台与券码，别的写备注 */
function tenderText(pm: ReceiptPayment): string {
  if (pm.method === 'wallet' && pm.consumption) {
    return `${pm.memberName ?? ''} · ${pm.consumption.docNo} · 本金 ${yuan(pm.consumption.principal)} / 赠金 ${yuan(pm.consumption.bonus)}${pm.consumption.status === 'reversed' ? '（已撤销）' : ''}`;
  }
  if (pm.method === 'coupon' && pm.coupon) {
    return `${COUPON_PLATFORM_LABELS[pm.coupon.platform]} ${pm.coupon.code}${pm.coupon.dealName ? ` · ${pm.coupon.dealName}` : ''}${pm.coupon.status === 'voided' ? '（已作废）' : ''}`;
  }
  return pm.ref;
}

/**
 * 结账单。showLines 为 false 时不列逐行明细（「流水」里按项目快照显示的那种单，逐行另列）；
 * footer 放在合计下面（「流水」的营业日、退款单、打印）
 */
export function CheckoutReceipt({ detail, showLines = true, footer }: { detail: ReceiptDetail; showLines?: boolean; footer?: ReactNode }) {
  const perkPayments = new Set(detail.perks.map((k) => k.paymentId));
  const tenders = detail.payments.filter((pm) => !perkPayments.has(pm.id));
  return (
    <div className="space-y-3" data-testid="checkout-receipt">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <ReceiptText className="size-4" />
        <span className="num font-semibold text-ink-2">{detail.checkoutNo}</span>
        <span data-testid="checkout-receipt-operator">
          {formatDateTime(detail.createdAt)} · 收银 {detail.operatorName}
        </span>
        {detail.status === 'voided' && <Badge tone="clay">已反结账</Badge>}
        {detail.backfill && (
          <span data-testid="checkout-backfill">
            <Badge tone="lake">补录 · 纸质单 {detail.backfill.slipNo}</Badge>
          </span>
        )}
      </div>
      {detail.backfill && (
        <p className="text-[12px] text-ink-3">
          按纸质单上的实际时间结账：{detail.backfill.enteredByName}于 {formatDateTime(detail.backfill.enteredAt)} 补录。
        </p>
      )}
      {detail.status === 'voided' && (
        <Notice tone="warning" icon={<Undo2 className="size-4" />} title={`${detail.voidedByName ?? ''} 于 ${detail.voidedAt ? formatDateTime(detail.voidedAt) : ''} 反结账`}>
          {detail.voidReason}。储值消费已按原单撤销，团购券登记已作废，{isTableCheckout(detail) ? '这几桌恢复为用餐中' : '客人恢复为在店未结'}。
        </Notice>
      )}
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-[13px]">
          <thead className="bg-paper-2 text-[12px] text-ink-3">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">手牌</th>
              <th className="px-3 py-2 text-left font-semibold">门票</th>
              <th className="px-3 py-2 text-right font-semibold">金额</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {detail.bills.map((b) => (
              <Fragment key={b.billId}>
                <tr data-testid="checkout-bill">
                  <td className="px-3 py-2">
                    <span className="num font-bold">{b.tableName !== null ? `桌 ${b.tableName}` : b.tagCode}</span>{' '}
                    <span className="text-ink-3">
                      {b.memberName ?? (b.guestLabel || '散客')}
                      {b.tableName !== null && ` · ${b.guests} 人`}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-ink-2">
                    {b.ticketName !== null && (
                      <>
                        {b.ticketName} · {b.ticketSegments === 1 ? '12 小时档' : `${b.ticketSegments} 段`} <Money cents={b.ticketAmount ?? 0} className="text-ink-3" />
                      </>
                    )}
                    <span className="block text-[12px] text-ink-3">
                      {b.tableName !== null ? '用餐' : '在店'} {Math.floor(b.stayMinutes / 60)} 时 {b.stayMinutes % 60} 分
                      {b.ticketExtensionMinutes > 0 && ` · 会员浴票延迟 ${minutesText(b.ticketExtensionMinutes)}`}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={b.amount} className="font-bold" />
                  </td>
                </tr>
                {showLines && b.lines && (
                  <tr data-testid="checkout-bill-lines">
                    <td colSpan={3} className="bg-paper/40 px-3 pt-0.5 pb-2">
                      <BillLines lines={b.lines} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {/* 优惠与赠送（8.1.15）：签赠、券、会员折扣、优惠 / 免单各一笔，写明经办人；下面只列真收的钱与预付抵扣 */}
        {detail.perks.length > 0 && (
          <div className="space-y-1.5 border-t border-line bg-yuzu-soft/40 px-3 py-2.5 text-[13px]" data-testid="checkout-perks">
            <p className="flex items-center gap-1 text-[12px] font-bold text-ink-3">
              <Gift className="size-3.5" /> 优惠与赠送
            </p>
            {detail.perks.map((k) => (
              <PerkRow key={k.paymentId} perk={k} />
            ))}
            <p className="flex items-baseline justify-between border-t border-dashed border-line pt-1.5">
              <span className="font-semibold">共优惠</span>
              <Money cents={perksTotal(detail.perks)} className="font-bold text-yuzu-deep" />
            </p>
          </div>
        )}
        <div className="space-y-1 border-t border-line bg-paper/60 px-3 py-2.5 text-[13px]" data-testid="checkout-tenders">
          {tenders.length === 0 && <p className="text-ink-3">{detail.perks.length > 0 ? '优惠后应付为 0，未收款' : '应收为 0，未收款'}</p>}
          {tenders.map((pm) => (
            <div key={pm.id}>
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold">{CHECKOUT_METHOD_LABELS[pm.method]}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{tenderText(pm)}</span>
                <Money cents={pm.amount} className="font-bold" />
              </p>
              {pm.balance && (
                <p className="text-[12px] text-ink-3">
                  储值余额：扣前 本金 {yuan(pm.balance.before.principal)} / 赠金 {yuan(pm.balance.before.bonus)} → 扣后 本金 {yuan(pm.balance.after.principal)} / 赠金 {yuan(pm.balance.after.bonus)}
                </p>
              )}
            </div>
          ))}
          <p className="flex items-baseline justify-between border-t border-dashed border-line pt-1.5">
            <span className="font-bold">合计</span>
            <span data-testid="checkout-receipt-total">
              <Money cents={detail.totalAmount} className="text-[20px] font-bold text-pine" />
            </span>
          </p>
        </div>
      </div>
      {detail.remainingMates.length > 0 && detail.status === 'completed' && <p className="text-[12.5px] text-ink-3">同行组里还有 {detail.remainingMates.join('、')} 在店，离店时另行结账。</p>}
      {footer}
    </div>
  );
}
