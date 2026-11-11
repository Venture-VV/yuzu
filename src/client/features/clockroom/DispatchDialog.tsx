// 派钟、加钟（v0.7.1）：都是给客人挂账（价格按技师等级），与前台挂账同一套「结果待确认」（提交前本机保存原编号与原请求）。
// 轮钟默认派给队列里第一位空闲、能做这个项目的技师；改派别人要写原因（记进钟房日志）。点钟可以点在钟上的技师（等钟）。

import { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { tierPrice, type PriceTier } from '@shared/catalog';
import { TECH_FILTER_LABELS, techFilterOf, type BoardSession, type BoardTechnician, type ClockroomBoard, type PendingLine } from '@shared/clockroom';
import type { FrontdeskBoard } from '@shared/frontdesk';
import { CALL_TYPE_LABELS, canServe, gradeLabel, tierFor, type CallType } from '@shared/technicians';
import type { ServiceItem } from '@shared/types';
import { api } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { useQuery } from '@tanstack/react-query';
import { spaceLabel } from '@shared/spaces';
import { useClockSpaces } from '../rooms/floormap-api';
import { RoomSelect } from './RoomPicker';

const doneOnFound = (found: { found: true } | { found: false }) => (found.found && 'visit' in found ? true : null);

/** 打开派钟时带入的信息（8.0.8，A04 预约到店）：手牌、项目、技师、上钟方式、预约编号 */
export interface DispatchPrefill {
  tagCode?: string;
  itemId?: number;
  technicianId?: number | null;
  callType?: CallType;
  bookingId?: number;
  /** 对话框上方的提示，例如「预约 YY… 到店」 */
  note?: string;
}

/** 派钟对话框里技师列表的状态筛选（8.0.8，B01；休假、停牌、未上牌的不能派，不列） */
type ListFilter = 'all' | 'idle' | 'serving' | 'rest';
const LIST_FILTERS: ListFilter[] = ['all', 'idle', 'serving', 'rest'];
const listFilterOf = (t: BoardTechnician): Exclude<ListFilter, 'all'> | null => {
  const f = techFilterOf(t);
  return f === 'idle' ? 'idle' : f === 'serving' || f === 'waiting' ? 'serving' : f === 'rest' ? 'rest' : null;
};
const LIST_FILTER_LABELS: Record<ListFilter, string> = { all: '全部', idle: TECH_FILTER_LABELS.idle, serving: '上钟中', rest: TECH_FILTER_LABELS.rest };
/** 能派钟的技师：在职、没停牌、当天在岗或休息（休假、未上牌的不能派） */
const dispatchable = (t: BoardTechnician) => t.active && !t.suspendedAt && (t.state === 'on' || t.state === 'rest');

export function DispatchDialog({
  open,
  board,
  onClose,
  onDone,
  assign = null,
  prefill = null,
}: {
  open: boolean;
  board: ClockroomBoard;
  onClose: () => void;
  onDone: () => void;
  /** 待派钟（8.0.8，A01）：给前台已点、交给钟房派钟的那一条派技师（不另挂一笔） */
  assign?: PendingLine | null;
  prefill?: DispatchPrefill | null;
}) {
  const session = useSession();
  const catalog = useCatalog();
  const tags = useQuery({ queryKey: ['frontdesk', 'board'], queryFn: () => api.get<FrontdeskBoard>('/api/frontdesk/board'), enabled: open });
  const [tagText, setTagText] = useState('');
  const [itemId, setItemId] = useState<number | null>(null);
  const [tier, setTier] = useState<PriceTier | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [callType, setCallType] = useState<CallType>(board.techRules.defaultCallType);
  const [technicianId, setTechnicianId] = useState<number | null>(null);
  const [skipReason, setSkipReason] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [gender, setGender] = useState<'all' | 'male' | 'female'>('all');
  const [listFilter, setListFilter] = useState<ListFilter>('all');
  // 服务的房间（v0.7.16，可不选）：房态图按它显示技师房的服务中
  const [spaceId, setSpaceId] = useState<number | null>(null);
  // 补派的那一条（打开时带入，或在提示里切过去）
  const [target, setTarget] = useState<PendingLine | null>(null);
  const spaces = useClockSpaces(open);

  // 每次打开清空上一次的填写（在打开的这一次渲染里就清空，手快时不会把刚输入的手牌号又清掉）；补派、预约带入的这里填上
  useResetOnOpen(open, () => {
    setTarget(assign);
    setTagText(assign?.tagCode ?? prefill?.tagCode ?? '');
    setItemId(assign?.itemId ?? prefill?.itemId ?? null);
    setTier(assign?.tier ?? null);
    setQuantity(assign?.quantity ?? 1);
    setCallType(prefill?.callType ?? board.techRules.defaultCallType);
    setTechnicianId(null);
    setSkipReason('');
    setStartNow(true);
    setGender('all');
    setListFilter('all');
    setSpaceId(null);
  });

  const inStore = (tags.data?.tags ?? []).filter((t) => t.visit);
  const tag = inStore.find((t) => t.code.toLowerCase() === tagText.trim().toLowerCase()) ?? null;
  const visit = tag?.visit ?? null;
  const op = useFrontdeskOp<true>({ type: 'bill_post', visitId: visit?.id ?? null, staffName: session.staff.displayName, pick: doneOnFound });

  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active && i.technicianRequired && (!i.gender || !tag || i.gender === tag.zone)), [catalog.data, tag]);
  // 补派的项目可能已经停用或取消了「需要技师」：照样按那一条的项目派
  const item = items.find((i) => i.id === itemId) ?? (target ? ((catalog.data?.items ?? []).find((i) => i.id === target.itemId) ?? null) : null);

  // 补派：价格档已经定了（不改金额），价格跟等级时只能派给同等级的
  const fixedTier: PriceTier | null = target && item ? (target.tier ?? item.prices[0]!.tier) : null;
  const tierOk = (t: BoardTechnician) => !fixedTier || !item || tierFor(t, item, fixedTier, board.techRules.tierByGrade) === fixedTier;
  // 轮钟：在岗、空闲、能做这个项目的技师按排位；第一位就是该派的
  const shape = item ? { category: item.category, prices: item.prices } : null;
  const eligible = board.technicians
    .filter((t) => t.state === 'on' && !t.busy && !t.suspendedAt && shape && !canServe(t, shape, board.techRules.tierByGrade) && tierOk(t))
    .sort((a, b) => a.position! - b.position!);
  const filtered = (list: BoardTechnician[]) =>
    list.filter((t) => (gender === 'all' || t.gender === gender) && (listFilter === 'all' || listFilterOf(t) === listFilter));
  const rotationList = filtered(eligible);
  const designatedBase = board.technicians
    .filter((t) => dispatchable(t) && tierOk(t))
    .sort((a, b) => Number(a.techNo) - Number(b.techNo) || a.techNo.localeCompare(b.techNo));
  const designatedList = filtered(designatedBase);
  const firstEligible = eligible[0] ?? null;
  // 切换项目、方式或筛选后，轮钟默认选队列里的第一位；点钟带入了预约的技师就选他（同样在这一次渲染里定，不会盖掉随后点选的技师）
  useResetOnOpen(
    open,
    () =>
      setTechnicianId(
        callType === 'rotation'
          ? (rotationList[0]?.id ?? null)
          : prefill?.technicianId && (!prefill.itemId || prefill.itemId === itemId)
            ? prefill.technicianId
            : null,
      ),
    [itemId, callType, gender, listFilter, target?.lineId],
  );
  const tech = board.technicians.find((t) => t.id === technicianId) ?? null;
  const skipping = callType === 'rotation' && !!tech && !!firstEligible && tech.id !== firstEligible.id;
  const why = tech && shape ? canServe(tech, shape, board.techRules.tierByGrade) : null;
  const chosenTier: PriceTier | null = item
    ? fixedTier ?? (tech ? tierFor(tech, item, tier ?? item.prices[0]!.tier, board.techRules.tierByGrade) : (tier ?? item.prices[0]!.tier))
    : null;
  const unit = item && chosenTier ? tierPrice(item.prices, chosenTier) : null;
  const total = target ? target.amount : unit !== null ? unit * quantity : 0;
  // 这位客人前台已经点了同一个项目、还没派技师：给那一条派，免得重复收费（8.0.8，A01）
  const duplicate = !target && visit && item ? (board.pending.find((p) => p.visitId === visit.id && p.itemId === item.id) ?? null) : null;
  const problem = !visit
    ? '请输入在店客人的手牌号'
    : !item
      ? '请选择项目'
      : !tech
        ? '请选择技师'
        : why
          ? `${tech.techNo} 号${why}`
          : !tierOk(tech)
            ? `${tech.techNo} 号按等级不是这一档价格，请换一位同等级的技师`
            : skipping && board.rules.skipNeedsReason && skipReason.trim().length < 2
              ? `轮钟应派给 ${firstEligible!.techNo} 号 ${firstEligible!.name}；要改派请写原因`
              : unit === null
                ? '这个项目没有这一档价格'
                : null;

  const room = spaces.data?.find((x) => x.id === spaceId) ?? null;
  const submit = async () => {
    if (problem || !visit || !item || !tech) return;
    if (target) {
      // 补派：不另挂一笔；与派钟一样带操作编号、走「结果待确认」（超时、断网后先查回或确认作废，不能改了技师再派，Codex 审查 fb67dca）
      const ok = await op.submit((key) => ({
        url: `/api/clockroom/lines/${target.lineId}/assign`,
        body: {
          clientKey: key,
          technicianId: tech.id,
          callType,
          startNow: startNow && !tech.busy,
          skipReason: skipping ? skipReason.trim() : undefined,
          spaceId: spaceId ?? undefined,
          bookingId: prefill?.bookingId,
        },
        tagCodes: [tag!.code],
        summary: `补派 ${target.itemName} × ${target.quantity}（${tech.techNo} 号 ${tech.name} · ${CALL_TYPE_LABELS[callType]}，前台已点、不另收费）`,
        amount: 0,
      }));
      if (ok) onDone();
      return;
    }
    const ok = await op.submit((key) => ({
      url: '/api/clockroom/dispatch',
      body: {
        clientKey: key,
        visitId: visit.id,
        itemId: item.id,
        tier: board.techRules.tierByGrade && item.prices.length > 1 ? undefined : chosenTier,
        quantity,
        technicianId: tech.id,
        callType,
        startNow: startNow && !tech.busy,
        skipReason: skipping ? skipReason.trim() : undefined,
        spaceId: spaceId ?? undefined,
        bookingId: prefill?.bookingId,
        expectedTotal: total,
      },
      tagCodes: [tag!.code],
      summary: `派钟 ${item.name} × ${quantity}（${tech.techNo} 号 ${tech.name} · ${CALL_TYPE_LABELS[callType]}${room ? ` · 房间 ${spaceLabel(room.code, room.displayName)}` : ''}${prefill?.bookingId ? ' · 按预约' : ''}）`,
      amount: total,
    }));
    if (ok) onDone();
  };

  const list = callType === 'rotation' ? rotationList : designatedList;
  const base = callType === 'rotation' ? eligible : designatedBase;
  const busyNow = op.busy;
  return (
    <Dialog
      open={open}
      onClose={busyNow ? () => {} : onClose}
      width="max-w-3xl"
      title={target ? '派钟 · 前台已点' : '派钟'}
      description={
        target
          ? `前台已经挂了这一项（${target.tagCode} ${target.guest} · ${target.itemName} × ${target.quantity}），这里只派技师、建钟单，不另收费。`
          : '给在店客人派技师并挂账（价格按技师等级）。派钟不是收款，结账时一起结。'
      }
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            {problem ? (
              <span className="text-clay">{problem}</span>
            ) : target ? (
              <>
                不另收费（已挂 <Money cents={total} className="font-bold text-ink" />）
              </>
            ) : (
              <>
                合计 <Money cents={total} className="text-[17px] font-bold text-ink" />
              </>
            )}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busyNow}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!!problem || op.locked} loading={busyNow} onClick={() => void submit()} data-testid="dispatch-submit">
            {tech?.busy ? '派钟（等钟）' : startNow ? '派钟并上钟' : '派钟'}
          </Button>
        </>
      }
    >
      {/* 派钟、补派共用这一个「结果待确认」（Codex 审查 9470097：补派也要看得到、能查回或确认作废） */}
      <PendingPanel op={op} onResolved={() => onDone()} />
      {prefill?.note && <Notice tone="info" title={prefill.note} className="mb-3" />}
      {duplicate && (
        <Notice tone="warning" title={`这位客人前台已经点了「${duplicate.itemName}」× ${duplicate.quantity}，还没派技师`} className="mb-3" data-testid="dispatch-duplicate">
          <span className="block">在这里再派会另挂一笔、重复收费。给前台那一条派技师不另收费。</span>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => {
              setTarget(duplicate);
              setQuantity(duplicate.quantity);
              setTier(duplicate.tier);
            }}
            data-testid="dispatch-use-pending"
          >
            改为给前台那一条派钟
          </Button>
        </Notice>
      )}
      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Field label="手牌" htmlFor="dispatch-tag" hint={visit ? `${tag!.zone === 'female' ? '女宾' : '男宾'} · ${visit.memberName ?? (visit.guestLabel || '散客')}` : '输入在店客人的手牌号'}>
            <Input id="dispatch-tag" value={tagText} onChange={(e) => setTagText(e.target.value)} className="num" placeholder="例如 A8062" data-autofocus disabled={!!target} data-testid="dispatch-tag" />
          </Field>
          <Field label="钟数">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" aria-label="减少钟数" disabled={!!target || quantity <= 1} onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
                <Minus className="size-4" />
              </Button>
              <span className="num w-8 text-center text-[18px] font-bold">{quantity}</span>
              <Button size="sm" variant="secondary" aria-label="增加钟数" disabled={!!target || quantity >= 9} onClick={() => setQuantity((q) => Math.min(9, q + 1))}>
                <Plus className="size-4" />
              </Button>
            </div>
          </Field>
          <Field label="上钟方式">
            <Segmented
              ariaLabel="上钟方式"
              value={callType}
              onChange={setCallType}
              className="w-full"
              options={[
                { value: 'rotation', label: CALL_TYPE_LABELS.rotation },
                { value: 'designated', label: CALL_TYPE_LABELS.designated },
              ]}
            />
          </Field>
          {(spaces.data?.length ?? 0) > 0 && (
            <Field label="房间（可不选）" htmlFor="dispatch-room" hint="房态图按这里显示服务中；以后也能在钟单上换">
              <RoomSelect id="dispatch-room" value={spaceId} onChange={setSpaceId} spaces={spaces.data} testId="dispatch-room" />
            </Field>
          )}
          <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
            <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
            技师到了，立即上钟
          </label>
        </div>
        <div className="min-w-0 space-y-3">
          <Field label="项目">
            {target ? (
              <p className="text-[13.5px] font-semibold" data-testid="dispatch-fixed-item">
                {target.itemName} × {target.quantity}
              </p>
            ) : catalog.isPending ? (
              <Skeleton className="h-20" />
            ) : items.length === 0 ? (
              <p className="text-[13px] text-ink-3">没有需要技师的项目（在「后台 → 技师」勾选）</p>
            ) : (
              <div className="flex flex-wrap gap-1.5" data-testid="dispatch-items">
                {items.map((i: ServiceItem) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => setItemId(i.id)}
                    className={cn('h-9 rounded-full border px-3 text-[13px] font-semibold', itemId === i.id ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4')}
                    data-testid={`dispatch-item-${i.name}`}
                  >
                    {i.name}
                  </button>
                ))}
              </div>
            )}
          </Field>
          {!target && item && !board.techRules.tierByGrade && item.prices.length > 1 && (
            <Field label="价格档">
              <Segmented ariaLabel="价格档" value={tier ?? item.prices[0]!.tier} onChange={setTier} options={item.prices.map((p) => ({ value: p.tier, label: `${{ standard: '标准', professional: '专业', premium: '优选' }[p.tier]} ¥${p.price / 100}` }))} />
            </Field>
          )}
          <Field
            label={callType === 'rotation' ? '技师（按轮钟排位）' : '技师（客人点名）'}
            aside={
              <Segmented
                size="sm"
                ariaLabel="技师性别"
                value={gender}
                onChange={setGender}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'female', label: '女' },
                  { value: 'male', label: '男' },
                ]}
              />
            }
          >
            {item && (
              <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="按状态筛选技师" data-testid="dispatch-status-filter">
                {LIST_FILTERS.map((f) => {
                  const n = f === 'all' ? base.length : base.filter((t) => listFilterOf(t) === f).length;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setListFilter(f)}
                      aria-pressed={listFilter === f}
                      className={cn('h-7 rounded-full border px-2.5 text-[12px] font-semibold', listFilter === f ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-3 hover:border-ink-4')}
                      data-testid={`dispatch-filter-${f}`}
                    >
                      {LIST_FILTER_LABELS[f]} {n}
                    </button>
                  );
                })}
              </div>
            )}
            {!item ? (
              <p className="text-[13px] text-ink-3">先选项目</p>
            ) : list.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-3">
                {listFilter !== 'all'
                  ? `没有「${LIST_FILTER_LABELS[listFilter]}」的技师`
                  : callType === 'rotation'
                    ? '没有空闲、能做这个项目的在岗技师（可以点钟让客人等钟）'
                    : '没有上牌的技师'}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="dispatch-techs">
                {list.map((t) => {
                  const cant = canServe(t, item, board.techRules.tierByGrade);
                  const price = tierPrice(item.prices, fixedTier ?? tierFor(t, item, tier ?? item.prices[0]!.tier, board.techRules.tierByGrade));
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={!!cant}
                      onClick={() => setTechnicianId(t.id)}
                      className={cn(
                        'flex flex-col rounded-lg border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
                        technicianId === t.id ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong',
                      )}
                      data-testid={`dispatch-tech-${t.techNo}`}
                    >
                      <span className="flex items-baseline gap-1.5">
                        {callType === 'rotation' && <span className="num text-[11.5px] font-bold text-ink-3">第 {t.position} 位</span>}
                        <span className="num text-[16px] font-bold">{t.techNo}</span>
                        <span className="min-w-0 truncate font-bold">{t.name}</span>
                      </span>
                      <span className="text-[12px] text-ink-3">
                        {gradeLabel(t.grade)} {price !== null && !cant && <Money cents={price} className="font-bold text-ink-2" />}
                      </span>
                      <span className={cn('text-[11.5px] font-semibold', cant ? 'text-clay' : t.busy ? 'text-yuzu-deep' : 'text-ink-4')}>
                        {cant ?? (t.busy ? (t.busy.status === 'serving' ? '在钟上，派了要等钟' : '已有待上钟') : t.state === 'rest' ? '休息中' : `今日 ${t.todayClocks} 钟`)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
          {skipping && (
            <Field label={`改派原因（轮钟应派给 ${firstEligible!.techNo} 号 ${firstEligible!.name}）`} htmlFor="dispatch-skip" hint="例如：客人要女技师、客人要力道重的；记进钟房日志">
              <Input id="dispatch-skip" value={skipReason} maxLength={100} onChange={(e) => setSkipReason(e.target.value)} data-testid="dispatch-skip-reason" />
            </Field>
          )}
        </div>
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}

/** 加钟：原技师继续，钟数与时长累加；挂账走「结果待确认」 */
export function ExtendDialog({ session: s, onClose, onDone }: { session: BoardSession; onClose: () => void; onDone: () => void }) {
  const me = useSession();
  const catalog = useCatalog();
  const [quantity, setQuantity] = useState(1);
  const op = useFrontdeskOp<true>({ type: 'bill_post', visitId: s.visitId, staffName: me.staff.displayName, pick: doneOnFound });
  const visit = useQuery({ queryKey: ['frontdesk', 'visit', s.visitId], queryFn: () => api.get<{ lines: { sessionId?: number; unitPrice: number; technician: { id: number } | null; itemId: number | null }[] }>(`/api/frontdesk/visits/${s.visitId}`) });
  // 加钟按这张钟单第一条明细的单价（同一项目、同一价格档）
  const unit = visit.data?.lines.find((l) => l.itemId === s.itemId && l.technician?.id === s.technicianId)?.unitPrice ?? null;
  const item = catalog.data?.items.find((i) => i.id === s.itemId);
  const total = unit !== null ? unit * quantity : 0;
  const submit = async () => {
    if (unit === null) return;
    const ok = await op.submit((key) => ({
      url: `/api/clockroom/sessions/${s.id}/extend`,
      body: { clientKey: key, quantity, expectedTotal: total },
      tagCodes: [s.tagCode],
      summary: `加钟 ${s.itemName} × ${quantity}（${s.techNo} 号 ${s.techName}）`,
      amount: total,
    }));
    if (ok) onDone();
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={`加钟 · ${s.techNo} 号 ${s.techName}`}
      description={`${s.tagCode} ${s.guest} · ${s.itemName}。原技师继续，挂到这位客人的账单上。`}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            合计 <Money cents={total} className="text-[17px] font-bold text-ink" />
          </span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={unit === null || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="extend-submit">
            加 {quantity} 钟
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={() => onDone()} />
      <div className="flex items-center gap-3">
        <Button size="sm" variant="secondary" aria-label="减少" disabled={quantity <= 1} onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
          <Minus className="size-4" />
        </Button>
        <span className="num w-8 text-center text-[20px] font-bold">{quantity}</span>
        <Button size="sm" variant="secondary" aria-label="增加" disabled={quantity >= 9} onClick={() => setQuantity((q) => Math.min(9, q + 1))}>
          <Plus className="size-4" />
        </Button>
        <span className="text-[13px] text-ink-3">
          × {unit !== null ? <Money cents={unit} /> : '…'} · 每钟 {item?.durationMinutes ?? Math.round(s.minutes / s.clocks)} 分钟
        </span>
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}

/**
 * 转钟（8.0.8，B05）：待上钟、上钟中的钟单转给另一位技师——原明细作废、给新技师挂同项目同价格档同钟数的明细（金额不变）、
 * 建新钟单（在钟上的转过去马上上钟，房间照旧），原技师按退钟 / 取消派钟的规则回到原位。带操作编号，走「结果待确认」。
 */
export function TransferDialog({ session: s, board, onClose, onDone }: { session: BoardSession; board: ClockroomBoard; onClose: () => void; onDone: () => void }) {
  const me = useSession();
  const catalog = useCatalog();
  const [callType, setCallType] = useState<CallType>(s.callType);
  const [technicianId, setTechnicianId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [skipReason, setSkipReason] = useState('');
  const [listFilter, setListFilter] = useState<ListFilter>('all');
  const op = useFrontdeskOp<true>({ type: 'bill_post', visitId: s.visitId, staffName: me.staff.displayName, pick: doneOnFound });
  const visit = useQuery({
    queryKey: ['frontdesk', 'visit', s.visitId],
    queryFn: () => api.get<{ lines: { sessionId: number | null; status: string; tier: PriceTier | null; amount: number }[] }>(`/api/frontdesk/visits/${s.visitId}`),
  });
  const lines = (visit.data?.lines ?? []).filter((l) => l.sessionId === s.id && l.status === 'active');
  const amount = lines.reduce((n, l) => n + l.amount, 0);
  const item = catalog.data?.items.find((i) => i.id === s.itemId) ?? null;
  const fixedTier: PriceTier | null = item ? (lines[0]?.tier ?? item.prices[0]?.tier ?? null) : null;
  const tierOk = (t: BoardTechnician) => !fixedTier || !item || tierFor(t, item, fixedTier, board.techRules.tierByGrade) === fixedTier;
  const shape = item ? { category: item.category, prices: item.prices } : null;
  const eligible = board.technicians
    .filter((t) => t.id !== s.technicianId && t.state === 'on' && !t.busy && !t.suspendedAt && shape && !canServe(t, shape, board.techRules.tierByGrade) && tierOk(t))
    .sort((a, b) => a.position! - b.position!);
  const designatedBase = board.technicians
    .filter((t) => t.id !== s.technicianId && dispatchable(t) && tierOk(t))
    .sort((a, b) => Number(a.techNo) - Number(b.techNo) || a.techNo.localeCompare(b.techNo));
  const base = callType === 'rotation' ? eligible : designatedBase;
  const list = base.filter((t) => listFilter === 'all' || listFilterOf(t) === listFilter);
  const firstEligible = eligible[0] ?? null;
  const tech = board.technicians.find((t) => t.id === technicianId) ?? null;
  const skipping = callType === 'rotation' && !!tech && !!firstEligible && tech.id !== firstEligible.id;
  const cant = tech && shape ? canServe(tech, shape, board.techRules.tierByGrade) : null;
  const problem = !visit.data
    ? '载入中'
    : lines.length === 0
      ? '这张钟单没有有效的挂账，请刷新'
      : !tech
        ? '请选择转给哪位技师'
        : cant
          ? `${tech.techNo} 号${cant}`
          : !tierOk(tech)
            ? `${tech.techNo} 号按等级不是这一档价格，请换一位同等级的技师（要换档请退钟后重新派）`
            : reason.trim().length < 2
              ? '请填写转钟原因（至少 2 个字）'
              : skipping && board.rules.skipNeedsReason && skipReason.trim().length < 2
                ? `轮钟应转给 ${firstEligible!.techNo} 号 ${firstEligible!.name}；要改派请写原因`
                : null;
  const submit = async () => {
    if (problem || !tech) return;
    const ok = await op.submit((key) => ({
      url: `/api/clockroom/sessions/${s.id}/transfer`,
      body: { clientKey: key, technicianId: tech.id, callType, reason: reason.trim(), skipReason: skipping ? skipReason.trim() : undefined },
      tagCodes: [s.tagCode],
      summary: `转钟 ${s.itemName} × ${s.clocks}：${s.techNo} 号 ${s.techName} → ${tech.techNo} 号 ${tech.name}（${CALL_TYPE_LABELS[callType]}）`,
      amount,
    }));
    if (ok) onDone();
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      width="max-w-2xl"
      title={`转钟 · ${s.techNo} 号 ${s.techName}`}
      description={`${s.tagCode} ${s.guest} · ${s.itemName} × ${s.clocks}。转给另一位技师：原明细作废、给新技师挂同样的明细，金额不变；${s.status === 'serving' ? '在钟上的转过去马上上钟，原技师按退钟算' : '还没上钟，原技师按取消派钟算'}，房间照旧。`}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            {problem ? <span className="text-clay">{problem}</span> : <>金额不变 <Money cents={amount} className="font-bold text-ink" /></>}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="transfer-submit">
            确认转钟
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={() => onDone()} />
      <div className="space-y-3">
        <Field label="上钟方式">
          <Segmented
            ariaLabel="上钟方式"
            value={callType}
            onChange={(v) => {
              setCallType(v);
              setTechnicianId(null);
            }}
            options={[
              { value: 'rotation', label: CALL_TYPE_LABELS.rotation },
              { value: 'designated', label: CALL_TYPE_LABELS.designated },
            ]}
          />
        </Field>
        <Field label={callType === 'rotation' ? '转给（按轮钟排位）' : '转给（客人点名）'}>
          <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="按状态筛选技师">
            {LIST_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setListFilter(f)}
                aria-pressed={listFilter === f}
                className={cn('h-7 rounded-full border px-2.5 text-[12px] font-semibold', listFilter === f ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-3 hover:border-ink-4')}
              >
                {LIST_FILTER_LABELS[f]} {f === 'all' ? base.length : base.filter((t) => listFilterOf(t) === f).length}
              </button>
            ))}
          </div>
          {list.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-3">没有能转的技师</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="transfer-techs">
              {list.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={!!(shape && canServe(t, shape, board.techRules.tierByGrade))}
                  onClick={() => setTechnicianId(t.id)}
                  className={cn('flex flex-col rounded-lg border px-3 py-2 text-left disabled:opacity-50', technicianId === t.id ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong')}
                  data-testid={`transfer-tech-${t.techNo}`}
                >
                  <span className="flex items-baseline gap-1.5">
                    {callType === 'rotation' && <span className="num text-[11.5px] font-bold text-ink-3">第 {t.position} 位</span>}
                    <span className="num text-[16px] font-bold">{t.techNo}</span>
                    <span className="min-w-0 truncate font-bold">{t.name}</span>
                  </span>
                  <span className="text-[11.5px] text-ink-3">
                    {gradeLabel(t.grade)} · {t.busy ? (t.busy.status === 'serving' ? '在钟上，要等钟' : '已有待上钟') : t.state === 'rest' ? '休息中' : `今日 ${t.todayClocks} 钟`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label="转钟原因" htmlFor="transfer-reason" hint="记进钟房日志与作废原因">
          <Input id="transfer-reason" value={reason} maxLength={100} placeholder="例如：客人要换技师、技师临时有事" onChange={(e) => setReason(e.target.value)} data-autofocus data-testid="transfer-reason" />
        </Field>
        {skipping && (
          <Field label={`改派原因（轮钟应转给 ${firstEligible!.techNo} 号 ${firstEligible!.name}）`} htmlFor="transfer-skip">
            <Input id="transfer-skip" value={skipReason} maxLength={100} onChange={(e) => setSkipReason(e.target.value)} data-testid="transfer-skip-reason" />
          </Field>
        )}
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}
