// 客房（S7，v0.7.4，见 docs/ROOMS.md）的入住与夜审对话框。8.1.16 起原来的「客房」页并进了房态中心（docs/ROOM_CENTER_V8115.md 第 7 节）：
// 客房的卡片在房态中心的「客房」页签里，点空闲的房入住（CheckinDialog：填在店客人的手牌，房费挂在手牌账单上，离店时随手牌在前台结账），
// 点在住的房看入住单（StayDialog），点待打扫、维修的房改房态（HousekeepingDialog）；夜审（AuditStrip、AuditDialog）在「客房」页签的顶上。
// 住客都是在店的洗浴客人（店主 2026-10-31：门票必选，没有只住房的客人；房价不含洗浴门票）。
// 入住、续住、收退押金、退房与前台一样有「结果待确认」：断网后查回、原样重提或确认作废。

import type { BookingDetail } from '@shared/bookings';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, MoonStar, Wrench } from 'lucide-react';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { PAYMENT_METHOD_LABELS, shiftDate } from '@shared/labels';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { MAX_STAY_GUESTS, type RoomAuditReport, type RoomBoard, type RoomBoardRoom, type RoomQuote, type StayDetail } from '@shared/rooms';
import { spaceLabel } from '@shared/spaces';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, useShiftReady } from '../shift/ShiftGate';
import { DepositFields, depositProblem, guestOf, kindLabel, rateText, type DepositDraft } from './parts';
import { dayText, minuteText, roomsKey } from './queries';

/** 夜审提醒：今晚还有在住的全天房没挂房费；没到时刻时说明几点以后做 */
export function AuditStrip({ board, onRun }: { board: RoomBoard; onRun?: () => void }) {
  const a = board.audit;
  if (a.allowed && a.pending > 0) {
    return (
      <div data-testid="rooms-audit-pending">
        <Notice
          tone="warning"
          icon={<MoonStar className="size-4" />}
          title={`今晚还有 ${a.pending} 间在住的全天房没挂房费，请做夜审`}
          action={
            onRun && (
              <Button size="sm" variant="primary" onClick={onRun}>
                做夜审
              </Button>
            )
          }
        >
          夜审给在住的全天房挂今晚的房费（同一晚只挂一次，可以重复做）；漏做的在退房时补上。
        </Notice>
      </div>
    );
  }
  return (
    <p className="text-[12.5px] text-ink-3" data-testid="rooms-audit-state">
      {a.done && a.runAt ? `营业日 ${a.date} 的夜审：${formatTime(a.runAt)} ${a.runByName ?? ''}已做。` : `营业日 ${a.date} 还没做夜审。`}
      {!a.allowed && ` 夜审在 ${minuteText(board.rules.lateFullMinute)} 以后做（这时还在住的客人要付今晚的房费）。`}
    </p>
  );
}

/** 入住：填在店客人的手牌（住客要先在前台接待、买门票），房费挂在手牌账单上，离店时随手牌结账；押金按规则默认收或不收。房态中心（8.1.15）的客房卡片也打开它 */
export function CheckinDialog({
  room,
  board,
  booking = null,
  onHousekeep,
  onClose,
  onDone,
}: {
  room: RoomBoardRoom;
  board: RoomBoard;
  /** 按预约入住（8.0.8，A04）：手牌、人数带好，入住记到这张预约 */
  booking?: BookingDetail | null;
  /** 改房态（例如空闲的房要维修）：有「客房打扫、维修」权限时 */
  onHousekeep?: () => void;
  onClose: () => void;
  onDone: (d: StayDetail) => void;
}) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = board.rules;
  const [tag, setTag] = useState(booking?.arrivalTagCode ?? '');
  const [label, setLabel] = useState(booking ? (booking.memberName ?? booking.guestName ?? '').slice(0, 16) : '');
  const [guests, setGuests] = useState(booking ? Math.min(MAX_STAY_GUESTS, Math.max(1, booking.guests)) : 1);
  const [leave, setLeave] = useState(room.kind === 'daily' ? shiftDate(session.today, 1) : '');
  const [withDeposit, setWithDeposit] = useState(rules.defaultDeposit > 0);
  const [deposit, setDeposit] = useState<DepositDraft>({ method: 'cash', amount: rules.defaultDeposit > 0 ? centsToInput(rules.defaultDeposit) : '', ref: '' });
  const shiftReady = useShiftReady(withDeposit);
  const op = useFrontdeskOp<StayDetail>({
    type: 'room_checkin',
    visitId: null,
    roomId: room.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'room_checkin' ? found.stay : null),
  });

  useEffect(() => {
    if (op.state.phase === 'error' && op.state.code === 'PRICE_CHANGED') void qc.invalidateQueries({ queryKey: roomsKey });
    if (op.state.phase === 'error' && SHIFT_ERRORS.includes(op.state.code ?? '')) void qc.invalidateQueries({ queryKey: shiftKeys.all });
  }, [op.state, qc]);

  const tagCode = normalizeTagCode(tag);
  const tagOk = TAG_CODE_PATTERN.test(tagCode);
  // 这位客人的房价（8.0.20 会员联动房价）：手牌绑了会员、房型设了会员价的按会员价；填好手牌号才问得到
  const quote = useQuery({
    queryKey: [...roomsKey, 'quote', room.id, tagOk ? tagCode : ''],
    queryFn: () => api.get<RoomQuote>(`/api/rooms/quote?roomId=${room.id}&tag=${encodeURIComponent(tagOk ? tagCode : '')}`),
    staleTime: 0,
  });
  const rate = quote.data?.rate ?? room.price;
  const depProblem = withDeposit ? depositProblem(deposit, { required: true }) : null;
  const ok =
    tagOk &&
    Number.isInteger(guests) &&
    guests >= 1 &&
    guests <= MAX_STAY_GUESTS &&
    label.trim().length <= 16 &&
    (room.kind !== 'daily' || !leave || leave >= session.today) &&
    depProblem === null &&
    (!withDeposit || shiftReady.ready);

  const finish = (d: StayDetail) => {
    toast({ tone: 'success', title: `${d.roomNo} 已入住`, body: `${d.stayNo} · ${d.guests} 人${d.depositBalance > 0 ? ` · 押金 ${formatYuan(d.depositBalance)}` : ''}` });
    onDone(d);
  };
  const submit = async () => {
    if (!ok) return;
    const dep = withDeposit ? { method: deposit.method, amount: parseYuan(deposit.amount)!, ref: deposit.ref.trim() } : null;
    const who = `手牌 ${tagCode}${label.trim() ? ` · ${label.trim()}` : ''}`;
    const d = await op.submit((key) => ({
      url: '/api/rooms/checkin',
      body: {
        clientKey: key,
        roomId: room.id,
        tagCode,
        guestLabel: label.trim(),
        guests,
        expectedCheckoutDate: room.kind === 'daily' && leave ? leave : null,
        expectedRate: rate,
        deposit: dep,
        bookingId: booking?.id,
      },
      tagCodes: [`房 ${room.roomNo}`],
      summary: `入住 ${guests} 人（${who}）${dep ? `，${PAYMENT_METHOD_LABELS[dep.method]}押金` : ''}${booking ? `，预约 ${booking.bookingNo}` : ''}`,
      amount: dep?.amount ?? null,
    }));
    if (d) finish(d);
  };

  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={
        <span className="flex items-center gap-2">
          <BedDouble className="size-5 text-pine" /> 入住 · {spaceLabel(room.roomNo, room.spaceName)}
        </span>
      }
      description={`${room.typeName} · ${kindLabel(room.kind)} · ${rateText(room.kind, room.price, room.blockMinutes)}。入住时先挂${room.kind === 'daily' ? '第一晚' : '第一段'}房费 ${formatYuan(room.price)}。`}
      footer={
        <>
          {onHousekeep && (
            <Button variant="ghost" className="mr-auto" icon={<Wrench className="size-4" />} onClick={onHousekeep} disabled={op.locked} data-testid="room-checkin-housekeep">
              改房态
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="room-checkin-submit">
            确认入住
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="space-y-4" data-testid="room-checkin">
        {quote.data && (quote.data.memberGrade !== null || quote.data.reason) && (
          <Notice
            tone={quote.data.memberGrade !== null ? 'success' : 'info'}
            title={quote.data.memberGrade !== null ? `会员价 ${formatYuan(quote.data.rate)}（L${quote.data.memberGrade} 起的价，门市价 ${formatYuan(quote.data.listRate)}）` : quote.data.reason}
            data-testid="room-checkin-quote"
          >
            {quote.data.memberGrade !== null ? '按会员价入住的房费，结账时不再打会员折扣（券照常能用）。' : null}
          </Notice>
        )}
        <Field
          label="住客的手牌号"
          htmlFor="room-tag"
          hint="住客要先在前台接待、买门票（门票必选，房价不含门票）；房费挂在这张手牌的账单上，离店时随手牌一起结账"
          error={tag && !tagOk ? '牌号格式不正确（例如 A023、1088）' : null}
        >
          <Input
            fullWidth={false}
            id="room-tag"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value.toUpperCase());
              op.clearError();
            }}
            disabled={op.locked}
            className="num w-40 text-[16px] font-bold"
            data-autofocus
            data-testid="room-checkin-tag"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="住客称呼" htmlFor="room-label" hint="选填，例如 王先生">
            <Input id="room-label" value={label} maxLength={16} onChange={(e) => setLabel(e.target.value)} disabled={op.locked} data-testid="room-checkin-label" />
          </Field>
          <Field label="入住人数" htmlFor="room-guests">
            <Input
              fullWidth={false}
              id="room-guests"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_STAY_GUESTS}
              value={String(guests)}
              onChange={(e) => setGuests(Math.trunc(Number(e.target.value)) || 0)}
              disabled={op.locked}
              className="num w-24 text-[16px] font-bold"
              data-testid="room-checkin-guests"
            />
          </Field>
        </div>
        {room.kind === 'daily' && (
          <Field label="预计离店" htmlFor="room-leave" hint={`只做提醒；房费按实际住的晚数算：${minuteText(rules.checkoutMinute)} 以后退房加收半天，${minuteText(rules.lateFullMinute)} 以后加收一晚`}>
            <Input
              fullWidth={false}
              id="room-leave"
              type="date"
              min={session.today}
              value={leave}
              onChange={(e) => setLeave(e.target.value)}
              disabled={op.locked}
              className="w-48"
              data-testid="room-checkin-leave"
            />
          </Field>
        )}
        <div className="rounded-lg border border-line bg-paper/50 p-3">
          <label className="flex items-center gap-2 text-[13.5px] font-semibold">
            <input
              type="checkbox"
              checked={withDeposit}
              onChange={(e) => setWithDeposit(e.target.checked)}
              disabled={op.locked}
              className="size-4 accent-pine"
              data-testid="room-checkin-with-deposit"
            />
            收押金
            <span className="text-[12px] font-normal text-ink-3">押金不算营业额，退房时原路退回；现金押金计入交班</span>
          </label>
          {withDeposit && (
            <div className="mt-2.5 space-y-2">
              <DepositFields value={deposit} onChange={setDeposit} disabled={op.locked} />
              {depProblem && deposit.amount && <p className="text-[12.5px] font-semibold text-clay">{depProblem}</p>}
              <ShiftGate action="收押金" />
            </div>
          )}
        </div>
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}

/** 夜审：给在住的全天房挂到今晚为止还没挂的房费（同一晚只挂一次，可以重复做），出夜审报告 */
export function AuditDialog({ board, onClose }: { board: RoomBoard; onClose: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RoomAuditReport | null>(null);
  const a = board.audit;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.post<RoomAuditReport>('/api/rooms/audit'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: roomsKey });
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      width="max-w-2xl"
      title={
        <span className="flex items-center gap-2">
          <MoonStar className="size-5 text-pine" /> 夜审 · 营业日 {a.date}
        </span>
      }
      description={`过了 ${minuteText(board.rules.lateFullMinute)} 还在住的全天房要付今晚的房费：夜审给它们挂上（同一晚只挂一次，可以重复做）。钟点房按段计价，不参加夜审。`}
      footer={
        report ? (
          <Button variant="primary" onClick={onClose} data-testid="room-audit-close">
            完成
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" size="lg" loading={busy} disabled={!a.allowed} onClick={run} data-testid="room-audit-run">
              做夜审
            </Button>
          </>
        )
      }
    >
      {report ? (
        <div className="space-y-4" data-testid="room-audit-report">
          <Notice tone="success" title={`夜审完成：挂了 ${report.posted.length} 晚房费，共 ${formatYuan(report.postedAmount)}`}>
            {formatDateTime(report.runAt)} {report.runByName}。在住 {report.stays.length} 间，押金余额 {formatYuan(report.depositBalance)}。
          </Notice>
          {report.posted.length > 0 && (
            <ul className="divide-y divide-line/70 rounded-lg border border-line text-[13px]">
              {report.posted.map((p, i) => (
                <li key={i} className="flex items-baseline gap-2 px-3 py-2">
                  <span className="num font-bold">{p.roomNo}</span>
                  <span className="text-ink-3">
                    {p.stayNo} · {dayText(p.nightDate)}
                  </span>
                  <span className="flex-1" />
                  <Money cents={p.amount} className="font-semibold" />
                </li>
              ))}
            </ul>
          )}
          <div>
            <p className="text-[13px] font-bold text-ink-2">在住</p>
            {report.stays.length === 0 ? (
              <p className="mt-1 text-[13px] text-ink-3">没有在住的房间</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-2">
                {report.stays.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="num font-bold">{s.roomNo}</span>
                    <span>
                      {guestOf(s)} · {s.guests} 人 · {kindLabel(s.kind)} · {dayText(s.businessDate)}入住
                    </span>
                    <span className="flex-1" />
                    <span>
                      房费 <Money cents={s.chargedAmount} /> · 押金 <Money cents={s.depositBalance} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3" data-testid="room-audit">
          {a.done && a.runAt && (
            <Notice tone="info" title={`今天 ${formatTime(a.runAt)} ${a.runByName ?? ''}已做过夜审`}>
              再做一次只会补挂之后入住、还没挂今晚房费的房间。
            </Notice>
          )}
          {!a.allowed && (
            <Notice tone="warning" title={`夜审要在 ${minuteText(board.rules.lateFullMinute)} 以后做`}>
              这时还在住的客人才要付今晚的房费。
            </Notice>
          )}
          <p className="text-[13.5px] text-ink-2">
            今晚还没挂房费的在住全天房：<b className="num">{a.pending}</b> 间
          </p>
          {error && <Notice tone="error" title={error} />}
        </div>
      )}
    </Dialog>
  );
}
