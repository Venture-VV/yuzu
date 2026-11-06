// 添加到桌面：安卓浏览器给了「安装」机会就直接装；iPhone 教用 Safari 的分享按钮；微信里提示换浏览器打开。

import { useEffect, useState } from 'react';
import { Button } from './ui';

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: InstallEvent | null = null;
const subs = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    subs.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    subs.forEach((fn) => fn());
  });
}

export const inWeChat = () => /MicroMessenger/i.test(navigator.userAgent);
export const isIos = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function useInstallPrompt() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subs.add(fn);
    return () => void subs.delete(fn);
  }, []);
  return deferred
    ? async () => {
        await deferred?.prompt();
        deferred = null;
        force((n) => n + 1);
      }
    : null;
}

export function InstallGuide() {
  const install = useInstallPrompt();
  if (isStandalone()) return <p className="pb-6 text-[15px] font-bold text-leaf-deep">已经在桌面上啦 ✓ 以后点桌面上的柚子就能打开。</p>;
  if (inWeChat()) return <WeChatTip />;
  return (
    <div className="space-y-4 pb-6 text-[15px] text-ink-2">
      {install && (
        <Button big className="w-full" onClick={() => void install()}>
          📲 一键添加到桌面
        </Button>
      )}
      {isIos() ? (
        <ol className="list-decimal space-y-2 pl-5">
          <li>用 <b className="text-ink">Safari</b> 打开柚子饭堂（别的浏览器不行）</li>
          <li>
            点底部中间的 <b className="text-ink">分享按钮</b>（方框加向上的箭头）
          </li>
          <li>
            往下滑，点 <b className="text-ink">「添加到主屏幕」</b>，再点右上角「添加」
          </li>
        </ol>
      ) : (
        !install && (
          <ol className="list-decimal space-y-2 pl-5">
            <li>点浏览器右上角的 <b className="text-ink">⋮ 菜单</b></li>
            <li>
              选 <b className="text-ink">「安装应用」</b> 或 <b className="text-ink">「添加到主屏幕」</b>
            </li>
          </ol>
        )
      )}
      <p className="rounded-2xl bg-yuzu-soft px-4 py-3 text-[14px]">添加以后，桌面上会多一颗小柚子 🍊 开饭时点它就能亮码，没网也行。</p>
    </div>
  );
}

export function WeChatTip() {
  return (
    <div className="rounded-2xl bg-peach-soft px-4 py-3 text-[14px] font-bold text-[#a8382c]">
      你在微信里打开的：点右上角 <span className="font-black">···</span> 选「在浏览器打开」，才能添加到桌面、用相机扫码。
    </div>
  );
}
