// UI 工作台的版面格式（8.1.1，docs/WORKBENCH_V811.md 第 3、5 节）：默认版面合格式、核对拦得住不合格的、发布前的检查。
// 只测格式与检查（不连数据库）；接口与权限在 tests/studio.test.ts。
import { describe, expect, it } from 'vitest';
import {
  changedScreens,
  checkStudioDoc,
  contrastRatio,
  defaultStudioDoc,
  DocSchema,
  EMENU_SURFACE,
  themeVars,
  validateStudioDoc,
  type StudioDoc,
  type StudioNode,
} from '../src/shared/studio';

const clone = (d: StudioDoc): StudioDoc => JSON.parse(JSON.stringify(d));
const text = (id: string, zh: string, more: Record<string, unknown> = {}): StudioNode =>
  DocSchema.shape.screens.parse({ s: { nodes: [{ type: 'text', id, x: 10, y: 10, w: 200, h: 30, text: { zh }, ...more }] } }).s!.nodes[0]!;

describe('版面格式', () => {
  it('默认版面合格式、核对没有问题、检查没有红的；主题变量一个都不多设（升级后与现在一样）', () => {
    const doc = defaultStudioDoc('emenu');
    expect(DocSchema.parse(doc)).toEqual(doc);
    expect(validateStudioDoc(doc)).toEqual([]);
    expect(checkStudioDoc(doc, { assets: new Map(), langSwitch: true }).filter((i) => i.level === 'error')).toEqual([]);
    expect(themeVars(doc)).toEqual({});
    // 每一屏都有：起始页 5 块、菜单页 3 块
    expect(doc.screens.start!.nodes).toHaveLength(5);
    expect(doc.screens.menu!.nodes.map((n) => (n.type === 'block' ? n.block : n.type))).toEqual(['menu.pages', 'menu.header', 'menu.dots']);
  });

  it('不接受脚本、外部图片、乱写的颜色与属性', () => {
    const base = defaultStudioDoc('emenu');
    const bad = (patch: (d: Record<string, unknown>) => void) => {
      const d = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      patch(d);
      return DocSchema.safeParse(d).success;
    };
    const start = (d: Record<string, unknown>) => (d.screens as Record<string, { nodes: unknown[] }>).start!.nodes;
    expect(bad(() => undefined)).toBe(true);
    expect(bad((d) => start(d).push({ type: 'html', id: 'x', x: 0, y: 0, w: 1, h: 1, html: '<script>' }))).toBe(false);
    expect(bad((d) => start(d).push({ type: 'image', id: 'x', x: 0, y: 0, w: 1, h: 1, asset: 'https://evil.example/a.png' }))).toBe(false);
    expect(bad((d) => start(d).push({ type: 'rect', id: 'x', x: 0, y: 0, w: 1, h: 1, fill: 'url(javascript:alert(1))' }))).toBe(false);
    expect(bad((d) => start(d).push({ type: 'rect', id: 'x', x: 0, y: 0, w: 1, h: 1, fill: 'red' }))).toBe(false);
    expect(bad((d) => start(d).push({ type: 'block', id: 'x', x: 0, y: 0, w: 1, h: 1, block: 'menu.pages', props: { onClick: { evil: 1 } } }))).toBe(false);
    expect(bad((d) => ((d.theme as { colors: Record<string, string> }).colors.ink = 'var(--x)'))).toBe(false);
  });

  it('核对：重复的编号、不能放在这一屏的块、不能挪的块被挪了、没有的属性、一屏两个', () => {
    const d = clone(defaultStudioDoc('emenu'));
    d.screens.start!.nodes.push({ ...(d.screens.start!.nodes[1] as StudioNode) });
    d.screens.start!.nodes.push({ type: 'block', id: 'p2', name: '', block: 'menu.pages', x: 0, y: 0, w: 1024, h: 768, rotate: 0, opacity: 1, hidden: false, locked: false, props: {} });
    const header = d.screens.menu!.nodes[1] as StudioNode & { x: number };
    header.x = 20;
    (d.screens.menu!.nodes[2] as { props: Record<string, unknown> }).props.color = '#ffffff';
    d.screens.menu!.nodes.push({ ...(d.screens.menu!.nodes[2] as StudioNode), id: 'dots-2' });
    const msgs = validateStudioDoc(d).map((i) => i.message);
    expect(msgs).toContain('节点编号「start-logo」重复了');
    expect(msgs).toContain('「菜单页」不能放在这一屏');
    expect(msgs).toContain('「顶栏」不能挪');
    expect(msgs).toContain('「翻页圆点」没有「color」这一项');
    expect(msgs).toContain('「翻页圆点」一屏只能有一个');
  });

  it('发布前的检查：缺了必需的块、藏起来、图片不在素材库、英文没填、对比不够、等比缩放的「中 | EN」缩小了', () => {
    const d = clone(defaultStudioDoc('emenu'));
    d.screens.start!.nodes = d.screens.start!.nodes.filter((n) => n.id !== 'start-footer');
    (d.screens.menu!.nodes[1] as { hidden: boolean }).hidden = true;
    d.screens.start!.nodes.push({ type: 'image', id: 'img', name: '海报', x: 0, y: 0, w: 100, h: 100, rotate: 0, opacity: 1, hidden: false, locked: false, asset: 'a'.repeat(64), fit: 'cover', radius: 0, fill: null });
    d.screens.start!.nodes.push(text('t1', '欢迎', { color: '#d0d0d0' }));
    const lang = d.screens.start!.nodes.find((n) => n.id === 'start-lang')!;
    lang.w = 24;
    lang.h = 11.15;
    const issues = checkStudioDoc(d, { assets: new Map([['b'.repeat(64), 10]]), langSwitch: true });
    const red = issues.filter((i) => i.level === 'error').map((i) => i.message);
    const yellow = issues.filter((i) => i.level === 'warn').map((i) => i.message);
    expect(red).toContain('起始页缺了「版权行（长按 3 秒退出平板）」：从左边「插入 → 功能块」加回来');
    expect(red).toContain('菜单页的「顶栏」被隐藏了：客人看不到、点不到');
    expect(red).toContain('「海报」用的图片不在素材库里');
    expect(yellow.some((m) => m.includes('没填英文'))).toBe(true);
    expect(yellow.some((m) => m.includes('对比不够'))).toBe(true);
    expect(yellow).toContain('「中 | EN 切换」比默认的小，客人可能点不准');
  });

  it('对比度、改了哪几屏、主题变量只给改过的', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#4b392a', '#f4f3f2')!).toBeGreaterThan(4.5);
    const a = defaultStudioDoc('emenu');
    const b = clone(a);
    b.theme.colors.tan = '#123456';
    b.theme.fonts.zh = 'heiti';
    expect(changedScreens(a, b)).toEqual(['theme']);
    expect(themeVars(b)).toEqual({ '--em-tan': '#123456', '--em-zh': EMENU_SURFACE.fonts.zh.find((f) => f.key === 'heiti')!.stack });
    b.screens.menu!.nodes[2]!.y = 700;
    expect(changedScreens(a, b)).toEqual(['theme', 'menu']);
    b.theme.colors.key2 = '#000000';
    expect(themeVars(b)['--em-key-2']).toBe('#000000');
  });
});
