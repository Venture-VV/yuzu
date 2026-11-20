// 后台「空间台账 → 房态中心房型」（8.1.15 / 8.1.16，docs/ROOM_CENTER_V8115.md 第 7.4 节）：房态中心按房型分页签，房型在这里配——
// 名称、排序、管空间台账里的哪几种业态、是哪一类房间（技师服务的房间 / 开单即占用的房间 / 客房 / 大厅类）、启用或停用。
// 一种业态同时只归一个在用的房型；来源与业态要对得上（客房只管「客房」，技师服务的房间只管技师服务类的业态）——保存前页面先提示，服务端再核对一遍。
// 有空间、却没归到房型的业态在房态中心放在「其他」页签里，这里写明是哪几种。修改带着看到的版本号，刚被别人改过的拒绝。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  categoryProblem,
  MAX_CATEGORY_NAME,
  MAX_CATEGORY_TYPES,
  ROOM_SOURCE_HINTS,
  ROOM_SOURCE_LABELS,
  ROOM_SOURCES,
  type RoomCategoriesAdmin,
  type RoomCategory,
  type RoomSource,
} from '@shared/room-center';
import { MAX_BUSINESS_TYPE } from '@shared/spaces';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Skeleton } from '../../components/ui';

const KEY = ['admin', 'room-categories'] as const;

export function RoomCategoriesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<RoomCategoriesAdmin>('/api/admin/room-categories') });
  const [editing, setEditing] = useState<RoomCategory | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = (data: RoomCategoriesAdmin) => {
    qc.setQueryData(KEY, data);
    void qc.invalidateQueries({ queryKey: ['room-center'] });
  };
  const defaults = async () => {
    setBusy(true);
    setError(null);
    try {
      saved(await api.post<RoomCategoriesAdmin>('/api/admin/room-categories/defaults'));
      toast({ tone: 'success', title: '已按默认建好房型' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (q.isPending) return <Skeleton className="h-48" />;
  if (q.isError && !q.data) return <LoadFailed title="房型没取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const d = q.data!;
  return (
    <Card className="space-y-4 p-5" data-testid="room-categories">
      <div className="flex flex-wrap items-center gap-3">
        <SectionTitle className="flex-1">房态中心房型</SectionTitle>
        <Button variant="primary" icon={<Plus className="size-4" />} className="h-11" onClick={() => setEditing('new')} data-testid="room-category-new">
          新建房型
        </Button>
      </div>
      <p className="text-[13px] text-ink-2">房态中心按房型分页签。每个房型管空间台账里的几种业态（一种业态只归一个在用的房型），选它是哪一类房间：点卡片能做什么跟着这一类走。</p>
      {d.unmapped.length > 0 && (
        <Notice tone="warning" title={`有房间、还没归到房型的业态：${d.unmapped.join('、')}`} data-testid="room-categories-unmapped">
          这些房间在房态中心的「其他」页签里。把业态加进一个房型，或新建一个房型。
        </Notice>
      )}
      {error && <Notice tone="error" title={error} />}
      {d.categories.length === 0 ? (
        <EmptyState
          art="calm"
          title="还没有房型"
          description="按默认建一份（按摩房、足浴房、SPA 房、休息大厅、宠物轰趴房、派对房、客房），再按门店的实际情况改。"
          action={
            <Button variant="primary" className="h-11" loading={busy} onClick={() => void defaults()} data-testid="room-category-defaults">
              按默认建房型
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line/70 rounded-lg border border-line" data-testid="room-category-list">
          {d.categories.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-testid={`room-category-${c.name}`}>
              <span className="min-w-0 flex-1 basis-56">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-bold text-ink">{c.name}</span>
                  <Badge tone={c.active ? 'pine' : 'neutral'}>{c.active ? '启用' : '停用'}</Badge>
                  <span className="text-[13px] text-ink-3">排序 {c.sortOrder}</span>
                </span>
                <span className="mt-0.5 block text-[13px] text-ink-2">
                  {ROOM_SOURCE_LABELS[c.source]}：{ROOM_SOURCE_HINTS[c.source]}
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {c.businessTypes.map((t) => (
                    <Badge key={t} tone="lake">
                      {t}
                      <span className="num text-ink-3">{d.businessTypes.find((x) => x.type === t)?.spaces ?? 0}</span>
                    </Badge>
                  ))}
                </span>
              </span>
              <Button variant="secondary" className="h-11" onClick={() => setEditing(c)} data-testid={`room-category-edit-${c.name}`}>
                修改
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <CategoryDialog admin={d} category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={saved} />}
    </Card>
  );
}

/** 新建、修改一个房型：业态从空间台账里用到的与常用的里点选，也能补一个新写的 */
function CategoryDialog({ admin, category, onClose, onSaved }: { admin: RoomCategoriesAdmin; category: RoomCategory | null; onClose: () => void; onSaved: (d: RoomCategoriesAdmin) => void }) {
  const toast = useToast();
  const [name, setName] = useState(category?.name ?? '');
  const [source, setSource] = useState<RoomSource>(category?.source ?? 'service');
  const [types, setTypes] = useState<string[]>(category?.businessTypes ?? []);
  const [extra, setExtra] = useState('');
  const [sortOrder, setSortOrder] = useState(String(category?.sortOrder ?? admin.categories.reduce((m, c) => Math.max(m, c.sortOrder), 0) + 10));
  const [active, setActive] = useState(category?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const order = /^\d{1,4}$/.test(sortOrder.trim()) ? Number(sortOrder.trim()) : null;
  // 别的在用房型已经管着的业态：点不了，写明归在哪
  const takenBy = new Map(admin.categories.filter((c) => c.active && c.id !== category?.id).flatMap((c) => c.businessTypes.map((t) => [t, c.name] as const)));
  const choices = [...new Set([...admin.businessTypes.map((t) => t.type), ...types])];
  const toggle = (t: string) => setTypes((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]));
  const typed = extra.trim();
  const taken = active ? types.find((t) => takenBy.has(t)) : undefined;
  const problem = !name.trim()
    ? '请填写房型名称'
    : order === null
      ? '排序请填 0–9999 的整数'
      : (categoryProblem(source, types) ?? (taken ? `「${taken}」已经在房型「${takenBy.get(taken)}」里` : null));
  const save = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), source, businessTypes: types, sortOrder: order, active, ...(category ? { version: category.version } : {}) };
    try {
      onSaved(category ? await api.put<RoomCategoriesAdmin>(`/api/admin/room-categories/${category.id}`, body) : await api.post<RoomCategoriesAdmin>('/api/admin/room-categories', body));
      toast({ tone: 'success', title: `房型「${name.trim()}」已保存` });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      width="max-w-2xl"
      title={category ? `修改房型 · ${category.name}` : '新建房型'}
      description="名称、是哪一类房间、管哪几种业态（一种业态只归一个在用的房型）、排序、启用或停用。"
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!!problem} loading={busy} onClick={() => void save()} data-testid="room-category-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="room-category-dialog">
        <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
          <Field label="房型名称" htmlFor="rcat-name">
            <Input id="rcat-name" value={name} maxLength={MAX_CATEGORY_NAME} onChange={(e) => setName(e.target.value)} data-autofocus data-testid="room-category-name" />
          </Field>
          <Field label="排序" htmlFor="rcat-order" hint="小的在前">
            <Input id="rcat-order" inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="num" data-testid="room-category-order" />
          </Field>
        </div>
        <Field label="是哪一类房间">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="是哪一类房间">
            {ROOM_SOURCES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={source === s}
                onClick={() => setSource(s)}
                className={cn('flex min-h-11 flex-col rounded-lg border px-3 py-2 text-left', source === s ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong')}
                data-testid={`room-category-source-${s}`}
              >
                <span className="text-[14px] font-bold text-ink">{ROOM_SOURCE_LABELS[s]}</span>
                <span className="text-[12.5px] text-ink-3">{ROOM_SOURCE_HINTS[s]}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label={`管哪几种业态（最多 ${MAX_CATEGORY_TYPES} 种；数字是空间台账里有几间）`}>
          <div className="flex flex-wrap gap-1.5" data-testid="room-category-types">
            {choices.map((t) => {
              const on = types.includes(t);
              const owner = takenBy.get(t);
              const n = admin.businessTypes.find((x) => x.type === t)?.spaces ?? 0;
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={on}
                  disabled={!on && !!owner && active}
                  onClick={() => toggle(t)}
                  title={owner ? `已经在房型「${owner}」里` : undefined}
                  className={cn(
                    'flex h-11 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50',
                    on ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4',
                  )}
                  data-testid={`room-category-type-${t}`}
                >
                  {t}
                  <span className="num text-[12px] text-ink-3">{n}</span>
                  {owner && !on && <span className="text-[12px] font-normal text-ink-3">（{owner}）</span>}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              fullWidth={false}
              value={extra}
              maxLength={MAX_BUSINESS_TYPE}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="另写一种业态"
              className="w-40"
              data-testid="room-category-extra"
            />
            <Button
              variant="secondary"
              className="h-11"
              disabled={!typed || types.includes(typed)}
              onClick={() => {
                setTypes((list) => [...list, typed]);
                setExtra('');
              }}
            >
              加上
            </Button>
          </div>
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-[14px] font-semibold">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4 accent-pine" data-testid="room-category-active" />
          启用（停用的房型不出页签，它管的业态回到「其他」）
        </label>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
