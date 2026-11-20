// 后台「岗位权限」的新岗位部分（8.1.18，docs/POSITIONS_V8118.md GW8）：超级管理员（总裁）按岗位逐项开关权限。
// 默认按《分部门岗位职权配置》的建议值（src/shared/positions.ts），存为相对建议值的增减，改完立即生效；
// 按表上的八列（本人经办、本部门台账、跨部门、业务录入、审核审批、会员与券、账号与权限、基础数据）分组显示。

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Lock, RotateCcw } from 'lucide-react';
import type { EditablePosition, RolePermissionMatrix } from '@shared/admin';
import { ALL_PERMISSIONS, LOCKED_PERMISSIONS, PERMISSION_LABELS, type Permission } from '@shared/permissions';
import { ADMIN_LEVEL_LABELS, ORG_DEPARTMENTS, PERMISSION_COLUMN, PERMISSION_COLUMNS, POSITIONS, positionOf } from '@shared/positions';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { cn, formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Notice, PendingBadge, Select } from '../../components/ui';

const EDITABLE = POSITIONS.filter((p) => p.key !== 'president');

export function PositionPermissions({ data, editable }: { data: RolePermissionMatrix; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState<EditablePosition>('front.staff');
  const [draft, setDraft] = useState<Permission[]>(data.positions.effective[key]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(data.positions.effective[key]), [data, key]);

  const def = positionOf(key);
  const defaults = data.positions.defaults[key];
  const unsaved = useMemo(() => diff(draft, data.positions.effective[key]), [draft, data, key]);
  const fromDefault = diff(draft, defaults);

  const toggle = (p: Permission) => {
    if (!editable || LOCKED_PERMISSIONS.includes(p)) return;
    setDraft((d) => (d.includes(p) ? d.filter((x) => x !== p) : [...d, p]));
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<RolePermissionMatrix>('/api/admin/position-permissions', { positions: { [key]: draft } });
      qc.setQueryData(['admin', 'permissions'], next);
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: `「${def.title}」的权限已保存`, body: '立即生效：这个岗位的员工下一次操作就按新的权限判断。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="position-permissions">
      <Notice tone="info" title={editable ? '选一个岗位，逐项勾选或取消；带锁的只属于总裁' : '只有总裁（超级管理员）可以调整岗位权限'}>
        默认按《分部门岗位职权配置》的建议值；总裁固定拥有全部权限。
        {data.positions.updatedBy ? `${data.positions.updatedBy} 于 ${formatDateTime(data.positions.updatedAt!)} 调整过。` : '目前全部按建议值。'}
        {data.positions.needsPosition > 0 && ` 还有 ${data.positions.needsPosition} 个老账号没选新岗位（他们下次登录时自己选）。`}
        <PendingBadge className="ml-2" title="每个岗位具体给哪几项待店主确认（GW4）" />
      </Notice>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="岗位" htmlFor="pp-position">
          <Select id="pp-position" value={key} onChange={(e) => setKey(e.target.value as EditablePosition)} data-testid="position-permissions-select">
            {ORG_DEPARTMENTS.filter((d) => d.key !== 'company').map((d) => (
              <optgroup key={d.key} label={d.name}>
                {EDITABLE.filter((p) => p.department === d.key).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.title}（{ADMIN_LEVEL_LABELS[p.level]}）{data.positions.staffCount[p.key as EditablePosition] ? ` · ${data.positions.staffCount[p.key as EditablePosition]} 人` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            {unsaved > 0 && <span className="text-[12.5px] text-ink-3">未保存 {unsaved} 处</span>}
            <Button variant="ghost" icon={<RotateCcw className="size-4" />} disabled={fromDefault === 0} onClick={() => setDraft(defaults)}>
              恢复建议值
            </Button>
            <Button variant="primary" loading={saving} disabled={unsaved === 0} onClick={save} data-testid="position-permissions-save">
              保存这个岗位
            </Button>
          </div>
        )}
      </div>
      {error && <Notice tone="error" title={error} />}
      <div className="grid gap-3 md:grid-cols-2">
        {PERMISSION_COLUMNS.map((c) => {
          const items = ALL_PERMISSIONS.filter((p) => PERMISSION_COLUMN[p] === c.key);
          const suggested = def.columns.includes(c.key);
          const note = def.notes?.[c.key];
          const on = items.filter((p) => draft.includes(p)).length;
          return (
            <Card key={c.key} className="p-3">
              <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-bold">
                {c.label}
                <Badge tone={suggested ? 'pine' : 'neutral'}>
                  表上建议 {suggested ? '✔' : '✘'}
                  {note ? `（${note}）` : ''}
                </Badge>
                <span className="text-[12px] font-normal text-ink-3">
                  开了 {on} / {items.length} 项
                </span>
              </p>
              <div className="mt-2 grid gap-1">
                {items.map((p) => {
                  const has = draft.includes(p);
                  const locked = LOCKED_PERMISSIONS.includes(p);
                  const changed = has !== defaults.includes(p);
                  return (
                    <label key={p} className={cn('flex items-start gap-2 rounded px-1 py-0.5 text-[12.5px]', editable && !locked && 'cursor-pointer hover:bg-paper-2')}>
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 accent-[var(--color-pine)]"
                        checked={has}
                        disabled={!editable || locked}
                        onChange={() => toggle(p)}
                        data-testid={`pos-perm-${key}-${p}`}
                      />
                      <span className={cn(changed && 'font-bold text-yuzu-deep')}>
                        {PERMISSION_LABELS[p]}
                        {locked && <Lock className="ml-1 inline size-3 text-ink-4" aria-label="只属于总裁" />}
                      </span>
                    </label>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function diff(a: readonly Permission[], b: readonly Permission[]) {
  return a.filter((p) => !b.includes(p)).length + b.filter((p) => !a.includes(p)).length;
}
