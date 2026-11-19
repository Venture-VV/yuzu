// 8.1.15《浴族系统需求汇总》块 B 与菜品管理的接头（docs/DINING_V8115.md 第 4 节，ZT26）：不要数据库。
// 点单页的做法 / 加料弹窗里，加料在这个岗位不能下单的出品口的，写明「不能在水吧下单」、不能选。

import { describe, expect, it } from 'vitest';
import { outletBlockedText } from '../src/shared/dining-v8115';

describe('加料在不能下单的出品口（ZT26）', () => {
  it('写明是哪一处；能下单的、不知道在哪一处的（菜单里没有这道菜）为 null', () => {
    expect(outletBlockedText('water', ['restaurant'])).toBe('不能在水吧下单');
    expect(outletBlockedText('restaurant', ['water', 'fruit'])).toBe('不能在餐厅下单');
    expect(outletBlockedText('fruit', ['restaurant', 'water'])).toBe('不能在果吧下单');
    expect(outletBlockedText('fruit', ['water', 'fruit'])).toBeNull();
    expect(outletBlockedText(undefined, [])).toBeNull();
    expect(outletBlockedText(null, ['restaurant'])).toBeNull();
  });
});
