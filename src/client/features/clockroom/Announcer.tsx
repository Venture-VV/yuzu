// 排位播报（8.1.15，docs/TECHNICIANS_V8115.md 第 3 节）：钟房顶上的一条。
//   · 叫号（派钟时自动记、手动叫号另记）在服务端各有一条记录，随看板一起取回来；只有登记成「主播报终端」的这一个浏览器念，
//     别的终端看得到是哪一台在念、可以明确地接管——几台终端同时开着钟房不会重复念。
//   · 这台终端的音量与静音记在本机；静音时这一条整条变红、写明「已静音」，期间没念的有几条也写着。
//   · 页面刚打开时已经有的叫号不补念；只念之后新来的、且不超过一分半钟的（页面在后台停了一阵再回来，不把旧的都念一遍）。
//   · 浏览器要先点过一下页面才肯出声：点「由本机播报」「取消静音」「试音」都算；刷新以后没点过的，条上提示点一下。

import { useEffect, useRef, useState } from 'react';
import { Megaphone, Play, Radio, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { ClockroomBoard } from '@shared/clockroom';
import { ANNOUNCER_STALE_MS, CALL_SPEAK_WITHIN_MS, spokenText } from '@shared/technician-admin';
import { api, errorMessage } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useSpeech } from '../../lib/speech';
import { cn, formatTime, uuid } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Button, Card } from '../../components/ui';
import { useTerminalState } from '../devices/terminal';

const CLIENT_KEY = 'yuzu.clock.announcer.client';
const PREF_KEY = 'yuzu.clock.announcer.pref';

interface Pref {
  muted: boolean;
  /** 0–100 */
  volume: number;
}

const DEFAULT_PREF: Pref = { muted: false, volume: 100 };

function readPref(): Pref {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null') as Partial<Pref> | null;
    const volume = Number(raw?.volume);
    return { muted: raw?.muted === true, volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : DEFAULT_PREF.volume };
  } catch {
    return DEFAULT_PREF;
  }
}

function savePref(pref: Pref) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    /* 存不下就只在这次打开时有效 */
  }
}

let memoryClientId: string | null = null;

/** 这个浏览器的编号（记在本机；存不了就只在这次打开时有效——刷新以后算另一台，要重新点「由本机播报」） */
function announcerClientId(): string {
  try {
    const saved = localStorage.getItem(CLIENT_KEY);
    if (saved && /^[0-9A-Za-z-]{8,64}$/.test(saved)) return saved;
    const id = uuid();
    localStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    return (memoryClientId ??= uuid());
  }
}

export function AnnouncerBar({ board, onBoard }: { board: ClockroomBoard; onBoard: (board: ClockroomBoard) => void }) {
  const toast = useToast();
  const terminal = useTerminalState().terminal;
  const speech = useSpeech();
  const { speak } = speech;
  const [clientId] = useState(announcerClientId);
  const [pref, setPrefState] = useState(readPref);
  const [busy, setBusy] = useState(false);
  const [missed, setMissed] = useState(0);
  const prefRef = useRef(pref);
  prefRef.current = pref;

  const claim = board.announcer;
  const mine = claim?.clientId === clientId;
  const label = terminal ? `终端 ${terminal}` : `浏览器 ${clientId.slice(0, 4).toUpperCase()}`;
  const last = board.calls.at(-1) ?? null;
  const serverNow = new Date(board.serverTime).getTime();
  const awayMinutes = claim && !mine ? Math.floor((serverNow - new Date(claim.seenAt).getTime()) / 60_000) : 0;
  const stale = !!claim && !mine && serverNow - new Date(claim.seenAt).getTime() > ANNOUNCER_STALE_MS;

  const setPref = (next: Pref) => {
    setPrefState(next);
    savePref(next);
  };

  // 新来的叫号：只有主播报终端念。cursor 是已经处理到哪一条；页面刚打开时已经有的不补念
  const cursor = useRef<number | null>(null);
  useEffect(() => {
    const latest = board.calls.at(-1)?.id ?? 0;
    if (cursor.current === null) {
      cursor.current = latest;
      return;
    }
    const seen = cursor.current;
    if (latest <= seen) return;
    cursor.current = latest;
    if (!mine) return;
    const now = new Date(board.serverTime).getTime();
    const due = board.calls.filter((c) => c.id > seen && now - new Date(c.at).getTime() <= CALL_SPEAK_WITHIN_MS);
    if (due.length === 0) return;
    if (prefRef.current.muted) {
      setMissed((n) => n + due.length);
      return;
    }
    for (const c of due) speak(spokenText(c.text), prefRef.current.volume / 100);
  }, [board, mine, speak]);

  // 主播报终端开着钟房每半分钟报到一次：别的终端据此知道它还在不在
  useLivePoll(
    async (isLive) => {
      if (!mine) return;
      try {
        const next = await api.post<ClockroomBoard>('/api/clockroom/announcer', { action: 'heartbeat', clientId, label });
        if (isLive()) onBoard(next);
      } catch {
        /* 报到没发出去：下一轮再报 */
      }
    },
    [mine, clientId, label],
    { intervalMs: 30_000 },
  );

  const send = async (action: 'claim' | 'release') => {
    // 在点的这一下里先让浏览器允许出声
    if (action === 'claim') speech.prime();
    setBusy(true);
    try {
      onBoard(await api.post<ClockroomBoard>('/api/clockroom/announcer', { action, clientId, label }));
      if (action === 'claim') {
        if (!pref.muted) speak('本机开始播报叫号', pref.volume / 100);
        toast({ tone: 'success', title: '已由本机播报叫号', body: pref.muted ? '现在是静音，取消静音以后才出声。' : undefined });
      } else {
        speech.stop();
        toast({ tone: 'info', title: '本机不再播报叫号', body: '在要播报的那台终端上点「由本机播报」。' });
      }
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const toggleMute = () => {
    const muted = !pref.muted;
    setPref({ ...pref, muted });
    if (muted) speech.stop();
    else {
      speech.prime();
      setMissed(0);
    }
  };

  const muted = mine && pref.muted;
  const tone = muted ? 'clay' : mine ? 'pine' : 'ember';
  const state = !speech.supported ? '这个浏览器不能朗读' : muted ? '已静音：叫号不会出声' : mine ? '本机播报中' : claim ? '播报在另一台终端' : '还没有终端负责播报';

  return (
    <Card
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3', muted && 'border-clay bg-clay-soft')}
      data-testid="announcer-bar"
      data-announcer={mine ? (muted ? 'muted' : 'on') : claim ? 'other' : 'none'}
    >
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
        <span
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full',
            tone === 'clay' ? 'bg-clay text-paper' : tone === 'pine' ? 'bg-pine-soft text-pine' : 'bg-ember-soft text-ember-deep',
          )}
          aria-hidden
        >
          {muted ? <VolumeX className="size-5" /> : mine ? <Volume2 className="size-5" /> : <Radio className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-ink-3">排位播报</p>
          <p
            className={cn('text-[16px] font-bold', tone === 'clay' ? 'text-clay' : tone === 'pine' ? 'text-pine' : 'text-ember-deep')}
            role="status"
            data-testid={muted ? 'announcer-muted' : 'announcer-state'}
          >
            {state}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink-2">
            {muted && (missed > 0 ? `静音期间有 ${missed} 次叫号没有念。` : '取消静音以后，新的叫号照常念。')}
            {!muted && mine && (speech.blocked ? '浏览器还没让出声：点一下「试音」。' : !speech.hasVoice ? '没找到中文的朗读声音，可能念不出来：点「试音」听一下。' : '')}
            {!mine && claim && (
              <span data-testid="announcer-other">
                {claim.label || '另一台终端'}（{claim.claimedByName} {formatTime(claim.claimedAt)} 起）在念，本机不出声。
                {stale && <span className="font-semibold text-ember-deep"> 那台终端已经 {awayMinutes} 分钟没有报到，可能关掉了。</span>}
              </span>
            )}
            {!mine && !claim && speech.supported && '叫号现在不会出声：在要播报的终端上点「由本机播报」。'}
            {!speech.supported && '换一台能朗读的终端（门店电脑的浏览器）来播报。'}
          </p>
          {last && (
            <p className="mt-1 truncate text-[13px] text-ink-2" data-testid="announcer-last">
              <span className="text-ink-3">最近叫号 {formatTime(last.at)}：</span>
              <span className="font-semibold text-ink">{last.text}</span>
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {mine ? (
          <>
            <label className="flex h-11 items-center gap-2 rounded-md border border-line-strong bg-card px-3 text-[13px] font-semibold text-ink-2">
              音量
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={pref.volume}
                onChange={(e) => setPref({ ...pref, volume: Number(e.target.value) })}
                className="w-24 accent-[var(--color-pine)]"
                aria-label="播报音量"
                data-testid="announcer-volume"
              />
              <span className="num w-9 text-right">{pref.volume}</span>
            </label>
            <Button
              size="lg"
              variant={muted ? 'primary' : 'secondary'}
              icon={muted ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
              onClick={toggleMute}
              aria-pressed={muted}
              data-testid="announcer-mute"
            >
              {muted ? '取消静音' : '静音'}
            </Button>
            <Button
              size="lg"
              variant="secondary"
              icon={<RotateCcw className="size-4" />}
              disabled={!last || muted}
              onClick={() => last && speak(spokenText(last.text), pref.volume / 100)}
              data-testid="announcer-replay"
            >
              重播上一条
            </Button>
            <Button size="lg" variant="ghost" icon={<Play className="size-4" />} disabled={muted} onClick={() => speak('排位播报试音', pref.volume / 100)} data-testid="announcer-test">
              试音
            </Button>
            <Button size="lg" variant="ghost" loading={busy} onClick={() => void send('release')} data-testid="announcer-release">
              不由本机播报
            </Button>
          </>
        ) : (
          <Button
            size="lg"
            variant="primary"
            icon={<Megaphone className="size-4" />}
            loading={busy}
            disabled={!speech.supported}
            onClick={() => void send('claim')}
            data-testid={claim ? 'announcer-takeover' : 'announcer-claim'}
          >
            {claim ? '由本机接管播报' : '由本机播报'}
          </Button>
        )}
      </div>
    </Card>
  );
}
