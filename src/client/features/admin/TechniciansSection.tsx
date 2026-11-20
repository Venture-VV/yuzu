// 后台「技师」（v0.7.0）：技师规则、技师名册、需要技师的项目。
// 规则只有店主能改；名册由有「维护技师名册」权限的岗位维护；需要技师的项目随价目，由能管理价目的岗位勾选。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { HandHeart, Plus } from 'lucide-react';
import { PRICE_TIERS } from '@shared/catalog';
import { CALL_TYPE_LABELS, DEFAULT_TECHNICIAN_RULES, gradeLabel, type CallType, type TechnicianAdmin, type TechnicianRules } from '@shared/technicians';
import { api, errorMessage } from '../../lib/api';
import { ClockroomRulesCard, CommissionCard } from './ClockroomCards';
import { qk, useCatalog } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { AdminPage } from './AdminShell';
import { SubPane } from '../../components/SubNav';
import { TechnicianDialog } from '../technicians/TechnicianDialog';

const adminKey = ['admin', 'technicians'] as const;
const useTechnicianAdmin = () => useQuery({ queryKey: adminKey, queryFn: () => api.get<TechnicianAdmin>('/api/admin/technicians') });

/** 二级页签（8.0.17）：规则 → 清单 */
const TECHNICIAN_TABS = [
  { key: 'rules', label: '规则' },
  { key: 'roster', label: '技师名册' },
  { key: 'items', label: '需要技师的项目' },
];

export function TechniciansSection() {
  const can = useCan();
  return (
    <AdminPage section="technicians" description="技师的规则（挂技师项目、钟房与轮钟、提成）、技师名册、哪些项目需要技师。" tabs={TECHNICIAN_TABS}>
      <SubPane tab="rules" className="space-y-5">
        <RulesCard />
        <ClockroomRulesCard />
        {(can('settings.manage') || can('report.commission')) && <CommissionCard />}
      </SubPane>
      <SubPane tab="roster">
        <RosterCard />
      </SubPane>
      <SubPane tab="items">
        <ItemsCard />
      </SubPane>
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
          '关闭后前台可以「交给钟房派钟」，钟房在「待派钟」里补派技师（不另挂一笔）；还没派的在技师业绩里单列为「未指定技师」。',
          <Segmented
            ariaLabel="挂技师项目必须选技师"
            value={onOff(draft.requireTechnician)}
            onChange={(v) => editable && set({ requireTechnician: v === 'on' })}
            options={[
              { value: 'on', label: '必须选', disabled: !editable },
              { value: 'off', label: '可以交给钟房派钟', disabled: !editable },
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
      <p className="mt-1 text-[12.5px] text-ink-3">工号保存后不变，纸质单与历史明细都按工号对得上；离职的停用（不删除，历史明细照常显示）。等级对应价目表的「标准 / 专业 / 优选」三档价格。</p>
      <p className="mt-1 text-[12.5px] text-ink-3" data-testid="technician-roster-store-link">
        {/* 8.1.15：组别、班次与排班、休假在门店的「技师管理」里（当班会用到的不放后台）；名册两边都能改，是同一份 */}
        技师的组别、班次与排班、休假在门店的
        <Link to="/technicians" className="font-semibold text-pine underline-offset-2 hover:underline">
          「技师管理」
        </Link>
        里；名册在那里也能改（同一份）。
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
              <span className="min-w-[96px] text-[14.5px] font-bold">
                {t.name}
                {t.nickname && <span className="ml-1 text-[12.5px] font-semibold text-ink-3">「{t.nickname}」</span>}
              </span>
              {t.kind && <Badge tone="lake">{t.kind}</Badge>}
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
      <TechnicianDialog target={editing} categories={admin.data.categories} kinds={admin.data.kinds} onClose={() => setEditing(null)} />
    </Card>
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
      <p className="mt-1 text-[12.5px] text-ink-3">勾上的项目在技师功能开启后挂账时要选技师（按摩、足疗、搓澡等）。也可以在「价目与套餐」里逐个项目设置。现在 {required} 个在售项目需要技师。</p>
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
                        <span className="text-[12px] text-ink-3">{i.prices.length > 1 ? `${i.prices.length} 档` : <Money cents={i.prices[0]!.price} />}</span>
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
