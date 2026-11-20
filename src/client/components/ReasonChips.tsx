// 快捷原因（8.0.21 数据字典）：点一下填进原因框，仍然可以手改、手填。清单在后台「数据字典与字段」维护。
import { cn } from '../lib/utils';

export function ReasonChips({ reasons, value, onPick, disabled, testId }: { reasons: readonly string[]; value: string; onPick: (reason: string) => void; disabled?: boolean; testId?: string }) {
  if (!reasons.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" data-testid={testId}>
      {reasons.map((r) => (
        <button
          key={r}
          type="button"
          disabled={disabled}
          aria-pressed={value.trim() === r}
          onClick={() => onPick(r)}
          className={cn(
            'tap relative h-8 rounded-full border px-3 text-[12.5px] font-semibold disabled:opacity-50',
            value.trim() === r ? 'border-clay bg-clay-soft text-clay' : 'border-line bg-card text-ink-2 hover:border-line-strong',
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
