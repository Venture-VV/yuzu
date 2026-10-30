// 厨房出品屏（KDS）与估清。
// 出品屏：待做 → 制作中 → 已出餐（待上菜）三列，按下单先后；下单超过规定分钟还没出餐标红，催过的标出次数。
// 每个操作都带上页面看到的状态，连点两下或别人刚改过时服务端拒绝（DISH_CHANGED），不会多走一步。
// 只有点单权限的服务员只能「上菜」与撤回上菜；开始做、出餐、估清要厨房的岗位。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, ChefHat, CircleCheckBig, Flame, Undo2 } from 'lucide-react';
import { KITCHEN_STATUS_LABELS, kitchenElapsed, type KitchenBoard, type KitchenItem, type MenuDish } from '@shared/dining';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { kitchenKey, tablesKey, menuKey, useKitchenBoard, useServerNow } from './queries';

type Action = 'start' | 'done' | 'serve' | 'undo';

/** 这台屏看哪个档口（只记在这台设备上：热菜屏、水吧屏各看各的） */
const STATION_PREF = 'yuzu.kitchen.station';
const readStation = (): number | 'all' => {
  try {
    const v = Number(localStorage.getItem(STATION_PREF));
    return Number.isInteger(v) && v > 0 ? v : 'all';
  } catch {
    return 'all';
  }
};
const writeStation = (v: number | 'all') => {
  try {
    if (v === 'all') localStorage.removeItem(STATION_PREF);
    else localStorage.setItem(STATION_PREF, String(v));
  } catch {
    // 存不了只是不记住
  }
};

export function KitchenTab() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const board = useKitchenBoard(5_000);
  const d = board.data;
  const now = useServerNow(d?.serverTime);
  const [pref, setPref] = useState(readStation);
  const [showRecent, setShowRecent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const kitchen = can('dining.kitchen');

  if (board.error && !d) return <Notice tone="error" title={errorMessage(board.error)} className="m-6" />;
  if (!d) return <Skeleton className="m-6 h-64" />;

  const stations = d.stations.filter((s) => s.active);
  const station = pref !== 'all' && stations.some((s) => s.id === pref) ? pref : 'all';
  const items = d.items.filter((k) => station === 'all' || k.stationId === station);
  const queued = items.filter((k) => k.status === 'queued');
  const cooking = items.filter((k) => k.status === 'cooking');
  const done = items.filter((k) => k.status === 'done');
  const recent = items.filter((k) => k.status === 'served' || k.status === 'cancelled');

  const act = async (k: KitchenItem, action: Action) => {
    setBusy(`${action}-${k.id}`);
    try {
      qc.setQueryData(kitchenKey, await api.post<KitchenBoard>(`/api/kitchen/items/${k.id}/${action}`, { from: k.status }));
      void qc.invalidateQueries({ queryKey: ['dining', 'guest'] });
      void qc.invalidateQueries({ queryKey: tablesKey });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      void qc.invalidateQueries({ queryKey: kitchenKey });
    } finally {
      setBusy(null);
    }
  };
  const btn = (k: KitchenItem, action: Action, label: string, variant: 'primary' | 'secondary' | 'ghost', icon?: React.ReactNode) => (
    <Button size="sm" variant={variant} icon={icon} disabled={busy !== null && busy !== `${action}-${k.id}`} loading={busy === `${action}-${k.id}`} onClick={() => void act(k, action)} data-testid={`kds-${action}-${k.id}`}>
      {label}
    </Button>
  );

  const columns: { key: string; title: string; icon: React.ReactNode; list: KitchenItem[]; actions: (k: KitchenItem) => React.ReactNode }[] = [
    {
      key: 'queued',
      title: '待做',
      icon: <ChefHat className="size-4 text-ink-3" />,
      list: queued,
      actions: (k) =>
        kitchen && (
          <>
            {btn(k, 'start', '开始做', 'primary', <Flame className="size-3.5" />)}
            {btn(k, 'done', '出餐', 'secondary')}
          </>
        ),
    },
    {
      key: 'cooking',
      title: '制作中',
      icon: <Flame className="size-4 text-yuzu-deep" />,
      list: cooking,
      actions: (k) =>
        kitchen && (
          <>
            {btn(k, 'done', '出餐', 'primary', <CircleCheckBig className="size-3.5" />)}
            {btn(k, 'undo', '撤回', 'ghost', <Undo2 className="size-3.5" />)}
          </>
        ),
    },
  ];
  // 规则改成「出餐即算上菜」之前已出餐的菜仍在这一列，上完为止
  if (d.rules.trackServed || done.length > 0) {
    columns.push({
      key: 'done',
      title: '待上菜',
      icon: <CircleCheckBig className="size-4 text-pine" />,
      list: done,
      actions: (k) => (
        <>
          {btn(k, 'serve', '上菜', 'primary')}
          {kitchen && btn(k, 'undo', '撤回', 'ghost', <Undo2 className="size-3.5" />)}
        </>
      ),
    });
  }

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 px-5 py-5 md:px-7" data-testid="kitchen">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {stations.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto" role="radiogroup" aria-label="档口">
            {[{ id: 'all' as const, name: '全部档口' }, ...stations].map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={station === s.id}
                onClick={() => {
                  setPref(s.id);
                  writeStation(s.id);
                }}
                className={cn('h-9 shrink-0 rounded-full px-4 text-[13.5px] font-semibold whitespace-nowrap', station === s.id ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:text-ink')}
                data-testid={`kds-station-${s.name}`}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
        <p className="ml-auto text-[12.5px] text-ink-3" data-testid="kds-today">
          今日 {d.today.orders} 单 · {d.today.dishes} 份 · 已上 {d.today.served} · 退 {d.today.cancelled}
          {d.today.avgMinutes !== null && ` · 平均 ${d.today.avgMinutes} 分钟出餐`}
        </p>
      </div>
      {!kitchen && <Notice tone="info" title="出餐后在「待上菜」里点「上菜」">开始做、出餐由厨房在出品屏上操作。</Notice>}
      <div className={cn('grid grid-cols-1 gap-4', columns.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
        {columns.map((c) => (
          <section key={c.key} className="min-w-0 rounded-lg bg-paper-2/60 p-3" data-testid={`kds-col-${c.key}`}>
            <h2 className="mb-2 flex items-center gap-1.5 text-[14px] font-bold text-ink-2">
              {c.icon} {c.title} <span className="num text-ink-3">{c.list.length}</span>
            </h2>
            {c.list.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[13px] text-ink-4">没有</p>
            ) : (
              <div className="space-y-2.5">
                {c.list.map((k) => (
                  <Ticket key={k.id} k={k} now={now} warnMinutes={d.rules.warnMinutes} showStation={station === 'all' && stations.length > 1}>
                    {c.actions(k)}
                  </Ticket>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      <Card className="p-4">
        <SectionTitle
          aside={
            <Button size="sm" variant="ghost" onClick={() => setShowRecent((v) => !v)} data-testid="kds-recent-toggle">
              {showRecent ? '收起' : `看最近 ${recent.length} 道`}
            </Button>
          }
        >
          今天上过的、退了的
        </SectionTitle>
        {showRecent &&
          (recent.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-ink-3">还没有</p>
          ) : (
            <ul className="mt-2 divide-y divide-line/70" data-testid="kds-recent">
              {recent.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-[13px]">
                  <span className="num w-12 text-[12px] text-ink-3">{formatTime(k.servedAt ?? k.createdAt)}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {k.name} × {k.quantity}
                    <span className="num ml-2 font-bold text-ink-3">{whereOf(k)}</span>
                  </span>
                  <Badge tone={k.status === 'cancelled' ? 'clay' : 'lake'}>{KITCHEN_STATUS_LABELS[k.status]}</Badge>
                  {k.status === 'served' && d.rules.trackServed && btn(k, 'undo', '撤回上菜', 'ghost', <Undo2 className="size-3.5" />)}
                </li>
              ))}
            </ul>
          ))}
      </Card>
    </div>
  );
}

/** 菜送到哪里：手牌号，或「桌 A1」 */
const whereOf = (k: KitchenItem) => (k.tableName !== null ? `桌 ${k.tableName}` : (k.tagCode ?? ''));

function Ticket({ k, now, warnMinutes, showStation, children }: { k: KitchenItem; now: number; warnMinutes: number; showStation: boolean; children: React.ReactNode }) {
  const waited = kitchenElapsed(k.createdAt, now);
  const late = (k.status === 'queued' || k.status === 'cooking') && waited >= warnMinutes;
  const fresh = now - new Date(k.createdAt).getTime() < 60_000;
  return (
    <div
      className={cn('rounded-lg border bg-card p-3 shadow-card', late ? 'border-clay/70' : k.rushCount ? 'border-yuzu-deep/60' : 'border-line', fresh && 'ring-2 ring-yuzu/60')}
      data-testid={`kds-${k.id}`}
      data-dish={k.name}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[17px] leading-snug font-bold">{k.name}</span>
        <span className="num text-[20px] font-bold">×{k.quantity}</span>
      </div>
      {k.note && <p className="mt-1 rounded-md bg-yuzu-tint px-2 py-1 text-[13.5px] font-bold text-yuzu-deep">{k.note}</p>}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-ink-3">
        {/* 手牌客人按男宾 / 女宾着色；桌台的菜显示桌号 */}
        <span className={cn('num text-[14px] font-bold', k.tableName !== null ? 'text-pine' : k.zone === 'female' ? 'text-clay' : 'text-lake')}>{whereOf(k)}</span>
        <span className="min-w-0 truncate">{k.guest}</span>
        {showStation && <span>· {k.stationName}</span>}
        <span className="num text-ink-4">· {k.orderNo}</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={cn('num text-[13px] font-bold', late ? 'text-clay' : 'text-ink-2')}>
          {k.status === 'done' && k.doneAt ? `出餐 ${kitchenElapsed(k.doneAt, now)} 分钟` : `已等 ${waited} 分钟`}
        </span>
        {k.rushCount > 0 && (
          <Badge tone="clay" icon={<BellRing className="size-3" />}>
            催 {k.rushCount} 次
          </Badge>
        )}
        {k.visitClosed && <Badge tone="ember">{k.tableName !== null ? '这桌已结账' : '客人已结账'}</Badge>}
        <span className="flex flex-1 flex-wrap justify-end gap-1.5">{children}</span>
      </div>
    </div>
  );
}

/** 估清：今天某道菜还剩几份（0 为估清）；不限量就是没有限制 */
export function LimitsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const board = useKitchenBoard(30_000);
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const d = board.data;
  if (board.error && !d) return <Notice tone="error" title={errorMessage(board.error)} className="m-6" />;
  if (!d) return <Skeleton className="m-6 h-64" />;

  const save = async (dish: MenuDish, remaining: number | null) => {
    setBusy(dish.id);
    try {
      qc.setQueryData(kitchenKey, await api.put<KitchenBoard>(`/api/kitchen/limits/${dish.id}`, { remaining }));
      void qc.invalidateQueries({ queryKey: menuKey });
      setEditing(null);
      toast({ tone: 'success', title: remaining === null ? `「${dish.name}」不限量` : remaining === 0 ? `「${dish.name}」已估清` : `「${dish.name}」今天限量 ${remaining} 份` });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const groups = new Map<string, MenuDish[]>();
  for (const dish of d.dishes) groups.set(dish.stationName, [...(groups.get(dish.stationName) ?? []), dish]);
  const soldOut = d.dishes.filter((x) => x.remaining === 0).length;
  const limited = d.dishes.filter((x) => x.remaining !== null && x.remaining > 0).length;

  return (
    <div className="mx-auto max-w-[1080px] space-y-4 px-5 py-5 md:px-7" data-testid="limits">
      <p className="text-[13px] text-ink-3">
        营业日 {d.businessDate}：已估清 {soldOut} 道，限量 {limited} 道。估清只管今天，换了营业日自动恢复不限量。
      </p>
      {d.dishes.length === 0 ? (
        <Card className="px-4 py-8 text-center text-[13px] text-ink-3">还没有进厨房的菜</Card>
      ) : (
        [...groups].map(([name, list]) => (
          <Card key={name} className="p-4">
            <SectionTitle>{name}</SectionTitle>
            <ul className="mt-2 divide-y divide-line/70">
              {list.map((dish) => {
                const edit = editing?.id === dish.id ? editing : null;
                const n = edit ? Number(edit.value) : NaN;
                const valid = !!edit && edit.value.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 9999;
                return (
                  <li key={dish.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5" data-testid={`limit-${dish.name}`}>
                    <span className="min-w-[120px] flex-1 text-[14px] font-semibold">
                      {dish.name}
                      <span className="ml-2 text-[12px] font-normal text-ink-4">{dish.category}</span>
                    </span>
                    <Money cents={dish.price} className="text-[13px] text-ink-3" />
                    {dish.remaining === null ? (
                      <Badge>不限量</Badge>
                    ) : dish.remaining === 0 ? (
                      <Badge tone="clay">已估清</Badge>
                    ) : (
                      <Badge tone="yuzu">剩 {dish.remaining} 份</Badge>
                    )}
                    {edit ? (
                      <span className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={9999}
                          value={edit.value}
                          onChange={(e) => setEditing({ id: dish.id, value: e.target.value })}
                          className="num h-9 w-24"
                          aria-label={`${dish.name} 今天还剩几份`}
                          data-autofocus
                          data-testid={`limit-input-${dish.name}`}
                        />
                        <span className="text-[13px] text-ink-3">份</span>
                        <Button size="sm" variant="primary" disabled={!valid} loading={busy === dish.id} onClick={() => void save(dish, n)} data-testid={`limit-save-${dish.name}`}>
                          保存
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          取消
                        </Button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setEditing({ id: dish.id, value: dish.remaining ? String(dish.remaining) : '' })} data-testid={`limit-set-${dish.name}`}>
                          限量
                        </Button>
                        {dish.remaining !== 0 && (
                          <Button size="sm" variant="danger" loading={busy === dish.id} disabled={busy !== null} onClick={() => void save(dish, 0)} data-testid={`limit-soldout-${dish.name}`}>
                            估清
                          </Button>
                        )}
                        {dish.remaining !== null && (
                          <Button size="sm" variant="ghost" loading={busy === dish.id} disabled={busy !== null} onClick={() => void save(dish, null)} data-testid={`limit-clear-${dish.name}`}>
                            不限
                          </Button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}
