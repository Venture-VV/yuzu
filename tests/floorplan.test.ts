// 底图转换（飞书需求 RQ-004 第二段，v0.7.15，见 docs/FLOORPLAN.md）：读 DXF、读 DWG（libredwg-web 输出的形状）→ 中性图元 →
// 分楼层、围合房间、每层 SVG、例外清单；转换进程。全是合成图形（门店的编码图只在开发环境解析，不进仓库）。

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import expected from '../src/server/demo/floorplan-expected.json';
import { FLOORPLAN_SAMPLE_EXPECTED, floorplanSampleDxf, floorplanSampleFloorSwapDxf } from '../src/server/demo/floorplan-sample';
import { classifyLayer, codesIn, convertDrawing, polygonArea, simplifyLine, textCenter, type ConvertResult } from '../src/server/floorplan/convert';
import type { PlanDrawing, PlanPath, PlanText, Pt } from '../src/server/floorplan/model';
import { detectFormat } from '../src/server/floorplan/read';
import { fromDwgDatabase, plainMText, readDwg, type DwgDatabaseLike } from '../src/server/floorplan/read-dwg';
import { dxfText, readDxf } from '../src/server/floorplan/read-dxf';
import { startConversion } from '../src/server/floorplan/run';

const enc = (s: string) => new TextEncoder().encode(s);
const sampleV1 = () => convertDrawing(readDxf(enc(floorplanSampleDxf(1))));
const statuses = (r: ConvertResult, status: string) =>
  r.rooms
    .filter((x) => x.status === status)
    .map((x) => x.code)
    .sort();

// ── 合成图元的小工具 ──
const path = (layer: string, pts: Pt[], closed = false): PlanPath => ({ layer, pts, closed });
const text = (layer: string, t: string, x: number, y: number, h = 300): PlanText => ({ layer, text: t, x, y, height: h, rotation: 0, ax: 0.5, ay: 0.5 });
const drawing = (paths: PlanPath[], texts: PlanText[]): PlanDrawing => ({
  paths,
  texts,
  layerCounts: {},
  stats: { entities: paths.length + texts.length, layers: 1, inserts: 0, skipped: {} },
});
/** 一间房（单线墙），下边留一个 900 的门洞 */
function room(x0: number, y0: number, w: number, h: number, layer = 'A-WALL'): PlanPath[] {
  const door = x0 + w / 2;
  return [
    path(layer, [[x0, y0], [door - 450, y0]]),
    path(layer, [[door + 450, y0], [x0 + w, y0]]),
    path(layer, [[x0 + w, y0], [x0 + w, y0 + h]]),
    path(layer, [[x0 + w, y0 + h], [x0, y0 + h]]),
    path(layer, [[x0, y0 + h], [x0, y0]]),
  ];
}

describe('解析规则', () => {
  it('房号：区域字母 + 楼层 + 两位序号，前后不能紧挨字母数字或乘号', () => {
    expect(codesIn('SPA S301 1人间')).toEqual(['S301']);
    expect(codesIn('派对房P205')).toEqual(['P205']);
    expect(codesIn('S301/S302')).toEqual(['S301', 'S302']);
    expect(codesIn('500*600*H900')).toEqual([]);
    expect(codesIn('AS301')).toEqual([]);
    expect(codesIn('S3011')).toEqual([]);
  });

  it('图层白名单：先剔除家具、天花、机电、标注，再认只围合的完成面与门套，最后认墙门窗楼梯', () => {
    expect(classifyLayer('A-新隔墙')).toEqual({ cls: 'base', kind: 'wall' });
    expect(classifyLayer('AD-土建柱轮廓线')).toEqual({ cls: 'base', kind: 'wall' });
    expect(classifyLayer('M-消防门')).toEqual({ cls: 'base', kind: 'door' });
    expect(classifyLayer('AD-玻璃幕墙、窗')).toEqual({ cls: 'base', kind: 'window' });
    expect(classifyLayer('A-Curt')).toEqual({ cls: 'base', kind: 'window' });
    expect(classifyLayer('AD-建筑楼梯')).toEqual({ cls: 'base', kind: 'stair' });
    expect(classifyLayer('A-Hdrl')).toEqual({ cls: 'base', kind: 'stair' });
    expect(classifyLayer('P-完成面').cls).toBe('room');
    expect(classifyLayer('M-消防门套').cls).toBe('room');
    expect(classifyLayer('P-门(未开虚线）').cls).toBe('room');
    expect(classifyLayer('W-区域文字').cls).toBe('label');
    for (const l of ['EQUIP-消防', 'P-窗帘', 'P-固定家具（落地、到顶）', 'RC-天花造型线', 'C-顶面天花门套线', 'A-新隔墙尺寸', 'PUB_HATCH', 'P-墙面灯带线']) {
      expect(classifyLayer(l).cls, l).toBe('exclude');
    }
    expect(classifyLayer('0').cls).toBe('other');
  });

  it('多行文字去掉格式代码；DXF 文字的 \\U+ 转义与 %% 代码', () => {
    expect(plainMText('{\\fSimSun|b0|i0;SPA S301}\\P1人间')).toBe('SPA S301 1人间');
    expect(plainMText('\\H2.5x;派对房P205')).toBe('派对房P205');
    expect(dxfText('\\U+6D74\\U+65CF %%c50 %%d %%p')).toBe('浴族 Ø50 ° ±');
  });

  it('文字中心按对齐点与估算的宽度算；简化去掉共线点；面积按鞋带公式', () => {
    const left: PlanText = { layer: 'L', text: '走道', x: 0, y: 0, height: 100, rotation: 0, ax: 0, ay: 0 };
    expect(textCenter(left)).toEqual([100, 50]);
    expect(textCenter({ ...left, ax: 0.5, ay: 0.5 })).toEqual([0, 0]);
    const c = textCenter({ ...left, rotation: Math.PI / 2 });
    expect(c[0]).toBeCloseTo(-50);
    expect(c[1]).toBeCloseTo(100);
    expect(simplifyLine([[0, 0], [1, 0.01], [2, 0], [3, 5]], 0.5)).toEqual([[0, 0], [2, 0], [3, 5]]);
    expect(polygonArea([[0, 0], [10, 0], [10, 5], [0, 5]])).toBe(50);
  });

  it('认文件格式：DWG 看文件头版本号，DXF 看段落开头，其余拒绝', () => {
    expect(detectFormat(enc('AC1032\0\0\0'))).toBe('dwg');
    expect(detectFormat(enc(floorplanSampleDxf()))).toBe('dxf');
    expect(detectFormat(enc('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n'))).toBe('dxf');
    expect(detectFormat(enc('%PDF-1.7'))).toBeNull();
    expect(detectFormat(enc('楼层,编码\nL3,S301'))).toBeNull();
  });
});

describe('读 DWG（libredwg-web 输出的形状）', () => {
  const db: DwgDatabaseLike = {
    entities: [
      // 外部参照绑定后的图层名带前缀
      { type: 'LWPOLYLINE', layer: '02-二层平面$0$A-WALL', flag: 512, vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 1000, y: 0, bulge: 0 }, { x: 1000, y: 1000, bulge: 0 }, { x: 0, y: 1000, bulge: 0 }] },
      // 凸度 1 = 半圆，逆时针：从 (0,0) 到 (1000,0) 经过 (500,-500)
      { type: 'LWPOLYLINE', layer: 'A-WALL', flag: 0, vertices: [{ x: 0, y: 0, bulge: 1 }, { x: 1000, y: 0, bulge: 0 }] },
      // 块参照：旋转 90°；块里画在 0 层的随块参照的图层；块属性也随
      {
        type: 'INSERT',
        layer: 'A-DOOR',
        name: 'D',
        insertionPoint: { x: 5000, y: 0 },
        xScale: 1,
        yScale: 1,
        rotation: Math.PI / 2,
        attribs: [{ layer: '0', text: { text: 'S301', startPoint: { x: 5000, y: 100 }, endPoint: { x: 0, y: 0 }, textHeight: 200, rotation: 0, halign: 0, valign: 0 } }],
      },
      { type: 'TEXT', layer: 'W-区域文字', text: 'SPA S301', startPoint: { x: 0, y: 0 }, endPoint: { x: 300, y: 400 }, textHeight: 250, rotation: 0, halign: 1, valign: 2 },
      { type: 'MTEXT', layer: 'W-区域文字', text: '{\\fArial;P205}', insertionPoint: { x: 10, y: 20 }, textHeight: 300, rotation: 0, attachmentPoint: 5 },
      // 拉伸方向 -Z（镜像）：x 反向
      { type: 'ARC', layer: 'A-WALL', center: { x: 0, y: 0 }, radius: 1000, startAngle: 0, endAngle: Math.PI / 2, extrusionDirection: { x: 0, y: 0, z: -1 } },
      { type: 'CIRCLE', layer: 'A-COLS', center: { x: 0, y: 0 }, radius: 300 },
      { type: 'HATCH', layer: 'PUB_HATCH' },
      { type: 'LINE', layer: 'A-WALL', startPoint: { x: 0, y: 0 }, endPoint: { x: 1e12, y: 0 } },
      { type: 'LINE', layer: 'A-WALL', startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, isVisible: false },
    ],
    tables: {
      LAYER: { entries: [{ name: '0' }, { name: 'A-WALL' }, { name: 'A-DOOR' }] },
      BLOCK_RECORD: { entries: [{ name: 'D', basePoint: { x: 0, y: 0 }, entities: [{ type: 'LINE', layer: '0', startPoint: { x: 0, y: 0 }, endPoint: { x: 900, y: 0 } }] }] },
    },
  };
  const d = fromDwgDatabase(db);

  it('多段线（闭合标志 512、凸度圆弧）、块参照展开、0 层随块参照、去掉图层前缀', () => {
    expect(d.paths[0]).toMatchObject({ layer: 'A-WALL', closed: true });
    expect(d.paths[0]!.pts).toHaveLength(4);
    const bulge = d.paths[1]!.pts;
    expect(bulge.some(([x, y]) => Math.abs(x - 500) < 1 && Math.abs(y + 500) < 1)).toBe(true);
    const door = d.paths.find((p) => p.layer === 'A-DOOR')!;
    expect(door.pts[0]![0]).toBeCloseTo(5000);
    expect(door.pts[0]![1]).toBeCloseTo(0);
    expect(door.pts[1]![0]).toBeCloseTo(5000);
    expect(door.pts[1]![1]).toBeCloseTo(900);
    expect(d.stats.inserts).toBe(1);
  });

  it('文字：块属性随块参照的图层，对齐的单行文字用第二对齐点，多行文字按附着点', () => {
    expect(d.texts.find((t) => t.text === 'S301')).toMatchObject({ layer: 'A-DOOR', x: 5000, y: 100, ax: 0, ay: 0 });
    expect(d.texts.find((t) => t.text === 'SPA S301')).toMatchObject({ x: 300, y: 400, ax: 0.5, ay: 0.5 });
    expect(d.texts.find((t) => t.text === 'P205')).toMatchObject({ x: 10, y: 20, ax: 0.5, ay: 0.5 });
  });

  it('镜像的圆弧、圆；填充计入未转换；坐标离谱的、不可见的不要', () => {
    const arc = d.paths.find((p) => p.layer === 'A-WALL' && !p.closed && p.pts.length > 2 && p.pts[0]![0] < -900)!;
    expect(arc.pts[0]![0]).toBeCloseTo(-1000);
    expect(arc.pts[arc.pts.length - 1]![1]).toBeCloseTo(1000);
    expect(d.paths.find((p) => p.layer === 'A-COLS')).toMatchObject({ closed: true });
    expect(d.stats.skipped).toEqual({ HATCH: 1 });
    expect(d.paths.some((p) => p.pts.some(([x]) => x > 1e9))).toBe(false);
    expect(d.paths.filter((p) => p.layer === 'A-WALL' && p.pts.length === 2 && p.pts[1]![0] === 10)).toHaveLength(0);
    expect(d.layerCounts['A-WALL']).toBeGreaterThan(0);
  });

  it('真的 DWG 读不了时给出能看懂的原因（加载 LibreDWG 的 WebAssembly）', async () => {
    await expect(readDwg(enc('AC1032 不是真的 DWG'))).rejects.toThrow(/读不了这个文件.*错误码 2048/);
  });
});

describe('读 DXF', () => {
  it('合成样例：墙体轮廓、块参照的门、单行与多行文字、楼层标题', () => {
    const d = readDxf(enc(floorplanSampleDxf()));
    expect(d.stats.inserts).toBe(13);
    expect(d.texts.map((t) => t.text)).toEqual(expect.arrayContaining(['样例 SPA T301 1人间', '样例客房 W302', '三层平面图', '二层平面图', '走道']));
    expect(d.texts.find((t) => t.text === '样例客房 W302')).toMatchObject({ ax: 0.5, ay: 0.5 });
    expect(d.paths.filter((p) => p.layer === 'A-DOOR')).toHaveLength(26);
  });

  it('R2007 之前的文件按 $DWGCODEPAGE 解码（ANSI_936 = GBK）', () => {
    const head = enc('0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$DWGCODEPAGE\n3\nANSI_936\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nTEXT\n8\nW-区域文字\n10\n0\n20\n0\n40\n300\n1\n'.replace('W-区域文字', 'LABEL'));
    const gbk = new Uint8Array([0xd7, 0xdf, 0xb5, 0xc0]); // 「走道」的 GBK 编码
    const tail = enc('\n0\nENDSEC\n0\nEOF\n');
    const bytes = new Uint8Array(head.length + gbk.length + tail.length);
    bytes.set(head);
    bytes.set(gbk, head.length);
    bytes.set(tail, head.length + gbk.length);
    expect(readDxf(bytes).texts[0]!.text).toBe('走道');
  });

  it('多行文字的旋转：组码 50 按度（AutoCAD 实际按度写，DXF 参考手册写的弧度有误，ezdxf 同样按度），有方向向量时以方向向量为准', () => {
    const mtext = (extra: string) =>
      readDxf(enc(`0\nSECTION\n2\nENTITIES\n0\nMTEXT\n8\nW-区域文字\n10\n0\n20\n0\n40\n300\n71\n5\n${extra}1\nG301\n0\nENDSEC\n0\nEOF\n`)).texts[0]!.rotation;
    expect(mtext('50\n90\n')).toBeCloseTo(Math.PI / 2);
    expect(mtext('11\n0\n21\n1\n50\n45\n')).toBeCloseTo(Math.PI / 2);
    expect(mtext('')).toBe(0);
  });

  it('二进制 DXF、损坏的组码给出原因', () => {
    expect(() => readDxf(enc('AutoCAD Binary DXF\r\n\x1a\0'))).toThrow(/二进制 DXF/);
    expect(() => readDxf(enc('0\nSECTION\n2\nENTITIES\nabc\nLINE\n'))).toThrow(/不是组码/);
  });

  it('docs/data 里的样例图纸与生成器一致', () => {
    expect(readFileSync('docs/data/floorplan-sample.dxf', 'utf8')).toBe(floorplanSampleDxf(1));
    expect(readFileSync('docs/data/floorplan-sample-v2.dxf', 'utf8')).toBe(floorplanSampleDxf(2));
    expect(readFileSync('docs/data/floorplan-sample-v2-swap.dxf', 'utf8')).toBe(floorplanSampleFloorSwapDxf());
  });
});

describe('转换：合成样例', () => {
  const r = sampleV1();

  it('分出两层（按墙线的空隙），楼层由房号的楼层位定，标题取图上的', () => {
    expect(r.floors.map((f) => f.code)).toEqual(expected.floors);
    expect(r.floors.map((f) => f.title)).toEqual(['二层平面图', '三层平面图']);
    expect(r.issues).toEqual([]);
  });

  it('房间：配上轮廓、几间连成一片、连到走廊，与固定预期一致', () => {
    expect(statuses(r, 'ok')).toEqual([...expected.v1.ok].sort());
    expect(statuses(r, 'merged')).toEqual(expected.v1.merged);
    expect(statuses(r, 'leak')).toEqual(expected.v1.leak);
    expect(r.rooms).toHaveLength(FLOORPLAN_SAMPLE_EXPECTED.rooms);
    expect(r.rooms.find((x) => x.code === 'W303')!.with).toEqual(['W305']);
  });

  it('轮廓贴着墙：面积与房间的净面积相近（门的开启扇形算走道的），都在图框内', () => {
    const area = (code: string) => r.rooms.find((x) => x.code === code)!.areaM2!;
    // T301 净尺寸 4.85 × 5.85 = 28.4 ㎡，扣掉门的开启扇形约 0.64 ㎡
    expect(area('T301')).toBeGreaterThan(26);
    expect(area('T301')).toBeLessThan(29);
    // X201 净尺寸 9.85 × 4.85 = 47.8 ㎡
    expect(area('X201')).toBeGreaterThan(45);
    expect(area('X201')).toBeLessThan(48.5);
    for (const room of r.rooms) {
      const floor = r.floors.find((f) => f.code === room.floor)!;
      for (const [x, y] of [...(room.polygon ?? []), room.labelAt]) {
        expect(x >= 0 && y >= 0 && x <= floor.width && y <= floor.height, `${room.code} ${x},${y}`).toBe(true);
      }
      expect(room.polygon === null).toBe(room.status !== 'ok');
    }
  });

  it('底图：结构线按类分组、不带房号（房号由轮廓那一层显示）、没有脚本，远小于 1 MB', () => {
    const svg = r.floors.find((f) => f.code === 'L3')!.svg;
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ')).toBe(true);
    for (const cls of ['wall', 'door', 'window', 'stair']) expect(svg).toContain(`class="${cls}"`);
    for (const label of ['走道', '设备间', '布草间']) expect(svg).toContain(`>${label}</text>`);
    expect(svg).not.toContain('T301');
    expect(svg).not.toContain('<script');
    expect(r.floors.every((f) => f.svgBytes < 50_000 && f.svgBytes === Buffer.byteLength(f.svg))).toBe(true);
  });

  it('同样的输入转换两次结果一样（可重跑）', () => {
    const again = sampleV1();
    expect(JSON.stringify({ ...again, convertMs: 0 })).toBe(JSON.stringify({ ...r, convertMs: 0 }));
  });

  it('第二版：T303 改成 T305、W306 的洞改成门、X202 拆掉', () => {
    const v2 = convertDrawing(readDxf(enc(floorplanSampleDxf(2))));
    expect(statuses(v2, 'ok')).toEqual([...expected.v2.ok].sort());
    expect(statuses(v2, 'merged')).toEqual(expected.v2.merged);
    expect(statuses(v2, 'leak')).toEqual([]);
  });
});

describe('转换：例外与提示', () => {
  it('同一层两处写了同一个编码：编码重复；文字压在密密的墙线里：找不到空地', () => {
    const paths = [...room(0, 0, 5000, 5000), ...room(6000, 0, 5000, 5000), ...room(12000, 0, 5000, 5000)];
    // 一块 6 × 6 米、间距 100 的密线（例如画错图层的填充），文字放在中间
    for (let y = 10000; y <= 16000; y += 100) paths.push(path('A-WALL', [[20000, y], [26000, y]]));
    const texts = [text('W-区域文字', 'G301', 2500, 2500), text('W-区域文字', 'G301', 8500, 2500), text('W-区域文字', 'G302', 14500, 2500), text('W-区域文字', 'G303', 23000, 13000)];
    const r = convertDrawing(drawing(paths, texts));
    expect(r.rooms.map((x) => [x.code, x.status])).toEqual([
      ['G301', 'duplicate'],
      ['G302', 'ok'],
      ['G303', 'no_seed'],
    ]);
  });

  it('隔得很远的两块图形分成两层；没有房号与标题的零星小块不报，大块报出来；图框外的编码、楼层位不符的编码列为提示', () => {
    const l3 = [...room(0, 0, 5000, 5000), ...room(6000, 0, 5000, 5000), ...room(12000, 0, 5000, 5000)];
    const l2 = [...room(100000, 0, 5000, 5000), ...room(106000, 0, 5000, 5000)];
    const legend = Array.from({ length: 12 }, (_, i) => path('A-WALL', [[300000, i * 100], [301000, i * 100]]));
    const big = Array.from({ length: 60 }, (_, i) => path('A-WALL', [[500000, i * 300], [520000, i * 300]]));
    const texts = [
      text('W-区域文字', 'G301', 2500, 2500),
      text('W-区域文字', 'G202', 8500, 2500),
      text('W-区域文字', 'G303', 14500, 2500),
      text('W-区域文字', 'P201', 102500, 2500),
      text('W-区域文字', 'P202', 108500, 2500),
      text('W-区域文字', 'G309', 900000, 900000),
      text('W-文字', '三层', 5000, -3000, 1000),
    ];
    const r = convertDrawing(drawing([...l3, ...l2, ...legend, ...big], texts));
    expect(r.floors.map((f) => [f.code, f.title])).toEqual([
      ['L2', ''],
      ['L3', '三层'],
    ]);
    expect(r.issues.map((i) => i.kind).sort()).toEqual(['code_floor_digit', 'code_outside', 'floor_unknown']);
    expect(r.issues.find((i) => i.kind === 'code_floor_digit')).toMatchObject({ floor: 'L3', code: 'G202' });
    expect(r.issues.find((i) => i.kind === 'code_outside')).toMatchObject({ code: 'G309' });
  });

  it('楼层先看图上的标题：个别房号换了楼层（楼层位对不上）不会让整层认错，只列提示；一个标题只给最近的一块', () => {
    const l3 = [...room(0, 0, 5000, 5000), ...room(6000, 0, 5000, 5000), ...room(12000, 0, 5000, 5000)];
    const l2 = [...room(100000, 0, 5000, 5000), ...room(106000, 0, 5000, 5000)];
    const texts = [
      text('W-区域文字', 'G301', 2500, 2500),
      text('W-区域文字', 'G302', 8500, 2500),
      text('W-区域文字', 'P201', 14500, 2500),
      // 二层只剩一个编码，而且是三层的编码
      text('W-区域文字', 'G303', 102500, 2500),
      text('W-文字', '三层', 8500, -3000, 1000),
      text('W-文字', '二层', 105500, -3000, 1000),
    ];
    const r = convertDrawing(drawing([...l3, ...l2], texts));
    expect(r.floors.map((f) => [f.code, f.title])).toEqual([
      ['L2', '二层'],
      ['L3', '三层'],
    ]);
    expect(r.rooms.find((x) => x.code === 'G303')).toMatchObject({ floor: 'L2', status: 'ok' });
    expect(r.issues.filter((i) => i.kind === 'code_floor_digit').map((i) => i.code).sort()).toEqual(['G303', 'P201']);
    expect(r.issues.some((i) => i.kind === 'floor_duplicate')).toBe(false);
  });

  it('区域文字里的 < & > 在底图里转义', () => {
    const paths = [...room(0, 0, 5000, 5000), ...room(6000, 0, 5000, 5000), ...room(0, 6000, 5000, 5000)];
    const r = convertDrawing(drawing(paths, [text('W-区域文字', 'G301', 2500, 2500), text('W-区域文字', '<b>&"走道"', 8500, 2500)]));
    const svg = r.floors[0]!.svg;
    expect(svg).toContain('&lt;b&gt;&amp;&quot;走道&quot;');
    expect(svg).not.toContain('<b>');
  });

  it('读图的非致命错误码列为提示', () => {
    const d = readDxf(enc(floorplanSampleDxf()));
    d.stats.readErrorCode = 64;
    const r = convertDrawing(d);
    expect(r.issues[0]).toMatchObject({ kind: 'read_warning' });
    expect(r.source.readErrorCode).toBe(64);
  });
});

describe('转换进程', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yuzu-floorplan-test-'));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('单独的进程转换合成样例，结果写进文件', async () => {
    await writeFile(join(dir, 'a.dxf'), floorplanSampleDxf());
    const out = await startConversion(join(dir, 'a.dxf'), join(dir, 'a.json'), 60_000).done;
    expect(out.ok, out.error).toBe(true);
    expect(out.format).toBe('dxf');
    expect(out.result!.floors.map((f) => f.code)).toEqual(['L2', 'L3']);
    expect(out.peakRssMb).toBeGreaterThan(0);
  }, 60_000);

  it('读不了的文件、超时：记失败原因', async () => {
    await writeFile(join(dir, 'b.bin'), 'hello');
    const bad = await startConversion(join(dir, 'b.bin'), join(dir, 'b.json'), 60_000).done;
    expect(bad).toMatchObject({ ok: false, error: '只收 DWG 或 ASCII DXF 图纸' });
    const slow = await startConversion(join(dir, 'a.dxf'), join(dir, 'c.json'), 50).done;
    expect(slow).toMatchObject({ ok: false, error: '转换超过 1 秒 没完成，已停止' });
  }, 60_000);
});
