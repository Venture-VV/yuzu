// UI 工作台的渲染器（8.1.1 起，docs/WORKBENCH_V811.md 第 4 节）：一屏的节点 → 页面。编辑器的画布、平板、员工食堂走的是这同一段代码，
// 所见即所得（小程序是微信原生写法，由小程序线照 docs/STUDIO_MP.md 另写一份，样例截图就是这里画的）。
//
// 节点按设计稿的像素绝对定位（外面的舞台负责整页缩放）；在自动排列（横排、竖排）的框或屏里按先后排，宽高照尺寸规则
// （固定 / 撑满 / 跟内容）。功能块由界面自己给怎么画（ctx.blocks：真实的组件、带逻辑），这里只把它摆到节点的位置上。
//
// 点按：装饰（框、矩形、椭圆、文字、图片）一律不接点按，点下去落到下面那一层（起始页上点哪里都开始点餐）；
// 功能块的外框也不接点按，只有块里面自己的按钮接——外框的空白处照旧点到下面，与没有外框时一样（默认版面逐屏一致）。
// 设了「点了做什么」的按钮、框、图片（8.1.2，手机界面）接点按，交给 ctx.onAction；编辑器里不给 onAction，点一下是选中。

import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';
// 只从不带 zod 的几个文件取（员工食堂只画版面，不带上 zod；核对在服务端、编辑器里做）
import { colorValue, isFlow, SHADOW_CSS, STUDIO_LIMITS } from '@shared/studio/core';
import { instanceView } from '@shared/studio/components';
import type { StudioAction, StudioBlockNode, StudioDoc, StudioLayout, StudioNode, StudioScreen } from '@shared/studio/format';
import type { StudioSurfaceDef } from '@shared/studio/surfaces';

export interface StudioRenderCtx {
  surface: StudioSurfaceDef;
  lang: 'zh' | 'en';
  /** 素材的地址 */
  assetUrl: (id: string) => string;
  /** 功能块怎么画：内容摆在块的左上角（块的位置、大小外面已经摆好）；没给的不画 */
  blocks: Partial<Record<string, (node: StudioBlockNode) => ReactNode>>;
  /** 编辑器的画布：每个节点带 data-studio-node（选中、量尺寸用） */
  editor?: boolean;
  /** 数据字段的值（没给用界面登记的样例：编辑器、样例截图） */
  data?: (field: string, lang: 'zh' | 'en') => string | null;
  /** 点了做什么（编辑器里不给：点一下是选中） */
  onAction?: (action: StudioAction) => void;
  /** 版面里的组件（8.1.2）：实例照它画 */
  components?: StudioDoc['components'];
  /** 实例套了几层（防止组件里又放了自己：核对拦着，这里再兜一下） */
  depth?: number;
}

type Flow = StudioLayout | null;

const fontOf = (ctx: StudioRenderCtx, font: 'zh' | 'en') => `var(${font === 'en' ? ctx.surface.fontVars.en : ctx.surface.fontVars.zh})`;

const ALIGN: Record<StudioLayout['align'], CSSProperties['alignItems']> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
const JUSTIFY: Record<StudioLayout['justify'], CSSProperties['justifyContent']> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' };

/** 自动排列的容器（框、屏）怎么排 */
export function flowContainerStyle(layout: StudioLayout): CSSProperties {
  const [t, r, b, l] = layout.padding;
  return {
    display: 'flex',
    flexDirection: layout.mode === 'row' ? 'row' : 'column',
    flexWrap: layout.wrap ? 'wrap' : 'nowrap',
    gap: layout.gap || undefined,
    padding: t || r || b || l ? `${t}px ${r}px ${b}px ${l}px` : undefined,
    alignItems: ALIGN[layout.align],
    justifyContent: JUSTIFY[layout.justify],
    boxSizing: 'border-box',
  };
}

/**
 * 一个节点放在哪、多大：自由摆放按 x / y / w / h（8.1.1 原样，平板菜单一个字不改）；
 * 自动排列里按先后排，宽高照尺寸规则：固定用 w / h，撑满在排的方向上分剩下的、另一个方向拉满，跟内容不写（由里面的内容撑开）。
 */
function placeStyle(n: StudioNode, flow: Flow): CSSProperties {
  const style: CSSProperties = flow
    ? (() => {
        const sz = n.sizing ?? { w: 'fixed', h: 'fixed' };
        const row = flow.mode === 'row';
        const s: CSSProperties = { position: 'relative', flex: 'none', boxSizing: 'border-box' };
        const main = row ? sz.w : sz.h;
        const cross = row ? sz.h : sz.w;
        if (main === 'fixed') s[row ? 'width' : 'height'] = row ? n.w : n.h;
        else if (main === 'fill') {
          s.flex = '1 1 0';
          s[row ? 'minWidth' : 'minHeight'] = 0;
        }
        if (cross === 'fixed') s[row ? 'height' : 'width'] = row ? n.h : n.w;
        else if (cross === 'fill') s.alignSelf = 'stretch';
        return s;
      })()
    : { position: 'absolute', left: n.x, top: n.y, width: n.w, height: n.h };
  style.pointerEvents = 'none';
  if (n.opacity < 1) style.opacity = n.opacity;
  if (n.rotate) style.transform = `rotate(${n.rotate}deg)`;
  return style;
}

function boxStyle(n: Extract<StudioNode, { type: 'rect' | 'ellipse' | 'frame' | 'button' }>, color: (c: string | null) => string | undefined): CSSProperties {
  return {
    background: color(n.fill),
    border: n.stroke && n.strokeWidth > 0 ? `${n.strokeWidth}px solid ${color(n.stroke)}` : undefined,
    borderRadius: n.type === 'ellipse' ? '50%' : n.radius || undefined,
    boxShadow: SHADOW_CSS[n.shadow],
    boxSizing: 'border-box',
  };
}

/** 字的样子（文字、按钮、数据字段） */
function textStyle(n: Extract<StudioNode, { type: 'text' | 'button' | 'field' }>, ctx: StudioRenderCtx, color: (c: string | null) => string | undefined): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: n.valign === 'middle' ? 'center' : n.valign === 'bottom' ? 'flex-end' : 'flex-start',
    color: color(n.color),
    fontFamily: fontOf(ctx, n.font),
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
  };
}

const pick = (t: { zh: string; en: string }, lang: 'zh' | 'en') => (lang === 'en' && t.en.trim() ? t.en : t.zh);

/** 数据字段现在显示什么：给了数据用数据，没给用界面登记的样例 */
function fieldText(ctx: StudioRenderCtx, field: string): string {
  const v = ctx.data?.(field, ctx.lang);
  if (v !== undefined && v !== null) return v;
  const def = ctx.surface.fields.find((f) => f.key === field);
  return def ? pick(def.sample, ctx.lang) : '';
}

/** 能点的（设了动作、而且这里接点按：不是编辑器） */
function tapProps(action: StudioAction | undefined, ctx: StudioRenderCtx, testId: string): { style: CSSProperties; props: Record<string, unknown> } {
  if (!action || !ctx.onAction) return { style: {}, props: {} };
  const run = ctx.onAction;
  return {
    style: { pointerEvents: 'auto', cursor: 'pointer' },
    props: {
      role: 'button',
      tabIndex: 0,
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        run(action);
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          run(action);
        }
      },
      'data-testid': testId,
    },
  };
}

/** 一个节点 */
function NodeView({ node: n, ctx, flow }: { node: StudioNode; ctx: StudioRenderCtx; flow: Flow }) {
  const color = (c: string | null) => colorValue(c, ctx.surface.cssVar);
  const tag = ctx.editor ? { 'data-studio-node': n.id } : {};
  const place = placeStyle(n, flow);
  switch (n.type) {
    case 'block': {
      const draw = ctx.blocks[n.block];
      const content = draw ? draw(n) : null;
      // 自动排列里这一块这会儿什么都没有：不占位置，也不多一个间隔（编辑器里照样画，好选中）
      if (flow && content === null && !ctx.editor) return null;
      // 员工食堂的一段（flowContents）：里面的几样各自直接排进去，与原来的页面一模一样
      if (flow && !ctx.editor && ctx.surface.blocks[n.block]?.flowContents) return <>{content}</>;
      return (
        <div style={place} data-studio-block={n.block} {...tag}>
          {/* 块自己的按钮照旧能点：点按属性往下继承，外框本身不接 */}
          <div style={{ display: 'contents', pointerEvents: 'auto' }}>{content}</div>
        </div>
      );
    }
    case 'rect':
    case 'ellipse':
      return <div style={{ ...place, ...boxStyle(n, color) }} {...tag} />;
    case 'frame': {
      const inner = n.layout && isFlow(n.layout) ? n.layout : null;
      const tap = tapProps(n.action, ctx, `studio-tap-${n.id}`);
      return (
        <div style={{ ...place, ...boxStyle(n, color), overflow: n.clip ? 'hidden' : undefined, ...(inner ? flowContainerStyle(inner) : {}), ...tap.style }} {...tap.props} {...tag}>
          <StudioNodes nodes={n.children} ctx={ctx} flow={inner} />
        </div>
      );
    }
    case 'image': {
      const tap = tapProps(n.action, ctx, `studio-tap-${n.id}`);
      return (
        // 平板菜单的图片一律直角（8.1.8，品牌部）：圆角不生效
        <div style={{ ...place, background: color(n.fill), borderRadius: ctx.surface.squareImages ? undefined : n.radius || undefined, overflow: 'hidden', ...tap.style }} {...tap.props} {...tag}>
          <img src={ctx.assetUrl(n.asset)} alt="" draggable={false} style={{ display: 'block', width: '100%', height: '100%', objectFit: n.fit }} />
        </div>
      );
    }
    case 'text':
      return (
        <div style={{ ...place, ...textStyle(n, ctx, color), background: color(n.fill) }} {...tag}>
          <span data-studio-text>{pick(n.text, ctx.lang)}</span>
        </div>
      );
    case 'field':
      return (
        <div style={{ ...place, ...textStyle(n, ctx, color), background: color(n.fill) }} data-studio-field={n.field} {...tag}>
          <span data-studio-text>
            {pick(n.prefix, ctx.lang)}
            {fieldText(ctx, n.field)}
            {pick(n.suffix, ctx.lang)}
          </span>
        </div>
      );
    case 'instance': {
      // 组件的实例（8.1.2）：照组件画，位置、大小、转角、藏不藏用实例的；编号用实例的（编辑器按它量、选中）
      const master = ctx.components?.[n.component]?.node;
      if (!master || (ctx.depth ?? 0) >= STUDIO_LIMITS.depth) return null;
      return <NodeView node={instanceView(n, master)} ctx={{ ...ctx, depth: (ctx.depth ?? 0) + 1 }} flow={flow} />;
    }
    case 'button': {
      const tap = tapProps(n.action, ctx, `studio-tap-${n.id}`);
      return (
        <div style={{ ...place, ...boxStyle(n, color), ...textStyle(n, ctx, color), paddingLeft: 12, paddingRight: 12, ...tap.style }} {...tap.props} {...tag}>
          <span data-studio-text>{pick(n.text, ctx.lang)}</span>
        </div>
      );
    }
  }
}

/**
 * 一列节点（后面的盖在前面的上面；自动排列里按先后排）。layer：content 只画普通的一层，top 只画要盖在弹窗上面的功能块
 * （起始页的「中 | EN」），不给画全部。隐藏的节点不画。flow：这一列所在的容器在自动排列（不给：自由摆放）。
 */
export function StudioNodes({ nodes, ctx, layer, flow = null }: { nodes: readonly StudioNode[]; ctx: StudioRenderCtx; layer?: 'content' | 'top'; flow?: Flow }) {
  const isTop = (n: StudioNode) => n.type === 'block' && ctx.surface.blocks[n.block]?.layer === 'top';
  return (
    <>
      {nodes.map((n) => {
        if (n.hidden) return null;
        if (layer === 'content' && isTop(n)) return null;
        if (layer === 'top' && !isTop(n)) return null;
        return <NodeView key={n.id} node={n} ctx={ctx} flow={flow} />;
      })}
    </>
  );
}

/**
 * 手机界面的一整屏（员工食堂、小程序的样例、编辑器的画布）：375 宽，底色、自动排列照版面；自由摆放时高是这一屏的高，
 * 自动排列时至少这么高、内容多了往下长。
 */
export function StudioPhoneScreen({ screen, ctx, background, testId }: { screen: StudioScreen; ctx: StudioRenderCtx; background?: string | null; testId?: string }) {
  const flow = screen.layout && isFlow(screen.layout) ? screen.layout : null;
  const height = screen.height ?? ctx.surface.size.h;
  return (
    <div
      style={{
        position: 'relative',
        width: ctx.surface.size.w,
        ...(flow ? { minHeight: height, ...flowContainerStyle(flow) } : { height, overflow: 'hidden' }),
        background: colorValue(background ?? screen.background, ctx.surface.cssVar),
        fontFamily: fontOf(ctx, 'zh'),
        color: colorValue(ctx.surface.tokens.text, ctx.surface.cssVar),
      }}
      data-testid={testId}
    >
      <StudioNodes nodes={screen.nodes} ctx={ctx} flow={flow} />
    </div>
  );
}

/**
 * 撑满外面宽度的一屏（员工食堂：手机多宽就多宽，外壳管左右留白、底色、字体）：自动排列照版面；
 * 自由摆放时高是这一屏的高。
 */
export function StudioFillScreen({ screen, ctx, testId }: { screen: StudioScreen; ctx: StudioRenderCtx; testId?: string }) {
  const flow = screen.layout && isFlow(screen.layout) ? screen.layout : null;
  return (
    <div
      style={{ position: 'relative', ...(flow ? flowContainerStyle(flow) : { height: screen.height ?? ctx.surface.size.h }), background: colorValue(screen.background, ctx.surface.cssVar) }}
      data-testid={testId}
    >
      <StudioNodes nodes={screen.nodes} ctx={ctx} flow={flow} />
    </div>
  );
}

/** 等比缩放的块：现在是默认大小的几倍 */
export function blockScale(node: StudioBlockNode, surface: StudioSurfaceDef): number {
  const def = surface.blocks[node.block];
  return def && def.size.w > 0 ? node.w / def.size.w : 1;
}
