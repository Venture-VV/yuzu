// UI 工作台编辑器的画布（8.1.1 起，docs/WORKBENCH_V811.md 第 1、2 节）：中间平板（或手机）大小的框里画的是真实的版面
// （与平板、员工食堂同一个渲染器），上面盖一层透明的操作层：点一下选中（Shift 多选）、拖动挪位置（靠近别的块与画布的边、
// 中线时出对齐线并吸过去）、拉角改大小（等比缩放的功能块只能等比，按住 Shift 也是等比）、双击文字到右边改字。
//
// 8.1.2：手机界面（小程序、员工食堂）按 375 宽画，屏往下长；自动排列（横排、竖排）里的节点位置由渲染出来的页面量
// （按 x / y 算不准），不能拖着挪（按先后排：方向键、图层里的上下），改大小可以（改了的那一边变成「固定」）。

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { colorValue, type StudioBlockNode, type StudioDoc, type StudioNode, type StudioSurfaceDef } from '@shared/studio';
import { EmbeddedStage } from '../emenu/stage';
import { LangProvider, type Lang } from '../emenu/i18n';
import { StudioNodes, StudioPhoneScreen } from '../../studio-render/StudioNodes';
import { absBox, findNode, geometryRules, hitTest, round1, screenOf, snapBox, updateNodes, type Box, type Guide } from './model';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

interface Drag {
  kind: 'move' | 'resize';
  handle?: Handle;
  ids: string[];
  /** 拖之前的那一份（拖完记成一步撤销） */
  before: StudioDoc;
  startX: number;
  startY: number;
  /** 拖之前各块的位置（框里的是相对框的） */
  boxes: Record<string, Box>;
  moved: boolean;
}

export function StudioCanvas({
  doc,
  screen,
  surface,
  selection,
  onSelect,
  scale,
  lang,
  big,
  vars,
  blocks,
  onLive,
  onCommit,
  onEditText,
  onMeasure,
}: {
  doc: StudioDoc;
  screen: string;
  surface: StudioSurfaceDef;
  selection: string[];
  onSelect: (ids: string[]) => void;
  scale: number;
  lang: Lang;
  big: boolean;
  vars: Record<string, string>;
  blocks: Record<string, (n: StudioBlockNode) => ReactNode>;
  onLive: (doc: StudioDoc) => void;
  onCommit: (before: StudioDoc) => void;
  onEditText: (id: string) => void;
  /** 量到的各块在画布上的位置大小（存成组件时用：自动排列里撑满、跟内容的块版面里的宽高不准） */
  onMeasure?: (boxes: ReadonlyMap<string, Box>) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const s = screenOf(doc, screen);
  const phone = surface.kind === 'phone';
  const W = surface.size.w;
  const screenH = s.height ?? surface.size.h;

  // ── 量：自动排列里的节点在画布上的位置（每次画完量一遍；与缩放无关，按设计稿的像素） ──
  const [measured, setMeasured] = useState<{ boxes: Map<string, Box>; height: number }>({ boxes: new Map(), height: screenH });
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;
    const r0 = root.getBoundingClientRect();
    const k = r0.width > 0 ? r0.width / W : 1;
    const boxes = new Map<string, Box>();
    root.querySelectorAll<HTMLElement>('[data-studio-node]').forEach((el) => {
      const r = el.getBoundingClientRect();
      boxes.set(el.dataset.studioNode!, { x: (r.left - r0.left) / k, y: (r.top - r0.top) / k, w: r.width / k, h: r.height / k });
    });
    const height = phone ? Math.max(screenH, root.scrollHeight) : surface.size.h;
    setMeasured((m) => (sameBoxes(m.boxes, boxes) && m.height === height ? m : { boxes, height }));
    onMeasure?.(boxes);
  });
  const H = phone ? measured.height : surface.size.h;
  // 在图层里点中的一块不在眼前（手机界面往下长）：画布滚到它那里
  const selKey = selection.join(',');
  useEffect(() => {
    if (selection.length !== 1 || drag.current) return;
    layer.current?.querySelector(`[data-testid="studio-selected-${CSS.escape(selection[0]!)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // 只在换了选中的时候滚（拖动、改属性时不滚）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, measured]);
  /** 一块在画布上的位置：自由摆放的按 x / y 算（与 8.1.1 一样，旋转的也按没转的框），自动排列里的用量出来的 */
  const boxOf = (id: string, d: StudioDoc = doc): Box | null => absBox(d, screen, id) ?? measured.boxes.get(id) ?? null;

  const pointAt = (e: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const begin = (e: ReactPointerEvent, kind: Drag['kind'], ids: string[], handle?: Handle) => {
    const boxes: Record<string, Box> = {};
    for (const id of ids) {
      const f = findNode(doc, screen, id);
      if (!f) continue;
      // 自动排列里改大小：从量出来的大小开始（跟内容、撑满的那一边，版面里的 w / h 不准）
      const m = f.flow ? measured.boxes.get(id) : null;
      boxes[id] = { x: f.node.x, y: f.node.y, w: m?.w ?? f.node.w, h: m?.h ?? f.node.h };
    }
    const p = pointAt(e);
    drag.current = { kind, handle, ids, before: doc, startX: p.x, startY: p.y, boxes, moved: false };
    layer.current?.setPointerCapture(e.pointerId);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    if (handle && selection.length === 1) {
      e.preventDefault();
      begin(e, 'resize', selection, handle);
      return;
    }
    const p = pointAt(e);
    const id = hitTest(s.nodes, p.x, p.y, (x) => boxOf(x));
    if (!id) {
      onSelect([]);
      return;
    }
    if (e.shiftKey) {
      onSelect(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]);
      return;
    }
    const ids = selection.includes(id) ? selection : [id];
    if (!selection.includes(id)) onSelect([id]);
    // 能挪的才拖（自动排列里的不能拖）
    const movable = ids.filter((x) => {
      const f = findNode(doc, screen, x);
      return f && geometryRules(f.node, surface, f.flow).move;
    });
    if (movable.length) {
      e.preventDefault();
      begin(e, 'move', movable);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const p = pointAt(e);
    if (!d) {
      setHover(hitTest(s.nodes, p.x, p.y, (x) => boxOf(x)));
      return;
    }
    let dx = p.x - d.startX;
    let dy = p.y - d.startY;
    if (!d.moved && Math.abs(dx) * scale < 2 && Math.abs(dy) * scale < 2) return;
    d.moved = true;
    const patches: Record<string, Partial<StudioNode>> = {};
    if (d.kind === 'move') {
      // 贴齐：按这几块合起来的外框，跟别的块与画布比
      const abs = d.ids.map((id) => boxOf(id, d.before)).filter((b): b is Box => !!b);
      if (!abs.length) return;
      const union = abs.reduce((u, b) => ({
        x: Math.min(u.x, b.x),
        y: Math.min(u.y, b.y),
        w: Math.max(u.x + u.w, b.x + b.w) - Math.min(u.x, b.x),
        h: Math.max(u.y + u.h, b.y + b.h) - Math.min(u.y, b.y),
      }));
      const others: Box[] = [];
      const collect = (nodes: readonly StudioNode[]) => {
        for (const n of nodes) {
          if (n.hidden || d.ids.includes(n.id)) continue;
          const b = boxOf(n.id, d.before);
          if (b) others.push(b);
          if (n.type === 'frame') collect(n.children);
        }
      };
      collect(s.nodes);
      const snap = e.altKey ? { dx: 0, dy: 0, guides: [] } : snapBox({ ...union, x: union.x + dx, y: union.y + dy }, others, { w: W, h: H }, 5 / scale);
      dx += snap.dx;
      dy += snap.dy;
      setGuides(snap.guides);
      for (const id of d.ids) {
        const b = d.boxes[id]!;
        patches[id] = { x: round1(b.x + dx), y: round1(b.y + dy) };
      }
    } else {
      const id = d.ids[0]!;
      const b = d.boxes[id]!;
      const f = findNode(d.before, screen, id);
      if (!f) return;
      const rules = geometryRules(f.node, surface, f.flow);
      if (rules.resize === 'none') return;
      const h = d.handle!;
      let x = b.x;
      let y = b.y;
      let w = b.w;
      let hh = b.h;
      if (h.includes('e')) w = b.w + dx;
      if (h.includes('w')) {
        w = b.w - dx;
        x = b.x + dx;
      }
      if (h.includes('s')) hh = b.h + dy;
      if (h.includes('n')) {
        hh = b.h - dy;
        y = b.y + dy;
      }
      const keep = rules.resize === 'scale' || e.shiftKey;
      if (keep && b.w > 0 && b.h > 0) {
        const ratio = b.h / b.w;
        // 以拉得多的那一边为准
        if (h === 'n' || h === 's') w = hh / ratio;
        else hh = w * ratio;
        if (h.includes('w')) x = b.x + b.w - w;
        if (h.includes('n')) y = b.y + b.h - hh;
        if (h === 'n' || h === 's') x = b.x + (b.w - w) / 2;
        if (h === 'e' || h === 'w') y = b.y + (b.h - hh) / 2;
      }
      w = Math.max(4, w);
      hh = Math.max(4, hh);
      if (f.flow) {
        // 自动排列里：位置按先后排，只改大小；拉过的那一边变成「固定」
        const sizing = { ...(f.node.sizing ?? { w: 'fixed', h: 'fixed' }) };
        const patch: Partial<StudioNode> = {};
        if (h.includes('e') || h.includes('w') || keep) {
          sizing.w = 'fixed';
          patch.w = round1(w);
        }
        if (h.includes('n') || h.includes('s') || keep) {
          sizing.h = 'fixed';
          patch.h = round1(hh);
        }
        patches[id] = { ...patch, sizing };
      } else patches[id] = { x: round1(x), y: round1(y), w: round1(w), h: round1(hh) };
    }
    onLive(updateNodes(d.before, screen, patches));
  };

  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    if (layer.current?.hasPointerCapture(e.pointerId)) layer.current.releasePointerCapture(e.pointerId);
    if (d?.moved) onCommit(d.before);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const p = pointAt(e);
    const id = hitTest(s.nodes, p.x, p.y, (x) => boxOf(x));
    const f = id ? findNode(doc, screen, id) : null;
    if (f && (f.node.type === 'text' || f.node.type === 'button' || f.node.type === 'field')) onEditText(f.node.id);
  };

  const box = (b: Box) => ({ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale });
  const single = selection.length === 1 ? findNode(doc, screen, selection[0]!) : null;
  const singleRules = single ? geometryRules(single.node, surface, single.flow) : null;
  const singleBox = single ? boxOf(single.node.id) : null;
  const background = colorValue(s.background, surface.cssVar);
  const ctx = { surface, lang, assetUrl: (id: string) => `/api/studio/assets/${id}`, blocks, editor: true, components: doc.components };

  return (
    <div style={{ position: 'relative', width: W * scale, height: H * scale }} className="shadow-[0_8px_30px_rgb(0_0_0/0.18)]" data-testid="studio-canvas">
      {phone ? (
        // 手机：375 宽、往下长；主题变量、字体设在最外层
        <div style={{ position: 'absolute', left: 0, top: 0, width: W, transform: `scale(${scale})`, transformOrigin: '0 0', ...(vars as React.CSSProperties) }}>
          <div ref={stage}>
            <StudioPhoneScreen screen={s} ctx={ctx} />
          </div>
        </div>
      ) : (
        <EmbeddedStage scale={scale} lang={lang} big={big} vars={vars}>
          <LangProvider value={lang}>
            {/* 这一屏的底色（起始页默认是图片占位色）；节点盖在上面 */}
            <div ref={stage} style={{ position: 'absolute', left: 0, top: 0, width: W, height: surface.size.h, background, overflow: 'hidden' }}>
              <StudioNodes nodes={s.nodes} ctx={ctx} />
            </div>
          </LangProvider>
        </EmbeddedStage>
      )}
      {/* 操作层 */}
      <div
        ref={layer}
        className="absolute inset-0 touch-none select-none"
        style={{ cursor: drag.current?.kind === 'move' ? 'grabbing' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={() => !drag.current && setHover(null)}
        onDoubleClick={onDoubleClick}
        data-testid="studio-canvas-layer"
      >
        {phone && screenH < H && (
          // 手机的一屏有多高（下面是内容多出来往下长的部分）：一条虚线
          <div className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-[#2f7cf6]/40" style={{ top: screenH * scale }} />
        )}
        {hover &&
          !selection.includes(hover) &&
          (() => {
            const b = boxOf(hover);
            return b ? <div className="pointer-events-none absolute border border-[#2f7cf6]/70" style={box(b)} /> : null;
          })()}
        {selection.map((id) => {
          const b = boxOf(id);
          if (!b) return null;
          return <div key={id} className="pointer-events-none absolute border-2 border-[#2f7cf6]" style={box(b)} data-testid={`studio-selected-${id}`} />;
        })}
        {single &&
          singleRules &&
          singleBox &&
          singleRules.resize !== 'none' &&
          (() => {
            const b = singleBox;
            const pos: Record<Handle, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
            // 等比缩放的块只给四个角
            const list = singleRules.resize === 'scale' ? (['nw', 'ne', 'se', 'sw'] as Handle[]) : HANDLES;
            return list.map((h) => (
              <div
                key={h}
                data-handle={h}
                className="absolute size-[10px] rounded-[2px] border border-[#2f7cf6] bg-white"
                style={{ left: (b.x + b.w * pos[h][0]) * scale - 5, top: (b.y + b.h * pos[h][1]) * scale - 5, cursor: CURSORS[h] }}
                data-testid={`studio-handle-${h}`}
              />
            ));
          })()}
        {single && singleBox && (
          <div
            className="pointer-events-none absolute rounded bg-[#2f7cf6] px-1.5 py-0.5 text-[11px] leading-none text-white tabular-nums"
            style={{ left: singleBox.x * scale, top: (singleBox.y + singleBox.h) * scale + 6 }}
          >
            {Math.round(singleBox.w)} × {Math.round(singleBox.h)}
            {single.flow && '（自动排列）'}
          </div>
        )}
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
