// 后台「技师」（v0.7.0）：技师规则、技师名册、需要技师的项目。
// 规则只有店主能改；名册由有「维护技师名册」权限的岗位维护；需要技师的项目随价目，由能管理价目的岗位勾选。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HandHeart, Plus } from 'lucide-react';
import { PRICE_TIER_LABELS, PRICE_TIERS, type PriceTier } from '@shared/catalog';
import {
  CALL_TYPE_LABELS,
  DEFAULT_TECHNICIAN_RULES,
  gradeLabel,
  MAX_TECH_NAME,
  TECH_NO_PATTERN,
  type CallType,
  type TechnicianAdmin,
  type TechnicianRules,
} from '@shared/technicians';
import { api, errorMessage } from '../../lib/api';
import { ClockroomRulesCard, CommissionCard } from './ClockroomCards';
import { qk, useCatalog } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { AdminPage } from './AdminShell';

const adminKey = ['admin', 'technicians'] as const;
const useTechnicianAdmin = () => useQuery({ queryKey: adminKey, queryFn: () => api.get<TechnicianAdmin>('/api/admin/technicians') });

export function TechniciansSection() {
  const can = useCan();
  return (
    <AdminPage section="technicians" description="技师名册、挂技师项目时的规则、钟房与轮钟规则、提成规则、哪些项目需要技师。">
      <div className="space-y-5">
        <RulesCard />
        <RosterCard />
        <ClockroomRulesCard />
        {(can('settings.manage') || can('report.commission')) && <CommissionCard />}
        <ItemsCard />
      </div>
    </AdminPage>
  );
}

function RulesCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const admin = useTechnicianAdmin();
  const [draft, setDraft] = useState<TechnicianRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (admin.data && !draft) setDraft(admin.data.rules);
  if (!draft || !admin.data) return <Skeleton className="h-56" />;
  const editable = can('settings.manage');
  const dirty = JSON.stringify(draft) !== JSON.stringify(admin.data.rules);
  const set = (patch: Partial<TechnicianRules>) => setDraft({ ...draft, ...patch });
  const onOff = (v: boolean) => (v ? 'on' : 'off');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<TechnicianAdmin>('/api/admin/technicians/rules', draft);
      qc.setQueryData(adminKey, next);
      setDraft(next.rules);
      await qc.invalidateQueries({ queryKey: ['frontdesk', 'technicians'] });
      toast({ tone: 'success', title: '技师规则已保存', body: next.rules.enabled ? '前台加项目时按新规则选技师。' : '技师功能已关闭，前台挂账与升级前一样。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, hint: string, control: React.ReactNode, pending = false) => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-[200px] flex-1">
        <p className="flex items-center gap-2 text-[14px] font-bold">
          {label}
          {pending && <PendingBadge title="按汤泉常见做法先定的默认，待店主确认" />}
        </p>
        <p className="text-[12.5px] text-ink-3">{hint}</p>
      </div>
      {control}
    </div>
  );

  return (
    <Card className="p-5" data-testid="technician-rules-card">
      <SectionTitle aside={!editable && <Badge>只有店主能改</Badge>}>技师规则</SectionTitle>
      <div className="mt-1 divide-y divide-line/70">
        {row(
          '技师功能',
          '开启后，前台挂「需要技师」的项目时选技师与点钟 / 轮钟；关闭时前台挂账与升级前完全一样。',
          <Segmented
            ariaLabel="技师功能"
            value={onOff(draft.enabled)}
            onChange={(v) => editable && set({ enabled: v === 'on' })}
            options={[
              { value: 'off', label: '关闭', disabled: !editable },
              { value: 'on', label: '开启', disabled: !editable },
            ]}
          />,
        )}
        {row(
          '挂技师项目必须选技师',
          '关闭后前台可以「暂不指定技师」，技师业绩里单列为「未指定技师」。',
          <Segmented
            ariaLabel="挂技师项目必须选技师"
            value={onOff(draft.requireTechnician)}
            onChange={(v) => editable && set({ requireTechnician: v === 'on' })}
            options={[
              { value: 'on', label: '必须选', disabled: !editable },
              { value: 'off', label: '可以暂不指定', disabled: !editable },
            ]}
          />,
          true,
        )}
        {row(
          '价格跟技师等级',
          '多档价格的项目（标准 / 专业 / 优选）按所选技师的等级取价；只有一档价格的项目不分等级。关闭后前台自己点价格档。',
          <Segmented
            ariaLabel="价格跟技师等级"
            value={onOff(draft.tierByGrade)}
            onChange={(v) => editable && set({ tierByGrade: v === 'on' })}
            options={[
              { value: 'on', label: '按技师等级', disabled: !editable },
              { value: 'off', label: '前台自选', disabled: !editable },
            ]}
          />,
          true,
        )}
        {row(
          '默认上钟方式',
          '选技师时先选中的方式；客人点名要某位技师时前台改成「点钟」。',
          <Segmented
            ariaLabel="默认上钟方式"
            value={draft.defaultCallType}
            onChange={(v: CallType) => editable && set({ defaultCallType: v })}
            options={(['rotation', 'designated'] as const).map((c) => ({ value: c, label: CALL_TYPE_LABELS[c], disabled: !editable }))}
          />,
          true,
        )}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-[12px] text-ink-4">
          {admin.data.rulesUpdatedAt ? `最近由${admin.data.rulesUpdatedBy ?? '系统'}于 ${formatDateTime(admin.data.rulesUpdatedAt)} 修改` : '一直按默认'}
        </span>
        {editable && JSON.stringify({ ...draft, enabled: false }) !== JSON.stringify({ ...DEFAULT_TECHNICIAN_RULES, enabled: false }) && (
          <Button size="sm" variant="ghost" onClick={() => setDraft({ ...DEFAULT_TECHNICIAN_RULES, enabled: draft.enabled })}>
            其他规则恢复默认
          </Button>
        )}
        {editable && (
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={save} data-testid="technician-rules-save">
            保存技师规则
          </Button>
        )}
      </div>
    </Card>
  );
}

type Tech = TechnicianAdmin['technicians'][number];

function RosterCard() {
  const can = useCan();
  const admin = useTechnicianAdmin();
  const [editing, setEditing] = useState<Tech | 'new' | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  if (!admin.data) return <Skeleton className="h-56" />;
  const editable = can('technician.manage');
  const all = admin.data.technicians;
  const inactive = all.filter((t) => !t.active).length;
  const shown = showInactive ? all : all.filter((t) => t.active);
  const byGrade = PRICE_TIERS.map((g) => ({ grade: g, n: all.filter((t) => t.active && t.grade === g).length })).filter((x) => x.n > 0);

  return (
    <Card className="p-5" data-testid="technician-roster">
      <SectionTitle
        aside={
          editable && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="technician-new">
              新建技师
            </Button>
          )
        }
      >
        技师名册
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        工号保存后不变，纸质单与历史明细都按工号对得上；离职的停用（不删除，历史明细照常显示）。等级对应价目表的「标准 / 专业 / 优选」三档价格。
      </p>
      <p className="mt-2 flex flex-wrap gap-1.5 text-[12.5px]">
        <Badge tone="pine">在职 {all.length - inactive} 人</Badge>
        {byGrade.map((x) => (
          <Badge key={x.grade}>
            {gradeLabel(x.grade)} {x.n}
          </Badge>
        ))}
        {inactive > 0 && (
          <button type="button" className="font-semibold text-ink-3 underline-offset-2 hover:underline" onClick={() => setShowInactive((v) => !v)}>
            {showInactive ? '隐藏' : '显示'}已停用的 {inactive} 人
          </button>
        )}
      </p>
      {all.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">
          还没有技师。{editable ? '点「新建技师」添加，或者先开启技师功能再陆续录入。' : ''}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {shown.map((t) => (
            <li key={t.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', !t.active && 'bg-paper-2/50 opacity-70')} data-testid={`technician-${t.techNo}`}>
              <span className="num w-12 text-[18px] font-bold">{t.techNo}</span>
              <span className="min-w-[96px] text-[14.5px] font-bold">{t.name}</span>
              <Badge tone={t.gender === 'female' ? 'clay' : 'lake'}>{t.gender === 'female' ? '女' : '男'}</Badge>
              <Badge tone={t.grade === 'premium' ? 'yuzu' : t.grade === 'professional' ? 'pine' : 'neutral'}>{gradeLabel(t.grade)}</Badge>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">
                {t.skills.length ? `可做：${t.skills.join('、')}` : '可做全部需要技师的项目'}
                {t.note && ` · ${t.note}`}
              </span>
              <span className="text-[12px] text-ink-4">{t.lineCount ? `已挂 ${t.lineCount} 项` : '还没有挂过'}</span>
              {!t.active && <Badge tone="clay">已停用</Badge>}
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                  编辑
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <TechnicianDialog target={editing} categories={admin.data.categories} onClose={() => setEditing(null)} />
    </Card>
  );
}

function TechnicianDialog({ target, categories, onClose }: { target: Tech | 'new' | null; categories: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = target === 'new';
  const existing = target && target !== 'new' ? target : null;
  const [techNo, setTechNo] = useState('');
  const [name, setName] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('female');
  const [grade, setGrade] = useState<PriceTier>('standard');
  const [skills, setSkills] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [sortOrder, setSortOrder] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<typeof target>(null);
  if (target !== last) {
    setLast(target);
    setTechNo(existing?.techNo ?? '');
    setName(existing?.name ?? '');
    setGender(existing?.gender ?? 'female');
    setGrade(existing?.grade ?? 'standard');
    setSkills(existing?.skills ?? []);
    setNote(existing?.note ?? '');
    setActive(existing?.active ?? true);
    setSortOrder(String(existing?.sortOrder ?? 0));
    setError(null);
  }
  // 名册里的分类可能已不在价目表里（项目改了分类），照样列出，方便去掉
  const options = [...new Set([...categories, ...skills])];
  const problem = isNew && !TECH_NO_PATTERN.test(techNo.trim()) ? '工号为 1–6 位数字或字母，例如 08、A12' : !name.trim() ? '请填写技师名字' : !/^\d{1,4}$/.test(sortOrder) ? '排序请填 0–9999 的整数' : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), gender, grade, skills, note: note.trim(), active, sortOrder: Number(sortOrder) };
    try {
      const next = isNew
        ? await api.post<TechnicianAdmin>('/api/admin/technicians', { ...body, techNo: techNo.trim() })
        : await api.put<TechnicianAdmin>(`/api/admin/technicians/${existing!.id}`, body);
      qc.setQueryData(adminKey, next);
      await qc.invalidateQueries({ queryKey: ['frontdesk', 'technicians'] });
      toast({ tone: 'success', title: isNew ? `已添加技师 ${techNo.trim()} 号 ${name.trim()}` : '已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={isNew ? '新建技师' : `编辑技师 · ${existing?.techNo} 号`}
      description={isNew ? '工号保存后不能改；离职的技师停用即可，不删除。' : `${existing?.lineCount ?? 0} 项明细记在这位技师名下，改名字后历史明细也显示新名字。`}
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} disabled={!!problem} onClick={save} data-testid="technician-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[120px_minmax(0,1fr)]">
          <Field label="工号" htmlFor="t-no">
            {isNew ? (
              <Input id="t-no" value={techNo} maxLength={6} onChange={(e) => setTechNo(e.target.value)} className="num" placeholder="08" data-autofocus data-testid="technician-no" />
            ) : (
              <p className="num flex h-11 items-center text-[18px] font-bold">{existing?.techNo}</p>
            )}
          </Field>
          <Field label="名字" htmlFor="t-name" hint="艺名或姓名，前台与小票上显示">
            <Input id="t-name" value={name} maxLength={MAX_TECH_NAME} onChange={(e) => setName(e.target.value)} data-testid="technician-name" />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="性别">
            <Segmented
              ariaLabel="技师性别"
              value={gender}
              onChange={setGender}
              className="w-full"
              options={[
                { value: 'female', label: '女' },
                { value: 'male', label: '男' },
              ]}
            />
          </Field>
          <Field label="等级" hint="价格跟技师等级时按这一档取价">
            <Segmented ariaLabel="技师等级" value={grade} onChange={setGrade} className="w-full" options={PRICE_TIERS.map((g) => ({ value: g, label: PRICE_TIER_LABELS[g] }))} />
          </Field>
        </div>
        <Field label="可做的项目分类" hint={skills.length ? `只能挂这 ${skills.length} 类的项目` : '不勾选 = 全部需要技师的项目都能做'}>
          <div className="flex flex-wrap gap-1.5">
            {options.length === 0 && <span className="text-[12.5px] text-ink-3">价目表里还没有项目分类</span>}
            {options.map((c) => {
              const on = skills.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSkills(on ? skills.filter((x) => x !== c) : [...skills, c])}
                  className={cn('h-8 rounded-full border px-3 text-[13px] font-semibold transition-colors', on ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4')}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
          <Field label="备注" htmlFor="t-note">
            <Input id="t-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} placeholder="例如：擅长足疗，周二休" />
          </Field>
          <Field label="排序" htmlFor="t-sort" hint="小的在前">
            <Input id="t-sort" value={sortOrder} inputMode="numeric" maxLength={4} onChange={(e) => setSortOrder(e.target.value)} className="num" />
          </Field>
        </div>
        {!isNew && (
          <Field label="状态">
            <Segmented
              ariaLabel="技师状态"
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              className="w-full"
              options={[
                { value: 'on', label: '在职' },
                { value: 'off', label: '停用（前台不能再选）' },
              ]}
            />
          </Field>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 需要技师的项目：按分类勾选，可以整类勾上 */
function ItemsCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useCatalog(true);
  const [draft, setDraft] = useState<Map<number, boolean>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo(() => catalog.data?.items ?? [], [catalog.data]);
  const groups = useMemo(() => {
    const map = new Map<string, typeof items>();
    for (const i of items) map.set(i.category || '其他', [...(map.get(i.category || '其他') ?? []), i]);
    return [...map];
  }, [items]);
  if (catalog.isPending) return <Skeleton className="h-56" />;
  const editable = can('catalog.manage');
  const value = (id: number, original: boolean) => draft.get(id) ?? original;
  const changes = items.filter((i) => draft.has(i.id) && draft.get(i.id) !== i.technicianRequired);
  const toggle = (id: number, original: boolean, on: boolean) => {
    const next = new Map(draft);
    if (on === original) next.delete(id);
    else next.set(id, on);
    setDraft(next);
  };
  const required = items.filter((i) => i.active && value(i.id, i.technicianRequired)).length;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/admin/technicians/items', { items: changes.map((i) => ({ id: i.id, required: draft.get(i.id)! })) });
      await qc.invalidateQueries({ queryKey: qk.catalog(true) });
      await qc.invalidateQueries({ queryKey: qk.catalog(false) });
      setDraft(new Map());
      toast({ tone: 'success', title: '需要技师的项目已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="technician-items">
      <SectionTitle aside={!editable && <Badge>能管理价目的岗位可改</Badge>}>需要技师的项目</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        勾上的项目在技师功能开启后挂账时要选技师（按摩、足疗、搓澡等）。也可以在「价目与套餐」里逐个项目设置。现在 {required} 个在售项目需要技师。
      </p>
      {items.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">价目表里还没有项目</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {groups.map(([cat, list]) => {
            const allOn = list.every((i) => value(i.id, i.technicianRequired));
            return (
              <div key={cat} className="rounded-lg border border-line" data-testid={`technician-items-${cat}`}>
                <div className="flex items-center justify-between gap-2 border-b border-line/70 bg-paper-2/60 px-3 py-2">
                  <span className="text-[13.5px] font-bold">{cat}</span>
                  {editable && (
                    <Button size="sm" variant="ghost" onClick={() => setDraft((d) => applyAll(d, list, !allOn))} data-testid={`technician-items-all-${cat}`}>
                      {allOn ? '整类取消' : '整类都需要'}
                    </Button>
                  )}
                </div>
                <ul className="divide-y divide-line/60">
                  {list.map((i) => {
                    const on = value(i.id, i.technicianRequired);
                    return (
                      <li key={i.id} className={cn('flex items-center gap-2 px-3 py-1.5', !i.active && 'opacity-55')}>
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--color-pine)]"
                            checked={on}
                            disabled={!editable}
                            onChange={(e) => toggle(i.id, i.technicianRequired, e.target.checked)}
                            aria-label={`${i.name} 需要技师`}
                          />
                          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{i.name}</span>
                        </label>
                        {!i.active && <Badge>已停用</Badge>}
                        {draft.has(i.id) && <Badge tone="lake">未保存</Badge>}
                        <span className="text-[12px] text-ink-3">
                          {i.prices.length > 1 ? `${i.prices.length} 档` : <Money cents={i.prices[0]!.price} />}
                        </span>
                        {on && <HandHeart className="size-4 text-pine" aria-label="需要技师" />}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {editable && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {changes.length > 0 && <span className="text-[12.5px] text-ink-3">改了 {changes.length} 个项目，还没保存</span>}
          <Button variant="primary" loading={busy} disabled={changes.length === 0} onClick={save} data-testid="technician-items-save">
            保存需要技师的项目
          </Button>
        </div>
      )}
    </Card>
  );
}

function applyAll(draft: Map<number, boolean>, list: { id: number; technicianRequired: boolean }[], on: boolean) {
  const next = new Map(draft);
  for (const i of list) {
    if (i.technicianRequired === on) next.delete(i.id);
    else next.set(i.id, on);
  }
  return next;
}
