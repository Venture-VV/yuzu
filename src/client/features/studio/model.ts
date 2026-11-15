// UI 工作台编辑器的版面操作（8.1.1，docs/WORKBENCH_V811.md 第 1、2 节）：找节点、改、删、加、调前后、复制、点中哪一块、对齐线。
// 都是纯函数：拿一份版面、返回新的一份（不改原来的），撤销、重做存的就是这一份一份。

import { STUDIO_LIMITS, type StudioBlockDef, type StudioDoc, type StudioFrameNode, type StudioNode, type StudioScreen, type StudioSurfaceDef } from '@shared/studio';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clone = <T,>(v: T): T => (typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T));

/** 新节点的编号：随机 8 位 */
export function newId(prefix = 'n'): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

export function screenOf(doc: StudioDoc, screen: string): StudioScreen {
  return doc.screens[screen] ?? { background: null, nodes: [] };
}

interface Found {
  node: StudioNode;
  /** 所在的那一列（屏的或框的 children） */
  list: StudioNode[];
  index: number;
  parent: StudioFrameNode | null;
  /** 框的左上角在画布上的位置（框里的节点按它摆） */
  offset: { x: number; y: number };
}

function findIn(list: StudioNode[], id: string, parent: StudioFrameNode | null, offset: { x: number; y: number }): Found | null {
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    if (n.id === id) return { node: n, list, index: i, parent, offset };
    if (n.type === 'frame') {
      const r = findIn(n.children, id, n, { x: offset.x + n.x, y: offset.y + n.y });
      if (r) return r;
    }
  }
  return null;
}

export function findNode(doc: StudioDoc, screen: string, id: string): Found | null {
  return findIn(screenOf(doc, screen).nodes, id, null, { x: 0, y: 0 });
}

/** 节点在画布上的位置（框里的加上框的位置） */
export function absBox(doc: StudioDoc, screen: string, id: string): Box | null {
  const f = findNode(doc, screen, id);
  return f ? { x: f.offset.x + f.node.x, y: f.offset.y + f.node.y, w: f.node.w, h: f.node.h } : null;
}

/** 改一屏（返回新的一份版面） */
export function withScreen(doc: StudioDoc, screen: string, fn: (s: StudioScreen) => void): StudioDoc {
  const next = clone(doc);
  const s = next.screens[screen] ?? (next.screens[screen] = { background: null, nodes: [] });
  fn(s);
  return next;
}

/** 改一个节点 */
export function updateNode(doc: StudioDoc, screen: string, id: string, patch: Partial<StudioNode> | ((n: StudioNode) => StudioNode)): StudioDoc {
  return withScreen(doc, screen, (s) => {
    const f = findIn(s.nodes, id, null, { x: 0, y: 0 });
    if (!f) return;
    f.list[f.index] = typeof patch === 'function' ? patch(f.node) : ({ ...f.node, ...patch } as StudioNode);
  });
}

/** 一次改好几个节点（拖动时一起挪） */
export function updateNodes(doc: StudioDoc, screen: string, patches: Record<string, Partial<StudioNode>>): StudioDoc {
  return withScreen(doc, screen, (s) => {
    for (const [id, patch] of Object.entries(patches)) {
      const f = findIn(s.nodes, id, null, { x: 0, y: 0 });
      if (f) f.list[f.index] = { ...f.node, ...patch } as StudioNode;
    }
  });
}

export function removeNodes(doc: StudioDoc, screen: string, ids: readonly string[]): StudioDoc {
  return withScreen(doc, screen, (s) => {
    const drop = (list: StudioNode[]): StudioNode[] =>
      list.filter((n) => !ids.includes(n.id)).map((n) => (n.type === 'frame' ? { ...n, children: drop(n.children) } : n));
    s.nodes = drop(s.nodes);
  });
}

/** 加到这一屏最上面（或给的位置） */
export function insertNode(doc: StudioDoc, screen: string, node: StudioNode, index?: number): StudioDoc {
  return withScreen(doc, screen, (s) => {
    if (index === undefined || index < 0 || index > s.nodes.length) s.nodes.push(node);
    else s.nodes.splice(index, 0, node);
  });
}

/** 调前后：在同一列里往上（盖住别的）、往下、到最上、到最下 */
export function moveLayer(doc: StudioDoc, screen: string, id: string, dir: 'up' | 'down' | 'top' | 'bottom'): StudioDoc {
  return withScreen(doc, screen, (s) => {
    const f = findIn(s.nodes, id, null, { x: 0, y: 0 });
    if (!f) return;
    const [n] = f.list.splice(f.index, 1);
    const to = dir === 'up' ? Math.min(f.index + 1, f.list.length) : dir === 'down' ? Math.max(f.index - 1, 0) : dir === 'top' ? f.list.length : 0;
    f.list.splice(to, 0, n!);
  });
}

/** 换个编号（框里的连同里面的都换） */
function reId(n: StudioNode): StudioNode {
  const id = newId(n.type === 'block' ? 'b' : n.type.slice(0, 1));
  return n.type === 'frame' ? { ...n, id, children: n.children.map(reId) } : { ...n, id };
}

/** 复制一份放在旁边（往右下挪 16）：返回新的版面与新节点的编号。一屏只能有一个的功能块不复制 */
export function duplicateNodes(doc: StudioDoc, screen: string, ids: readonly string[], surface: StudioSurfaceDef): { doc: StudioDoc; ids: string[] } {
  const made: string[] = [];
  const next = withScreen(doc, screen, (s) => {
    for (const id of ids) {
      const f = findIn(s.nodes, id, null, { x: 0, y: 0 });
      if (!f) continue;
      if (f.node.type === 'block' && surface.blocks[f.node.block]?.single) continue;
      const copy = { ...reId(clone(f.node)), x: f.node.x + 16, y: f.node.y + 16, name: f.node.name ? `${f.node.name} 副本` : '', locked: false } as StudioNode;
      f.list.splice(f.index + 1, 0, copy);
      made.push(copy.id);
    }
  });
  return { doc: next, ids: made };
}

/** 一屏一共几个节点（连同框里的） */
export function countNodes(nodes: readonly StudioNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + (n.type === 'frame' ? countNodes(n.children) : 0), 0);
}
export const canAddNode = (doc: StudioDoc, screen: string) => countNodes(screenOf(doc, screen).nodes) < STUDIO_LIMITS.nodesPerScreen;

/** 点中的是哪一块：从最上面往下找（框里的先看里面），隐藏的、锁住的跳过 */
export function hitTest(nodes: readonly StudioNode[], x: number, y: number, offset = { x: 0, y: 0 }): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (n.hidden) continue;
    const ax = offset.x + n.x;
    const ay = offset.y + n.y;
    const inside = x >= ax && x <= ax + n.w && y >= ay && y <= ay + n.h;
    if (n.type === 'frame') {
      const inner = hitTest(n.children, x, y, { x: ax, y: ay });
      if (inner) return inner;
    }
    if (inside && !n.locked) return n.id;
  }
  return null;
}

/** 节点叫什么（图层里显示）：取的名字 > 文字的内容 > 功能块的名字 > 类型 */
export function nodeLabel(n: StudioNode, surface: StudioSurfaceDef): string {
  if (n.name) return n.name;
  if (n.type === 'text') return n.text.zh.slice(0, 16) || '文字';
  if (n.type === 'block') return surface.blocks[n.block]?.label ?? n.block;
  return { frame: '框', rect: '矩形', ellipse: '椭圆', image: '图片' }[n.type];
}

/** 这一块能不能挪、改大小（功能块按登记，锁住的都不行） */
export function geometryRules(n: StudioNode, surface: StudioSurfaceDef): { move: boolean; resize: StudioBlockDef['resize'] } {
  if (n.locked) return { move: false, resize: 'none' };
  if (n.type !== 'block') return { move: true, resize: 'free' };
  const b = surface.blocks[n.block];
  return { move: b?.move ?? false, resize: b?.resize ?? 'none' };
}

// ───────────────────────── 对齐线 ─────────────────────────

export interface Guide {
  axis: 'x' | 'y';
  /** 线在画布上的位置 */
  at: number;
}

/**
 * 挪动时贴齐：拿要挪的那一块（挪完以后的位置）的左中右、上中下，跟别的块与画布的边、中线比，近的（threshold 以内）吸过去。
 * 返回要再补的位移与画出来的线。
 */
export function snapBox(moving: Box, others: readonly Box[], canvas: { w: number; h: number }, threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [0, canvas.w / 2, canvas.w, ...others.flatMap((b) => [b.x, b.x + b.w / 2, b.x + b.w])];
  const ys = [0, canvas.h / 2, canvas.h, ...others.flatMap((b) => [b.y, b.y + b.h / 2, b.y + b.h])];
  const mine = (axis: 'x' | 'y') => (axis === 'x' ? [moving.x, moving.x + moving.w / 2, moving.x + moving.w] : [moving.y, moving.y + moving.h / 2, moving.y + moving.h]);
  const best = (axis: 'x' | 'y', targets: number[]) => {
    let pick: { d: number; at: number } | null = null;
    for (const m of mine(axis)) for (const t of targets) {
      const d = t - m;
      if (Math.abs(d) <= threshold && (!pick || Math.abs(d) < Math.abs(pick.d))) pick = { d, at: t };
    }
    return pick;
  };
  const bx = best('x', xs);
  const by = best('y', ys);
  const guides: Guide[] = [];
  if (bx) guides.push({ axis: 'x', at: bx.at });
  if (by) guides.push({ axis: 'y', at: by.at });
  return { dx: bx?.d ?? 0, dy: by?.d ?? 0, guides };
}

/** 四舍五入到 0.1 像素（存进版面里的数不要一长串小数） */
export const round1 = (v: number) => Math.round(v * 10) / 10;

// ───────────────────────── 新节点 ─────────────────────────

const base = (x: number, y: number, w: number, h: number) => ({ x: round1(x), y: round1(y), w: round1(w), h: round1(h), rotate: 0, opacity: 1, hidden: false, locked: false, name: '' });

export function makeText(x: number, y: number, zh = '双击右边改文字'): StudioNode {
  return { type: 'text', id: newId('t'), ...base(x, y, 320, 40), text: { zh, en: '' }, font: 'zh', size: 24, weight: 400, color: '$ink', align: 'left', valign: 'top', lineHeight: 1.4, letterSpacing: 0, italic: false, underline: false, fill: null };
}
export function makeRect(x: number, y: number): StudioNode {
  return { type: 'rect', id: newId('r'), ...base(x, y, 200, 120), fill: '$tan', stroke: null, strokeWidth: 0, radius: 8, shadow: 'none' };
}
export function makeEllipse(x: number, y: number): StudioNode {
  return { type: 'ellipse', id: newId('e'), ...base(x, y, 120, 120), fill: '$tan', stroke: null, strokeWidth: 0, radius: 0, shadow: 'none' };
}
export function makeFrame(x: number, y: number): StudioNode {
  return { type: 'frame', id: newId('f'), ...base(x, y, 320, 200), fill: '$modal', stroke: '$mute', strokeWidth: 1, radius: 12, shadow: 'sm', clip: true, children: [] };
}
/** 图片：按图的宽高比，最长边不超过 400 */
export function makeImage(x: number, y: number, asset: string, width: number | null, height: number | null): StudioNode {
  const w0 = width ?? 300;
  const h0 = height ?? 200;
  const k = Math.min(1, 400 / Math.max(w0, h0));
  return { type: 'image', id: newId('i'), ...base(x, y, w0 * k, h0 * k), asset, fit: 'cover', radius: 0, fill: null };
}
export function makeBlock(def: StudioBlockDef, x: number, y: number, at?: { x: number; y: number }): StudioNode {
  const props = Object.fromEntries(def.props.map((p) => [p.key, p.default]));
  const pos = at ?? { x, y };
  return { type: 'block', id: newId('b'), ...base(pos.x, pos.y, def.size.w, def.size.h), name: def.label, block: def.key, props };
}
