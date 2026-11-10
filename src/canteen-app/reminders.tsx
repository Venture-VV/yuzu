// 饭点提醒（店主 2026-11-10，docs/CANTEEN.md 第 19 节，K23、K24）：「我的 → 饭点提醒」的面板，首页的「要不要柚子到点喊你吃饭」。
// 这台手机打开提醒（允许通知、订阅、交给门店系统）、选哪几顿、发一条试试、关掉；收不到的手机说清楚为什么、怎么办。

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { MEAL_EMOJI, MEAL_LABELS, type Meal } from '@shared/canteen';
import type { PushInfo, PushTestResult } from '@shared/canteen-reminders';
import { IconBell } from './doodles';
import { InstallGuide, isIos, WeChatTip } from './install';
import { call, messageOf, readJson, writeJson } from './lib';
import { Mascot } from './Mascot';
import { disablePush, enablePush, PushError, pushEnabledHere, pushSupport } from './push';
import { Button, cn, toast } from './ui';

const permissionNow = (): NotificationPermission => ('Notification' in window ? Notification.permission : 'default');

function Note({ tone = 'info', children, testId }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode; testId?: string }) {
  const t = { info: 'bg-relax-soft text-relax', warn: 'bg-peach-soft text-danger', ok: 'bg-organic-soft text-leaf-deep' }[tone];
  return (
    <div className={cn('rounded-2xl px-4 py-3 text-[14px] leading-relaxed font-bold', t)} data-testid={testId}>
      {children}
    </div>
  );
}

/** 开关（一顿一个） */
function Toggle({ label, hint, checked, disabled, onChange, testId }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; testId: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-cream disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-bold">{label}</span>
        <span className="num block text-[12.5px] text-ink-3">{hint}</span>
      </span>
      <span className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors', checked ? 'bg-organic' : 'bg-line-strong')}>
        <span className={cn('absolute top-0.5 size-6 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

export function ReminderPanel({ online }: { online: boolean }) {
  const support = pushSupport();
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [here, setHere] = useState<boolean | null>(null);
  const [permission, setPermission] = useState(permissionNow);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<'service' | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  const load = useCallback(async () => {
    setPermission(permissionNow());
    setHere(await pushEnabledHere());
    if (online) setInfo(await call<PushInfo>('GET', '/api/canteen/push').catch(() => null));
  }, [online]);
  useEffect(() => {
    void load();
  }, [load]);

  /** 打开：点按钮的这一下里直接要通知权限（iPhone 只认点出来的请求），中间不等别的 */
  const turnOn = async () => {
    if (!info) {
      toast(online ? '正在问门店系统，等一下再点' : '要联网才能打开提醒', 'error');
      return;
    }
    setBusy('on');
    setProblem(null);
    try {
      setInfo(await enablePush(info.publicKey));
      setHere(true);
      toast('饭点提醒打开啦 🔔 到点柚子就喊你', 'ok');
    } catch (e) {
      if (e instanceof PushError) {
        if (e.reason === 'service') setProblem('service');
        else if (e.reason === 'unsupported') toast('这个浏览器收不到提醒', 'error');
      } else toast(messageOf(e), 'error');
    } finally {
      setPermission(permissionNow());
      setBusy(null);
    }
  };

  const turnOff = async () => {
    setBusy('off');
    try {
      const next = await disablePush('off');
      if (next) setInfo(next);
      setHere(false);
      toast('这台手机不再提醒了');
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      const r = await call<PushTestResult>('POST', '/api/canteen/push/test', {});
      if (r.sent > 0) toast('发出去啦，看看手机上有没有柚子的消息～', 'ok');
      else toast(`没送到：${r.errors[0] ?? '推送服务没收下'}`, 'error');
    } catch (e) {
      toast(messageOf(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const mute = async (meal: Meal, off: boolean) => {
    if (!info) return;
    setBusy(meal);
    try {
      const muted = off ? [...info.muted, meal] : info.muted.filter((m) => m !== meal);
      setInfo(await call<PushInfo>('PUT', '/api/canteen/push/muted', { muted }));
    } catch (e) {
      toast(messageOf(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 pb-6" data-testid="reminder-panel">
      <div className="flex items-center gap-3 rounded-2xl bg-yuzu-soft px-4 py-3">
        <Mascot mood="wink" className="size-14 shrink-0" still />
        <p className="text-[14px] leading-relaxed font-bold text-ink-2">到了开饭时间，柚子在手机上喊你吃饭，桌面上的柚子图标还会冒出小红点～</p>
      </div>

      {support === 'insecure' && (
        <Note tone="warn" testId="reminder-insecure">
          现在是用 http（店里局域网）打开的，收不到提醒。请用管理员给的 https 网址打开柚子饭堂、添加到桌面，再回来打开提醒。
        </Note>
      )}
      {support === 'wechat' && <WeChatTip />}
      {support === 'ios-browser' && (
        <>
          <Note tone="warn" testId="reminder-ios-browser">
            iPhone 要先把柚子饭堂添加到主屏幕，再点桌面上的柚子打开，才能打开提醒（iOS 16.4 及以上）。在 Safari 里直接打开的收不到。
          </Note>
          {showGuide ? (
            <InstallGuide />
          ) : (
            <Button tone="leaf" className="w-full" onClick={() => setShowGuide(true)}>
              怎么添加到桌面
            </Button>
          )}
        </>
      )}
      {support === 'unsupported' && (
        <Note tone="warn" testId="reminder-unsupported">
          这个浏览器收不到提醒。安卓手机请用 Chrome 或 Edge 打开柚子饭堂再试；手机上没有谷歌服务的（大多数国产安卓手机），Chrome 也收不到——到了饭点打开柚子饭堂，首页照样写着「开饭中」。
        </Note>
      )}

      {support === 'ok' && permission === 'denied' && (
        <>
          <Note tone="warn" testId="reminder-denied">
            {isIos()
              ? '之前点了「不允许」通知：打开手机的「设置 → 通知 → 柚子饭堂」，打开「允许通知」，再回来点下面的按钮。'
              : '之前点了「不允许」通知：长按桌面上的柚子 → 应用信息 → 通知，打开以后再回来点下面的按钮（没装到桌面的，在浏览器的网站设置里允许通知）。'}
          </Note>
          <Button tone="ghost" className="w-full" onClick={() => void load()}>
            我改好了，再看一下
          </Button>
        </>
      )}

      {support === 'ok' && permission !== 'denied' && here === false && (
        <>
          <Button big tone="yuzu" className="w-full" onClick={() => void turnOn()} disabled={busy !== null} data-testid="reminder-enable">
            <IconBell size={26} /> {busy === 'on' ? '正在打开…' : '打开饭点提醒'}
          </Button>
          <p className="px-1 text-[13px] text-ink-3">手机会问要不要允许「柚子饭堂」发通知，点「允许」就好。</p>
          {problem === 'service' && (
            <Note tone="warn" testId="reminder-service">
              这台手机连不上推送服务（多半是手机上没有谷歌服务），收不到提醒。到了饭点打开柚子饭堂，首页照样写着「开饭中」。
            </Note>
          )}
        </>
      )}

      {support === 'ok' && here === true && (
        <>
          <Note tone="ok" testId="reminder-on">
            ✓ 这台手机打开了饭点提醒
          </Note>
          <section>
            <h3 className="mb-2 px-1 text-[14px] font-extrabold text-ink-2">提醒哪几顿</h3>
            <div className="divide-y divide-line/70 overflow-hidden rounded-[var(--radius-card)] bg-card ring-1 ring-line/80">
              {!info && <p className="px-4 py-3 text-[14px] text-ink-3">{online ? '正在取…' : '联网后才看得到'}</p>}
              {info?.meals.length === 0 && <p className="px-4 py-3 text-[14px] text-ink-3">管理员还没打开饭点提醒，打开以后到点就会提醒你。</p>}
              {info?.meals.map((m) => (
                <Toggle
                  key={m.meal}
                  label={`${MEAL_EMOJI[m.meal]} ${MEAL_LABELS[m.meal]}`}
                  hint={`${m.time} 提醒`}
                  checked={!info.muted.includes(m.meal)}
                  disabled={busy !== null || !online}
                  onChange={(on) => void mute(m.meal, !on)}
                  testId={`reminder-meal-${m.meal}`}
                />
              ))}
            </div>
            <p className="mt-2 px-1 text-[12.5px] text-ink-3">已经打过卡的那一顿不再提醒。柚子说的话管理员可以在后台改。</p>
          </section>
          <div className="grid grid-cols-2 gap-2">
            <Button tone="ghost" onClick={() => void test()} disabled={busy !== null || !online} data-testid="reminder-test">
              {busy === 'test' ? '正在发…' : '发一条试试'}
            </Button>
            <Button tone="ghost" className="text-berry" onClick={() => void turnOff()} disabled={busy !== null} data-testid="reminder-off">
              关掉提醒
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

const PROMPT_KEY = 'yuzu.canteen.reminderPrompt.v1';

/**
 * 首页：能收提醒、还没决定过（没点过允许或不允许）、没点过「不用了」的手机，问一句要不要柚子到点喊你吃饭。
 * 点「好呀」就在这一下里打开提醒。
 */
export function ReminderPrompt({ online }: { online: boolean }) {
  const [show, setShow] = useState(false);
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!online || pushSupport() !== 'ok' || permissionNow() !== 'default' || readJson<boolean>(PROMPT_KEY)) return;
    let alive = true;
    void (async () => {
      if (await pushEnabledHere()) return;
      const i = await call<PushInfo>('GET', '/api/canteen/push').catch(() => null);
      // 管理员一顿都没打开提醒时先不问
      if (alive && i && i.meals.length > 0) {
        setInfo(i);
        setShow(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [online]);
  if (!show || !info) return null;
  const dismiss = () => {
    writeJson(PROMPT_KEY, true);
    setShow(false);
  };
  const yes = async () => {
    setBusy(true);
    try {
      await enablePush(info.publicKey);
      toast('饭点提醒打开啦 🔔 到点柚子就喊你', 'ok');
      dismiss();
    } catch (e) {
      if (e instanceof PushError && e.reason === 'service') toast('这台手机连不上推送服务，收不到提醒', 'error');
      else if (!(e instanceof PushError)) toast(messageOf(e), 'error');
      if (permissionNow() !== 'default' || (e instanceof PushError && e.reason === 'service')) dismiss();
    } finally {
      setBusy(false);
    }
  };
  const times = info.meals.map((m) => `${MEAL_LABELS[m.meal]} ${m.time}`).join('、');
  return (
    <div className="flex animate-rise items-center gap-3 rounded-[var(--radius-card)] bg-card px-4 py-3 shadow-[var(--shadow-soft)] ring-1 ring-yuzu/50" data-testid="reminder-prompt">
      <span className="text-wood">
        <IconBell size={30} fill="var(--color-yuzu)" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-black">要柚子到点喊你吃饭吗？</p>
        <p className="num text-[12.5px] text-ink-2">{times}</p>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        <Button tone="yuzu" className="h-9 px-3 text-[13px]" onClick={() => void yes()} disabled={busy}>
          好呀
        </Button>
        <button type="button" className="text-[12.5px] font-bold text-ink-3" onClick={dismiss}>
          不用了
        </button>
      </div>
    </div>
  );
}
