import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/labels';
import { parseYuan } from '@shared/money';
import { ROOM_KIND_LABELS, type RoomKind } from '@shared/rooms';
import { Input, MoneyInput, Select } from '../../components/ui';

/** 住客的叫法：手牌上登记的会员、入住时的称呼，都没有时写手牌号 */
export const guestOf = (s: { memberName: string | null; guestLabel: string; tagCode?: string | null }) =>
  s.memberName ?? (s.guestLabel || (s.tagCode ? `手牌 ${s.tagCode}` : '散客'));

/** 「¥288 / 晚」「¥98 / 段（3 小时）」 */
export function rateText(kind: RoomKind, price: number, blockMinutes: number | null) {
  const yuan = `¥${(price / 100).toFixed(2).replace(/\.00$/, '')}`;
  if (kind === 'daily') return `${yuan} / 晚`;
  const m = blockMinutes ?? 180;
  return `${yuan} / 段（${m % 60 === 0 ? `${m / 60} 小时` : `${m} 分钟`}）`;
}

export const kindLabel = (kind: RoomKind) => ROOM_KIND_LABELS[kind];

/** 押金的一笔：收款方式、金额、备注（「其他」必须写明） */
export interface DepositDraft {
  method: PaymentMethod;
  amount: string;
  ref: string;
}

export function depositProblem(d: DepositDraft, opts: { required: boolean }): string | null {
  const cents = parseYuan(d.amount);
  if (!d.amount.trim()) return opts.required ? '请填写押金金额' : null;
  if (cents === null || cents <= 0) return '押金金额不正确';
  if (d.method === 'other' && !d.ref.trim()) return '「其他」收款请在备注里写明收的是什么';
  return null;
}

export function DepositFields({ value, onChange, disabled, label = '押金' }: { value: DepositDraft; onChange: (d: DepositDraft) => void; disabled?: boolean; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="deposit-fields">
      <Select
        fullWidth={false}
        value={value.method}
        onChange={(e) => onChange({ ...value, method: e.target.value as PaymentMethod })}
        disabled={disabled}
        className="h-10 w-[120px]"
        aria-label={`${label}的收款方式`}
        data-testid="deposit-method"
      >
        {PAYMENT_METHODS.map((m) => (
          <option key={m} value={m}>
            {PAYMENT_METHOD_LABELS[m]}
          </option>
        ))}
      </Select>
      <div className="w-[140px]">
        <MoneyInput value={value.amount} onChange={(e) => onChange({ ...value, amount: e.target.value })} disabled={disabled} aria-label={`${label}金额`} className="h-10" data-testid="deposit-amount" />
      </div>
      <Input
        fullWidth={false}
        value={value.ref}
        onChange={(e) => onChange({ ...value, ref: e.target.value })}
        placeholder={value.method === 'other' ? '写明收的是什么（必填）' : '单号后几位（选填）'}
        maxLength={64}
        disabled={disabled}
        className="h-10 min-w-0 flex-1 basis-32"
        aria-label={`${label}备注`}
      />
    </div>
  );
}
