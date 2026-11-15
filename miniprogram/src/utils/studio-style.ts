// 工作台 · 小程序版面的样式计算、数据字段与动作（8.1.2，docs/STUDIO_MP.md 第 1–4、6 节）。
// 纯函数、不依赖微信界面，单元测试直接喂 tests/fixtures/studio/mp/ 的五份样例核对。
//   · 单位：375 设计宽 = 750rpx（1px = 2rpx）；
//   · 颜色：#RRGGBB 原样，#RRGGBBAA 转 rgba()（老 WebView 不认 8 位十六进制），$主题色转 var(--…)；
//   · 排列：不用 CSS flex gap（老 iOS 不认），不换行除最后一个可见节点外加方向外边距，换行包一层负外边距抵消；
//   · 容错：schema 不是 1 或缺关键结构返回 null（页面回退原来的画法）；不认识的节点 type 跳过、不占间距、不白屏。

import type {
  MpStore,
  MpStudioAction,
  MpStudioBilingual,
  MpStudioBlockNode,
  MpStudioBoxFields,
  MpStudioDoc,
  MpStudioLayout,
  MpStudioNode,
  MpStudioScreen,
  MpStudioShadow,
  MpStudioTextFields,
  MpStudioTheme,
} from '../../../src/shared/mp';
import type { CardView } from './member-card';

const CSS_VAR_BY_TOKEN: Record<string, string> = {
  bg: '--bg',
  surface: '--surface',
  ink: '--ink',
  muted: '--muted',
  line: '--line',
  wood: '--wood',
  wood2: '--wood-2',
  wood3: '--wood-3',
  wood4: '--wood-4',
  wood5: '--wood-5',
  wood6: '--wood-6',
  organic: '--organic',
  relax: '--relax',
  energy: '--energy',
  danger: '--danger',
  cardA: '--card-a',
  cardB: '--card-b',
  cardInk: '--card-ink',
  cardMuted: '--card-muted',
};

const SERIF_ZH = "'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', serif";
const SERIF_EN = "Georgia, 'Times New Roman', serif";

const SHADOW_RPX: Record<MpStudioShadow, string> = {
  none: '',
  sm: '0 2rpx 6rpx rgba(0, 0, 0, 0.12)',
  md: '0 8rpx 28rpx rgba(0, 0, 0, 0.16)',
  lg: '0 24rpx 64rpx rgba(0, 0, 0, 0.22)',
};

const ALIGN_CSS: Record<MpStudioLayout['align'], string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

const JUSTIFY_CSS: Record<MpStudioLayout['justify'], string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
};

const IMAGE_MODE: Record<'cover' | 'contain' | 'fill', 'aspectFill' | 'aspectFit' | 'scaleToFill'> = {
  cover: 'aspectFill',
  contain: 'aspectFit',
  fill: 'scaleToFill',
};

const TAB_PAGES: Record<string, string> = {
  home: '/pages/home/index',
  prices: '/pages/prices/index',
  guide: '/pages/guide/index',
  me: '/pages/me/index',
};

const SUB_PAGES: Record<string, string> = {
  code: '/pages/code/index',
  coupons: '/pages/coupons/index',
  'coupon-center': '/pages/coupon-center/index',
  benefits: '/pages/benefits/index',
  ledger: '/pages/ledger/index',
  recharge: '/pages/recharge/index',
  invite: '/pages/invite/index',
  food: '/pages/food/index',
  booking: '/pages/booking/index',
  bookings: '/pages/bookings/index',
  activity: '/pages/activity/index',
};

const KNOWN_NODE_TYPES: Record<string, boolean> = {
  frame: true,
  rect: true,
  ellipse: true,
  text: true,
  field: true,
  image: true,
  button: true,
  block: true,
};

/** 哪一屏认哪几个功能块（docs/STUDIO_MP.md 第 3.10 节） */
const SCREEN_BLOCKS: Record<string, Record<string, string>> = {
  home: { 'mp.banner': 'banner', 'mp.store': 'store' },
  activity: { 'mp.banner': 'banner' },
  member: { 'mp.memberCard': 'memberCard' },
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 375 设计稿像素 → rpx（1px = 2rpx） */
export function rpx(px: number): string {
  if (!px || !isFinite(px)) return '0';
  const v = Math.round(px * 200) / 100;
  return v === 0 ? '0' : v + 'rpx';
}

/** 颜色转成小程序稳妥的 CSS 值：#RRGGBBAA 转 rgba()，$主题色转 var(--…) */
export function studioColor(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(raw);
  if (m) {
    const r = parseInt(m[1]!, 16);
    const g = parseInt(m[2]!, 16);
    const b = parseInt(m[3]!, 16);
    const a = Math.round((parseInt(m[4]!, 16) / 255) * 10000) / 10000;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
  }
  if (raw.charAt(0) === '$') {
    const v = CSS_VAR_BY_TOKEN[raw.slice(1)];
    return v ? 'var(' + v + ')' : '';
  }
  return '';
}

/** 核对整份版面：schema 必须是 1、surface 是 mp、有 theme 与 screens；不合要求返回 null（回退原页面） */
export function validateMpStudioDoc(raw: unknown): MpStudioDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<MpStudioDoc>;
  if (d.schema !== 1 || d.surface !== 'mp') return null;
  if (!d.theme || typeof d.theme !== 'object') return null;
  if (!d.theme.colors || typeof d.theme.colors !== 'object') return null;
  if (!d.theme.fonts || typeof d.theme.fonts !== 'object') return null;
  if (!d.screens || typeof d.screens !== 'object') return null;
  for (const k of Object.keys(d.screens)) {
    const s = d.screens[k];
    if (!s || typeof s !== 'object' || !Array.isArray(s.nodes)) return null;
  }
  return d as MpStudioDoc;
}

/** 主题色与字体转成设在页面最外层的行内 CSS 变量字符串 */
export function buildThemeStyle(theme: MpStudioTheme | null | undefined): string {
  if (!theme) return '';
  const out: string[] = [];
  const colors = theme.colors || {};
  for (const key of Object.keys(CSS_VAR_BY_TOKEN)) {
    const raw = colors[key];
    if (typeof raw !== 'string') continue;
    // 主题表里的值只认 #RRGGBB / #RRGGBBAA，防止变量自己指自己
    if (raw.charAt(0) !== '#') continue;
    const val = studioColor(raw);
    if (val) out.push(CSS_VAR_BY_TOKEN[key]! + ':' + val);
  }
  if (theme.fonts) {
    if (theme.fonts.zh === 'serif') out.push('--font-zh:' + SERIF_ZH);
    if (theme.fonts.en === 'serif') out.push('--font-en:' + SERIF_EN);
  }
  return out.length ? out.join(';') + ';' : '';
}

/** 北京时间今天的日期：「11 月 15 日 周日」（不依赖手机时区） */
export function formatTodayBeijing(nowMs = Date.now()): string {
  const d = new Date(nowMs + 8 * 3600 * 1000);
  return (d.getUTCMonth() + 1) + ' 月 ' + d.getUTCDate() + ' 日 周' + WEEKDAYS[d.getUTCDay()];
}

export interface MpFieldContext {
  store?: MpStore | null;
  card?: CardView | null;
  nowMs?: number;
}

/** 解析数据字段（docs/STUDIO_MP.md 第 3.9 节）；取不到的返回空串，前后的字照写 */
export function resolveMpField(field: string, ctx: MpFieldContext): string {
  const s = ctx.store || null;
  const c = ctx.card || null;
  switch (field) {
    case 'store.name':
      return s ? s.name : '';
    case 'store.hours':
      return s ? s.hours : '';
    case 'store.address':
      return s ? s.address : '';
    case 'store.phone':
      return s ? s.phone : '';
    case 'store.notice':
      return s ? s.notice : '';
    case 'member.name':
      return c ? c.name : '';
    case 'member.grade':
      if (!c) return '';
      return c.tierName ? c.code + ' ' + c.gradeName + ' · ' + c.tierName : c.code + ' ' + c.gradeName;
    case 'member.balance':
      return c ? c.total : '';
    case 'member.coupons':
      return c ? String(c.coupons) : '';
    case 'today.date':
      return formatTodayBeijing(ctx.nowMs);
    default:
      return '';
  }
}

/** 这一屏是否用到了 member.* 数据字段（首页、活动页据此决定要不要去读一次 /v1/me） */
export function screenUsesMemberField(screen: MpStudioScreen | null | undefined): boolean {
  if (!screen || !Array.isArray(screen.nodes)) return false;
  const stack: MpStudioNode[] = screen.nodes.slice();
  while (stack.length) {
    const n = stack.pop()!;
    if (!n || typeof n !== 'object' || n.hidden) continue;
    if (n.type === 'field' && typeof n.field === 'string' && n.field.indexOf('member.') === 0) return true;
    if (n.type === 'frame' && Array.isArray(n.children)) {
      for (let i = 0; i < n.children.length; i++) stack.push(n.children[i]!);
    }
  }
  return false;
}

export interface RenderBannerProps {
  shade: number;
  shadeStyle: string;
  wordmark: boolean;
  autoplay: boolean;
}

export interface RenderStoreProps {
  cardBg: string;
  cardStyle: string;
  buttons: boolean;
}

export interface RenderMemberCardProps {
  from: string;
  to: string;
  ink: string;
  cardStyle: string;
}

export interface RenderNode {
  id: string;
  type: 'frame' | 'rect' | 'ellipse' | 'text' | 'field' | 'image' | 'button' | 'block';
  style: string;
  /** 换行的横排框：里面包一层负外边距抵消多出来的右边距和下边距 */
  innerWrapStyle: string;
  text: string;
  imageSrc: string;
  imageMode: 'aspectFill' | 'aspectFit' | 'scaleToFill';
  hasAction: boolean;
  action: MpStudioAction | null;
  blockKey: string;
  blockSlot: string;
  children: RenderNode[];
}

export interface RenderScreen {
  screenKey: string;
  style: string;
  innerWrapStyle: string;
  nodes: RenderNode[];
  bannerProps: RenderBannerProps;
  storeProps: RenderStoreProps;
  memberCardProps: RenderMemberCardProps;
}

export const DEFAULT_BANNER_PROPS: RenderBannerProps = {
  shade: 0.2,
  shadeStyle: 'background:linear-gradient(180deg, rgba(28, 26, 23, 0.2) 0%, rgba(28, 26, 23, 0.04) 40%, rgba(28, 26, 23, 0.35) 100%);',
  wordmark: true,
  autoplay: true,
};

export const DEFAULT_STORE_PROPS: RenderStoreProps = {
  cardBg: 'var(--surface)',
  cardStyle: 'background-color:var(--surface);',
  buttons: true,
};

export const DEFAULT_MEMBER_CARD_PROPS: RenderMemberCardProps = {
  from: 'var(--card-a)',
  to: 'var(--card-b)',
  ink: 'var(--card-ink)',
  cardStyle: '',
};

function pickZh(b: MpStudioBilingual | undefined): string {
  if (!b || typeof b !== 'object') return '';
  return typeof b.zh === 'string' ? b.zh : '';
}

function isFlowLayout(layout: MpStudioLayout | undefined): layout is MpStudioLayout {
  return !!layout && (layout.mode === 'row' || layout.mode === 'column');
}

function containerStyles(layout: MpStudioLayout | undefined): { flow: MpStudioLayout | null; outer: string; innerWrap: string } {
  if (!isFlowLayout(layout)) return { flow: null, outer: '', innerWrap: '' };
  const pad = Array.isArray(layout.padding) && layout.padding.length === 4 ? layout.padding : [0, 0, 0, 0];
  const t = pad[0] || 0;
  const r = pad[1] || 0;
  const b = pad[2] || 0;
  const l = pad[3] || 0;
  const padCss = t || r || b || l ? 'padding:' + rpx(t) + ' ' + rpx(r) + ' ' + rpx(b) + ' ' + rpx(l) + ';' : '';
  const align = ALIGN_CSS[layout.align] || 'flex-start';
  const justify = JUSTIFY_CSS[layout.justify] || 'flex-start';
  const gap = typeof layout.gap === 'number' && layout.gap > 0 ? layout.gap : 0;

  if (layout.mode === 'row' && layout.wrap && gap > 0) {
    const g = rpx(gap);
    return {
      flow: layout,
      outer: padCss + 'box-sizing:border-box;',
      innerWrap:
        'display:flex;flex-direction:row;flex-wrap:wrap;align-items:' +
        align +
        ';justify-content:' +
        justify +
        ';width:calc(100% + ' +
        g +
        ');margin-right:-' +
        g +
        ';margin-bottom:-' +
        g +
        ';box-sizing:border-box;',
    };
  }
  return {
    flow: layout,
    outer:
      'display:flex;flex-direction:' +
      (layout.mode === 'row' ? 'row' : 'column') +
      ';flex-wrap:' +
      (layout.wrap ? 'wrap' : 'nowrap') +
      ';' +
      padCss +
      'align-items:' +
      align +
      ';justify-content:' +
      justify +
      ';box-sizing:border-box;',
    innerWrap: '',
  };
}

function placeStyle(n: MpStudioNode, flow: MpStudioLayout | null, isLastVisible: boolean): string {
  let s = '';
  if (flow) {
    const sz = n.sizing || { w: 'fixed', h: 'fixed' };
    const row = flow.mode === 'row';
    const main = row ? sz.w : sz.h;
    const cross = row ? sz.h : sz.w;
    s += 'position:relative;box-sizing:border-box;';
    if (main === 'fixed') {
      s += (row ? 'width:' + rpx(n.w) : 'height:' + rpx(n.h)) + ';flex-shrink:0;';
    } else if (main === 'fill') {
      s += 'flex:1 1 0%;' + (row ? 'min-width:0;' : 'min-height:0;');
    } else {
      s += 'flex-shrink:0;';
    }
    if (cross === 'fixed') {
      s += (row ? 'height:' + rpx(n.h) : 'width:' + rpx(n.w)) + ';';
    } else if (cross === 'fill') {
      s += 'align-self:stretch;';
    }
    const gap = typeof flow.gap === 'number' && flow.gap > 0 ? flow.gap : 0;
    if (gap > 0) {
      if (row && flow.wrap) {
        s += 'margin-right:' + rpx(gap) + ';margin-bottom:' + rpx(gap) + ';';
      } else if (!isLastVisible) {
        s += (row ? 'margin-right:' : 'margin-bottom:') + rpx(gap) + ';';
      }
    }
  } else {
    s += 'position:absolute;left:' + rpx(n.x) + ';top:' + rpx(n.y) + ';width:' + rpx(n.w) + ';height:' + rpx(n.h) + ';box-sizing:border-box;';
  }
  if (typeof n.opacity === 'number' && n.opacity < 1) s += 'opacity:' + n.opacity + ';';
  if (typeof n.rotate === 'number' && n.rotate !== 0) s += 'transform:rotate(' + n.rotate + 'deg);';
  return s;
}

function boxStyle(n: MpStudioBoxFields, isEllipse: boolean): string {
  let s = 'box-sizing:border-box;';
  const fill = studioColor(n.fill);
  if (fill) s += 'background-color:' + fill + ';';
  const stroke = studioColor(n.stroke);
  if (stroke && typeof n.strokeWidth === 'number' && n.strokeWidth > 0) {
    s += 'border:' + rpx(n.strokeWidth) + ' solid ' + stroke + ';';
  }
  if (isEllipse) {
    s += 'border-radius:50%;';
  } else if (typeof n.radius === 'number' && n.radius > 0) {
    s += 'border-radius:' + rpx(n.radius) + ';';
  }
  const sh = SHADOW_RPX[n.shadow] || '';
  if (sh) s += 'box-shadow:' + sh + ';';
  return s;
}

function textStyle(n: MpStudioTextFields): string {
  const justify = n.valign === 'middle' ? 'center' : n.valign === 'bottom' ? 'flex-end' : 'flex-start';
  const font = n.font === 'en' ? 'var(--font-en)' : 'var(--font-zh)';
  const color = studioColor(n.color);
  let s =
    'display:flex;flex-direction:column;justify-content:' +
    justify +
    ';font-family:' +
    font +
    ';font-size:' +
    rpx(n.size) +
    ';font-weight:' +
    n.weight +
    ';line-height:' +
    rpx(n.size * n.lineHeight) +
    ';letter-spacing:' +
    (n.letterSpacing || 0) +
    'em;text-align:' +
    n.align +
    ';white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow:hidden;';
  if (color) s += 'color:' + color + ';';
  if (n.italic) s += 'font-style:italic;';
  if (n.underline) s += 'text-decoration:underline;';
  return s;
}

function isRenderableNode(n: MpStudioNode, screenKey: string, topLevel: boolean): boolean {
  if (!n || typeof n !== 'object' || n.hidden === true) return false;
  if (!KNOWN_NODE_TYPES[n.type]) return false;
  if (n.type === 'block') {
    if (!topLevel) return false;
    const allowed = SCREEN_BLOCKS[screenKey];
    return !!(allowed && allowed[n.block]);
  }
  return true;
}

function parseBannerProps(node: MpStudioBlockNode): RenderBannerProps {
  const p = node.props || {};
  const rawShade = typeof p.shade === 'number' && isFinite(p.shade) ? Math.max(0, Math.min(0.8, p.shade)) : 0.2;
  const top = Math.round(rawShade * 1000) / 1000;
  const mid = Math.round(rawShade * 0.2 * 1000) / 1000;
  const bot = Math.round(Math.min(0.85, rawShade * 1.6) * 1000) / 1000;
  return {
    shade: rawShade,
    shadeStyle:
      rawShade <= 0
        ? 'background:none;'
        : 'background:linear-gradient(180deg, rgba(28, 26, 23, ' +
          top +
          ') 0%, rgba(28, 26, 23, ' +
          mid +
          ') 40%, rgba(28, 26, 23, ' +
          bot +
          ') 100%);',
    wordmark: typeof p.wordmark === 'boolean' ? p.wordmark : true,
    autoplay: typeof p.autoplay === 'boolean' ? p.autoplay : true,
  };
}

function parseStoreProps(node: MpStudioBlockNode): RenderStoreProps {
  const p = node.props || {};
  const cardBg = typeof p.card === 'string' ? studioColor(p.card) : 'var(--surface)';
  return {
    cardBg,
    cardStyle: cardBg ? 'background-color:' + cardBg + ';' : '',
    buttons: typeof p.buttons === 'boolean' ? p.buttons : true,
  };
}

function parseMemberCardProps(node: MpStudioBlockNode): RenderMemberCardProps {
  const p = node.props || {};
  const from = (typeof p.from === 'string' && studioColor(p.from)) || 'var(--card-a)';
  const to = (typeof p.to === 'string' && studioColor(p.to)) || 'var(--card-b)';
  const ink = (typeof p.ink === 'string' && studioColor(p.ink)) || 'var(--card-ink)';
  return {
    from,
    to,
    ink,
    cardStyle:
      'color:' +
      ink +
      ';background:radial-gradient(120% 90% at 100% 0%, rgba(235, 222, 202, 0.36) 0%, rgba(235, 222, 202, 0) 55%), linear-gradient(150deg, ' +
      to +
      ', ' +
      from +
      ');',
  };
}

function buildNodeList(
  nodes: MpStudioNode[],
  flow: MpStudioLayout | null,
  screenKey: string,
  topLevel: boolean,
  fieldCtx: MpFieldContext,
  assetUrl: (id: string) => string,
  outBlocks: { banner: RenderBannerProps; store: RenderStoreProps; memberCard: RenderMemberCardProps },
): RenderNode[] {
  const seenSlots: Record<string, boolean> = {};
  const visible = nodes.filter((n) => {
    if (!isRenderableNode(n, screenKey, topLevel)) return false;
    if (n.type === 'block') {
      const slot = SCREEN_BLOCKS[screenKey]![n.block]!;
      if (seenSlots[slot]) return false;
      seenSlots[slot] = true;
    }
    return true;
  });
  const result: RenderNode[] = [];

  for (let i = 0; i < visible.length; i++) {
    const n = visible[i]!;
    const last = i === visible.length - 1;
    const place = placeStyle(n, flow, last);

    switch (n.type) {
      case 'block': {
        const slot = SCREEN_BLOCKS[screenKey]![n.block]!;
        if (n.block === 'mp.banner') outBlocks.banner = parseBannerProps(n);
        else if (n.block === 'mp.store') outBlocks.store = parseStoreProps(n);
        else if (n.block === 'mp.memberCard') outBlocks.memberCard = parseMemberCardProps(n);
        result.push({
          id: n.id,
          type: 'block',
          style: place,
          innerWrapStyle: '',
          text: '',
          imageSrc: '',
          imageMode: 'aspectFill',
          hasAction: false,
          action: null,
          blockKey: n.block,
          blockSlot: slot,
          children: [],
        });
        break;
      }
      case 'rect':
      case 'ellipse': {
        result.push({
          id: n.id,
          type: n.type,
          style: place + boxStyle(n, n.type === 'ellipse'),
          innerWrapStyle: '',
          text: '',
          imageSrc: '',
          imageMode: 'aspectFill',
          hasAction: false,
          action: null,
          blockKey: '',
          blockSlot: '',
          children: [],
        });
        break;
      }
      case 'frame': {
        const inner = containerStyles(n.layout);
        const clipCss = n.clip ? 'overflow:hidden;' : '';
        const act = n.action && typeof n.action.action === 'string' ? { action: n.action.action, arg: n.action.arg || '' } : null;
        result.push({
          id: n.id,
          type: 'frame',
          style: place + boxStyle(n, false) + clipCss + inner.outer,
          innerWrapStyle: inner.innerWrap,
          text: '',
          imageSrc: '',
          imageMode: 'aspectFill',
          hasAction: !!act,
          action: act,
          blockKey: '',
          blockSlot: '',
          children: buildNodeList(Array.isArray(n.children) ? n.children : [], inner.flow, screenKey, false, fieldCtx, assetUrl, outBlocks),
        });
        break;
      }
      case 'image': {
        const fill = studioColor(n.fill);
        const bgCss = fill ? 'background-color:' + fill + ';' : '';
        const radCss = typeof n.radius === 'number' && n.radius > 0 ? 'border-radius:' + rpx(n.radius) + ';' : '';
        const act = n.action && typeof n.action.action === 'string' ? { action: n.action.action, arg: n.action.arg || '' } : null;
        result.push({
          id: n.id,
          type: 'image',
          style: place + bgCss + radCss + 'overflow:hidden;',
          innerWrapStyle: '',
          text: '',
          imageSrc: typeof n.asset === 'string' ? assetUrl(n.asset) : '',
          imageMode: IMAGE_MODE[n.fit] || 'aspectFill',
          hasAction: !!act,
          action: act,
          blockKey: '',
          blockSlot: '',
          children: [],
        });
        break;
      }
      case 'text': {
        const fill = studioColor(n.fill);
        const bgCss = fill ? 'background-color:' + fill + ';' : '';
        result.push({
          id: n.id,
          type: 'text',
          style: place + textStyle(n) + bgCss,
          innerWrapStyle: '',
          text: pickZh(n.text),
          imageSrc: '',
          imageMode: 'aspectFill',
          hasAction: false,
          action: null,
          blockKey: '',
          blockSlot: '',
          children: [],
        });
        break;
      }
      case 'field': {
        const fill = studioColor(n.fill);
        const bgCss = fill ? 'background-color:' + fill + ';' : '';
        result.push({
          id: n.id,
          type: 'field',
          style: place + textStyle(n) + bgCss,
          innerWrapStyle: '',
          text: pickZh(n.prefix) + resolveMpField(n.field, fieldCtx) + pickZh(n.suffix),
          imageSrc: '',
          imageMode: 'aspectFill',
          hasAction: false,
          action: null,
          blockKey: '',
          blockSlot: '',
          children: [],
        });
        break;
      }
      case 'button': {
        const act = n.action && typeof n.action.action === 'string' ? { action: n.action.action, arg: n.action.arg || '' } : null;
        result.push({
          id: n.id,
          type: 'button',
          style: place + boxStyle(n, false) + textStyle(n) + 'padding-left:24rpx;padding-right:24rpx;',
          innerWrapStyle: '',
          text: pickZh(n.text),
          imageSrc: '',
          imageMode: 'aspectFill',
          hasAction: !!act,
          action: act,
          blockKey: '',
          blockSlot: '',
          children: [],
        });
        break;
      }
      default:
        break;
    }
  }
  return result;
}

/** 把一屏节点转换成 WXML 直接能画的结构；这一屏不存在时返回 null */
export function prepareScreenRender(
  doc: MpStudioDoc | null | undefined,
  screenKey: 'home' | 'activity' | 'member',
  fieldCtx: MpFieldContext,
  assetUrl: (id: string) => string,
): RenderScreen | null {
  if (!doc || !doc.screens) return null;
  const screen = doc.screens[screenKey];
  if (!screen || !Array.isArray(screen.nodes)) return null;

  const height = typeof screen.height === 'number' && screen.height > 0 ? screen.height : 812;
  const bg = studioColor(screen.background || '$bg') || 'var(--bg)';
  const cont = containerStyles(screen.layout);
  const baseStyle =
    'position:relative;width:750rpx;' +
    (cont.flow ? 'min-height:' + rpx(height) + ';' + cont.outer : 'height:' + rpx(height) + ';overflow:hidden;box-sizing:border-box;') +
    'background-color:' +
    bg +
    ';color:var(--ink);font-family:var(--font-zh);';

  const blocks = {
    banner: { ...DEFAULT_BANNER_PROPS },
    store: { ...DEFAULT_STORE_PROPS },
    memberCard: { ...DEFAULT_MEMBER_CARD_PROPS },
  };
  const nodes = buildNodeList(screen.nodes, cont.flow, screenKey, true, fieldCtx, assetUrl, blocks);

  return {
    screenKey,
    style: baseStyle,
    innerWrapStyle: cont.innerWrap,
    nodes,
    bannerProps: blocks.banner,
    storeProps: blocks.store,
    memberCardProps: blocks.memberCard,
  };
}

export interface StudioActionOptions {
  store?: MpStore | null;
  cardFrozen?: boolean;
  currentRoute?: string;
}

/** 执行版面节点上的动作（docs/STUDIO_MP.md 第 3.8 节）；不认识的动作或参数不做事 */
export function runMpStudioAction(action: MpStudioAction | null | undefined, opts: StudioActionOptions = {}): void {
  if (!action || typeof action.action !== 'string') return;
  const arg = typeof action.arg === 'string' ? action.arg : '';
  if (action.action === 'open.page') {
    const tab = TAB_PAGES[arg];
    if (tab) {
      wx.switchTab({ url: tab });
      return;
    }
    const sub = SUB_PAGES[arg];
    if (!sub) return;
    if (arg === 'code' && opts.cardFrozen) {
      wx.showToast({ title: '会员已冻结，会员码用不了，请到前台咨询', icon: 'none' });
      return;
    }
    if (opts.currentRoute && '/' + opts.currentRoute.replace(/^\/+/, '') === sub) return;
    wx.navigateTo({ url: sub });
    return;
  }
  if (action.action === 'call.store') {
    const s = opts.store;
    if (!s || !s.phone) return;
    const phoneNumber = s.phone.replace(/[^\d+-]/g, '');
    if (!phoneNumber) return;
    wx.makePhoneCall({ phoneNumber }).catch(() => undefined);
    return;
  }
  if (action.action === 'nav.store') {
    const s = opts.store;
    if (!s || s.latitude === null || s.longitude === null) return;
    wx.openLocation({
      latitude: s.latitude,
      longitude: s.longitude,
      name: '汤崎 TOUCHILL ' + s.name,
      address: s.address,
      scale: 16,
    });
  }
}
