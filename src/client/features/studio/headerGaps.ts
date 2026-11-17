// 工作台里顶栏的间距（8.1.6，docs/EMENU.md 第 15.8 节，QZ9）：从左到右每两块之间、两头到屏幕边各多远，
// 以及在右边「间距」里改一个数时哪几块怎么挪。只有算术，方便单测。
//
// 改哪一个只动那一条间距：分类那一块是排开分类页签的范围，由它来收放——
//   · 分类左边的间距（左页边、字标↔分类）：从这条间距到分类之间的几块一起挪，分类的左边跟着收放；
//   · 分类右边的间距（分类↔中英切换 … 订单↔手牌、右页边）：右边一组靠右边贴住——从分类到这条间距之间的几块一起挪，
//     分类的右边跟着收放；这条间距右边的不动。
// 别的间距都不变。分类那一块最窄 120（放得下分类页签），再窄就不改、告诉设计师。

import type { Box } from './model';

export interface HeaderGap {
  /** 第几条（0 是左页边，最后一条是右页边） */
  index: number;
  /** 左右是哪两块（页边那一头是 null） */
  left: string | null;
  right: string | null;
  value: number;
}

/** 分类那一块最窄多少 */
export const CATS_MIN_W = 120;

/** 从左到右排好的几块（按框的中心） */
export function headerOrder(boxes: ReadonlyMap<string, Box>): string[] {
  return [...boxes.entries()].sort((a, b) => a[1].x + a[1].w / 2 - (b[1].x + b[1].w / 2)).map(([k]) => k);
}

/** 每一条间距：左页边、每两块之间、右页边（canvasW 是屏宽 1024） */
export function headerGaps(boxes: ReadonlyMap<string, Box>, canvasW = 1024): HeaderGap[] {
  const order = headerOrder(boxes);
  const out: HeaderGap[] = [];
  for (let i = 0; i <= order.length; i++) {
    const l = i > 0 ? order[i - 1]! : null;
    const r = i < order.length ? order[i]! : null;
    const from = l ? boxes.get(l)!.x + boxes.get(l)!.w : 0;
    const to = r ? boxes.get(r)!.x : canvasW;
    out.push({ index: i, left: l, right: r, value: to - from });
  }
  return out;
}

/** 改一条间距要挪的：各块往右挪多少（dx），分类那一块的左边、宽各变多少 */
export interface GapEdit {
  moves: { key: string; dx: number }[];
  cats: { dx: number; dw: number } | null;
}

/**
 * 把第 index 条间距改成 value。cats 是分类那一块的名字；返回 null 表示改不了（分类那一块会窄过 CATS_MIN_W，或找不到分类）
 */
export function editHeaderGap(boxes: ReadonlyMap<string, Box>, index: number, value: number, cats = 'cats', canvasW = 1024): GapEdit | null {
  const gaps = headerGaps(boxes, canvasW);
  const g = gaps[index];
  const order = headerOrder(boxes);
  const c = order.indexOf(cats);
  if (!g || c < 0) return null;
  // 挪的量取到 0.1（位置都存到 0.1）：挪动的几块与分类那一边一起挪同样的量，别的间距一点不变
  const delta = Math.round((value - g.value) * 10) / 10;
  if (Math.abs(delta) < 1e-9) return { moves: [], cats: null };
  const catsBox = boxes.get(cats)!;
  if (index <= c) {
    // 分类左边的间距：这条间距右边、分类左边的几块往右挪 delta，分类的左边也往右挪 delta（右边不动）
    if (catsBox.w - delta < CATS_MIN_W) return null;
    return { moves: order.slice(index, c).map((key) => ({ key, dx: delta })), cats: { dx: delta, dw: -delta } };
  }
  // 分类右边的间距：分类右边、这条间距左边的几块往左挪 delta，分类的右边也往左收 delta
  if (catsBox.w - delta < CATS_MIN_W) return null;
  return { moves: order.slice(c + 1, index).map((key) => ({ key, dx: -delta })), cats: { dx: 0, dw: -delta } };
}

/** 拖着一块时它左右两边的间距（画间距线用）：左边是离它最近的、在它左边的那一块（没有就是屏幕左边），右边同理 */
export function neighborGaps(
  boxes: ReadonlyMap<string, Box>,
  key: string,
  canvasW = 1024,
): { left: { from: number; to: number; with: string | null }; right: { from: number; to: number; with: string | null } } | null {
  const me = boxes.get(key);
  if (!me) return null;
  let left: { from: number; to: number; with: string | null } = { from: 0, to: me.x, with: null };
  let right: { from: number; to: number; with: string | null } = { from: me.x + me.w, to: canvasW, with: null };
  for (const [k, b] of boxes) {
    if (k === key) continue;
    const end = b.x + b.w;
    if (b.x + b.w / 2 <= me.x + me.w / 2) {
      if (end > left.from) left = { from: end, to: me.x, with: k };
    } else if (b.x < right.to) right = { from: me.x + me.w, to: b.x, with: k };
  }
  return { left, right };
}
