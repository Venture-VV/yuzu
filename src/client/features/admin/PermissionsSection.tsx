// 后台「岗位权限」：店主按岗位勾选权限（存为相对默认规则的增减，改完立即生效）。
// 店主一栏固定拥有全部权限；管理员工账号、修改经营规则、导入期初只属于店主；库存职责的权限固定，不在这里调整。

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, Minus, RotateCcw } from 'lucide-react';
import type { RolePermissionInput, RolePermissionMatrix } from '@shared/admin';
import { DUTY_LABELS, ROLE_LABELS } from '@shared/labels';
import { DUTIES, EDITABLE_ROLES, LOCKED_PERMISSIONS, PERMISSION_GROUPS, PERMISSION_LABELS, PERMISSIONS, ROLES, type EditableRole, type Permission, type Role } from '@shared/permissions';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Button, Card, Notice, PendingBadge, Skeleton } from '../../components/ui';
import { AdminPage } from './AdminShell';

type Draft = Record<EditableRole, Permission[]>;

export function PermissionsSection() {
  const can = useCan();
  const editable = can('settings.manage');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'permissions'], queryFn: () => api.get<RolePermissionMatrix>('/api/admin/permissions') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(EDITABLE_ROLES.map((r) => [r, q.data.effective[r]])) as Draft);
  }, [q.data]);

  const changes = useMemo(() => {
    if (!draft || !q.data) return 0;
    return EDITABLE_ROLES.reduce((n, r) => n + symmetricDiff(draft[r], q.data.effective[r]), 0);
  }, [draft, q.data]);
  const fromDefault = useMemo(() => {
    if (!draft || !q.data) return 0;
    return EDITABLE_ROLES.reduce((n, r) => n + symmetricDiff(draft[r], q.data.defaults[r]), 0);
  }, [draft, q.data]);

  const toggle = (role: EditableRole, p: Permission) => {
    if (!draft || !editable || LOCKED_PERMISSIONS.includes(p)) return;
    const has = draft[role].includes(p);
    setDraft({ ...draft, [role]: has ? draft[role].filter((x) => x !== p) : [...draft[role], p] });
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const body: RolePermissionInput = draft;
      const next = await api.put<RolePermissionMatrix>('/api/admin/permissions', { roles: body });
      qc.setQueryData(['admin', 'permissions'], next);
      await qc.invalidateQueries({ queryKey: qk.session });
      await qc.invalidateQueries({ queryKey: ['admin'] });
      toast({ tone: 'success', title: '岗位权限已保存', body: '立即生效：员工下一次操作就按新的权限判断。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const columns: { key: string; label: string; role?: Role; duty?: (typeof DUTIES)[number] }[] = [
    ...ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r], role: r })),
    ...DUTIES.map((d) => ({ key: d, label: DUTY_LABELS[d].title, duty: d })),
  ];

  return (
    <AdminPage
      section="permissions"
      wide
      description="一个账号 = 一个岗位 + 若干库存职责，权限取并集；服务端逐项校验，改完立即生效。"
      actions={
        editable && q.data && draft ? (
          <div className="flex flex-wrap items-center gap-2">
            {changes > 0 && <span className="text-[12.5px] text-ink-3">未保存 {changes} 处</span>}
            <Button
              variant="ghost"
              icon={<RotateCcw className="size-4" />}
              disabled={fromDefault === 0}
              onClick={() => setDraft(Object.fromEntries(EDITABLE_ROLES.map((r) => [r, q.data!.defaults[r]])) as Draft)}
            >
              全部恢复默认
            </Button>
            <Button variant="primary" loading={saving} disabled={changes === 0} onClick={save} data-testid="permissions-save">
              保存岗位权限
            </Button>
          </div>
        ) : undefined
      }
    >
      {q.isPending || !draft ? (
        <Skeleton className="h-96" />
      ) : q.error ? (
        <Notice tone="error" title={q.error.message} />
      ) : (
        <div className="space-y-4">
          <Notice tone="info" title={editable ? '点格子勾选或取消；带锁的只属于店主' : '只有店主可以调整岗位权限'}>
            {q.data.updatedBy ? `${q.data.updatedBy} 于 ${formatDateTime(q.data.updatedAt!)} 调整过；` : '目前全部按默认规则；'}
            黄点表示与默认规则不同（与默认相比 {fromDefault} 处）。库存与采购的职责可叠加，在「员工账号」里给人勾选。
            <PendingBadge className="ml-2" title="各岗位的默认权限待店主确认" />
          </Notice>
          {error && <Notice tone="error" title={error} />}
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-[13px]" data-testid="permission-matrix">
                <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                  <tr>
                    <th className="sticky left-0 bg-paper-2 px-4 py-2 text-left">操作</th>
                    {columns.map((c, i) => (
                      <th key={c.key} className={cn('w-[78px] px-1.5 py-2 text-center leading-tight', i === ROLES.length && 'border-l border-line')}>
                        {c.label}
                        {c.role && q.data.staffCount[c.role] ? <span className="block text-[11px] font-semibold text-ink-4">{q.data.staffCount[c.role]} 人</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {PERMISSION_GROUPS.map((g) => [
                    <tr key={g.title} className="bg-paper/60">
                      <td colSpan={columns.length + 1} className="px-4 py-1.5 text-[12px] font-bold text-ink-2">
                        {g.title}
                      </td>
                    </tr>,
                    ...g.items.map((p) => (
                      <tr key={p}>
                        <td className="sticky left-0 bg-card px-4 py-2">
                          <span className="inline-flex items-center gap-1.5">
                            {PERMISSION_LABELS[p]}
                            {LOCKED_PERMISSIONS.includes(p) && <Lock className="size-3.5 text-ink-4" aria-label="只属于店主" />}
                          </span>
                        </td>
                        {columns.map((c, i) => {
                          const border = i === ROLES.length && 'border-l border-line';
                          if (c.duty) {
                            const has = !!(PERMISSIONS[p] as { duties?: readonly string[] }).duties?.includes(c.duty);
                            return (
                              <td key={c.key} className={cn('px-1.5 py-2 text-center', border)}>
                                {has ? <Check className="mx-auto size-4 text-pine/70" strokeWidth={3} /> : <Minus className="mx-auto size-4 text-ink-4" />}
                              </td>
                            );
                          }
                          if (c.role === 'owner') {
                            return (
                              <td key={c.key} className="px-1.5 py-2 text-center">
                                <Check className="mx-auto size-4 text-pine" strokeWidth={3} />
                              </td>
                            );
                          }
                          const role = c.role as EditableRole;
                          const has = draft[role].includes(p);
                          const locked = LOCKED_PERMISSIONS.includes(p);
                          const changed = has !== q.data.defaults[role].includes(p);
                          return (
                            <td key={c.key} className="px-1 py-1 text-center">
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={has}
                                aria-label={`${ROLE_LABELS[role]}：${PERMISSION_LABELS[p]}`}
                                disabled={!editable || locked}
                                onClick={() => toggle(role, p)}
                                data-testid={`perm-${role}-${p}`}
                                className={cn(
                                  'relative mx-auto flex size-8 items-center justify-center rounded-md transition-colors',
                                  editable && !locked ? 'hover:bg-paper-2' : 'cursor-default',
                                  has && 'bg-pine-tint',
                                )}
                              >
                                {locked ? <Lock className="size-3.5 text-ink-4" /> : has ? <Check className="size-4 text-pine" strokeWidth={3} /> : <Minus className="size-4 text-ink-4" />}
                                {changed && <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-yuzu ring-2 ring-card" aria-hidden />}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </AdminPage>
  );
}

function symmetricDiff(a: readonly Permission[], b: readonly Permission[]) {
  return a.filter((p) => !b.includes(p)).length + b.filter((p) => !a.includes(p)).length;
}
