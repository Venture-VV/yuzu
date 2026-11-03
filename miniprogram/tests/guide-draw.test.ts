import { describe, expect, it } from 'vitest';
import type { GuideMarker, GuideZone } from '../../src/shared/guide';
import { drawFloor, fitFloor, legendOf, sortFloorCodes, zoneLabelSize } from '../src/utils/guide-draw';

const zone = (over: Partial<GuideZone> = {}): GuideZone => ({
  id: 1,
  floorCode: 'L1',
  name: '女宾浴区',
  nameEn: "Women's Baths",
  kind: 'active',
  color: '#f4ad85',
  polygons: [
    [
      [0, 0],
      [100, 0],
      [100, 50],
      [0, 50],
    ],
  ],
  labelAt: [50, 25],
  area: 5000,
  ...over,
});
const marker = (over: Partial<GuideMarker> = {}): GuideMarker => ({ id: 1, floorCode: 'L1', kind: 'toilet', x: 10, y: 10, label: '卫生间', labelEn: 'Restroom', ...over });

function fakeCanvas() {
  const ops: string[] = [];
  const ctx = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineJoin: '',
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    clearRect: () => ops.push('clear'),
    fillRect: () => ops.push('fillRect'),
    beginPath: () => ops.push('begin'),
    closePath: () => ops.push('close'),
    moveTo: (x: number, y: number) => ops.push(`move ${x.toFixed(1)},${y.toFixed(1)}`),
    lineTo: (x: number, y: number) => ops.push(`line ${x.toFixed(1)},${y.toFixed(1)}`),
    arc: (x: number, y: number) => ops.push(`arc ${x.toFixed(1)},${y.toFixed(1)}`),
    fill: () => ops.push('fill'),
    stroke: () => ops.push('stroke'),
    fillText: (t: string) => ops.push(`text ${t}`),
    strokeText: () => ops.push('strokeText'),
    drawImage: (_i: unknown, x: number, y: number, w: number, h: number) => ops.push(`image ${x},${y},${w},${h}`),
  };
  return { ctx, ops };
}

describe('导览图', () => {
  it('等比缩放放进画布，左右居中；高度随楼层长宽比，最高不超过上限', () => {
    const wide = fitFloor({ width: 200, height: 100 }, 336, 600);
    expect(wide.scale).toBeCloseTo(1.6);
    expect(wide.offsetX).toBeCloseTo(8);
    expect(wide.height).toBe(176);
    const tall = fitFloor({ width: 100, height: 400 }, 336, 480);
    expect(tall.height).toBeLessThanOrEqual(480);
    expect(tall.offsetX).toBeGreaterThan(8);
  });

  it('区域名的字号：随区域大小，限制在 11–15；写不下的区域不写（看图例）', () => {
    expect(zoneLabelSize(zone({ area: 1_000_000 }), 1)).toBe(15);
    // 边长 30 像素：四个字写不下，两个字写得下
    expect(zoneLabelSize(zone({ area: 900 }), 1)).toBe(0);
    expect(zoneLabelSize(zone({ area: 900, name: '前台' }), 1)).toBe(11);
    expect(zoneLabelSize(zone({ area: 10_000 }), 1)).toBe(15);
  });

  it('画：底色、底图半透明、区域色块、区域名、设施', () => {
    const { ctx, ops } = fakeCanvas();
    const fit = fitFloor({ width: 100, height: 50 }, 216, 400);
    drawFloor(ctx, fit, [zone({ area: 1_000_000 })], [marker()], { image: {}, width: 100, height: 50 });
    expect(ops[0]).toBe('clear');
    expect(ops).toContain('image 8,8,200,100');
    expect(ops).toContain('move 8.0,8.0');
    expect(ops).toContain('line 208.0,108.0');
    expect(ops).toContain('text 女宾浴区');
    expect(ops).toContain("text WOMEN'S BATHS");
    expect(ops).toContain('arc 28.0,28.0');
    expect(ops).toContain('text 卫');
    expect(ctx.globalAlpha).toBe(1);
  });

  it('图例：设施按种类与文字去重', () => {
    const l = legendOf([zone()], [marker(), marker({ id: 2, x: 50 }), marker({ id: 3, kind: 'elevator', label: 'VIP 电梯', labelEn: 'VIP Elevator' })]);
    expect(l.zones).toEqual([{ id: 1, name: '女宾浴区', nameEn: "Women's Baths", color: '#f4ad85' }]);
    expect(l.facilities.map((f) => f.glyph + f.label)).toEqual(['卫卫生间', '电VIP 电梯']);
  });

  it('楼层排序：地下在前，数字按大小', () => {
    expect(sortFloorCodes([{ code: 'L10' }, { code: 'L2' }, { code: 'B1' }, { code: 'L1' }]).map((f) => f.code)).toEqual(['B1', 'L1', 'L2', 'L10']);
  });
});
