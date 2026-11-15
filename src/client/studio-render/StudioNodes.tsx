// UI 工作台的渲染器（8.1.1，docs/WORKBENCH_V811.md 第 4 节）：一屏的节点 → 页面。编辑器的画布和平板上走的是这同一段代码，所见即所得。
//
// 节点按设计稿的像素绝对定位（外面的舞台负责整页缩放）。功能块由界面自己给怎么画（ctx.blocks：真实的组件、带逻辑），
// 这里只把它摆到节点的位置上。
//
// 点按：装饰（框、矩形、椭圆、文字、图片）一律不接点按，点下去落到下面那一层（起始页上点哪里都开始点餐）；
// 功能块的外框也不接点按，只有块里面自己的按钮接——外框的空白处照旧点到下面，与没有外框时一样（默认版面逐屏一致）。

import type { CSSProperties, ReactNode } from 'react';
import { colorValue, SHADOW_CSS, type StudioBlockNode, type StudioNode, type StudioSurfaceDef } from '@shared/studio';

export interface StudioRenderCtx {
  surface: StudioSurfaceDef;
  lang: 'zh' | 'en';
  /** 素材的地址 */
  assetUrl: (id: string) => string;
  /** 功能块怎么画：内容摆在块的左上角（块的位置、大小外面已经摆好）；没给的不画 */
  blocks: Partial<Record<string, (node: StudioBlockNode) => ReactNode>>;
  /** 编辑器的画布：每个节点带 data-studio-node（选中、量尺寸用） */
  editor?: boolean;
}

const fontOf = (font: 'zh' | 'en') => (font === 'en' ? 'var(--em-en)' : 'var(--em-zh)');

function frameStyle(n: StudioNode): CSSProperties {
  const style: CSSProperties = { position: 'absolute', left: n.x, top: n.y, width: n.w, height: n.h, pointerEvents: 'none' };
  if (n.opacity < 1) style.opacity = n.opacity;
  if (n.rotate) style.transform = `rotate(${n.rotate}deg)`;
  return style;
}

function boxStyle(n: Extract<StudioNode, { type: 'rect' | 'ellipse' | 'frame' }>, color: (c: string | null) => string | undefined): CSSProperties {
  return {
    background: color(n.fill),
    border: n.stroke && n.strokeWidth > 0 ? `${n.strokeWidth}px solid ${color(n.stroke)}` : undefined,
    borderRadius: n.type === 'ellipse' ? '50%' : n.radius || undefined,
    boxShadow: SHADOW_CSS[n.shadow],
    boxSizing: 'border-box',
  };
}

/** 一个节点 */
function NodeView({ node: n, ctx }: { node: StudioNode; ctx: StudioRenderCtx }) {
  const color = (c: string | null) => colorValue(c, ctx.surface.cssVar);
  const tag = ctx.editor ? { 'data-studio-node': n.id } : {};
  switch (n.type) {
    case 'block': {
      const draw = ctx.blocks[n.block];
      return (
        <div style={frameStyle(n)} data-studio-block={n.block} {...tag}>
          {/* 块自己的按钮照旧能点：点按属性往下继承，外框本身不接 */}
          <div style={{ display: 'contents', pointerEvents: 'auto' }}>{draw ? draw(n) : null}</div>
        </div>
      );
    }
    case 'rect':
    case 'ellipse':
      return <div style={{ ...frameStyle(n), ...boxStyle(n, color) }} {...tag} />;
    case 'frame':
      return (
        <div style={{ ...frameStyle(n), ...boxStyle(n, color), overflow: n.clip ? 'hidden' : undefined }} {...tag}>
          <StudioNodes nodes={n.children} ctx={ctx} />
        </div>
      );
    case 'image':
      return (
        <div style={{ ...frameStyle(n), background: color(n.fill), borderRadius: n.radius || undefined, overflow: 'hidden' }} {...tag}>
          <img src={ctx.assetUrl(n.asset)} alt="" draggable={false} style={{ display: 'block', width: '100%', height: '100%', objectFit: n.fit }} />
        </div>
      );
    case 'text': {
      const text = ctx.lang === 'en' && n.text.en.trim() ? n.text.en : n.text.zh;
      return (
        <div
          style={{
            ...frameStyle(n),
            display: 'flex',
            flexDirection: 'column',
            justifyContent: n.valign === 'middle' ? 'center' : n.valign === 'bottom' ? 'flex-end' : 'flex-start',
            background: color(n.fill),
            color: color(n.color),
            fontFamily: fontOf(n.font),
            fontSize: n.size,
            fontWeight: n.weight,
            fontStyle: n.italic ? 'italic' : undefined,
            textDecoration: n.underline ? 'underline' : undefined,
            lineHeight: `${n.size * n.lineHeight}px`,
            letterSpacing: `${n.letterSpacing}em`,
            textAlign: n.align,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            overflow: 'hidden',
          }}
          {...tag}
        >
          <span data-studio-text>{text}</span>
        </div>
      );
    }
  }
}

/**
 * 一屏的节点（后面的盖在前面的上面）。layer：content 只画普通的一层，top 只画要盖在弹窗上面的功能块（起始页的「中 | EN」），
 * 不给画全部。隐藏的节点不画。
 */
export function StudioNodes({ nodes, ctx, layer }: { nodes: readonly StudioNode[]; ctx: StudioRenderCtx; layer?: 'content' | 'top' }) {
  const isTop = (n: StudioNode) => n.type === 'block' && ctx.surface.blocks[n.block]?.layer === 'top';
  return (
    <>
      {nodes.map((n) => {
        if (n.hidden) return null;
        if (layer === 'content' && isTop(n)) return null;
        if (layer === 'top' && !isTop(n)) return null;
        return <NodeView key={n.id} node={n} ctx={ctx} />;
      })}
    </>
  );
}

/** 等比缩放的块：现在是默认大小的几倍 */
export function blockScale(node: StudioBlockNode, surface: StudioSurfaceDef): number {
  const def = surface.blocks[node.block];
  return def && def.size.w > 0 ? node.w / def.size.w : 1;
}
