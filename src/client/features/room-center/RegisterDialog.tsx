// 卡片式登记（《浴族系统需求汇总》房态中心第 3 条）：点技师服务的房间卡片，填手牌号、项目、档次、技师、出单员工号、备注、开始时间，
// 一步做完挂账 + 派钟 + 占房。必填的没填不能提交（服务端再核对一遍）。挂账与前台同一套「结果待确认」：提交前本机先存原编号与原请求，
// 超时、断网以后查回、原样重提或确认作废。轮钟默认队列里第一位空闲、能做这个项目的技师；改派别人要写原因（记进钟房日志）。

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Minus, Plus } from 'lucide-react';
import { PRICE_TIER_LABELS, tierPrice, type PriceTier } from '@shared/catalog';
import type { BoardTechnician, ClockroomBoard } from '@shared/clockroom';
import { formatYuan } from '@shared/money';
import {
  MAX_ROOM_NOTE,
  MAX_SELLER_NO,
  MAX_START_BACKDATE_MINUTES,
  ROOM_START_LABELS,
  type RoomCard,
  type RoomCenterBoard,
  type RoomGuestLookup,
  type RoomSellerLookup,
  type RoomStartMode,
} from '@shared/room-center';
import { spaceLabel } from '@shared/spaces';
import { CALL_TYPE_LABELS, canServe, gradeLabel, tierFor, type CallType } from '@shared/technicians';
import { api, errorMessage } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { serverNowMs } from '../../lib/serverClock';
import { useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { QtyInput } from '../../components/QtyInput';
import { Button, Field, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { clockKey } from '../clockroom/ClockroomPage';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { roomUrl } from './queries';
import { TagField } from './TagField';

/** 钟数的加减（1–9）：加减按钮 44 像素，中间可以直接输 */
export function ClockStepper({ value, onChange, disabled, label, testId }: { value: number; onChange: (n: number) => void; disabled?: boolean; label: string; testId: string }) {
  const [hint, setHint] = useState<string | null>(null);
  const side = 'flex size-11 items-center justify-center rounded-lg border border-line-strong bg-card text-ink-2 hover:border-ink-3 disabled:text-ink-4';
  return (
    <div>
      <div className="flex items-center gap-2">
        <button type="button" className={side} aria-label="少一个钟" disabled={disabled || value <= 1} onClick={() => onChange(Math.max(1, value - 1))}>
          <Minus className="size-4" />
        </button>
        <QtyInput value={value} min={1} max={9} onChange={onChange} onHint={setHint} label={label} disabled={disabled} className="h-11 w-12 text-[18px]" testId={testId} />
        <button type="button" className={side} aria-label="多一个钟" disabled={disabled || value >= 9} onClick={() => onChange(Math.min(9, value + 1))}>
          <Plus className="size-4" />
        </button>
      </div>
      {hint && <p className="mt-1 text-[12.5px] text-clay">{hint}</p>}
    </div>
  );
}

/** 「结果待确认」查回来：按挂账的编号查到这位客人的账单，就是登记（续钟）已经生效——没有最新的看板，交给页面重新取 */
export const foundPosted = (found: { found: true } | { found: false }): true | null => (found.found && 'visit' in found ? true : null);

/** 能派钟的技师：在职、没停牌、当天在岗或休息（休假、未上牌的不列） */
const dispatchable = (t: BoardTechnician) => t.active && !t.suspendedAt && (t.state === 'on' || t.state === 'rest');
const byTechNo = (a: BoardTechnician, b: BoardTechnician) => Number(a.techNo) - Number(b.techNo) || a.techNo.localeCompare(b.techNo);
const BACKDATE_CHOICES = [5, 10, 15, 20, 30];

export function RegisterDialog({
  room,
  join = false,
  onClose,
  onDone,
  onDetail,
}: {
  room: RoomCard;
  /** 同房加人：这间房已经有客人，再登记一位 */
  join?: boolean;
  onClose: () => void;
  /** 登记好了：带着服务端回的最新看板；从「结果待确认」查回来的没有看板（null），页面自己重新取 */
  onDone: (board: RoomCenterBoard | null) => void;
  /** 打开这间房的详情（改房态、看历史） */
  onDetail?: () => void;
}) {
  const session = useSession();
  const catalog = useCatalog();
  const clock = useQuery({ queryKey: clockKey, queryFn: () => api.get<ClockroomBoard>('/api/clockroom') });
  const [tag, setTag] = useState('');
  const [guest, setGuest] = useState<RoomGuestLookup | null>(null);
  const [itemId, setItemId] = useState<number | null>(null);
  const [tier, setTier] = useState<PriceTier | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [callType, setCallType] = useState<CallType | null>(null);
  const [technicianId, setTechnicianId] = useState<number | null>(null);
  const [skipReason, setSkipReason] = useState('');
  const [sellerNo, setSellerNo] = useState(session.staff.username);
  const [note, setNote] = useState('');
  const [start, setStart] = useState<RoomStartMode>('now');
  const [minutesAgo, setMinutesAgo] = useState(10);
  const op = useFrontdeskOp<RoomCenterBoard | true>({ type: 'bill_post', visitId: guest?.visitId ?? null, staffName: session.staff.displayName, pick: foundPosted });
  const finish = (r: RoomCenterBoard | true) => onDone(r === true ? null : r);

  // 出单员：输完停一下去查这个工号是谁
  const [sellerKey, setSellerKey] = useState(sellerNo.trim());
  useEffect(() => {
    const t = setTimeout(() => setSellerKey(sellerNo.trim()), 350);
    return () => clearTimeout(t);
  }, [sellerNo]);
  const seller = useQuery({
    queryKey: ['room-center', 'seller', sellerKey],
    queryFn: () => api.get<RoomSellerLookup>(`/api/room-center/seller?no=${encodeURIComponent(sellerKey)}`),
    enabled: sellerKey !== '',
    retry: false,
    staleTime: 60_000,
  });
  const sellerOk = sellerKey !== '' && sellerKey === sellerNo.trim() && !!seller.data;

  const board = clock.data;
  const rules = board?.techRules;
  const mode: CallType = callType ?? rules?.defaultCallType ?? 'rotation';
  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active && i.technicianRequired && (!i.gender || !guest || i.gender === guest.zone)), [catalog.data, guest]);
  const item = items.find((i) => i.id === itemId) ?? null;
  const byGrade = !!rules?.tierByGrade && !!item && item.prices.length > 1;
  const cant = (t: BoardTechnician) => (item && rules ? canServe(t, item, rules.tierByGrade) : null);
  // 轮钟：在岗、空闲、能做这个项目的技师按排位，第一位就是该派的；点钟：上了牌的都能点（在钟上的要等钟）
  const queue = (board?.technicians ?? []).filter((t) => t.state === 'on' && !t.busy && !t.suspendedAt && !cant(t)).sort((a, b) => a.position! - b.position!);
  const list = mode === 'rotation' ? queue : (board?.technicians ?? []).filter(dispatchable).sort(byTechNo);
  const first = queue[0] ?? null;
  // 轮钟没选过就是队列里的第一位
  const tech = list.find((t) => t.id === technicianId) ?? (mode === 'rotation' ? first : null);
  const skipping = mode === 'rotation' && !!tech && !!first && tech.id !== first.id;
  const chosenTier: PriceTier | null = item ? (tech && rules ? tierFor(tech, item, tier ?? item.prices[0]!.tier, rules.tierByGrade) : (tier ?? item.prices[0]!.tier)) : null;
  const unit = item && chosenTier ? tierPrice(item.prices, chosenTier) : null;
  const total = unit !== null ? unit * quantity : 0;
  const waits = !!tech?.busy;
  const startedAt = start === 'at' ? new Date(serverNowMs() - minutesAgo * 60_000) : null;

  const problem = !guest
    ? '请输入在店客人的手牌号'
    : guest.registeredIn
      ? `这位客人还登记在 ${guest.registeredIn}`
      : !item
        ? '请选择项目'
        : !tech
          ? '请选择技师'
          : cant(tech)
            ? `${tech.techNo} 号${cant(tech)}`
            : unit === null
              ? '这个项目没有这一档价格'
              : skipping && board!.rules.skipNeedsReason && skipReason.trim().length < 2
                ? `轮钟应派给 ${first!.techNo} 号 ${first!.name}；要改派请写原因`
                : !sellerNo.trim()
                  ? '请填写出单员的工号'
                  : !sellerOk
                    ? seller.isError
                      ? errorMessage(seller.error)
                      : '正在核对出单员的工号'
                    : start === 'at' && waits
                      ? `${tech.techNo} 号还在钟上，这一钟要等钟，不能补记开始时间`
                      : null;

  const submit = async () => {
    if (problem || !guest || !item || !tech || !chosenTier) return;
    const where = spaceLabel(room.code, room.name);
    const done = await op.submit((key) => ({
      url: roomUrl(room.spaceId!, 'register'),
      body: {
        clientKey: key,
        tagCode: guest.tagCode,
        itemId: item.id,
        tier: byGrade ? undefined : chosenTier,
        quantity,
        technicianId: tech.id,
        callType: mode,
        skipReason: skipping ? skipReason.trim() : undefined,
        sellerNo: seller.data!.no,
        note: note.trim(),
        start,
        startedAt: startedAt?.toISOString(),
        join,
        expectedTotal: total,
      },
      tagCodes: [guest.tagCode],
      summary: `房态登记 ${where}：${item.name} × ${quantity}（${tech.techNo} 号 ${tech.name} · ${CALL_TYPE_LABELS[mode]}，出单员 ${seller.data!.name}）`,
      amount: total,
    }));
    if (done) finish(done);
  };

  const pickCallType = (v: CallType) => {
    setCallType(v);
    setTechnicianId(null);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      width="max-w-3xl"
      title={`${join ? '同房加人' : '登记'} · ${spaceLabel(room.code, room.name)}`}
      description="登记 = 挂账 + 派钟 + 占房，一步做完。挂账不是收款，账记在客人的手牌上，离店时在收银台结。"
      footer={
        <>
          {onDetail && (
            <Button variant="ghost" className="mr-auto" onClick={onDetail} disabled={op.busy} data-testid="rc-register-detail">
              房间详情
            </Button>
          )}
          <span className="self-center text-[13px] text-ink-3" data-testid="rc-register-total">
            {problem ? (
              <span className="text-clay">{problem}</span>
            ) : (
              <>
                合计 <Money cents={total} className="text-[18px] font-bold text-ink" />
              </>
            )}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="rc-register-submit">
            {start === 'later' || waits ? '登记（待上钟）' : '登记并上钟'}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      {clock.isError && !board ? (
        <LoadFailed title="技师没取回来" onRetry={() => void clock.refetch()} retrying={clock.isFetching} />
      ) : catalog.isError && !catalog.data ? (
        <LoadFailed title="项目没取回来" onRetry={() => void catalog.refetch()} retrying={catalog.isFetching} />
      ) : !board || !catalog.data ? (
        <Skeleton className="h-72" />
      ) : (
        <div className="grid gap-5 md:grid-cols-[250px_minmax(0,1fr)]" data-testid="rc-register">
          <div className="space-y-4">
            <TagField value={tag} onChange={setTag} onGuest={setGuest} disabled={op.locked} />
            <Field label="钟数">
              <ClockStepper value={quantity} onChange={setQuantity} disabled={op.locked} label="钟数" testId="rc-register-qty" />
            </Field>
            <Field
              label="出单员工号"
              htmlFor="rc-seller"
              error={sellerNo.trim() && sellerKey === sellerNo.trim() && seller.isError ? errorMessage(seller.error) : null}
              hint={sellerOk ? `${seller.data!.no} · ${seller.data!.name}` : '员工名单里的工号，或系统账号的登录名'}
            >
              <Input id="rc-seller" value={sellerNo} maxLength={MAX_SELLER_NO} onChange={(e) => setSellerNo(e.target.value)} disabled={op.locked} autoComplete="off" data-testid="rc-register-seller" />
            </Field>
            <Field label="开始时间" hint={start === 'at' && startedAt ? `按 ${formatTime(startedAt.toISOString())} 开始计时` : start === 'later' ? '先占房、挂账、派钟；技师到了在房间详情里点「上钟」' : undefined}>
              <Segmented<RoomStartMode>
                size="sm"
                ariaLabel="开始时间"
                value={start}
                onChange={setStart}
                className="w-full"
                options={(['now', 'at', 'later'] as const).map((v) => ({ value: v, label: ROOM_START_LABELS[v] }))}
              />
              {start === 'at' && (
                <div className="flex flex-wrap items-center gap-1.5" data-testid="rc-register-ago">
                  {BACKDATE_CHOICES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMinutesAgo(m)}
                      aria-pressed={minutesAgo === m}
                      className={cn('h-9 rounded-full border px-3 text-[13px] font-semibold', minutesAgo === m ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4')}
                    >
                      {m} 分钟前
                    </button>
                  ))}
                  <span className="text-[12.5px] text-ink-3">最多补记到 {MAX_START_BACKDATE_MINUTES} 分钟以前</span>
                </div>
              )}
            </Field>
            <Field label="备注" htmlFor="rc-note" hint="选填，例如客人的偏好">
              <Input id="rc-note" value={note} maxLength={MAX_ROOM_NOTE} onChange={(e) => setNote(e.target.value)} disabled={op.locked} data-testid="rc-register-note" />
            </Field>
          </div>
          <div className="min-w-0 space-y-4">
            <Field label="项目">
              {items.length === 0 ? (
                <p className="text-[13px] text-ink-3">没有需要技师的项目（在「后台 → 技师」里勾选）</p>
              ) : (
                <div className="flex flex-wrap gap-1.5" data-testid="rc-register-items">
                  {items.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      disabled={op.locked}
                      onClick={() => {
                        setItemId(i.id);
                        setTier(null);
                        setTechnicianId(null);
                      }}
                      aria-pressed={itemId === i.id}
                      className={cn('h-11 rounded-full border px-3.5 text-[13.5px] font-semibold', itemId === i.id ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4')}
                      data-testid={`rc-register-item-${i.name}`}
                    >
                      {i.name}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            {item && (
              <Field label="档次" hint={byGrade ? '这个项目的价格跟技师的等级走，选了技师就定了' : undefined}>
                {byGrade || item.prices.length === 1 ? (
                  <p className="text-[14px] font-semibold text-ink" data-testid="rc-register-tier">
                    {chosenTier ? PRICE_TIER_LABELS[chosenTier] : ''}
                    {unit !== null && <span className="ml-2 text-ink-3">每钟 {formatYuan(unit)}</span>}
                  </p>
                ) : (
                  <Segmented<PriceTier>
                    ariaLabel="档次"
                    value={tier ?? item.prices[0]!.tier}
                    onChange={setTier}
                    options={item.prices.map((p) => ({ value: p.tier, label: `${PRICE_TIER_LABELS[p.tier]} ${formatYuan(p.price)}` }))}
                  />
                )}
              </Field>
            )}
            <Field
              label="技师"
              aside={
                <Segmented<CallType>
                  size="sm"
                  ariaLabel="上钟方式"
                  value={mode}
                  onChange={pickCallType}
                  options={[
                    { value: 'rotation', label: CALL_TYPE_LABELS.rotation },
                    { value: 'designated', label: `${CALL_TYPE_LABELS.designated}（指定技师）` },
                  ]}
                />
              }
            >
              {!item ? (
                <p className="text-[13px] text-ink-3">先选项目</p>
              ) : list.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-3">
                  {mode === 'rotation' ? '没有空闲、能做这个项目的在岗技师（可以改成点钟，让客人等钟）' : '没有上牌的技师（先在钟房上牌）'}
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="rc-register-techs">
                  {list.map((t) => {
                    const why = cant(t);
                    const price = rules ? tierPrice(item.prices, tierFor(t, item, tier ?? item.prices[0]!.tier, rules.tierByGrade)) : null;
                    const on = tech?.id === t.id;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          disabled={!!why || op.locked}
                          onClick={() => setTechnicianId(t.id)}
                          aria-pressed={on}
                          className={cn(
                            'flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
                            on ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong',
                          )}
                          data-testid={`rc-register-tech-${t.techNo}`}
                        >
                          <span className="num w-9 shrink-0 text-[17px] font-bold">{t.techNo}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] font-bold">{t.name}</span>
                            <span className={cn('block truncate text-[12px]', why ? 'text-clay' : t.busy ? 'text-ember-deep' : 'text-ink-3')}>
                              {why ?? (t.busy ? (t.busy.status === 'serving' ? '在钟上，登记后等钟' : '已有待上的钟') : mode === 'rotation' ? `轮钟第 ${t.position} 位` : t.state === 'rest' ? '休息中' : `今日 ${t.todayClocks} 钟`)}
                              {!why && ` · ${gradeLabel(t.grade)}`}
                            </span>
                          </span>
                          {price !== null && !why && <Money cents={price} className="shrink-0 text-[14px] font-bold text-ink-2" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Field>
            {skipping && (
              <Field label={`改派原因（轮钟应派给 ${first!.techNo} 号 ${first!.name}）`} htmlFor="rc-skip" hint="例如：客人要女技师；记进钟房日志">
                <Input id="rc-skip" value={skipReason} maxLength={100} onChange={(e) => setSkipReason(e.target.value)} disabled={op.locked} data-testid="rc-register-skip" />
              </Field>
            )}
          </div>
        </div>
      )}
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" data-testid="rc-register-error" />}
    </Dialog>
  );
}
