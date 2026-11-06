// 扫码打卡（食堂负责人）：相机对准员工的饭卡码，叮咚一声就记下；没带手机的同事手动登记；登记错了当天可以撤销。
// 每一笔先存在这台手机上再交给门店系统，没网时显示「已记下」，联网后自动按原编号补交（queue.ts）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { MEAL_EMOJI, MEAL_LABELS, MEALS, type CanteenCheckinRow, type CanteenMe, type CanteenPerson, type CanteenToday, type CheckinResult } from '@shared/canteen';
import { Mascot } from '../Mascot';
import { ApiError, beep, call, messageOf, timeText, unlockAudio, uuid } from '../lib';
import { enqueue, flush, loadQueue, submit, type Outcome, type QueuedScan, type ScanBody } from '../queue';
import { CameraError, decodeImageFile, startScanner } from '../scanner';
import { Button, Card, cn, inputClass, Pill, Sheet, toast } from '../ui';

type Shown =
  | { status: 'ok' | 'already'; result: CheckinResult }
  | { status: 'error'; message: string; code: string }
  | { status: 'queued'; label: string };

export function ScanPage({ me, offsetMs, online }: { me: CanteenMe; offsetMs: number; online: boolean }) {
  const managerId = me.employee.id;
  const video = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const busyRef = useRef(false);
  const coolUntil = useRef(0);
  const [camera, setCamera] = useState<'off' | 'starting' | 'on'>('off');
  const [cameraError, setCameraError] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const [today, setToday] = useState<CanteenToday | null>(null);
  const [queued, setQueued] = useState(() => loadQueue(managerId).length);
  const [settled, setSettled] = useState<{ item: QueuedScan; outcome: Outcome }[]>([]);
  const [manual, setManual] = useState(false);
  const [voiding, setVoiding] = useState<CanteenCheckinRow | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  const refreshToday = useCallback(() => {
    call<CanteenToday>('GET', '/api/canteen/today')
      .then(setToday)
      .catch(() => undefined);
  }, []);
  useEffect(() => refreshToday(), [refreshToday]);

  const show = (s: Shown) => {
    setShown(s);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShown(null), s.status === 'ok' ? 2200 : 4500);
  };

  /** 一笔登记：先存本机（存不下就不发），再交；结果显示成大卡片。相机连续识别时，一笔办完再停 0.9 秒才认下一个码 */
  const record = useCallback(
    async (body: Omit<ScanBody, 'clientKey' | 'scannedAt'>, label: string, fromCamera = false) => {
      if (busyRef.current || (fromCamera && Date.now() < coolUntil.current)) {
        if (!fromCamera) toast('上一笔还在登记，稍等一下', 'info');
        return;
      }
      busyRef.current = true;
      try {
        const full: ScanBody = { ...body, clientKey: uuid(), scannedAt: new Date(Date.now() + offsetMs).toISOString() };
        if (!enqueue(managerId, { body: full, label, savedAt: Date.now() })) {
          beep('error');
          show({ status: 'error', code: 'STORE', message: '这台手机存不下记录（隐私模式或存储满了），为防止重复登记，这一笔没有交' });
          return;
        }
        const outcome = await submit(managerId, full);
        setQueued(loadQueue(managerId).length);
        if (outcome.kind === 'done') {
          beep(outcome.result.status === 'ok' ? 'ok' : 'already');
          show({ status: outcome.result.status, result: outcome.result });
          refreshToday();
        } else if (outcome.kind === 'rejected') {
          beep('error');
          show({ status: 'error', code: outcome.error.code, message: outcome.error.message });
        } else {
          beep('queued');
          show({ status: 'queued', label });
        }
      } finally {
        busyRef.current = false;
        coolUntil.current = Date.now() + 900;
      }
    },
    [managerId, offsetMs, refreshToday],
  );

  // 补交：每 10 秒一轮，联网时马上一轮
  useEffect(() => {
    let running = false;
    const round = async () => {
      if (running || !loadQueue(managerId).length) return;
      running = true;
      try {
        const left = await flush(managerId, (item, outcome) => setSettled((xs) => [{ item, outcome }, ...xs].slice(0, 20)));
        setQueued(left);
        refreshToday();
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void round(), 10_000);
    window.addEventListener('online', round);
    void round();
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', round);
    };
  }, [managerId, refreshToday]);

  const onText = useCallback((text: string) => void record({ code: text }, '扫码', true), [record]);

  const start = async () => {
    unlockAudio();
    setCameraError('');
    setCamera('starting');
    try {
      stopRef.current = await startScanner(video.current!, onText);
      setCamera('on');
    } catch (e) {
      setCamera('off');
      setCameraError(e instanceof CameraError ? e.message : '相机打不开，可以先用「从相册选」或「手动登记」');
    }
  };
  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
    setCamera('off');
  };
  useEffect(() => () => stopRef.current?.(), []);

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    unlockAudio();
    try {
      const text = await decodeImageFile(file);
      if (!text) {
        beep('error');
        show({ status: 'error', code: 'NO_QR', message: '这张图里没找到二维码' });
        return;
      }
      await record({ code: text }, '相册');
    } catch {
      show({ status: 'error', code: 'NO_QR', message: '这张图读不了，换一张试试' });
    }
  };

  const current = today?.current;
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <h1 className="text-[24px] font-black tracking-tight">扫码打卡 📷</h1>
        {queued > 0 && (
          <Pill tone="sky">
            <span data-testid="queued-count">{queued}</span> 条等联网补登
          </Pill>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2">
        {MEALS.filter((m) => today?.meals.find((w) => w.meal === m)?.enabled ?? m !== 'supper').map((m) => (
          <div key={m} className={cn('rounded-2xl px-2 py-2 text-center ring-1', current?.meal === m ? 'bg-yuzu ring-yuzu-deep/30' : 'bg-card ring-line')}>
            <p className="text-[12px] font-bold text-ink-2">
              {MEAL_EMOJI[m]} {MEAL_LABELS[m]}
            </p>
            <p className="num text-[22px] leading-tight font-black" data-testid={`count-${m}`}>
              {today?.counts[m] ?? '–'}
            </p>
          </div>
        ))}
      </div>
      {today && !current && <p className="rounded-2xl bg-cream-2 px-4 py-2.5 text-[14px] font-bold text-ink-2">现在不是开饭时间，扫了也不会记</p>}
      {!online && <p className="rounded-2xl bg-sky-soft px-4 py-2.5 text-[14px] font-bold text-[#1f6fa8]">📶 现在没网：照样扫，先记在手机上，联网后自动补登</p>}

      <div className="relative overflow-hidden rounded-[28px] bg-ink shadow-[var(--shadow-pop)]">
        <video ref={video} className={cn('aspect-square w-full object-cover', camera !== 'on' && 'opacity-0')} playsInline muted />
        {camera !== 'on' && !shown && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <Mascot mood={cameraError ? 'oops' : 'happy'} className="size-20" />
            {cameraError && <p className="text-[14px] font-bold text-yuzu">{cameraError}</p>}
            <Button big onClick={() => void start()} disabled={camera === 'starting'}>
              {camera === 'starting' ? '正在打开相机…' : '开始扫码'}
            </Button>
          </div>
        )}
        {camera === 'on' && (
          <>
            {/* 取景框：四个圆角 */}
            <div className="pointer-events-none absolute inset-[14%] rounded-[24px] shadow-[0_0_0_999px_rgb(59_47_42/0.35)]">
              {['top-0 left-0 border-t-4 border-l-4 rounded-tl-[24px]', 'top-0 right-0 border-t-4 border-r-4 rounded-tr-[24px]', 'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-[24px]', 'bottom-0 right-0 border-b-4 border-r-4 rounded-br-[24px]'].map(
                (c) => (
                  <span key={c} className={cn('absolute size-10 border-yuzu', c)} />
                ),
              )}
            </div>
            <button type="button" onClick={stop} className="absolute top-3 right-3 rounded-full bg-black/50 px-3 py-1.5 text-[13px] font-bold text-white">
              暂停
            </button>
            <p className="absolute inset-x-0 bottom-3 text-center text-[14px] font-bold text-white drop-shadow">对准员工的饭卡码</p>
          </>
        )}
        {shown && <ResultCard shown={shown} onClose={() => setShown(null)} />}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex h-12 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-white/70 text-[15px] font-bold text-ink-2 ring-1 ring-line active:scale-[0.97]">
          🖼️ 从相册选
          <input type="file" accept="image/*" className="hidden" data-testid="scan-file" onChange={(e) => void pickImage(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
        </label>
        <Button tone="ghost" className="h-12" onClick={() => setManual(true)}>
          ✍️ 手动登记
        </Button>
      </div>

      {settled.length > 0 && (
        <Card>
          <h2 className="text-[15px] font-extrabold">补登结果</h2>
          <ul className="mt-2 space-y-1.5 text-[14px]">
            {settled.map(({ item, outcome }) => (
              <li key={item.body.clientKey} className="flex items-center gap-2" data-testid="settled-item">
                {outcome.kind === 'done' ? (
                  <>
                    <span>{outcome.result.status === 'ok' ? '✅' : '🟡'}</span>
                    <span className="font-bold">{outcome.result.checkin.name}</span>
                    <span className="text-ink-2">
                      {MEAL_LABELS[outcome.result.checkin.meal]} {outcome.result.status === 'ok' ? '补登成功' : '之前已经打过卡'}
                    </span>
                  </>
                ) : (
                  <>
                    <span>❌</span>
                    <span className="text-berry">{outcome.kind === 'rejected' ? outcome.error.message : ''}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <section>
        <h2 className="mb-2 px-1 text-[15px] font-extrabold text-ink-2">刚刚打卡的</h2>
        <Card className="py-1">
          {!today?.recent.length && <p className="py-4 text-center text-[14px] text-ink-3">还没有人打卡</p>}
          <ul className="divide-y divide-line/70">
            {today?.recent.slice(0, 15).map((r) => (
              <li key={r.id} className={cn('flex items-center gap-3 py-2.5', r.voidedAt && 'opacity-50')}>
                <span className="text-[24px]">{r.avatar}</span>
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate text-[15px] font-bold', r.voidedAt && 'line-through')}>
                    {r.name} <span className="num text-[13px] font-semibold text-ink-3">{r.empNo}</span>
                  </p>
                  <p className="text-[12px] text-ink-2">
                    {MEAL_LABELS[r.meal]} · {timeText(r.scannedAt)}
                    {r.method === 'manual' && ' · 手动'}
                    {r.voidedAt && ` · 已撤销：${r.voidReason}`}
                  </p>
                </div>
                {!r.voidedAt && r.recorderName === me.employee.name && (
                  <button type="button" onClick={() => setVoiding(r)} className="rounded-full px-3 py-1.5 text-[13px] font-bold text-berry active:bg-berry-soft">
                    撤销
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <Sheet open={manual} onClose={() => setManual(false)} title="手动登记">
        <ManualPicker
          onPick={(p, note) => {
            setManual(false);
            unlockAudio();
            void record({ employeeId: p.id, note }, p.name);
          }}
        />
      </Sheet>
      <Sheet open={!!voiding} onClose={() => setVoiding(null)} title="撤销这次登记">
        {voiding && (
          <VoidForm
            row={voiding}
            onDone={() => {
              setVoiding(null);
              refreshToday();
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

function ResultCard({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  const tone =
    shown.status === 'ok' ? 'bg-leaf text-white' : shown.status === 'already' ? 'bg-yuzu text-ink' : shown.status === 'queued' ? 'bg-sky text-white' : 'bg-berry text-white';
  return (
    <button type="button" onClick={onClose} className={cn('absolute inset-0 flex animate-pop flex-col items-center justify-center gap-2 p-6 text-center', tone)} data-testid="scan-result" data-status={shown.status}>
      {shown.status === 'ok' || shown.status === 'already' ? (
        <>
          <span className="text-[56px] leading-none">{shown.result.checkin.avatar}</span>
          <p className="text-[28px] font-black">{shown.result.checkin.name}</p>
          <p className="num text-[15px] font-bold opacity-90">
            {shown.result.checkin.empNo}
            {shown.result.checkin.department && ` · ${shown.result.checkin.department}`}
          </p>
          <p className="mt-2 rounded-full bg-black/15 px-4 py-1.5 text-[18px] font-black">
            {shown.status === 'ok'
              ? `✓ ${MEAL_LABELS[shown.result.checkin.meal]}打卡成功 · 第 ${shown.result.mealCount} 位`
              : `已经打过卡啦（${timeText(shown.result.checkin.scannedAt)}）`}
          </p>
        </>
      ) : shown.status === 'queued' ? (
        <>
          <span className="text-[56px] leading-none">📮</span>
          <p className="text-[24px] font-black">已记下</p>
          <p className="text-[15px] font-bold opacity-90">现在连不上门店系统，联网后自动补登</p>
        </>
      ) : (
        <>
          <span className="text-[56px] leading-none">🙅</span>
          <p className="text-[22px] font-black">没登记上</p>
          <p className="max-w-[300px] text-[15px] font-bold opacity-95">{shown.status === 'error' ? shown.message : ''}</p>
        </>
      )}
      <span className="mt-3 text-[12px] font-bold opacity-75">点一下继续扫</span>
    </button>
  );
}

function ManualPicker({ onPick }: { onPick: (p: CanteenPerson, note: string) => void }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<CanteenPerson[] | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      call<CanteenPerson[]>('GET', `/api/canteen/people?q=${encodeURIComponent(q)}`)
        .then(setPeople)
        .catch((e) => toast(messageOf(e), 'error'));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="space-y-3 pb-6">
      <input className={inputClass} placeholder="搜姓名或工号" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜姓名或工号" />
      <div className="flex flex-wrap gap-1.5">
        {['手机没电', '没带手机', '码打不开'].map((n) => (
          <button key={n} type="button" onClick={() => setNote(note === n ? '' : n)} className={cn('rounded-full px-3 py-1 text-[13px] font-bold', note === n ? 'bg-ink text-cream' : 'bg-card ring-1 ring-line')}>
            {n}
          </button>
        ))}
      </div>
      <ul className="max-h-[46dvh] divide-y divide-line/70 overflow-y-auto rounded-2xl bg-card px-3">
        {people?.length === 0 && <li className="py-4 text-center text-[14px] text-ink-3">没找到</li>}
        {people?.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-2.5">
            <span className="text-[24px]">{p.avatar}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-bold">{p.name}</p>
              <p className="num text-[12px] text-ink-2">
                {p.empNo}
                {p.department && ` · ${p.department}`}
              </p>
            </div>
            {p.checkedIn ? (
              <Pill tone="leaf">已打卡</Pill>
            ) : (
              <Button className="h-9 px-3 text-[14px]" onClick={() => onPick(p, note)}>
                登记
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function VoidForm({ row, onDone }: { row: CanteenCheckinRow; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await call('POST', `/api/canteen/checkins/${row.id}/void`, { reason });
      toast('撤销了', 'ok');
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : messageOf(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 pb-6">
      <p className="text-[15px]">
        撤销 <b>{row.name}</b> 的{MEAL_LABELS[row.meal]}登记（{timeText(row.scannedAt)}）？
      </p>
      <div className="flex flex-wrap gap-1.5">
        {['扫错人了', '重复登记', '登记错餐次'].map((n) => (
          <button key={n} type="button" onClick={() => setReason(n)} className={cn('rounded-full px-3 py-1 text-[13px] font-bold', reason === n ? 'bg-ink text-cream' : 'bg-card ring-1 ring-line')}>
            {n}
          </button>
        ))}
      </div>
      <input className={inputClass} placeholder="撤销原因" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={100} aria-label="撤销原因" />
      <Button tone="peach" big className="w-full" disabled={busy || !reason.trim()} onClick={() => void submit()}>
        撤销
      </Button>
    </div>
  );
}
