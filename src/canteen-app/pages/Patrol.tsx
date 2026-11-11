// 工作台 · 巡场（8.0.9，docs/PATROL_V809.md 第 3.2 节）：安保部门的人巡到哪里，就扫那里贴的场所二维码打卡。
// 网页里取景扫码（https），店里局域网用 http 打开时拍一张扫码；用手机相机、微信直接扫开的码在 App 里先记下、到这一页接着打卡。
// 断网也能扫：先记在这台手机上，联网后按原来的操作编号补交（XC7）。下面列今天每个场所谁几点巡过、还没人巡的。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanteenMe } from '@shared/canteen';
import { parsePatrolToken, type PatrolCheckinResult, type PatrolPortalDay, type PatrolVia } from '@shared/patrol';
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
  const start = async () => {
    unlockAudio();
    setCameraError('');
    setCamera('starting');
    try {
      stopRef.current = await startScanner(video.current!, onText);
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

  const points = day ? [...day.points].sort((a, b) => Number(a.count > 0) - Number(b.count > 0)) : [];
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
                {timeText(shown.result.checkin.at)} 打卡成功 · 今天这里第 {shown.result.pointCount} 次{shown.result.checkin.late ? '（离线补交）' : ''}
              </p>
            </>
          )}
          {shown.status === 'already' && (
            <>
              <p className="text-[22px] font-black text-wood-deep">刚打过卡啦</p>
              <p className="mt-1 text-[15px] font-bold text-ink-2">
                {shown.result.checkin.pointName} · {timeText(shown.result.checkin.at)} 已经记过，不重复记
              </p>
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
                {outcome.kind === 'done' ? `✓ ${outcome.result.checkin.pointName}${outcome.result.status === 'already' ? '（已记过）' : ''}` : outcome.kind === 'rejected' ? `✗ ${outcome.error.message}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="px-4 py-3" data-testid="patrol-today">
        <div className="flex items-baseline justify-between">
          <p className="text-[17px] font-black">今天的巡场</p>
          {day && (
            <p className="text-[13px] font-bold text-ink-3">
              我巡了 <b className="num text-ink">{day.mine}</b> 次 · 还没人巡 <b className={cn('num', day.missing > 0 ? 'text-berry' : 'text-ink')}>{day.missing}</b> 处
            </p>
          )}
        </div>
        {dayError && <p className="mt-2 text-[13px] font-bold text-berry">{dayError}</p>}
        {day && points.length === 0 && <p className="mt-2 text-[14px] text-ink-3">还没有场所：请管理员在后台「安保巡场」里添加</p>}
        <ul className="mt-2 divide-y divide-line">
          {points.map((p) => (
            <li key={p.id} className="flex items-start gap-3 py-2.5" data-testid={`patrol-point-${p.name}`}>
              <span className={cn('mt-0.5 text-[18px]', p.count > 0 ? 'text-leaf-deep' : 'text-berry')}>{p.count > 0 ? '✓' : '○'}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-black">
                  {p.name}
                  {!p.active && <span className="ml-1 text-[12px] font-bold text-ink-3">（已停用）</span>}
                </span>
                {p.area && <span className="block text-[12px] text-ink-3">{p.area}</span>}
                {p.count > 0 ? (
                  <span className="mt-0.5 block text-[13px] text-ink-2">
                    {p.scans.map((s) => `${timeText(s.at)} ${s.name}${s.late ? '（补交）' : ''}`).join('、')}
                  </span>
                ) : (
                  <span className="mt-0.5 block text-[13px] font-bold text-berry">今天还没人巡</span>
                )}
              </span>
              {p.count > 0 && <span className="num shrink-0 text-[15px] font-black">{p.count} 次</span>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
