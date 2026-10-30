import { clsx, type ClassValue } from 'clsx';

export const cn = (...inputs: ClassValue[]) => clsx(inputs);

/**
 * 生成 UUID v4 作为操作编号。
 * 注意：门店局域网用 http 访问时 crypto.randomUUID 不可用（仅限安全上下文），这里改用 getRandomValues。
 */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// 时间按门店时区显示（登录后由会话信息设置）
let timeFmt: Intl.DateTimeFormat;
let dateTimeFmt: Intl.DateTimeFormat;
let shortDateFmt: Intl.DateTimeFormat;
let dateFmt: Intl.DateTimeFormat;
export function setDisplayTimeZone(timeZone: string) {
  dateFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone });
  timeFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
  dateTimeFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
  shortDateFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone });
}
setDisplayTimeZone('Asia/Shanghai');

export const formatTime = (iso: string) => timeFmt.format(new Date(iso));
export const formatDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));
/** 带年份的日期，例如 2026/10/30（门店时区） */
export const formatDate = (iso: string) => dateFmt.format(new Date(iso));

/** "刚刚" / "12 分钟前" / "3 小时前" / "10月21日" */
export function relativeTime(iso: string | null): string {
  if (!iso) return '暂无记录';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return shortDateFmt.format(new Date(iso));
}

/** 正在输入框里打字时不响应单键快捷键 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

const AVATAR_TONES = [
  'bg-pine-soft text-pine',
  'bg-moss-soft text-moss',
  'bg-yuzu-soft text-yuzu-deep',
  'bg-ember-soft text-ember',
  'bg-lake-soft text-lake',
];
export const avatarTone = (seed: number) => AVATAR_TONES[seed % AVATAR_TONES.length]!;

export function downloadUrl(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
