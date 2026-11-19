// 平板电子菜单 11 种版式的「卡片模板」（8.1.2，GZ13，docs/WORKBENCH_V811.md 第 7、13 节）：每一种版式里有哪几块（照片、
// 特写图、一道菜的文字、竖排小标题、封面标题、介绍、文字陈列的一行），各在哪、多大——数字照设计稿一处处量的
// （原来写在 features/emenu/pages.tsx 里，8.1.2 抽到这里，平板与编辑器都读这一份），放大一档另有一套。
//
// 设计师在工作台里挪、拉某一块，版面里只存改过的那几项（templates[版式][块][原样 / 放大]）；没改的照这里的数，
// 所以没改过的版面与以前逐屏一致。文字块的高跟着内容走，这里的 h 只是编辑器里画框用。

import type { EmenuLayout } from '../emenu';
import type { StudioDishState, StudioDishStateStyle, StudioDoc, StudioSlotOverride } from './format';

export type EmenuSlotKind = 'photo' | 'text' | 'title' | 'coverTitle' | 'intro' | 'row' | 'logo' | 'cats' | 'icon' | 'tag';

/**
 * 放大一档的位置：没写的沿用原样的；文字块写了 bottom 是「下沿贴在这条线上、往上长」。
 * 宽、高都是放大以后在平板上看到的大小（文字里面按放大的倍数缩回去排）。
 */
export interface EmenuBigSpot {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  bottom?: number;
  /** 介绍最多几行（默认 4） */
  lines?: number;
}

/**
 * 加号与菜名的间距（8.1.5，PP5）：按加号自己的大小算几倍。加号紧跟在菜名后面；地方不够时间距往下收（最少 1 倍），菜名不被挤断。
 * 8.1.14（品牌部《工作台需求汇总 1.2》第 2 条，PENDING_DECISIONS.md PC2）：「大图 + 文字」右边的六格与「文字陈列」的十行（text）
 * 2 倍，其余版式（photo：封面、单菜、两菜、三菜）3.5 倍——3.5 就是设计稿原来的间距（44.2 ÷ 12.6）。8.1.5 到 8.1.13 是 4.5 / 2.5
 */
export const EMENU_PLUS_GAP = { photo: 3.5, text: 2 } as const;
export type EmenuPlusKind = keyof typeof EMENU_PLUS_GAP;

export interface EmenuSlotDef {
  key: string;
  label: string;
  kind: EmenuSlotKind;
  /** 原样一档：位置与大小（文字块的 h 只用来在编辑器里画框） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 放大一档另给的（没写的沿用原样的） */
  big?: EmenuBigSpot;
  /** 一道菜的文字：介绍怎么排（normal 正常、tight 紧、none 不要介绍）；加号与菜名的间距按哪一种算（默认带图片的） */
  desc?: 'normal' | 'tight' | 'none';
  plus?: EmenuPlusKind;
  /** 照片位：用菜品的哪张图（image 餐品图、detail 特写图）；tint 第二张浅一点的底色 */
  source?: 'image' | 'detail';
  tint?: boolean;
  /** 第几道菜（从 0 起） */
  dish?: number;
}

export interface EmenuTemplateDef {
  layout: EmenuLayout | typeof EMENU_HEADER_LAYOUT;
  slots: readonly EmenuSlotDef[];
}

const photo = (key: string, label: string, dish: number, x: number, y: number, w: number, h: number, more: Partial<EmenuSlotDef> = {}): EmenuSlotDef => ({
  key,
  label,
  kind: 'photo',
  dish,
  x,
  y,
  w,
  h,
  source: 'image',
  ...more,
});
const text = (key: string, label: string, dish: number, x: number, y: number, w: number, desc: EmenuSlotDef['desc'], big: EmenuBigSpot, more: Partial<EmenuSlotDef> = {}): EmenuSlotDef => ({
  key,
  label,
  kind: 'text',
  dish,
  x,
  y,
  w,
  h: desc === 'none' ? 56 : desc === 'tight' ? 104 : 120,
  desc,
  big,
  ...more,
});

/** 图文列表（list_image）六格的位置：两列三行 */
const LIST_IMAGE_COLS = [636.9, 823.8] as const;
const LIST_IMAGE_ROWS = [257.7, 350.9, 443] as const;
const LIST_IMAGE_BIG_COLS = [566, 778] as const;
const LIST_IMAGE_BIG_ROWS = [256, 392, 528] as const;
/** 文字陈列（list_text）十行：两列五行，行距不是整数（设计稿量的 89.6–90） */
export const TEXT_ROWS = [174.6, 264.2, 354.1, 444, 534] as const;
const TRIO_MIXED = [
  { x: 40, w: 386.2, h: 281.6, textY: 447.6 },
  { x: 469.1, w: 300.4, h: 406.4, textY: 572.7 },
  { x: 812.4, w: 171.6, h: 234.4, textY: 401.6 },
] as const;

export const EMENU_TEMPLATES: Record<EmenuLayout, EmenuTemplateDef> = {
  cover: {
    layout: 'cover',
    slots: [
      // 封面标题：中文 48 号在 (37.4, 218.5)；英文为主时大标题在 (38.6, 222.5)、小字在 (40, 274)——一起挪
      { key: 'title', label: '分类大标题', kind: 'coverTitle', x: 37.4, y: 218.5, w: 480, h: 72 },
      text('text', '菜名、介绍、价格', 0, 40, 344, 420, 'normal', { bottom: 485, w: 429 }),
      photo('detail', '特写图', 0, 40, 509.1, 429.1, 218.9, { source: 'detail' }),
      photo('photo', '餐品图', 0, 555.5, 133.8, 428.5, 594.2),
    ],
  },
  list_image: {
    layout: 'list_image',
    slots: [
      photo('photo', '餐品图', 0, 40, 133.8, 428.5, 594.2),
      { key: 'title', label: '竖排小标题', kind: 'title', x: 577.4, y: 254, w: 40, h: 110, big: { x: 524, y: 252 } },
      // 这六格没有自己的图：加号与菜名的间距按纯文字的算（8.1.5，PP5；原来加号按列对齐）
      ...Array.from({ length: 6 }, (_, i) =>
        text(
          `d${i}`,
          `第 ${i + 1} 道`,
          i,
          LIST_IMAGE_COLS[i % 2]!,
          LIST_IMAGE_ROWS[Math.floor(i / 2)]!,
          170,
          'none',
          { x: LIST_IMAGE_BIG_COLS[i % 2]!, y: LIST_IMAGE_BIG_ROWS[Math.floor(i / 2)]!, w: 206 },
          { plus: 'text' },
        ),
      ),
    ],
  },
  single_wide: {
    layout: 'single_wide',
    slots: [
      photo('photo', '餐品图', 0, 40, 133.8, 944, 359.6),
      text('text', '菜名、价格', 0, 39.7, 525.8, 420, 'none', { y: 522, w: 440 }),
      // 介绍：原样 9 号、最多 5 行；放大一档绕 (512, 520) 放大 1.4 倍、最多 6 行（w 是放大以后看到的宽：337 × 1.4）
      { key: 'intro', label: '介绍', kind: 'intro', x: 512, y: 523.4, w: 392, h: 66, big: { y: 520, w: 471.8, h: 114 } },
    ],
  },
  single_left: {
    layout: 'single_left',
    slots: [
      photo('photo', '餐品图', 0, 40, 133.8, 428.5, 594.2),
      photo('detail', '特写图', 0, 812.4, 133.8, 171.6, 203.1, { source: 'detail' }),
      text('text', '菜名、介绍、价格', 0, 554.9, 464.5, 420, 'normal', { y: 440, w: 429 }),
    ],
  },
  single_right: {
    layout: 'single_right',
    slots: [
      text('text', '菜名、介绍、价格', 0, 210.9, 275.2, 330, 'normal', { x: 130, y: 250, w: 400 }),
      photo('detail', '特写图', 0, 40, 524.9, 171.6, 203.1, { source: 'detail' }),
      photo('photo', '餐品图', 0, 555.5, 133.8, 428.5, 594.2),
    ],
  },
  duo_stagger: {
    layout: 'duo_stagger',
    slots: [
      photo('a.photo', '第 1 道的图', 0, 40, 133.8, 429.1, 296.7),
      text('a.text', '第 1 道的文字', 0, 40, 464.6, 420, 'normal', { y: 458, w: 429 }),
      text('b.text', '第 2 道的文字', 1, 640.7, 182.9, 343, 'normal', { bottom: 313, lines: 3 }),
      photo('b.photo', '第 2 道的图', 1, 640.8, 337, 343.2, 391),
    ],
  },
  duo_row: {
    layout: 'duo_row',
    slots: [
      photo('a.photo', '第 1 道的图', 0, 40, 165.1, 386.2, 359.6),
      photo('b.photo', '第 2 道的图', 1, 426.2, 165.1, 557.8, 359.6, { tint: true }),
      text('a.text', '第 1 道的文字', 0, 39.7, 557.1, 370, 'none', { y: 552 }),
      text('b.text', '第 2 道的文字', 1, 426.2, 557.1, 420, 'none', { y: 552, w: 540 }),
    ],
  },
  duo_mixed: {
    layout: 'duo_mixed',
    slots: [
      text('a.text', '第 1 道的文字', 0, 40, 256.1, 420, 'tight', { bottom: 344, w: 540 }),
      photo('a.photo', '第 1 道的图', 0, 40, 368.4, 557.8, 359.6),
      photo('b.photo', '第 2 道的图', 1, 769.5, 133.8, 214.5, 265.6),
      text('b.text', '第 2 道的文字', 1, 769.5, 431.6, 214.5, 'tight', { y: 426 }),
    ],
  },
  trio_row: {
    layout: 'trio_row',
    slots: [125.8, 426.2, 726.5].flatMap((x, i) => [
      photo(`${'abc'[i]}.photo`, `第 ${i + 1} 道的图`, i, x, 165.1, 257.6, 343.9),
      text(`${'abc'[i]}.text`, `第 ${i + 1} 道的文字`, i, x, 542.1, 257.6, 'none', { y: 536 }),
    ]),
  },
  trio_mixed: {
    layout: 'trio_mixed',
    slots: TRIO_MIXED.flatMap((s, i) => [
      photo(`${'abc'[i]}.photo`, `第 ${i + 1} 道的图`, i, s.x, 133.8, s.w, s.h),
      text(`${'abc'[i]}.text`, `第 ${i + 1} 道的文字`, i, s.x, s.textY, s.w, 'none', { y: s.textY - 6 }),
    ]),
  },
  list_text: {
    layout: 'list_text',
    slots: [
      { key: 'title', label: '竖排小标题', kind: 'title', x: 307.8, y: 169.9, w: 40, h: 110, big: { x: 236, y: 156 } },
      ...Array.from(
        { length: 10 },
        (_, i): EmenuSlotDef => ({
          key: `r${i}`,
          label: `第 ${i + 1} 行`,
          kind: 'row',
          dish: i,
          x: i % 2 === 0 ? 403.7 : 755.1,
          y: TEXT_ROWS[Math.floor(i / 2)]!,
          w: 232,
          h: 74,
          big: { x: i % 2 === 0 ? 296 : 660, y: 150 + Math.floor(i / 2) * 112 },
        }),
      ),
    ],
  },
};

// ───────────────────────── 顶栏（8.1.6，docs/EMENU.md 第 15.8 节，QZ8、QZ9） ─────────────────────────
// 平板每一屏最上面那一条：字标、分类、中英切换、搜索、订单、手牌各是一块，设计师在工作台里单独挪、改大小、调间距。
// 数字照 features/emenu/header.tsx 原来写死的（8.1.5 的位置）：没改过顶栏的版面与以前逐像素一致。
// 字标、图标、手牌只能等比缩放（存宽、高两个数）；分类那一块是分类页签排开的范围，只改宽（高跟着字）。

/** 顶栏在 templates 里的名字（与 11 种版式并列） */
export const EMENU_HEADER_LAYOUT = 'header';
/** 顶栏那一条有多高（设计稿） */
export const EMENU_HEADER_H = 102;
/** 顶栏右边几样（切换图标、搜索、订单、手牌）与字标的中线 */
export const EMENU_HEADER_MID = 55.45;
/** 放大一档顶栏右边几样放大多少（= 平板 stage.tsx 的 BIG.ui，用例核对两边一致） */
export const EMENU_HEADER_BIG = 1.3;
/** 中英切换图标的边长（与手牌色块一样高） */
export const EMENU_LANG_ICON = 22.3;
/** 横排字标的宽高比（viewBox 79.809 × 15.441）、高是切换图标的几倍 */
export const EMENU_LOGO_RATIO = 79.809 / 15.441;
export const EMENU_LOGO_TO_ICON = 0.7;
/** 手牌色块原来的最小宽（里面的字长了往外长） */
export const EMENU_TAG_W = 85.8;

const K = EMENU_HEADER_BIG;
const MID = EMENU_HEADER_MID;
const ICON = EMENU_LANG_ICON;
const logoH = ICON * EMENU_LOGO_TO_ICON;
/** 放大一档绕中心放大的一块：中心 (cx, cy)、原样的宽高 → 看到的左上角与大小 */
const zoomed = (cx: number, cy: number, w: number, h: number): EmenuBigSpot => ({ x: cx - (w * K) / 2, y: cy - (h * K) / 2, w: w * K, h: h * K });

export const EMENU_HEADER_TEMPLATE: EmenuTemplateDef = {
  layout: EMENU_HEADER_LAYOUT,
  slots: [
    {
      key: 'logo',
      label: '字标',
      kind: 'logo',
      x: 40,
      y: MID - logoH / 2,
      w: logoH * EMENU_LOGO_RATIO,
      h: logoH,
      big: { x: 40, y: MID - (logoH * K) / 2, w: logoH * K * EMENU_LOGO_RATIO, h: logoH * K },
    },
    // 分类页签排开的范围：原来以 441 为中线、有中英切换时宽 528（放大一档 498）；按钮从 57 − 23 × 字的倍数开始、高 46 × 倍数
    { key: 'cats', label: '分类', kind: 'cats', x: 441 - 264, y: 34, w: 528, h: 46, big: { x: 441 - 249, y: 57 - 23 * K, w: 498, h: 46 * K } },
    // 中英切换：右边贴在 774（放大一档图标中心在 764.2 − 11.15 × 1.3）
    { key: 'lang', label: '中英切换', kind: 'icon', x: 774 - ICON, y: MID - ICON / 2, w: ICON, h: ICON, big: zoomed(764.2 - (ICON / 2) * K, MID, ICON, ICON) },
    // 搜索、订单：原样照设计稿的左上角；放大一档绕 (796, 中线) 与 (842, 中线) 放大
    { key: 'search', label: '搜索', kind: 'icon', x: 795.4, y: 45.4, w: 20.5, h: 20.5, big: zoomed(796, 45.4 + 20.5 / 2, 20.5, 20.5) },
    { key: 'order', label: '订单', kind: 'icon', x: 837.5, y: 45.2, w: 17.9, h: 20.4, big: zoomed(842, 45.2 + 20.4 / 2, 17.9, 20.4) },
    // 手牌：原样左边贴在 898.2、往右长；放大一档右边贴在 984、往左长（色块原来最小宽 85.8，里面的字长了往外长）
    { key: 'tag', label: '手牌', kind: 'tag', x: 898.2, y: 44.3, w: EMENU_TAG_W, h: ICON, big: { x: 984 - EMENU_TAG_W * K, y: MID - (ICON * K) / 2, w: EMENU_TAG_W * K, h: ICON * K } },
  ],
};

/** 平板菜单的卡片模板与顶栏（工作台、服务端核对用这一份） */
export const EMENU_ALL_TEMPLATES: Readonly<Record<string, EmenuTemplateDef>> = { ...EMENU_TEMPLATES, [EMENU_HEADER_LAYOUT]: EMENU_HEADER_TEMPLATE };

/** 顶栏里只能等比缩放的块（字标、图标、手牌）：宽高比 */
export const headerSlotRatio = (def: EmenuSlotDef): number | null => (def.kind === 'logo' || def.kind === 'icon' || def.kind === 'tag' ? def.w / def.h : null);

export type EmenuSlotMode = 'design' | 'big';

/** 一块在一档里的位置；bottom 是放大一档里「下沿贴线、往上长」的文字块（这时 y 不算数） */
export interface EmenuSlotSpot {
  x: number;
  y: number;
  w: number;
  h: number;
  bottom?: number;
}

/** 一块叠上改动以后：原样一档的位置，放大一档另给的（没写的沿用原样的），藏没藏，照片的圆角 */
export interface ResolvedSlot {
  def: EmenuSlotDef;
  x: number;
  y: number;
  w: number;
  h: number;
  big?: EmenuBigSpot;
  hidden: boolean;
}

/** 一块叠上版面里的改动（templates[版式][块]）以后在哪：放大一档改了 y 的不再往上长，改了下沿的照旧往上长 */
export function resolveSlot(def: EmenuSlotDef, o: StudioSlotOverride | undefined): ResolvedSlot {
  const d = o?.design;
  let big = def.big;
  if (o?.big) {
    const b = o.big;
    big = { ...def.big };
    if (b.x !== undefined) big.x = b.x;
    if (b.y !== undefined) {
      big.y = b.y;
      delete big.bottom;
    }
    if (b.bottom !== undefined) {
      big.bottom = b.bottom;
      delete big.y;
    }
    if (b.w !== undefined) big.w = b.w;
    if (b.h !== undefined) big.h = b.h;
  }
  // 照片的圆角（8.1.2 加的 radius）从 8.1.8 起不生效：品牌部要求图片一律直角（PENDING_DECISIONS.md PB3），这里不再带出
  return { def, x: d?.x ?? def.x, y: d?.y ?? def.y, w: d?.w ?? def.w, h: d?.h ?? def.h, big, hidden: !!o?.hidden };
}

/** 一块在一档里的位置（放大一档没写的沿用原样一档的，原样一档改了也跟着） */
export function slotSpot(s: ResolvedSlot, mode: EmenuSlotMode): EmenuSlotSpot {
  if (mode === 'design' || !s.big) return { x: s.x, y: s.y, w: s.w, h: s.h };
  const b = s.big;
  return { x: b.x ?? s.x, y: b.y ?? s.y, w: b.w ?? s.w, h: b.h ?? s.h, ...(b.bottom !== undefined ? { bottom: b.bottom } : {}) };
}

/** 这一块在设计稿原样 / 放大一档里的位置（照登记的，没加改动） */
export function slotDefault(def: EmenuSlotDef, mode: EmenuSlotMode): EmenuSlotSpot {
  return slotSpot(resolveSlot(def, undefined), mode);
}

export const findSlotDef = (layout: string, key: string): EmenuSlotDef | undefined => (EMENU_ALL_TEMPLATES as Record<string, EmenuTemplateDef | undefined>)[layout]?.slots.find((s) => s.key === key);

type Templates = NonNullable<StudioDoc['templates']>;

/**
 * 把一块的改动写回版面：空了的一档、一块、一种版式都去掉（全恢复默认时版面里没有 templates 这一项，与没改过一样）。
 * 以前存的照片圆角（radius）写回时去掉（8.1.8 起照片一律直角）：改过的那一块存下来就干净了。
 */
function writeOverride(doc: StudioDoc, layout: string, key: string, o: StudioSlotOverride): StudioDoc {
  const clean: StudioSlotOverride = {};
  for (const mode of ['design', 'big'] as const) if (o[mode] && Object.keys(o[mode]!).length) clean[mode] = o[mode];
  if (o.hidden) clean.hidden = true;
  const all: Templates = { ...doc.templates };
  const slots = { ...all[layout] };
  if (Object.keys(clean).length) slots[key] = clean;
  else delete slots[key];
  if (Object.keys(slots).length) all[layout] = slots;
  else delete all[layout];
  const next: StudioDoc = { ...doc, templates: all };
  if (!Object.keys(all).length) delete next.templates;
  return next;
}

/**
 * 把一块在一档里挪到 / 改成 next：只存与「这一档没改时」不一样的项（放大一档没改时跟着原样一档）。
 * 写了 y 的改成从上往下排（去掉下沿），写了 bottom 的照旧往上长（去掉 y）。
 */
export function setSlotSpot(doc: StudioDoc, layout: string, key: string, mode: EmenuSlotMode, next: Partial<EmenuSlotSpot>): StudioDoc {
  const def = findSlotDef(layout, key);
  if (!def) return doc;
  const o = doc.templates?.[layout]?.[key] ?? {};
  const base = slotSpot(resolveSlot(def, { ...o, [mode]: undefined }), mode);
  const patch: NonNullable<StudioSlotOverride['design']> = { ...o[mode] };
  for (const f of ['x', 'w', 'h'] as const) {
    const v = next[f];
    if (v === undefined) continue;
    if (v === base[f]) delete patch[f];
    else patch[f] = v;
  }
  if (next.y !== undefined) {
    delete patch.bottom;
    if (next.y === base.y && base.bottom === undefined) delete patch.y;
    else patch.y = next.y;
  }
  if (next.bottom !== undefined) {
    delete patch.y;
    if (next.bottom === base.bottom) delete patch.bottom;
    else patch.bottom = next.bottom;
  }
  return writeOverride(doc, layout, key, { ...o, [mode]: patch });
}

/** 藏起来 / 显示（两档一起）。照片的圆角 8.1.8 起不再有（PB3） */
export function setSlotFlags(doc: StudioDoc, layout: string, key: string, flags: { hidden?: boolean }): StudioDoc {
  if (!findSlotDef(layout, key)) return doc;
  const o = { ...doc.templates?.[layout]?.[key] };
  if (flags.hidden !== undefined) o.hidden = flags.hidden;
  return writeOverride(doc, layout, key, o);
}

/** 恢复默认：一块的一档（mode）或整块（不给 mode：两档、藏都去掉） */
export function resetSlot(doc: StudioDoc, layout: string, key: string, mode?: EmenuSlotMode): StudioDoc {
  const o = doc.templates?.[layout]?.[key];
  if (!o) return doc;
  return writeOverride(doc, layout, key, mode ? { ...o, [mode]: undefined } : {});
}

/** 一种版式整个恢复默认 */
export function resetLayoutTemplate(doc: StudioDoc, layout: string): StudioDoc {
  if (!doc.templates?.[layout]) return doc;
  const all = { ...doc.templates };
  delete all[layout];
  const next: StudioDoc = { ...doc, templates: all };
  if (!Object.keys(all).length) delete next.templates;
  return next;
}

/** 能藏起来的块：照片、特写图、小标题、介绍（菜名、价格、加号所在的文字块不能藏：藏了客人点不了） */
export const slotHideable = (def: EmenuSlotDef) => def.kind === 'photo' || def.kind === 'title' || def.kind === 'intro' || def.kind === 'coverTitle';
/** 能改宽的块：照片、文字、介绍（竖排小标题、封面标题、文字陈列的一行只能挪） */
export const slotResizable = (def: EmenuSlotDef): { w: boolean; h: boolean } => {
  // 顶栏（8.1.6）：字标、图标、手牌等比缩放（宽高一起），分类那一块只改宽
  if (def.kind === 'logo' || def.kind === 'icon' || def.kind === 'tag') return { w: true, h: true };
  if (def.kind === 'cats') return { w: true, h: false };
  return { w: def.kind === 'photo' || def.kind === 'text' || def.kind === 'intro', h: def.kind === 'photo' };
};

// ───────────────────────── 菜的几种状态（变体） ─────────────────────────

/** 设计稿里三种状态的样子：照片压暗 55% 的黑、浅色字居中两行；没有图的文字变浅一半 */
export const DISH_STATE_DEFAULT: Required<StudioDishStateStyle> = { style: 'center', shade: '#000000', shadeOpacity: 0.55, textColor: '#F4F3F2', textOpacity: 0.5, grayscale: false };

export const DISH_STATE_LABELS: Record<StudioDishState, string> = { sold_out: '已售罄', closed: '当前时段不可售', off: '已下架' };

/** 一种状态叠上改动以后的样子 */
export function dishStateStyle(states: StudioDoc['dishStates'] | null | undefined, state: StudioDishState): Required<StudioDishStateStyle> {
  return { ...DISH_STATE_DEFAULT, ...states?.[state] };
}

/** 改一种状态的样子：与设计稿一样的项去掉，全去掉时版面里没有 dishStates */
export function setDishState(doc: StudioDoc, state: StudioDishState, patch: StudioDishStateStyle): StudioDoc {
  const cur: StudioDishStateStyle = { ...doc.dishStates?.[state], ...patch };
  for (const k of Object.keys(cur) as (keyof StudioDishStateStyle)[]) if (cur[k] === undefined || cur[k] === DISH_STATE_DEFAULT[k]) delete cur[k];
  const all = { ...doc.dishStates };
  if (Object.keys(cur).length) all[state] = cur;
  else delete all[state];
  const next: StudioDoc = { ...doc, dishStates: all };
  if (!Object.keys(all).length) delete next.dishStates;
  return next;
}
