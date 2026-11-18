// UI 工作台的版面格式（8.1.1 起，docs/WORKBENCH_V811.md 第 3 节；小程序线照这一份写渲染组件，说明见 docs/STUDIO_MP.md）。
// 前后端共用：编辑器、平板、员工食堂、小程序、服务端读的都是这一份。
//
// 一份版面 = 一个界面（如平板电子菜单）的主题 + 每一屏的一列节点。节点按设计稿的像素摆（平板菜单是 1024×768，手机是 375 宽），
// 后面的盖在前面的上面。节点只有几种：框、矩形、椭圆、文字、图片、按钮、数据字段，以及「功能块」——各界面在代码里登记的、
// 带逻辑的那几块（菜单页、顶栏、语言切换……），设计师改它们放在哪、多大、长什么样，不改它们做什么。
//
// 8.1.2 加的（都是可选项，没写的照 8.1.1 的样子，旧版面一字不改照样能读）：
//   · 自动排列（layout）：框、屏可以「横排 / 竖排」（可换行），里面的节点按顺序排、不看 x / y；间距、内边距、对齐；
//   · 尺寸规则（sizing）：在自动排列里，宽、高可以「固定 / 撑满 / 跟内容」；
//   · 按钮（button）与点了做什么（action，只能从界面登记的动作里选）；数据字段（field，只能从界面登记的字段里选）；
//   · 屏的高度（height）：手机界面会往下滚，一屏多高由设计师定。
//
// 安全：版面里没有 HTML、CSS、脚本字符串；颜色只能是 #rrggbb(aa) 或主题色（$ink）；图片只能引用素材库里的图（按内容的摘要）；
// 功能块只能从界面登记的清单里选，属性按登记的格式核对。所以版面改得再乱也只是难看，不会注入脚本、不会把数据发到别处、
// 不会绕过下单逻辑。服务端存之前按这里的格式核对一遍，平板读到不认识的属性就忽略（新编辑器配旧平板也不白屏）。

import { z } from 'zod';
import { SHADOWS, STUDIO_LIMITS, STUDIO_SCHEMA, walkNodes } from './core';

// 不依赖 zod 的常数与小工具（格式版本、上限、投影、遍历、颜色）在 core.ts：员工食堂等只画版面的地方不用带上 zod；这里照旧都能取到
export { colorValue, isFlow, SHADOWS, STUDIO_LIMITS, walkNodes } from './core';

/** 颜色：#rrggbb、#rrggbbaa，或者主题色（$ink） */
export const ColorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|\$[a-z][a-zA-Z0-9]{0,23})$/, '颜色写成 #RRGGBB 或主题色');
export type StudioColor = z.infer<typeof ColorSchema>;

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, '节点编号只能是字母、数字、- 与 _');

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
  /** 在自动排列的框（或屏）里：宽、高「固定 / 撑满 / 跟内容」（没写是两个都固定；自由摆放时不看这一项） */
  sizing: z.object({ w: z.enum(['fixed', 'fill', 'hug']).default('fixed'), h: z.enum(['fixed', 'fill', 'hug']).default('fixed') }).optional(),
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
/** 中英两份的文字（英文没填时显示中文） */
const Bilingual = (max: number) => z.object({ zh: z.string().max(max), en: z.string().max(max).default('') });
/** 字的样子：文字、按钮、数据字段共用 */
const TextStyle = {
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
};
export const TextSchema = z.object({ type: z.literal('text'), ...Base, text: Bilingual(STUDIO_LIMITS.text), ...TextStyle, fill: ColorSchema.nullable().default(null) });

/** 点了做什么：只能是界面登记的动作（打开哪一页、拨打门店电话……），arg 按登记核对 */
export const ActionSchema = z.object({ action: z.string().regex(/^[a-z][a-zA-Z0-9.]{0,47}$/, '动作的名字不对'), arg: z.string().max(80).default('') });
export type StudioAction = z.infer<typeof ActionSchema>;

/** 按钮：一个框里一行字，点了做登记的动作（没设动作的只是样子） */
export const ButtonSchema = z.object({
  type: z.literal('button'),
  ...Base,
  fill: ColorSchema.nullable().default('$ink'),
  stroke: ColorSchema.nullable().default(null),
  strokeWidth: num(0, 40).default(0),
  radius: num(0, 4096).default(8),
  shadow: z.enum(SHADOWS).default('none'),
  text: Bilingual(80),
  ...TextStyle,
  align: z.enum(['left', 'center', 'right']).default('center'),
  valign: z.enum(['top', 'middle', 'bottom']).default('middle'),
  action: ActionSchema.optional(),
});

/** 数据字段：显示界面登记的一项数据（门店名、营业时间、会员等级……），前后可以加字 */
export const FieldSchema = z.object({
  type: z.literal('field'),
  ...Base,
  field: z.string().regex(/^[a-z][a-zA-Z0-9.]{0,47}$/, '字段的名字不对'),
  prefix: Bilingual(40).default({ zh: '', en: '' }),
  suffix: Bilingual(40).default({ zh: '', en: '' }),
  ...TextStyle,
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
  action: ActionSchema.optional(),
});

/** 功能块的属性：只能是简单的值，按界面登记的格式再核对 */
/** 组件的编号（8.1.2）：c- 开头 */
export const ComponentId = z.string().regex(/^c-[a-z0-9]{4,20}$/, '组件编号不对');
/**
 * 组件的实例（8.1.2）：屏上放的一个组件。位置、大小、转角、藏不藏、尺寸规则是实例自己的（透明度与组件的相乘），
 * 长什么样跟着组件——改了组件，各处的实例一起变。
 */
export const InstanceSchema = z.object({ type: z.literal('instance'), ...Base, component: ComponentId });

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
export type StudioButtonNode = z.infer<typeof ButtonSchema>;
export type StudioFieldNode = z.infer<typeof FieldSchema>;
export type StudioFrameNode = z.infer<typeof BaseFrameSchema> & { children: StudioNode[] };
export type StudioInstanceNode = z.infer<typeof InstanceSchema>;
export type StudioNode = StudioTextNode | StudioRectNode | StudioEllipseNode | StudioImageNode | StudioBlockNode | StudioButtonNode | StudioFieldNode | StudioFrameNode | StudioInstanceNode;

/**
 * 自动排列（框、屏都可以有）：free 自由摆放（按 x / y，8.1.1 的样子）；row 横排、column 竖排——里面的节点按先后排，不看 x / y。
 * wrap：横排放不下时换行（网格用「换行 + 每个一样宽」表达，不用 CSS 网格，小程序也照着排得出来）。
 * padding 是上、右、下、左；align 是另一个方向上怎么对齐（stretch：撑满）；justify 是排的方向上怎么分（between：两头对齐、中间平分）。
 */
export const LayoutSchema = z.object({
  mode: z.enum(['free', 'row', 'column']).default('free'),
  wrap: z.boolean().default(false),
  gap: num(0, 400).default(0),
  padding: z.tuple([num(0, 400), num(0, 400), num(0, 400), num(0, 400)]).default([0, 0, 0, 0]),
  align: z.enum(['start', 'center', 'end', 'stretch']).default('start'),
  justify: z.enum(['start', 'center', 'end', 'between']).default('start'),
});
export type StudioLayout = z.infer<typeof LayoutSchema>;

/** 框：里面的节点按框的左上角摆（或按 layout 自动排）；clip 时超出的部分不显示；有 action 的框整块能点（卡片、入口） */
const BaseFrameSchema = z.object({ type: z.literal('frame'), ...Base, ...Box, clip: z.boolean().default(false), layout: LayoutSchema.optional(), action: ActionSchema.optional() });
export const NodeSchema: z.ZodType<StudioNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    TextSchema,
    RectSchema,
    EllipseSchema,
    ImageSchema,
    BlockSchema,
    ButtonSchema,
    FieldSchema,
    InstanceSchema,
    BaseFrameSchema.extend({ children: z.array(NodeSchema).max(STUDIO_LIMITS.nodesPerScreen) }),
  ]),
) as z.ZodType<StudioNode>;

/** 组件（8.1.2）：设计师存下来的一块（框连着里面的也行），屏上放它的实例；里面不能有功能块 */
export const ComponentSchema = z.object({ name: z.string().trim().min(1).max(40), node: NodeSchema });

export const ScreenSchema = z.object({
  /** 这一屏的底色（null：用界面自己的底） */
  background: ColorSchema.nullable().default(null),
  /** 这一屏多高（手机界面往下滚；没写用界面登记的高） */
  height: num(100, 20000).optional(),
  /** 整屏自动排列（手机界面常用竖排：一段一段往下排） */
  layout: LayoutSchema.optional(),
  nodes: z.array(NodeSchema).max(STUDIO_LIMITS.nodesPerScreen),
});
export type StudioScreen = z.infer<typeof ScreenSchema>;

export const ThemeSchema = z.object({
  /** 主题色：键按界面登记（平板菜单是 ink、mute、tan……），值是 #rrggbb(aa) */
  colors: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,23}$/), z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, '主题色写成 #RRGGBB')),
  /** 中文、英文字体：从界面登记的几种里选 */
  fonts: z.object({ zh: z.string().max(40), en: z.string().max(40) }),
});

export const STUDIO_SURFACES = ['emenu', 'mp', 'canteen'] as const;
export type StudioSurface = (typeof STUDIO_SURFACES)[number];
export const STUDIO_SURFACE_LABELS: Record<StudioSurface, string> = { emenu: '平板电子菜单', mp: '微信小程序', canteen: '员工食堂' };

/**
 * 卡片模板里一块在一档里的改动：只写改了的（没写的照登记的位置）。bottom 只给放大一档里「下沿贴线、往上长」的文字块
 * （照登记的那样往上长，挪的是下沿）；写了 y 的改成从上往下排。
 */
const SlotPatchSchema = z.object({ x: num(-2048, 4096).optional(), y: num(-2048, 4096).optional(), w: num(4, 4096).optional(), h: num(4, 4096).optional(), bottom: num(-2048, 4096).optional() });
/** 卡片模板里一块的改动（8.1.2，平板菜单的 11 种版式）：原样、放大两档各自的位置大小，藏起来，照片的圆角 */
export const SlotOverrideSchema = z.object({ design: SlotPatchSchema.optional(), big: SlotPatchSchema.optional(), hidden: z.boolean().optional(), radius: num(0, 400).optional() });
export type StudioSlotOverride = z.infer<typeof SlotOverrideSchema>;

/** 菜的三种状态（8.1.2，变体）：售罄、当前时段不可售、已下架——菜单页上照片、文字的样子 */
export const DISH_STATES = ['sold_out', 'closed', 'off'] as const;
export type StudioDishState = (typeof DISH_STATES)[number];
/** 照片上怎么写：居中两行（设计稿）、左上角小标签、只压暗不写字 */
export const DISH_STATE_STYLES = ['center', 'badge', 'dim'] as const;
/** 一种状态的样子：只存改过的项（没写的照设计稿） */
export const DishStateSchema = z.object({
  style: z.enum(DISH_STATE_STYLES).optional(),
  shade: ColorSchema.optional(),
  shadeOpacity: num(0, 0.9).optional(),
  textColor: ColorSchema.optional(),
  textOpacity: num(0.2, 1).optional(),
  grayscale: z.boolean().optional(),
});
export type StudioDishStateStyle = z.infer<typeof DishStateSchema>;

export const DocSchema = z.object({
  schema: z.literal(STUDIO_SCHEMA),
  surface: z.enum(STUDIO_SURFACES),
  theme: ThemeSchema,
  screens: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,23}$/), ScreenSchema),
  /** 卡片模板的改动（8.1.2）：templates[版式][块]，只存改过的；界面登记了模板的才有（平板菜单） */
  templates: z.record(z.string().regex(/^[a-z][a-z_]{0,23}$/), z.record(z.string().regex(/^[a-z0-9][a-z0-9.]{0,15}$/), SlotOverrideSchema)).optional(),
  /** 组件（8.1.2）：编号 → 名字与样子；屏上的实例按编号找 */
  components: z.record(ComponentId, ComponentSchema).optional(),
  /** 菜的几种状态的样子（8.1.2，变体）：只存改过的；与卡片模板一样只有平板菜单有 */
  dishStates: z.object({ sold_out: DishStateSchema.optional(), closed: DishStateSchema.optional(), off: DishStateSchema.optional() }).optional(),
});
export type StudioDoc = z.infer<typeof DocSchema>;

/** 旧格式的版面升到现在的格式（现在只有第 1 版：原样返回，只去掉不用的项）；认不出的抛错 */
export function upgradeStudioDoc(raw: unknown): unknown {
  const v = (raw as { schema?: unknown } | null)?.schema;
  if (v === STUDIO_SCHEMA) return dropRetiredKeys(raw);
  throw new Error(`版面格式第 ${String(v)} 版认不出来`);
}

/** 版面里存颜色的字段（ColorSchema 的几处）：主题色引用「$名字」只会出现在这些字段上 */
const COLOR_FIELDS = new Set(['fill', 'stroke', 'color', 'background', 'shade', 'textColor']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
/** 8.1.8 主题色 dot 的默认值，也是 8.1.9 起样式表里写死的小圆圈颜色（--em-dot） */
const RETIRED_DOT_DEFAULT = '#bf1d25';

/** 把颜色字段上的主题色引用 ref 换成颜色 to；没换到的原样返回（同一个对象） */
function swapColorRef(node: unknown, ref: string, to: string): unknown {
  if (Array.isArray(node)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < node.length; i++) {
      const next = swapColorRef(node[i], ref, to);
      if (next !== node[i]) (out ??= node.slice())[i] = next;
    }
    return out ?? node;
  }
  if (!node || typeof node !== 'object') return node;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(node)) {
    const next = COLOR_FIELDS.has(k) && v === ref ? to : swapColorRef(v, ref, to);
    if (next !== v) (out ??= { ...(node as Record<string, unknown>) })[k] = next;
  }
  return out ?? node;
}

/**
 * 去掉已经不用的项（读到就去掉，下次存的就没有了）：
 *   · 8.1.8 发布时平板菜单的主题色里有一项 dot（封面标题右下角小圆圈的颜色），8.1.9 起写死在样式表里——
 *     留着它，8.1.9 的核对不认（没有这个主题色），退回 8.1.7 时那边也不认（测试会话对 5fec3e3 的 P1，docs/EMENU.md 16.9）。
 *     8.1.8 的颜色选择器里也能选 dot（例如屏背景选了它）：去掉之前先把引用「$dot」的颜色字段换成当时存的颜色，
 *     不然 8.1.9 显示成样式表里的固定色、8.1.7 显示成透明（测试会话对 e2381e3 的 P2）。没有 dot 却还引用着的（8.1.9 候选读过又存的），
 *     换成 8.1.8 的默认色——与候选显示的一样。
 */
function dropRetiredKeys(raw: unknown): unknown {
  const d = raw as { surface?: unknown; theme?: { colors?: Record<string, unknown> } } | null;
  if (d?.surface !== 'emenu' || !d.theme || typeof d.theme !== 'object') return raw;
  const colors = d.theme.colors && typeof d.theme.colors === 'object' ? d.theme.colors : undefined;
  const hasDot = !!colors && 'dot' in colors;
  const saved = hasDot ? colors!.dot : undefined;
  const to = typeof saved === 'string' && HEX_COLOR.test(saved) ? saved : RETIRED_DOT_DEFAULT;
  const { theme, ...body } = d;
  const swapped = swapColorRef(body, '$dot', to);
  if (swapped === body && !hasDot) return raw;
  let nextTheme = theme;
  if (hasDot) {
    const { dot: _retired, ...rest } = colors!;
    nextTheme = { ...theme, colors: rest };
  }
  // 先摊开原来的，键的先后不变
  return { ...d, ...(swapped as object), theme: nextTheme };
}

/** 一份版面里用到的素材（按出现的先后，不重复；组件里的也算） */
export function docAssets(doc: StudioDoc): string[] {
  const out = new Set<string>();
  for (const s of Object.values(doc.screens)) walkNodes(s.nodes, (n) => n.type === 'image' && out.add(n.asset));
  for (const c of Object.values(doc.components ?? {})) walkNodes([c.node], (n) => n.type === 'image' && out.add(n.asset));
  return [...out];
}
