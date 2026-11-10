// 饭卡码：在手机上离线生成，每 30 秒换一个（外圈倒计时）；亮码时让屏幕常亮。没网也能用；
// 店里局域网用 http 打开也能亮（签名不靠 WebCrypto，K18；只是 http 下浏览器不给「屏幕常亮」）。

import { useEffect, useState } from 'react';
import { CANTEEN_ROLE_LABELS, CODE_STEP_SECONDS, type CanteenMe } from '@shared/canteen';
import { Mascot } from '../Mascot';
import { QrCode } from '../QrCode';
import { makeCode } from '../lib';
import { Pill } from '../ui';

type WakeLock = { release(): Promise<void> };

/** 亮码时屏幕不灭（支持的浏览器才有：安卓 Chrome、iPhone Safari 16.4 起） */
function useWakeLock() {
  useEffect(() => {
    let lock: WakeLock | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLock> } };
    const take = () => {
      if (document.visibilityState === 'visible') nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      document.removeEventListener('visibilitychange', take);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}

export function CodePage({ me, offsetMs, online }: { me: CanteenMe; offsetMs: number; online: boolean }) {
  const [code, setCode] = useState<{ text: string; step: number } | null>(null);
  const [left, setLeft] = useState(CODE_STEP_SECONDS);
  const [error, setError] = useState('');
  useWakeLock();

  useEffect(() => {
    let alive = true;
    let current = -1;
    const tick = async () => {
      const now = Date.now() + offsetMs;
      const step = Math.floor(now / (CODE_STEP_SECONDS * 1000));
      setLeft(CODE_STEP_SECONDS - (now / 1000 - step * CODE_STEP_SECONDS));
      if (step !== current) {
        current = step;
        try {
          const next = await makeCode(me.codeKey, me.employee.id, now);
          if (alive) setCode(next);
        } catch {
          if (alive) setError('生成饭卡码出错了：请退出重新登录一次');
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 250);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [me.codeKey, me.employee.id, offsetMs]);

  return (
    <div className="flex flex-col items-center pt-2 text-center">
      <div className="sketch flex items-center gap-3 self-stretch rounded-[var(--radius-card)] bg-card p-3 shadow-[var(--shadow-sticker)]">
        <span className="flex size-14 items-center justify-center rounded-full bg-wood-6 text-[32px]">{me.employee.avatar}</span>
        <div className="min-w-0 flex-1 text-left">
          <p className="truncate text-[20px] font-black">{me.employee.name}</p>
          <p className="num truncate text-[14px] font-semibold text-ink-2">
            工号 {me.employee.empNo}
            {me.employee.department && ` · ${me.employee.department}`}
          </p>
        </div>
        {me.employee.role !== 'staff' && <Pill tone="leaf">{CANTEEN_ROLE_LABELS[me.employee.role]}</Pill>}
      </div>

      {error ? (
        <div className="mt-10 flex flex-col items-center">
          <Mascot mood="oops" className="size-28" />
          <p className="mt-3 max-w-[300px] text-[15px] font-bold text-berry">{error}</p>
        </div>
      ) : (
        <>
          {/* 外框就是倒计时：这个码还能用几秒（30 秒一换），黄色一圈慢慢变短；不压在二维码上，扫码不受影响 */}
          <div
            className="mt-6 w-[min(84vw,330px)] rounded-[34px] p-[7px] shadow-[var(--shadow-pop)]"
            style={{ background: `conic-gradient(var(--color-yuzu) ${(left / CODE_STEP_SECONDS) * 360}deg, var(--color-yuzu-soft) 0deg)` }}
            data-testid="meal-code"
            data-tour="meal-code"
          >
            <div className="rounded-[27px] bg-white p-4">
              {code ? <QrCode text={code.text} className="block aspect-square w-full" label="饭卡码" /> : <div className="aspect-square w-full animate-pulse rounded-2xl bg-cream" />}
            </div>
          </div>
          <p className="mt-6 text-[18px] font-black">
            <span className="marker">给食堂负责人扫一扫</span>
          </p>
          <p className="num mt-1 text-[14px] text-ink-2">{Math.ceil(left)} 秒后自动换码 · 截图没用哦</p>
          <div className="mt-3">{online ? <Pill tone="leaf">✓ 已连上门店</Pill> : <Pill tone="sky">没网也能用</Pill>}</div>
          <div className="mt-6 flex items-center gap-2 text-[13px] text-ink-3">
            <Mascot mood="yum" pose="bowl" className="h-16 w-auto" />
            <span>吃饱饱，下午才有力气呀</span>
          </div>
        </>
      )}
    </div>
  );
}
