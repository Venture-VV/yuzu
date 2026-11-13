// 动效套件（8.0.16，docs/UI_V8016.md）：全站公共部件共用的几样——退场的影子、依次出现、跟着当前项滑动的一块、
// 折叠 / 展开、换页面时内容淡入、提示条停留多久。时间与曲线在 styles.css 开头的变量里。
//
// 规矩（设计文档第 2 节）：只动透明度、位移、缩放、颜色；进出成对；不用匀速；只在出现时播一次；
// 系统开了「减少动态效果」时这里什么都不做（styles.css 末尾另有一条规则把所有动画、过渡的时间压到接近 0）。
//
// 退场为什么用「影子」：弹窗、抽屉、菜单、提示条关掉时，React 那边照旧马上卸掉——页面上「它还在不在」的判断、
// 焦点的归还、Esc 关哪一层、浏览器用例都与原来一样，不会有两份能点的弹窗。卸掉之前把它的 DOM 复制一份，播完退场动画自己删掉。
// 平板点餐页 8.0.13 用的是同一个办法（emenu/motion.tsx）。
//
// 影子放在哪：页面最后面一个「关着的」影子容器（closed shadow root）里。关着的容器从外面查不到里面的东西——
// 按文字、按占位字、按标签找输入框、读屏、浏览器用例都认不到影子（刚关掉的弹窗里有一个「保存」，页面上也有一个「保存」，
// 不会变成两个）。容器里看不到页面的样式表，所以把页面现在的样式表照抄一份给它用（抄一次记住，样式表没变就不再抄）。

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { cn } from './utils';

/** 系统现在要不要「减少动态效果」 */
export const prefersReducedMotion = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ───────────────────────── 退场的影子 ─────────────────────────

/** 影子身上要去掉的属性：不让读屏、测试、表单、标签关联认到它 */
const STRIP = ['id', 'role', 'name', 'for', 'tabindex', 'data-testid', 'data-autofocus', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-modal', 'aria-pressed', 'aria-checked', 'aria-current', 'aria-expanded', 'aria-haspopup', 'aria-live'];

/** 影子最多留多久（毫秒）：比最慢的退场（抽屉 220）长一点，到时间一定删掉 */
export const GHOST_MS = 320;

/**
 * 把一个节点复制成影子（纯的那部分，单独导出给用例用）：去掉会被认到的属性，输入框带上现在的值并停用。
 */
export function makeGhost(node: HTMLElement): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;
  clone.classList.add('mo-ghost');
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const attr of STRIP) el.removeAttribute(attr);
  }
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  // 复制出来的输入框只带着最初的值：照现在的补上
  const from = node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
  clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select').forEach((el, i) => {
    const src = from[i];
    if (!src) return;
    if (el instanceof HTMLInputElement && src instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) el.checked = src.checked;
    else el.value = src.value;
    el.disabled = true;
  });
  return clone;
}

// 影子容器：整页只有一个，用到时才建
let ghostRoot: ShadowRoot | null = null;
/** 抄好的样式表：按页面的样式表记，规则条数没变就不再抄 */
const sheetCopies = new WeakMap<CSSStyleSheet, { rules: number; copy: CSSStyleSheet }>();

/** 这个浏览器能不能建影子容器并给它样式表（很老的平板不能：那就不播退场，别的照常） */
const ghostsSupported = (): boolean =>
  typeof document !== 'undefined' && typeof document.body?.attachShadow === 'function' && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in Document.prototype;

/** 把页面现在的样式表照抄给影子容器（读不到规则的外站样式表跳过） */
function syncGhostStyles(root: ShadowRoot) {
  const sheets: CSSStyleSheet[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    let cached = sheetCopies.get(sheet);
    if (!cached || cached.rules !== rules.length) {
      const copy = new CSSStyleSheet();
      copy.replaceSync(Array.from(rules, (r) => r.cssText).join('\n'));
      cached = { rules: rules.length, copy };
      sheetCopies.set(sheet, cached);
    }
    sheets.push(cached.copy);
  }
  root.adoptedStyleSheets = sheets;
}

function ensureGhostRoot(): ShadowRoot | null {
  if (!ghostsSupported()) return null;
  if (!ghostRoot || !ghostRoot.host.isConnected) {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('data-mo-ghosts', '');
    // 自己不占位置、不成一层：里面的影子照各自的层级画在页面上
    host.style.display = 'contents';
    document.body.appendChild(host);
    ghostRoot = host.attachShadow({ mode: 'closed' });
  }
  return ghostRoot;
}

/** 空闲时先把样式表抄好：第一次关弹窗时不用现抄（抄一份几十毫秒） */
let warmed = false;
function warmGhostStyles() {
  if (warmed || typeof window === 'undefined') return;
  warmed = true;
  const run = () => {
    const root = ensureGhostRoot();
    if (root) syncGhostStyles(root);
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 3000 });
  else window.setTimeout(run, 1200);
}

/**
 * 这一层卸掉时留一个影子播退场动画。返回的 ref 挂在这一层最外面的元素上。
 * 怎么退由 CSS 定：这一层里带 data-mo-out（fade / dialog / sheet / toast / menu）的元素各播各的退场（styles.css）。
 * 最外面的元素自己是固定定位（弹窗、抽屉的整层）时原样复制；不是的（菜单、提示条）按它此刻在屏幕上的位置钉住。
 * 只能用在「关掉就整个卸掉」的组件里（卸掉时才留影子）。
 */
export function useExitGhost<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(warmGhostStyles, []);
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (!node || !node.isConnected || prefersReducedMotion()) return;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const scrolls = [...node.querySelectorAll<HTMLElement>('.scroll-thin, [data-mo-scroll]')].map((el) => el.scrollTop);
      const clone = makeGhost(node);
      if (style.position !== 'fixed') {
        // 不是固定定位的（菜单、提示条）：钉在它此刻的位置上
        Object.assign(clone.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, right: 'auto', bottom: 'auto', width: `${rect.width}px`, height: `${rect.height}px`, margin: '0' });
      }
      // 影子比原来低一层：紧接着打开的下一个弹窗画在它上面
      const z = Number.parseInt(style.zIndex, 10);
      clone.style.zIndex = String(Number.isFinite(z) ? z - 1 : 39);
      // 开发模式下 React 会把副作用先卸一次再装回来（StrictMode）：那一次这一层还在页面上，不留影子
      queueMicrotask(() => {
        if (node.isConnected) return;
        const root = ensureGhostRoot();
        if (!root) return;
        syncGhostStyles(root);
        root.appendChild(clone);
        clone.querySelectorAll<HTMLElement>('.scroll-thin, [data-mo-scroll]').forEach((el, i) => {
          el.scrollTop = scrolls[i] ?? 0;
        });
        // 容器是关着的，从外面数不到里面有几个影子：把个数、一共留过几个写在容器上（排查与浏览器用例用）
        const host = root.host as HTMLElement;
        const count = () => {
          host.dataset.count = String(root.childElementCount);
        };
        host.dataset.total = String(Number(host.dataset.total ?? 0) + 1);
        count();
        window.setTimeout(() => {
          clone.remove();
          count();
        }, GHOST_MS);
      });
    };
  }, []);
  return ref;
}

// ───────────────────────── 依次出现 ─────────────────────────

/** 「依次出现」的类只挂这么久（毫秒）：12 个 × 28 的间隔 + 进场的时间，之后进来的（筛选、刷新）不再播 */
const STAGGER_MS = 700;

/**
 * 一组卡片、一列行第一次出现时依次升起（最多前 12 个，后面的直接显示）。只在这一组刚挂上来时播一次。
 * 直接的子元素就是要依次出现的那些：这一层照 className 排版（grid、flex……），不另套一层。
 */
export function Stagger({ children, className, as: Tag = 'div', ...rest }: { children: ReactNode; className?: string; as?: 'div' | 'ul' | 'ol' | 'section' } & Record<`data-${string}`, string | undefined>) {
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setFresh(false), STAGGER_MS);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <Tag className={cn(fresh && 'mo-stagger', className)} {...rest}>
      {children}
    </Tag>
  );
}

// ───────────────────────── 跟着当前项滑动的一块 ─────────────────────────

export interface IndicatorBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 当前项在容器里的位置（算上容器自己滚动了多少）；量不到（没有当前项、容器没显示）返回 null */
export function measureIndicator(container: HTMLElement, selector: string): IndicatorBox | null {
  const active = container.querySelector<HTMLElement>(selector);
  if (!active) return null;
  const c = container.getBoundingClientRect();
  const a = active.getBoundingClientRect();
  if (a.width === 0 || a.height === 0) return null;
  return { x: a.left - c.left + container.scrollLeft - container.clientLeft, y: a.top - c.top + container.scrollTop - container.clientTop, w: a.width, h: a.height };
}

const sameBox = (a: IndicatorBox | null, b: IndicatorBox | null) => a === b || (!!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5);

/**
 * 量出容器里当前项（selector 找到的第一个）的位置，给「跟着当前项滑动的那一块」用。
 * 容器要是定位元素（relative），滑块放在容器里、用返回的 style。dep 变了（选中的换了、项目多了少了）或容器大小变了重新量。
 * 量不到时返回 null：调用的地方退回到「当前项自己带底色」的老样子。
 * maxSlide：一次最多滑多远（像素）。更远的不滑过去（长长的导航里从头滑到尾会扫过中间每一项，反而乱），
 * 直接出现在新的位置并淡入——这时 jump 加一，调用的地方拿它当滑块的 key。
 */
export function useSlidingIndicator<T extends HTMLElement>(
  selector: string,
  dep: unknown,
  maxSlide = Number.POSITIVE_INFINITY,
): { ref: RefObject<T | null>; box: IndicatorBox | null; style: CSSProperties | null; settled: boolean; jump: number } {
  const ref = useRef<T>(null);
  const [state, setState] = useState<{ box: IndicatorBox | null; jump: number }>({ box: null, jump: 0 });
  // 第一次量到位置的那一帧不带过渡（不从左上角滑过来）
  const [settled, setSettled] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setState((cur) => {
        const next = measureIndicator(el, selector);
        if (sameBox(cur.box, next)) return cur;
        const far = !!cur.box && !!next && Math.hypot(next.x - cur.box.x, next.y - cur.box.y) > maxSlide;
        return { box: next, jump: far ? cur.jump + 1 : cur.jump };
      });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, [selector, dep, maxSlide]);
  const { box, jump } = state;
  useEffect(() => {
    if (!box || settled) return;
    const frame = window.requestAnimationFrame(() => setSettled(true));
    return () => window.cancelAnimationFrame(frame);
  }, [box, settled]);
  const style: CSSProperties | null = box ? { transform: `translate3d(${box.x}px, ${box.y}px, 0)`, width: box.w, height: box.h } : null;
  return { ref, box, style, settled, jump };
}

// ───────────────────────── 折叠 / 展开 ─────────────────────────

/** 折叠 / 展开：高度平滑变化。收起时里面的内容不能点、键盘到不了、读屏不念 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn('mo-collapse', className)} data-open={open}>
      <div inert={!open} aria-hidden={!open || undefined}>
        {children}
      </div>
    </div>
  );
}

// ───────────────────────── 换页面时内容淡入 ─────────────────────────

/**
 * 换页面（key 变了）时内容区淡入。不重新挂载页面（页面上填到一半的东西不丢），只在这一层上播一次淡入；
 * 第一次挂上来不播（整页刚打开时不闪）。
 */
export function usePageEnter<T extends HTMLElement>(key: string): RefObject<T | null> {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    return () => fade.cancel();
  }, [key]);
  return ref;
}

// ───────────────────────── 提示条停留多久 ─────────────────────────

/**
 * 提示条停留多久（毫秒）：字要看得完。至少 3.6 秒，10 个字以上每多 10 个字加 0.6 秒；出错的至少 6 秒；最长 10 秒。
 */
export function dwellMs(text: string, tone: 'success' | 'error' | 'info' = 'info'): number {
  const length = [...text].length;
  const base = 3600 + Math.max(0, Math.ceil((length - 10) / 10)) * 600;
  return Math.min(10_000, Math.max(tone === 'error' ? 6000 : 3600, base));
}
