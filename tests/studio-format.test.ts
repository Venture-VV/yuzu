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
  resolveColor,
  STUDIO_SURFACE_DEFS,
  themeColor,
  themeVars,
  upgradeStudioDoc,
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
    d.screens.start!.nodes.push({
      type: 'image',
      id: 'img',
      name: '海报',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      rotate: 0,
      opacity: 1,
      hidden: false,
      locked: false,
      asset: 'a'.repeat(64),
      fit: 'cover',
      radius: 0,
      fill: null,
    });
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
    expect(yellow).toContain('「中英切换」比默认的小，客人可能点不准');
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

  it('8.1.8（品牌部，PB4）：平板菜单的主文字是品牌规定的 #4b392a，版面里存着别的值也不生效', () => {
    const doc = clone(defaultStudioDoc('emenu'));
    expect(EMENU_SURFACE.colors.find((c) => c.key === 'ink')).toMatchObject({ default: '#4b392a', locked: true });
    expect(EMENU_SURFACE.squareImages).toBe(true);
    // 测试服上那一版：主文字改成了 #be9879——页面上照旧是 #4b392a，工作台读出来也是
    doc.theme.colors.ink = '#be9879';
    expect(validateStudioDoc(doc)).toEqual([]);
    expect(themeColor(doc, 'ink')).toBe('#4b392a');
    expect(themeColor(doc, 'nope')).toBeNull();
    expect(themeVars(doc)).toEqual({});
    expect(themeVars(doc, true)['--em-ink']).toBe('#4b392a');
    // 主题色引用 $ink 的块（设计师加的字）也是品牌色；数据不改（存着的照旧存着）
    expect(resolveColor(doc, '$ink')).toBe('#4b392a');
    expect(doc.theme.colors.ink).toBe('#be9879');
  });

  it('8.1.8 存的带着 dot 的版面（标题小圆圈的颜色，8.1.9 起不进主题色）：读到就去掉，照常用；再存就没有了', () => {
    const saved = clone(defaultStudioDoc('emenu')) as StudioDoc;
    saved.theme.colors.dot = '#bf1d25';
    saved.theme.colors.tan = '#7a5c3a';
    // 没升级的直接核对：不认（8.1.7 也是这样报的）
    expect(validateStudioDoc(saved).map((i) => i.message)).toContain('没有「dot」这个主题色');
    const up = DocSchema.parse(upgradeStudioDoc(saved));
    expect(up.theme.colors).not.toHaveProperty('dot');
    expect(up.theme.colors.tan).toBe('#7a5c3a');
    expect(validateStudioDoc(up)).toEqual([]);
    // 只动平板菜单；没有 dot 的原样返回（同一个对象）
    const plain = defaultStudioDoc('emenu');
    expect(upgradeStudioDoc(plain)).toBe(plain);
    const mp = clone(defaultStudioDoc('mp')) as StudioDoc;
    (mp.theme.colors as Record<string, string>).dot = '#000000';
    expect((upgradeStudioDoc(mp) as StudioDoc).theme.colors).toHaveProperty('dot');
  });

  it('退回上一版也读得了（8.1.8 测试会话 P1）：主题色一项不多，与 8.1.7 一样', () => {
    // 版面里存着上一版不认识的主题色时，上一版的工作台报「没有「x」这个主题色」：发布的版面读不出来、草稿存不进（STUDIO_INVALID）。
    // 8.1.8 起先加的「标题右下角的小圆圈」就是这样，测试会话照「留着数据库退回 8.1.7」复现过；现在小圆圈的颜色写死在样式表里。
    // 以后真要加主题色，先想好退回的办法（例如上一版先学会不认识的主题色不报错、照存），再改这张表
    const RELEASED: Record<string, string[]> = {
      emenu: ['ink', 'mute', 'tan', 'bg', 'modal', 'band', 'key', 'key2', 'photo', 'light', 'error'],
      mp: ['bg', 'surface', 'ink', 'muted', 'line', 'wood', 'wood2', 'wood3', 'wood4', 'wood5', 'wood6', 'organic', 'relax', 'energy', 'danger', 'cardA', 'cardB', 'cardInk', 'cardMuted'],
      canteen: ['cream', 'card', 'line', 'ink', 'ink2', 'ink3', 'wood', 'wood4', 'woodDeep', 'yuzu', 'yuzuDeep', 'yuzuSoft', 'organic', 'relax', 'energy', 'danger'],
    };
    for (const surface of ['emenu', 'mp', 'canteen'] as const) {
      expect(
        STUDIO_SURFACE_DEFS[surface].colors.map((c) => c.key),
        surface,
      ).toEqual(RELEASED[surface]);
      expect(Object.keys(defaultStudioDoc(surface).theme.colors), surface).toEqual(RELEASED[surface]);
    }
  });
});

describe('8.1.2：小程序的版面（自动排列、按钮、数据字段、点了做什么）', () => {
  const mpNode = (n: Record<string, unknown>): StudioNode => DocSchema.shape.screens.parse({ s: { nodes: [{ id: 'x', x: 0, y: 0, w: 100, h: 40, ...n }] } }).s!.nodes[0]!;

  it('默认版面合格式、核对没有问题、检查没有红的；主题变量全写在页面上（小程序这边没有样式表）', () => {
    const doc = defaultStudioDoc('mp');
    expect(DocSchema.parse(doc)).toEqual(doc);
    expect(validateStudioDoc(doc)).toEqual([]);
    expect(checkStudioDoc(doc, { assets: new Map() }).filter((i) => i.level === 'error')).toEqual([]);
    expect(Object.keys(doc.screens)).toEqual(['home', 'activity', 'member']);
    // 首页：整屏竖排，版头、门店信息（必需）、三块业务、服务入口
    expect(doc.screens.home!.layout?.mode).toBe('column');
    expect(doc.screens.home!.nodes.map((n) => n.id)).toEqual(['home-banner', 'home-store', 'home-pillars', 'home-services']);
    const vars = themeVars(doc);
    expect(vars['--mp-wood']).toBe('#937051');
    expect(vars['--mp-zh']).toContain('PingFang SC');
    // 旧版面（8.1.1 的平板菜单）一个新字段都没有：存进去、读出来一字不改
    expect(JSON.stringify(defaultStudioDoc('emenu'))).not.toMatch(/"(layout|sizing|action)"/);
  });

  it('自动排列、尺寸规则、按钮、数据字段合格式；乱写的排列、尺寸、动作名存不进去', () => {
    expect(mpNode({ type: 'frame', layout: { mode: 'row', gap: 8 }, children: [] })).toMatchObject({
      layout: { mode: 'row', wrap: false, gap: 8, padding: [0, 0, 0, 0], align: 'start', justify: 'start' },
    });
    expect(mpNode({ type: 'text', text: { zh: '字' }, sizing: { w: 'fill' } })).toMatchObject({ sizing: { w: 'fill', h: 'fixed' } });
    expect(mpNode({ type: 'button', text: { zh: '去看看' }, action: { action: 'open.page', arg: 'coupons' } })).toMatchObject({
      fill: '$ink',
      align: 'center',
      valign: 'middle',
      action: { action: 'open.page', arg: 'coupons' },
    });
    expect(mpNode({ type: 'field', field: 'store.hours' })).toMatchObject({ prefix: { zh: '', en: '' }, suffix: { zh: '', en: '' } });
    const parse = (n: Record<string, unknown>) => DocSchema.shape.screens.safeParse({ s: { nodes: [{ id: 'x', x: 0, y: 0, w: 1, h: 1, ...n }] } }).success;
    expect(parse({ type: 'frame', layout: { mode: 'grid' }, children: [] })).toBe(false);
    expect(parse({ type: 'text', text: { zh: '字' }, sizing: { w: 'auto' } })).toBe(false);
    expect(parse({ type: 'button', text: { zh: '去' }, action: { action: 'javascript:alert(1)' } })).toBe(false);
    expect(parse({ type: 'field', field: 'store.name; drop' })).toBe(false);
  });

  it('核对：动作、参数、字段只能是登记的；平板菜单的屏不能自动排列、没有动作', () => {
    const doc = defaultStudioDoc('mp');
    const add = (d: StudioDoc, n: StudioNode) => {
      d.screens.activity!.nodes.push(n);
      return validateStudioDoc(d).map((i) => i.message);
    };
    expect(add(clone(doc), mpNode({ type: 'button', id: 'b1', text: { zh: '打开' }, action: { action: 'open.url', arg: 'https://x' } }))).toContain('没有「open.url」这个动作');
    expect(add(clone(doc), mpNode({ type: 'button', id: 'b2', text: { zh: '打开' }, action: { action: 'open.page', arg: 'admin' } }))).toContain('「打开小程序的一页」要从选项里选');
    expect(add(clone(doc), mpNode({ type: 'button', id: 'b3', text: { zh: '打电话' }, action: { action: 'call.store', arg: '13800000000' } }))).toContain('「拨打门店电话」不要填参数');
    expect(add(clone(doc), mpNode({ type: 'field', id: 'f1', field: 'member.phone' }))).toContain('没有「member.phone」这个数据字段');
    expect(add(clone(doc), mpNode({ type: 'button', id: 'b4', text: { zh: '我的券' }, action: { action: 'open.page', arg: 'coupons' } }))).toEqual([]);

    const em = clone(defaultStudioDoc('emenu'));
    em.screens.start!.layout = { mode: 'column', wrap: false, gap: 0, padding: [0, 0, 0, 0], align: 'start', justify: 'start' };
    expect(validateStudioDoc(em).map((i) => i.message)).toContain('平板电子菜单的屏不能自动排列、不能改高');
    const em2 = clone(defaultStudioDoc('emenu'));
    em2.screens.start!.nodes.push(mpNode({ type: 'button', id: 'b5', text: { zh: '去' }, action: { action: 'open.page', arg: 'home' } }));
    expect(validateStudioDoc(em2).map((i) => i.message)).toContain('平板电子菜单上的按钮、框不能设「点了做什么」');
  });

  it('发布前的检查：按钮太小、没设动作、字和底色对比不够是黄的；自动排列的屏不报「在画布外面」', () => {
    const doc = clone(defaultStudioDoc('mp'));
    doc.screens.activity!.nodes.push(mpNode({ type: 'button', id: 'tiny', w: 30, h: 30, text: { zh: '小' }, fill: '#FFFFFF', color: '#EEEEEE', sizing: { w: 'fixed', h: 'fixed' } }));
    // 自动排列里的 x / y 不看：远在「画布外」也不报
    doc.screens.activity!.nodes.push(mpNode({ type: 'text', id: 'far', x: 5000, y: 5000, text: { zh: '很远' }, sizing: { w: 'fill', h: 'hug' } }));
    const msgs = checkStudioDoc(doc, { assets: new Map() }).map((i) => `${i.level}:${i.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([expect.stringMatching(/^warn:「小」比 44×44 小/), expect.stringMatching(/^warn:「小」还没设「点了做什么」/), expect.stringMatching(/^warn:「小」字和底色对比不够/)]),
    );
    expect(msgs.some((m) => m.includes('画布外面'))).toBe(false);
    expect(msgs.filter((m) => m.startsWith('error'))).toEqual([]);
    // 门店信息是必需的：删了是红的
    doc.screens.home!.nodes = doc.screens.home!.nodes.filter((n) => n.id !== 'home-store');
    expect(
      checkStudioDoc(doc)
        .filter((i) => i.level === 'error')
        .map((i) => i.message),
    ).toEqual(['首页缺了「门店信息」：从左边「插入 → 功能块」加回来']);
  });
});

describe('8.1.2：员工食堂的版面', () => {
  it('默认版面合格式、核对和检查都没有问题；主题变量一个都不多设（员工手机上与原来一样），在工作台里画时全写上', () => {
    const doc = defaultStudioDoc('canteen');
    expect(DocSchema.parse(doc)).toEqual(doc);
    expect(validateStudioDoc(doc)).toEqual([]);
    expect(checkStudioDoc(doc, { assets: new Map(), langSwitch: false })).toEqual([]);
    expect(themeVars(doc)).toEqual({});
    const all = themeVars(doc, true);
    expect(all['--color-yuzu']).toBe('#e9c75e');
    expect(all['--color-ink-2']).toBe('#5c4639');
    expect(all['--color-wood-deep']).toBe('#8a684a');
    expect(all['--font-sans']).toContain('HarmonyOS Sans SC');
    // 首页一段一段往下排（间隔 16），饭卡码页居中；各段都是功能块
    expect(doc.screens.home!.layout).toMatchObject({ mode: 'column', gap: 16, align: 'stretch' });
    expect(doc.screens.code!.nodes.map((n) => (n.type === 'block' ? n.block : n.type))).toEqual(['cn.profile', 'cn.qr', 'cn.codeHint', 'cn.mascot']);
  });

  it('饭卡码、亮出饭卡码、按岗位的入口是必需的：藏起来是红的', () => {
    const doc = defaultStudioDoc('canteen');
    for (const n of [...doc.screens.home!.nodes, ...doc.screens.code!.nodes]) if (n.type === 'block' && ['cn.qr', 'cn.codeButton', 'cn.entries'].includes(n.block)) n.hidden = true;
    const red = checkStudioDoc(doc, { assets: new Map(), langSwitch: false }).filter((i) => i.level === 'error');
    expect(red.map((i) => i.message)).toEqual(expect.arrayContaining([expect.stringContaining('饭卡码'), expect.stringContaining('亮出饭卡码'), expect.stringContaining('按岗位的入口')]));
  });
});

describe('8.1.6：顶栏（docs/EMENU.md 第 15.8 节，QZ8、QZ9）', () => {
  const withHeader = (header: NonNullable<StudioDoc['templates']>[string]): StudioDoc => ({ ...clone(defaultStudioDoc('emenu')), templates: { header } });
  it('挪、等比改大小、改分类那一块的宽都合格；顶栏那一条外面、不等比、缩得太小拦下来', () => {
    expect(validateStudioDoc(withHeader({ search: { design: { x: 780 } }, order: { design: { w: 26.3, h: 30 } }, cats: { design: { w: 480 } }, tag: { big: { x: 860 } } }))).toEqual([]);
    expect(validateStudioDoc(withHeader({ search: { design: { y: 120 } } })).map((i) => i.message)).toEqual(['「搜索」要在顶栏那一条里（宽 1024、高 102）']);
    expect(validateStudioDoc(withHeader({ order: { design: { w: 30, h: 20 } } })).map((i) => i.message)).toContain('「订单」只能等比缩放');
    expect(validateStudioDoc(withHeader({ lang: { design: { w: 8, h: 8 } } })).map((i) => i.message)).toContain('「中英切换」最小缩到一半、最大放到两倍半');
    expect(validateStudioDoc(withHeader({ cats: { design: { w: 100 } } })).map((i) => i.message)).toContain('「分类」至少要 120 宽（放得下分类页签）');
    // 分类那一块只改宽；顶栏里的块不能藏
    expect(validateStudioDoc(withHeader({ cats: { design: { h: 30 } } })).map((i) => i.message)).toContain('「分类」不能改高');
    expect(validateStudioDoc(withHeader({ tag: { hidden: true } })).length).toBeGreaterThan(0);
    expect(validateStudioDoc(withHeader({ bell: { design: { x: 10 } } })).map((i) => i.message)).toEqual(['版式「header」里没有「bell」这一块']);
  });

  it('发布前的检查：两块叠在一起提醒一下（黄的，不拦发布）；没改过顶栏不查', () => {
    const issues = checkStudioDoc(withHeader({ search: { design: { x: 760 } } }), { assets: new Map(), langSwitch: true });
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(issues.filter((i) => i.level === 'warn').map((i) => i.message)).toContain('顶栏里「中英切换」与「搜索」叠在一起了：客人可能点错');
    expect(checkStudioDoc(defaultStudioDoc('emenu'), { assets: new Map(), langSwitch: true }).filter((i) => i.message.startsWith('顶栏'))).toEqual([]);
  });
});
