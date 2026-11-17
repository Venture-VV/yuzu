// UI 工作台里改卡片模板的画布（8.1.2，GZ13，docs/WORKBENCH_V811.md 第 13 节）：画的是平板上的菜单页（顶栏、装饰、翻页圆点都在，
// 与平板同一个渲染器），菜单页换成选中的版式；上面一层给版式里的每一块（照片、特写图、菜名价格、小标题、介绍、文字陈列的一行）
// 画框：点一下选中，拖动挪位置（靠近别的块、页边、中线时出对齐线并吸过去，按住 Alt 不吸），拉边角改大小（照片宽高都能改，
// 文字、介绍只改宽——高跟着内容走），藏起来的块画成虚线框（选中以后在右边取消）。
//
// 改的是顶栏「原样 / 放大」选中的那一档：两档各有一套位置（平板用哪一档在后台「电子菜单 → 设置」里定）。
// 文字块的位置按量出来的（放大一档整块放大 1.4 倍，量的是看到的大小）；没画出来的块（藏起来的）按登记的位置画框。
//
// 顶栏（8.1.6，QZ8、QZ9）：layout 为 header 时画的是顶栏的六块（字标、分类、中英切换、搜索、订单、手牌）——字标、图标、
// 手牌拉角等比缩放，分类那一块只改宽；挪的时候往顶栏的中线、左右页边、别的块上吸；拖着或选中一块时，它与左右相邻两块
// （没有就是屏幕边）之间画出间距线、标出设计稿像素（一位小数），随手指实时变。

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { EmenuLayout, EmenuPageView } from '@shared/emenu';
import {
  colorValue,
  EMENU_ALL_TEMPLATES,
  EMENU_HEADER_H,
  EMENU_HEADER_LAYOUT,
  EMENU_HEADER_MID,
  headerSlotRatio,
  resolveSlot,
  setSlotSpot,
  slotResizable,
  slotSpot,
  type EmenuSlotSpot,
  type ResolvedSlot,
  type StudioBlockNode,
  type StudioDishState,
  type StudioDoc,
  type StudioSurfaceDef,
} from '@shared/studio';
import { EmbeddedStage } from '../emenu/stage';
import { LangProvider, type Lang } from '../emenu/i18n';
import { PageCanvas } from '../emenu/pages';
import { EmenuTemplatesProvider } from '../emenu/templates';
import { StudioNodes } from '../../studio-render/StudioNodes';
import { cn } from '../../lib/utils';
import { frameBatcher, round1, screenOf, snapBox, type Box, type Guide } from './model';
import { pageInState } from './templateModel';
import { neighborGaps } from './headerGaps';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const HANDLE_AT: Record<Handle, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

/** 页面上放菜的那一块（左右各留 40，顶栏下面到翻页圆点上面）：挪的时候也往它的边上吸 */
const PAGE_AREA: Box = { x: 40, y: 133.8, w: 944, h: 594.2 };
/** 改宽、改高最小到多少（文字太窄菜名、价格排不下） */
const MIN_W = { photo: 24, text: 80 } as const;
/** 顶栏（8.1.6）：左右页边之间那一条、各块对齐的中线（挪的时候往上吸） */
const HEAD_AREA: Box = { x: 40, y: 0, w: 944, h: EMENU_HEADER_H };
const HEAD_MID: Box = { x: 0, y: EMENU_HEADER_MID, w: 1024, h: 0 };
/** 顶栏里等比缩放的块最小、最大到默认的几倍；分类那一块最窄多少 */
const HEAD_SCALE = { min: 0.5, max: 2.5 } as const;
const HEAD_CATS_MIN = 120;
const CORNERS: Handle[] = ['nw', 'ne', 'se', 'sw'];

interface Drag {
  kind: 'move' | 'resize';
  handle?: Handle;
  key: string;
  before: StudioDoc;
  startX: number;
  startY: number;
  /** 拖之前这一块在这一档的位置（存进版面的数）与画布上量到的框 */
  spot: EmenuSlotSpot;
  box: Box;
  moved: boolean;
}

export function TemplateCanvas({
  doc,
  surface,
  layout,
  page,
  categoryName,
  categoryNameEn,
  selected,
  onSelect,
  scale,
  lang,
  big,
  vars,
  blocks,
  onLive,
  onCommit,
  previewState,
  langOn = true,
  onHeadBoxes,
}: {
  doc: StudioDoc;
  surface: StudioSurfaceDef;
  /** 菜单页的一种版式，或顶栏（header，8.1.6） */
  layout: EmenuLayout | typeof EMENU_HEADER_LAYOUT;
  page: EmenuPageView;
  categoryName: string;
  categoryNameEn: string;
  selected: string | null;
  onSelect: (key: string | null) => void;
  scale: number;
  lang: Lang;
  big: boolean;
  vars: Record<string, string>;
  blocks: Record<string, (n: StudioBlockNode) => ReactNode>;
  onLive: (doc: StudioDoc) => void;
  onCommit: (before: StudioDoc) => void;
  /** 在看菜的哪种状态（变体）：这一页的菜都按这种状态画 */
  previewState?: StudioDishState | null;
  /** 后台开着中英切换（顶栏：关着时中英切换那一块画成虚线框，平板上没有它） */
  langOn?: boolean;
  /** 顶栏各块在画布上量到的框（右边「间距」用）；量到的变了才叫 */
  onHeadBoxes?: (boxes: ReadonlyMap<string, Box>) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // 拖动、拉大小时每一帧最多交一次改动（8.1.6，QZ4）；松手时先交完再记撤销
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;
  const live = useMemo(() => frameBatcher<StudioDoc>((d) => onLiveRef.current(d)), []);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const W = surface.size.w;
  const H = surface.size.h;
  const mode = big ? 'big' : 'design';
  const menuScreen = screenOf(doc, 'menu');
  const isHead = layout === EMENU_HEADER_LAYOUT;
  const slots: ResolvedSlot[] = EMENU_ALL_TEMPLATES[layout]!.slots.map((def) => resolveSlot(def, doc.templates?.[layout]?.[def.key]));
  /** 画成虚线框的：藏起来的块；顶栏里后台关了中英切换时的那一块（平板上没有它，位置照样能改） */
  const ghost = (s: ResolvedSlot) => s.hidden || (isHead && !langOn && s.def.key === 'lang');

  // 菜单页换成这种版式的一页（照片没配图时写上「餐品展示」「特写图」，不能点）；其余的块（顶栏、圆点、装饰）照常画
  const pageBlocks = useMemo(
    () => ({
      ...blocks,
      'menu.pages': () => (
        <EmenuTemplatesProvider templates={doc.templates} dishStates={doc.dishStates}>
          <PageCanvas page={pageInState(page, previewState ?? null)} ctx={{ categoryName, categoryNameEn, open: previewState !== 'closed', preview: true }} />
        </EmenuTemplatesProvider>
      ),
    }),
    [blocks, doc.templates, doc.dishStates, page, categoryName, categoryNameEn, previewState],
  );

  // ── 量：每一块在画布上看到的框（每次画完量一遍；字体晚到时再量一遍） ──
  const [measured, setMeasured] = useState<Map<string, Box>>(new Map());
  const headBoxesOut = useRef(onHeadBoxes);
  headBoxesOut.current = onHeadBoxes;
  const [fontsTick, setFontsTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => alive && setFontsTick((t) => t + 1));
    return () => {
      alive = false;
    };
  }, []);
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;
    const r0 = root.getBoundingClientRect();
    const k = r0.width > 0 ? r0.width / W : 1;
    const boxes = new Map<string, Box>();
    root.querySelectorAll<HTMLElement>(isHead ? '[data-studio-head]' : '[data-studio-slot]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const b = { x: (r.left - r0.left) / k, y: (r.top - r0.top) / k, w: r.width / k, h: r.height / k };
      const key = (isHead ? el.dataset.studioHead : el.dataset.studioSlot)!;
      const u = boxes.get(key);
      boxes.set(key, u ? { x: Math.min(u.x, b.x), y: Math.min(u.y, b.y), w: Math.max(u.x + u.w, b.x + b.w) - Math.min(u.x, b.x), h: Math.max(u.y + u.h, b.y + b.h) - Math.min(u.y, b.y) } : b);
    });
    setMeasured((m) => (sameBoxes(m, boxes) ? m : boxes));
    if (isHead) headBoxesOut.current?.(boxes);
    // fontsTick：字体到了以后重新量
  }, [doc, page, layout, big, lang, scale, fontsTick, W, previewState, isHead]);

  /** 一块在画布上的框：画出来的按量的；藏起来的按登记的位置（往上长的文字按下沿往上推一个登记的高） */
  const boxOf = (s: ResolvedSlot): Box => {
    const m = ghost(s) ? null : measured.get(s.def.key);
    if (m) return m;
    const p = slotSpot(s, mode);
    return { x: p.x, y: p.bottom !== undefined ? p.bottom - p.h : p.y, w: p.w, h: p.h };
  };

  const pointAt = (e: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const begin = (e: ReactPointerEvent, kind: Drag['kind'], s: ResolvedSlot, handle?: Handle) => {
    const p = pointAt(e);
    drag.current = { kind, handle, key: s.def.key, before: doc, startX: p.x, startY: p.y, spot: slotSpot(s, mode), box: boxOf(s), moved: false };
    layer.current?.setPointerCapture(e.pointerId);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    const handle = t.dataset.handle as Handle | undefined;
    const sel = selected ? slots.find((s) => s.def.key === selected) : undefined;
    if (handle && sel) {
      e.preventDefault();
      begin(e, 'resize', sel, handle);
      return;
    }
    const key = t.dataset.slot;
    const s = key ? slots.find((x) => x.def.key === key) : undefined;
    if (!s) {
      onSelect(null);
      return;
    }
    onSelect(s.def.key);
    // 藏起来的只选中（在右边取消「藏起来」），不拖（顶栏里关着的中英切换照样能挪）
    if (!s.hidden) {
      e.preventDefault();
      begin(e, 'move', s);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = pointAt(e);
    let dx = p.x - d.startX;
    let dy = p.y - d.startY;
    if (!d.moved && Math.abs(dx) * scale < 2 && Math.abs(dy) * scale < 2) return;
    d.moved = true;
    const s = slots.find((x) => x.def.key === d.key);
    if (!s) return;
    if (d.kind === 'move') {
      const others = [...(isHead ? [HEAD_AREA, HEAD_MID] : [PAGE_AREA]), ...slots.filter((x) => x.def.key !== d.key && !ghost(x)).map(boxOf)];
      const snap = e.altKey ? { dx: 0, dy: 0, guides: [] } : snapBox({ ...d.box, x: d.box.x + dx, y: d.box.y + dy }, others, { w: W, h: H }, 5 / scale);
      dx += snap.dx;
      dy += snap.dy;
      setGuides(snap.guides);
      const next: Partial<EmenuSlotSpot> = d.spot.bottom !== undefined ? { x: round1(d.spot.x + dx), bottom: round1(d.spot.bottom + dy) } : { x: round1(d.spot.x + dx), y: round1(d.spot.y + dy) };
      live.push(setSlotSpot(d.before, layout, d.key, mode, next));
      return;
    }
    const can = slotResizable(s.def);
    const h = d.handle!;
    // 顶栏的字标、图标、手牌：拉角等比缩放（对角不动），最小一半、最大两倍半
    const ratio = headerSlotRatio(s.def);
    if (ratio !== null) {
      const def0 = resolveSlot(s.def, undefined);
      const base = slotSpot(def0, mode);
      // 横着拉按宽换算成高，竖着拉按高；哪个方向拉得多按哪个
      const byX = (h.includes('e') ? dx : -dx) / ratio;
      const byY = h.includes('s') ? dy : -dy;
      const grow = Math.abs(byX) > Math.abs(byY) ? byX : byY;
      const nh = Math.max(base.h * HEAD_SCALE.min, Math.min(base.h * HEAD_SCALE.max, d.spot.h + grow));
      const nw = nh * ratio;
      const nx = h.includes('w') ? d.spot.x + d.spot.w - nw : d.spot.x;
      const ny = h.includes('n') ? d.spot.y + d.spot.h - nh : d.spot.y;
      live.push(setSlotSpot(d.before, layout, d.key, mode, { x: round1(nx), y: round1(ny), w: round1(nw), h: round1(nh) }));
      return;
    }
    const min = s.def.kind === 'photo' ? MIN_W.photo : s.def.kind === 'cats' ? HEAD_CATS_MIN : MIN_W.text;
    let { x, y, w, h: hh } = d.spot;
    if (can.w && h.includes('e')) w = d.spot.w + dx;
    if (can.w && h.includes('w')) {
      w = d.spot.w - dx;
      x = d.spot.x + dx;
    }
    if (can.h && h.includes('s')) hh = d.spot.h + dy;
    if (can.h && h.includes('n')) {
      hh = d.spot.h - dy;
      y = d.spot.y + dy;
    }
    // 照片按住 Shift 等比
    if (can.h && e.shiftKey && d.spot.w > 0) {
      const ratio = d.spot.h / d.spot.w;
      if (h === 'n' || h === 's') w = hh / ratio;
      else hh = w * ratio;
      if (h.includes('w')) x = d.spot.x + d.spot.w - w;
      if (h.includes('n')) y = d.spot.y + d.spot.h - hh;
    }
    if (w < min) {
      if (h.includes('w')) x -= min - w;
      w = min;
    }
    if (hh < MIN_W.photo) {
      if (h.includes('n')) y -= MIN_W.photo - hh;
      hh = MIN_W.photo;
    }
    const next: Partial<EmenuSlotSpot> = { x: round1(x), w: round1(w) };
    if (can.h) Object.assign(next, { y: round1(y), h: round1(hh) });
    live.push(setSlotSpot(d.before, layout, d.key, mode, next));
  };

  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    if (layer.current?.hasPointerCapture(e.pointerId)) layer.current.releasePointerCapture(e.pointerId);
    live.flush();
    if (d?.moved) onCommit(d.before);
  };

  const px = (b: Box) => ({ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale });
  // 大的先画、小的后画（叠在一起时点得到小的）
  const order = [...slots].sort((a, b) => {
    const A = boxOf(a);
    const B = boxOf(b);
    return B.w * B.h - A.w * A.h;
  });
  const sel = selected ? slots.find((s) => s.def.key === selected) : undefined;
  const selBox = sel ? boxOf(sel) : null;
  const can = sel ? slotResizable(sel.def) : null;
  const handles: Handle[] = !sel || sel.hidden || !can ? [] : headerSlotRatio(sel.def) !== null ? CORNERS : can.h ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] : can.w ? ['w', 'e'] : [];
  // 顶栏：选中（拖着）的那一块与左右相邻两块之间的间距（平板上看不到的中英切换不算）
  const headBoxes = isHead ? new Map(slots.filter((x) => !ghost(x)).map((x) => [x.def.key, boxOf(x)] as const)) : null;
  const gaps = headBoxes && sel && !ghost(sel) ? neighborGaps(headBoxes, sel.def.key) : null;
  /** 正拖着（或拉着大小）：画的时候每一帧都会走到这里（改动一推版面就重画） */
  const dragging = !!drag.current?.moved;
  const background = colorValue(menuScreen.background, surface.cssVar);
  const ctx = { surface, lang, assetUrl: (id: string) => `/api/studio/assets/${id}`, blocks: pageBlocks, editor: true, components: doc.components };

  return (
    <div style={{ position: 'relative', width: W * scale, height: H * scale }} className="shadow-[0_8px_30px_rgb(0_0_0/0.18)]" data-testid="studio-template-canvas" data-mode={mode}>
      <EmbeddedStage scale={scale} lang={lang} big={big} vars={vars}>
        <LangProvider value={lang}>
          <div ref={stage} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, background, overflow: 'hidden' }}>
            <StudioNodes nodes={menuScreen.nodes} ctx={ctx} />
          </div>
        </LangProvider>
      </EmbeddedStage>
      {/* 操作层：每一块一个框 */}
      <div
        ref={layer}
        className="absolute inset-0 touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={() => !drag.current && setHover(null)}
        data-testid="studio-template-layer"
      >
        {order.map((s) => {
          const b = boxOf(s);
          const key = s.def.key;
          const on = key === selected;
          return (
            <div
              key={key}
              data-slot={key}
              className={cn(
                'absolute',
                ghost(s)
                  ? 'border border-dashed border-ink-3/70 bg-[repeating-linear-gradient(45deg,rgb(0_0_0/0.05)_0_6px,transparent_6px_12px)]'
                  : on
                    ? 'border-2 border-[#2f7cf6]'
                    : hover === key
                      ? 'border border-[#2f7cf6]'
                      : 'border border-dashed border-[#2f7cf6]/45',
              )}
              style={{ ...px(b), cursor: s.hidden ? 'pointer' : 'move' }}
              onPointerEnter={() => !drag.current && setHover(key)}
              data-testid={`studio-slot-${key}`}
              data-hidden={s.hidden || undefined}
            />
          );
        })}
        {/* 名字：选中的与鼠标指着的 */}
        {slots
          // 拖着的时候只看间距（名字、大小的小牌子收起来，免得叠在小图标的间距数上）
          .filter((s) => !dragging && (s.def.key === selected || (s.def.key === hover && !drag.current)))
          .map((s) => {
            const b = boxOf(s);
            const on = s.def.key === selected;
            return (
              <div
                key={`label-${s.def.key}`}
                className={cn('pointer-events-none absolute whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] leading-none', on ? 'bg-[#2f7cf6] text-white' : 'bg-white/90 text-[#2f7cf6] shadow-sm')}
                style={{ left: b.x * scale, top: Math.max(0, b.y * scale - 18) }}
              >
                {s.def.label}
                {s.hidden ? '（藏起来了）' : ghost(s) ? '（中英切换关着，平板上没有）' : ''}
              </div>
            );
          })}
        {sel &&
          selBox &&
          handles.map((h) => (
            <div
              key={h}
              data-handle={h}
              className="absolute size-[10px] rounded-[2px] border border-[#2f7cf6] bg-white"
              style={{ left: (selBox.x + selBox.w * HANDLE_AT[h][0]) * scale - 5, top: (selBox.y + selBox.h * HANDLE_AT[h][1]) * scale - 5, cursor: CURSORS[h] }}
              data-testid={`studio-slot-handle-${h}`}
            />
          ))}
        {sel && selBox && !dragging && (
          <div
            className="pointer-events-none absolute rounded bg-[#2f7cf6] px-1.5 py-0.5 text-[11px] leading-none text-white tabular-nums"
            style={{ left: selBox.x * scale, top: (selBox.y + selBox.h) * scale + 6 }}
          >
            {Math.round(selBox.w)} × {Math.round(selBox.h)}
            {can && !can.h && !sel.hidden ? '（高跟着内容）' : ''}
          </div>
        )}
        {gaps &&
          sel &&
          selBox &&
          (['left', 'right'] as const).map((side) => {
            const g = gaps[side];
            const len = g.to - g.from;
            const y = (selBox.y + selBox.h / 2) * scale;
            // 数写在哪：拖着时写在线上面；只是选中时写在下面那个「宽 × 高」的小牌子再下面（不压着块的名字）
            const labelTop = dragging ? -19 : (selBox.y + selBox.h) * scale - y + 26;
            // 叠在一起了：在叠住的那一段上标「叠 N」
            if (len <= -0.05)
              return (
                <div
                  key={side}
                  className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded bg-[#d9822b] px-1 py-px text-[10.5px] leading-none text-white tabular-nums"
                  style={{ left: ((g.from + g.to) / 2) * scale, top: y + labelTop }}
                  data-testid={`studio-gap-${side}`}
                  data-gap={round1(len)}
                >
                  叠 {round1(-len).toFixed(1)}
                </div>
              );
            if (len < 0.05) return null;
            return (
              <div
                key={side}
                className="pointer-events-none absolute"
                style={{ left: g.from * scale, top: y, width: len * scale, height: 1 }}
                data-testid={`studio-gap-${side}`}
                data-gap={round1(len)}
              >
                <div className="absolute inset-x-0 top-0 h-px bg-[#f2545b]" />
                <div className="absolute left-0 top-[-4px] h-[9px] w-px bg-[#f2545b]" />
                <div className="absolute right-0 top-[-4px] h-[9px] w-px bg-[#f2545b]" />
                <div className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-[#f2545b] px-1 py-px text-[10.5px] leading-none text-white tabular-nums" style={{ top: labelTop }}>
                  {round1(len).toFixed(1)}
                </div>
              </div>
            );
          })}
        {guides.map((g, i) => (
          <div
            key={i}
            className="pointer-events-none absolute bg-[#f2545b]"
            style={g.axis === 'x' ? { left: g.at * scale, top: 0, width: 1, height: H * scale } : { top: g.at * scale, left: 0, height: 1, width: W * scale }}
          />
        ))}
      </div>
    </div>
  );
}

function sameBoxes(a: Map<string, Box>, b: Map<string, Box>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || Math.abs(w.x - v.x) > 0.05 || Math.abs(w.y - v.y) > 0.05 || Math.abs(w.w - v.w) > 0.05 || Math.abs(w.h - v.h) > 0.05) return false;
  }
  return true;
}
