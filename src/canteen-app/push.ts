// 饭点提醒（docs/CANTEEN.md 第 19 节，K23、K24）：这台手机能不能收提醒、打开 / 关掉、每次打开柚子饭堂时核对一遍订阅，
// 桌面图标的小红点（收到提醒时 sw.js 点上，打开柚子饭堂时这里清掉）。
//   · iPhone：iOS 16.4 起、添加到主屏幕以后从桌面上的柚子打开才能收（Safari 里直接开的不行）；
//   · 安卓：Chrome、Edge 靠谷歌的推送服务，手机上没有谷歌服务的（多数国产手机）收不到；
//   · http（店里局域网）打开的、微信里打开的都收不到。

import type { PushInfo } from '@shared/canteen-reminders';
import { call } from './lib';
import { inWeChat, isIos, isStandalone } from './install';

export type PushSupport = 'ok' | 'insecure' | 'ios-browser' | 'wechat' | 'unsupported';

/** 这台手机、这样打开的柚子饭堂能不能收提醒 */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (inWeChat()) return 'wechat';
  if (!window.isSecureContext) return 'insecure';
  const has = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !isStandalone()) return 'ios-browser';
  return has ? 'ok' : 'unsupported';
}

export const platformOf = (): 'ios' | 'android' | 'other' => (isIos() ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'other');

/** 打开提醒没成的原因 */
export class PushError extends Error {
  constructor(readonly reason: 'denied' | 'dismissed' | 'service' | 'unsupported') {
    super(reason);
  }
}

const fromB64u = (text: string) => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const toB64u = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** 离线外壳（sw.js）：正式构建开机时已经注册；没注册的（开发时）这里注册 */
async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

/** 这台手机现在的订阅（没有、收不了返回 null） */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** 这台手机开着提醒吗（允许了通知、订阅着） */
export async function pushEnabledHere(): Promise<boolean> {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return false;
  return (await currentSubscription().catch(() => null)) !== null;
}

/** 订阅的钥匙与门店系统现在的不一样（门店系统换过钥匙）：退掉重新订阅 */
async function subscribeWith(reg: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  let sub = await reg.pushManager.getSubscription();
  const key = sub?.options?.applicationServerKey;
  if (sub && (!key || toB64u(key) !== publicKey)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(publicKey) });
}

const save = (sub: PushSubscription, platform = true) => call<PushInfo>('PUT', '/api/canteen/push/subscription', { ...sub.toJSON(), ...(platform ? { platform: platformOf() } : {}) });

/** 打开提醒：要在点按钮的那一下里调用（iPhone 只认点出来的权限请求）→ 允许通知 → 订阅 → 交给门店系统 */
export async function enablePush(publicKey: string): Promise<PushInfo> {
  if (pushSupport() !== 'ok') throw new PushError('unsupported');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new PushError(permission === 'denied' ? 'denied' : 'dismissed');
  let sub: PushSubscription;
  try {
    sub = await subscribeWith(await registration(), publicKey);
  } catch {
    // 安卓手机没有谷歌服务时，Chrome 订阅会失败（连不上推送服务）
    throw new PushError('service');
  }
  return save(sub);
}

/** 关掉这台手机的提醒（或退出登录）：告诉门店系统，再退掉浏览器的订阅（门店系统没联系上也照样退掉） */
export async function disablePush(reason: 'off' | 'logout'): Promise<PushInfo | null> {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return null;
  const info = await call<PushInfo>('POST', '/api/canteen/push/off', { endpoint: sub.endpoint, reason }).catch(() => null);
  await sub.unsubscribe().catch(() => undefined);
  return info;
}

/** 每次打开柚子饭堂：这台手机开着提醒的，交给门店系统核对一遍（换人登录、门店系统换过钥匙都跟上）。不弹任何东西 */
export async function syncPush(): Promise<void> {
  if (!(await pushEnabledHere())) return;
  const info = await call<PushInfo>('GET', '/api/canteen/push');
  const sub = await subscribeWith(await registration(), info.publicKey);
  await save(sub);
}

/** 清掉桌面图标上的小红点（打开柚子饭堂、回到前台时） */
export function clearBadge() {
  try {
    const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
    void nav.clearAppBadge?.().catch(() => undefined);
  } catch {
    /* 不支持的浏览器 */
  }
}
