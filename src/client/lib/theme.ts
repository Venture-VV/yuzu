// 深浅两套主题（8.1.15，《浴族系统需求汇总》系统整体；docs/DESIGN.md「深浅两套主题」）。
// 选的是哪一套记在这台设备的浏览器里（不同的终端各选各的：前台的电脑多半用浅色，灯光暗的区域的平板可以用深色），默认浅色。
// 样式只换变量：<html data-theme="dark"> 时 styles.css 里那一段生效。对客的页面与要出纸的页面一律浅色。
import { useEffect, useSyncExternalStore } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
type Theme = 'light' | 'dark';

export const THEME_LABELS: Record<ThemeChoice, string> = { light: '浅色', dark: '深色', system: '跟随系统' };

const KEY = 'yuzu.theme';
const listeners = new Set<() => void>();

/** 这台设备选的是哪一套；没选过、读不到都是浅色 */
function readChoice(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    // 存不了（无痕窗口、被禁用）：这一次照样换，刷新后回到浅色
  }
  memory = choice;
  for (const fn of listeners) fn();
}

// 存不了的时候至少这一次页面里记得住
let memory: ThemeChoice | null = null;
const currentChoice = (): ThemeChoice => memory ?? readChoice();

const systemDark = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;

/** 选的这一套落到实际用哪一套 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

/** 一律浅色的页面：对客的（平板电子菜单、导览大屏、扫码打开的页面）、要出纸的（打印）、工作台（画布要和对客看到的一样）、登录页 */
const LIGHT_ONLY = ['/login', '/print', '/emenu', '/guide', '/studio', '/studio-preview', '/r', '/s'];

export function themeLocked(pathname: string): boolean {
  return LIGHT_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  media?.addEventListener('change', fn);
  // 另一个标签页里换了，这边跟着换
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      memory = null;
      fn();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    media?.removeEventListener('change', fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** 现在选的是哪一套（给切换的按钮用） */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, currentChoice, () => 'light');
}

/** 把主题落到 <html> 上：整个应用挂一次（App.tsx），跟着地址与选择变 */
export function useApplyTheme(pathname: string): void {
  const choice = useThemeChoice();
  const prefersDark = useSyncExternalStore(subscribe, systemDark, () => false);
  const theme: Theme = themeLocked(pathname) ? 'light' : resolveTheme(choice, prefersDark);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}
