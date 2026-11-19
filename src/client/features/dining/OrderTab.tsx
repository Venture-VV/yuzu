// 点单：按手牌找在店客人，或选一张用餐中的桌（第二步）→ 点菜（份数、口味备注）→ 下单。下单就是记到客人或这桌的账上
// （与前台挂账同一套「结果待确认」：提交前本机保存原编号与原请求，断网后查回、原样重提或确认作废），同时送到厨房。
// 右边列出这位客人（这桌）还没上的菜：可以催单、上菜（服务员送到后点）、退菜（作废这条明细，要写原因）。
// 8.1.7（docs/DINING_V817.md）：菜单区先弹出餐厅 / 水吧 / 果吧三个入口，选了再按小分类点，下单成功后回到入口（CF4）；
// 「还没上的菜」旁边能打开点菜单（小票可视化，CF8）。

import { useEffect, useMemo, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Minus, PencilLine, Plus, ReceiptText, RotateCcw, Search, Trash2, Undo2, Users, UtensilsCrossed, X } from 'lucide-react';
import {
  DINING_OUTLET_LABELS,
  KITCHEN_STATUS_LABELS,
  MAX_DISH_NOTE,
  outletDef,
  type DiningGuest,
  type DiningOutlet,
  type KitchenStatus,
  type MenuDish,
  type PendingDish,
  type TableSessionDetail,
} from '@shared/dining';
import { partsText } from '@shared/dishes';
import { ZONE_LABELS } from '@shared/frontdesk';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime, uuid } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { QtyInput } from '../../components/QtyInput';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented, Skeleton, Spinner } from '../../components/ui';
import { PendingPanel, useFrontdeskOp, useFrontdeskPending } from '../frontdesk/pending';
import { guestKey, menuKey, useDiningMenu, useTableSession, useTablesBoard } from './queries';
import { DishOptionsDialog, type PickedLine } from './DishOptionsDialog';
import { DishVoidDialog } from './DishVoid';
import { ReceiptDialog, type ReceiptTarget } from './ReceiptDialog';
import { GroupChips, OutletEntry, OutletFilter } from './slots';

interface CartLine {
  key: string;
  dishId: number;
  quantity: number;
  note: string;
}

/** 常用口味备注，点一下加进备注 */
const QUICK_NOTES = ['少辣', '不辣', '不要香菜', '不要葱', '少冰', '去冰', '热的'];

const STATUS_TONE: Record<KitchenStatus, 'neutral' | 'yuzu' | 'pine' | 'lake' | 'clay'> = {
  queued: 'neutral',
  cooking: 'yuzu',
  done: 'pine',
  served: 'lake',
  cancelled: 'clay',
};

const doneOnFound = () => true as const;

export function OrderTab() {
  const session = useSession();
  /** 退菜、改单与下单同一套权限：挂到账上要「前台挂账」（桌台上的还要「点单」，这一页本来就要）（8.0.8，B02，Codex 审查 f14210c） */
  const canVoid = useCan()('frontdesk.operate');
  const qc = useQueryClient();
  const toast = useToast();
  const menu = useDiningMenu();
  const [params, setParams] = useSearchParams();
  /** 点给谁：手牌客人，或用餐中的一桌（第二步） */
  const [mode, setMode] = useState<'tag' | 'table'>('tag');
  const [tagText, setTagText] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [tableSession, setTableSession] = useState<number | null>(null);
  /** 客房点餐（8.0.20）：住店的客人可以选「送到客房」；没动过这个勾时，按房号找到的默认送、按手牌找到的默认不送 */
  const [toRoomChoice, setToRoomChoice] = useState<boolean | null>(null);
  const guest = useQuery({
    queryKey: guestKey(tag),
    queryFn: () => api.get<DiningGuest>(`/api/dining/guest?tag=${encodeURIComponent(tag!)}`),
    enabled: !!tag,
    retry: false,
    refetchInterval: 15_000,
  });
  const board = useTablesBoard(mode === 'table');
  const table = useTableSession(mode === 'table' ? tableSession : null);
  const g = mode === 'tag' && tag ? (guest.data ?? null) : null;
  const toRoom = !!g?.roomNo && (toRoomChoice ?? g.via === 'room');
  const t: TableSessionDetail | null = mode === 'table' && tableSession !== null ? (table.data ?? null) : null;
  const target: { label: string; who: string; pending: PendingDish[]; open: boolean } | null = g
    ? { label: g.tagCode, who: g.guest, pending: g.pending, open: true }
    : t
      ? { label: `桌 ${t.tableName}`, who: `${t.guests} 人 · ${t.member?.name ?? (t.guestLabel || '散客')}`, pending: t.pending, open: t.status === 'open' }
      : null;
  const [cart, setCart] = useState<CartLine[]>([]);
  // 换一位客人、换一张桌时菜篮里还有没下单的菜（店主 2026-11-14 的需求 5）：原来菜篮悄悄跟到下一位，容易记到别人账上。
  // 先问清空还是带过去；带过去的在下单处一直标着是从谁那里带来的，直到下单或清空
  const [switching, setSwitching] = useState<{ from: string; apply: () => void } | null>(null);
  const [carriedFrom, setCarriedFrom] = useState<string | null>(null);
  const [qtyHint, setQtyHint] = useState<string | null>(null);
  /** 点单分类（8.1.7，CF4）：先在菜单区弹出的三个入口里选一处（null 为还没选），再按小分类点；下单成功后回到入口 */
  const [outlet, setOutlet] = useState<DiningOutlet | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const pickOutlet = (o: DiningOutlet | null) => {
    setOutlet(o);
    setGroups([]);
  };
  /** 点菜单（小票可视化，CF8） */
  const [receipt, setReceipt] = useState<ReceiptTarget | null>(null);
  const [voiding, setVoiding] = useState<{ dish: PendingDish; mode: 'void' | 'modify' } | null>(null);
  /** 正在选做法、加料的那道菜（8.1.15 菜品管理：有做法或加料的菜点了先弹出来选） */
  const [picking, setPicking] = useState<MenuDish | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const op = useFrontdeskOp<DiningGuest | TableSessionDetail | true>({
    type: mode === 'table' ? 'table_post' : 'bill_post',
    visitId: g?.visitId ?? null,
    sessionId: mode === 'table' ? tableSession : null,
    staffName: session.staff.displayName,
    pick: doneOnFound,
  });

  // 从桌台详情点「点单」、或顶部「结果待确认」的「去处理」进来：直接选好那一桌
  const fromTable = Number(params.get('table')) || null;
  // 8.0.8（A05）：桌台点单下架时只能挂手牌点单（开着的桌在「桌台账单」里结账、退菜）。
  // 但这一桌还有待确认的桌台点单（下架前、升级前留下的）时照样进来，只为查回、原样重提或确认作废那一笔（Codex 审查 d5e0c06）；
  // 待确认时表单锁着，不能另下新单，处理完自动回到手牌点单
  const tablesOn = menu.data?.rules.tablesEnabled ?? false;
  const allPending = useFrontdeskPending();
  const tablePending = (sid: number | null) => sid !== null && allPending.some((p) => p.type === 'table_post' && !!p.sessionIds?.includes(sid));
  useEffect(() => {
    if (!fromTable || !menu.data) return;
    if (tablesOn || tablePending(fromTable)) {
      setMode('table');
      setTableSession(fromTable);
      // 从桌台点「点单」进来：先选这一单点哪里的（CF4）
      pickOutlet(null);
      op.clearError();
      if (!tablesOn) toast({ tone: 'info', title: '桌台点单已下架', body: '这里只处理这一桌那笔待确认的点单（查回、原样重提或确认作废）；新的消费请挂手牌点单' });
    } else {
      toast({ tone: 'info', title: '桌台点单已下架', body: '所有消费请挂手牌点单；这桌在「桌台账单」里照常结账、退菜' });
    }
    const next = new URLSearchParams(params);
    next.delete('table');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromTable, !!menu.data]);
  const recovering = !tablesOn && mode === 'table' && tablePending(tableSession);
  useEffect(() => {
    if (menu.data && !tablesOn && mode === 'table' && !recovering) setMode('tag');
  }, [menu.data, tablesOn, mode, recovering]);

  const dishes = useMemo(() => menu.data?.dishes ?? [], [menu.data]);
  const byId = useMemo(() => new Map(dishes.map((d) => [d.id, d])), [dishes]);
  // 这一处的菜，再按小分类筛（8.1.7）
  const inOutlet = useMemo(() => (outlet ? dishes.filter((d) => d.outlet === outlet) : []), [dishes, outlet]);
  const shown = groups.length ? inOutlet.filter((d) => groups.includes(d.group)) : inOutlet;
  const outletCounts = useMemo(() => {
    const c: Partial<Record<DiningOutlet, number>> = {};
    for (const d of dishes) c[d.outlet] = (c[d.outlet] ?? 0) + 1;
    return c;
  }, [dishes]);
  const groupCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const d of inOutlet) c[d.group] = (c[d.group] ?? 0) + 1;
    return c;
  }, [inOutlet]);
  const countOf = (id: number) => cart.reduce((s, l) => s + (l.dishId === id ? l.quantity : 0), 0);
  const lines = cart.map((l) => ({ ...l, dish: byId.get(l.dishId) ?? null }));
  const total = lines.reduce((s, l) => s + (l.dish ? l.dish.price * l.quantity : 0), 0);
  const short = dishes.find((d) => d.remaining !== null && countOf(d.id) > d.remaining) ?? null;
  const problem = !target
    ? mode === 'tag'
      ? '先输入手牌号找到客人'
      : '先选一张用餐中的桌'
    : !target.open
      ? '这桌已经结账或撤台，不能再点单'
      : cart.length === 0
        ? '点了菜才能下单'
        : lines.some((l) => !l.dish)
          ? '有菜刚下架了，请从已点的菜里删掉'
          : short
            ? short.remaining === 0
              ? `「${short.name}」今天已沽清，请删掉或换一道`
              : `「${short.name}」今天只剩 ${short.remaining} 份`
            : null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['dining'] });
    void qc.invalidateQueries({ queryKey: ['frontdesk'] });
  };

  /** 要换点单对象了：菜篮空着、或者现在还没找到人（没有可以记错的对象）直接换；否则先问 */
  const askSwitch = (apply: () => void) => {
    if (op.locked) return;
    if (cart.length === 0 || !target) return apply();
    setSwitching({ from: target.label, apply });
  };
  const find = () => {
    const code = tagText.trim();
    if (!code) return;
    const go = () => {
      setToRoomChoice(null);
      setTag(code);
      op.clearError();
    };
    // 已经找到一位客人、又输了另一个手牌号（或房号）：也是换人。按房号找到的客人，再按同一个房号找不算
    if (g && code.toUpperCase() !== g.tagCode.toUpperCase() && code !== tag) askSwitch(go);
    else go();
  };

  const add = (d: MenuDish) => {
    if (d.remaining === 0) return;
    // 有做法或加料的菜：先选（DishOptionsDialog），选好了再加进已点
    if (d.methods?.length || d.addons?.length) return setPicking(d);
    setCart((c) => {
      // 同一道菜没写备注的合成一行；写了备注的另起一行（同一桌两份，一份少辣一份正常）
      const i = c.findIndex((l) => l.dishId === d.id && !l.note.trim());
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l));
      return [...c, { key: uuid(), dishId: d.id, quantity: 1, note: '' }];
    });
    op.clearError();
  };
  /** 选好做法、加料的那几行加进已点：带了做法、备注的另起一行，加料各一行（备注「配 某菜」）；什么都没带的照旧合进没备注的那一行 */
  const addPicked = (picked: PickedLine[]) => {
    setCart((c) => {
      let next = c;
      for (const p of picked) {
        const i = p.note ? -1 : next.findIndex((l) => l.dishId === p.dishId && !l.note.trim());
        next = i >= 0 ? next.map((l, j) => (j === i ? { ...l, quantity: Math.min(99, l.quantity + p.quantity) } : l)) : [...next, { key: uuid(), ...p }];
      }
      return next;
    });
    setPicking(null);
    op.clearError();
  };
  const update = (key: string, patch: Partial<CartLine>) => {
    if (patch.quantity !== undefined) setQtyHint(null);
    setCart((c) => c.map((l) => (l.key === key ? { ...l, ...patch } : l)).filter((l) => l.quantity > 0));
  };
  const emptyCart = () => {
    setCart([]);
    setCarriedFrom(null);
    setQtyHint(null);
  };
  useEffect(() => {
    if (cart.length === 0) setCarriedFrom(null);
  }, [cart.length]);
  const addNote = (l: CartLine, word: string) => {
    const parts = l.note.split(/[，,、\s]+/).filter(Boolean);
    if (parts.includes(word)) return;
    update(l.key, {
      note: [...parts, word].join('，').slice(0, MAX_DISH_NOTE),
    });
  };

  const submit = async () => {
    if (problem || !target) return;
    const named = lines.map((l) => ({
      name: l.dish!.name,
      quantity: l.quantity,
      note: l.note.trim(),
    }));
    const orderLines = lines.map((l) => ({
      itemId: l.dishId,
      quantity: l.quantity,
      ...(l.note.trim() ? { note: l.note.trim() } : {}),
    }));
    const summary = `点单 ${named.map((n) => `${n.name}×${n.quantity}${n.note ? `（${n.note}）` : ''}`).join('、')}`.slice(0, 120);
    const ok = await op.submit((key) =>
      t
        ? {
            url: `/api/dining/tables/sessions/${t.id}/orders`,
            body: { clientKey: key, lines: orderLines, expectedTotal: total },
            tagCodes: [`桌 ${t.tableName}`],
            summary,
            amount: total,
          }
        : {
            url: '/api/dining/orders',
            body: { clientKey: key, visitId: g!.visitId, lines: orderLines, expectedTotal: total, ...(toRoom ? { toRoom: true } : {}) },
            tagCodes: [toRoom ? `${g!.tagCode} · 客房 ${g!.roomNo}` : g!.tagCode],
            summary,
            amount: total,
          },
    );
    if (ok) {
      emptyCart();
      // 下单成功后回到餐厅 / 水吧 / 果吧三个入口，下一单再选（CF4）
      pickOutlet(null);
      toast({
        tone: 'success',
        title: `${target.label} 已下单`,
        body: `${named.reduce((s, n) => s + n.quantity, 0)} 份菜已送到厨房，${t ? '记在这桌的账上' : '挂在客人账上'}，结账时一起结。右边「点菜单」里看上菜进度。`,
      });
      refresh();
    } else {
      // 下单没成功（例如余量不够、沽清了）：马上刷新菜单与余量（8.0.8，B03）
      void qc.invalidateQueries({ queryKey: menuKey });
    }
  };

  const switchMode = (m: 'tag' | 'table') => {
    if (op.locked || m === mode) return;
    askSwitch(() => {
      setMode(m);
      op.clearError();
    });
  };
  const openTables = (board.data?.tables ?? []).filter((x) => x.session);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast({ tone: 'success', title: ok });
      return true;
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      return false;
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-5 px-5 py-5 md:px-7 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="dining-order">
      <div className="min-w-0 space-y-4">
        <Card className="p-4">
          {tablesOn ? (
            <Segmented
              ariaLabel="点给谁"
              size="sm"
              value={mode}
              onChange={switchMode}
              options={[
                { value: 'tag', label: '手牌客人' },
                { value: 'table', label: '桌台' },
              ]}
              className="mb-3"
            />
          ) : (
            <p className="mb-3 text-[12.5px] text-ink-3" data-testid="dining-tag-only">
              按手牌点单：所有消费都挂在客人的手牌上（桌台点单已下架）
            </p>
          )}
          {mode === 'tag' ? (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                find();
              }}
            >
              <Field label="手牌号或房号" htmlFor="dining-tag">
                <Input
                  id="dining-tag"
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value.toUpperCase())}
                  placeholder="例如 A008"
                  autoComplete="off"
                  maxLength={16}
                  className="num w-40 text-[18px] font-bold"
                  data-testid="dining-tag"
                />
              </Field>
              <Button type="submit" variant="secondary" icon={<Search className="size-4" />} disabled={!tagText.trim()} data-testid="dining-find">
                找客人
              </Button>
              <div className="min-w-0 flex-1 basis-full self-center sm:basis-auto">
                {!tag ? (
                  <p className="text-[13px] text-ink-3">输入客人手牌上的号码；住店的客人也可以输房号</p>
                ) : guest.isPending ? (
                  <Spinner />
                ) : guest.error ? (
                  <p className="text-[13.5px] font-semibold text-clay" data-testid="dining-guest-error">
                    {errorMessage(guest.error)}
                  </p>
                ) : (
                  g && (
                    <div className="flex flex-wrap items-center gap-2" data-testid="dining-guest">
                      <Badge tone={g.zone === 'female' ? 'clay' : 'lake'}>{ZONE_LABELS[g.zone].title}</Badge>
                      <span className="num text-[18px] font-bold">{g.tagCode}</span>
                      <span className="text-[15px] font-semibold">{g.guest}</span>
                      {g.roomNo && (
                        <label className="ml-1 inline-flex items-center gap-1.5 rounded-md bg-paper-2 px-2 py-1 text-[13px] font-semibold" data-testid="dining-to-room">
                          <input type="checkbox" checked={toRoom} onChange={(e) => setToRoomChoice(e.target.checked)} />
                          送到客房 {g.roomNo}
                        </label>
                      )}
                      <button
                        type="button"
                        className="ml-1 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[12.5px] font-semibold text-ink-3 hover:bg-paper-2 hover:text-ink"
                        onClick={() =>
                          askSwitch(() => {
                            setTag(null);
                            setTagText('');
                            setToRoomChoice(null);
                          })
                        }
                        data-testid="dining-switch-guest"
                      >
                        <X className="size-3.5" /> 换一位
                      </button>
                    </div>
                  )
                )}
              </div>
            </form>
          ) : (
            <TablePicker
              loading={board.isPending}
              tables={openTables.map((x) => ({ sessionId: x.session!.id, name: x.name, guests: x.session!.guests, guest: x.session!.memberName ?? (x.session!.guestLabel || '散客') }))}
              selected={tableSession}
              detail={t}
              error={table.error}
              locked={op.locked}
              onPick={(id) => {
                const go = () => {
                  setTableSession(id);
                  op.clearError();
                };
                // 已经选着一张桌、又点了另一张：也是换对象
                if (t && id !== tableSession) askSwitch(go);
                else go();
              }}
            />
          )}
        </Card>

        <Card className="p-4" data-testid="dining-menu">
          <SectionTitle aside={menu.data && <span className="text-[12px] text-ink-3">营业日 {menu.data.businessDate}</span>}>{outlet ? `菜单 · ${DINING_OUTLET_LABELS[outlet]}` : '菜单'}</SectionTitle>
          {menu.isPending ? (
            <Skeleton className="mt-3 h-48" />
          ) : menu.isError && !menu.data ? (
            // 菜单没取回来：不是「还没有菜」，给重试；已经点的菜、找到的客人都不动（需求 4 的同类问题）
            <LoadFailed title="菜单加载失败，请检查网络" onRetry={() => void menu.refetch()} retrying={menu.isFetching} className="mt-3" testId="dining-menu-error">
              菜单没有取回来，不是没有菜。点「重试」再取一次。
            </LoadFailed>
          ) : dishes.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">
              还没有进厨房的菜。请店主在「后台 → 餐饮」建出品档口，并把菜挂到档口上。
            </p>
          ) : outlet === null ? (
            // 二级菜单（8.1.7，CF4）：一进来、每次下单成功后都先弹出这三个入口
            <OutletEntry dishes={dishes} onPick={pickOutlet} disabled={op.locked} />
          ) : (
            <div className="animate-dialog-in" key={outlet}>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <OutletFilter value={outlet} onChange={(o) => o && pickOutlet(o)} withAll={false} counts={outletCounts} testPrefix="dining" size="sm" />
                <button
                  type="button"
                  onClick={() => pickOutlet(null)}
                  className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] font-semibold text-ink-3 hover:bg-paper-2 hover:text-ink"
                  data-testid="dining-outlet-back"
                >
                  <RotateCcw className="size-3.5" /> 重新选
                </button>
              </div>
              {outletDef(outlet).groups.length > 0 && (
                <div className="mt-2.5">
                  <GroupChips outlet={outlet} value={groups} onChange={setGroups} testPrefix="dining" counts={groupCounts} />
                </div>
              )}
              {shown.length === 0 ? (
                <p className="mt-3 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3" data-testid="dining-outlet-empty">
                  {DINING_OUTLET_LABELS[outlet]}
                  {groups.length ? `的「${groups.join('、')}」` : ''}还没有菜。店主在「后台 → 餐饮 → 出品档口与菜品」里给菜选点单分类。
                </p>
              ) : groups.length === 0 && outletDef(outlet).groups.length > 1 ? (
                // 「全部」：按小分类分段排
                outletDef(outlet)
                  .groups.map((g) => ({ g, list: shown.filter((d) => d.group === g) }))
                  .filter((x) => x.list.length > 0)
                  .map(({ g, list }) => (
                    <section key={g} className="mt-3" data-testid={`dining-menu-group-${g}`}>
                      <h4 className="mb-1.5 text-[12.5px] font-bold text-ink-3">{g}</h4>
                      <DishGrid list={list} countOf={countOf} add={add} locked={op.locked} />
                    </section>
                  ))
              ) : (
                <div className="mt-3">
                  <DishGrid list={shown} countOf={countOf} add={add} locked={op.locked} />
                </div>
              )}
              <p className="mt-2 text-[12px] text-ink-4" data-testid="dining-remaining-hint">
                「剩 N」是厨房在「沽清」里设的今天还能卖几份，没写的不限量；别的终端点了菜，10 秒内跟上。
              </p>
            </div>
          )}
        </Card>
      </div>

      <div className="space-y-4 lg:sticky lg:top-5 lg:self-start">
        <Card className="p-4" data-testid="dining-cart">
          <SectionTitle
            aside={
              cart.length > 0 &&
              !op.locked && (
                <button type="button" className="text-[12.5px] font-semibold text-ink-3 hover:text-ink" onClick={emptyCart} data-testid="dining-cart-clear">
                  清空
                </button>
              )
            }
          >
            <span className="flex items-center gap-1.5">
              <UtensilsCrossed className="size-4 text-pine" /> 已点 {cart.length ? `${cart.reduce((s, l) => s + l.quantity, 0)} 份` : ''}
            </span>
          </SectionTitle>
          <div className="mt-3">
            <PendingPanel
              op={op}
              onResolved={() => {
                emptyCart();
                refresh();
              }}
            />
          </div>
          {/* 这一单记到谁账上：手牌号（桌号）、客人、份数放在最上面，下单前一眼看得到（需求 5） */}
          {target && cart.length > 0 && (
            <div className="mb-3 rounded-lg border border-pine/25 bg-pine-tint px-3 py-2" data-testid="dining-target">
              <p className="text-[11.5px] font-semibold text-ink-3">这一单记到</p>
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="num text-[22px] leading-tight font-bold text-pine">{target.label}</span>
                <span className="text-[14.5px] font-bold">{target.who}</span>
                <span className="num ml-auto text-[13.5px] font-bold text-ink-2">{cart.reduce((s, l) => s + l.quantity, 0)} 份</span>
              </p>
              {/* 客房点餐（8.0.20）：勾了「送到客房」时在这里也写明送到哪一间 */}
              {toRoom && g?.roomNo && (
                <p className="text-[12.5px] font-semibold text-ink-2" data-testid="dining-target-room">
                  送到客房 <span className="num">{g.roomNo}</span>
                </p>
              )}
            </div>
          )}
          {carriedFrom && cart.length > 0 && (
            <Notice tone="warning" className="mb-3" title={`这些菜是从 ${carriedFrom} 带过来的`} data-testid="dining-carried">
              {target ? `现在会记到 ${target.label} 的账上，下单前请核对；不对就点「清空」。` : '找到下一位客人后会记到他的账上，下单前请核对；不对就点「清空」。'}
            </Notice>
          )}
          {cart.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[13px] text-ink-3">点菜单里的菜加进来</p>
          ) : (
            <ul className="space-y-2.5">
              {lines.map((l, i) => (
                <li key={l.key} className="rounded-lg border border-line px-3 py-2" data-testid={`dining-line-${i}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {/* 窄屏（手机点单）上菜名单独一行，份数与金额换到下一行 */}
                    <span className={cn('min-w-0 flex-1 basis-32 truncate text-[14px] font-bold', !l.dish && 'text-clay line-through')}>{l.dish?.name ?? '已下架'}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        className="flex size-8 items-center justify-center rounded-full bg-paper-2 hover:bg-paper-3"
                        onClick={() => update(l.key, { quantity: l.quantity - 1 })}
                        aria-label="少一份"
                        disabled={op.locked}
                      >
                        {l.quantity === 1 ? <Trash2 className="size-3.5" /> : <Minus className="size-3.5" />}
                      </button>
                      <QtyInput
                        value={l.quantity}
                        onChange={(n) => update(l.key, { quantity: n })}
                        onHint={setQtyHint}
                        label={`${l.dish?.name ?? '已下架的菜'} 的份数`}
                        disabled={op.locked}
                        className="h-8 w-9 text-[15px]"
                        testId={`dining-qty-${i}`}
                      />
                      <button
                        type="button"
                        className="flex size-8 items-center justify-center rounded-full bg-paper-2 hover:bg-paper-3"
                        onClick={() =>
                          update(l.key, {
                            quantity: Math.min(99, l.quantity + 1),
                          })
                        }
                        aria-label="多一份"
                        disabled={op.locked}
                      >
                        <Plus className="size-3.5" />
                      </button>
                      {l.dish && <Money cents={l.dish.price * l.quantity} className="w-16 justify-end text-[13.5px] font-bold" />}
                    </span>
                  </div>
                  {/* 套餐（8.1.15）：含的几样写出来，出品单上也会列 */}
                  {l.dish?.combo && (
                    <p className="mt-0.5 text-[12px] text-ink-3" data-testid={`dining-line-combo-${i}`}>
                      套餐含 {partsText(l.dish.combo)}
                    </p>
                  )}
                  <Input
                    value={l.note}
                    onChange={(e) => update(l.key, { note: e.target.value })}
                    maxLength={MAX_DISH_NOTE}
                    placeholder="口味备注（选填）"
                    disabled={op.locked}
                    className="mt-1.5 h-9 text-[13px]"
                    data-testid={`dining-note-${i}`}
                  />
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {QUICK_NOTES.map((w) => (
                      <button
                        key={w}
                        type="button"
                        className="h-6 rounded-full bg-paper-2 px-2 text-[11.5px] font-semibold text-ink-3 hover:text-ink"
                        onClick={() => addNote(l, w)}
                        disabled={op.locked}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {qtyHint && cart.length > 0 && (
            <p className="mt-2 text-[12.5px] font-semibold text-clay" role="status" data-testid="dining-qty-hint">
              {qtyHint}
            </p>
          )}
          {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-3" />}
          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
            <span className="min-w-0 flex-1 text-[13px] text-ink-3">
              {problem ? (
                <span className="text-clay">{problem}</span>
              ) : (
                <>
                  合计 <Money cents={total} className="text-[18px] font-bold text-ink" />
                </>
              )}
            </span>
            <Button variant="primary" size="lg" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="dining-submit">
              {target ? `下单 · ${target.label}` : '下单'}
            </Button>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">下单就是记到客人或这桌的账上（不是收款），结账时一起结。点错了在下面「还没上的菜」里退菜。</p>
        </Card>

        {target && (
          <Card className="p-4" data-testid="dining-pending">
            <SectionTitle
              aside={
                // 点菜单（8.1.7，CF8）：这桌（这位客人）点过的菜，每道标已上 / 未上
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ReceiptText className="size-3.5" />}
                  onClick={() => setReceipt(t ? { session: t.id } : { visit: g!.visitId })}
                  data-testid="dining-receipt-open"
                >
                  点菜单
                </Button>
              }
            >
              还没上的菜 {target.pending.length ? target.pending.length : ''}
            </SectionTitle>
            {!canVoid && target.pending.length > 0 && (
              <p className="mt-1 text-[11.5px] text-ink-4" data-testid="dining-void-no-permission">
                退菜、改单与下单一样要有「前台挂账」权限，请找前台同事。
              </p>
            )}
            {target.pending.length === 0 ? (
              <p className="mt-2 text-[12.5px] text-ink-3">{t ? '这桌点的菜都上齐了' : '这位客人点的菜都上齐了'}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line/70">
                {target.pending.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2" data-testid={`dining-pending-${p.name}`}>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
                      {p.name} × {p.quantity}
                      {p.note && <span className="ml-1 text-[12px] font-bold text-yuzu-deep">{p.note}</span>}
                    </span>
                    <Badge tone={STATUS_TONE[p.status]}>{KITCHEN_STATUS_LABELS[p.status]}</Badge>
                    {p.rushCount > 0 && <Badge tone="clay">催 {p.rushCount}</Badge>}
                    <span className="flex w-full items-center justify-end gap-1">
                      <span className="mr-auto text-[11.5px] text-ink-4">{formatTime(p.createdAt)} 下单</span>
                      {p.status === 'done' ? (
                        <Button
                          size="sm"
                          variant="primary"
                          loading={busy === `serve-${p.id}`}
                          onClick={() =>
                            run(
                              `serve-${p.id}`,
                              () =>
                                api.post(`/api/kitchen/items/${p.id}/serve`, {
                                  from: 'done',
                                }),
                              `${p.name} 已上菜`,
                            )
                          }
                          data-testid={`dining-serve-${p.id}`}
                        >
                          上菜
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<BellRing className="size-3.5" />}
                          loading={busy === `rush-${p.id}`}
                          onClick={() => run(`rush-${p.id}`, () => api.post(`/api/dining/items/${p.id}/rush`), `已催 ${p.name}`)}
                          data-testid={`dining-rush-${p.id}`}
                        >
                          催单
                        </Button>
                      )}
                      {canVoid && (
                        <>
                          <Button size="sm" variant="ghost" icon={<PencilLine className="size-3.5" />} onClick={() => setVoiding({ dish: p, mode: 'modify' })} data-testid={`dining-modify-${p.id}`}>
                            改
                          </Button>
                          <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => setVoiding({ dish: p, mode: 'void' })} data-testid={`dining-void-${p.id}`}>
                            退菜
                          </Button>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {switching &&
        (() => {
          const named = lines.map((l) => `${l.dish?.name ?? '已下架的菜'} ×${l.quantity}`);
          const count = cart.reduce((n, l) => n + l.quantity, 0);
          const done = (keep: boolean) => {
            const { from, apply } = switching;
            setSwitching(null);
            if (keep) setCarriedFrom((prev) => prev ?? from);
            else emptyCart();
            apply();
          };
          return (
            <Dialog
              open
              onClose={() => setSwitching(null)}
              title="菜篮里还有没下单的菜"
              description={`现在是 ${switching.from} 的菜篮`}
              footer={
                <>
                  <Button variant="secondary" onClick={() => done(true)} data-testid="dining-switch-keep">
                    保留并换人
                  </Button>
                  <Button variant="primary" onClick={() => done(false)} data-autofocus data-testid="dining-switch-clear">
                    清空菜篮
                  </Button>
                </>
              }
            >
              <div className="space-y-2 text-[14px]" data-testid="dining-switch">
                <p>
                  当前有 <b className="num">{count}</b> 份未下单的菜品（{named.slice(0, 3).join('、')}
                  {named.length > 3 ? ' 等' : ''}），要带走给下一位客人还是清空？
                </p>
                <p className="text-[12.5px] text-ink-3">清空：这些菜不要了，下一位从空的菜篮开始。保留并换人：菜跟到下一位，下单时记在下一位的账上。点右上角关闭则不换人。</p>
              </div>
            </Dialog>
          );
        })()}

      <ReceiptDialog target={receipt} onClose={() => setReceipt(null)} />

      <DishOptionsDialog
        dish={picking}
        remainingOf={(id) => {
          const left = byId.get(id)?.remaining ?? null;
          return left === null ? null : left - countOf(id);
        }}
        onClose={() => setPicking(null)}
        onAdd={addPicked}
      />

      <DishVoidDialog
        dish={
          voiding
            ? {
                billLineId: voiding.dish.billLineId,
                name: voiding.dish.name,
                quantity: voiding.dish.quantity,
                amount: voiding.dish.amount,
                postedBy: voiding.dish.postedBy,
                postedAt: voiding.dish.postedAt,
                served: voiding.dish.status === 'done',
              }
            : null
        }
        mode={voiding?.mode ?? 'void'}
        // 桌台的明细在桌台账单上，退菜走桌台的接口；手牌客人的照旧走前台作废
        url={voiding ? (t ? `/api/dining/tables/lines/${voiding.dish.billLineId}/void` : `/api/frontdesk/lines/${voiding.dish.billLineId}/void`) : ''}
        onClose={() => setVoiding(null)}
        onDone={() => {
          const v = voiding!;
          setVoiding(null);
          refresh();
          if (v.mode === 'modify') {
            // 改单（8.0.8，B02）：退掉以后放回购物车，改数量或换菜再下单
            setCart((c) => [...c, { key: uuid(), dishId: v.dish.itemId, quantity: v.dish.quantity, note: v.dish.note }]);
            toast({ tone: 'success', title: `${v.dish.name} 已退，放回了购物车`, body: '改好数量或换菜后点「下单」' });
          } else toast({ tone: 'success', title: `${v.dish.name} 已退` });
        }}
      />
    </div>
  );
}

/** 桌台点单：选一张用餐中的桌（开台在「桌台」页） */
/** 一组菜（8.1.7 抽出来：「全部」时按小分类分段，每段一组） */
function DishGrid({ list, countOf, add, locked }: { list: MenuDish[]; countOf: (id: number) => number; add: (d: MenuDish) => void; locked: boolean }) {
  return (
    // 手持点单机（商米 V3，窄屏）一行一道，菜名不被挤成一列；平板、收银机两到三列
    <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
      {list.map((d) => {
        const n = countOf(d.id);
        const out = d.remaining === 0;
        return (
          <button
            key={d.id}
            type="button"
            onClick={() => add(d)}
            disabled={out || locked}
            className={cn(
              'relative flex min-h-[64px] flex-col items-start rounded-lg border px-3 py-2.5 text-left transition-colors min-[480px]:min-h-[76px]',
              out ? 'cursor-not-allowed border-line bg-paper-2/60 opacity-60' : n ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-pine',
            )}
            data-testid={`dining-dish-${d.name}`}
          >
            <span className="pr-8 text-[14.5px] leading-snug font-bold">{d.name}</span>
            {/* 菜品管理（8.1.15）：套餐写出含哪几样；有做法、加料的点了先选 */}
            {d.combo && <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-3">含 {partsText(d.combo)}</span>}
            {(d.methods || d.addons) && <span className="mt-0.5 text-[12px] font-semibold text-pine">可选{[d.methods && '做法', d.addons && '加料'].filter(Boolean).join('、')}</span>}
            <span className="mt-auto flex w-full items-center gap-1.5 pt-1">
              <Money cents={d.price} className="text-[13.5px] font-bold text-ink-2" />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-4">{d.stationName}</span>
              {out ? <Badge tone="clay">已沽清</Badge> : d.remaining !== null && <Badge tone="yuzu">剩 {d.remaining}</Badge>}
            </span>
            {n > 0 && <span className="num absolute top-2 right-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-pine px-1.5 text-[12.5px] font-bold text-paper">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

function TablePicker({
  loading,
  tables,
  selected,
  detail,
  error,
  locked,
  onPick,
}: {
  loading: boolean;
  tables: { sessionId: number; name: string; guests: number; guest: string }[];
  selected: number | null;
  detail: TableSessionDetail | null;
  error: unknown;
  locked: boolean;
  onPick: (sessionId: number) => void;
}) {
  if (loading) return <Spinner />;
  return (
    <div data-testid="dining-table-picker">
      {tables.length === 0 && !detail ? (
        <p className="text-[13px] text-ink-3">
          现在没有用餐中的桌。先到{' '}
          <NavLink to="/dining/tables" className="font-semibold text-pine hover:underline">
            桌台
          </NavLink>{' '}
          开台，再回来点单。
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {tables.map((x) => {
            const on = x.sessionId === selected;
            return (
              <button
                key={x.sessionId}
                type="button"
                aria-pressed={on}
                disabled={locked && !on}
                onClick={() => onPick(x.sessionId)}
                title={`${x.guests} 人 · ${x.guest}`}
                className={cn(
                  'flex h-10 items-center gap-1.5 rounded-full border px-3 text-[14px] font-bold disabled:opacity-40',
                  on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                )}
                data-testid={`dining-table-${x.name}`}
              >
                <span className="num">桌 {x.name}</span>
                <span className="flex items-center gap-0.5 text-[11.5px] font-semibold opacity-70">
                  <Users className="size-3" />
                  {x.guests}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {selected !== null &&
        (error ? (
          <p className="mt-2 text-[13.5px] font-semibold text-clay">{errorMessage(error)}</p>
        ) : detail ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-ink-2" data-testid="dining-table-selected">
            <span className="num text-[18px] font-bold text-ink">桌 {detail.tableName}</span>
            <span>
              {detail.guests} 人 · {detail.member?.name ?? (detail.guestLabel || '散客')}
            </span>
            <span className="text-ink-3">
              已点 <Money cents={detail.amount} className="font-bold" />
            </span>
            {detail.status !== 'open' && <Badge tone="clay">{detail.status === 'settled' ? '已结账' : '已撤台'}</Badge>}
          </p>
        ) : (
          <Spinner />
        ))}
    </div>
  );
}
