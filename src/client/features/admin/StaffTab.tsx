import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, UserPlus } from 'lucide-react';
import { DUTY_LABELS, ROLE_HINTS, ROLE_LABELS } from '@shared/labels';
import { DUTIES, dutyConflict, type Duty, type Role } from '@shared/permissions';
import type { StaffRecord } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { qk, useStaff } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { avatarTone, cn, relativeTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { useDepartments } from '../inventory/queries';

export function StaffTab() {
  const session = useSession();
  const staff = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<StaffRecord | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; password: string } | null>(null);
  const [resetting, setResetting] = useState<StaffRecord | null>(null);

  const reset = async (s: StaffRecord) => {
    try {
      const r = await api.post<{ temporaryPassword: string }>(`/api/staff/${s.id}/reset-password`);
      setResetting(null);
      setSecret({ name: s.displayName, password: r.temporaryPassword });
      void qc.invalidateQueries({ queryKey: qk.staff });
    } catch (err) {
      toast({ tone: 'error', title: errorMessage(err) });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-3">每位员工使用自己的账号，所有余额与库存操作都记录经办人。停用后立即退出登录。</p>
        {(() => {
          const conflicts = (staff.data ?? []).filter((s) => s.active && dutyConflict(s.role, s.duties));
          return conflicts.length > 0 ? (
            <Notice tone="warning" title={`${conflicts.length} 名员工的职责跨了组，请改成一组（仓库、采购、部门、财务、负责人不兼任）`} className="w-full">
              {conflicts.map((s) => `${s.displayName}（${dutyConflict(s.role, s.duties)}）`).join('、')}。不改也照常能用，但下次保存这名员工时要先改成一组。
            </Notice>
          ) : null;
        })()}
        <Button variant="primary" size="sm" icon={<UserPlus className="size-4" />} onClick={() => setEditing('new')}>
          添加员工
        </Button>
      </div>
      <Card className="divide-y divide-line/70">
        {staff.isPending
          ? [0, 1, 2].map((i) => <Skeleton key={i} className="m-3 h-12" />)
          : staff.data?.map((s) => (
              <div key={s.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', !s.active && 'opacity-55')}>
                <span className={cn('flex size-10 items-center justify-center rounded-full text-[15px] font-bold', avatarTone(s.id))}>
                  {s.displayName.slice(0, 1)}
                </span>
                <div className="min-w-[140px] flex-1">
                  <p className="flex items-center gap-2 text-[14.5px] font-bold">
                    {s.displayName}
                    {s.id === session.staff.id && <span className="text-[12px] font-semibold text-ink-3">（我）</span>}
                  </p>
                  <p className="num text-[12.5px] text-ink-3">
                    {s.username} · 上次登录 {relativeTime(s.lastLoginAt)}
                  </p>
                </div>
                <span className="flex flex-wrap gap-1">
                  <Badge tone={s.role === 'owner' ? 'pine' : s.role === 'backoffice' || s.role === 'other_store' ? 'lake' : s.role === 'clerk' ? 'neutral' : 'yuzu'}>{ROLE_LABELS[s.role]}</Badge>
                  {s.role !== 'owner' &&
                    s.duties.map((d) => (
                      <Badge key={d} tone="moss">
                        {DUTY_LABELS[d].title}
                      </Badge>
                    ))}
                </span>
                {s.departmentName && <span className="text-[12.5px] text-ink-2">所属部门：{s.departmentName}</span>}
                {!s.active && <Badge tone="clay">已停用</Badge>}
                {s.active && dutyConflict(s.role, s.duties) && <Badge tone="ember">职责跨组</Badge>}
                {s.mustChangePassword && s.active && <Badge tone="yuzu">待首次改密</Badge>}
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setResetting(s)}>
                    重置密码
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>
                    编辑
                  </Button>
                </div>
              </div>
            ))}
      </Card>

      <StaffDialog
        target={editing}
        onClose={() => setEditing(null)}
        onCreated={(name, password) => setSecret({ name, password })}
      />

      <Dialog
        open={!!resetting}
        onClose={() => setResetting(null)}
        title="重置密码"
        description={resetting ? `${resetting.displayName}（${resetting.username}）` : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetting(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => resetting && reset(resetting)}>
              生成临时密码
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-ink-2">将生成一个临时密码，并让该员工在所有设备上退出登录。员工用临时密码登录后需要设置新密码。</p>
      </Dialog>

      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title="临时密码"
        description="只显示这一次，请当面告知员工。"
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            我已告知
          </Button>
        }
      >
        <div className="rounded-lg border border-dashed border-pine/40 bg-pine-tint px-4 py-5 text-center">
          <p className="text-[13px] text-ink-2">{secret?.name} 的临时密码</p>
          <p className="num mt-2 text-[26px] font-bold tracking-wider text-pine select-all">{secret?.password}</p>
        </div>
      </Dialog>
    </div>
  );
}

function StaffDialog({
  target,
  onClose,
  onCreated,
}: {
  target: StaffRecord | 'new' | null;
  onClose: () => void;
  onCreated: (name: string, password: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = target === 'new';
  const existing = target && target !== 'new' ? target : null;
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('clerk');
  const [duties, setDuties] = useState<Duty[]>([]);
  // 所属部门（v0.7.8）：部门申购只能给它提需求单；读不到部门列表时不改原来的设置
  const departments = useDepartments(true);
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastTarget, setLastTarget] = useState<typeof target>(null);

  if (target !== lastTarget) {
    setLastTarget(target);
    setUsername(existing?.username ?? '');
    setName(existing?.displayName ?? '');
    setRole(existing?.role ?? 'clerk');
    setDuties(existing?.duties ?? []);
    setDepartmentId(existing?.departmentId ?? null);
    setActive(existing?.active ?? true);
    setError(null);
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const r = await api.post<{ temporaryPassword: string }>('/api/staff', {
          username,
          displayName: name,
          role,
          duties: role === 'owner' || role === 'other_store' ? [] : duties,
          departmentId: departments.data ? departmentId : null,
        });
        onCreated(name, r.temporaryPassword);
      } else if (existing) {
        await api.put(`/api/staff/${existing.id}`, {
          displayName: name,
          role,
          duties: role === 'owner' || role === 'other_store' ? [] : duties,
          active,
          ...(departments.data ? { departmentId } : {}),
        });
        toast({ tone: 'success', title: '已保存' });
      }
      void qc.invalidateQueries({ queryKey: qk.staff });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={isNew ? '添加员工' : '编辑员工'}
      description={isNew ? '保存后会生成临时密码，员工首次登录时设置自己的密码。' : existing?.username}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {isNew && (
          <Field label="登录账号" htmlFor="s-user" hint="2–32 位小写字母、数字或 _ . -，如 xiaozhou">
            <Input id="s-user" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoCapitalize="none" data-autofocus />
          </Field>
        )}
        <Field label="姓名" htmlFor="s-name">
          <Input id="s-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="岗位" aside={<span className="text-[12px] text-ink-3">权限见「岗位权限」</span>}>
          <Segmented
            value={role}
            onChange={setRole}
            className="w-full flex-wrap"
            options={[
              { value: 'clerk', label: '前台店员' },
              { value: 'duty_manager', label: '值班经理' },
              { value: 'account_manager', label: '客户经理' },
              { value: 'store_manager', label: '店总' },
              { value: 'backoffice', label: '后勤人员' },
              { value: 'other_store', label: '他店查询' },
              { value: 'owner', label: '店主' },
            ]}
          />
          <p className="text-[12.5px] text-ink-3">{ROLE_HINTS[role]}</p>
        </Field>
        <Field label="库存与采购职责" aside={<span className="text-[12px] text-ink-3">仓库、采购、部门、财务（含成本）、负责人不兼任</span>}>
          {role === 'owner' ? (
            <p className="rounded-md bg-paper-2/70 px-3 py-2.5 text-[13px] text-ink-2">店主默认拥有全部库存与采购权限。</p>
          ) : role === 'other_store' ? (
            <p className="rounded-md bg-paper-2/70 px-3 py-2.5 text-[13px] text-ink-2">他店查询只查会员档阶，没有库存与采购职责。</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {DUTIES.map((d) => {
                const on = duties.includes(d);
                return (
                  <label
                    key={d}
                    className={cn(
                      'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors',
                      on ? 'border-pine bg-pine-tint' : 'border-line-strong bg-card hover:border-ink-4',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => setDuties((list) => (e.target.checked ? [...list, d] : list.filter((x) => x !== d)))}
                      className="mt-0.5 size-4 accent-[var(--color-pine)]"
                    />
                    <span>
                      <span className="block text-[13.5px] font-bold">{DUTY_LABELS[d].title}</span>
                      <span className="block text-[12px] leading-snug text-ink-3">{DUTY_LABELS[d].hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {role !== 'owner' && dutyConflict(role, duties) && (
            <p className="text-[12.5px] font-semibold text-clay">职责跨了「{dutyConflict(role, duties)}」：只能在一组里（对账付款与成本核算同属财务，可以同时有）。</p>
          )}
          {role !== 'owner' && <p className="text-[12px] text-ink-3">库存职责不会带来会员钱包、撤销或日结权限。</p>}
        </Field>
        {departments.data && (
          <Field label="所属部门" htmlFor="s-dept" hint="部门申购只能给所属部门提采购需求单">
            <Select id="s-dept" value={departmentId ?? ''} onChange={(e) => setDepartmentId(Number(e.target.value) || null)} data-testid="staff-dept">
              <option value="">不设置</option>
              {departments.data
                .filter((d) => d.active || d.id === departmentId)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.active ? '' : '（已停用）'}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        {!isNew && (
          <Field label="状态">
            <Segmented
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              className="w-full"
              options={[
                { value: 'on', label: '在职' },
                { value: 'off', label: '停用' },
              ]}
            />
          </Field>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
