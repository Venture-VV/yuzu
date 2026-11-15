// UI 工作台的版面格式（8.1.1，docs/WORKBENCH_V811.md 第 3 节）。前后端共用：编辑器、平板、服务端读的都是这一份。
//
// 一份版面 = 一个界面（如平板电子菜单）的主题 + 每一屏的一列节点。节点按设计稿的像素摆（平板菜单是 1024×768），
// 后面的盖在前面的上面。节点只有几种：框、矩形、椭圆、文字、图片，以及「功能块」——各界面在代码里登记的、带逻辑的那几块
// （菜单页、顶栏、语言切换……），设计师改它们放在哪、多大、长什么样，不改它们做什么。
//
// 安全：版面里没有 HTML、CSS、脚本字符串；颜色只能是 #rrggbb(aa) 或主题色（$ink）；图片只能引用素材库里的图（按内容的摘要）；
// 功能块只能从界面登记的清单里选，属性按登记的格式核对。所以版面改得再乱也只是难看，不会注入脚本、不会把数据发到别处、
// 不会绕过下单逻辑。服务端存之前按这里的格式核对一遍，平板读到不认识的属性就忽略（新编辑器配旧平板也不白屏）。

import { z } from 'zod';

/** 格式版本：以后改格式加一，写升级函数（upgradeStudioDoc），旧版面自动升上来 */
export const STUDIO_SCHEMA = 1;

/** 一屏最多几个节点（连同框里的）、一份版面最多几个、框最多套几层、整份最大多少字节 */
export const STUDIO_LIMITS = { nodesPerScreen: 300, nodesPerDoc: 1500, depth: 6, bytes: 512 * 1024, text: 2000 } as const;

/** 颜色：#rrggbb、#rrggbbaa，或者主题色（$ink） */
export const ColorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|\$[a-z][a-zA-Z0-9]{0,23})$/, '颜色写成 #RRGGBB 或主题色');
export type StudioColor = z.infer<typeof ColorSchema>;

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, '节点编号只能是字母、数字、- 与 _');

/** 投影：几档，不让写任意的 CSS */
export const SHADOWS = ['none', 'sm', 'md', 'lg'] as const;
export const SHADOW_CSS: Record<(typeof SHADOWS)[number], string | undefined> = {
  none: undefined,
  sm: '0 1px 3px rgb(0 0 0 / 0.12)',
  md: '0 4px 14px rgb(0 0 0 / 0.16)',
  lg: '0 12px 32px rgb(0 0 0 / 0.22)',
};

const Base = {
  id: Id,
  name: z.string().max(40).default(''),
  x: num(-4096, 8192),
  y: num(-4096, 8192),
  w: num(0, 8192),
  h: num(0, 8192),
  rotate: num(-360, 360).default(0),
  opacity: num(0, 1).default(1),
  hidden: z.boolean().default(false),
  locked: z.boolean().default(false),
};

const Box = {
  fill: ColorSchema.nullable().default(null),
  stroke: ColorSchema.nullable().default(null),
  strokeWidth: num(0, 40).default(0),
  radius: num(0, 4096).default(0),
  shadow: z.enum(SHADOWS).default('none'),
};

/** 文字的字体：zh / en 是主题里的中文、英文字体 */
export const TEXT_FONTS = ['zh', 'en'] as const;
export const TextSchema = z.object({
  type: z.literal('text'),
  ...Base,
  text: z.object({ zh: z.string().max(STUDIO_LIMITS.text), en: z.string().max(STUDIO_LIMITS.text).default('') }),
  font: z.enum(TEXT_FONTS).default('zh'),
  size: num(4, 400).default(16),
  weight: z.union([z.literal(300), z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(900)]).default(400),
  color: ColorSchema.default('$ink'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  valign: z.enum(['top', 'middle', 'bottom']).default('top'),
  /** 行高：字号的几倍 */
  lineHeight: num(0.5, 4).default(1.4),
  /** 字距：字号的几分之一（em） */
  letterSpacing: num(-0.5, 2).default(0),
  italic: z.boolean().default(false),
  underline: z.boolean().default(false),
  fill: ColorSchema.nullable().default(null),
});

export const RectSchema = z.object({ type: z.literal('rect'), ...Base, ...Box });
export const EllipseSchema = z.object({ type: z.literal('ellipse'), ...Base, ...Box });

/** 图片：素材库里的图（素材的编号是图片内容的 SHA-256） */
export const ImageSchema = z.object({
  type: z.literal('image'),
  ...Base,
  asset: z.string().regex(/^[0-9a-f]{64}$/, '图片要从素材库里选'),
  fit: z.enum(['cover', 'contain', 'fill']).default('cover'),
  radius: num(0, 4096).default(0),
  fill: ColorSchema.nullable().default(null),
});

/** 功能块的属性：只能是简单的值，按界面登记的格式再核对 */
export const BlockPropValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
export const BlockSchema = z.object({
  type: z.literal('block'),
  ...Base,
  block: z.string().regex(/^[a-z][a-zA-Z0-9.]{0,47}$/, '功能块的名字不对'),
  props: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/), BlockPropValue).default({}),
});

export type StudioTextNode = z.infer<typeof TextSchema>;
export type StudioRectNode = z.infer<typeof RectSchema>;
export type StudioEllipseNode = z.infer<typeof EllipseSchema>;
export type StudioImageNode = z.infer<typeof ImageSchema>;
export type StudioBlockNode = z.infer<typeof BlockSchema>;
export type StudioFrameNode = z.infer<typeof BaseFrameSchema> & { children: StudioNode[] };
export type StudioNode = StudioTextNode | StudioRectNode | StudioEllipseNode | StudioImageNode | StudioBlockNode | StudioFrameNode;
export type StudioNodeType = StudioNode['type'];

/** 框：里面的节点按框的左上角摆；clip 时超出的部分不显示 */
const BaseFrameSchema = z.object({ type: z.literal('frame'), ...Base, ...Box, clip: z.boolean().default(false) });
export const NodeSchema: z.ZodType<StudioNode> = z.lazy(() =>
  z.discriminatedUnion('type', [TextSchema, RectSchema, EllipseSchema, ImageSchema, BlockSchema, BaseFrameSchema.extend({ children: z.array(NodeSchema).max(STUDIO_LIMITS.nodesPerScreen) })]),
) as z.ZodType<StudioNode>;

export const ScreenSchema = z.object({
  /** 这一屏的底色（null：用界面自己的底） */
  background: ColorSchema.nullable().default(null),
  nodes: z.array(NodeSchema).max(STUDIO_LIMITS.nodesPerScreen),
});
export type StudioScreen = z.infer<typeof ScreenSchema>;

export const ThemeSchema = z.object({
  /** 主题色：键按界面登记（平板菜单是 ink、mute、tan……），值是 #rrggbb(aa) */
  colors: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,23}$/), z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, '主题色写成 #RRGGBB')),
  /** 中文、英文字体：从界面登记的几种里选 */
  fonts: z.object({ zh: z.string().max(40), en: z.string().max(40) }),
});
export type StudioTheme = z.infer<typeof ThemeSchema>;

export const STUDIO_SURFACES = ['emenu'] as const;
export type StudioSurface = (typeof STUDIO_SURFACES)[number];
export const STUDIO_SURFACE_LABELS: Record<StudioSurface, string> = { emenu: '平板电子菜单' };

export const DocSchema = z.object({
  schema: z.literal(STUDIO_SCHEMA),
  surface: z.enum(STUDIO_SURFACES),
  theme: ThemeSchema,
  screens: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,23}$/), ScreenSchema),
});
export type StudioDoc = z.infer<typeof DocSchema>;

/** 旧格式的版面升到现在的格式（现在只有第 1 版：原样返回）；认不出的抛错 */
export function upgradeStudioDoc(raw: unknown): unknown {
  const v = (raw as { schema?: unknown } | null)?.schema;
  if (v === STUDIO_SCHEMA) return raw;
  throw new Error(`版面格式第 ${String(v)} 版认不出来`);
}

/** 遍历一屏里所有的节点（连同框里的），depth 从 1 算 */
export function walkNodes(nodes: readonly StudioNode[], fn: (node: StudioNode, depth: number, parent: StudioFrameNode | null) => void, depth = 1, parent: StudioFrameNode | null = null): void {
  for (const n of nodes) {
    fn(n, depth, parent);
    if (n.type === 'frame') walkNodes(n.children, fn, depth + 1, n);
  }
}

/** 一份版面里用到的素材（按出现的先后，不重复） */
export function docAssets(doc: StudioDoc): string[] {
  const out = new Set<string>();
  for (const s of Object.values(doc.screens)) walkNodes(s.nodes, (n) => n.type === 'image' && out.add(n.asset));
  return [...out];
}

/** 颜色写成页面上用的值：主题色换成 CSS 变量（平板菜单的 $ink → var(--em-ink)），hex 原样 */
export function colorValue(c: StudioColor | null | undefined, tokenVar: (key: string) => string): string | undefined {
  if (!c) return undefined;
  return c.startsWith('$') ? tokenVar(c.slice(1)) : c;
}
