// UI 工作台的组件（8.1.2，docs/WORKBENCH_V811.md 第 13 节）：实例照组件画、展开给小程序、核对拦得住（删掉的组件、功能块进组件、
// 组件套自己）；编辑器里存成组件、改组件（当成一屏改）、拆开、删掉没人用的。只测纯函数（不连数据库）；发布以后小程序读到的是展开的，
// 在 tests/studio.test.ts。
import { describe, expect, it } from 'vitest';
import {
  changedScreens,
  componentCycles,
  componentUses,
  defaultStudioDoc,
  DocSchema,
  docAssets,
  expandInstances,
  instanceView,
  MP_SURFACE,
  validateStudioDoc,
  walkNodes,
  type StudioDoc,
  type StudioInstanceNode,
  type StudioNode,
} from '../src/shared/studio';
import { componentScreen, deleteComponent, detachInstance, findNode, insertNode, makeComponentFrom, makeInstance, renameComponent, screenOf, updateNode } from '../src/client/features/studio/model';

const base = { name: '', rotate: 0, opacity: 1, hidden: false, locked: false };
const text = (id: string, zh: string, x = 0, y = 0): StudioNode =>
  ({
    type: 'text',
    id,
    ...base,
    x,
    y,
    w: 100,
    h: 20,
    text: { zh, en: '' },
    font: 'zh',
    size: 14,
    weight: 400,
    color: '$ink',
    align: 'left',
    valign: 'top',
    lineHeight: 1.4,
    letterSpacing: 0,
    italic: false,
    underline: false,
    fill: null,
  }) as StudioNode;
const frame = (id: string, children: StudioNode[], more: Record<string, unknown> = {}): StudioNode =>
  ({ type: 'frame', id, ...base, x: 0, y: 0, w: 160, h: 90, fill: '$surface', stroke: null, strokeWidth: 0, radius: 12, shadow: 'none', clip: false, children, ...more }) as StudioNode;
const inst = (id: string, component: string, more: Partial<StudioInstanceNode> = {}): StudioNode => ({ type: 'instance', id, ...base, x: 10, y: 20, w: 200, h: 100, component, ...more });

/** 小程序的默认版面，活动页上放一个组件的两处 */
function withCard(): StudioDoc {
  const d = defaultStudioDoc('mp');
  d.components = { 'c-card01': { name: '卡片', node: frame('card', [text('title', '标题', 12, 12)], { opacity: 0.8 }) } };
  d.screens.activity!.nodes.push(inst('i-one', 'c-card01'), inst('i-two', 'c-card01', { x: 30, opacity: 0.5, sizing: { w: 'fill', h: 'fixed' } }));
  return d;
}

describe('组件：画、展开、核对', () => {
  it('实例照组件画：位置、大小、转角、藏不藏、尺寸规则用实例的，透明度相乘，编号用实例的', () => {
    const d = withCard();
    const v = instanceView(d.screens.activity!.nodes.at(-1) as StudioInstanceNode, d.components!['c-card01']!.node);
    expect(v).toMatchObject({ type: 'frame', id: 'i-two', x: 30, y: 20, w: 200, h: 100, opacity: 0.4, sizing: { w: 'fill', h: 'fixed' }, fill: '$surface', radius: 12 });
    expect(v.type === 'frame' && v.children[0]!.id).toBe('title');
  });

  it('展开：实例换成组件的样子，里面的编号加实例的前缀、不重；组件里套的组件也展开；找不到组件的不画；不留 components', () => {
    const d = withCard();
    d.components!['c-badge01'] = { name: '角标', node: text('b', '新') };
    (d.components!['c-card01']!.node as Extract<StudioNode, { type: 'frame' }>).children.push(inst('inner', 'c-badge01', { x: 120, y: 4, w: 30, h: 20 }));
    d.screens.activity!.nodes.push(inst('i-gone', 'c-nothere'));
    const e = expandInstances(d);
    expect(e.components).toBeUndefined();
    const ids: string[] = [];
    let instances = 0;
    for (const s of Object.values(e.screens)) walkNodes(s.nodes, (n) => (ids.push(n.id), n.type === 'instance' && (instances += 1)));
    expect(instances).toBe(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['i-one', 'i-one__title', 'i-one__inner', 'i-two__title']));
    expect(ids).not.toContain('i-gone');
    const one = e.screens.activity!.nodes.find((n) => n.id === 'i-one')!;
    expect(one.type === 'frame' && one.children.find((c) => c.id === 'i-one__inner')).toMatchObject({ type: 'text', x: 120, y: 4, w: 30, h: 20 });
    // 没有组件的版面原样返回
    const plain = defaultStudioDoc('mp');
    expect(expandInstances(plain)).toBe(plain);
  });

  it('格式与核对：合格的组件没问题；删掉的组件、功能块进组件、组件里编号重复、组件套自己都拦下', () => {
    const ok = withCard();
    expect(DocSchema.parse(ok)).toEqual(ok);
    expect(validateStudioDoc(ok)).toEqual([]);
    expect(DocSchema.safeParse({ ...ok, components: { 'C-bad!': { name: 'x', node: text('t', 'a') } } }).success).toBe(false);
    expect(DocSchema.safeParse({ ...ok, components: { 'c-card02': { name: '', node: text('t', 'a') } } }).success).toBe(false);

    const bad = withCard();
    bad.screens.activity!.nodes.push(inst('i-x', 'c-nothere'));
    bad.components!['c-dup01'] = { name: '重复', node: frame('f', [text('same', 'a'), text('same', 'b')]) };
    bad.components!['c-blk01'] = { name: '有块', node: frame('g', [{ type: 'block', id: 'blk', ...base, x: 0, y: 0, w: 375, h: 300, block: 'mp.banner', props: {} } as StudioNode]) };
    bad.components!['c-aaaa1'] = { name: '甲', node: frame('a', [inst('to-b', 'c-bbbb1')]) };
    bad.components!['c-bbbb1'] = { name: '乙', node: frame('b', [inst('to-a', 'c-aaaa1')]) };
    const msgs = validateStudioDoc(bad).map((i) => i.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('用的组件已经删掉了'),
        expect.stringContaining('组件「重复」里节点编号「same」重复了'),
        expect.stringContaining('功能块不能存进组件'),
        expect.stringContaining('组件「甲」里又放了它自己'),
        expect.stringContaining('组件「乙」里又放了它自己'),
      ]),
    );
    expect(componentCycles(bad).sort()).toEqual(['c-aaaa1', 'c-bbbb1']);
  });

  it('组件里的图算版面用到的素材；改了组件，发布记录记「组件」', () => {
    const d = withCard();
    const img: StudioNode = { type: 'image', id: 'pic', ...base, x: 0, y: 0, w: 40, h: 40, asset: 'a'.repeat(64), fit: 'cover', radius: 0, fill: null } as StudioNode;
    (d.components!['c-card01']!.node as Extract<StudioNode, { type: 'frame' }>).children.push(img);
    expect(docAssets(d)).toContain('a'.repeat(64));
    const before = withCard();
    expect(changedScreens(before, renameComponent(before, 'c-card01', '新名字'))).toEqual(['components']);
  });
});

describe('组件：编辑器里的操作', () => {
  it('存成组件：原来的位置换成实例（编号、位置、大小不变），组件放在画布中间；功能块、实例存不成', () => {
    const d = defaultStudioDoc('mp');
    const card = frame('my-card', [text('t1', '会员日')], { x: 20, y: 400, w: 160, h: 90, name: '活动卡' });
    const d1 = insertNode(d, 'activity', card);
    const r = makeComponentFrom(d1, 'activity', 'my-card', MP_SURFACE)!;
    expect(r).not.toBeNull();
    const placed = findNode(r.doc, 'activity', 'my-card')!.node;
    expect(placed).toMatchObject({ type: 'instance', component: r.cid, x: 20, y: 400, w: 160, h: 90 });
    expect(r.doc.components![r.cid]).toMatchObject({ name: '活动卡', node: { type: 'frame', w: 160, h: 90, x: (375 - 160) / 2 } });
    expect(validateStudioDoc(r.doc)).toEqual([]);
    // 实例、功能块存不成
    expect(makeComponentFrom(r.doc, 'activity', 'my-card', MP_SURFACE)).toBeNull();
    const banner = r.doc.screens.home!.nodes.find((n) => n.type === 'block')!;
    expect(makeComponentFrom(r.doc, 'home', banner.id, MP_SURFACE)).toBeNull();
  });

  it('自动排列里撑满的块：组件用画布上量到的大小', () => {
    const d = defaultStudioDoc('mp');
    let row: StudioNode | null = null;
    walkNodes(d.screens.home!.nodes, (n) => {
      if (!row && n.type === 'frame' && n.action && n.sizing?.w === 'fill') row = n;
    });
    expect(row).not.toBeNull();
    const id = (row as unknown as StudioNode).id;
    const r = makeComponentFrom(d, 'home', id, MP_SURFACE, { x: 24, y: 300, w: 107.7, h: 96 })!;
    expect(r.doc.components![r.cid]!.node).toMatchObject({ w: 107.7, h: 96 });
    // 原来那一处照旧撑满
    expect(findNode(r.doc, 'home', id)!.node).toMatchObject({ type: 'instance', sizing: { w: 'fill' } });
  });

  it('改组件：当成一屏改（「@组件编号」），改了写回组件，各处的实例跟着变', () => {
    const d = withCard();
    const sc = componentScreen('c-card01');
    expect(screenOf(d, sc).nodes).toHaveLength(1);
    const d2 = updateNode(d, sc, 'title', { text: { zh: '改过的标题', en: '' } } as Partial<StudioNode>);
    const master = d2.components!['c-card01']!.node;
    expect(master.type === 'frame' && master.children[0]).toMatchObject({ text: { zh: '改过的标题' } });
    // 加在组件这个框里
    const d3 = insertNode(d2, sc, text('more', '加的一行'), undefined, 'card');
    expect(d3.components!['c-card01']!.node.type === 'frame' && (d3.components!['c-card01']!.node as Extract<StudioNode, { type: 'frame' }>).children.map((c) => c.id)).toEqual(['title', 'more']);
    // 屏上没变（还是两个实例）
    expect(d3.screens.activity).toEqual(d.screens.activity);
  });

  it('拆开：实例换成组件的一份副本（外面沿用实例的编号与位置大小，里面换新编号）；放一个、删掉没人用的', () => {
    const d = withCard();
    const d2 = detachInstance(d, 'activity', 'i-two');
    const copy = findNode(d2, 'activity', 'i-two')!.node;
    expect(copy).toMatchObject({ type: 'frame', id: 'i-two', x: 30, w: 200, h: 100, opacity: 0.4, sizing: { w: 'fill', h: 'fixed' } });
    expect(copy.type === 'frame' && copy.children[0]!.id).not.toBe('title');
    expect(componentUses(d2, 'c-card01')).toBe(1);
    // 还有人用的删不掉；放一个；都拆开以后能删
    expect(deleteComponent(d2, 'c-card01')).toBe(d2);
    const another = makeInstance(d2, 'c-card01', 100, 100)!;
    expect(another).toMatchObject({ type: 'instance', component: 'c-card01', w: 160, h: 90 });
    const d3 = detachInstance(d2, 'activity', 'i-one');
    expect(componentUses(d3, 'c-card01')).toBe(0);
    const d4 = deleteComponent(d3, 'c-card01');
    expect(d4.components).toBeUndefined();
    expect(validateStudioDoc(d4)).toEqual([]);
  });
});
