// UI 工作台的核对与检查（8.1.1，docs/WORKBENCH_V811.md 第 3、5 节）。前后端共用：编辑器里随改随看，服务端存草稿、发布时再核对一遍。
//   · validateStudioDoc：格式之外、按界面登记核对（屏、功能块、属性、编号不重复、套几层）——不过的存不进去；
//   · checkStudioDoc：发布前的检查（GZ7）。红的（error）不改不能发布：必需的功能块不在或看不见、图片不在素材库里；
//     黄的（warn）提醒一下：英文没填、字和底色对比不够、能点的块缩得太小、图片太大、整块在画布外面。

import { isFlow, STUDIO_LIMITS, walkNodes, type StudioAction, type StudioBlockNode, type StudioColor, type StudioDoc, type StudioNode } from './format';
import { slotHideable, slotResizable } from './emenu-templates';
import { STUDIO_SURFACE_DEFS, type StudioBlockDef, type StudioPropDef, type StudioSurfaceDef } from './surfaces';

export interface StudioIssue {
  level: 'error' | 'warn';
  screen?: string;
  nodeId?: string;
  message: string;
}

/** 功能块里不能挪的那几块固定在哪（与默认版面一致） */
const FIXED_AT: Record<string, { x: number; y: number }> = { 'menu.pages': { x: 0, y: 0 }, 'menu.header': { x: 0, y: 0 } };
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

function propIssue(def: StudioPropDef, value: unknown): string | null {
  switch (def.kind) {
    case 'color':
      if (def.auto && value === 'auto') return null;
      return typeof value === 'string' && /^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|\$[a-z][a-zA-Z0-9]{0,23})$/.test(value) ? null : `「${def.label}」要是颜色`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (def.min === undefined || value >= def.min) && (def.max === undefined || value <= def.max)
        ? null
        : `「${def.label}」要在 ${def.min ?? '-∞'}–${def.max ?? '∞'} 之间`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `「${def.label}」要是开或关`;
    case 'select':
      return typeof value === 'string' && !!def.options?.some((o) => o.value === value) ? null : `「${def.label}」只能从选项里选`;
  }
}

/** 动作只能是界面登记的；有选项的 arg 只能从选项里选，没有选项的不要 arg */
function actionIssue(def: StudioSurfaceDef, a: StudioAction): string | null {
  const d = def.actions.find((x) => x.key === a.action);
  if (!d) return def.actions.length ? `没有「${a.action}」这个动作` : `${def.label}上的按钮、框不能设「点了做什么」`;
  if (d.args) return d.args.some((o) => o.value === a.arg) ? null : `「${d.label}」要从选项里选`;
  return a.arg ? `「${d.label}」不要填参数` : null;
}

/** 格式之外按界面登记核对：不过的存不进去 */
export function validateStudioDoc(doc: StudioDoc): StudioIssue[] {
  const def = STUDIO_SURFACE_DEFS[doc.surface];
  const issues: StudioIssue[] = [];
  const err = (message: string, screen?: string, nodeId?: string) => issues.push({ level: 'error', message, screen, nodeId });
  for (const key of Object.keys(doc.theme.colors)) if (!def.colors.some((c) => c.key === key)) err(`没有「${key}」这个主题色`);
  if (!def.fonts.zh.some((f) => f.key === doc.theme.fonts.zh)) err(`中文字体「${doc.theme.fonts.zh}」不在可选的里面`);
  if (!def.fonts.en.some((f) => f.key === doc.theme.fonts.en)) err(`英文字体「${doc.theme.fonts.en}」不在可选的里面`);
  const ids = new Set<string>();
  let total = 0;
  for (const [screen, s] of Object.entries(doc.screens)) {
    if (!def.screens.some((x) => x.key === screen)) {
      err(`没有「${screen}」这一屏`, screen);
      continue;
    }
    // 平板（整页等比缩放）的屏是一张画布：不能自动排列、不能改高；手机的屏能
    if (def.kind === 'tablet' && (s.layout || s.height !== undefined)) err(`${def.label}的屏不能自动排列、不能改高`, screen);
    let count = 0;
    const singles = new Map<string, number>();
    walkNodes(s.nodes, (n, depth, parent) => {
      count += 1;
      if (ids.has(n.id)) err(`节点编号「${n.id}」重复了`, screen, n.id);
      ids.add(n.id);
      if (depth > STUDIO_LIMITS.depth) err(`框最多套 ${STUDIO_LIMITS.depth} 层`, screen, n.id);
      if ((n.type === 'button' || n.type === 'frame' || n.type === 'image') && n.action) {
        const why = actionIssue(def, n.action);
        if (why) err(why, screen, n.id);
      }
      if (n.type === 'field' && !def.fields.some((f) => f.key === n.field)) err(`没有「${n.field}」这个数据字段`, screen, n.id);
      if (n.type !== 'block') return;
      const b = def.blocks[n.block];
      if (!b) return err(`没有「${n.block}」这个功能块`, screen, n.id);
      if (!b.screens.includes(screen)) err(`「${b.label}」不能放在这一屏`, screen, n.id);
      if (parent) err(`「${b.label}」不能放进框里`, screen, n.id);
      if (b.single) singles.set(n.block, (singles.get(n.block) ?? 0) + 1);
      for (const [k, v] of Object.entries(n.props)) {
        const p = b.props.find((x) => x.key === k);
        const why = p ? propIssue(p, v) : `「${b.label}」没有「${k}」这一项`;
        if (why) err(why, screen, n.id);
      }
      if (b.resize === 'none' && (!near(n.w, b.size.w) || !near(n.h, b.size.h))) err(`「${b.label}」不能改大小`, screen, n.id);
      if (b.resize === 'scale' && b.size.w > 0 && n.w > 0 && Math.abs(n.h / n.w - b.size.h / b.size.w) > 0.01 * (b.size.h / b.size.w) + 0.02) err(`「${b.label}」只能等比缩放`, screen, n.id);
      const at = FIXED_AT[n.block];
      if (!b.move && at && (!near(n.x, at.x) || !near(n.y, at.y))) err(`「${b.label}」不能挪`, screen, n.id);
    });
    for (const [key, n] of singles) if (n > 1) err(`「${def.blocks[key]!.label}」一屏只能有一个`, screen);
    if (count > STUDIO_LIMITS.nodesPerScreen) err(`一屏最多 ${STUDIO_LIMITS.nodesPerScreen} 个图层`, screen);
    total += count;
  }
  if (total > STUDIO_LIMITS.nodesPerDoc) err(`一份版面最多 ${STUDIO_LIMITS.nodesPerDoc} 个图层`);
  // 卡片模板的改动（8.1.2）：只有登记了模板的界面有；版式、块按登记；藏、改大小、圆角只给能改的块
  for (const [layout, slots] of Object.entries(doc.templates ?? {})) {
    const t = def.templates?.[layout];
    if (!t) {
      err(def.templates ? `没有「${layout}」这种版式` : `${def.label}没有卡片模板`);
      continue;
    }
    for (const [key, o] of Object.entries(slots)) {
      const slot = t.slots.find((x) => x.key === key);
      if (!slot) {
        err(`版式「${layout}」里没有「${key}」这一块`);
        continue;
      }
      const can = slotResizable(slot);
      if (o.hidden && !slotHideable(slot)) err(`「${slot.label}」不能藏起来（菜名、价格、加号在里面）`);
      if (o.radius !== undefined && slot.kind !== 'photo') err(`「${slot.label}」没有圆角这一项`);
      for (const mode of ['design', 'big'] as const) {
        const p = o[mode];
        if (!p) continue;
        if ((p.w !== undefined && !can.w) || (p.h !== undefined && !can.h)) err(`「${slot.label}」不能改${p.w !== undefined && !can.w ? '宽' : '高'}`);
        // 下沿只给放大一档里登记成「往上长」的文字块；同一档里上沿、下沿只能写一个
        if (p.bottom !== undefined && (mode === 'design' || slot.big?.bottom === undefined)) err(`「${slot.label}」${mode === 'design' ? '原样一档' : ''}没有「下沿」这一项`);
        if (p.bottom !== undefined && p.y !== undefined) err(`「${slot.label}」的上沿、下沿只能定一个`);
      }
    }
  }
  return issues;
}

// ───────────────────────── 发布前的检查 ─────────────────────────

/** #rrggbb(aa) → [r, g, b, a]（0–255，a 0–1） */
function rgba(hex: string): [number, number, number, number] | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!m) return null;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16), m[4] ? parseInt(m[4], 16) / 255 : 1];
}
const lum = ([r, g, b]: [number, number, number, number]) => {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
/** 两个颜色的对比度（WCAG）：前景有透明度时按叠在背景上算 */
export function contrastRatio(fg: string, bg: string): number | null {
  const f = rgba(fg);
  const b = rgba(bg);
  if (!f || !b) return null;
  const mixed: [number, number, number, number] = [0, 1, 2].map((i) => f[i]! * f[3] + b[i]! * (1 - f[3])).concat(1) as [number, number, number, number];
  const [hi, lo] = [lum(mixed), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** 主题色换成具体的颜色（认不出的返回空） */
export function resolveColor(doc: StudioDoc, c: StudioColor | null | undefined): string | null {
  if (!c) return null;
  if (!c.startsWith('$')) return c;
  const key = c.slice(1);
  return doc.theme.colors[key] ?? STUDIO_SURFACE_DEFS[doc.surface].colors.find((x) => x.key === key)?.default ?? null;
}

export interface StudioCheckContext {
  /** 素材库里有的图（编号 → 字节数）；不给就不查图片 */
  assets?: ReadonlyMap<string, number>;
  /** 中英切换开着：英文没填的提醒 */
  langSwitch?: boolean;
}

const MB = 1024 * 1024;

/**
 * 字和底色要多大的对比（WCAG）：正文 4.5:1；大字 3:1——24 号以上，或 18.66 号以上的粗体（700 以上）。
 * 8.1.1 的平板菜单原来只查 24 号以下的正文，大字不查；8.1.2 起大字也查 3:1。
 */
function contrastNeeded(size: number, weight: number): 4.5 | 3 {
  return size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
}

/** 发布前的检查：红的不改不能发布，黄的提醒 */
export function checkStudioDoc(doc: StudioDoc, ctx: StudioCheckContext = {}): StudioIssue[] {
  const def = STUDIO_SURFACE_DEFS[doc.surface];
  const issues: StudioIssue[] = validateStudioDoc(doc);
  const add = (level: StudioIssue['level'], message: string, screen?: string, nodeId?: string) => issues.push({ level, message, screen, nodeId });
  for (const screenDef of def.screens) {
    const s = doc.screens[screenDef.key];
    const nodes = s?.nodes ?? [];
    const top: StudioNode[] = nodes;
    // 必需的功能块：在、看得见
    for (const b of Object.values(def.blocks)) {
      if (!b.required || !b.screens.includes(screenDef.key)) continue;
      const n = top.find((x): x is StudioBlockNode => x.type === 'block' && x.block === b.key);
      if (!n) add('error', `${screenDef.label}缺了「${b.label}」：从左边「插入 → 功能块」加回来`, screenDef.key);
      else if (n.hidden || n.opacity < 0.05) add('error', `${screenDef.label}的「${b.label}」被隐藏了：客人看不到、点不到`, screenDef.key, n.id);
    }
    const screenBg = resolveColor(doc, s?.background ?? screenDef.background) ?? resolveColor(doc, '$bg');
    const height = s?.height ?? def.size.h;
    walkNodes(nodes, (n, _depth, parent) => {
      if (n.hidden) return;
      // 整块在画布外面（整屏自动排列时不看 x / y）
      if (!parent && !isFlow(s?.layout) && (n.x >= def.size.w || n.y >= height || n.x + n.w <= 0 || n.y + n.h <= 0))
        add('warn', `「${n.name || n.id}」整块在画布外面，${def.kind === 'tablet' ? '平板' : '手机'}上看不到`, screenDef.key, n.id);
      if (n.type === 'image' && ctx.assets) {
        const size = ctx.assets.get(n.asset);
        if (size === undefined) add('error', `「${n.name || n.id}」用的图片不在素材库里`, screenDef.key, n.id);
        else if (size > MB) add('warn', `「${n.name || n.id}」的图片大于 1 MB，平板打开会慢一些`, screenDef.key, n.id);
      }
      if (n.type === 'text') {
        if (ctx.langSwitch && n.text.zh.trim() && !n.text.en.trim()) add('warn', `「${n.name || n.text.zh.slice(0, 10)}」没填英文：切到 EN 时显示中文`, screenDef.key, n.id);
        const fg = resolveColor(doc, n.color);
        const bg = resolveColor(doc, n.fill) ?? (parent ? resolveColor(doc, parent.fill) : null) ?? screenBg;
        const ratio = fg && bg ? contrastRatio(fg, bg) : null;
        const need = contrastNeeded(n.size, n.weight);
        if (ratio !== null && ratio < need)
          add('warn', `「${n.name || n.text.zh.slice(0, 10)}」字和底色对比不够（${ratio.toFixed(1)}:1，${need === 3 ? '大字' : '正文'}要 ${need}:1），可能看不清`, screenDef.key, n.id);
      }
      if (n.type === 'block') {
        const b: StudioBlockDef | undefined = def.blocks[n.block];
        // 等比缩放的能点的块（中 | EN）缩得比默认小：点按区域跟着变小
        if (b?.tap && b.resize === 'scale' && n.w < b.size.w - 0.5) add('warn', `「${b.label}」比默认的小，客人可能点不准`, screenDef.key, n.id);
      }
      if (n.type === 'button') {
        const label = n.name || n.text.zh.slice(0, 10) || '按钮';
        // 自动排列里跟内容走的边量不出来，只看固定的
        const fixedW = !n.sizing || n.sizing.w === 'fixed';
        const fixedH = !n.sizing || n.sizing.h === 'fixed';
        if ((fixedW && n.w < 44) || (fixedH && n.h < 44)) add('warn', `「${label}」比 44×44 小，手指可能点不准`, screenDef.key, n.id);
        if (ctx.langSwitch && n.text.zh.trim() && !n.text.en.trim()) add('warn', `「${label}」没填英文：切到 EN 时显示中文`, screenDef.key, n.id);
        const fg = resolveColor(doc, n.color);
        const bg = resolveColor(doc, n.fill) ?? (parent ? resolveColor(doc, parent.fill) : null) ?? screenBg;
        const ratio = fg && bg ? contrastRatio(fg, bg) : null;
        const need = contrastNeeded(n.size, n.weight);
        if (ratio !== null && ratio < need) add('warn', `「${label}」字和底色对比不够（${ratio.toFixed(1)}:1，要 ${need}:1），可能看不清`, screenDef.key, n.id);
        if (!n.action && def.actions.length) add('warn', `「${label}」还没设「点了做什么」，点了没反应`, screenDef.key, n.id);
      }
    });
  }
  return issues;
}

/** 与键的先后无关的 JSON（库里的 jsonb 会重排键，不能直接比 JSON.stringify） */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 两份版面哪几屏改了（主题改了算「主题」）：发布记录里写 */
export function changedScreens(before: StudioDoc | null, after: StudioDoc): string[] {
  const def = STUDIO_SURFACE_DEFS[after.surface];
  const out: string[] = [];
  if (!before || canonicalJson(before.theme) !== canonicalJson(after.theme)) out.push('theme');
  for (const s of def.screens) if (!before || canonicalJson(before.screens[s.key] ?? null) !== canonicalJson(after.screens[s.key] ?? null)) out.push(s.key);
  // 卡片模板（8.1.2）：改过、或恢复了默认
  if (canonicalJson(before?.templates ?? null) !== canonicalJson(after.templates ?? null)) out.push('templates');
  return out;
}

/** 屏、主题的中文名（发布记录、版本列表里显示） */
export function screenLabel(surface: StudioDoc['surface'], key: string): string {
  if (key === 'theme') return '主题';
  if (key === 'templates') return '卡片模板';
  return STUDIO_SURFACE_DEFS[surface].screens.find((s) => s.key === key)?.label ?? key;
}
