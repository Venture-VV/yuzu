// 登记报销页的两块（8.0.3，docs/BUDGET_INVOICES.md）：
//   · 预算提示：这个部门这个月各科目的额度、已占用，这张报完剩多少 / 超了多少（超了不拦，要多一级店主审批）；
//   · 发票台账：专票、普票按号码在台账里找——有就关联（好几张时选一张），挂在别的报销单上、在三单匹配里的提示不能报；
//     没有的会自动登记进台账，开票方、开票日、税额可以在这里填（不填的开票方记未填、开票日按支出日期、税额按税点算）。

import { CircleAlert, FileCheck2 } from 'lucide-react';
import { budgetLevel, type BudgetLevel } from '@shared/budgets';
import { EXPENSE_CATEGORY_LABELS, taxRateText, type ExpenseCategory } from '@shared/expenses';
import { expectedTaxCents, normalizeInvoiceNo } from '@shared/invoices';
import { formatAmount } from '@shared/money';
import { cn } from '../../lib/utils';
import { Field, Input, MoneyInput, Notice } from '../../components/ui';
import { useInvoiceLookup } from '../invoices/queries';
import { useBudgetUsage } from './queries';

const LEVEL_TEXT: Record<BudgetLevel, string> = { none: 'text-ink-3', ok: 'text-ink-2', warn: 'text-yuzu-deep', over: 'font-semibold text-clay' };

/** 这张报销各科目的金额 */
export type CategoryAmounts = Partial<Record<ExpenseCategory, number>>;

export function BudgetHint({ departmentId, expenseDate, amounts }: { departmentId: number | null; expenseDate: string; amounts: CategoryAmounts }) {
  const usage = useBudgetUsage(departmentId, expenseDate);
  if (!usage.data) return null;
  const rows = usage.data.cells.filter((c) => c.budgetCents !== null);
  if (rows.length === 0) return null;
  const items = rows.map((c) => {
    const claim = amounts[c.category] ?? 0;
    const after = c.usedCents + claim;
    return { c, claim, after, level: budgetLevel(c.budgetCents, after, usage.data!.warnPercent) };
  });
  const over = items.filter((i) => i.claim > 0 && i.level === 'over');
  return (
    <section className="rounded-lg border border-line bg-card p-4 shadow-card" data-testid="claim-budget">
      <h2 className="mb-2 text-[13.5px] font-bold">本月预算（{usage.data.month}）</h2>
      <ul className="grid gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
        {items.map(({ c, claim, after, level }) => (
          <li key={c.category} className={cn(LEVEL_TEXT[level])} data-testid={`claim-budget-${c.category}`} data-level={level}>
            {EXPENSE_CATEGORY_LABELS[c.category]}：额度 ¥{formatAmount(c.budgetCents!)}，已占用 ¥{formatAmount(c.usedCents)}
            {claim > 0 && (
              <>
                ，这张 ¥{formatAmount(claim)}，
                {after > c.budgetCents! ? `超出 ¥${formatAmount(after - c.budgetCents!)}` : `报完剩 ¥${formatAmount(c.budgetCents! - after)}`}
              </>
            )}
          </li>
        ))}
      </ul>
      {over.length > 0 && (
        <Notice tone="warning" title="这张报销会超预算：照常登记，但要走「超预算报销」审批（在原来的审批后面多一级店主）" className="mt-3" data-testid="claim-over-budget" />
      )}
    </section>
  );
}

/** 这张报销会不会超预算（登记页底部的提示用，与 BudgetHint 同一个查询） */
export function useClaimOverBudget(departmentId: number | null, expenseDate: string, amounts: CategoryAmounts): boolean {
  const usage = useBudgetUsage(departmentId, expenseDate);
  return (usage.data?.cells ?? []).some((c) => {
    const claim = amounts[c.category] ?? 0;
    return c.budgetCents !== null && claim > 0 && c.usedCents + claim > c.budgetCents;
  });
}

export interface InvoiceExtras {
  invoiceId: number | null;
  issuer: string;
  date: string;
  tax: string;
}

/**
 * 发票台账：按号码在台账里找。onChange 给出选中的台账发票（好几张时要选）、开票方、开票日、税额。
 * 返回值 blocking：这张发票不能报（已报销、在三单匹配里），或者好几张还没选。
 */
export function InvoiceLedgerFields({
  invoiceNo,
  kindLabel,
  taxRateBp,
  totalCents,
  supplierName,
  expenseDate,
  today,
  value,
  onChange,
  disabled,
}: {
  invoiceNo: string;
  kindLabel: string;
  taxRateBp: number | null;
  totalCents: number;
  /** 按采购单报销的：开票方就是采购单的供应商 */
  supplierName: string | null;
  expenseDate: string;
  today: string;
  value: InvoiceExtras;
  onChange: (v: InvoiceExtras) => void;
  disabled: boolean;
}) {
  const no = invoiceNo.trim();
  const lookup = useInvoiceLookup(no, true);
  const issuer = (supplierName ?? value.issuer).trim().toLowerCase();
  const matches = (lookup.data ?? []).filter((m) => normalizeInvoiceNo(m.invoiceNo) === normalizeInvoiceNo(no));
  const narrowed = issuer ? matches.filter((m) => m.issuerName.trim().toLowerCase() === issuer || !m.issuerName.trim()) : matches;
  const chosen = narrowed.find((m) => m.id === value.invoiceId) ?? (narrowed.length === 1 ? narrowed[0] : null);
  const computedTax = taxRateBp !== null && totalCents > 0 ? expectedTaxCents(totalCents, taxRateBp) : null;
  return (
    <div className="space-y-3 sm:col-span-2 lg:col-span-4" data-testid="claim-invoice-ledger">
      {chosen ? (
        chosen.usedBy || chosen.inPayables ? (
          <Notice tone="error" title={chosen.usedBy ? `这张发票已在报销单 ${chosen.usedBy} 里，同一张发票不能报销两次` : '这张发票已在三单匹配里分到采购单（走货款付款），不能再报销'} data-testid="claim-invoice-blocked" />
        ) : (
          <Notice tone="info" icon={<FileCheck2 className="size-4" />} title={`台账里已有这张${chosen.kindLabel}：${chosen.issuerName || '开票方未填'} · ${chosen.invoiceDate} · ¥${formatAmount(chosen.totalCents)}，提交后直接关联`} data-testid="claim-invoice-found">
            {chosen.totalCents !== totalCents && totalCents > 0 && <span className="text-[12.5px] text-clay">报销金额与发票金额不一样，会在台账里标「与报销金额不符」</span>}
          </Notice>
        )
      ) : narrowed.length > 1 ? (
        <Field label={`台账里有 ${narrowed.length} 张号码是 ${no} 的发票，请选是哪一张`} htmlFor="ex-inv-pick">
          <select
            id="ex-inv-pick"
            className="h-10 w-full rounded-md border border-line bg-card px-3 text-[14px]"
            value={value.invoiceId ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, invoiceId: Number(e.target.value) || null })}
            data-testid="ex-invoice-pick"
          >
            <option value="">选择发票</option>
            {narrowed.map((m) => (
              <option key={m.id} value={m.id}>
                {m.issuerName || '开票方未填'} · {m.invoiceDate} · ¥{formatAmount(m.totalCents)}
                {m.usedBy ? `（已在 ${m.usedBy}）` : m.inPayables ? '（在三单匹配里）' : ''}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <p className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
            <CircleAlert className="size-3.5" />
            {no ? `台账里还没有这张${kindLabel}，提交后自动登记进台账` : `${kindLabel}会进进项发票台账`}
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {supplierName ? (
              <Field label="开票方">
                <Input value={supplierName} disabled className="h-10" />
              </Field>
            ) : (
              <Field label="开票方" htmlFor="ex-inv-issuer" hint="发票上的销售方名称（不填记「未填」）">
                <Input id="ex-inv-issuer" value={value.issuer} maxLength={60} disabled={disabled} onChange={(e) => onChange({ ...value, issuer: e.target.value })} className="h-10" data-testid="ex-invoice-issuer" />
              </Field>
            )}
            <Field label="开票日" htmlFor="ex-inv-date" hint="不填按支出日期">
              <Input id="ex-inv-date" type="date" value={value.date} max={today} disabled={disabled} onChange={(e) => onChange({ ...value, date: e.target.value })} placeholder={expenseDate} className="h-10" data-testid="ex-invoice-date" />
            </Field>
            <Field label="税额" htmlFor="ex-inv-tax" hint={computedTax !== null ? `不填按税点 ${taxRateText(taxRateBp!)} 算：¥${formatAmount(computedTax)}` : '不填按税点算'}>
              <MoneyInput id="ex-inv-tax" value={value.tax} disabled={disabled} onChange={(e) => onChange({ ...value, tax: e.target.value })} className="h-10" data-testid="ex-invoice-tax" />
            </Field>
          </div>
        </>
      )}
    </div>
  );
}

/** 发票这一块挡不挡提交 */
export function invoiceBlocking(
  matches: { id: number; issuerName: string; usedBy: string | null; inPayables: boolean; invoiceNo: string }[] | undefined,
  invoiceNo: string,
  issuerName: string,
  invoiceId: number | null,
): string | null {
  const no = normalizeInvoiceNo(invoiceNo.trim());
  if (!no || !matches) return null;
  const issuer = issuerName.trim().toLowerCase();
  const same = matches.filter((m) => normalizeInvoiceNo(m.invoiceNo) === no);
  const narrowed = issuer ? same.filter((m) => m.issuerName.trim().toLowerCase() === issuer || !m.issuerName.trim()) : same;
  const chosen = narrowed.find((m) => m.id === invoiceId) ?? (narrowed.length === 1 ? narrowed[0] : null);
  if (!chosen && narrowed.length > 1) return '台账里有好几张这个号码的发票，请选是哪一张';
  if (chosen?.usedBy) return `发票已在报销单 ${chosen.usedBy} 里，不能报销两次`;
  if (chosen?.inPayables) return '这张发票在三单匹配里（走货款付款），不能再报销';
  return null;
}
