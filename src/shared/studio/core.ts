// UI 工作台版面格式里不依赖 zod 的那一部分（8.1.2 从 format.ts 分出来）：格式版本、上限、投影、遍历节点、颜色。
// 渲染器、员工食堂只画版面，用这里的与 surfaces.ts、components.ts，不用带上 zod（核对在服务端、编辑器里做）；
// format.ts 照旧把这些都导出，别处原来怎么取还怎么取。

import type { StudioColor, StudioFrameNode, StudioLayout, StudioNode } from './format';

/** 格式版本：以后改格式加一，写升级函数（upgradeStudioDoc），旧版面自动升上来 */
export const STUDIO_SCHEMA = 1;

/** 一屏最多几个节点（连同框里的）、一份版面最多几个、框最多套几层、整份最大多少字节、最多几个组件、组件展开以后最多几个节点 */
export const STUDIO_LIMITS = { nodesPerScreen: 300, nodesPerDoc: 1500, depth: 6, bytes: 512 * 1024, text: 2000, components: 100, expanded: 3000 } as const;

/** 投影：几档，不让写任意的 CSS */
export const SHADOWS = ['none', 'sm', 'md', 'lg'] as const;
export const SHADOW_CSS: Record<(typeof SHADOWS)[number], string | undefined> = {
  none: undefined,
  sm: '0 1px 3px rgb(0 0 0 / 0.12)',
  md: '0 4px 14px rgb(0 0 0 / 0.16)',
  lg: '0 12px 32px rgb(0 0 0 / 0.22)',
};

/** 遍历一屏里所有的节点（连同框里的），depth 从 1 算 */
export function walkNodes(nodes: readonly StudioNode[], fn: (node: StudioNode, depth: number, parent: StudioFrameNode | null) => void, depth = 1, parent: StudioFrameNode | null = null): void {
  for (const n of nodes) {
    fn(n, depth, parent);
    if (n.type === 'frame') walkNodes(n.children, fn, depth + 1, n);
  }
}

/** 这一层是不是自动排列（横排、竖排）：里面的节点不看 x / y */
export const isFlow = (layout: StudioLayout | undefined): boolean => !!layout && layout.mode !== 'free';

/** 颜色写成页面上用的值：主题色换成 CSS 变量（平板菜单的 $ink → var(--em-ink)），hex 原样 */
export function colorValue(c: StudioColor | null | undefined, tokenVar: (key: string) => string): string | undefined {
  if (!c) return undefined;
  return c.startsWith('$') ? tokenVar(c.slice(1)) : c;
}
