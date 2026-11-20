import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StoreBrief } from '@shared/stores';
import { KeyRound, TabletSmartphone, UserPlus, UtensilsCrossed } from 'lucide-react';
import { DUTY_LABELS, ROLE_HINTS, ROLE_LABELS } from '@shared/labels';
import { ALL_PERMISSIONS, PERMISSION_LABELS, dutyConflict, type Permission, type Role } from '@shared/permissions';
import { ADMIN_LEVEL_LABELS, ORG_DEPARTMENTS, PERMISSION_COLUMN, PERMISSION_COLUMNS, positionDefaults, positionLabel, positionOf, type OrgDepartment, type PositionKey } from '@shared/positions';
import type { RolePermissionMatrix } from '@shared/admin';
import type { StaffRecord } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { qk, useStaff } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { avatarTone, cn, relativeTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { useDepartments } from '../inventory/queries';

/** 专用账号（8.1.18，GW3）：不是组织里的岗位，照旧按旧岗位建 */
const SPECIAL_ROLES = ['tablet', 'other_store', 'designer'] as const;
type SpecialRole = (typeof SPECIAL_ROLES)[number];
const isSpecial = (r: Role): r is SpecialRole => (SPECIAL_ROLES as readonly Role[]).includes(r);

/** 员工名单上的岗位徽章：新岗位显示岗位名与管理员级别；老账号显示旧岗位 */
function PositionBadges({ s }: { s: StaffRecord }) {
  if (s.position) {
    const def = positionOf(s.position);
    const extra = s.permissionAdjust.add.length + s.permissionAdjust.remove.length;
    return (
      <>
        <Badge tone={def.level === 'super' ? 'pine' : def.level === 'senior' ? 'yuzu' : 'neutral'}>{def.title}</Badge>
        <Badge tone="lake">{ADMIN_LEVEL_LABELS[def.level]}</Badge>
        {extra > 0 && <Badge tone="moss">个人微调 {extra} 项</Badge>}
        {s.positionChosenAt && s.active && (
          <span title="老账号第一次登录自己选的岗位，请核对；在「编辑」里改了岗位以后不再标">
            <Badge tone="ember">自选岗位</Badge>
          </span>
        )}
      </>
    );
  }
  // 店主账号就是总裁（迁移时定成总裁；演示库、脚本建的店主账号没写岗位，也按总裁显示）
  if (s.role === 'owner') {
    return (
      <>
        <Badge tone="pine">总裁</Badge>
        <Badge tone="lake">{ADMIN_LEVEL_LABELS.super}</Badge>
      </>
    );
  }
  return (
    <>
      <Badge
        tone={s.role === 'backoffice' || s.role === 'other_store' ? 'lake' : s.role === 'clerk' || s.role === 'tablet' ? 'neutral' : 'yuzu'}
        icon={s.role === 'tablet' ? <TabletSmartphone className="size-3" /> : undefined}
      >
        {isSpecial(s.role) ? ROLE_LABELS[s.role] : `旧岗位：${ROLE_LABELS[s.role]}`}
      </Badge>
      {s.duties.map((d) => (
        <Badge key={d} tone="moss">
          {DUTY_LABELS[d].title}
        </Badge>
      ))}
      {s.needsPosition && s.active && <Badge tone="ember">待本人选新岗位</Badge>}
    </>
  );
}

export function StaffTab() {
  const session = useSession();
  const can = useCan();
  // 部门负责人（8.1.18，GW6）只管本部门的「员工」岗位：不能生成点单密码、改门店、个人微调
  const manageAll = can('staff.manage');
  const staff = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<StaffRecord | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; password: string; kind: 'password' | 'pin' } | null>(null);
  const [resetting, setResetting] = useState<StaffRecord | null>(null);
  // 点单密码（8.0.10，docs/EMENU.md）：服务员在点餐平板上确认下单用的 6 位数字，系统生成、只显示一次
  const [pinTarget, setPinTarget] = useState<StaffRecord | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  const reset = async (s: StaffRecord) => {
    try {
      const r = await api.post<{ temporaryPassword: string }>(`/api/staff/${s.id}/reset-password`);
      setResetting(null);
      setSecret({ name: s.displayName, password: r.temporaryPassword, kind: 'password' });
      void qc.invalidateQueries({ queryKey: qk.staff });
    } catch (err) {
      toast({ tone: 'error', title: errorMessage(err) });
    }
  };

  const makePin = async (s: StaffRecord) => {
    setPinBusy(true);
    try {
      const r = await api.post<{ pin: string }>(`/api/staff/${s.id}/order-pin`);
      setPinTarget(null);
      setSecret({ name: s.displayName, password: r.pin, kind: 'pin' });
      void qc.invalidateQueries({ queryKey: qk.staff });
    } catch (err) {
      toast({ tone: 'error', title: errorMessage(err) });
    } finally {
      setPinBusy(false);
    }
  };

  const clearPin = async (s: StaffRecord) => {
    setPinBusy(true);
    try {
      await api.post(`/api/staff/${s.id}/order-pin/clear`);
      setPinTarget(null);
      toast({ tone: 'success', title: `已收回 ${s.displayName} 的点单密码` });
      void qc.invalidateQueries({ queryKey: qk.staff });
    } catch (err) {
      toast({ tone: 'error', title: errorMessage(err) });
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-3">
          {manageAll
            ? '每位员工使用自己的账号，所有余额与库存操作都记录经办人。新建账号先选部门、再选岗位，系统按岗位套用管理员级别与权限。停用后立即退出登录。'
            : `您是${positionLabel(session.staff.position)}：这里只列本部门「员工」岗位的账号，可以新建、编辑、停用、重置密码。`}
        </p>
        {(() => {
          const conflicts = (staff.data ?? []).filter((s) => s.active && !s.position && dutyConflict(s.role, s.duties));
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
                <span className={cn('flex size-10 items-center justify-center rounded-full text-[15px] font-bold', avatarTone(s.id))}>{s.displayName.slice(0, 1)}</span>
                <div className="min-w-[140px] flex-1">
                  <p className="flex items-center gap-2 text-[14.5px] font-bold">
                    {s.displayName}
                    {s.id === session.staff.id && <span className="text-[12px] font-semibold text-ink-3">（我）</span>}
                  </p>
                  <p className="num text-[12.5px] text-ink-3">
                    {s.username} · 上次登录 {relativeTime(s.lastLoginAt)}
                  </p>
                </div>
                <span className="flex flex-wrap gap-1" data-testid={`staff-position-${s.username}`}>
                  <PositionBadges s={s} />
                </span>
                {s.departmentName && <span className="text-[12.5px] text-ink-2">领料小仓：{s.departmentName}</span>}
                {!s.active && <Badge tone="clay">已停用</Badge>}
                {s.active && !s.position && dutyConflict(s.role, s.duties) && <Badge tone="ember">职责跨组</Badge>}
                {s.mustChangePassword && s.active && <Badge tone="yuzu">待首次改密</Badge>}
                {s.orderPinSetAt && s.active && (
                  <span data-testid={`staff-pin-badge-${s.username}`}>
                    <Badge tone="moss">有点单密码</Badge>
                  </span>
                )}
                <div className="flex gap-1.5">
                  {manageAll && s.active && s.role !== 'tablet' && (
                    <Button size="sm" variant="ghost" icon={<UtensilsCrossed className="size-3.5" />} onClick={() => setPinTarget(s)} data-testid={`staff-pin-${s.username}`}>
                      点单密码
                    </Button>
                  )}
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
        manageAll={manageAll}
        myPosition={session.staff.position}
        onClose={() => setEditing(null)}
        onCreated={(name, password) => setSecret({ name, password, kind: 'password' })}
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
        open={!!pinTarget}
        onClose={() => setPinTarget(null)}
        title="点单密码"
        description={pinTarget ? `${pinTarget.displayName}（${pinTarget.username}）` : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPinTarget(null)}>
              取消
            </Button>
            {pinTarget?.orderPinSetAt && (
              <Button variant="secondary" loading={pinBusy} onClick={() => pinTarget && clearPin(pinTarget)} data-testid="staff-pin-clear">
                收回
              </Button>
            )}
            <Button variant="primary" loading={pinBusy} onClick={() => pinTarget && makePin(pinTarget)} data-testid="staff-pin-make">
              {pinTarget?.orderPinSetAt ? '重新生成' : '生成点单密码'}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-[14px] text-ink-2">
          <p>点单密码是 6 位数字：客人在餐桌的平板上选好菜，服务员输自己的点单密码确认下单，这一单记在这位服务员名下。</p>
          <p>
            {pinTarget?.orderPinSetAt
              ? `现在的密码是 ${relativeTime(pinTarget.orderPinSetAt)}生成的。重新生成后旧密码马上失效；收回后这位员工不能在平板上确认下单。`
              : '密码由系统生成、只显示一次，请当面告诉本人；本人登录后也能在「修改密码」页自己重新生成。'}
          </p>
          <p className="text-[12.5px] text-ink-3">岗位要有「餐饮点单」和「前台挂账」两项权限，点单密码才用得上（见「岗位权限」）。</p>
        </div>
      </Dialog>

      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title={secret?.kind === 'pin' ? '点单密码' : '临时密码'}
        description="只显示这一次，请当面告知员工。"
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            我已告知
          </Button>
        }
      >
        <div className="rounded-lg border border-dashed border-pine/40 bg-pine-tint px-4 py-5 text-center">
          <p className="text-[13px] text-ink-2">
            {secret?.name} 的{secret?.kind === 'pin' ? '点单密码' : '临时密码'}
          </p>
          <p className="num mt-2 text-[26px] font-bold tracking-wider text-pine select-all" data-testid="staff-secret">
            {secret?.password}
          </p>
        </div>
      </Dialog>
    </div>
  );
}

function StaffDialog({
  target,
  manageAll,
  myPosition,
  onClose,
  onCreated,
}: {
  target: StaffRecord | 'new' | null;
  manageAll: boolean;
  myPosition: PositionKey | null;
  onClose: () => void;
  onCreated: (name: string, password: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = target === 'new';
  const existing = target && target !== 'new' ? target : null;
  // 负责人只能建、改本部门的「员工」岗位
  const leadPosition: PositionKey | null = !manageAll && myPosition && myPosition !== 'president' && myPosition !== 'gmo' ? (`${positionOf(myPosition).department}.staff` as PositionKey) : null;
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'org' | 'special'>('org');
  const [dept, setDept] = useState<OrgDepartment | ''>('');
  const [position, setPosition] = useState<PositionKey | null>(null);
  const [special, setSpecial] = useState<SpecialRole>('tablet');
  const [adjust, setAdjust] = useState<{ add: Permission[]; remove: Permission[] }>({ add: [], remove: [] });
  const [showAdjust, setShowAdjust] = useState(false);
  // 领料小仓（原「所属部门」，v0.7.8）：部门申购只能给它提需求单；读不到部门列表时不改原来的设置
  const departments = useDepartments(true);
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [active, setActive] = useState(true);
  // 挂哪几家门店（8.0.22）：只有一家店时不显示；总裁不用挂（所有门店都能进）
  const storesQ = useQuery({
    queryKey: ['staff', 'stores', existing?.id ?? 0],
    queryFn: () => api.get<{ storeIds: number[]; stores: StoreBrief[] }>(`/api/staff/${existing!.id}/stores`),
    enabled: !!existing && manageAll,
  });
  // 岗位按后台调整以后的权限（个人微调在它的基础上增减）
  const matrix = useQuery({ queryKey: ['admin', 'permissions'], queryFn: () => api.get<RolePermissionMatrix>('/api/admin/permissions'), enabled: manageAll && !!target });
  const [storeIds, setStoreIds] = useState<number[] | null>(null);
  const role: Role = kind === 'special' ? special : position ? positionOf(position).legacyRole : (existing?.role ?? 'clerk');
  const shownStores = storesQ.data && storesQ.data.stores.length > 1 && role !== 'owner' ? storesQ.data.stores : null;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastTarget, setLastTarget] = useState<typeof target>(null);

  if (target !== lastTarget) {
    setLastTarget(target);
    setUsername(existing?.username ?? '');
    setName(existing?.displayName ?? '');
    const p = existing?.position ?? leadPosition;
    setKind(existing && !existing.position && isSpecial(existing.role) ? 'special' : 'org');
    setSpecial(existing && isSpecial(existing.role) ? existing.role : 'tablet');
    setPosition(p);
    setDept(p ? positionOf(p).department : '');
    setAdjust(existing?.permissionAdjust ?? { add: [], remove: [] });
    setShowAdjust(false);
    setDepartmentId(existing?.departmentId ?? null);
    setActive(existing?.active ?? true);
    setStoreIds(null);
    setError(null);
  }

  const pickDept = (d: OrgDepartment | '') => {
    setDept(d);
    setPosition(d === 'company' ? 'president' : d === 'gmo' ? 'gmo' : d ? (`${d}.staff` as PositionKey) : null);
    setAdjust({ add: [], remove: [] });
  };
  // 岗位权限（模板 + 后台按岗位的调整）；拿不到后台调整时按模板
  const positionPerms: Permission[] = position ? (position === 'president' ? [...ALL_PERMISSIONS] : (matrix.data?.positions.effective[position] ?? positionDefaults(position, ALL_PERMISSIONS))) : [];
  const effective = new Set(positionPerms);
  for (const p of adjust.remove) effective.delete(p);
  for (const p of adjust.add) effective.add(p);
  const toggle = (p: Permission, on: boolean) => {
    const inBase = positionPerms.includes(p);
    setAdjust((a) => ({
      add: on && !inBase ? [...a.add.filter((x) => x !== p), p] : a.add.filter((x) => x !== p),
      remove: !on && inBase ? [...a.remove.filter((x) => x !== p), p] : a.remove.filter((x) => x !== p),
    }));
  };

  const body = () => {
    if (kind === 'special') return { role: special, duties: [] };
    if (!position) throw new Error('请选择部门与岗位');
    return { position, ...(manageAll && position !== 'president' ? { permissionAdjust: adjust } : {}) };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const r = await api.post<{ temporaryPassword: string }>('/api/staff', {
          username,
          displayName: name,
          ...body(),
          departmentId: departments.data ? departmentId : null,
        });
        onCreated(name, r.temporaryPassword);
      } else if (existing) {
        await api.put(`/api/staff/${existing.id}`, {
          displayName: name,
          ...body(),
          active,
          ...(departments.data ? { departmentId } : {}),
        });
        if (shownStores && storeIds && storeIds.join(',') !== storesQ.data!.storeIds.join(',')) {
          await api.put(`/api/staff/${existing.id}/stores`, { storeIds });
          void qc.invalidateQueries({ queryKey: ['staff', 'stores', existing.id] });
        }
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

  const def = position ? positionOf(position) : null;
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={isNew ? '添加员工' : '编辑员工'}
      description={
        isNew
          ? kind === 'special' && special === 'tablet'
            ? '保存后会生成临时密码；在平板上用它登录、设好新密码，之后这台平板一直停在点餐页。'
            : '保存后会生成临时密码，员工首次登录时设置自己的密码。'
          : existing?.username
      }
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
        {existing && !existing.position && !isSpecial(existing.role) && (
          <Notice tone="warning" title={`旧岗位：${ROLE_LABELS[existing.role]}${existing.needsPosition ? '（本人还没选新岗位）' : ''}`}>
            选好部门与岗位后保存，就换成新岗位、按新岗位的权限；本人下次登录不再提示选岗位。
          </Notice>
        )}
        {manageAll && (
          <Field label="账号类型">
            <Segmented
              value={kind}
              onChange={setKind}
              className="w-full"
              options={[
                { value: 'org', label: '组织岗位' },
                { value: 'special', label: '专用账号（平板 / 他店 / 设计师）' },
              ]}
            />
          </Field>
        )}
        {kind === 'special' ? (
          <Field label="专用账号" aside={<span className="text-[12px] text-ink-3">不是组织里的岗位</span>}>
            <Segmented
              value={special}
              onChange={setSpecial}
              className="w-full flex-wrap"
              options={[
                { value: 'tablet', label: '点餐平板' },
                { value: 'other_store', label: '他店查询' },
                { value: 'designer', label: '设计师' },
              ]}
            />
            <p className="text-[12.5px] text-ink-3">{ROLE_HINTS[special]}</p>
          </Field>
        ) : (
          <>
            <Field label="部门" htmlFor="s-org-dept" hint="先选部门，再选岗位">
              <Select id="s-org-dept" value={dept} disabled={!manageAll} onChange={(e) => pickDept(e.target.value as OrgDepartment | '')} data-testid="staff-org-dept">
                <option value="">请选择部门</option>
                {ORG_DEPARTMENTS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.key === 'company' ? `${d.name}（总裁）` : d.name}
                  </option>
                ))}
              </Select>
            </Field>
            {dept && dept !== 'company' && dept !== 'gmo' && (
              <Field label="岗位">
                <Segmented
                  value={position ?? ''}
                  onChange={(v) => {
                    setPosition(v as PositionKey);
                    setAdjust({ add: [], remove: [] });
                  }}
                  className="w-full"
                  options={(manageAll ? (['lead', 'staff'] as const) : (['staff'] as const)).map((l) => ({ value: `${dept}.${l}`, label: l === 'lead' ? '负责人（高级管理员）' : '员工（管理员）' }))}
                />
              </Field>
            )}
            {def && (
              <div className="rounded-md border border-line bg-paper-2/60 px-3 py-2.5" data-testid="staff-position-template">
                <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-bold">
                  {def.title}
                  <Badge tone="lake">{ADMIN_LEVEL_LABELS[def.level]}</Badge>
                  <span className="text-[12px] font-normal text-ink-3">按岗位自动套用 {positionPerms.length} 项权限</span>
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {PERMISSION_COLUMNS.map((c) => {
                    const on = def.columns.includes(c.key);
                    const note = def.notes?.[c.key];
                    return (
                      <Badge key={c.key} tone={on ? 'pine' : 'neutral'}>
                        {on ? '✔' : '✘'} {c.label}
                        {note ? `（${note}）` : ''}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}
            {manageAll && def && position !== 'president' && (
              <Field
                label="逐项微调（只对这个人）"
                aside={
                  <button type="button" className="text-[12.5px] font-semibold text-pine" onClick={() => setShowAdjust((v) => !v)} data-testid="staff-adjust-toggle">
                    {showAdjust ? '收起' : adjust.add.length + adjust.remove.length ? `已调 ${adjust.add.length + adjust.remove.length} 项，展开` : '展开'}
                  </button>
                }
              >
                {showAdjust && (
                  <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border border-line px-3 py-2">
                    {PERMISSION_COLUMNS.map((c) => {
                      const items = ALL_PERMISSIONS.filter((p) => PERMISSION_COLUMN[p] === c.key && p !== 'staff.manage' && p !== 'settings.manage' && p !== 'wallet.opening');
                      return (
                        <div key={c.key}>
                          <p className="text-[12.5px] font-bold text-ink-2">{c.label}</p>
                          <div className="mt-1 grid gap-1 sm:grid-cols-2">
                            {items.map((p) => (
                              <label key={p} className="flex items-start gap-2 text-[12.5px]">
                                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-pine)]" checked={effective.has(p)} onChange={(e) => toggle(p, e.target.checked)} />
                                <span className={cn(adjust.add.includes(p) && 'font-bold text-pine', adjust.remove.includes(p) && 'font-bold text-clay')}>{PERMISSION_LABELS[p]}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-[12px] text-ink-3">一般不用调：岗位的权限在「岗位权限」里按岗位统一开关；这里只给个别人加减。</p>
              </Field>
            )}
          </>
        )}
        {departments.data && (
          <Field label="领料小仓" htmlFor="s-dept" hint="部门申购、本部门小仓用：只能给这个小仓提采购需求单、签收领料">
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
        {shownStores && (
          <Field label="门店" hint="挂了几家店的员工登录后可以换店；总裁不用挂">
            <div className="flex flex-wrap gap-2" data-testid="staff-stores">
              {shownStores.map((st) => {
                const current = storeIds ?? storesQ.data!.storeIds;
                const on = current.includes(st.id);
                return (
                  <label key={st.id} className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[13.5px]', on ? 'border-pine bg-pine-tint' : 'border-line-strong bg-card')}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => setStoreIds(e.target.checked ? [...current, st.id].sort((a, b) => a - b) : current.filter((x) => x !== st.id))}
                      className="size-4 accent-[var(--color-pine)]"
                      data-testid={`staff-store-${st.code}`}
                    />
                    <span className="num text-ink-3">{st.code}</span>
                    {st.name}
                  </label>
                );
              })}
            </div>
            {storeIds && storeIds.length === 0 && <p className="text-[12.5px] font-semibold text-clay">至少挂一家门店</p>}
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
