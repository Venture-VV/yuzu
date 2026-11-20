// 技师管理 · 技师名册（8.1.15）：工号、名字与花名、类型、等级、可做项目、组别、入职时间、状态，今天的班与休假。
// 搜索与钟房一样（姓名、工号、花名、拼音首字母）。新建、编辑走与后台同一个对话框、同一组接口；类型的清单在这里改。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Tags, X } from 'lucide-react';
import { PRICE_TIER_LABELS } from '@shared/catalog';
import { normalizeQuery } from '@shared/pinyin-initials';
import { LEAVE_TYPE_LABELS, matchesTechnician, MAX_TECH_KIND, MAX_TECH_KINDS, shiftTimeText, type RosterTechnician, type TechnicianAdminView } from '@shared/technician-admin';
import { api, errorMessage } from '../../lib/api';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice } from '../../components/ui';
import { techViewKey, useTechAdminRefresh } from './queries';
import { TechnicianDialog } from './TechnicianDialog';

/** 宽屏上排成表格的列：工号、名字、类型、等级、可做项目、组别、入职、状态、操作 */
const COLUMNS = 'lg:grid lg:grid-cols-[56px_minmax(130px,1.1fr)_84px_64px_minmax(120px,1.4fr)_minmax(72px,0.7fr)_104px_minmax(132px,1fr)_72px] lg:items-center lg:gap-x-3';

export function RosterTab({ view }: { view: TechnicianAdminView }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<RosterTechnician | 'new' | null>(null);
  const [editingKinds, setEditingKinds] = useState(false);
  const query = normalizeQuery(text);
  const all = view.technicians;
  const inactive = all.filter((t) => !t.active).length;
  const list = all.filter((t) => (showInactive || t.active) && (kind === null || t.kind === kind) && matchesTechnician(query, t));
  // 类型的选项：清单里的，加上名册里还在用的
  const kinds = [...new Set([...view.kinds, ...all.map((t) => t.kind).filter(Boolean)])];

  return (
    <Card className="p-5" data-testid="tech-roster">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-0 flex-1 basis-60">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="搜姓名、工号、花名，或拼音首字母"
            aria-label="搜索技师"
            className="pl-10"
            maxLength={20}
            inputMode="search"
            data-testid="tech-roster-search"
          />
        </div>
        {view.canManage && (
          <>
            <Button size="lg" variant="secondary" icon={<Tags className="size-4" />} onClick={() => setEditingKinds(true)} data-testid="tech-kinds-edit">
              类型清单
            </Button>
            <Button size="lg" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="tech-roster-new">
              新建技师
            </Button>
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="按类型看">
        <KindChip on={kind === null} onClick={() => setKind(null)}>
          全部 <span className="num">{all.filter((t) => showInactive || t.active).length}</span>
        </KindChip>
        {kinds.map((k) => (
          <KindChip key={k} on={kind === k} onClick={() => setKind(kind === k ? null : k)}>
            {k} <span className="num">{all.filter((t) => (showInactive || t.active) && t.kind === k).length}</span>
          </KindChip>
        ))}
        {inactive > 0 && (
          <button
            type="button"
            className="ml-auto h-9 px-2 text-[13px] font-semibold text-ink-3 underline-offset-2 hover:underline"
            onClick={() => setShowInactive((v) => !v)}
            data-testid="tech-roster-inactive"
          >
            {showInactive ? '不看' : '也看'}离职的 {inactive} 人
          </button>
        )}
      </div>
      {all.length === 0 ? (
        <EmptyState
          art="leaf"
          title="还没有技师"
          description={view.canManage ? '点「新建技师」录入工号、名字、类型与等级。' : '请有「维护技师名册」权限的同事录入。'}
          action={
            view.canManage && (
              <Button variant="primary" size="lg" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                新建技师
              </Button>
            )
          }
        />
      ) : list.length === 0 ? (
        <EmptyState art="search" title="没有符合条件的技师" description="换个搜索词或类型试试。" />
      ) : (
        <div className="mt-3 rounded-lg border border-line" data-testid="tech-roster-list">
          <div className={cn('hidden border-b border-line bg-paper-2/60 px-3 py-2 text-[12.5px] font-semibold text-ink-3', COLUMNS)}>
            <span>工号</span>
            <span>名字 / 花名</span>
            <span>类型</span>
            <span>等级</span>
            <span>可做项目</span>
            <span>组别</span>
            <span>入职时间</span>
            <span>状态</span>
            <span />
          </div>
          <ul className="divide-y divide-line/70">
            {list.map((t) => (
              <li key={t.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', COLUMNS, !t.active && 'bg-paper-2/50')} data-testid={`tech-roster-${t.techNo}`}>
                <span className="num text-[18px] font-bold">{t.techNo}</span>
                <span className="min-w-0 text-[15px] font-bold">
                  <span className="break-words">{t.name}</span>
                  {t.nickname && <span className="ml-1 text-[13px] font-semibold text-ink-3">「{t.nickname}」</span>}
                  <span className={cn('ml-1.5 text-[12px] font-semibold', t.gender === 'female' ? 'text-clay' : 'text-lake')}>{t.gender === 'female' ? '女' : '男'}</span>
                </span>
                <span>{t.kind ? <Badge tone="lake">{t.kind}</Badge> : <span className="text-[12.5px] text-ink-4">未设</span>}</span>
                <span>
                  <Badge tone={t.grade === 'premium' ? 'yuzu' : t.grade === 'professional' ? 'pine' : 'neutral'}>{PRICE_TIER_LABELS[t.grade]}</Badge>
                </span>
                <span className="min-w-0 basis-full text-[12.5px] text-ink-2 lg:basis-auto lg:truncate" title={t.skills.join('、')}>
                  {t.skills.length ? t.skills.join('、') : '全部需要技师的项目'}
                </span>
                <span className="text-[13px] text-ink-2">{t.groupName ?? <span className="text-ink-4">未分组</span>}</span>
                <span className="num text-[13px] text-ink-2">{t.hiredOn ?? <span className="text-ink-4">没填</span>}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className={cn('text-[16px] font-bold', t.active ? 'text-pine' : 'text-clay')}>{t.active ? '在职' : '离职'}</span>
                  <span className="text-[12.5px] text-ink-3">
                    {!t.active
                      ? (t.leftOn ?? '')
                      : t.leaveToday
                        ? `今天休假（${LEAVE_TYPE_LABELS[t.leaveToday.leaveType]}，到 ${t.leaveToday.toDate.slice(5)}）`
                        : t.restToday
                          ? '今天排休'
                          : t.shiftToday
                            ? `今天 ${t.shiftToday.name} ${shiftTimeText(t.shiftToday)}`
                            : ''}
                  </span>
                </span>
                <span className="ml-auto lg:ml-0 lg:justify-self-end">
                  {view.canManage && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(t)} data-testid={`tech-roster-edit-${t.techNo}`}>
                      编辑
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-[12.5px] text-ink-3">工号保存后不变；离职的停用（不删除，历史明细照常显示）。规则与提成在「后台 → 技师」。</p>
      <TechnicianDialog target={editing} categories={view.categories} kinds={view.kinds} onClose={() => setEditing(null)} />
      <KindsDialog open={editingKinds} kinds={view.kinds} onClose={() => setEditingKinds(false)} />
    </Card>
  );
}

function KindChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn('h-9 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-pine bg-pine text-paper' : 'border-line-strong bg-card text-ink-2 hover:border-ink-4')}
    >
      {children}
    </button>
  );
}

/** 技师类型的清单：加、去掉、调先后（钟房的筛选、名册的下拉都按它） */
function KindsDialog({ open, kinds, onClose }: { open: boolean; kinds: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const [list, setList] = useState<string[]>(kinds);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setList(kinds);
    setDraft('');
    setError(null);
  });
  const name = draft.trim();
  const addProblem = !name ? null : list.includes(name) ? '已经有这个类型了' : list.length >= MAX_TECH_KINDS ? `最多 ${MAX_TECH_KINDS} 个` : null;
  const add = () => {
    if (!name || addProblem) return;
    setList([...list, name]);
    setDraft('');
  };
  const dirty = JSON.stringify(list) !== JSON.stringify(kinds);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      qc.setQueryData(techViewKey, await api.put<TechnicianAdminView>('/api/technician-admin/kinds', { kinds: list }));
      refresh();
      toast({ tone: 'success', title: '技师类型的清单已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="技师类型的清单"
      description="名册里选类型、钟房按类型筛选都按这份清单。去掉一个类型不影响已经设成它的技师（照旧显示，可以再改）。"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!dirty || list.length === 0} onClick={save} data-testid="tech-kinds-save">
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5" data-testid="tech-kinds-list">
        {list.map((k) => (
          <span key={k} className="inline-flex h-9 items-center gap-1 rounded-full border border-line-strong bg-card pr-1.5 pl-3 text-[13px] font-semibold text-ink-2">
            {k}
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-paper-2 hover:text-clay"
              onClick={() => setList(list.filter((x) => x !== k))}
              aria-label={`去掉「${k}」`}
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        {list.length === 0 && <span className="text-[13px] text-clay">至少留一个类型</span>}
      </div>
      <Field label="加一个类型" htmlFor="tech-kind-new" className="mt-4" error={addProblem} hint={`最多 ${MAX_TECH_KIND} 个字，例如：修脚、头疗`}>
        <div className="flex gap-2">
          <Input
            id="tech-kind-new"
            value={draft}
            maxLength={MAX_TECH_KIND}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            data-testid="tech-kind-new"
          />
          <Button variant="secondary" className="h-11" disabled={!name || !!addProblem} onClick={add} data-testid="tech-kind-add">
            添加
          </Button>
        </div>
      </Field>
      {error && <Notice tone="error" title={error} className="mt-4" />}
    </Dialog>
  );
}
