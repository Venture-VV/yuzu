// UI 工作台编辑器的版面操作（8.1.1，docs/WORKBENCH_V811.md 第 1、2 节）：找节点、改、删、加、调前后、复制、点中哪一块、对齐线。
// 都是纯函数：拿一份版面、返回新的一份（不改原来的），撤销、重做存的就是这一份一份。

import {
  componentUses,
  isFlow,
  STUDIO_LIMITS,
  walkNodes,
  type StudioBlockDef,
  type StudioDoc,
  type StudioFieldDef,
  type StudioFrameNode,
  type StudioLayout,
  type StudioNode,
  type StudioScreen,
  type StudioSurfaceDef,
} from '@shared/studio';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clone = <T>(v: T): T => (typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T));

/** 新节点的编号：随机 8 位 */
export function newId(prefix = 'n'): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

/**
 * 组件（8.1.2）在编辑器里当成一屏来改：屏的名字是「@组件编号」，这一屏只有一个节点——组件本身；
 * 改它用的是改屏的那一套（选中、拖动、属性、插入到框里），写回到 doc.components。
 */
export const COMPONENT_SCREEN = '@';
export const isComponentScreen = (screen: string) => screen.startsWith(COMPONENT_SCREEN);
export const componentScreen = (cid: string) => `${COMPONENT_SCREEN}${cid}`;
export const componentIdOf = (screen: string) => (isComponentScreen(screen) ? screen.slice(COMPONENT_SCREEN.length) : null);

export function screenOf(doc: StudioDoc, screen: string): StudioScreen {
  const cid = componentIdOf(screen);
  if (cid) {
    const c = doc.components?.[cid];
    return { background: null, nodes: c ? [c.node] : [] };
  }
  return doc.screens[screen] ?? { background: null, nodes: [] };
}

interface Found {
  node: StudioNode;
  /** 所在的那一列（屏的或框的 children） */
  list: StudioNode[];
  index: number;
  parent: StudioFrameNode | null;
  /** 框的左上角在画布上的位置（框里的节点按它摆；上面有自动排列的这个数不准，见 inFlow） */
  offset: { x: number; y: number };
  /** 管它排的那一层（所在的框或屏）在自动排列：不看 x / y，挪不动，按先后排 */
  flow: StudioLayout | null;
  /** 它或上面任何一层在自动排列：画布上的位置要量（按 x / y 算不准） */
  inFlow: boolean;
}

function findIn(list: StudioNode[], id: string, parent: StudioFrameNode | null, offset: { x: number; y: number }, flow: StudioLayout | null, inFlow: boolean): Found | null {
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    if (n.id === id) return { node: n, list, index: i, parent, offset, flow, inFlow };
    if (n.type === 'frame') {
      const inner = n.layout && isFlow(n.layout) ? n.layout : null;
      const r = findIn(n.children, id, n, { x: offset.x + n.x, y: offset.y + n.y }, inner, inFlow || !!inner);
      if (r) return r;
    }
  }
  return null;
}

const screenFlow = (s: StudioScreen): StudioLayout | null => (s.layout && isFlow(s.layout) ? s.layout : null);

export function findNode(doc: StudioDoc, screen: string, id: string): Found | null {
  const s = screenOf(doc, screen);
  const flow = screenFlow(s);
  return findIn(s.nodes, id, null, { x: 0, y: 0 }, flow, !!flow);
}

/** 节点在画布上的位置（框里的加上框的位置）。在自动排列里的按 x / y 算不准：返回空，由画布去量 */
export function absBox(doc: StudioDoc, screen: string, id: string): Box | null {
  const f = findNode(doc, screen, id);
  if (!f || f.inFlow) return null;
  return { x: f.offset.x + f.node.x, y: f.offset.y + f.node.y, w: f.node.w, h: f.node.h };
}

/** 改一屏（返回新的一份版面） */
export function withScreen(doc: StudioDoc, screen: string, fn: (s: StudioScreen) => void): StudioDoc {
  const next = clone(doc);
  const cid = componentIdOf(screen);
  if (cid) {
    // 组件：改完写回去；组件本身不会被删掉、外面也加不了第二块（只认第一块）
    const c = next.components?.[cid];
    if (!c) return doc;
    const s: StudioScreen = { background: null, nodes: [c.node] };
    fn(s);
    if (s.nodes[0]) c.node = s.nodes[0];
    return next;
  }
  const s = next.screens[screen] ?? (next.screens[screen] = { background: null, nodes: [] });
  fn(s);
  return next;
}

/** 改一个节点 */
export function updateNode(doc: StudioDoc, screen: string, id: string, patch: Partial<StudioNode> | ((n: StudioNode) => StudioNode)): StudioDoc {
  return withScreen(doc, screen, (s) => {
    const f = findIn(s.nodes, id, null, { x: 0, y: 0 }, null, false);
    if (!f) return;
    f.list[f.index] = typeof patch === 'function' ? patch(f.node) : ({ ...f.node, ...patch } as StudioNode);
  });
}

/** 一次改好几个节点（拖动时一起挪） */
export function updateNodes(doc: StudioDoc, screen: string, patches: Record<string, Partial<StudioNode>>): StudioDoc {
  return withScreen(doc, screen, (s) => {
    for (const [id, patch] of Object.entries(patches)) {
      const f = findIn(s.nodes, id, null, { x: 0, y: 0 }, null, false);
      if (f) f.list[f.index] = { ...f.node, ...patch } as StudioNode;
    }
  });
}

export function removeNodes(doc: StudioDoc, screen: string, ids: readonly string[]): StudioDoc {
  return withScreen(doc, screen, (s) => {
    const drop = (list: StudioNode[]): StudioNode[] => list.filter((n) => !ids.includes(n.id)).map((n) => (n.type === 'frame' ? { ...n, children: drop(n.children) } : n));
    s.nodes = drop(s.nodes);
  });
}

/** 加到这一屏最上面（或给的位置）；给了 into（一个框的编号）就加到那个框里最后面 */
export function insertNode(doc: StudioDoc, screen: string, node: StudioNode, index?: number, into?: string): StudioDoc {
  return withScreen(doc, screen, (s) => {
    if (into) {
      const f = findIn(s.nodes, into, null, { x: 0, y: 0 }, null, false);
      if (f && f.node.type === 'frame') {
        f.list[f.index] = { ...f.node, children: [...f.node.children, node] };
        return;
      }
    }
    if (index === undefined || index < 0 || index > s.nodes.length) s.nodes.push(node);
    else s.nodes.splice(index, 0, node);
  });
}

/** 移出框：放到框的后面一个（同一层），自由摆放时位置换算成外面那一层的 */
export function moveOutOfFrame(doc: StudioDoc, screen: string, id: string): StudioDoc {
  return withScreen(doc, screen, (s) => {
    const f = findIn(s.nodes, id, null, { x: 0, y: 0 }, null, false);
    if (!f || !f.parent) return;
    const frame = f.parent;
    const outer = findIn(s.nodes, frame.id, null, { x: 0, y: 0 }, null, false);
    if (!outer) return;
    const moved = { ...f.node, x: round1(frame.x + f.node.x), y: round1(frame.y + f.node.y) } as StudioNode;
    outer.list[outer.index] = { ...frame, children: frame.children.filter((c) => c.id !== id) };
    outer.list.splice(outer.index + 1, 0, moved);
  });
}

/** 调前后：在同一列里往上（盖住别的）、往下、到最上、到最下 */
export function moveLayer(doc: StudioDoc, screen: string, id: string, dir: 'up' | 'down' | 'top' | 'bottom'): StudioDoc {
  return withScreen(doc, screen, (s) => {
    const f = findIn(s.nodes, id, null, { x: 0, y: 0 }, null, false);
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
      const f = findIn(s.nodes, id, null, { x: 0, y: 0 }, null, false);
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

/**
 * 点中的是哪一块：从最上面往下找（框里的先看里面），隐藏的、锁住的跳过。boxOf 给每一块在画布上的位置
 * （自由摆放的按 x / y 算，自动排列里的由画布量出来）。
 */
export function hitTest(nodes: readonly StudioNode[], x: number, y: number, boxOf: (id: string) => Box | null): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (n.hidden) continue;
    if (n.type === 'frame') {
      const inner = hitTest(n.children, x, y, boxOf);
      if (inner) return inner;
    }
    const b = boxOf(n.id);
    if (b && !n.locked && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return n.id;
  }
  return null;
}

/** 节点叫什么（图层里显示）：取的名字 > 文字的内容 > 功能块的名字 > 类型 */
export function nodeLabel(n: StudioNode, surface: StudioSurfaceDef, doc?: StudioDoc): string {
  if (n.name) return n.name;
  if (n.type === 'instance') return doc?.components?.[n.component]?.name ?? '组件';
  if (n.type === 'text') return n.text.zh.slice(0, 16) || '文字';
  if (n.type === 'block') return surface.blocks[n.block]?.label ?? n.block;
  if (n.type === 'button') return n.text.zh.slice(0, 16) || '按钮';
  if (n.type === 'field') return surface.fields.find((f) => f.key === n.field)?.label ?? n.field;
  return { frame: '框', rect: '矩形', ellipse: '椭圆', image: '图片' }[n.type];
}

/**
 * 这一块能不能挪、改大小（功能块按登记，锁住的都不行）。在自动排列里（flow）不能拖着挪——按先后排，
 * 用方向键或图层里的上下换位置；改大小可以（改了的那一边变成「固定」）。
 */
export function geometryRules(n: StudioNode, surface: StudioSurfaceDef, flow: StudioLayout | null = null): { move: boolean; resize: StudioBlockDef['resize'] } {
  if (n.locked) return { move: false, resize: 'none' };
  if (n.type !== 'block') return { move: !flow, resize: 'free' };
  const b = surface.blocks[n.block];
  return { move: !flow && (b?.move ?? false), resize: b?.resize ?? 'none' };
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
    for (const m of mine(axis))
      for (const t of targets) {
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

/** 新节点用的主题色（平板菜单：深棕字、浅棕块……；手机界面各自登记） */
type Tokens = StudioSurfaceDef['tokens'];
const EMENU_TOKENS: Tokens = { text: '$ink', fill: '$tan', panel: '$modal', line: '$mute', button: '$ink' };

export function makeText(x: number, y: number, zh = '双击右边改文字', t: Tokens = EMENU_TOKENS, size = 24): StudioNode {
  return {
    type: 'text',
    id: newId('t'),
    ...base(x, y, 320, 40),
    text: { zh, en: '' },
    font: 'zh',
    size,
    weight: 400,
    color: t.text,
    align: 'left',
    valign: 'top',
    lineHeight: 1.4,
    letterSpacing: 0,
    italic: false,
    underline: false,
    fill: null,
  };
}
export function makeRect(x: number, y: number, t: Tokens = EMENU_TOKENS): StudioNode {
  return { type: 'rect', id: newId('r'), ...base(x, y, 200, 120), fill: t.fill, stroke: null, strokeWidth: 0, radius: 8, shadow: 'none' };
}
export function makeEllipse(x: number, y: number, t: Tokens = EMENU_TOKENS): StudioNode {
  return { type: 'ellipse', id: newId('e'), ...base(x, y, 120, 120), fill: t.fill, stroke: null, strokeWidth: 0, radius: 0, shadow: 'none' };
}
export function makeFrame(x: number, y: number, t: Tokens = EMENU_TOKENS, layout?: StudioLayout['mode']): StudioNode {
  const frame: StudioFrameNode = { type: 'frame', id: newId('f'), ...base(x, y, 320, 200), fill: t.panel, stroke: t.line, strokeWidth: 1, radius: 12, shadow: 'sm', clip: true, children: [] };
  if (layout && layout !== 'free') frame.layout = { mode: layout, wrap: false, gap: 8, padding: [12, 12, 12, 12], align: layout === 'column' ? 'stretch' : 'center', justify: 'start' };
  return frame;
}
/** 按钮：一行字，点了做什么在右边选 */
export function makeButton(x: number, y: number, t: Tokens = EMENU_TOKENS, zh = '按钮'): StudioNode {
  return {
    type: 'button',
    id: newId('u'),
    ...base(x, y, 160, 44),
    fill: t.button,
    stroke: null,
    strokeWidth: 0,
    radius: 8,
    shadow: 'none',
    text: { zh, en: '' },
    font: 'zh',
    size: 15,
    weight: 600,
    color: '#FFFFFF',
    align: 'center',
    valign: 'middle',
    lineHeight: 1.4,
    letterSpacing: 0.04,
    italic: false,
    underline: false,
  };
}
/** 数据字段：显示界面登记的一项数据 */
export function makeField(x: number, y: number, field: StudioFieldDef, t: Tokens = EMENU_TOKENS): StudioNode {
  return {
    type: 'field',
    id: newId('d'),
    ...base(x, y, 240, 24),
    name: field.label,
    field: field.key,
    prefix: { zh: '', en: '' },
    suffix: { zh: '', en: '' },
    font: 'zh',
    size: 15,
    weight: 400,
    color: t.text,
    align: 'left',
    valign: 'top',
    lineHeight: 1.4,
    letterSpacing: 0,
    italic: false,
    underline: false,
    fill: null,
  };
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

/**
 * 放进自动排列（屏或框）的新节点：大小照手机上常用的——文字、字段、框宽撑满、高跟内容；按钮、图片、形状固定大小；
 * 功能块照登记。自由摆放的不动。
 */
export function sizeForFlow(n: StudioNode, flow: StudioLayout | null, surface: StudioSurfaceDef): StudioNode {
  if (!flow) return n;
  const row = flow.mode === 'row';
  if (n.type === 'block') return { ...n, sizing: surface.blocks[n.block]?.sizing ?? { w: 'fill', h: 'hug' } };
  if (n.type === 'text' || n.type === 'field') return { ...n, sizing: row ? { w: 'hug', h: 'hug' } : { w: 'fill', h: 'hug' } };
  if (n.type === 'frame') return { ...n, sizing: row ? { w: 'fill', h: 'hug' } : { w: 'fill', h: n.layout && n.layout.mode !== 'free' ? 'hug' : 'fixed' } };
  return { ...n, sizing: { w: 'fixed', h: 'fixed' } };
}

// ───────────────────────── 组件（8.1.2） ─────────────────────────

/** 一块连同里面的都换上新编号（复制、拆开组件时用，免得与原来的撞） */
export function reid<T extends StudioNode>(n: T): T {
  const copy = { ...n, id: newId(n.type.slice(0, 1)) } as T;
  if (copy.type === 'frame') return { ...copy, children: copy.children.map(reid) } as T;
  return copy;
}

/**
 * 存成组件：选中的这一块（框连着里面的）变成组件，原来的位置换成它的实例（编号、位置、大小不变）。
 * 组件本身放在画布中间（改组件时看得清）；里面的编号沿用（只在这个组件里）。功能块、实例不能存。
 */
export function makeComponentFrom(doc: StudioDoc, screen: string, id: string, surface: StudioSurfaceDef, measured?: Box): { doc: StudioDoc; cid: string } | null {
  const f = findNode(doc, screen, id);
  if (!f || f.node.type === 'block' || f.node.type === 'instance' || isComponentScreen(screen)) return null;
  let hasBlock = false;
  walkNodes([f.node], (n) => n.type === 'block' && (hasBlock = true));
  if (hasBlock) return null;
  const cid = newId('c');
  // 自动排列里撑满、跟内容的边，版面里的宽高不准：组件用画布上量到的大小
  const sz = f.node.sizing;
  const w = round1(measured && (f.flow ? sz?.w !== undefined && sz.w !== 'fixed' : false) ? measured.w : f.node.w || measured?.w || 0);
  const h = round1(measured && (f.flow ? sz?.h !== undefined && sz.h !== 'fixed' : false) ? measured.h : f.node.h || measured?.h || 0);
  const master = { ...clone(f.node), w, h, x: round1(Math.max(0, (surface.size.w - w) / 2)), y: round1(Math.max(0, Math.min(200, (surface.size.h - h) / 2))) } as StudioNode;
  const name = (f.node.name || nodeLabel(f.node, surface)).slice(0, 40) || '组件';
  const inst: StudioNode = {
    type: 'instance',
    id: f.node.id,
    name: f.node.name,
    x: f.node.x,
    y: f.node.y,
    w: f.node.w,
    h: f.node.h,
    rotate: f.node.rotate,
    opacity: 1,
    hidden: f.node.hidden,
    locked: false,
    component: cid,
    ...(f.node.sizing ? { sizing: f.node.sizing } : {}),
  };
  const withComp: StudioDoc = { ...doc, components: { ...doc.components, [cid]: { name, node: master } } };
  return { doc: updateNode(withComp, screen, id, () => inst), cid };
}

/** 放一个组件的实例（大小照组件） */
export function makeInstance(doc: StudioDoc, cid: string, x: number, y: number): StudioNode | null {
  const c = doc.components?.[cid];
  if (!c) return null;
  return { type: 'instance', id: newId('i'), name: '', x: round1(x), y: round1(y), w: c.node.w, h: c.node.h, rotate: 0, opacity: 1, hidden: false, locked: false, component: cid };
}

/** 拆开：实例换成组件的一份副本（新编号、实例的位置大小），之后各改各的 */
export function detachInstance(doc: StudioDoc, screen: string, id: string): StudioDoc {
  const f = findNode(doc, screen, id);
  if (!f || f.node.type !== 'instance') return doc;
  const c = doc.components?.[f.node.component];
  if (!c) return doc;
  const inst = f.node;
  // 最外面那一块沿用实例的编号（选中不丢），里面的换新编号
  const copy = { ...reid(clone(c.node)), id: inst.id } as StudioNode;
  const placed = {
    ...copy,
    x: inst.x,
    y: inst.y,
    w: inst.w,
    h: inst.h,
    rotate: inst.rotate,
    opacity: Math.round(inst.opacity * copy.opacity * 1000) / 1000,
    hidden: inst.hidden,
    name: inst.name || c.name,
  } as StudioNode;
  if (inst.sizing) placed.sizing = inst.sizing;
  else delete placed.sizing;
  return updateNode(doc, screen, id, () => placed);
}

/** 组件改名 */
export function renameComponent(doc: StudioDoc, cid: string, name: string): StudioDoc {
  const c = doc.components?.[cid];
  if (!c) return doc;
  return { ...doc, components: { ...doc.components, [cid]: { ...c, name: name.slice(0, 40) } } };
}

/** 删掉组件：只删没人用的（还在用的先拆开或删掉那几处） */
export function deleteComponent(doc: StudioDoc, cid: string): StudioDoc {
  if (!doc.components?.[cid] || componentUses(doc, cid) > 0) return doc;
  const all = { ...doc.components };
  delete all[cid];
  const next: StudioDoc = { ...doc, components: all };
  if (!Object.keys(all).length) delete next.components;
  return next;
}

/**
 * 拖动、拉大小时把改动合并到每一帧最多一次（8.1.6，QZ4）：144 Hz 的平板上手指一秒报一两百次位置，每次都整张画布重画会卡。
 * push 记下最新的一份、下一帧交出去；松手时 flush 马上交出还没交的那一份（再记撤销）。
 */
export function frameBatcher<T>(deliver: (v: T) => void) {
  let latest: { v: T } | null = null;
  let raf = 0;
  const run = () => {
    raf = 0;
    const got = latest;
    latest = null;
    if (got) deliver(got.v);
  };
  return {
    push(v: T) {
      latest = { v };
      if (!raf) raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
    },
    flush() {
      if (raf) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        else clearTimeout(raf);
      }
      run();
    },
  };
}
