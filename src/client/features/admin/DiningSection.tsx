// 后台「餐饮」（S5 第一步）：餐饮规则（只有店主能改）、出品档口、菜品挂在哪个档口（能管理价目的岗位）。
// 挂了档口的菜在餐饮功能开启后才进厨房；没挂档口的项目照常挂账、不进厨房。需要技师的项目不进厨房。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { DEFAULT_DINING_RULES, MAX_STATION_NAME, type DiningAdmin, type DiningRules, type KitchenStation } from '@shared/dining';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { AdminPage } from './AdminShell';

const adminKey = ['admin', 'dining'] as const;
const useDiningAdmin = () => useQuery({ queryKey: adminKey, queryFn: () => api.get<DiningAdmin>('/api/admin/dining') });

export function DiningSection() {
  return (
    <AdminPage section="dining" description="餐饮功能开关与出品规则、出品档口（热菜、凉菜、水吧……）、每道菜送到哪个档口的厨房屏。">
      <div className="space-y-5">
        <RulesCard />
        <StationsCard />
        <ItemsCard />
      </div>
    </AdminPage>
  );
}

function RulesCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const admin = useDiningAdmin();
  const [draft, setDraft] = useState<DiningRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (admin.data && !draft) setDraft(admin.data.rules);
  if (!draft || !admin.data) return <Skeleton className="h-48" />;
  const editable = can('settings.manage');
  const dirty = JSON.stringify(draft) !== JSON.stringify(admin.data.rules);
  const set = (patch: Partial<DiningRules>) => setDraft({ ...draft, ...patch });
  const minutesOk = Number.isInteger(draft.warnMinutes) && draft.warnMinutes >= 1 && draft.warnMinutes <= 180;
  const mapped = admin.data.items.filter((i) => i.stationId !== null && !i.technicianRequired).length;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<DiningAdmin>('/api/admin/dining/rules', draft);
      qc.setQueryData(adminKey, next);
      setDraft(next.rules);
      await qc.invalidateQueries({ queryKey: qk.session });
      await qc.invalidateQueries({ queryKey: ['dining'] });
      toast({ tone: 'success', title: '餐饮规则已保存', body: next.rules.enabled ? '主导航有「餐饮」：点单、厨房出品与估清。' : '餐饮功能已关闭，前台挂账与升级前一样。' });
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
          {pending && <PendingBadge title="按洗浴中心餐厅常见做法先定的默认，待店主确认" />}
        </p>
        <p className="text-[12.5px] text-ink-3">{hint}</p>
      </div>
      {control}
    </div>
  );

  return (
    <Card className="p-5" data-testid="dining-rules-card">
      <SectionTitle aside={!editable && <Badge>只有店主能改</Badge>}>餐饮规则</SectionTitle>
      <div className="mt-1 divide-y divide-line/70">
        {row(
          '餐饮功能',
          `开启后主导航有「餐饮」：服务员按手牌点单，挂了档口的菜下单后到厨房屏。关闭时前台挂账与升级前完全一样。现在有 ${mapped} 道菜挂在档口上。`,
          <Segmented
            ariaLabel="餐饮功能"
            value={draft.enabled ? 'on' : 'off'}
            onChange={(v) => editable && set({ enabled: v === 'on' })}
            options={[
              { value: 'off', label: '关闭', disabled: !editable },
              { value: 'on', label: '开启', disabled: !editable },
            ]}
          />,
        )}
        {row(
          '出餐后要服务员点「上菜」',
          '开启时厨房出餐后菜在「待上菜」，服务员送到客人手上再点「上菜」；关闭后出餐即算上菜。',
          <Segmented
            ariaLabel="出餐后要服务员点上菜"
            value={draft.trackServed ? 'on' : 'off'}
            onChange={(v) => editable && set({ trackServed: v === 'on' })}
            options={[
              { value: 'on', label: '要点上菜', disabled: !editable },
              { value: 'off', label: '出餐即上菜', disabled: !editable },
            ]}
          />,
          true,
        )}
        {row(
          '多久没出餐标红',
          '下单超过这么多分钟还没出餐，厨房屏上标红提醒。',
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={180}
              value={Number.isNaN(draft.warnMinutes) ? '' : draft.warnMinutes}
              disabled={!editable}
              onChange={(e) => set({ warnMinutes: e.target.value === '' ? NaN : Number(e.target.value) })}
              className="num h-10 w-20"
              aria-label="多久没出餐标红（分钟）"
              data-testid="dining-warn-minutes"
            />
            <span className="text-[13px] text-ink-3">分钟</span>
          </span>,
          true,
        )}
      </div>
      {!minutesOk && <Notice tone="error" title="分钟数要在 1 到 180 之间" className="mt-3" />}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-[12px] text-ink-4">
          {admin.data.rulesUpdatedAt ? `最近由${admin.data.rulesUpdatedBy ?? '系统'}于 ${formatDateTime(admin.data.rulesUpdatedAt)} 修改` : '一直按默认'}
        </span>
        {editable && (draft.trackServed !== DEFAULT_DINING_RULES.trackServed || draft.warnMinutes !== DEFAULT_DINING_RULES.warnMinutes) && (
          <Button size="sm" variant="ghost" onClick={() => setDraft({ ...DEFAULT_DINING_RULES, enabled: draft.enabled })}>
            其他规则恢复默认
          </Button>
        )}
        {editable && (
          <Button variant="primary" loading={busy} disabled={!dirty || !minutesOk} onClick={save} data-testid="dining-rules-save">
            保存餐饮规则
          </Button>
        )}
      </div>
    </Card>
  );
}

function StationsCard() {
  const can = useCan();
  const admin = useDiningAdmin();
  const [editing, setEditing] = useState<KitchenStation | 'new' | null>(null);
  if (!admin.data) return <Skeleton className="h-40" />;
  const editable = can('catalog.manage');
  const stations = admin.data.stations;
  return (
    <Card className="p-5" data-testid="dining-stations">
      <SectionTitle
        aside={
          editable && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="dining-station-new">
              新建档口
            </Button>
          )
        }
      >
        出品档口
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        厨房按档口分屏（热菜、凉菜、主食、水吧……），每块屏只看自己档口的菜。停用的档口上的菜不再进厨房（照常挂账）；档口不删除，历史出品单照常显示。
      </p>
      {stations.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">
          还没有档口。{editable ? '点「新建档口」，例如「热菜」「水吧」。' : ''}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {stations.map((s) => (
            <li key={s.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', !s.active && 'bg-paper-2/50 opacity-70')} data-testid={`dining-station-${s.name}`}>
              <span className="min-w-[96px] flex-1 text-[14.5px] font-bold">{s.name}</span>
              <span className="text-[12.5px] text-ink-3">{s.itemCount} 道菜</span>
              <span className="num text-[12px] text-ink-4">排序 {s.sortOrder}</span>
              {!s.active && <Badge tone="clay">已停用</Badge>}
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                  编辑
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <StationDialog target={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function StationDialog({ target, onClose }: { target: KitchenStation | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<typeof target>(null);
  if (target !== opened) {
    setOpened(target);
    setName(target && target !== 'new' ? target.name : '');
    setSortOrder(target && target !== 'new' ? String(target.sortOrder) : '0');
    setActive(target && target !== 'new' ? target.active : true);
    setError(null);
  }
  const order = Number(sortOrder);
  const ok = name.trim().length >= 1 && name.trim().length <= MAX_STATION_NAME && Number.isInteger(order) && order >= 0 && order <= 9999;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), sortOrder: order, active };
      const next = target === 'new' ? await api.post<DiningAdmin>('/api/admin/dining/stations', body) : await api.put<DiningAdmin>(`/api/admin/dining/stations/${target!.id}`, body);
      qc.setQueryData(adminKey, next);
      void qc.invalidateQueries({ queryKey: ['dining'] });
      toast({ tone: 'success', title: target === 'new' ? `已新建档口「${body.name}」` : '档口已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : onClose}
      title={target === 'new' ? '新建出品档口' : '编辑出品档口'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={save} data-testid="dining-station-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="档口名称" htmlFor="station-name" hint={`最多 ${MAX_STATION_NAME} 字，例如 热菜、凉菜、水吧`}>
          <Input id="station-name" value={name} maxLength={MAX_STATION_NAME} onChange={(e) => setName(e.target.value)} data-autofocus data-testid="dining-station-name" />
        </Field>
        <Field label="排序" htmlFor="station-order" hint="小的排前面（厨房屏、点单页的顺序）">
          <Input id="station-order" type="number" inputMode="numeric" min={0} max={9999} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="num w-28" />
        </Field>
        {target !== 'new' && (
          <Segmented
            ariaLabel="档口状态"
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function ItemsCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const admin = useDiningAdmin();
  const [draft, setDraft] = useState<Map<number, number | null>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo(() => admin.data?.items ?? [], [admin.data]);
  const groups = useMemo(() => {
    const map = new Map<string, typeof items>();
    for (const i of items) map.set(i.category || '其他', [...(map.get(i.category || '其他') ?? []), i]);
    return [...map];
  }, [items]);
  if (!admin.data) return <Skeleton className="h-56" />;
  const editable = can('catalog.manage');
  const stations = admin.data.stations;
  const value = (i: (typeof items)[number]) => (draft.has(i.id) ? draft.get(i.id)! : i.stationId);
  const choose = (i: (typeof items)[number], stationId: number | null) => {
    const next = new Map(draft);
    if (stationId === i.stationId) next.delete(i.id);
    else next.set(i.id, stationId);
    setDraft(next);
  };
  const changes = items.filter((i) => draft.has(i.id) && draft.get(i.id) !== i.stationId);
  const options = [{ value: '', label: '不进厨房' }, ...stations.map((s) => ({ value: String(s.id), label: s.active ? s.name : `${s.name}（已停用）` }))];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<DiningAdmin>('/api/admin/dining/items', { items: changes.map((i) => ({ id: i.id, stationId: draft.get(i.id)! })) });
      qc.setQueryData(adminKey, next);
      setDraft(new Map());
      void qc.invalidateQueries({ queryKey: ['dining'] });
      toast({ tone: 'success', title: '菜品的出品档口已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="dining-items">
      <SectionTitle aside={!editable && <Badge>能管理价目的岗位可改</Badge>}>菜品送到哪个档口</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        挂了档口的菜：点单页能点，前台「加项目」点了也一样进厨房，账单上记在「餐饮」。没挂档口的项目（门票、洗浴用品、按摩等）照常挂账、不进厨房。
        {stations.length === 0 && ' 请先在上面建档口。'}
      </p>
      {items.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">价目表里还没有项目</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {groups.map(([cat, list]) => (
            <div key={cat} className="rounded-lg border border-line" data-testid={`dining-items-${cat}`}>
              <div className="flex items-center justify-between gap-2 border-b border-line/70 bg-paper-2/60 px-3 py-2">
                <span className="text-[13.5px] font-bold">{cat}</span>
                {editable && stations.length > 0 && (
                  <Select
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '') return;
                      const sid = v === 'none' ? null : Number(v);
                      const next = new Map(draft);
                      for (const i of list) {
                        if (i.technicianRequired) continue;
                        if (sid === i.stationId) next.delete(i.id);
                        else next.set(i.id, sid);
                      }
                      setDraft(next);
                    }}
                    fullWidth={false}
                    className="text-[12.5px]"
                    aria-label={`${cat} 整类设为`}
                    data-testid={`dining-items-all-${cat}`}
                  >
                    <option value="">整类设为…</option>
                    <option value="none">不进厨房</option>
                    {stations.filter((s) => s.active).map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              <ul className="divide-y divide-line/60">
                {list.map((i) => {
                  const v = value(i);
                  return (
                    <li key={i.id} className="flex items-center gap-2 px-3 py-1.5" data-testid={`dining-item-${i.name}`}>
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{i.name}</span>
                      {draft.has(i.id) && <Badge tone="lake">未保存</Badge>}
                      <Money cents={i.price} className="text-[12px] text-ink-3" />
                      {i.technicianRequired ? (
                        <span title="需要技师的项目不进厨房">
                          <Badge>需要技师</Badge>
                        </span>
                      ) : (
                        <Select
                          value={v === null ? '' : String(v)}
                          disabled={!editable || stations.length === 0}
                          onChange={(e) => choose(i, e.target.value === '' ? null : Number(e.target.value))}
                          fullWidth={false}
                          className="w-32 text-[13px]"
                          aria-label={`${i.name} 的出品档口`}
                          data-testid={`dining-item-station-${i.name}`}
                        >
                          {options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {editable && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          {changes.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(new Map())}>
              放弃修改
            </Button>
          )}
          <Button variant="primary" loading={busy} disabled={changes.length === 0} onClick={save} data-testid="dining-items-save">
            保存{changes.length ? `（${changes.length} 道）` : ''}
          </Button>
        </div>
      )}
    </Card>
  );
}
