// UI 工作台的「界面」登记（8.1.1，docs/WORKBENCH_V811.md 第 3、7 节）：每个界面的设计尺寸、有哪几屏、主题色与字体、
// 能用哪些功能块（带逻辑的那几块：放在哪、多大、长什么样可以改，做什么不能改），以及代码里内置的默认版面。
// 8.1.1 只有平板电子菜单；8.1.2 加员工食堂与小程序（照同一个办法登记）。
//
// 默认版面 = 现在的样子：每一块的位置、大小都是现在页面上的那个数（emenu/EmenuPage.tsx、header.tsx），
// 平板没有发布过版面时就用它，升级以后客人看不出变化（GZ12，浏览器用例逐屏截图比对）。

import { STUDIO_SCHEMA, type StudioBlockNode, type StudioDoc, type StudioNode, type StudioSurface } from './format';

export interface StudioPropDef {
  key: string;
  label: string;
  kind: 'color' | 'number' | 'boolean' | 'select';
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly { value: string; label: string }[];
  /** 颜色可以选「自动」（值是 auto） */
  auto?: boolean;
}

export interface StudioBlockDef {
  key: string;
  label: string;
  hint: string;
  /** 能放在哪几屏 */
  screens: readonly string[];
  /** 默认大小（设计稿的像素） */
  size: { w: number; h: number };
  /** free：宽高随便改；scale：等比缩放（里面照设计稿画，整块放大缩小）；none：不能改大小 */
  resize: 'free' | 'scale' | 'none';
  /** 能不能挪 */
  move: boolean;
  /** 这一屏必须有（不能删、不能隐藏；检查里缺了是红的） */
  required?: boolean;
  /** 一屏只能有一个 */
  single?: boolean;
  /** 盖在弹窗上面：起始页的「中 | EN」在输入信息的弹窗开着时也要能点 */
  layer?: 'top';
  /** 能点的：缩得比默认小时提醒「客人可能点不准」 */
  tap?: boolean;
  props: readonly StudioPropDef[];
}

export interface StudioColorDef {
  key: string;
  label: string;
  default: string;
}
export interface StudioFontDef {
  key: string;
  label: string;
  /** CSS 的字体列表（平板菜单的都以行框字体 Em Box 打头：文字框的上沿照设计稿量的位置，见 emenu.css） */
  stack: string;
}

export interface StudioScreenDef {
  key: string;
  label: string;
  hint: string;
  /** 这一屏的底色默认值（null：用界面自己的底） */
  background: string | null;
}

export interface StudioSurfaceDef {
  key: StudioSurface;
  label: string;
  size: { w: number; h: number };
  screens: readonly StudioScreenDef[];
  colors: readonly StudioColorDef[];
  fonts: { zh: readonly StudioFontDef[]; en: readonly StudioFontDef[]; default: { zh: string; en: string } };
  blocks: Readonly<Record<string, StudioBlockDef>>;
  /** 主题色在页面上的 CSS 变量名（$ink → --em-ink） */
  cssVar: (token: string) => string;
}

const AUTO_COLOR = { kind: 'color', auto: true, default: 'auto' } as const;

/** 平板电子菜单（8.0.10 起，docs/EMENU.md）：1024×768，整页等比缩放到屏幕 */
export const EMENU_SURFACE: StudioSurfaceDef = {
  key: 'emenu',
  label: '平板电子菜单',
  size: { w: 1024, h: 768 },
  screens: [
    { key: 'start', label: '起始页', hint: '客人坐下看到的第一屏：点屏幕任何地方开始点餐（输入手牌、桌号、人数的弹窗照旧）', background: '$photo' },
    { key: 'menu', label: '菜单页', hint: '翻菜单、加菜：菜单页的分类、版面、菜品在后台「电子菜单」里维护；这里可以加装饰、改主题', background: null },
  ],
  colors: [
    { key: 'ink', label: '主文字（深棕）', default: '#4b392a' },
    { key: 'mute', label: '次要文字、细线', default: '#a59c95' },
    { key: 'tan', label: '强调（选中、按钮）', default: '#a6947a' },
    { key: 'bg', label: '页面底色', default: '#f4f3f2' },
    { key: 'modal', label: '弹窗底色', default: '#f7f8f8' },
    { key: 'band', label: '提示条底色', default: '#f8f7db' },
    { key: 'key', label: '数字键', default: '#f4f3f2' },
    { key: 'key2', label: '数字键（按下）', default: '#dbdbdb' },
    { key: 'photo', label: '图片占位、起始页底', default: '#d3d3d3' },
    { key: 'light', label: '浅色字（深底上）', default: '#efefef' },
    { key: 'error', label: '出错', default: '#a2412b' },
  ],
  fonts: {
    zh: [
      { key: 'fangsong', label: '朱雀仿宋（品牌字体，默认）', stack: "'Em Box Zh', 'Zhuque Fangsong', 'FangSong', 'STFangsong', 'Songti SC', 'Noto Serif CJK SC', serif" },
      { key: 'songti', label: '宋体（系统字体）', stack: "'Em Box Zh', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', serif" },
      { key: 'heiti', label: '黑体（系统字体）', stack: "'Em Box Zh', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif" },
    ],
    en: [
      { key: 'average', label: 'Average Sans（默认）', stack: "'Em Box En', 'Average Sans', 'Optima', 'Zhuque Fangsong', 'FangSong', 'STFangsong', sans-serif" },
      { key: 'serif', label: '衬线（系统字体）', stack: "'Em Box En', Georgia, 'Times New Roman', 'Zhuque Fangsong', serif" },
      { key: 'sans', label: '无衬线（系统字体）', stack: "'Em Box En', 'Helvetica Neue', Arial, 'PingFang SC', sans-serif" },
    ],
    default: { zh: 'fangsong', en: 'average' },
  },
  blocks: {
    'start.cover': {
      key: 'start.cover',
      label: '氛围大图',
      hint: '后台「电子菜单 → 设置」里传的起始页大图；没传时不显示',
      screens: ['start'],
      size: { w: 1024, h: 768 },
      resize: 'free',
      move: true,
      single: true,
      props: [
        { key: 'dim', label: '压暗', kind: 'number', min: 0, max: 0.8, step: 0.02, default: 0.18 },
        { key: 'kenburns', label: '慢慢放大缩小', kind: 'boolean', default: true },
      ],
    },
    'brand.logo': {
      key: 'brand.logo',
      label: '汤崎字标（竖排）',
      hint: '品牌字标，等比缩放',
      screens: ['start', 'menu'],
      size: { w: 78.64, h: 76.633 },
      resize: 'scale',
      move: true,
      props: [{ key: 'color', label: '颜色（自动：起始页有大图时浅色）', ...AUTO_COLOR }],
    },
    'brand.logoRow': {
      key: 'brand.logoRow',
      label: '汤崎字标（横排）',
      hint: '品牌字标，等比缩放',
      screens: ['start', 'menu'],
      size: { w: 79.81, h: 15.441 },
      resize: 'scale',
      move: true,
      props: [{ key: 'color', label: '颜色（自动：起始页有大图时浅色）', ...AUTO_COLOR }],
    },
    'start.pending': {
      key: 'start.pending',
      label: '待确认提示',
      hint: '有一单结果待确认时出现，提醒服务员处理',
      screens: ['start'],
      size: { w: 1024, h: 16 },
      resize: 'free',
      move: true,
      required: true,
      single: true,
      props: [
        { key: 'color', label: '颜色（自动：有大图时浅色）', ...AUTO_COLOR },
        { key: 'size', label: '字号', kind: 'number', min: 8, max: 40, step: 1, default: 12 },
      ],
    },
    'start.footer': {
      key: 'start.footer',
      label: '版权行（长按 3 秒退出平板）',
      hint: '文字在后台「电子菜单 → 设置」里改；员工长按 3 秒退出这台平板的登录，不能去掉',
      screens: ['start'],
      size: { w: 1024, h: 12 },
      resize: 'free',
      move: true,
      required: true,
      single: true,
      tap: true,
      props: [
        { key: 'color', label: '颜色（自动：有大图时浅色）', ...AUTO_COLOR },
        { key: 'size', label: '字号', kind: 'number', min: 8, max: 40, step: 1, default: 12 },
      ],
    },
    lang: {
      key: 'lang',
      label: '中 | EN 切换',
      hint: '后台关掉中英切换时不显示；输入信息的弹窗开着时也能点',
      screens: ['start'],
      size: { w: 48, h: 22.3 },
      resize: 'scale',
      move: true,
      single: true,
      layer: 'top',
      tap: true,
      props: [
        {
          key: 'tone',
          label: '深浅',
          kind: 'select',
          default: 'auto',
          options: [
            { value: 'auto', label: '自动（有大图时浅色）' },
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
          ],
        },
      ],
    },
    'menu.pages': {
      key: 'menu.pages',
      label: '菜单页',
      hint: '分类、版面、菜品在后台「电子菜单」里维护；8.1.1 位置不能改',
      screens: ['menu'],
      size: { w: 1024, h: 768 },
      resize: 'none',
      move: false,
      required: true,
      single: true,
      props: [],
    },
    'menu.header': {
      key: 'menu.header',
      label: '顶栏',
      hint: '字标、分类、中 | EN、搜索、订单、手牌；菜品详情也在顶栏下面打开。8.1.1 位置不能改，颜色跟主题',
      screens: ['menu'],
      size: { w: 1024, h: 102 },
      resize: 'none',
      move: false,
      required: true,
      single: true,
      props: [],
    },
    'menu.dots': {
      key: 'menu.dots',
      label: '翻页圆点',
      hint: '一个分类有几页就有几个点；圆点在这一块里居中',
      screens: ['menu'],
      size: { w: 1024, h: 14 },
      resize: 'free',
      move: true,
      single: true,
      tap: true,
      props: [],
    },
  },
  cssVar: (token) => `var(--em-${token === 'key2' ? 'key-2' : token})`,
};

export const STUDIO_SURFACE_DEFS: Record<StudioSurface, StudioSurfaceDef> = { emenu: EMENU_SURFACE };

/** 默认版面里的一块（位置、大小照现在的页面） */
const block = (id: string, key: string, name: string, x: number, y: number, w: number, h: number, props: StudioBlockNode['props'] = {}): StudioBlockNode => ({
  type: 'block',
  id,
  name,
  block: key,
  x,
  y,
  w,
  h,
  rotate: 0,
  opacity: 1,
  hidden: false,
  locked: false,
  props,
});

/** 代码里内置的默认版面（= 现在的样子）。每次调用返回新的一份 */
export function defaultStudioDoc(surface: StudioSurface): StudioDoc {
  const def = STUDIO_SURFACE_DEFS[surface];
  const colors = Object.fromEntries(def.colors.map((c) => [c.key, c.default]));
  const start: StudioNode[] = [
    block('start-cover', 'start.cover', '氛围大图', 0, 0, 1024, 768, { dim: 0.18, kenburns: true }),
    block('start-logo', 'brand.logo', '汤崎字标', 472.6, 342.8, 78.64, 76.633, { color: 'auto' }),
    block('start-pending', 'start.pending', '待确认提示', 0, 600, 1024, 16, { color: 'auto', size: 12 }),
    block('start-footer', 'start.footer', '版权行', 0, 715.2, 1024, 12, { color: 'auto', size: 12 }),
    block('start-lang', 'lang', '中 | EN', 936, 44.3, 48, 22.3, { tone: 'auto' }),
  ];
  const menu: StudioNode[] = [
    block('menu-pages', 'menu.pages', '菜单页', 0, 0, 1024, 768),
    block('menu-header', 'menu.header', '顶栏', 0, 0, 1024, 102),
    block('menu-dots', 'menu.dots', '翻页圆点', 0, 742, 1024, 14),
  ];
  return {
    schema: STUDIO_SCHEMA,
    surface,
    theme: { colors, fonts: { ...def.fonts.default } },
    screens: {
      start: { background: '$photo', nodes: start },
      menu: { background: null, nodes: menu },
    },
  };
}

/** 主题色、字体在页面上的 CSS 变量（只给和默认不一样的：默认版面在页面上一个变量都不多设） */
export function themeVars(doc: StudioDoc): Record<string, string> {
  const def = STUDIO_SURFACE_DEFS[doc.surface];
  const out: Record<string, string> = {};
  for (const c of def.colors) {
    const v = doc.theme.colors[c.key];
    if (v && v.toLowerCase() !== c.default.toLowerCase()) out[def.cssVar(c.key).slice(4, -1)] = v;
  }
  const zh = def.fonts.zh.find((f) => f.key === doc.theme.fonts.zh);
  const en = def.fonts.en.find((f) => f.key === doc.theme.fonts.en);
  if (zh && zh.key !== def.fonts.default.zh) out['--em-zh'] = zh.stack;
  if (en && en.key !== def.fonts.default.en) out['--em-en'] = en.stack;
  return out;
}
