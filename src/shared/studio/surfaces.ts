// UI 工作台的「界面」登记（8.1.1 起，docs/WORKBENCH_V811.md 第 3、7、8 节）：每个界面的设计尺寸、有哪几屏、主题色与字体、
// 能用哪些功能块（带逻辑的那几块：放在哪、多大、长什么样可以改，做什么不能改）、点了能做什么（动作）、能显示哪些数据（字段），
// 以及代码里内置的默认版面。8.1.1 是平板电子菜单；8.1.2 加微信小程序（渲染组件由小程序线照 docs/STUDIO_MP.md 写）与员工食堂。
//
// 默认版面 = 现在的样子：每一块的位置、大小都是现在页面上的那个数（emenu/EmenuPage.tsx、header.tsx），
// 平板没有发布过版面时就用它，升级以后客人看不出变化（GZ12，浏览器用例逐屏截图比对）。

import type { EmenuTemplateDef } from './emenu-templates';
import { EMENU_ALL_TEMPLATES } from './emenu-templates';
import { STUDIO_SCHEMA } from './core';
import type { StudioBlockNode, StudioButtonNode, StudioDoc, StudioFrameNode, StudioLayout, StudioNode, StudioSurface, StudioTextNode } from './format';

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
  /** 放进自动排列的屏时默认的尺寸规则（手机界面：宽撑满、高跟内容） */
  sizing?: { w: 'fixed' | 'fill' | 'hug'; h: 'fixed' | 'fill' | 'hug' };
  /**
   * 在自动排列里不另占一格：里面的几样（员工食堂一段里的几张卡片、按钮）各自直接排进去，没有的不占位置、不多间隔——
   * 与原来的页面一模一样。编辑器里照常是一整块（好选中、挪先后）。
   */
  flowContents?: boolean;
  props: readonly StudioPropDef[];
}

/** 点了做什么（界面登记的动作）：args 有的话 arg 只能从里面选，没有就不要 arg */
export interface StudioActionDef {
  key: string;
  label: string;
  args?: readonly { value: string; label: string }[];
}

/** 能显示的数据（界面登记的字段）：sample 是编辑器、样例截图里显示的样子 */
export interface StudioFieldDef {
  key: string;
  label: string;
  sample: { zh: string; en: string };
}

export interface StudioColorDef {
  key: string;
  label: string;
  default: string;
  /**
   * 品牌规定的颜色（8.1.8，平板菜单的主文字 #4b392a）：工作台里只显示、不能改；版面里存着的别的值不生效（数据不改，照默认值画）。
   * 读主题色一律走 themeColor，不直接读 doc.theme.colors。
   */
  locked?: boolean;
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
  /** tablet：整页等比缩放到屏幕（平板菜单）；phone：手机，按 375 宽排、往下滚，一屏多高由设计师定（屏的 height） */
  kind: 'tablet' | 'phone';
  /** 设计尺寸；手机界面的 h 是一屏默认的高 */
  size: { w: number; h: number };
  screens: readonly StudioScreenDef[];
  colors: readonly StudioColorDef[];
  fonts: { zh: readonly StudioFontDef[]; en: readonly StudioFontDef[]; default: { zh: string; en: string } };
  blocks: Readonly<Record<string, StudioBlockDef>>;
  /** 点了能做什么（没有的界面：按钮、框只是样子） */
  actions: readonly StudioActionDef[];
  /** 能显示哪些数据 */
  fields: readonly StudioFieldDef[];
  /** 新加的节点默认用哪几个主题色：字、填充（色块）、框的底、细线、按钮（上面是白字，要够深） */
  tokens: { text: string; fill: string; panel: string; line: string; button: string };
  /** 主题色在页面上的 CSS 变量名（$ink → --em-ink） */
  cssVar: (token: string) => string;
  /** 中文、英文字体在页面上的 CSS 变量名 */
  fontVars: { zh: string; en: string };
  /** 主题色、字体的变量是不是全写在页面上（平板菜单的默认值在样式表里，只写改过的；手机界面的全写） */
  inlineAllVars: boolean;
  /** 卡片模板（8.1.2，平板菜单的 11 种版式）：每种版式里有哪几块、各在哪 */
  templates?: Readonly<Record<string, EmenuTemplateDef>>;
  /** 图片一律直角（8.1.8，品牌部：平板菜单的图片不要圆角）：图片块的圆角不生效、工作台里不给改 */
  squareImages?: boolean;
}

const AUTO_COLOR = { kind: 'color', auto: true, default: 'auto' } as const;

/** 平板电子菜单（8.0.10 起，docs/EMENU.md）：1024×768，整页等比缩放到屏幕 */
export const EMENU_SURFACE: StudioSurfaceDef = {
  key: 'emenu',
  label: '平板电子菜单',
  kind: 'tablet',
  size: { w: 1024, h: 768 },
  screens: [
    { key: 'start', label: '起始页', hint: '客人坐下看到的第一屏：点屏幕任何地方开始点餐（输入手牌、桌号、人数的弹窗照旧）', background: '$photo' },
    { key: 'menu', label: '菜单页', hint: '翻菜单、加菜：菜单页的分类、版面、菜品在后台「电子菜单」里维护；这里可以加装饰、改主题', background: null },
  ],
  colors: [
    // 8.1.8（品牌部）：字标、顶栏分类、页面标题、菜名这些主文字一律是品牌的深棕 #4b392a，每一页都一样，工作台里不能改（PENDING_DECISIONS.md PB4）
    { key: 'ink', label: '主文字（深棕 #4b392a，品牌规定）', default: '#4b392a', locked: true },
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
    // 这里加一项，版面里就多存一个主题色：退回上一版时，上一版的工作台不认、整份版面读不了也存不进（8.1.7 就是这样）。
    // 所以 8.1.8 封面标题右下角小圆圈的颜色写死在样式表里（--em-dot），不加在这里（PB2；tests/studio-format.test.ts 核对这张表）
  ],
  fonts: {
    zh: [
      { key: 'fangsong', label: '朱雀仿宋（品牌字体，默认）', stack: "'Em Box Zh', 'Tangqi Brand Latin', 'Zhuque Fangsong', 'FangSong', 'STFangsong', 'Songti SC', 'Noto Serif CJK SC', serif" },
      { key: 'songti', label: '宋体（系统字体）', stack: "'Em Box Zh', 'Tangqi Brand Latin', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', serif" },
      { key: 'heiti', label: '黑体（系统字体）', stack: "'Em Box Zh', 'Tangqi Brand Latin', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif" },
    ],
    en: [
      // 8.1.5：门店服务器上放了授权的品牌英文字体（ABC Arizona Flare）就用它，没放用 Average Sans 顶替（docs/EMENU.md 第 14.2 节）
      {
        key: 'average',
        label: 'ABC Arizona Flare（品牌字体，默认；服务器没放授权文件时用 Average Sans 顶替）',
        stack: "'Em Box En', 'Tangqi Brand En', 'Average Sans', 'Optima', 'Zhuque Fangsong', 'FangSong', 'STFangsong', sans-serif",
      },
      // 8.1.19（店主 2026-11-20「所有的英文字体都要替换为数据包提供的示例字体」，PD5）：电子菜单里的英文一律用品牌字体
      // ABC Arizona Flare。这两项留着（存过它们的版面照常读、照常发布），授权字体排在最前；只在服务器没放授权文件时才用到后面的系统字体
      {
        key: 'serif',
        label: '衬线（系统字体；8.1.19 起英文统一用品牌字体，这一项只在服务器没放授权文件时顶替）',
        stack: "'Em Box En', 'Tangqi Brand En', Georgia, 'Times New Roman', 'Zhuque Fangsong', serif",
      },
      {
        key: 'sans',
        label: '无衬线（系统字体；8.1.19 起英文统一用品牌字体，这一项只在服务器没放授权文件时顶替）',
        stack: "'Em Box En', 'Tangqi Brand En', 'Helvetica Neue', Arial, 'PingFang SC', sans-serif",
      },
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
      label: '中英切换',
      hint: '品牌图标（8.1.5）：中文时显示 En、英文时显示中，靠右放在这一块里；后台关掉中英切换时不显示；输入信息的弹窗开着时也能点',
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
      hint: '分类、版面、菜品在后台「电子菜单」里维护；11 种版式里面每一块的位置在左边「版式」里改（8.1.2）',
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
  // 平板菜单上的装饰不接点按（点哪里都开始点餐、翻页），没有动作；也没有数据字段（菜品数据在功能块里）
  actions: [],
  fields: [],
  tokens: { text: '$ink', fill: '$tan', panel: '$modal', line: '$mute', button: '$ink' },
  cssVar: (token) => `var(--em-${token === 'key2' ? 'key-2' : token})`,
  squareImages: true,
  fontVars: { zh: '--em-zh', en: '--em-en' },
  inlineAllVars: false,
  // 菜单页 11 种版式的卡片模板，加上顶栏（8.1.6）
  templates: EMENU_ALL_TEMPLATES,
};

/** 小程序能打开的页（与 miniprogram/src/app.json 的页对应；activity 是工作台里排的活动页） */
const MP_PAGES = [
  { value: 'home', label: '首页' },
  { value: 'activity', label: '活动页（工作台里排的）' },
  { value: 'prices', label: '价目表' },
  { value: 'guide', label: '楼层导览' },
  { value: 'me', label: '我的' },
  { value: 'code', label: '会员码' },
  { value: 'coupons', label: '我的券' },
  { value: 'coupon-center', label: '领券中心' },
  { value: 'benefits', label: '会员权益' },
  { value: 'ledger', label: '账单流水' },
  { value: 'recharge', label: '充值' },
  { value: 'invite', label: '邀请好友' },
  { value: 'food', label: '扫码点餐' },
  { value: 'booking', label: '预约' },
  { value: 'bookings', label: '我的预约' },
] as const;

/**
 * 微信小程序（8.1.2，docs/WORKBENCH_V811.md 第 8 节、docs/STUDIO_MP.md）：按 375 宽排（小程序里 1 像素 = 2rpx），往下滚。
 * 只开放展示页：首页、活动页、会员页；充值、支付、退款等页只跟主题（颜色、字体），不开放结构。
 * 渲染组件由小程序线（Gemini）照 docs/STUDIO_MP.md 写；主题色对应小程序 app.wxss 里的变量（wood2 → --wood-2）。
 */
export const MP_SURFACE: StudioSurfaceDef = {
  key: 'mp',
  label: '微信小程序',
  kind: 'phone',
  size: { w: 375, h: 812 },
  screens: [
    { key: 'home', label: '首页', hint: '打开小程序的第一页：版头、门店信息、入口；会员提醒的弹窗照旧盖在上面', background: '$bg' },
    { key: 'activity', label: '活动页', hint: '换季、节日的活动页：海报、文字、按钮随便排；按钮可以打开小程序的别的页', background: '$bg' },
    { key: 'member', label: '会员页（我的）', hint: '会员卡（等级、余额、会员码）与各个入口；会员的数据照旧由小程序取', background: '$bg' },
  ],
  colors: [
    { key: 'bg', label: '页面底色（米白）', default: '#F5F1EA' },
    { key: 'surface', label: '卡片底色', default: '#FCFAF6' },
    { key: 'ink', label: '主文字', default: '#1C1A17' },
    { key: 'muted', label: '次要文字', default: '#776C60' },
    { key: 'line', label: '细线', default: '#E0D7C9' },
    { key: 'wood', label: '主色（木色）', default: '#937051' },
    { key: 'wood2', label: '木色 2', default: '#AD8E69' },
    { key: 'wood3', label: '木色 3', default: '#C4A67E' },
    { key: 'wood4', label: '木色 4', default: '#D2B993' },
    { key: 'wood5', label: '木色 5', default: '#E4D0B3' },
    { key: 'wood6', label: '木色 6', default: '#EBDECA' },
    { key: 'organic', label: '概念色：有机（绿）', default: '#5D6B3B' },
    { key: 'relax', label: '概念色：放松（蓝）', default: '#4E6B82' },
    { key: 'energy', label: '概念色：活力（橙）', default: '#B5532F' },
    { key: 'danger', label: '出错', default: '#A6452F' },
    { key: 'cardA', label: '会员卡深色', default: '#5B4432' },
    { key: 'cardB', label: '会员卡浅色', default: '#937051' },
    { key: 'cardInk', label: '会员卡上的字', default: '#FBF6EE' },
    { key: 'cardMuted', label: '会员卡上的次要字', default: '#E2CFB2' },
  ],
  fonts: {
    zh: [
      { key: 'system', label: '系统字体（苹方 / 鸿蒙，默认）', stack: "'HarmonyOS Sans SC', 'HarmonyOS Sans', 'PingFang SC', -apple-system, 'Helvetica Neue', 'Microsoft YaHei', sans-serif" },
      { key: 'serif', label: '宋体', stack: "'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', serif" },
    ],
    en: [
      { key: 'helvetica', label: 'Helvetica（默认）', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
      { key: 'serif', label: '衬线', stack: "Georgia, 'Times New Roman', serif" },
    ],
    default: { zh: 'system', en: 'helvetica' },
  },
  blocks: {
    'mp.banner': {
      key: 'mp.banner',
      label: '版头大图（轮播）',
      hint: '小程序后台配的轮播图，没配时是氛围底色加字标；几张图自动轮播',
      screens: ['home', 'activity'],
      size: { w: 375, h: 300 },
      resize: 'free',
      move: true,
      single: true,
      sizing: { w: 'fill', h: 'fixed' },
      props: [
        { key: 'shade', label: '压暗', kind: 'number', min: 0, max: 0.8, step: 0.02, default: 0.2 },
        { key: 'wordmark', label: '显示字标', kind: 'boolean', default: true },
        { key: 'autoplay', label: '自动轮播', kind: 'boolean', default: true },
      ],
    },
    'mp.store': {
      key: 'mp.store',
      label: '门店信息',
      hint: '门店名、营业时间、地址、电话、公告，导航与拨打电话；有几家店时可以切换。高度跟内容',
      screens: ['home'],
      size: { w: 375, h: 280 },
      resize: 'free',
      move: true,
      required: true,
      single: true,
      sizing: { w: 'fill', h: 'hug' },
      props: [
        { key: 'card', label: '卡片底色', kind: 'color', default: '$surface' },
        { key: 'buttons', label: '显示导航、拨打电话', kind: 'boolean', default: true },
      ],
    },
    'mp.memberCard': {
      key: 'mp.memberCard',
      label: '会员卡',
      hint: '会员等级、余额、到下一档还差多少、会员码入口；没登录时是「登录 / 注册」。数据照旧由小程序取',
      screens: ['member'],
      size: { w: 375, h: 220 },
      resize: 'free',
      move: true,
      required: true,
      single: true,
      sizing: { w: 'fill', h: 'hug' },
      props: [
        { key: 'from', label: '渐变起点色', kind: 'color', default: '$cardA' },
        { key: 'to', label: '渐变终点色', kind: 'color', default: '$cardB' },
        { key: 'ink', label: '卡上的字', kind: 'color', default: '$cardInk' },
      ],
    },
  },
  actions: [
    { key: 'open.page', label: '打开小程序的一页', args: MP_PAGES },
    { key: 'call.store', label: '拨打门店电话' },
    { key: 'nav.store', label: '导航到门店' },
  ],
  fields: [
    { key: 'store.name', label: '门店名', sample: { zh: '汤崎·前海店', en: 'TOUCHILL Qianhai' } },
    { key: 'store.hours', label: '营业时间', sample: { zh: '10:00–次日 02:00', en: '10:00–02:00' } },
    { key: 'store.address', label: '门店地址', sample: { zh: '深圳市南山区前海路 88 号', en: '88 Qianhai Rd, Nanshan, Shenzhen' } },
    { key: 'store.phone', label: '门店电话', sample: { zh: '0755-8888 0000', en: '0755-8888 0000' } },
    { key: 'store.notice', label: '门店公告', sample: { zh: '本周三 14:00–16:00 温泉池例行保养', en: 'Spa pool maintenance Wed 14:00–16:00' } },
    { key: 'member.name', label: '会员称呼', sample: { zh: '林女士', en: 'Ms. Lin' } },
    { key: 'member.grade', label: '会员等级', sample: { zh: '金卡会员', en: 'Gold' } },
    { key: 'member.balance', label: '储值余额', sample: { zh: '¥1,280.00', en: '¥1,280.00' } },
    { key: 'member.coupons', label: '可用的券（张）', sample: { zh: '3', en: '3' } },
    { key: 'today.date', label: '今天的日期', sample: { zh: '11 月 15 日 周日', en: 'Sun, Nov 15' } },
  ],
  tokens: { text: '$ink', fill: '$wood', panel: '$surface', line: '$line', button: '$cardA' },
  cssVar: (token) => `var(--mp-${token})`,
  fontVars: { zh: '--mp-zh', en: '--mp-en' },
  inlineAllVars: true,
};

/** 柚子饭堂的页（与 src/canteen-app/App.tsx 的路由对应） */
const CANTEEN_PAGES = [
  { value: 'home', label: '首页' },
  { value: 'menu', label: '菜单（这周吃什么）' },
  { value: 'code', label: '饭卡码' },
  { value: 'talk', label: '跟柚子说' },
  { value: 'me', label: '我的' },
] as const;

/** 柚子饭堂的主题色在页面上的变量：ink2 → --color-ink-2、woodDeep → --color-wood-deep（src/canteen-app/styles.css） */
export const canteenColorVar = (token: string) =>
  `--color-${token
    .replace(/([A-Z])/g, '-$1')
    .replace(/(\d+)/g, '-$1')
    .toLowerCase()}`;

/** 一块内容（功能块）：照现在的页面画，高跟着内容走、宽撑满；不能改大小（大小由里面的内容定） */
const cnBlock = (key: string, label: string, hint: string, screen: 'home' | 'code', h: number, more: Partial<StudioBlockDef> = {}): StudioBlockDef => ({
  key,
  label,
  hint,
  screens: [screen],
  size: { w: 343, h },
  resize: 'none',
  move: true,
  single: true,
  sizing: { w: 'fill', h: 'hug' },
  flowContents: true,
  props: [],
  ...more,
});

/**
 * 员工食堂 · 柚子饭堂（8.1.2，docs/CANTEEN.md、docs/WORKBENCH_V811.md 第 8 节）：员工手机上的首页与饭卡码页。
 * 现在的每一段（问好、现在吃什么、亮出饭卡码、按岗位的入口……）都是功能块（逻辑照旧），设计师调先后、藏起来、在中间加图文、换主题色；
 * **饭卡码那一块的大小、留白、颜色锁定**（码是固定的深色点阵白底，主题色改不到它），扫不出来就打不了卡。
 */
export const CANTEEN_SURFACE: StudioSurfaceDef = {
  key: 'canteen',
  label: '员工食堂',
  kind: 'phone',
  size: { w: 375, h: 812 },
  screens: [
    {
      key: 'home',
      label: '首页',
      hint: '员工打开柚子饭堂的第一页：问好、现在吃什么、亮出饭卡码、按岗位的入口、跟柚子说、今天的菜单。没网时照样能看（用上次的样子）。底色「无」是柚子饭堂的暖白',
      background: '$cream',
    },
    { key: 'code', label: '饭卡码', hint: '给食堂负责人扫的那一页：饭卡码那一块的大小、留白、颜色锁定（扫不出来就打不了卡），只能改它周围。底色「无」是柚子饭堂的暖白', background: '$cream' },
  ],
  colors: [
    { key: 'cream', label: '页面底色（暖白）', default: '#f4ede2' },
    { key: 'card', label: '卡片底色', default: '#fbf7f0' },
    { key: 'line', label: '细线', default: '#e3d6c3' },
    { key: 'ink', label: '主文字（深胡桃）', default: '#3a2c22' },
    { key: 'ink2', label: '次要文字', default: '#5c4639' },
    { key: 'ink3', label: '浅文字', default: '#8b7865' },
    { key: 'wood', label: '木色', default: '#937051' },
    { key: 'wood4', label: '木色（浅）', default: '#d2b993' },
    { key: 'woodDeep', label: '木色（深，按钮）', default: '#8a684a' },
    { key: 'yuzu', label: '柚黄（重点）', default: '#e9c75e' },
    { key: 'yuzuDeep', label: '柚黄（深）', default: '#7f5d10' },
    { key: 'yuzuSoft', label: '柚黄（浅底）', default: '#f6ebc5' },
    { key: 'organic', label: '概念色：有机（绿，成功）', default: '#6d673d' },
    { key: 'relax', label: '概念色：放松（蓝，提示）', default: '#4d718c' },
    { key: 'energy', label: '概念色：活力（橙，点赞）', default: '#c04a1f' },
    { key: 'danger', label: '出错', default: '#a6452f' },
  ],
  fonts: {
    zh: [
      {
        key: 'harmony',
        label: '鸿蒙 / 苹方（默认）',
        stack:
          "'HarmonyOS Sans SC', 'HarmonyOS Sans', 'PingFang SC', -apple-system, 'Helvetica Neue', Helvetica, Arial, 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, sans-serif",
      },
      { key: 'serif', label: '宋体', stack: "'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', serif" },
    ],
    en: [
      { key: 'helvetica', label: 'Helvetica（默认）', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
      { key: 'serif', label: '衬线', stack: "Georgia, 'Times New Roman', serif" },
    ],
    default: { zh: 'harmony', en: 'helvetica' },
  },
  blocks: {
    'cn.greeting': cnBlock('cn.greeting', '问好与头像', '「中午好，名字」与头像（点头像到「我的」）', 'home', 76),
    'cn.notices': cnBlock('cn.notices', '提示条', '没网时、菜单是上次看到的、问要不要饭点提醒；没有要提示的时候不占地方', 'home', 44),
    'cn.focusMeal': cnBlock('cn.focusMeal', '现在吃什么', '现在开饭的那一顿（或今天下一顿）的菜单卡片，可以点赞；都开完了是柚子说明天见', 'home', 300),
    'cn.codeButton': cnBlock('cn.codeButton', '亮出饭卡码', '大按钮：打开饭卡码。员工吃饭靠它，不能去掉', 'home', 56, { required: true }),
    'cn.entries': cnBlock('cn.entries', '按岗位的入口', '负责人的「扫码打卡」「柚子信箱」，巡场的人的「巡场打卡」；别的员工这里什么都没有。不能去掉', 'home', 200, { required: true }),
    'cn.talk': cnBlock('cn.talk', '跟柚子说', '柚子与「跟柚子说」的入口', 'home', 96),
    'cn.today': cnBlock('cn.today', '今天的菜单', '今天其他几顿的菜单，「看看这周的菜单」', 'home', 260),
    'cn.footer': cnBlock('cn.footer', '这个月吃了几顿', '一行小字：这个月在饭堂吃了几顿', 'home', 28),
    'cn.profile': cnBlock('cn.profile', '我的名片', '头像、名字、工号、部门、岗位', 'code', 82),
    'cn.qr': cnBlock('cn.qr', '饭卡码', '每 30 秒换一个的饭卡码，外圈是倒计时。大小、留白、颜色锁定：扫不出来就打不了卡。不能去掉', 'code', 330, {
      required: true,
      size: { w: 330, h: 330 },
      sizing: { w: 'hug', h: 'hug' },
    }),
    'cn.codeHint': cnBlock('cn.codeHint', '扫码说明', '「给食堂负责人扫一扫」、几秒后换码、连没连上门店', 'code', 90, { sizing: { w: 'hug', h: 'hug' } }),
    'cn.mascot': cnBlock('cn.mascot', '柚子与一句话', '柚子端着碗：「吃饱饱，下午才有力气呀」', 'code', 64, { sizing: { w: 'hug', h: 'hug' } }),
  },
  actions: [{ key: 'open.page', label: '打开柚子饭堂的一页', args: CANTEEN_PAGES }],
  fields: [
    { key: 'me.name', label: '员工的名字', sample: { zh: '林小柚', en: 'Lin' } },
    { key: 'me.department', label: '部门', sample: { zh: '前厅部', en: 'Front desk' } },
    { key: 'me.mealsThisMonth', label: '这个月在饭堂吃了几顿', sample: { zh: '12', en: '12' } },
    { key: 'today.date', label: '今天的日期', sample: { zh: '11 月 16 日 周一', en: 'Mon, Nov 16' } },
  ],
  tokens: { text: '$ink', fill: '$yuzu', panel: '$card', line: '$line', button: '$woodDeep' },
  cssVar: (token) => `var(${canteenColorVar(token)})`,
  fontVars: { zh: '--font-sans', en: '--font-en' },
  inlineAllVars: false,
};

export const STUDIO_SURFACE_DEFS: Record<StudioSurface, StudioSurfaceDef> = { emenu: EMENU_SURFACE, mp: MP_SURFACE, canteen: CANTEEN_SURFACE };

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
  return surface === 'mp' ? defaultMpDoc() : surface === 'canteen' ? defaultCanteenDoc() : defaultEmenuDoc();
}

/** 柚子饭堂的默认版面（= 现在的样子）：首页一段一段往下排、间隔 16；饭卡码页居中、上面留 8；左右各留 16 */
function defaultCanteenDoc(): StudioDoc {
  const def = CANTEEN_SURFACE;
  const at = (id: string, key: string): StudioBlockNode => {
    const b = def.blocks[key]!;
    return { ...block(id, key, b.label, 0, 0, b.size.w, b.size.h), sizing: { ...(b.sizing ?? { w: 'fill', h: 'hug' }) } };
  };
  // 左右各留 16（原来是外壳留的，现在在版面里，设计师可以改）
  const column = (gap: number, align: StudioLayout['align'], top = 0): StudioLayout => ({ mode: 'column', wrap: false, gap, padding: [top, 16, 0, 16], align, justify: 'start' });
  return {
    schema: STUDIO_SCHEMA,
    surface: 'canteen',
    theme: themeOf(def),
    screens: {
      home: {
        background: null,
        layout: column(16, 'stretch'),
        nodes: [
          at('home-greeting', 'cn.greeting'),
          at('home-notices', 'cn.notices'),
          at('home-focus', 'cn.focusMeal'),
          at('home-code', 'cn.codeButton'),
          at('home-entries', 'cn.entries'),
          at('home-talk', 'cn.talk'),
          at('home-today', 'cn.today'),
          at('home-footer', 'cn.footer'),
        ],
      },
      // 饭卡码页：各段自己带着原来的上边距（码上面 24、说明上面 24……），间隔是 0
      code: { background: null, layout: column(0, 'center', 8), nodes: [at('code-profile', 'cn.profile'), at('code-qr', 'cn.qr'), at('code-hint', 'cn.codeHint'), at('code-mascot', 'cn.mascot')] },
    },
  };
}

const themeOf = (def: StudioSurfaceDef) => ({ colors: Object.fromEntries(def.colors.map((c) => [c.key, c.default])), fonts: { ...def.fonts.default } });

function defaultEmenuDoc(): StudioDoc {
  const def = EMENU_SURFACE;
  const start: StudioNode[] = [
    block('start-cover', 'start.cover', '氛围大图', 0, 0, 1024, 768, { dim: 0.18, kenburns: true }),
    block('start-logo', 'brand.logo', '汤崎字标', 472.6, 342.8, 78.64, 76.633, { color: 'auto' }),
    block('start-pending', 'start.pending', '待确认提示', 0, 600, 1024, 16, { color: 'auto', size: 12 }),
    block('start-footer', 'start.footer', '版权行', 0, 715.2, 1024, 12, { color: 'auto', size: 12 }),
    block('start-lang', 'lang', '中英切换', 936, 44.3, 48, 22.3, { tone: 'auto' }),
  ];
  const menu: StudioNode[] = [
    block('menu-pages', 'menu.pages', '菜单页', 0, 0, 1024, 768),
    block('menu-header', 'menu.header', '顶栏', 0, 0, 1024, 102),
    block('menu-dots', 'menu.dots', '翻页圆点', 0, 742, 1024, 14),
  ];
  return { schema: STUDIO_SCHEMA, surface: 'emenu', theme: themeOf(def), screens: { start: { background: '$photo', nodes: start }, menu: { background: null, nodes: menu } } };
}

// ───────────────────────── 小程序的默认版面 ─────────────────────────
// 照小程序现在的首页、「我的」排的：一段一段往下排（整屏竖排）。小程序线照这一份做「没发布过时」的样子也可以，
// 自己原来的页面也可以（docs/STUDIO_MP.md 第 6 节）。

const at = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotate: 0, opacity: 1, hidden: false, locked: false });
const flow = (
  mode: 'row' | 'column',
  gap: number,
  padding: [number, number, number, number],
  align: StudioLayout['align'] = 'start',
  justify: StudioLayout['justify'] = 'start',
  wrap = false,
): StudioLayout => ({ mode, wrap, gap, padding, align, justify });
const txt = (id: string, name: string, zh: string, en: string, size: number, style: Partial<StudioTextNode> = {}): StudioTextNode => ({
  type: 'text',
  id,
  name,
  ...at(0, 0, 0, 0),
  sizing: { w: 'fill', h: 'hug' },
  text: { zh, en },
  font: 'zh',
  size,
  weight: 400,
  color: '$ink',
  align: 'left',
  valign: 'top',
  lineHeight: 1.4,
  letterSpacing: 0,
  italic: false,
  underline: false,
  fill: null,
  ...style,
});
const mpBlock = (id: string, key: string, name: string, w: number, h: number, props: StudioBlockNode['props']): StudioBlockNode => ({
  ...block(id, key, name, 0, 0, w, h, props),
  sizing: MP_SURFACE.blocks[key]!.sizing ?? { w: 'fill', h: 'hug' },
});
const card = (id: string, name: string, w: number, h: number, children: StudioNode[], extra: Partial<StudioFrameNode> = {}): StudioFrameNode => ({
  type: 'frame',
  id,
  name,
  ...at(0, 0, w, h),
  fill: '$surface',
  stroke: '$line',
  strokeWidth: 1,
  radius: 8,
  shadow: 'none',
  clip: true,
  children,
  ...extra,
});
/** 入口：一个能点的小卡片（上面一个字的「图标」，下面名字），点了打开小程序的一页 */
const entry = (id: string, icon: string, label: string, page: string): StudioFrameNode =>
  card(
    id,
    label,
    76,
    84,
    [
      { ...txt(`${id}-ic`, '图标', icon, '', 20, { align: 'center', color: '$wood', weight: 700 }), sizing: { w: 'fill', h: 'hug' } },
      { ...txt(`${id}-lb`, '名字', label, '', 12, { align: 'center', color: '$muted' }), sizing: { w: 'fill', h: 'hug' } },
    ],
    { layout: flow('column', 6, [16, 4, 14, 4], 'center', 'center'), sizing: { w: 'fixed', h: 'fixed' }, action: { action: 'open.page', arg: page } },
  );
/** 三块业务（品牌书）：英文大写小标题 + 中文名 */
const pillar = (id: string, en: string, zh: string, color: string, page: string): StudioFrameNode =>
  card(
    id,
    zh,
    0,
    96,
    [txt(`${id}-en`, '英文', en, en, 10, { font: 'en', weight: 700, letterSpacing: 0.1, color: '$cardInk' }), txt(`${id}-zh`, '中文', zh, zh, 15, { weight: 500, color: '$cardInk' })],
    { fill: color, stroke: null, strokeWidth: 0, layout: flow('column', 6, [18, 12, 18, 12], 'start', 'end'), sizing: { w: 'fill', h: 'fixed' }, action: { action: 'open.page', arg: page } },
  );
const section = (id: string, name: string, eyebrow: string, title: string, body: StudioNode): StudioFrameNode => ({
  type: 'frame',
  id,
  name,
  ...at(0, 0, 375, 0),
  sizing: { w: 'fill', h: 'hug' },
  fill: null,
  stroke: null,
  strokeWidth: 0,
  radius: 0,
  shadow: 'none',
  clip: false,
  layout: flow('column', 12, [20, 18, 4, 18]),
  children: [
    txt(`${id}-eb`, '小标题（英文）', eyebrow, eyebrow, 11, { font: 'en', weight: 700, letterSpacing: 0.2, color: '$muted' }),
    txt(`${id}-h`, '标题', title, title, 18, { weight: 600 }),
    body,
  ],
});

function defaultMpDoc(): StudioDoc {
  const pillars: StudioFrameNode = {
    type: 'frame',
    id: 'home-pillars',
    name: '三块业务',
    ...at(0, 0, 375, 0),
    sizing: { w: 'fill', h: 'hug' },
    fill: null,
    stroke: null,
    strokeWidth: 0,
    radius: 0,
    shadow: 'none',
    clip: false,
    layout: flow('row', 8, [20, 18, 4, 18], 'start'),
    children: [
      pillar('home-taste', 'TASTE', '美食餐饮', '$energy', 'food'),
      pillar('home-wellness', 'WELLNESS', '按摩疗愈', '$relax', 'booking'),
      pillar('home-exp', 'EXPERIENCE', '日常娱乐', '$organic', 'guide'),
    ],
  };
  const services = section('home-services', '服务', 'SERVICES', '服务', {
    type: 'frame',
    id: 'home-services-grid',
    name: '入口',
    ...at(0, 0, 339, 0),
    sizing: { w: 'fill', h: 'hug' },
    fill: null,
    stroke: null,
    strokeWidth: 0,
    radius: 0,
    shadow: 'none',
    clip: false,
    layout: flow('row', 11, [0, 0, 0, 0], 'start', 'start', true),
    children: [
      entry('home-code', '码', '会员码', 'code'),
      entry('home-prices', '价', '价目表', 'prices'),
      entry('home-guide', '导', '楼层导览', 'guide'),
      entry('home-coupons', '券', '我的券', 'coupons'),
    ],
  });
  const memberEntries = section('member-entries', '我的入口', 'MY TOUCHILL', '我的', {
    type: 'frame',
    id: 'member-entries-grid',
    name: '入口',
    ...at(0, 0, 339, 0),
    sizing: { w: 'fill', h: 'hug' },
    fill: null,
    stroke: null,
    strokeWidth: 0,
    radius: 0,
    shadow: 'none',
    clip: false,
    layout: flow('row', 11, [0, 0, 0, 0], 'start', 'start', true),
    children: [
      entry('member-coupons', '券', '我的券', 'coupons'),
      entry('member-benefits', '益', '会员权益', 'benefits'),
      entry('member-ledger', '账', '账单流水', 'ledger'),
      entry('member-recharge', '充', '充值', 'recharge'),
      entry('member-bookings', '约', '我的预约', 'bookings'),
      entry('member-invite', '邀', '邀请好友', 'invite'),
      entry('member-center', '领', '领券中心', 'coupon-center'),
      entry('member-code', '码', '会员码', 'code'),
    ],
  });
  const activityTitle = txt('activity-title', '活动标题', '活动页还没有排', 'Coming soon', 22, { weight: 600, align: 'center' });
  const activityNote = txt('activity-note', '说明', '在工作台里放海报、文字、按钮，发布以后这里就是新的活动页。', 'Posters, text and buttons go here.', 13, { align: 'center', color: '$muted' });
  const backHome: StudioButtonNode = {
    type: 'button',
    id: 'activity-home',
    name: '回首页',
    ...at(0, 0, 160, 44),
    sizing: { w: 'fixed', h: 'fixed' },
    fill: '$cardA',
    stroke: null,
    strokeWidth: 0,
    radius: 8,
    shadow: 'none',
    text: { zh: '回首页', en: 'Home' },
    font: 'zh',
    size: 14,
    weight: 600,
    color: '#FFFFFF',
    align: 'center',
    valign: 'middle',
    lineHeight: 1.4,
    letterSpacing: 0.04,
    italic: false,
    underline: false,
    action: { action: 'open.page', arg: 'home' },
  };
  return {
    schema: STUDIO_SCHEMA,
    surface: 'mp',
    theme: themeOf(MP_SURFACE),
    screens: {
      home: {
        background: '$bg',
        layout: flow('column', 0, [0, 0, 24, 0], 'stretch'),
        nodes: [
          mpBlock('home-banner', 'mp.banner', '版头大图', 375, 300, { shade: 0.2, wordmark: true, autoplay: true }),
          mpBlock('home-store', 'mp.store', '门店信息', 375, 280, { card: '$surface', buttons: true }),
          pillars,
          services,
        ],
      },
      activity: { background: '$bg', layout: flow('column', 16, [120, 24, 24, 24], 'center'), nodes: [activityTitle, activityNote, backHome] },
      member: {
        background: '$bg',
        layout: flow('column', 0, [0, 0, 24, 0], 'stretch'),
        nodes: [mpBlock('member-card', 'mp.memberCard', '会员卡', 375, 220, { from: '$cardA', to: '$cardB', ink: '$cardInk' }), memberEntries],
      },
    },
  };
}

/**
 * 版面里一个主题色现在是什么颜色（8.1.8）：品牌规定的（locked）一律是默认值，不看版面里存的；没存的用默认值；界面没登记的返回空。
 * 画页面、工作台的色块、核对对比度都用它，不直接读 doc.theme.colors。
 */
export function themeColor(doc: StudioDoc, key: string): string | null {
  const def = STUDIO_SURFACE_DEFS[doc.surface].colors.find((c) => c.key === key);
  if (!def) return null;
  return def.locked ? def.default : (doc.theme.colors[key] ?? def.default);
}

/**
 * 主题色、字体在页面上的 CSS 变量。平板菜单只给和默认不一样的（默认值在 emenu.css 里，默认版面在页面上一个变量都不多设）；
 * 手机界面全给（React 这边没有它们的样式表）。
 */
/**
 * 主题色、字体的 CSS 变量：界面登记 inlineAllVars 的全写，不然只写改过的（默认值在那个界面自己的样式表里）。
 * all：不管登记都全写——在别的页面里画这个界面时（工作台的编辑器、预览里画员工食堂，那里没有员工食堂的样式表）。
 */
export function themeVars(doc: StudioDoc, all = false): Record<string, string> {
  const def = STUDIO_SURFACE_DEFS[doc.surface];
  const every = all || def.inlineAllVars;
  const out: Record<string, string> = {};
  for (const c of def.colors) {
    const v = themeColor(doc, c.key) ?? c.default;
    if (every || v.toLowerCase() !== c.default.toLowerCase()) out[def.cssVar(c.key).slice(4, -1)] = v;
  }
  const zh = def.fonts.zh.find((f) => f.key === doc.theme.fonts.zh) ?? def.fonts.zh.find((f) => f.key === def.fonts.default.zh);
  const en = def.fonts.en.find((f) => f.key === doc.theme.fonts.en) ?? def.fonts.en.find((f) => f.key === def.fonts.default.en);
  if (zh && (every || zh.key !== def.fonts.default.zh)) out[def.fontVars.zh] = zh.stack;
  if (en && (every || en.key !== def.fonts.default.en)) out[def.fontVars.en] = en.stack;
  return out;
}
