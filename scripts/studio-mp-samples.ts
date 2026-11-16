// 给小程序线的样例版面（8.1.2，docs/STUDIO_MP.md 第 7 节）：几份小程序版面，覆盖格式里的每一种节点、排列与样式。
// 小程序线照 docs/STUDIO_MP.md 写渲染组件，把这几份画出来，与 tests/fixtures/studio/mp/*.png（本仓库的 React 渲染器在 375 宽、
// 两倍像素下的截图）逐张比对。
//
//   npx tsx scripts/studio-mp-samples.ts          重新生成 tests/fixtures/studio/mp/*.json 与样例图（格式改了以后跑一遍）
//   截图：node scripts/studio-mp-shots.mjs        （要开着的应用，见那个文件的说明）
// tests/studio-mp-samples.test.ts 核对仓库里的 JSON 与这里生成的一致、都合格式、检查没有红的。

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { checkStudioDoc, defaultStudioDoc, DocSchema, validateStudioDoc, type StudioDoc, type StudioLayout, type StudioNode } from '../src/shared/studio';

export interface MpSample {
  /** 文件名（不带后缀） */
  name: string;
  /** 画哪一屏 */
  screen: string;
  /** 这一份看什么 */
  note: string;
  doc: StudioDoc;
}

// ── 一张确定的样例图（海报）：360×200 的渐变加一个圆，每次生成的字节一样 ──
function png(w: number, h: number, f: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function samplePoster(): { id: string; bytes: Buffer } {
  const bytes = png(360, 200, (x, y) => {
    const inCircle = (x - 270) ** 2 + (y - 70) ** 2 < 42 ** 2;
    if (inCircle) return [235, 222, 202];
    const t = (x + y) / 560;
    return [Math.round(147 - 60 * t), Math.round(112 - 48 * t), Math.round(81 - 34 * t)];
  });
  return { id: createHash('sha256').update(bytes).digest('hex'), bytes };
}

// ── 节点的简写（照格式把每一项都写全，小程序那边读到的就是这个样子） ──
const at = (x = 0, y = 0, w = 0, h = 0) => ({ name: '', x, y, w, h, rotate: 0, opacity: 1, hidden: false, locked: false });
const flow = (
  mode: 'row' | 'column',
  gap: number,
  padding: [number, number, number, number],
  align: StudioLayout['align'] = 'start',
  justify: StudioLayout['justify'] = 'start',
  wrap = false,
): StudioLayout => ({ mode, wrap, gap, padding, align, justify });
const textStyle = {
  font: 'zh' as const,
  size: 14,
  weight: 400 as const,
  color: '$ink',
  align: 'left' as const,
  valign: 'top' as const,
  lineHeight: 1.4,
  letterSpacing: 0,
  italic: false,
  underline: false,
};
type Over = Record<string, unknown>;
const text = (id: string, zh: string, more: Over = {}): StudioNode =>
  ({ type: 'text', id, ...at(0, 0, 339, 20), sizing: { w: 'fill', h: 'hug' }, text: { zh, en: '' }, ...textStyle, fill: null, ...more }) as StudioNode;
const rect = (id: string, w: number, h: number, more: Over = {}): StudioNode =>
  ({ type: 'rect', id, ...at(0, 0, w, h), sizing: { w: 'fixed', h: 'fixed' }, fill: '$wood', stroke: null, strokeWidth: 0, radius: 4, shadow: 'none', ...more }) as StudioNode;
const frame = (id: string, layout: StudioLayout | undefined, children: StudioNode[], more: Over = {}): StudioNode =>
  ({
    type: 'frame',
    id,
    ...at(0, 0, 339, 0),
    sizing: { w: 'fill', h: 'hug' },
    fill: null,
    stroke: null,
    strokeWidth: 0,
    radius: 0,
    shadow: 'none',
    clip: false,
    ...(layout ? { layout } : {}),
    children,
    ...more,
  }) as StudioNode;
const button = (id: string, zh: string, action: { action: string; arg: string } | null, more: Over = {}): StudioNode =>
  ({
    type: 'button',
    id,
    ...at(0, 0, 160, 44),
    sizing: { w: 'fill', h: 'fixed' },
    fill: '$wood',
    stroke: null,
    strokeWidth: 0,
    radius: 8,
    shadow: 'none',
    text: { zh, en: '' },
    ...textStyle,
    size: 15,
    weight: 600,
    color: '#FFFFFF',
    align: 'center',
    valign: 'middle',
    letterSpacing: 0.04,
    ...(action ? { action } : {}),
    ...more,
  }) as StudioNode;
const field = (id: string, key: string, more: Over = {}): StudioNode =>
  ({ type: 'field', id, ...at(0, 0, 339, 20), sizing: { w: 'fill', h: 'hug' }, field: key, prefix: { zh: '', en: '' }, suffix: { zh: '', en: '' }, ...textStyle, fill: null, ...more }) as StudioNode;

/** 换掉一屏（其余照默认版面） */
function withScreen(screen: string, nodes: StudioNode[], layout: StudioLayout | undefined, extra: { background?: string | null; height?: number } = {}): StudioDoc {
  const doc = defaultStudioDoc('mp');
  doc.screens[screen] = { background: extra.background ?? '$bg', ...(extra.height ? { height: extra.height } : {}), ...(layout ? { layout } : {}), nodes };
  return doc;
}

export function buildMpSamples(): MpSample[] {
  const poster = samplePoster();
  const activity: StudioNode[] = [
    { type: 'image', id: 'poster', ...at(0, 0, 375, 208), sizing: { w: 'fill', h: 'fixed' }, asset: poster.id, fit: 'cover', radius: 0, fill: '$wood6' } as StudioNode,
    frame('intro', flow('column', 8, [20, 18, 0, 18]), [
      text('intro-eb', 'WINTER SPA', { font: 'en', size: 11, weight: 700, letterSpacing: 0.2, color: '$muted' }),
      text('intro-h', '冬日汤泉季', { size: 24, weight: 600 }),
      text('intro-p', '12 月 1 日至 2 月 28 日，会员泡汤赠送姜茶一份；周末夜场延长到凌晨两点。', { size: 14, lineHeight: 1.6, color: '$muted' }),
    ]),
    frame('facts', flow('row', 10, [16, 18, 0, 18], 'stretch'), [
      frame('fact-hours', flow('column', 4, [12, 12, 12, 12]), [text('fact-hours-k', '营业时间', { size: 11, color: '$muted' }), field('fact-hours-v', 'store.hours', { size: 14, weight: 600 })], {
        fill: '$surface',
        radius: 8,
        sizing: { w: 'fill', h: 'hug' },
      }),
      frame('fact-phone', flow('column', 4, [12, 12, 12, 12]), [text('fact-phone-k', '订位电话', { size: 11, color: '$muted' }), field('fact-phone-v', 'store.phone', { size: 14, weight: 600 })], {
        fill: '$surface',
        radius: 8,
        sizing: { w: 'fill', h: 'hug' },
      }),
    ]),
    frame('cta', flow('column', 10, [20, 18, 0, 18], 'stretch'), [
      button('cta-coupon', '领取冬日券', { action: 'open.page', arg: 'coupon-center' }, { fill: '$energy', h: 48 }),
      button('cta-home', '回首页', { action: 'open.page', arg: 'home' }, { fill: null, stroke: '$ink', strokeWidth: 1, color: '$ink', weight: 500 }),
    ]),
  ];

  // 排列测试表：横排的四种分布、四种对齐、换行、撑满与固定、内边距、自由摆放套在自动排列里
  const sq = (id: string, w = 40, h = 40, fill = '$wood') => rect(id, w, h, { fill });
  const label = (id: string, zh: string) => text(id, zh, { size: 11, color: '$muted' });
  const lane = (id: string, layout: StudioLayout, children: StudioNode[], more: Over = {}) => frame(id, layout, children, { fill: '$wood6', radius: 6, ...more });
  const layoutSheet: StudioNode[] = [
    label('l-j', '横排 · 分布：靠左 / 居中 / 靠右 / 两头'),
    ...(['start', 'center', 'end', 'between'] as const).map((j) =>
      lane(`j-${j}`, flow('row', 8, [8, 8, 8, 8], 'center', j), [sq(`j-${j}-1`), sq(`j-${j}-2`, 40, 40, '$wood3'), sq(`j-${j}-3`, 40, 40, '$wood2')]),
    ),
    label('l-a', '横排 · 对齐：上 / 中 / 下 / 撑满（高 64 的框里）'),
    ...(['start', 'center', 'end', 'stretch'] as const).map((a) =>
      lane(
        `a-${a}`,
        flow('row', 8, [8, 8, 8, 8], a),
        [
          sq(`a-${a}-1`, 40, 20),
          a === 'stretch' ? rect(`a-${a}-2`, 40, 20, { fill: '$wood3', sizing: { w: 'fixed', h: 'fill' } }) : sq(`a-${a}-2`, 40, 32, '$wood3'),
          sq(`a-${a}-3`, 40, 44, '$wood2'),
        ],
        { sizing: { w: 'fill', h: 'fixed' }, h: 64 },
      ),
    ),
    label('l-w', '横排 · 放不下换行（每个 76 宽、间距 11）'),
    lane(
      'wrap',
      flow('row', 11, [8, 8, 8, 8], 'start', 'start', true),
      Array.from({ length: 7 }, (_, i) => sq(`w-${i}`, 76, 32, i % 2 ? '$wood3' : '$wood')),
    ),
    label('l-s', '宽：固定 80 + 撑满 + 撑满'),
    lane('fill', flow('row', 8, [8, 8, 8, 8], 'center'), [
      sq('f-1', 80, 32),
      rect('f-2', 10, 32, { fill: '$wood3', sizing: { w: 'fill', h: 'fixed' } }),
      rect('f-3', 10, 32, { fill: '$wood2', sizing: { w: 'fill', h: 'fixed' } }),
    ]),
    label('l-p', '竖排 · 内边距 上 20 右 10 下 4 左 30、间距 6、跟内容的高'),
    lane('pad', flow('column', 6, [20, 10, 4, 30], 'stretch'), [
      rect('p-1', 10, 24, { sizing: { w: 'fill', h: 'fixed' } }),
      rect('p-2', 10, 24, { fill: '$wood3', sizing: { w: 'fill', h: 'fixed' } }),
    ]),
    label('l-free', '自由摆放的框（按 x / y）套在竖排里：圆、转 15 度的方块、文字'),
    frame(
      'free',
      undefined,
      [
        { type: 'ellipse', id: 'free-dot', ...at(16, 16, 56, 56), fill: '$relax', stroke: null, strokeWidth: 0, radius: 0, shadow: 'none' } as StudioNode,
        { ...(rect('free-sq', 48, 48, { fill: '$organic' }) as Record<string, unknown>), x: 120, y: 20, rotate: 15, sizing: undefined } as StudioNode,
        { ...(text('free-t', '自由摆放', { size: 16, weight: 600 }) as Record<string, unknown>), x: 200, y: 32, w: 120, h: 24, sizing: undefined } as StudioNode,
      ],
      { fill: '$wood6', radius: 6, sizing: { w: 'fill', h: 'fixed' }, h: 96, clip: true },
    ),
  ];

  // 文字与样式测试表：字号、粗细、字距、行高、对齐、竖直对齐、斜体下划线、英文字体、数据字段、颜色（主题 / 十六进制 / 带透明度）、
  // 透明度、投影、描边、圆角、椭圆、按钮的几种样子
  const textSheet: StudioNode[] = [
    frame(
      'sizes',
      flow('row', 10, [0, 0, 0, 0], 'end'),
      [12, 16, 24, 32].map((n) => text(`size-${n}`, `${n}号`, { size: n, sizing: { w: 'hug', h: 'hug' } })),
    ),
    frame(
      'weights',
      flow('row', 10, [0, 0, 0, 0], 'center'),
      [300, 400, 600, 900].map((w) => text(`w-${w}`, `粗细${w}`, { size: 16, weight: w, sizing: { w: 'hug', h: 'hug' } })),
    ),
    text('spacing', '字距 0.2em：汤崎 TOUCHILL', { size: 15, letterSpacing: 0.2 }),
    text('en', 'Helvetica · YOUR NEXT URBAN PLEASURE', { font: 'en', size: 13, weight: 700, letterSpacing: 0.12 }),
    text('lh', '行高 2 倍：第一行字\n第二行字', { size: 14, lineHeight: 2, fill: '$wood6' }),
    ...(['left', 'center', 'right'] as const).map((a) => text(`align-${a}`, `对齐：${{ left: '左', center: '中', right: '右' }[a]}`, { align: a, fill: '$surface' })),
    frame(
      'valigns',
      flow('row', 8, [0, 0, 0, 0], 'start'),
      (['top', 'middle', 'bottom'] as const).map((v) =>
        text(`valign-${v}`, `竖直${{ top: '上', middle: '中', bottom: '下' }[v]}`, { valign: v, fill: '$wood6', sizing: { w: 'fill', h: 'fixed' }, h: 56, align: 'center' }),
      ),
    ),
    text('deco', '斜体加下划线', { italic: true, underline: true }),
    field('field-name', 'store.name', { size: 18, weight: 600 }),
    field('field-coupons', 'member.coupons', { prefix: { zh: '可用的券：', en: 'Coupons: ' }, suffix: { zh: ' 张', en: '' }, color: '$energy' }),
    frame('colors', flow('row', 8, [0, 0, 0, 0], 'center'), [
      rect('c-theme', 48, 32, { fill: '$organic' }),
      rect('c-hex', 48, 32, { fill: '#4E6B82' }),
      rect('c-alpha', 48, 32, { fill: '#B5532F80' }),
      rect('c-opacity', 48, 32, { fill: '$ink', opacity: 0.5 }),
      { type: 'ellipse', id: 'c-ellipse', ...at(0, 0, 32, 32), sizing: { w: 'fixed', h: 'fixed' }, fill: '$wood', stroke: '$ink', strokeWidth: 2, radius: 0, shadow: 'none' } as StudioNode,
    ]),
    frame(
      'shadows',
      flow('row', 14, [6, 6, 10, 6], 'center'),
      (['sm', 'md', 'lg'] as const).map((sh) => rect(`sh-${sh}`, 64, 40, { fill: '$surface', radius: 12, shadow: sh })),
    ),
    rect('stroke', 10, 40, { fill: null, stroke: '$wood', strokeWidth: 3, radius: 20, sizing: { w: 'fill', h: 'fixed' } }),
    frame('buttons', flow('row', 10, [0, 0, 0, 0], 'center'), [
      button('btn-solid', '实心', { action: 'open.page', arg: 'coupons' }, { sizing: { w: 'fill', h: 'fixed' } }),
      button('btn-ghost', '描边', { action: 'nav.store', arg: '' }, { fill: null, stroke: '$ink', strokeWidth: 1, color: '$ink', sizing: { w: 'fill', h: 'fixed' } }),
      button('btn-round', '圆角', { action: 'call.store', arg: '' }, { fill: '$relax', radius: 22, sizing: { w: 'fill', h: 'fixed' } }),
    ]),
  ];

  return [
    {
      name: '01-home-default',
      screen: 'home',
      note: '内置的默认首页：整屏竖排；版头大图、门店信息是功能块（小程序画真的），三块业务、服务入口是框与文字（点了打开别的页）',
      doc: defaultStudioDoc('mp'),
    },
    { name: '02-member-default', screen: 'member', note: '内置的默认会员页：会员卡是功能块；入口是横排换行的小卡片', doc: defaultStudioDoc('mp') },
    {
      name: '03-activity-poster',
      screen: 'activity',
      note: '活动页：海报图（铺满）、文字、两栏数据字段（横排 + 撑满）、两种按钮',
      doc: withScreen('activity', activity, flow('column', 0, [0, 0, 32, 0], 'stretch')),
    },
    {
      name: '04-layout-sheet',
      screen: 'activity',
      note: '排列测试表：分布、对齐、换行、撑满与固定、内边距、自由摆放套在竖排里、旋转',
      doc: withScreen('activity', layoutSheet, flow('column', 8, [16, 18, 24, 18], 'stretch')),
    },
    {
      name: '05-text-sheet',
      screen: 'activity',
      note: '文字与样式测试表：字号、粗细、字距、英文字体、行高、对齐、竖直对齐、斜体下划线、数据字段、颜色、透明度、投影、描边、圆角、按钮',
      doc: withScreen('activity', textSheet, flow('column', 12, [16, 18, 24, 18], 'stretch')),
    },
  ];
}

const OUT = 'tests/fixtures/studio/mp';

/** 每一份都要合格式、核对与检查没有红的（不合的说明生成的有错，不写文件） */
function assertValid(s: MpSample, assets: ReadonlyMap<string, number>) {
  const parsed = DocSchema.parse(s.doc);
  const problems = [...validateStudioDoc(parsed), ...checkStudioDoc(parsed, { assets })].filter((i) => i.level === 'error');
  if (problems.length) throw new Error(`${s.name}：${problems.map((p) => p.message).join('；')}`);
}

if (process.argv[1]?.endsWith('studio-mp-samples.ts')) {
  const poster = samplePoster();
  const assets = new Map([[poster.id, poster.bytes.length]]);
  mkdirSync(`${OUT}/assets`, { recursive: true });
  writeFileSync(`${OUT}/assets/${poster.id}.png`, poster.bytes);
  for (const s of buildMpSamples()) {
    assertValid(s, assets);
    // 外层带缩进好读；版面本身压成一行（整份版面带缩进有上百 KB）
    const { doc, ...head } = s;
    writeFileSync(`${OUT}/${s.name}.json`, `${JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "doc": ${JSON.stringify(doc)}\n}`)}\n`);
    console.log(`写好 ${OUT}/${s.name}.json`);
  }
}
