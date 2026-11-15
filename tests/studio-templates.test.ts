// 平板菜单 11 种版式的卡片模板（8.1.2，GZ13，docs/WORKBENCH_V811.md 第 13 节）：登记的位置与设计稿一致、改动只存改了的、
// 恢复默认以后与没改过一样、核对拦得住不能改的项。只测格式与纯函数（不连数据库）；平板上逐屏一致由截图比对核对。
import { describe, expect, it } from 'vitest';
import { EMENU_LAYOUT_INFO, EMENU_LAYOUTS } from '../src/shared/emenu';
import {
  changedScreens,
  DISH_STATE_DEFAULT,
  dishStateStyle,
  defaultStudioDoc,
  DocSchema,
  EMENU_TEMPLATES,
  resetLayoutTemplate,
  resetSlot,
  resolveSlot,
  setDishState,
  setSlotFlags,
  setSlotSpot,
  slotDefault,
  slotSpot,
  validateStudioDoc,
  type StudioDoc,
} from '../src/shared/studio';

const doc0 = () => defaultStudioDoc('emenu');
const errorsOf = (d: StudioDoc) => validateStudioDoc(d).map((i) => i.message);

describe('卡片模板：登记的位置', () => {
  it('11 种版式都有模板；块的编号不重；第几道菜都在版式能放的道数里；每道菜都有一块文字', () => {
    expect(Object.keys(EMENU_TEMPLATES).sort()).toEqual([...EMENU_LAYOUTS].sort());
    for (const layout of EMENU_LAYOUTS) {
      const slots = EMENU_TEMPLATES[layout].slots;
      expect(new Set(slots.map((s) => s.key)).size).toBe(slots.length);
      const n = EMENU_LAYOUT_INFO[layout].slots;
      for (const s of slots) if (s.dish !== undefined) expect(s.dish).toBeLessThan(n);
      // 每一道菜都有菜名价格（文字块或文字陈列的一行）：藏不掉，客人才点得到
      const dishes = new Set(slots.filter((s) => s.kind === 'text' || s.kind === 'row').map((s) => s.dish));
      expect(dishes.size).toBe(n);
    }
  });

  it('几处设计稿量的数（原样、放大两档）没有走样', () => {
    const at = (layout: keyof typeof EMENU_TEMPLATES, key: string, mode: 'design' | 'big') => slotDefault(EMENU_TEMPLATES[layout].slots.find((s) => s.key === key)!, mode);
    expect(at('cover', 'photo', 'design')).toEqual({ x: 555.5, y: 133.8, w: 428.5, h: 594.2 });
    expect(at('cover', 'text', 'big')).toMatchObject({ x: 40, w: 429, bottom: 485 });
    expect(at('list_image', 'd3', 'design')).toMatchObject({ x: 823.8, y: 350.9, w: 170 });
    expect(at('list_image', 'd3', 'big')).toMatchObject({ x: 778, y: 392, w: 206 });
    expect(at('list_text', 'r9', 'big')).toMatchObject({ x: 660, y: 150 + 4 * 112 });
    // 介绍的放大一档：宽是看到的宽（337 × 1.4）
    expect(at('single_wide', 'intro', 'big')).toMatchObject({ x: 512, y: 520, w: 471.8 });
  });
});

describe('卡片模板：改动', () => {
  it('挪一块只存改了的项；挪回原处就去掉，版面里不留 templates', () => {
    let d = setSlotSpot(doc0(), 'list_image', 'photo', 'design', { x: 60, y: 140 });
    expect(d.templates).toEqual({ list_image: { photo: { design: { x: 60, y: 140 } } } });
    d = setSlotSpot(d, 'list_image', 'photo', 'design', { x: 40, y: 133.8 });
    expect(d.templates).toBeUndefined();
    expect(d).toEqual(doc0());
  });

  it('放大一档没改的项跟着原样一档；单独改过的不跟', () => {
    // 照片没有登记放大一档：原样挪了，放大也跟着
    let d = setSlotSpot(doc0(), 'duo_row', 'a.photo', 'design', { x: 50 });
    const photo = () => resolveSlot(EMENU_TEMPLATES.duo_row.slots.find((s) => s.key === 'a.photo')!, d.templates?.duo_row?.['a.photo']);
    expect(slotSpot(photo(), 'big').x).toBe(50);
    d = setSlotSpot(d, 'duo_row', 'a.photo', 'big', { x: 70 });
    expect(slotSpot(photo(), 'big').x).toBe(70);
    expect(slotSpot(photo(), 'design').x).toBe(50);
    // 放大一档改成与原样一样：去掉（又跟着原样）
    d = setSlotSpot(d, 'duo_row', 'a.photo', 'big', { x: 50 });
    expect(d.templates?.duo_row?.['a.photo']).toEqual({ design: { x: 50 } });
  });

  it('放大一档里往上长的文字：挪的是下沿（照旧往上长）；写了 y 的改成从上往下排', () => {
    const def = EMENU_TEMPLATES.cover.slots.find((s) => s.key === 'text')!;
    let d = setSlotSpot(doc0(), 'cover', 'text', 'big', { bottom: 470 });
    expect(d.templates?.cover?.text).toEqual({ big: { bottom: 470 } });
    expect(slotSpot(resolveSlot(def, d.templates?.cover?.text), 'big')).toMatchObject({ bottom: 470 });
    d = setSlotSpot(d, 'cover', 'text', 'big', { y: 300 });
    expect(d.templates?.cover?.text).toEqual({ big: { y: 300 } });
    const s = slotSpot(resolveSlot(def, d.templates?.cover?.text), 'big');
    expect(s.y).toBe(300);
    expect(s.bottom).toBeUndefined();
    // 下沿挪回登记的：去掉
    d = setSlotSpot(d, 'cover', 'text', 'big', { bottom: 485 });
    expect(d.templates).toBeUndefined();
  });

  it('藏起来、圆角、恢复默认（一档 / 一块 / 整个版式）', () => {
    let d = setSlotFlags(doc0(), 'single_left', 'detail', { hidden: true });
    d = setSlotFlags(d, 'single_left', 'photo', { radius: 16 });
    d = setSlotSpot(d, 'single_left', 'photo', 'big', { w: 400 });
    d = setSlotSpot(d, 'single_left', 'photo', 'design', { y: 150 });
    expect(d.templates?.single_left).toEqual({ detail: { hidden: true }, photo: { radius: 16, big: { w: 400 }, design: { y: 150 } } });
    d = resetSlot(d, 'single_left', 'photo', 'big');
    expect(d.templates?.single_left?.photo).toEqual({ radius: 16, design: { y: 150 } });
    d = resetSlot(d, 'single_left', 'photo');
    expect(d.templates?.single_left).toEqual({ detail: { hidden: true } });
    d = setSlotFlags(d, 'single_left', 'detail', { hidden: false });
    expect(d.templates).toBeUndefined();
    d = setSlotFlags(d, 'trio_row', 'b.photo', { hidden: true });
    expect(resetLayoutTemplate(d, 'trio_row')).toEqual(doc0());
  });

  it('不认识的版式、块：什么都不改', () => {
    expect(setSlotSpot(doc0(), 'nope', 'photo', 'design', { x: 1 })).toEqual(doc0());
    expect(setSlotFlags(doc0(), 'cover', 'nope', { hidden: true })).toEqual(doc0());
  });
});

describe('卡片模板：格式与核对', () => {
  it('合格式的改动核对没有问题；格式不收乱写的键', () => {
    let d = setSlotSpot(doc0(), 'cover', 'photo', 'design', { x: 500, w: 480, h: 560 });
    d = setSlotFlags(d, 'cover', 'detail', { hidden: true, radius: 12 });
    d = setSlotSpot(d, 'cover', 'text', 'big', { bottom: 470, w: 440 });
    expect(DocSchema.parse(d)).toEqual(d);
    expect(errorsOf(d)).toEqual([]);
    const bad = (templates: unknown) => DocSchema.safeParse({ ...doc0(), templates }).success;
    expect(bad({ 'Cover!': {} })).toBe(false);
    expect(bad({ cover: { 'photo<x>': {} } })).toBe(false);
    expect(bad({ cover: { photo: { design: { x: 'a' } } } })).toBe(false);
    expect(bad({ cover: { photo: { design: { w: 1 } } } })).toBe(false);
    expect(bad({ cover: { photo: { extra: 1 } } })).toBe(true); // 多写的键被去掉（与别处的格式一样）
  });

  it('核对拦下：没有的版式、块，藏菜名价格，文字加圆角，竖排小标题改宽、文字改高，原样一档写下沿，上下沿一起写', () => {
    const d = { ...doc0(), templates: {} } as StudioDoc;
    const t = d.templates!;
    t.nope = { photo: {} };
    t.cover = { nope: {}, text: { hidden: true, radius: 4, design: { bottom: 10 } } };
    t.list_image = { title: { design: { w: 60 } }, d0: { design: { h: 60 } } };
    t.duo_stagger = { 'b.text': { big: { bottom: 300, y: 200 } }, 'a.text': { big: { bottom: 300 } } };
    const errs = errorsOf(d);
    expect(errs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('没有「nope」这种版式'),
        expect.stringContaining('没有「nope」这一块'),
        expect.stringContaining('不能藏起来'),
        expect.stringContaining('没有圆角这一项'),
        expect.stringContaining('原样一档没有「下沿」这一项'),
        expect.stringContaining('竖排小标题」不能改宽'),
        expect.stringContaining('第 1 道」不能改高'),
        expect.stringContaining('上沿、下沿只能定一个'),
        expect.stringContaining('第 1 道的文字」没有「下沿」这一项'),
      ]),
    );
  });

  it('手机界面没有卡片模板', () => {
    const d = { ...defaultStudioDoc('mp'), templates: { cover: { photo: { hidden: true } } } };
    expect(errorsOf(d)).toEqual([expect.stringContaining('没有卡片模板')]);
  });
});

describe('菜的几种样子（变体）', () => {
  it('没改过是设计稿的样子；只存改过的项，改回去就去掉', () => {
    expect(dishStateStyle(undefined, 'sold_out')).toEqual(DISH_STATE_DEFAULT);
    expect(DISH_STATE_DEFAULT).toMatchObject({ style: 'center', shade: '#000000', shadeOpacity: 0.55, textOpacity: 0.5 });
    let d = setDishState(doc0(), 'sold_out', { style: 'badge', shadeOpacity: 0.2 });
    d = setDishState(d, 'off', { textOpacity: 0.3, grayscale: true });
    expect(d.dishStates).toEqual({ sold_out: { style: 'badge', shadeOpacity: 0.2 }, off: { textOpacity: 0.3, grayscale: true } });
    expect(dishStateStyle(d.dishStates, 'sold_out')).toMatchObject({ style: 'badge', shadeOpacity: 0.2, shade: '#000000' });
    expect(dishStateStyle(d.dishStates, 'closed')).toEqual(DISH_STATE_DEFAULT);
    expect(DocSchema.parse(d)).toEqual(d);
    expect(errorsOf(d)).toEqual([]);
    d = setDishState(d, 'sold_out', { style: 'center', shadeOpacity: 0.55 });
    d = setDishState(d, 'off', { ...DISH_STATE_DEFAULT });
    expect(d.dishStates).toBeUndefined();
    expect(d).toEqual(doc0());
  });

  it('格式拦下乱写的样子、颜色、深浅；手机界面没有；发布记录算在「卡片模板」里', () => {
    const bad = (dishStates: unknown) => DocSchema.safeParse({ ...doc0(), dishStates }).success;
    expect(bad({ sold_out: { style: 'blink' } })).toBe(false);
    expect(bad({ sold_out: { shade: 'red' } })).toBe(false);
    expect(bad({ sold_out: { shadeOpacity: 1 } })).toBe(false);
    expect(bad({ off: { textOpacity: 0.1 } })).toBe(false);
    expect(bad({ closed: { shade: '$tan', textColor: '#FFFFFF' } })).toBe(true);
    expect(errorsOf({ ...defaultStudioDoc('mp'), dishStates: { sold_out: { style: 'dim' } } })).toEqual([expect.stringContaining('没有「菜的几种样子」')]);
    const before = doc0();
    expect(changedScreens(before, setDishState(before, 'closed', { style: 'dim' }))).toEqual(['templates']);
    expect(changedScreens(before, before)).toEqual([]);
  });
});
