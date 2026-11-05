// 法务审查清单（v0.7.31，C3）：法务那一级逐条给结论（通过 / 要修改 / 风险提示）。
// 同意时 10 条都要给结论、不能有「要修改」，「风险提示」要写意见；退回时可以只填有问题的几条（「要修改」「风险提示」要写意见）。
// 审批中心的详情（手机上整屏）与合同详情的审批对话框共用。

import { CheckCheck } from 'lucide-react';
import { LEGAL_CHECKLIST, LEGAL_ITEM_KEYS, REVIEW_VERDICTS, REVIEW_VERDICT_LABELS, type LegalItemKey, type ReviewItem, type ReviewVerdict } from '@shared/contracts';
import { cn } from '../../lib/utils';
import { Button, Input } from '../../components/ui';

export type ChecklistDraft = Partial<Record<LegalItemKey, { verdict: ReviewVerdict; note: string }>>;

/** 同意、退回之前的核对（与服务端一致）；没问题返回 null */
export function checklistProblem(d: ChecklistDraft, action: 'approve' | 'return'): string | null {
  const given = LEGAL_ITEM_KEYS.filter((k) => d[k]);
  if (action === 'approve') {
    if (given.length < LEGAL_ITEM_KEYS.length) return `审查清单还有 ${LEGAL_ITEM_KEYS.length - given.length} 条没给结论`;
    if (given.some((k) => d[k]!.verdict === 'revise')) return '有「要修改」的条目不能同意，请退回并写明要改什么';
    if (given.some((k) => d[k]!.verdict === 'risk' && d[k]!.note.trim().length < 2)) return '「风险提示」的条目请写意见（至少 2 个字）';
    return null;
  }
  if (given.some((k) => d[k]!.verdict !== 'pass' && d[k]!.note.trim().length < 2)) return '「要修改」「风险提示」的条目请写意见（至少 2 个字）';
  return null;
}

/** 发给服务端的清单（只带给了结论的条目） */
export function checklistBody(d: ChecklistDraft): ReviewItem[] {
  return LEGAL_ITEM_KEYS.filter((k) => d[k]).map((k) => ({ key: k, verdict: d[k]!.verdict, note: d[k]!.note.trim() }));
}

const TONE: Record<ReviewVerdict, string> = {
  pass: 'bg-pine text-paper',
  revise: 'bg-clay text-paper',
  risk: 'bg-ember text-paper',
};

export function LegalChecklistEditor({ value, onChange, disabled }: { value: ChecklistDraft; onChange: (next: ChecklistDraft) => void; disabled?: boolean }) {
  const set = (key: LegalItemKey, patch: Partial<{ verdict: ReviewVerdict; note: string }>) => {
    const cur = value[key];
    const verdict = patch.verdict ?? cur?.verdict;
    if (!verdict) return;
    onChange({ ...value, [key]: { verdict, note: patch.note ?? cur?.note ?? '' } });
  };
  const unset = LEGAL_ITEM_KEYS.filter((k) => !value[k]).length;
  return (
    <section className="rounded-lg border border-lake/30 bg-lake-soft/30 px-3.5 py-3" data-testid="legal-checklist">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-bold text-ink">法务审查清单</h3>
        <span className="text-[12px] text-ink-3">{unset ? `还有 ${unset} 条没给结论` : '10 条都给了结论'}</span>
        {unset > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            icon={<CheckCheck className="size-4" />}
            disabled={disabled}
            onClick={() => onChange(Object.fromEntries(LEGAL_ITEM_KEYS.map((k) => [k, value[k] ?? { verdict: 'pass', note: '' }])) as ChecklistDraft)}
            data-testid="legal-checklist-pass-rest"
          >
            其余都通过
          </Button>
        )}
      </div>
      <ul className="space-y-2">
        {LEGAL_CHECKLIST.map((item) => {
          const cur = value[item.key];
          return (
            <li key={item.key} className="rounded-md bg-card px-3 py-2" data-testid={`legal-item-${item.key}`}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold">{item.label}</p>
                  <p className="text-[11.5px] text-ink-3">{item.hint}</p>
                </div>
                <div className="flex gap-1" role="radiogroup" aria-label={`${item.label}结论`}>
                  {REVIEW_VERDICTS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={cur?.verdict === v}
                      disabled={disabled}
                      onClick={() => set(item.key, { verdict: v })}
                      className={cn('h-7 rounded-full px-2.5 text-[12px] font-semibold disabled:opacity-50', cur?.verdict === v ? TONE[v] : 'bg-paper-2 text-ink-2 hover:bg-paper-3')}
                      data-testid={`legal-${item.key}-${v}`}
                    >
                      {REVIEW_VERDICT_LABELS[v]}
                    </button>
                  ))}
                </div>
              </div>
              {cur && cur.verdict !== 'pass' && (
                <Input
                  aria-label={`${item.label}意见`}
                  value={cur.note}
                  maxLength={200}
                  disabled={disabled}
                  onChange={(e) => set(item.key, { note: e.target.value })}
                  placeholder={cur.verdict === 'revise' ? '要改什么（必填）' : '风险是什么（必填）'}
                  className="mt-1.5 h-9 text-[13px]"
                  data-testid={`legal-${item.key}-note`}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
