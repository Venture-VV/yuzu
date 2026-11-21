// 按模块分组勾选权限（8.2.0 P05、P06，docs/YUZU_REQ_V820.md 第 6、7 节）：「分部门岗位职权配置」改建议权限、「设立岗位」改岗位权限共用。
//   · 按权限表的模块分组（PERMISSION_GROUPS）；单项勾选、全选、全不选、反选、本组全选 / 本组全不选；
//   · 给了 baseline（建议权限）时，与它不同的项标出来（黄点 + 「与建议不同」），组标题写这一组差几项；
//   · 只属于总裁的权限带锁、不能勾。

import { useMemo, useState } from 'react';
import { Lock, Search } from 'lucide-react';
import { ALL_PERMISSIONS, LOCKED_PERMISSIONS, PERMISSION_GROUPS, PERMISSION_LABELS, type Permission } from '@shared/permissions';
import { cn } from '../../lib/utils';
import { Button, Input } from '../../components/ui';

export function PermissionPicker({
  value,
  onChange,
  baseline,
  baselineLabel = '建议',
  editable,
  testId,
}: {
  value: readonly Permission[];
  onChange: (next: Permission[]) => void;
  /** 对照的建议权限：与它不同的项标出来 */
  baseline?: readonly Permission[];
  baselineLabel?: string;
  editable: boolean;
  testId: string;
}) {
  const [q, setQ] = useState('');
  const can = (p: Permission) => editable && !LOCKED_PERMISSIONS.includes(p);
  const set = (next: Iterable<Permission>) => onChange(ALL_PERMISSIONS.filter((p) => new Set(next).has(p)));
  const groups = useMemo(() => {
    const t = q.trim();
    return PERMISSION_GROUPS.map((g) => ({ ...g, items: t ? g.items.filter((p) => PERMISSION_LABELS[p].includes(t) || p.includes(t) || g.title.includes(t)) : g.items })).filter((g) => g.items.length);
  }, [q]);
  const toggle = (p: Permission) => can(p) && set(value.includes(p) ? value.filter((x) => x !== p) : [...value, p]);
  const allEditable = ALL_PERMISSIONS.filter(can);
  const differs = (p: Permission) => !!baseline && value.includes(p) !== baseline.includes(p);
  const offCount = baseline ? ALL_PERMISSIONS.filter(differs).length : 0;

  return (
    <div className="space-y-3" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative min-w-0 flex-1 basis-48">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="找权限：名称、编号或模块" className="pl-9" aria-label="找权限" data-testid={`${testId}-search`} />
        </span>
        <span className="text-[12.5px] text-ink-3">
          勾了 <b className="num text-ink">{value.length}</b> 项
          {baseline && (
            <>
              {' '}
              · 与{baselineLabel}不同{' '}
              <b className={cn('num', offCount ? 'text-yuzu-deep' : 'text-ink')} data-testid={`${testId}-off`}>
                {offCount}
              </b>{' '}
              项
            </>
          )}
        </span>
        {editable && (
          <span className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => set([...value.filter((p) => !can(p)), ...allEditable])} data-testid={`${testId}-all`}>
              全选
            </Button>
            <Button size="sm" variant="ghost" onClick={() => set(value.filter((p) => !can(p)))} data-testid={`${testId}-none`}>
              全不选
            </Button>
            <Button size="sm" variant="ghost" onClick={() => set([...value.filter((p) => !can(p)), ...allEditable.filter((p) => !value.includes(p))])} data-testid={`${testId}-invert`}>
              反选
            </Button>
          </span>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {groups.map((g) => {
          const on = g.items.filter((p) => value.includes(p)).length;
          const off = g.items.filter(differs).length;
          const editableItems = g.items.filter(can);
          const allOn = editableItems.length > 0 && editableItems.every((p) => value.includes(p));
          return (
            <section key={g.title} className="rounded-lg border border-line bg-card p-3" data-testid={`${testId}-group-${g.title}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-[13.5px] font-bold">{g.title}</h4>
                <span className="text-[12px] text-ink-3">
                  {on} / {g.items.length}
                </span>
                {off > 0 && (
                  <span className="rounded bg-yuzu-soft px-1.5 text-[12px] font-semibold text-yuzu-deep">
                    与{baselineLabel}不同 {off} 项
                  </span>
                )}
                {editable && editableItems.length > 0 && (
                  <button
                    type="button"
                    className="ml-auto text-[12.5px] font-semibold text-lake hover:underline"
                    onClick={() => set(allOn ? value.filter((p) => !editableItems.includes(p)) : [...value, ...editableItems])}
                    data-testid={`${testId}-group-toggle-${g.title}`}
                  >
                    {allOn ? '本组全不选' : '本组全选'}
                  </button>
                )}
              </div>
              <div className="mt-2 grid gap-0.5">
                {g.items.map((p) => {
                  const has = value.includes(p);
                  const locked = LOCKED_PERMISSIONS.includes(p);
                  const off1 = differs(p);
                  return (
                    <label
                      key={p}
                      className={cn('flex items-start gap-2 rounded px-1 py-1 text-[12.5px]', can(p) && 'cursor-pointer hover:bg-paper-2', off1 && 'bg-yuzu-tint')}
                      data-off={off1 ? 'true' : undefined}
                    >
                      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-pine)]" checked={has} disabled={!can(p)} onChange={() => toggle(p)} data-testid={`${testId}-${p}`} />
                      <span className="min-w-0 flex-1">
                        {PERMISSION_LABELS[p]}
                        {locked && <Lock className="ml-1 inline size-3 text-ink-4" aria-label="只属于总裁" />}
                        {off1 && (
                          <span className="ml-1.5 inline-flex items-center gap-1 text-[12px] font-semibold text-yuzu-deep">
                            <span className="size-1.5 rounded-full bg-yuzu" aria-hidden />与{baselineLabel}不同（{baselineLabel}
                            {baseline!.includes(p) ? '有' : '没有'}）
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
