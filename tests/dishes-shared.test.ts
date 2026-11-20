// 8.1.15 菜品管理（docs/DISHES_V8115.md）的纯函数：出品备注怎么拼、套餐内容怎么写、改价的前后对比、菜品表的筛选、
// 导入表格里一格一格怎么读。不连数据库。

import { describe, expect, it } from 'vitest';
import { MAX_DISH_NOTE } from '../src/shared/dining';
import {
  addonNote,
  composeDishNote,
  dishNoteFits,
  filterDishes,
  parseComboPart,
  parseSheetOutlet,
  parseSheetPrice,
  parseSheetStatus,
  partsText,
  priceChangeText,
  priceDiff,
  pricesText,
  remainingText,
  splitSheetList,
} from '../src/shared/dishes';

describe('点单：做法、加料、套餐写在出品单上的样子', () => {
  it('做法在前、用「，」隔开，手写的备注接在后面；什么都没有是空的', () => {
    expect(composeDishNote(['微辣', '去冰'], ' 少盐 ')).toBe('微辣，去冰，少盐');
    expect(composeDishNote(['微辣'], '')).toBe('微辣');
    expect(composeDishNote([], '不要香菜')).toBe('不要香菜');
    expect(composeDishNote([], '  ')).toBe('');
  });

  it('拼出来超过出品备注的长度（40 个字）不让加', () => {
    const many = ['一二三四五六七八', '二二三四五六七八', '三二三四五六七八', '四二三四五六七八'];
    expect(composeDishNote(many, '').length).toBe(35);
    expect(dishNoteFits(many, '')).toBe(true);
    expect(dishNoteFits(many, '一二三四')).toBe(true);
    expect(dishNoteFits(many, '一二三四五')).toBe(false);
    expect(MAX_DISH_NOTE).toBe(40);
  });

  it('加料那一行写「配 某菜」；菜名最长 32 个字也放得下', () => {
    expect(addonNote('牛肉面')).toBe('配 牛肉面');
    expect(addonNote('长'.repeat(32)).length).toBeLessThanOrEqual(MAX_DISH_NOTE);
  });

  it('套餐内容写成「菜名×份数」，用顿号隔开', () => {
    expect(
      partsText([
        { name: '柠檬茶', quantity: 1 },
        { name: '薯条', quantity: 2 },
      ]),
    ).toBe('柠檬茶×1、薯条×2');
    expect(partsText([])).toBe('');
  });
});

describe('改价：前后对比', () => {
  it('只出改了的档，按标准、专业、优选排；新加的档改前为空，去掉的档改后为空', () => {
    const before = [
      { tier: 'standard' as const, price: 3800 },
      { tier: 'professional' as const, price: 4800 },
    ];
    const after = [
      { tier: 'premium' as const, price: 5800 },
      { tier: 'standard' as const, price: 4200 },
    ];
    expect(priceDiff(before, after)).toEqual([
      { tier: 'standard', oldPrice: 3800, newPrice: 4200 },
      { tier: 'professional', oldPrice: 4800, newPrice: null },
      { tier: 'premium', oldPrice: null, newPrice: 5800 },
    ]);
    expect(priceDiff(before, [...before].reverse())).toEqual([]);
    expect(priceDiff([], before).map(priceChangeText)).toEqual(['新加 标准 ¥38.00', '新加 专业 ¥48.00']);
    expect(priceDiff(before, after).map(priceChangeText)).toEqual(['标准 ¥38.00 → ¥42.00', '去掉 专业（原 ¥48.00）', '新加 优选 ¥58.00']);
  });

  it('规格与价格的字：一档只写价格，多档写上档名', () => {
    expect(pricesText([{ tier: 'standard', price: 3800 }])).toBe('¥38.00');
    expect(
      pricesText([
        { tier: 'standard', price: 3800 },
        { tier: 'premium', price: 5800 },
      ]),
    ).toBe('标准 ¥38.00 / 优选 ¥58.00');
  });
});

describe('菜品表：搜索与筛选', () => {
  const rows = [
    { name: '宫保鸡丁', category: '餐饮', outlet: 'restaurant' as const, group: '餐饮', stationName: '热菜', active: true, remaining: null, methods: ['微辣', '中辣'] },
    { name: '柠檬茶', category: '饮品', outlet: 'water' as const, group: '手作饮料', stationName: '水吧', active: true, remaining: 0, methods: ['去冰'] },
    { name: '鲜切果盘', category: '果吧', outlet: 'fruit' as const, group: '', stationName: '果吧档', active: false, remaining: 0, methods: [] },
    { name: 'Mojito', category: '鸡尾酒', outlet: 'water' as const, group: '调酒', stationName: '水吧', active: true, remaining: 3, methods: [] },
  ];
  const names = (f: Parameters<typeof filterDishes>[1]) => filterDishes(rows, f).map((r) => r.name);

  it('不带条件是全部；按出品口、按状态筛；今日沽清只算上架的', () => {
    expect(names({ q: '', outlet: null, status: 'all' })).toEqual(['宫保鸡丁', '柠檬茶', '鲜切果盘', 'Mojito']);
    expect(names({ q: '', outlet: 'water', status: 'all' })).toEqual(['柠檬茶', 'Mojito']);
    expect(names({ q: '', outlet: null, status: 'on' })).toEqual(['宫保鸡丁', '柠檬茶', 'Mojito']);
    expect(names({ q: '', outlet: null, status: 'off' })).toEqual(['鲜切果盘']);
    expect(names({ q: '', outlet: null, status: 'soldout' })).toEqual(['柠檬茶']);
    expect(names({ q: '', outlet: 'fruit', status: 'on' })).toEqual([]);
  });

  it('搜名称、分类、档口、小类、出品口的名字、做法，不分大小写；条件可以叠加', () => {
    expect(names({ q: '鸡', outlet: null, status: 'all' })).toEqual(['宫保鸡丁', 'Mojito']);
    expect(names({ q: 'mojito', outlet: null, status: 'all' })).toEqual(['Mojito']);
    expect(names({ q: '水吧', outlet: null, status: 'all' })).toEqual(['柠檬茶', 'Mojito']);
    expect(names({ q: '调酒', outlet: null, status: 'all' })).toEqual(['Mojito']);
    expect(names({ q: '去冰', outlet: null, status: 'all' })).toEqual(['柠檬茶']);
    expect(names({ q: ' 果吧 ', outlet: null, status: 'all' })).toEqual(['鲜切果盘']);
    expect(names({ q: '水吧', outlet: 'water', status: 'soldout' })).toEqual(['柠檬茶']);
  });

  it('沽清一格的字', () => {
    expect([null, 0, 5].map(remainingText)).toEqual(['不限量', '已沽清', '剩 5 份']);
  });
});

describe('导入表格：一格一格怎么读', () => {
  it('做法、加料：顿号、逗号、分号、斜杠、换行都算分隔；去掉空的与重复的', () => {
    expect(splitSheetList('微辣、中辣，特辣,  去冰;少冰/热的\n常温')).toEqual(['微辣', '中辣', '特辣', '去冰', '少冰', '热的', '常温']);
    expect(splitSheetList('微辣、、微辣、 ')).toEqual(['微辣']);
    expect(splitSheetList('')).toEqual([]);
  });

  it('套餐内容的一项：菜名×份数（×、x、X、* 都认），不写份数是 1；份数不对的不认', () => {
    expect(parseComboPart('柠檬茶×2')).toEqual({ name: '柠檬茶', quantity: 2 });
    expect(parseComboPart('柠檬茶 x 2')).toEqual({ name: '柠檬茶', quantity: 2 });
    expect(parseComboPart('柠檬茶*12')).toEqual({ name: '柠檬茶', quantity: 12 });
    expect(parseComboPart(' 薯条 ')).toEqual({ name: '薯条', quantity: 1 });
    expect(parseComboPart('柠檬茶×0')).toBeNull();
    expect(parseComboPart('柠檬茶×100')).toBeNull();
    expect(parseComboPart('×2')).toBeNull();
    expect(parseComboPart('  ')).toBeNull();
  });

  it('价格写元：整数、一两位小数、带 ¥ 与千分位都认；Excel 带出来的一长串小数按整分算；多于两位小数、0、负数、不是数的不认', () => {
    expect(parseSheetPrice('38')).toBe(3800);
    expect(parseSheetPrice('38.5')).toBe(3850);
    expect(parseSheetPrice('¥1,280.00')).toBe(128000);
    expect(parseSheetPrice('38.900000000000006')).toBe(3890);
    expect(parseSheetPrice('0.1')).toBe(10);
    for (const bad of ['38.555', '0', '-5', '三十八', '', '1e3', '38元']) expect(parseSheetPrice(bad), bad).toBeNull();
  });

  it('状态：上架 / 下架；空着是不改，认不出的单独报', () => {
    expect(parseSheetStatus('上架')).toBe(true);
    expect(parseSheetStatus(' 下架 ')).toBe(false);
    expect(parseSheetStatus('')).toBeUndefined();
    expect(parseSheetStatus('暂停')).toBeNull();
  });

  it('出品口：餐厅 / 水吧 / 果吧（或它们的编码）', () => {
    expect(['餐厅', '水吧', '果吧', 'water'].map(parseSheetOutlet)).toEqual(['restaurant', 'water', 'fruit', 'water']);
    expect(parseSheetOutlet('吧台')).toBeNull();
  });
});
