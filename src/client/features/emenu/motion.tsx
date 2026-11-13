// 平板点餐页的动效部件（8.0.13，docs/EMENU.md 第 11.3 节）：退场的影子、飞向订单的小圆点、带回弹的上下滑、淡入的图片。
// 时间与曲线都在 emenu.css 开头的变量里；舞台带 data-motion="off"（系统「减少动态效果」或后台设成「简洁」）时这里什么都不做。
//
// 退场为什么用「影子」：弹窗、抽屉、菜品详情关掉时，React 那边照旧马上卸掉（逻辑与 8.0.12 完全一样，不会有两份能点的弹窗），
// 卸掉之前把它的 DOM 复制一份放进舞台最上面的影子层，影子不能点、读屏不念、没有测试标记，播完退场动画自己删掉。

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ImgHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { useStage } from './stage';
import { rubberBand, STAGE_W } from './viewport';

const stageOf = (node: Element): HTMLElement | null => node.closest<HTMLElement>('[data-emenu-stage]');
const ghostLayer = (stage: HTMLElement): HTMLElement | null => stage.querySelector<HTMLElement>(':scope > [data-emenu-ghosts]');
const animatedNow = (stage: HTMLElement): boolean => stage.closest('.emenu')?.getAttribute('data-motion') !== 'off';

/** 一个元素的中心在设计稿坐标里的位置（把屏幕上的位置换算回 1024×768） */
export function designPoint(el: Element): { x: number; y: number } | null {
  const stage = stageOf(el);
  if (!stage) return null;
  const s = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const scale = s.width / STAGE_W || 1;
  return { x: (r.left + r.width / 2 - s.left) / scale, y: (r.top + r.height / 2 - s.top) / scale };
}

// ───────────────────────── 退场的影子 ─────────────────────────

/**
 * 接下来要打开的是哪一层（EmenuPage 在换层之前写）：抽屉里从「未下单」进「备注」、从「备注」回来，是同一块抽屉换内容，
 * 旧的不播滑出去的退场（不然两块抽屉一出一进，像闪了一下）。
 */
export const overlayNav: { to: string | null } = { to: null };

const DRAWERS = new Set(['drawer', 'remark']);
const skipGhost = (kind: string) => DRAWERS.has(kind) && overlayNav.to !== null && DRAWERS.has(overlayNav.to);

function makeGhost(node: HTMLElement): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;
  clone.classList.add('em-ghost');
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const attr of ['data-testid', 'id', 'role', 'aria-label', 'aria-pressed', 'aria-current', 'tabindex']) el.removeAttribute(attr);
  }
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  // 复制出来的输入框只带着最初的值、滚动的位置回到顶上：照原样补上
  const inputs = node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((el, i) => {
    el.value = inputs[i]?.value ?? '';
    el.readOnly = true;
  });
  return clone;
}

/**
 * 这一层卸掉时留一个影子播退场动画。返回的 ref 挂在这一层最外面的元素上（它要直接放在舞台里，位置才对得上）。
 * 怎么退由 CSS 定：影子自己淡出，里面带 data-em-out 的元素另有各自的退法（pop 缩小、drawer 向右滑出、zoom 整块缩小）。
 */
export function useExitGhost<T extends HTMLElement>(kind: string): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (!node || !node.isConnected) return;
      const stage = stageOf(node);
      const layer = stage && ghostLayer(stage);
      if (!stage || !layer || !animatedNow(stage) || skipGhost(kind)) return;
      const scrolls = [...node.querySelectorAll<HTMLElement>('.emenu-scroll')].map((el) => el.scrollTop);
      const clone = makeGhost(node);
      // 开发模式下 React 会把副作用先卸一次再装回来（StrictMode）：那一次这一层还在页面上，不留影子
      queueMicrotask(() => {
        if (node.isConnected) return;
        layer.appendChild(clone);
        clone.querySelectorAll<HTMLElement>('.emenu-scroll').forEach((el, i) => {
          el.scrollTop = scrolls[i] ?? 0;
        });
        const done = () => clone.remove();
        clone.addEventListener('animationend', (e) => e.target === clone && done());
        window.setTimeout(done, 900);
      });
    };
  }, [kind]);
  return ref;
}

// ───────────────────────── 飞向订单的小圆点 ─────────────────────────

/** 顶栏订单图标的中心（设计稿：837.5, 45.2，17.9 × 20.4） */
const ORDER_AT = { x: 846.5, y: 55.4 };

/** 加菜时一个小圆点从加号飞到右上角的订单图标：横向匀速、纵向先慢后快，走出一条弧线 */
export function flyToOrder(from: Element) {
  const stage = stageOf(from);
  const layer = stage && ghostLayer(stage);
  const start = designPoint(from);
  if (!stage || !layer || !start || !animatedNow(stage) || typeof layer.animate !== 'function') return;
  const dx = ORDER_AT.x - start.x;
  const dy = ORDER_AT.y - start.y;
  const ms = Math.round(520 + Math.min(260, Math.hypot(dx, dy) * 0.35));
  const outer = document.createElement('span');
  const inner = document.createElement('span');
  outer.style.cssText = `position:absolute;left:${start.x - 5}px;top:${start.y - 5}px;width:10px;height:10px;will-change:transform`;
  inner.style.cssText = 'display:block;width:10px;height:10px;border-radius:50%;background:var(--em-tan);box-shadow:0 2px 8px rgb(75 57 42 / 0.28);will-change:transform,opacity';
  outer.appendChild(inner);
  layer.appendChild(outer);
  outer.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${dx}px)` }], { duration: ms, easing: 'linear', fill: 'forwards' });
  const fly = inner.animate(
    [
      { transform: 'translateY(0) scale(1)', opacity: 1 },
      { transform: `translateY(${dy}px) scale(0.45)`, opacity: 0.85 },
    ],
    { duration: ms, easing: 'cubic-bezier(0.5, -0.18, 0.85, 0.6)', fill: 'forwards' },
  );
  const done = () => outer.remove();
  fly.onfinish = done;
  fly.oncancel = done;
  window.setTimeout(done, ms + 200);
}

// ───────────────────────── 带回弹的上下滑 ─────────────────────────

/**
 * 能上下滑的一块（订单抽屉里的菜、搜索结果）：滑到头再拖有阻尼、松手回弹。
 * 滚动仍是浏览器自己的（惯性照旧）；到了头以后这里接手，把里面的内容按阻尼挪一点，松手用缓出曲线回到原位。
 */
export function ScrollArea({ children, style, testId, className }: { children: ReactNode; style?: CSSProperties; testId?: string; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const { scale, animated } = useStage();
  const live = useRef({ scale, animated });
  live.current = { scale, animated };

  useEffect(() => {
    const el = outer.current;
    const content = inner.current;
    if (!el || !content) return;
    let startY = 0;
    let bandFrom: number | null = null;
    const release = () => {
      if (bandFrom === null) return;
      bandFrom = null;
      content.style.transition = 'transform var(--em-in) var(--em-ease)';
      content.style.transform = '';
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0]!.clientY;
      bandFrom = null;
      content.style.transition = 'none';
    };
    const onMove = (e: TouchEvent) => {
      if (!live.current.animated || e.touches.length !== 1) return;
      const y = e.touches[0]!.clientY;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const pull = y - (bandFrom ?? startY);
      if ((atTop && pull > 0) || (atBottom && pull < 0)) {
        if (bandFrom === null) bandFrom = y;
        const d = (y - bandFrom) / live.current.scale;
        if (e.cancelable) e.preventDefault();
        content.style.transform = `translate3d(0, ${Math.sign(d) * rubberBand(Math.abs(d), el.clientHeight || 300)}px, 0)`;
      } else if (bandFrom !== null) {
        bandFrom = null;
        content.style.transform = '';
      }
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', release);
    el.addEventListener('touchcancel', release);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', release);
      el.removeEventListener('touchcancel', release);
    };
  }, []);

  return (
    <div ref={outer} className={`emenu-scroll${className ? ` ${className}` : ''}`} style={style} data-testid={testId}>
      <div ref={inner} style={{ willChange: 'transform' }}>
        {children}
      </div>
    </div>
  );
}

// ───────────────────────── 淡入的图片 ─────────────────────────

/** 图片加载完淡入（不再一下子跳出来）；已经在缓存里的马上显示 */
export function FadeImg({ className, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const ref = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  useLayoutEffect(() => {
    setLoaded(!!ref.current?.complete && (ref.current?.naturalWidth ?? 0) > 0);
  }, [props.src]);
  return <img ref={ref} alt="" draggable={false} {...props} className={`em-img${className ? ` ${className}` : ''}`} data-loaded={loaded || undefined} onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} />;
}
