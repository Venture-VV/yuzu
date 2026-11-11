// 工作台 · 巡场（8.0.9，docs/PATROL_V809.md 第 3.2 节）：安保部门的人巡到哪里，就扫那里贴的场所二维码打卡。
// 网页里取景扫码（https），店里局域网用 http 打开时拍一张扫码；用手机相机、微信直接扫开的码在 App 里先记下、到这一页接着打卡。
// 断网也能扫：先记在这台手机上，联网后按原来的操作编号补交（XC7）。
// 8.0.11 巡场轮次（第 11 节）：一天按巡场间隔分轮，同一个场所每轮只记一次；下面列这一轮每个场所巡了没有，以及今天各轮的情况。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanteenMe } from '@shared/canteen';
import { parsePatrolToken, patrolIntervalText, type PatrolCheckinResult, type PatrolPortalDay, type PatrolRound, type PatrolScan, type PatrolVia } from '@shared/patrol';
import { Mascot } from '../Mascot';
import { IconShield } from '../doodles';
import { beep, call, timeText, unlockAudio, uuid } from '../lib';
import { enqueuePatrol, flushPatrol, loadPatrolQueue, submitPatrol, takePatrolLink, type QueuedPatrolScan, type PatrolOutcome } from '../patrol';
import { CameraError, decodeImageFile, preloadDecoder, startScanner } from '../scanner';
import { Button, Card, Pill, cn } from '../ui';

type Shown =
  | { status: 'ok' | 'already'; result: PatrolCheckinResult }
  | { status: 'queued' }
  | { status: 'error'; message: string };

export function PatrolPage({ me, offsetMs, online, go }: { me: CanteenMe; offsetMs: number; online: boolean; go: (route: string) => void }) {
  const employeeId = me.employee.id;
  const video = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const busyRef = useRef(false);
  const coolUntil = useRef(0);
  const [camera, setCamera] = useState<'off' | 'starting' | 'on'>('off');
  // 网页能不能开相机取景：要 https（或本机地址）和 getUserMedia；局域网 http 打开的不行，只能拍照识别
  const [liveCamera] = useState(() => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia);
  const [cameraError, setCameraError] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const [queued, setQueued] = useState(() => loadPatrolQueue(employeeId).length);
  const [settled, setSettled] = useState<{ item: QueuedPatrolScan; outcome: PatrolOutcome }[]>([]);
  const [day, setDay] = useState<PatrolPortalDay | null>(null);
  const [dayError, setDayError] = useState('');
  const hideTimer = useRef<number | undefined>(undefined);

  const refreshDay = useCallback(() => {
    call<PatrolPortalDay>('GET', '/api/canteen/patrol/day')
      .then((d) => {
        setDay(d);
        setDayError('');
      })
      .catch((e: unknown) => setDayError(e instanceof Error ? e.message : '今天的巡场没取到'));
  }, []);
  useEffect(() => refreshDay(), [refreshDay]);
  // 联网了、页面回到前台：今天的巡场也跟着重新取（打开时没网没取到的、过了营业日切换时间的，Codex 审查 7ae94b1、b0a8bf6）
  useEffect(() => {
    const visible = () => document.visibilityState === 'visible' && refreshDay();
    window.addEventListener('online', refreshDay);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', refreshDay);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refreshDay]);
  // 先把识别二维码的程序取下来（没有系统自带识别的手机要用），断网时也能扫
  useEffect(() => preloadDecoder(), []);

  const show = (s: Shown) => {
    setShown(s);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShown(null), s.status === 'ok' ? 3000 : 5000);
  };

  /** 一笔打卡：先存本机（存不下就不发），再交。相机连续识别时，一笔办完再停 1.5 秒才认下一个码 */
  const record = useCallback(
    async (code: string, via: PatrolVia, opts: { fromCamera?: boolean; atMs?: number } = {}) => {
      if (busyRef.current || (opts.fromCamera && Date.now() < coolUntil.current)) return;
      busyRef.current = true;
      try {
        if (!parsePatrolToken(code)) {
          beep('error');
          show({ status: 'error', message: '这不是巡场的场所码：请扫贴在场所里的巡场二维码' });
          return;
        }
        const body = { clientKey: uuid(), code, scannedAt: new Date((opts.atMs ?? Date.now()) + offsetMs).toISOString(), via };
        if (!enqueuePatrol(employeeId, { body, savedAt: Date.now() })) {
          beep('error');
          show({ status: 'error', message: '这台手机存不下记录（隐私模式或存储满了），为防止重复打卡，这一笔没有交' });
          return;
        }
        const outcome = await submitPatrol(employeeId, body);
        setQueued(loadPatrolQueue(employeeId).length);
        if (outcome.kind === 'done') {
          beep(outcome.result.status === 'ok' ? 'ok' : 'already');
          show({ status: outcome.result.status, result: outcome.result });
          refreshDay();
        } else if (outcome.kind === 'rejected') {
          beep('error');
          show({ status: 'error', message: outcome.error.message });
        } else {
          beep('queued');
          show({ status: 'queued' });
        }
      } finally {
        busyRef.current = false;
        coolUntil.current = Date.now() + 1500;
      }
    },
    [employeeId, offsetMs, refreshDay],
  );

  // 用手机相机、微信直接扫开的码：到这一页接着打卡（记的是打开链接的时间）
  useEffect(() => {
    const link = takePatrolLink();
    if (link) void record(link.token, 'link', { atMs: link.at });
    // 只在打开这一页时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 补交：每 10 秒一轮，联网时马上一轮
  useEffect(() => {
    let running = false;
    const round = async () => {
      if (running || !loadPatrolQueue(employeeId).length) return;
      running = true;
      try {
        const left = await flushPatrol(employeeId, (item, outcome) => setSettled((xs) => [{ item, outcome }, ...xs].slice(0, 20)));
        setQueued(left);
        refreshDay();
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
  }, [employeeId, refreshDay]);

  const onText = useCallback((text: string) => void record(text, 'scan', { fromCamera: true }), [record]);
  // 相机识别到码时调用最新的那个（换了人以后不会还记在上一位名下，Codex 审查 5966502）
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const start = async () => {
    unlockAudio();
    setCameraError('');
    setCamera('starting');
    try {
      stopRef.current = await startScanner(video.current!, (text) => onTextRef.current(text));
      setCamera('on');
    } catch (e) {
      setCamera('off');
      setCameraError(e instanceof CameraError ? e.message : '相机打不开，可以「拍一张扫码」，或者直接用手机相机扫贴着的码');
    }
  };
  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
    setCamera('off');
  };
  useEffect(() => () => stopRef.current?.(), []);
  // 换了人（同一台手机另一个标签页登录了别人，这一页刷新成那一位）：关掉还开着的相机、要这一位自己再点开，
  // 等补交的笔数、刚补交的也换成这一位的（Codex 审查 5966502）
  const shownFor = useRef(employeeId);
  useEffect(() => {
    if (shownFor.current === employeeId) return;
    shownFor.current = employeeId;
    stopRef.current?.();
    stopRef.current = null;
    setCamera('off');
    setQueued(loadPatrolQueue(employeeId).length);
    setSettled([]);
    setShown(null);
  }, [employeeId]);

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    unlockAudio();
    try {
      const text = await decodeImageFile(file);
      if (!text) {
        beep('error');
        show({ status: 'error', message: '这张照片里没找到二维码：凑近一点、对准场所二维码再拍' });
        return;
      }
      await record(text, 'photo');
    } catch {
      show({ status: 'error', message: '这张照片读不了，再拍一张试试' });
    }
  };

  const current = day?.rounds.find((r) => r.state === 'current') ?? null;
  const ci = current ? day!.rounds.indexOf(current) : -1;
  // 这一轮要巡、还没巡的排在前面
  const points = day
    ? day.points
        .filter((p) => ci < 0 || p.byRound[ci] !== null)
        .sort((a, b) => Number(ci >= 0 && (a.byRound[ci]?.length ?? 0) > 0) - Number(ci >= 0 && (b.byRound[ci]?.length ?? 0) > 0))
    : [];
  return (
    <div className="space-y-4" data-testid="patrol-page">
      <div className="flex items-end justify-between gap-2">
        <h1 className="flex items-center gap-1.5 text-[24px] font-black tracking-tight">
          <IconShield size={28} fill="var(--color-yuzu)" /> 巡场
        </h1>
        <div className="flex items-center gap-2">
          {queued > 0 && (
            <Pill tone="sky">
              <span data-testid="patrol-queued">{queued}</span> 条等联网补交
            </Pill>
          )}
          {me.apps?.includes('patrolLog') && (
            <button type="button" onClick={() => go('patrolLog')} className="text-[14px] font-bold text-wood-deep underline">
              巡场记录
            </button>
          )}
        </div>
      </div>
      {!online && <p className="rounded-2xl bg-sky-soft px-4 py-2.5 text-[14px] font-bold text-relax">📶 现在没网：照样扫，先记在手机上，联网后自动补交</p>}

      <div className="relative overflow-hidden rounded-[28px] bg-ink shadow-[var(--shadow-pop)]">
        <video ref={video} className={cn('aspect-square w-full object-cover', camera !== 'on' && 'opacity-0')} playsInline muted />
        {camera !== 'on' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <Mascot mood={cameraError ? 'oops' : 'happy'} className="size-20" />
            {cameraError && <p className="text-[14px] font-bold text-yuzu">{cameraError}</p>}
            {liveCamera ? (
              <Button big onClick={() => void start()} disabled={camera === 'starting'} data-testid="patrol-start">
                {camera === 'starting' ? '正在打开相机…' : '扫码打卡'}
              </Button>
            ) : (
              <>
                <p className="text-[14px] font-bold text-white" data-testid="patrol-lan-hint">
                  店里局域网打开的，网页里开不了相机取景：点下面拍一张场所二维码；也可以直接用手机相机扫贴着的码
                </p>
                <label className="inline-flex h-14 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-wood px-6 text-[17px] font-black text-white shadow-[0_4px_0_var(--color-wood-ink)] active:translate-y-[3px] active:shadow-[0_1px_0_var(--color-wood-ink)]">
                  📷 拍一张扫码
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    data-testid="patrol-photo"
                    onChange={(e) => void pickImage(e.target.files?.[0]).finally(() => (e.target.value = ''))}
                  />
                </label>
              </>
            )}
          </div>
        )}
        {camera === 'on' && (
          <button type="button" onClick={stop} className="absolute right-3 bottom-3 rounded-full bg-black/55 px-4 py-2 text-[14px] font-bold text-white">
            关掉相机
          </button>
        )}
      </div>

      {shown && (
        <Card
          className={cn(
            'px-4 py-4 text-center',
            shown.status === 'ok' && 'bg-organic-soft ring-2 ring-organic',
            shown.status === 'already' && 'bg-yuzu-soft ring-2 ring-yuzu-deep/40',
            shown.status === 'queued' && 'bg-sky-soft ring-2 ring-relax/40',
            shown.status === 'error' && 'bg-peach-soft ring-2 ring-berry/40',
          )}
          data-testid="patrol-result"
        >
          {shown.status === 'ok' && (
            <>
              <p className="text-[26px] font-black text-leaf-deep">✓ {shown.result.checkin.pointName}</p>
              <p className="mt-1 text-[15px] font-bold text-ink-2">
                {timeText(shown.result.checkin.at)} 打卡成功
                {shown.result.round ? ` · 第 ${shown.result.round.no} 轮（${timeText(shown.result.round.start)}–${timeText(shown.result.round.end)}）` : ''}
                {shown.result.checkin.late ? '（离线补交）' : ''}
              </p>
            </>
          )}
          {shown.status === 'already' && (
            <>
              <p className="text-[22px] font-black text-wood-deep">这一轮已打过卡</p>
              <p className="mt-1 text-[15px] font-bold text-ink-2" data-testid="patrol-already">
                {shown.result.checkin.pointName}
                {shown.result.round ? ` 第 ${shown.result.round.no} 轮` : ''} 已由{shown.result.checkin.mine ? '你' : ` ${shown.result.checkin.employeeName} `}在 {timeText(shown.result.checkin.at)} 打过，不重复记
              </p>
              {shown.result.round && <p className="mt-0.5 text-[13px] text-ink-3">下一轮 {timeText(shown.result.round.end)} 开始</p>}
            </>
          )}
          {shown.status === 'queued' && <p className="text-[17px] font-black text-relax">已记在手机上，联网后自动补交</p>}
          {shown.status === 'error' && <p className="text-[16px] font-black text-berry">{shown.message}</p>}
        </Card>
      )}

      {settled.length > 0 && (
        <Card className="px-4 py-3">
          <p className="text-[14px] font-black">刚补交的</p>
          <ul className="mt-1 space-y-1 text-[13px]">
            {settled.slice(0, 5).map(({ item, outcome }) => (
              <li key={item.body.clientKey} className={cn(outcome.kind === 'rejected' ? 'text-berry' : 'text-ink-2')}>
                {timeText(item.body.scannedAt)}{' '}
                {outcome.kind === 'done' ? `✓ ${outcome.result.checkin.pointName}${outcome.result.status === 'already' ? '（这一轮已打过）' : ''}` : outcome.kind === 'rejected' ? `✗ ${outcome.error.message}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="px-4 py-3" data-testid="patrol-today">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[17px] font-black">{current ? `这一轮 · 第 ${current.no} 轮` : '今天的巡场'}</p>
          {day && (
            <p className="text-[13px] font-bold text-ink-3">
              我今天巡了 <b className="num text-ink">{day.mine}</b> 次
            </p>
          )}
        </div>
        {current && (
          <p className="mt-0.5 text-[13px] font-bold text-ink-2" data-testid="patrol-current-round">
            {timeText(current.start)}–{timeText(current.end)} · 巡了 {current.done}/{current.expected} 处 · 还没巡{' '}
            <b className={cn('num', (day?.currentMissing ?? 0) > 0 ? 'text-berry' : 'text-ink')}>{day?.currentMissing ?? 0}</b> 处
          </p>
        )}
        {day && <p className="mt-0.5 text-[12px] text-ink-3">每 {patrolIntervalText(day.roundMinutes)}一轮，同一个场所每轮只记一次；今天已经漏巡 {day.missed} 处次</p>}
        {dayError && <p className="mt-2 text-[13px] font-bold text-berry">{dayError}</p>}
        {day && points.length === 0 && <p className="mt-2 text-[14px] text-ink-3">还没有场所：请管理员在后台「安保巡场」里添加</p>}
        <ul className="mt-2 divide-y divide-line">
          {points.map((p) => {
            const now = ci >= 0 ? p.byRound[ci] ?? [] : p.scans;
            return (
              <li key={p.id} className="flex items-start gap-3 py-2.5" data-testid={`patrol-point-${p.name}`}>
                <span className={cn('mt-0.5 text-[18px]', now.length > 0 ? 'text-leaf-deep' : 'text-berry')}>{now.length > 0 ? '✓' : '○'}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-black">
                    {p.name}
                    {!p.active && <span className="ml-1 text-[12px] font-bold text-ink-3">（已停用）</span>}
                  </span>
                  {p.area && <span className="block text-[12px] text-ink-3">{p.area}</span>}
                  {now.length > 0 ? (
                    <span className="mt-0.5 block text-[13px] text-ink-2">{now.map((x) => `${timeText(x.at)} ${x.name}${x.late ? '（补交）' : ''}`).join('、')}</span>
                  ) : (
                    <span className="mt-0.5 block text-[13px] font-bold text-berry">{ci >= 0 ? '这一轮还没巡' : '今天还没人巡'}</span>
                  )}
                  {day && <RoundDots rounds={day.rounds} cells={p.byRound} />}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

/** 一个场所今天各轮的小圆点：绿 = 巡了，红 = 漏巡，黄 = 正在巡、还没打，灰 = 还没到；不用巡的那一轮空着 */
export function RoundDots({ rounds, cells }: { rounds: PatrolRound[]; cells: (PatrolScan[] | null)[] }) {
  return (
    <span className="mt-1 flex flex-wrap gap-1" aria-label="今天各轮">
      {rounds.map((r, i) => {
        const c = cells[i] ?? null;
        const tone = c === null ? 'bg-transparent ring-1 ring-line' : c.length > 0 ? 'bg-organic' : r.state === 'past' ? 'bg-berry' : r.state === 'current' ? 'bg-yuzu' : 'bg-cream-2';
        const label = `第 ${r.no} 轮 ${timeText(r.start)}–${timeText(r.end)}：${c === null ? '不用巡' : c.length > 0 ? `${timeText(c[0]!.at)} ${c[0]!.name}` : r.state === 'past' ? '漏巡' : r.state === 'current' ? '还没巡' : '还没到'}`;
        return <span key={r.no} title={label} aria-label={label} className={cn('inline-block size-2.5 rounded-full', tone, r.state === 'current' && 'outline-2 outline-offset-1 outline-yuzu-deep/50')} />;
      })}
    </span>
  );
}
