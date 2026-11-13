// 菜单页一页一页左右翻（8.0.13，docs/EMENU.md 第 11.3 节）：跟手拖动、松手按速度与距离决定翻不翻、带惯性缓停；
// 第一页、最后一页再拖有阻尼、松手回弹。8.0.12 以前用的是浏览器自己的横向滚动加吸附，各家平板手感不一、有的没有回弹。
//
// 页面的位置直接写在轨道的 transform 上（拖动时每一帧都改，不经过 React）；翻到第几页由外面记（index），
// 这里只在松手、滚轮翻页时告诉外面（onIndex）。离当前页两页以外的不渲染，只占位置。

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { box, useStage } from './stage';
import { dragPosition, settlePage, STAGE_H, STAGE_W } from './viewport';

export interface StripHandle {
  /**
   * 翻到第 i 页：slide 滑过去；jump 直接到；zoom 直接到、那一页轻微放大缓入（点分类页签时）
   */
  goTo: (i: number, mode: 'slide' | 'jump' | 'zoom') => void;
  /** 现在停在第几页（按轨道的位置算） */
  page: () => number;
}

interface Drag {
  id: number;
  x0: number;
  y0: number;
  base: number;
  active: boolean;
  samples: { t: number; x: number }[];
}

export const MenuStrip = forwardRef<StripHandle, { count: number; index: number; onIndex: (i: number) => void; pageKey: (i: number) => string; renderPage: (i: number) => ReactNode }>(function MenuStrip(
  { count, index, onIndex, pageKey, renderPage },
  ref,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const { scale, animated } = useStage();
  const live = useRef({ scale, animated, count, index, onIndex });
  live.current = { scale, animated, count, index, onIndex };
  const pos = useRef(index * STAGE_W);
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const [zoom, setZoom] = useState<{ index: number; n: number } | null>(null);

  const apply = (x: number, animate: boolean) => {
    const el = track.current;
    pos.current = x;
    if (!el) return;
    el.style.transition = animate && live.current.animated ? 'transform var(--em-page) var(--em-ease)' : 'none';
    el.style.transform = `translate3d(${-x}px, 0, 0)`;
  };

  useImperativeHandle(ref, () => ({
    goTo: (i, mode) => {
      apply(i * STAGE_W, mode === 'slide');
      if (mode === 'zoom') setZoom((z) => ({ index: i, n: (z?.n ?? 0) + 1 }));
    },
    page: () => Math.round(pos.current / STAGE_W),
  }));

  // 刚出现时（页面被系统刷新后接着上一次点餐）停在外面记的那一页
  useLayoutEffect(() => {
    apply(live.current.index * STAGE_W, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = viewport.current;
    const rail = track.current;
    if (!el || !rail) return;
    const end = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      drag.current = null;
      if (!d.active) return;
      const { count: n } = live.current;
      const now = performance.now();
      const recent = d.samples.filter((s) => now - s.t <= 120);
      const first = recent[0];
      const last = recent[recent.length - 1];
      // 速度：最近 120 毫秒手指走了多少（设计稿像素 / 毫秒）；往左甩是正的（去下一页）
      const velocity = first && last && last.t > first.t ? -(last.x - first.x) / live.current.scale / (last.t - first.t) : 0;
      const from = Math.max(0, Math.min(n - 1, Math.round(d.base / STAGE_W)));
      const target = settlePage(from, pos.current - d.base, velocity, n);
      apply(target * STAGE_W, true);
      if (target !== live.current.index) live.current.onIndex(target);
      swallowClick.current = true;
      window.setTimeout(() => {
        swallowClick.current = false;
      }, 0);
    };
    const onDown = (e: PointerEvent) => {
      if (drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
      // 正在滑的时候按住：从现在滑到的地方接着拖
      const m = new DOMMatrixReadOnly(getComputedStyle(rail).transform);
      const base = Number.isFinite(m.m41) ? -m.m41 : pos.current;
      drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base, active: false, samples: [{ t: performance.now(), x: e.clientX }] };
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      if (!d.active) {
        // 横着拖出 8 像素才算翻页；竖着划的、点一下的都不管
        if (Math.abs(dx) < 8 * live.current.scale) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.2) {
          drag.current = null;
          return;
        }
        d.active = true;
        d.x0 = e.clientX;
        apply(d.base, false);
        try {
          el.setPointerCapture(d.id);
        } catch {
          /* 这个指针已经抬起了 */
        }
        return;
      }
      d.samples.push({ t: performance.now(), x: e.clientX });
      if (d.samples.length > 12) d.samples.shift();
      apply(dragPosition(d.base, dx / live.current.scale, live.current.count), false);
    };
    // 拖完松手带出来的那一下点击不算（不然会点开手指底下的菜）
    const onClick = (e: MouseEvent) => {
      if (!swallowClick.current) return;
      e.stopPropagation();
      e.preventDefault();
    };
    // 触控板、鼠标滚轮横着滚：一次翻一页
    let wheelAt = 0;
    const onWheel = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (Math.abs(dx) < 24 || Date.now() - wheelAt < 500) return;
      wheelAt = Date.now();
      const { index: i, count: n } = live.current;
      const target = Math.max(0, Math.min(n - 1, i + (dx > 0 ? 1 : -1)));
      if (target === i) return;
      apply(target * STAGE_W, true);
      live.current.onIndex(target);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('click', onClick, true);
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  return (
    <div ref={viewport} className="emenu-strip" style={{ ...box(0, 0, STAGE_W, STAGE_H) }} data-testid="emenu-strip">
      <div ref={track} style={{ display: 'flex', width: count * STAGE_W, height: STAGE_H, willChange: 'transform' }}>
        {Array.from({ length: count }, (_, i) => (
          <div key={pageKey(i)} style={{ width: STAGE_W, height: STAGE_H, flex: 'none' }} data-page={i}>
            {Math.abs(i - index) <= 2 && (
              <div key={zoom?.index === i ? `z${zoom.n}` : 'p'} className={zoom?.index === i ? 'em-page-in' : undefined} style={{ width: STAGE_W, height: STAGE_H }}>
                {renderPage(i)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
