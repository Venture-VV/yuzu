// UI 工作台的组件（8.1.2，docs/WORKBENCH_V811.md 第 13 节）：设计师把一块（框连着里面的也行）存成组件，屏上放它的实例；
// 改了组件，各处的实例一起变。组件存在版面里（doc.components），跟着版面发布、回滚、导出。
//   · instanceView：实例画出来是什么——组件的样子 + 实例自己的位置、大小、转角、藏不藏、尺寸规则（透明度相乘）；
//   · expandInstances：把实例都换成组件的样子（编号加上实例的前缀，不重复），给只认普通节点的地方用（小程序线）；
//   · componentCycles：组件里又放了它自己（直接或间接）的，画不出来，核对拦下。

import { STUDIO_LIMITS, walkNodes } from './core';
import type { StudioDoc, StudioInstanceNode, StudioNode } from './format';

/** 实例画出来是什么：组件的样子换上实例的位置、大小、转角、藏不藏、尺寸规则；编号用实例的 */
export function instanceView(inst: StudioInstanceNode, master: StudioNode): StudioNode {
  const v = {
    ...master,
    id: inst.id,
    name: inst.name || master.name,
    x: inst.x,
    y: inst.y,
    w: inst.w,
    h: inst.h,
    rotate: inst.rotate,
    opacity: Math.round(inst.opacity * master.opacity * 1000) / 1000,
    hidden: inst.hidden,
    locked: inst.locked,
  } as StudioNode;
  if (inst.sizing) v.sizing = inst.sizing;
  else delete v.sizing;
  return v;
}

/** 组件里（连同框里的）放了哪些组件的实例 */
function usedIn(node: StudioNode): Set<string> {
  const out = new Set<string>();
  walkNodes([node], (n) => n.type === 'instance' && out.add(n.component));
  return out;
}

/** 在环里的组件（组件里又放了它自己，直接或间接） */
export function componentCycles(doc: StudioDoc): string[] {
  const comps = doc.components ?? {};
  const edges = new Map(Object.entries(comps).map(([id, c]) => [id, usedIn(c.node)]));
  const bad = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (path.includes(id)) {
      for (const x of path.slice(path.indexOf(id))) bad.add(x);
      return;
    }
    for (const next of edges.get(id) ?? []) if (edges.has(next)) visit(next, [...path, id]);
  };
  for (const id of edges.keys()) visit(id, []);
  return [...bad];
}

/** 这个组件在版面里放了几处（屏上的、别的组件里的都算） */
export function componentUses(doc: StudioDoc, cid: string): number {
  let n = 0;
  const count = (nodes: readonly StudioNode[]) => walkNodes(nodes, (x) => x.type === 'instance' && x.component === cid && (n += 1));
  for (const s of Object.values(doc.screens)) count(s.nodes);
  for (const [id, c] of Object.entries(doc.components ?? {})) if (id !== cid) count([c.node]);
  return n;
}

/** 一列节点里的实例都换成组件的样子（里面的编号前面加「实例编号__」，不会重）；找不到组件、套太深的不画 */
function expandList(doc: StudioDoc, nodes: readonly StudioNode[], prefix: string, depth: number): StudioNode[] {
  const out: StudioNode[] = [];
  for (const n of nodes) {
    let v: StudioNode = n;
    if (n.type === 'instance') {
      const c = doc.components?.[n.component];
      if (!c || depth > STUDIO_LIMITS.depth) continue;
      const view = instanceView(n, c.node);
      // 组件本身是另一个组件的实例：接着展开那一个（位置、大小已经是这个实例的）
      if (view.type === 'instance') {
        out.push(...expandList(doc, [view], prefix, depth + 1));
        continue;
      }
      // 组件里面的编号：加上这个实例的前缀
      v = { ...view, id: prefix + n.id };
      if (view.type === 'frame') v = { ...view, id: prefix + n.id, children: expandList(doc, view.children, `${prefix}${n.id}__`, depth + 1) };
      out.push(v);
      continue;
    }
    if (prefix) v = { ...v, id: prefix + n.id };
    if (v.type === 'frame') v = { ...v, children: expandList(doc, v.children, prefix, depth + 1) };
    out.push(v);
  }
  return out;
}

/** 把版面里的实例都换成组件的样子、去掉 components（给只认普通节点的地方：小程序线的读取函数） */
export function expandInstances(doc: StudioDoc): StudioDoc {
  if (!doc.components) return doc;
  const screens = Object.fromEntries(Object.entries(doc.screens).map(([k, s]) => [k, { ...s, nodes: expandList(doc, s.nodes, '', 1) }]));
  const next: StudioDoc = { ...doc, screens };
  delete next.components;
  return next;
}

/** 展开以后一共几个节点（组件放得多、套得深时会很多：核对按它拦） */
export function expandedCount(doc: StudioDoc): number {
  if (!doc.components) return Object.values(doc.screens).reduce((t, s) => t + countAll(s.nodes), 0);
  return Object.values(expandInstances(doc).screens).reduce((t, s) => t + countAll(s.nodes), 0);
}

function countAll(nodes: readonly StudioNode[]): number {
  let n = 0;
  walkNodes(nodes, () => (n += 1));
  return n;
}
