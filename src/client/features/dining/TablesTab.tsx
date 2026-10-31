// 桌台（S5 第二步）：不洗浴的客人在桌台上用餐，一桌一张账单，单独结账。
// 按区域的桌台格子：点空闲的桌开台（人数、称呼、可登记会员）；点用餐中的桌看这一桌：明细与出品状态（催单、上菜、退菜）、
// 点单、改人数与会员、转台（写原因）、撤台（没有有效明细时）、结账（与手牌结账同一套收款）。
// 开台、桌台点单、桌台结账与前台一样有「结果待确认」：断网后查回、原样重提或确认作废。

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, BellRing, Minus, Pencil, Plus, ReceiptText, Search, Undo2, UserRound, Users, UtensilsCrossed, X } from 'lucide-react';
import type { CheckoutDetail } from '@shared/checkout';
import { KITCHEN_STATUS_LABELS, type KitchenStatus, type PendingDish, type TableSessionDetail, type TablesBoard } from '@shared/dining';
import { maskPhone } from '@shared/labels';
import type { MemberSummary } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { useMembers } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { CheckoutRecordsDialog } from '../frontdesk/CheckoutDialog';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { stayText } from '../frontdesk/queries';
import { TableCheckoutDialog } from './TableCheckoutDialog';
import { tablesKey, useServerNow, useTableSession, useTablesBoard } from './queries';

type Tile = TablesBoard['tables'][number];

const STATUS_TONE: Record<KitchenStatus, 'neutral' | 'yuzu' | 'pine' | 'lake' | 'clay'> = {
  queued: 'neutral',
  cooking: 'yuzu',
  done: 'pine',
  served: 'lake',
  cancelled: 'clay',
};

const guestOf = (s: { memberName: string | null; guestLabel: string }) => s.memberName ?? (s.guestLabel || '散客');

export function TablesTab() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const board = useTablesBoard();
  const now = useServerNow(board.data?.serverTime, 30_000);
  const [opening, setOpening] = useState<Tile | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [checkoutFor, setCheckoutFor] = useState<number | null>(null);
  const [records, setRecords] = useState(false);
  const canOpen = can('dining.order') && can('frontdesk.operate');

  // 顶部「结果待确认」的「去处理」：开台回到那张桌台的开台对话框，桌台结账回到那一桌的结账
  const resume = params.get('resume');
  useEffect(() => {
    if (!resume || !board.data) return;
    const t = Number(params.get('t')) || null;
    const s = Number(params.get('s')) || null;
    if (resume === 'table_open' && t) {
      const tile = board.data.tables.find((x) => x.id === t);
      if (tile) setOpening(tile);
    } else if (resume === 'table_checkout' && s) {
      setCheckoutFor(s);
    }
    const next = new URLSearchParams(params);
    for (const k of ['resume', 't', 's']) next.delete(k);
    setParams(next, { replace: true });
  }, [resume, board.data, params, setParams]);

  const tables = useMemo(() => board.data?.tables ?? [], [board.data]);
  const areas = useMemo(() => {
    const map = new Map<string, Tile[]>();
    for (const t of tables) map.set(t.area, [...(map.get(t.area) ?? []), t]);
    return [...map.entries()];
  }, [tables]);
  const busy = tables.filter((t) => t.session);
  const choices = busy.map((t) => ({ sessionId: t.session!.id, tableName: t.name, guests: t.session!.guests }));

  const click = (t: Tile) => {
    if (t.session) setSessionId(t.session.id);
    else if (canOpen) setOpening(t);
    else toast({ tone: 'info', title: `桌 ${t.name} 空闲`, body: '开台要有「餐饮点单」与「前台挂账」权限' });
  };

  const done = (detail: CheckoutDetail) => {
    setCheckoutFor(null);
    setSessionId(null);
    void qc.invalidateQueries({ queryKey: tablesKey });
    toast({ tone: 'success', title: `已结清 ${detail.checkoutNo}`, body: '桌台已空出来；结账单在「结账记录」里，可以重打或反结账。' });
  };

  if (board.isPending) return <Skeleton className="m-5 h-64 md:m-7" />;
  if (board.error) return <Notice tone="error" title={errorMessage(board.error)} className="m-5 md:m-7" />;

  return (
    <div className="mx-auto max-w-[1280px] space-y-4 px-5 py-5 md:px-7" data-testid="dining-tables-board">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[13.5px] text-ink-2">
          用餐中 <b className="num text-ink">{busy.length}</b> 桌 · <b className="num text-ink">{busy.reduce((n, t) => n + t.session!.guests, 0)}</b> 人 · 空闲{' '}
          <b className="num text-ink">{tables.length - busy.length}</b> 桌
        </span>
        <span className="flex-1" />
        {can('frontdesk.read') && (
          <Button size="sm" variant="secondary" icon={<ReceiptText className="size-4" />} onClick={() => setRecords(true)} data-testid="tables-records">
            结账记录
          </Button>
        )}
      </div>

      {tables.length === 0 ? (
        <EmptyState art="calm" title="还没有桌台" description="店主或能管理价目的岗位在「后台 → 餐饮 → 桌台」里建桌台（例如 A1、包间 1）后，这里开台、点单、结账。" />
      ) : (
        areas.map(([area, list]) => (
          <section key={area || '-'} aria-label={area || '未分区'}>
            {areas.length > 1 && <h3 className="mb-2 text-[13px] font-bold text-ink-3">{area || '未分区'}</h3>}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
              {list.map((t) => (
                <TableTile key={t.id} t={t} now={now} onClick={() => click(t)} />
              ))}
            </div>
          </section>
        ))
      )}

      {opening && (
        <OpenTableDialog
          table={opening}
          onClose={() => setOpening(null)}
          onOpened={(d) => {
            setOpening(null);
            setSessionId(d.id);
            void qc.invalidateQueries({ queryKey: tablesKey });
          }}
        />
      )}
      {sessionId !== null && (
        <SessionDialog
          id={sessionId}
          board={board.data!}
          onClose={() => setSessionId(null)}
          onCheckout={() => setCheckoutFor(sessionId)}
        />
      )}
      {checkoutFor !== null && (
        <TableCheckoutDialog
          open
          sessionId={checkoutFor}
          choices={choices}
          onClose={() => setCheckoutFor(null)}
          onDone={done}
        />
      )}
      <CheckoutRecordsDialog open={records} onClose={() => setRecords(false)} />
    </div>
  );
}

function TableTile({ t, now, onClick }: { t: Tile; now: number; onClick: () => void }) {
  const s = t.session;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-[104px] flex-col items-start rounded-lg border px-3 py-2.5 text-left transition-colors',
        s ? 'border-yuzu-deep/40 bg-yuzu-tint hover:border-yuzu-deep' : 'border-dashed border-line-strong bg-card hover:border-pine',
      )}
      data-testid={`table-tile-${t.name}`}
      data-state={s ? 'busy' : 'free'}
    >
      <span className="flex w-full items-baseline gap-2">
        <span className="num min-w-0 flex-1 truncate text-[18px] font-bold">{t.name}</span>
        {s ? (
          <span className="num flex items-center gap-0.5 text-[12.5px] font-bold text-ink-2">
            <Users className="size-3.5" />
            {s.guests}
          </span>
        ) : (
          <span className="text-[12px] text-ink-4">{t.seats} 座</span>
        )}
      </span>
      {s ? (
        <>
          <span className="mt-0.5 w-full truncate text-[12.5px] font-semibold text-ink-2">{guestOf(s)}</span>
          <span className="mt-auto flex w-full flex-wrap items-center gap-x-2 gap-y-1 pt-1.5">
            <Money cents={s.amount} className="text-[14px] font-bold" />
            <span className="num text-[11.5px] text-ink-3">{stayText(s.openedAt, now)}</span>
            {s.pendingDishes > 0 && <Badge tone="yuzu">待上 {s.pendingDishes}</Badge>}
            {!t.active && <Badge tone="clay">已停用</Badge>}
          </span>
        </>
      ) : (
        <span className="mt-auto pt-1.5 text-[12.5px] font-semibold text-pine">空闲 · 点这里开台</span>
      )}
    </button>
  );
}

/** 开台：人数（默认按座位数）、称呼、可登记会员（结账时可以用这位会员的储值） */
function OpenTableDialog({ table, onClose, onOpened }: { table: Tile; onClose: () => void; onOpened: (d: TableSessionDetail) => void }) {
  const session = useSession();
  const can = useCan();
  const toast = useToast();
  const [guests, setGuests] = useState(table.seats);
  const [label, setLabel] = useState('');
  const [member, setMember] = useState<MemberSummary | null>(null);
  const op = useFrontdeskOp<TableSessionDetail>({
    type: 'table_open',
    visitId: null,
    tableId: table.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'table_open' ? found.session : null),
  });
  const ok = Number.isInteger(guests) && guests >= 1 && guests <= 99 && label.trim().length <= 16;

  const finish = (d: TableSessionDetail) => {
    toast({ tone: 'success', title: `桌 ${d.tableName} 已开台`, body: `${d.guests} 人 · ${d.sessionNo}。点「点单」给这桌点菜。` });
    onOpened(d);
  };
  const submit = async () => {
    if (!ok) return;
    const d = await op.submit((key) => ({
      url: '/api/dining/tables/open',
      body: { clientKey: key, tableId: table.id, guests, guestLabel: label.trim(), ...(member ? { memberId: member.id } : {}) },
      tagCodes: [`桌 ${table.name}`],
      summary: `开台 ${guests} 人${member ? `（会员 ${member.name}）` : label.trim() ? `（${label.trim()}）` : ''}`,
      amount: null,
    }));
    if (d) finish(d);
  };

  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={`开台 · 桌 ${table.name}`}
      description={`${table.area ? `${table.area} · ` : ''}${table.seats} 座。开台后这桌的菜记在这桌的账上，吃完在这里结账。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="table-open-submit">
            开台
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="space-y-4" data-testid="table-open">
        <Field label="用餐人数" htmlFor="table-guests">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" icon={<Minus className="size-4" />} aria-label="少一人" disabled={op.locked || guests <= 1} onClick={() => setGuests((n) => Math.max(1, n - 1))} />
            <Input
              id="table-guests"
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              value={String(guests)}
              onChange={(e) => setGuests(Math.trunc(Number(e.target.value)) || 0)}
              disabled={op.locked}
              className="num w-20 text-center text-[18px] font-bold"
              data-testid="table-guests"
            />
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} aria-label="多一人" disabled={op.locked || guests >= 99} onClick={() => setGuests((n) => Math.min(99, n + 1))} />
          </div>
        </Field>
        <Field label="客人称呼" htmlFor="table-label" hint="选填，例如 王先生、公司聚餐">
          <Input id="table-label" value={label} maxLength={16} onChange={(e) => setLabel(e.target.value)} disabled={op.locked} data-testid="table-label" />
        </Field>
        {can('member.read') && <MemberField value={member} onChange={setMember} disabled={op.locked} />}
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}

/** 登记会员（选填）：结账时可以用这位会员的储值（桌台与客房共用，testPrefix 区分页面） */
export function MemberField({
  value,
  onChange,
  disabled,
  testPrefix = 'table',
}: {
  value: MemberSummary | { id: number; name: string; memberNo: string } | null;
  onChange: (m: MemberSummary | null) => void;
  disabled?: boolean;
  testPrefix?: string;
}) {
  const [q, setQ] = useState('');
  const members = useMembers(value ? '' : q.trim());
  if (value) {
    return (
      <Field label="会员" hint="结账时可以用这位会员的储值支付">
        <div className="flex items-center gap-3 rounded-lg border border-pine/25 bg-pine-tint px-3 py-2" data-testid={`${testPrefix}-member`}>
          <UserRound className="size-4 text-pine" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-bold">
            {value.name} <span className="num text-[12px] font-semibold text-ink-3">{value.memberNo}</span>
          </span>
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} disabled={disabled} onClick={() => onChange(null)}>
            不登记
          </Button>
        </div>
      </Field>
    );
  }
  return (
    <Field label="会员" hint="选填；登记后结账时可以用这位会员的储值支付">
      <div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="手机号 / 姓名 / 会员号" className="pl-9" aria-label="查找会员" disabled={disabled} data-testid={`${testPrefix}-member-search`} />
        </div>
        {q.trim() && (
          <ul className="mt-1.5 space-y-0.5">
            {members.data?.slice(0, 5).map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onChange(m)} className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left hover:bg-paper-2" data-testid={`${testPrefix}-member-${m.memberNo}`}>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{m.name}</span>
                  <span className="num text-[12.5px] text-ink-3">{maskPhone(m.phone)}</span>
                  <span className="num text-[12px] text-ink-4">{m.memberNo}</span>
                </button>
              </li>
            ))}
            {members.data?.length === 0 && <li className="px-3 py-1.5 text-[13px] text-ink-3">没有找到会员，可以不登记</li>}
          </ul>
        )}
      </div>
    </Field>
  );
}

/** 一桌的详情：明细与出品状态、催单、上菜、退菜；点单、改人数与会员、转台、撤台、结账 */
function SessionDialog({ id, board, onClose, onCheckout }: { id: number; board: TablesBoard; onClose: () => void; onCheckout: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const detail = useTableSession(id);
  const now = useServerNow(board.serverTime, 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<{ lineId: number; name: string; quantity: number; status: KitchenStatus | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showVoided, setShowVoided] = useState(false);
  const d = detail.data;
  const canOrder = can('dining.order') && can('frontdesk.operate');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['dining'] });
    void qc.invalidateQueries({ queryKey: ['frontdesk'] });
  };
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

  if (!d) {
    return (
      <Dialog open onClose={onClose} title="桌台">
        {detail.error ? <Notice tone="error" title={errorMessage(detail.error)} /> : <Skeleton className="h-48" />}
      </Dialog>
    );
  }

  const open = d.status === 'open';
  const active = d.lines.filter((l) => l.status === 'active');
  const voided = d.lines.filter((l) => l.status === 'voided');
  const pendingOf = (lineId: number): PendingDish | undefined => d.pending.find((p) => p.billLineId === lineId);
  const freeTables = board.tables.filter((t) => t.active && !t.session && t.id !== d.tableId);
  const guestName = d.member?.name ?? (d.guestLabel || '散客');

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      width="max-w-2xl"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <UtensilsCrossed className="size-5 text-pine" /> 桌 {d.tableName}
          <span className="text-[14px] font-semibold text-ink-3">
            {d.guests} 人 · {guestName}
          </span>
          {d.status === 'settled' && <Badge tone="lake">已结账</Badge>}
          {d.status === 'cancelled' && <Badge tone="clay">已撤台</Badge>}
        </span>
      }
      description={`${d.sessionNo} · ${formatTime(d.openedAt)} ${d.openedByName}开台 · 已用餐 ${stayText(d.openedAt, now)}${d.member ? ` · 会员 ${d.member.memberNo}` : ''}`}
      footer={
        open ? (
          <>
            <span className="mr-auto self-center text-[13px] text-ink-3">
              合计 <Money cents={d.amount} className="text-[18px] font-bold text-ink" />
            </span>
            {can('dining.order') && (
              <Button variant="secondary" size="lg" icon={<Plus className="size-4" />} onClick={() => navigate(`/dining/order?table=${d.id}`)} data-testid="table-order">
                点单
              </Button>
            )}
            {can('frontdesk.checkout') && (
              <Button variant="primary" size="lg" onClick={onCheckout} data-testid="table-checkout">
                结账 ¥{(d.amount / 100).toFixed(2)}
              </Button>
            )}
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            关闭
          </Button>
        )
      }
    >
      <div className="space-y-4" data-testid="table-session">
        {d.status === 'cancelled' && <Notice tone="warning" title={`已撤台：${d.closeReason ?? ''}`} />}
        {open && (
          <div className="flex flex-wrap gap-2">
            {canOrder && (
              <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)} data-testid="table-edit">
                改人数、会员
              </Button>
            )}
            {canOrder && (
              <Button size="sm" variant="secondary" icon={<ArrowRightLeft className="size-3.5" />} onClick={() => setMoving(true)} disabled={freeTables.length === 0} data-testid="table-move">
                转台
              </Button>
            )}
            {canOrder && active.length === 0 && (
              <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => setCancelling(true)} data-testid="table-cancel">
                撤台
              </Button>
            )}
          </div>
        )}

        <div>
          <SectionTitle
            aside={
              voided.length > 0 && (
                <button type="button" className="text-[12.5px] font-semibold text-ink-3 hover:text-ink" onClick={() => setShowVoided((x) => !x)}>
                  {showVoided ? '收起已退的' : `已退 ${voided.length} 项`}
                </button>
              )
            }
          >
            明细
          </SectionTitle>
          {active.length === 0 && !showVoided ? (
            <p className="mt-2 rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[13px] text-ink-3">还没有点菜{open && can('dining.order') ? '，点「点单」给这桌点菜' : ''}</p>
          ) : (
            <ul className="mt-2 divide-y divide-line/70 rounded-lg border border-line" data-testid="table-lines">
              {[...active, ...(showVoided ? voided : [])].map((l) => {
                const p = pendingOf(l.id);
                const isVoided = l.status === 'voided';
                return (
                  <li key={l.id} className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2', isVoided && 'opacity-60')} data-testid={`table-line-${l.name}`}>
                    <span className={cn('min-w-0 flex-1 basis-40 text-[13.5px] font-semibold', isVoided && 'line-through')}>
                      {l.name} × {l.quantity}
                      {l.kitchen?.note && <span className="ml-1 text-[12px] font-bold text-yuzu-deep">{l.kitchen.note}</span>}
                      <span className="block text-[11.5px] font-normal text-ink-4">
                        {formatTime(l.postedAt)} {l.postedByName}
                        {isVoided && ` · ${l.voidedByName ?? ''}退：${l.voidReason ?? ''}`}
                      </span>
                    </span>
                    {l.kitchen && !isVoided && <Badge tone={STATUS_TONE[l.kitchen.status]}>{KITCHEN_STATUS_LABELS[l.kitchen.status]}</Badge>}
                    {p && p.rushCount > 0 && <Badge tone="clay">催 {p.rushCount}</Badge>}
                    <Money cents={l.amount} className="w-20 justify-end text-[13.5px] font-bold" />
                    {open && !isVoided && can('dining.order') && (
                      <span className="flex w-full justify-end gap-1">
                        {p?.status === 'done' ? (
                          <Button
                            size="sm"
                            variant="primary"
                            loading={busy === `serve-${p.id}`}
                            onClick={() => void run(`serve-${p.id}`, () => api.post(`/api/kitchen/items/${p.id}/serve`, { from: 'done' }), `${l.name} 已上菜`)}
                            data-testid={`table-serve-${p.id}`}
                          >
                            上菜
                          </Button>
                        ) : p ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<BellRing className="size-3.5" />}
                            loading={busy === `rush-${p.id}`}
                            onClick={() => void run(`rush-${p.id}`, () => api.post(`/api/dining/items/${p.id}/rush`), `已催 ${l.name}`)}
                            data-testid={`table-rush-${p.id}`}
                          >
                            催单
                          </Button>
                        ) : null}
                        {canOrder && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Undo2 className="size-3.5" />}
                            onClick={() => setVoiding({ lineId: l.id, name: l.name, quantity: l.quantity, status: l.kitchen?.status ?? null })}
                            data-testid={`table-void-${l.id}`}
                          >
                            退菜
                          </Button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {d.moves.length > 0 && (
          <div className="text-[12.5px] text-ink-3">
            <p className="font-bold text-ink-2">转台记录</p>
            <ul className="mt-1 space-y-0.5">
              {d.moves.map((m, i) => (
                <li key={i}>
                  {formatDateTime(m.at)} {m.operatorName}：桌 {m.fromTable} → 桌 {m.toTable}（{m.reason}）
                </li>
              ))}
            </ul>
          </div>
        )}
        {open && !can('frontdesk.checkout') && <p className="text-[12px] text-ink-4">结账请找有「结账收款」权限的同事。</p>}
      </div>

      <ReasonDialog
        open={!!voiding}
        title={voiding ? `退菜 · ${voiding.name} × ${voiding.quantity}` : '退菜'}
        description={
          voiding
            ? `${voiding.status === 'done' || voiding.status === 'served' ? '这道菜已经出餐了。' : ''}退菜就是作废这条明细（留痕，不收这道菜的钱），厨房屏上显示「已退」${voiding.status === 'queued' || voiding.status === null ? '' : '，请当面告诉厨房'}；估清的菜按原份数加回。`
            : undefined
        }
        confirmLabel="确认退菜"
        danger
        busy={!!voiding && busy === `void-${voiding.lineId}`}
        onClose={() => setVoiding(null)}
        onConfirm={(reason) => {
          const v = voiding!;
          void run(`void-${v.lineId}`, () => api.post(`/api/dining/tables/lines/${v.lineId}/void`, { reason }), `${v.name} 已退`).then((ok) => ok && setVoiding(null));
        }}
      />
      <ReasonDialog
        open={cancelling}
        title={`撤台 · 桌 ${d.tableName}`}
        description="开错台、客人没点菜就走了时撤台：这一次开台作废（留痕），桌台空出来。已经点了菜的要先退菜或结账。"
        confirmLabel="确认撤台"
        danger
        busy={busy === 'cancel'}
        onClose={() => setCancelling(false)}
        onConfirm={(reason) => {
          void run('cancel', () => api.post(`/api/dining/tables/sessions/${d.id}/cancel`, { reason }), `桌 ${d.tableName} 已撤台`).then((ok) => {
            if (ok) {
              setCancelling(false);
              onClose();
            }
          });
        }}
      />
      {editing && <EditSessionDialog detail={d} onClose={() => setEditing(false)} onSaved={refresh} />}
      {moving && <MoveDialog detail={d} free={freeTables} onClose={() => setMoving(false)} onMoved={refresh} />}
    </Dialog>
  );
}

/** 改人数、称呼、登记的会员 */
function EditSessionDialog({ detail, onClose, onSaved }: { detail: TableSessionDetail; onClose: () => void; onSaved: () => void }) {
  const can = useCan();
  const toast = useToast();
  const [guests, setGuests] = useState(detail.guests);
  const [label, setLabel] = useState(detail.guestLabel);
  const [member, setMember] = useState<MemberSummary | { id: number; name: string; memberNo: string } | null>(detail.member);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = Number.isInteger(guests) && guests >= 1 && guests <= 99 && label.trim().length <= 16;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/dining/tables/sessions/${detail.id}`, { guests, guestLabel: label.trim(), memberId: member?.id ?? null });
      toast({ tone: 'success', title: `桌 ${detail.tableName} 已保存` });
      onSaved();
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
      title={`改人数、会员 · 桌 ${detail.tableName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={save} data-testid="table-edit-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="用餐人数" htmlFor="edit-guests" hint="报表的结账客人按人数计">
          <Input
            id="edit-guests"
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            value={String(guests)}
            onChange={(e) => setGuests(Math.trunc(Number(e.target.value)) || 0)}
            className="num w-24 text-[16px] font-bold"
            data-testid="table-edit-guests"
          />
        </Field>
        <Field label="客人称呼" htmlFor="edit-label">
          <Input id="edit-label" value={label} maxLength={16} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {can('member.read') && <MemberField value={member} onChange={setMember} />}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 转台：账单跟着这一桌走；要转去的桌必须空闲，要写原因 */
function MoveDialog({ detail, free, onClose, onMoved }: { detail: TableSessionDetail; free: Tile[]; onClose: () => void; onMoved: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = free.find((t) => t.id === to) ?? null;
  const save = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/dining/tables/sessions/${detail.id}/move`, { toTableId: target.id, reason: reason.trim() });
      toast({ tone: 'success', title: `已转到桌 ${target.name}`, body: `桌 ${detail.tableName} 空出来了；账单与点的菜跟着到桌 ${target.name}。` });
      onMoved();
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
      title={`转台 · 桌 ${detail.tableName}`}
      description="客人换桌：这一桌的账单、点的菜和出品单跟着转过去，厨房屏显示新桌号。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!target || reason.trim().length < 2} onClick={save} data-testid="table-move-save">
            {target ? `转到桌 ${target.name}` : '转台'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="转到哪一桌">
          {free.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={to === t.id}
              onClick={() => setTo(t.id)}
              className={cn('h-10 rounded-full border px-3.5 text-[14px] font-bold', to === t.id ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong')}
              data-testid={`table-move-to-${t.name}`}
            >
              <span className="num">{t.name}</span> <span className="text-[11.5px] font-semibold opacity-70">{t.seats} 座</span>
            </button>
          ))}
        </div>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="转台原因（至少 2 个字），例如：客人要靠窗" maxLength={100} aria-label="转台原因" data-testid="table-move-reason" />
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
