// 会员卡押金的收款 / 退款方式（8.1.15，docs/MEMBERS_V8115.md 第 3 节）：建档选实体卡、发卡、退卡三处共用。
// 金额不让改：收多少是后台设的，退多少是押着的全部；页面只选方式、写备注，服务端按自己算的金额核对。

import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/labels';
import { Money } from '../../components/Money';
import { Field, Input, Select } from '../../components/ui';

export interface DepositPayDraft {
  method: PaymentMethod;
  ref: string;
}

export const EMPTY_DEPOSIT_PAY: DepositPayDraft = { method: 'cash', ref: '' };

/** 还差什么没填（没有问题返回 null）：「其他」方式收的要写明收的是什么；退的时候扫码、银行卡要登记退款单号 */
export function depositPayProblem(d: DepositPayDraft, kind: 'receive' | 'refund'): string | null {
  const ref = d.ref.trim();
  if (kind === 'receive') return d.method === 'other' && ref.length < 2 ? '「其他」方式收的押金请在备注里写明收的是什么' : null;
  if (d.method === 'cash' || ref.length >= 2) return null;
  return d.method === 'other' ? '「其他」方式退的请写明是怎么退的' : `${PAYMENT_METHOD_LABELS[d.method]}退的请登记商户后台的退款单号`;
}

export function CardDepositFields({
  kind,
  amount,
  value,
  onChange,
  disabled,
  error,
}: {
  kind: 'receive' | 'refund';
  amount: number;
  value: DepositPayDraft;
  onChange: (d: DepositPayDraft) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const receive = kind === 'receive';
  const refNeeded = receive ? value.method === 'other' : value.method !== 'cash';
  return (
    <div className="rounded-lg border border-line bg-paper/60 p-3.5" data-testid="card-deposit-fields">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-semibold text-ink-2">{receive ? '实体卡押金' : '退押金'}</span>
        <span data-testid="card-deposit-amount">
          <Money cents={amount} className="text-[18px] font-bold text-ink" />
        </span>
      </p>
      <p className="mt-0.5 text-[12.5px] text-ink-3">{receive ? '押金不进储值、不算营业额；退卡时全额退。现金记进你当班的钱箱。' : '押着的押金全额退。现金从你当班的钱箱退。'}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
        <Field label={receive ? '收款方式' : '退款方式'} htmlFor="card-deposit-method">
          <Select id="card-deposit-method" value={value.method} onChange={(e) => onChange({ ...value, method: e.target.value as PaymentMethod })} disabled={disabled} data-testid="card-deposit-method">
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={receive ? '收款备注' : '退款单号 / 备注'} htmlFor="card-deposit-ref" error={error}>
          <Input
            id="card-deposit-ref"
            value={value.ref}
            onChange={(e) => onChange({ ...value, ref: e.target.value })}
            placeholder={refNeeded ? (receive ? '写明收的是什么（必填）' : value.method === 'other' ? '写明是怎么退的（必填）' : '商户后台的退款单号（必填）') : '选填'}
            maxLength={64}
            disabled={disabled}
            invalid={!!error}
            data-testid="card-deposit-ref"
          />
        </Field>
      </div>
    </div>
  );
}
