// 8.0.13 电子菜单整改（docs/EMENU.md 第 11 节）里页面这边的算术：键盘弹起时舞台怎么摆、翻页松手翻到哪、拖过头的阻尼，
// 以及切到英文时每样内容取哪一份（录了英文的用英文，没录的显示中文，单位、规格、常见忌口有内置的英文）。不开浏览器、不连数据库。

import { describe, expect, it } from 'vitest';
import { dishMissingEnglish, emenuOptionEn, emenuSpecLabelEn, emenuUnitEn } from '../src/shared/emenu';
import { blockLabel, dishAttrs, dishDescription, dishNames, dishTagline, dishUnit, guestErrorEn, messages, namePair, optionLabel, specLabel } from '../src/client/features/emenu/i18n';
import { dragPosition, nextStable, rubberBand, settlePage, STAGE_H, STAGE_W, stageLayout, type ViewportNow } from '../src/client/features/emenu/viewport';

const view = (patch: Partial<ViewportNow> = {}): ViewportNow => ({ width: 1280, height: 800, visibleTop: 0, visibleHeight: patch.height ?? 800, editing: false, ...patch });

describe('键盘弹起时舞台怎么摆', () => {
  it('稳定的窗口大小：正在输入时高度变小当作键盘，不认；宽度变了、高度变大、没在输入时变矮都认', () => {
    const start = nextStable(null, view());
    expect(start).toEqual({ w: 1280, h: 800 });
    // 安卓键盘把网页可用的高度压到 420：正在输入 → 还是原来的大小
    expect(nextStable(start, view({ height: 420, editing: true }))).toEqual({ w: 1280, h: 800 });
    // 没在输入时变矮（拖小了窗口）：认
    expect(nextStable(start, view({ height: 600 }))).toEqual({ w: 1280, h: 600 });
    // 旋转：宽度变了，正在输入也认
    expect(nextStable(start, view({ width: 800, height: 1280, editing: true }))).toEqual({ w: 800, h: 1280 });
    // 键盘收起：高度回来
    expect(nextStable({ w: 1280, h: 420 }, view({ height: 800, editing: true }))).toEqual({ w: 1280, h: 800 });
  });

  it('缩放只按稳定的大小算：键盘弹起前后页面一样大、位置一样（搜索框在最上面，不用挪）', () => {
    const stable = { w: 1280, h: 800 };
    const before = stageLayout(stable, view(), null);
    expect(before.scale).toBeCloseTo(800 / STAGE_H, 6);
    expect(before.left).toBeCloseTo((1280 - STAGE_W * before.scale) / 2, 6);
    expect([before.top, before.shift, before.visible, before.keyboard]).toEqual([0, 0, STAGE_H, false]);
    // 键盘弹起（布局视口压到 420），输入框是顶上的搜索框（下沿 80）
    const kb = stageLayout(stable, view({ height: 420, editing: true }), 80);
    expect([kb.scale, kb.left, kb.top, kb.shift]).toEqual([before.scale, before.left, 0, 0]);
    expect(kb.keyboard).toBe(true);
    // 键盘上面看得见 420 屏幕像素 → 设计稿里的 403
    expect(kb.visible).toBeCloseTo(420 / before.scale, 6);
  });

  it('输入框在键盘下面：整页往上挪到它露出来（留 12 设计像素），最多挪键盘那么高；键盘收起回到原位', () => {
    const stable = { w: 1024, h: 768 };
    // 备注抽屉的自定义备注：下沿 656；键盘盖到 420
    const kb = stageLayout(stable, view({ width: 1024, height: 420, editing: true }), 656);
    expect(kb.shift).toBe(656 + 12 - 420);
    expect(kb.top).toBe(-(656 + 12 - 420));
    // 输入框在最底下（下沿 760）、键盘只有 100 高：最多挪 100
    expect(stageLayout(stable, view({ width: 1024, height: 668, editing: true }), 760).shift).toBe(100);
    // 键盘盖在页面上的平板（iPad）：布局视口不变，只有看得见的那一块变小——一样处理
    const ipad = stageLayout(stable, view({ width: 1024, height: 768, visibleHeight: 420, editing: true }), 656);
    expect([ipad.scale, ipad.shift, ipad.keyboard]).toEqual([1, 248, true]);
    // 系统自己把页面往上推了 200（visualViewport.offsetTop）：只再补不够的 48
    expect(stageLayout(stable, view({ width: 1024, height: 768, visibleTop: 200, visibleHeight: 420, editing: true }), 656).shift).toBe(48);
    // 没在输入、或者只是地址栏收放的几十像素：不算键盘
    expect(stageLayout(stable, view({ width: 1024, height: 768, visibleHeight: 420 }), 656).keyboard).toBe(false);
    expect(stageLayout(stable, view({ width: 1024, height: 768, visibleHeight: 720, editing: true }), 760).shift).toBe(0);
  });
});

describe('翻页的手感', () => {
  it('拖过头有阻尼：越拖越走不动，永远到不了一整屏', () => {
    expect(rubberBand(0, STAGE_W)).toBe(0);
    expect(rubberBand(-5, STAGE_W)).toBe(0);
    const a = rubberBand(100, STAGE_W);
    const b = rubberBand(400, STAGE_W);
    const c = rubberBand(4000, STAGE_W);
    expect(a).toBeGreaterThan(40);
    expect(a).toBeLessThan(100);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeLessThan(300 * 0.55);
    expect(c).toBeLessThan(STAGE_W);
  });

  it('拖动时页面跟手；第一页往右、最后一页往左带阻尼', () => {
    // 5 页，停在第 2 页（1024）：往左拖 300 → 1324
    expect(dragPosition(1024, -300, 5)).toBe(1324);
    expect(dragPosition(1024, 300, 5)).toBe(724);
    // 第一页往右拖 200：往回走不到 200
    const first = dragPosition(0, 200, 5);
    expect(first).toBeLessThan(0);
    expect(first).toBeGreaterThan(-200);
    // 最后一页（4096）往左拖 200
    const last = dragPosition(4096, -200, 5);
    expect(last).toBeGreaterThan(4096);
    expect(last).toBeLessThan(4296);
    // 只有一页：两头都带阻尼
    expect(Math.abs(dragPosition(0, -200, 1))).toBeLessThan(200);
  });

  it('松手：拖过五分之一屏或者甩得够快翻一页，一次最多一页，两头不出界', () => {
    expect(settlePage(2, 100, 0, 5)).toBe(2);
    expect(settlePage(2, 250, 0, 5)).toBe(3);
    expect(settlePage(2, -250, 0, 5)).toBe(1);
    // 只拖了一点、但甩得快
    expect(settlePage(2, 40, 0.6, 5)).toBe(3);
    expect(settlePage(2, -40, -0.6, 5)).toBe(1);
    // 拖了两屏也只翻一页
    expect(settlePage(2, 2200, 3, 5)).toBe(3);
    expect(settlePage(4, 500, 2, 5)).toBe(4);
    expect(settlePage(0, -500, -2, 5)).toBe(0);
    expect(settlePage(0, 500, 2, 1)).toBe(0);
  });
});

describe('中 / EN：每样内容取哪一份', () => {
  const dish = { name: '砂锅焗溪鳗', nameEn: 'Clay Pot Baked Stream Eel', tagline: '煎档', taglineEn: 'Pan-fried', description: '砂锅慢焗。', descriptionEn: 'Slow-baked.', attrs: ['产地：法国'], attrsEn: ['Origin: France'], unit: '份', unitEn: '' };
  const bare = { name: '小炒黑猪肉', nameEn: '', tagline: '例份', taglineEn: '', description: '现炒。', descriptionEn: '', attrs: ['微辣'], attrsEn: [], unit: '盅', unitEn: '' };

  it('中文模式与 8.0.12 一样：中文为主、英文名是下面的小字', () => {
    expect(dishNames(dish, 'zh')).toEqual({ main: '砂锅焗溪鳗', sub: 'Clay Pot Baked Stream Eel', mainEn: false });
    expect(dishTagline(dish, 'zh')).toEqual({ text: '煎档', en: false });
    expect(dishDescription(dish, 'zh')).toEqual({ text: '砂锅慢焗。', en: false });
    expect(dishAttrs(dish, 'zh')).toEqual({ list: ['产地：法国'], en: false });
    expect(dishUnit(dish, 'zh')).toEqual({ text: '份', en: false });
    expect(specLabel({ label: '大份', labelEn: 'Big' }, 'zh')).toBe('大份');
    expect(optionLabel('不加香菜', 'zh', { 不加香菜: 'No coriander' })).toBe('不加香菜');
  });

  it('切到英文：录了英文的英文为主、中文名缩成小字；介绍、小字、属性行、单位、规格用英文', () => {
    expect(dishNames(dish, 'en')).toEqual({ main: 'Clay Pot Baked Stream Eel', sub: '砂锅焗溪鳗', mainEn: true });
    expect(dishTagline(dish, 'en')).toEqual({ text: 'Pan-fried', en: true });
    expect(dishDescription(dish, 'en')).toEqual({ text: 'Slow-baked.', en: true });
    expect(dishAttrs(dish, 'en')).toEqual({ list: ['Origin: France'], en: true });
    // 单位没填英文：用内置的
    expect(dishUnit(dish, 'en')).toEqual({ text: 'portion', en: true });
    expect(dishUnit({ unit: '份', unitEn: 'pot' }, 'en')).toEqual({ text: 'pot', en: true });
  });

  it('没录英文的地方显示中文，不留空白（EN4）', () => {
    expect(dishNames(bare, 'en')).toEqual({ main: '小炒黑猪肉', sub: '', mainEn: false });
    expect(dishTagline(bare, 'en')).toEqual({ text: '例份', en: false });
    expect(dishDescription(bare, 'en')).toEqual({ text: '现炒。', en: false });
    expect(dishAttrs(bare, 'en')).toEqual({ list: ['微辣'], en: false });
    // 内置里有「盅」；没有的单位显示中文
    expect(dishUnit(bare, 'en')).toEqual({ text: 'cup', en: true });
    expect(dishUnit({ unit: '尾', unitEn: '' }, 'en')).toEqual({ text: '尾', en: false });
    expect(namePair('西式午餐', '  ', 'en')).toEqual({ main: '西式午餐', sub: '  ', mainEn: false });
  });

  it('单位、规格、忌口：后台填的 → 内置的 → 中文', () => {
    expect(emenuUnitEn('瓶', '')).toBe('bottle');
    expect(emenuUnitEn('瓶', ' btl ')).toBe('btl');
    expect(emenuUnitEn('桌', '')).toBe('桌');
    expect(emenuSpecLabelEn('大份', '')).toBe('Large');
    expect(emenuSpecLabelEn('大份', 'For sharing')).toBe('For sharing');
    expect(emenuSpecLabelEn('鸳鸯', '')).toBe('鸳鸯');
    expect(specLabel({ label: '小份', labelEn: '' }, 'en')).toBe('Small');
    expect(emenuOptionEn('不加香菜', {})).toBe('No cilantro');
    expect(emenuOptionEn('不加香菜', { 不加香菜: 'No coriander' })).toBe('No coriander');
    expect(emenuOptionEn('不加折耳根', {})).toBe('不加折耳根');
    expect(optionLabel('慢起', 'en', {})).toBe('Serve later');
  });

  it('售罄、下架、时段不可售按语言排主次；缺英文的判断', () => {
    expect(blockLabel('sold_out', 'zh')).toEqual({ main: '已售罄', sub: 'Sold Out', mainEn: false });
    expect(blockLabel('sold_out', 'en')).toEqual({ main: 'Sold Out', sub: '已售罄', mainEn: true });
    expect(blockLabel('closed', 'en').main).toBe('Not Available Now');
    expect(dishMissingEnglish(dish)).toBe(false);
    expect(dishMissingEnglish(bare)).toBe(true);
    // 有英文名、有中文介绍、没有英文介绍：也算缺
    expect(dishMissingEnglish({ nameEn: 'Pork', description: '现炒。', descriptionEn: '' })).toBe(true);
    // 本来就没有介绍的不算
    expect(dishMissingEnglish({ nameEn: 'Pork', description: '', descriptionEn: '' })).toBe(false);
  });

  it('两种语言的词表一样全；给客人看的出错提示只有几种拒绝码有英文，别的照门店系统给的', () => {
    const zh = messages('zh');
    const en = messages('en');
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(typeof en[k], k).toBe(typeof zh[k]);
      if (typeof en[k] === 'string') expect(en[k] as string, k).not.toMatch(/[一-鿿]/);
    }
    expect(zh.cartEmpty).toBe('还没有点菜');
    expect(en.added('Eel', 'Large')).toBe('Eel (Large) added');
    expect(zh.added('溪鳗', '大份')).toBe('溪鳗（大份） 加进未下单了');
    expect(en.endCart(1)).toContain('1 item in your cart');
    expect(en.endCart(3)).toContain('3 items');
    expect(guestErrorEn('TAG_NOT_IN_STORE')).toMatch(/tag/i);
    expect(guestErrorEn('TABLE_NOT_FOUND')).toMatch(/table/i);
    // 服务员那一步的原因（密码不对、估清）不翻
    expect(guestErrorEn('PIN_INVALID')).toBeNull();
    expect(guestErrorEn('DISH_SOLD_OUT')).toBeNull();
  });
});
