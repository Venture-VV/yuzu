// 底图转换的 PDF 输入（RQ-004 第二段）：认格式、读矢量 PDF（pdf.js 的操作列表与文字内容）→ 中性图元 → 与 DWG / DXF 同样的转换；
// 图纸比例（图上的比例文字 / 上传时填的 / 都没有）、图层（可选内容组 / 默认图层）、页面旋转与表单、扫描件与文字转曲线的拒绝；转换进程。
// 全是合成 PDF（src/server/demo/floorplan-sample.ts），不连数据库。

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import expected from '../src/server/demo/floorplan-expected.json';
import { floorplanSampleDxf, floorplanSamplePdf, writePdf } from '../src/server/demo/floorplan-sample';
import { convertDrawing, textCenter, type ConvertResult } from '../src/server/floorplan/convert';
import type { PlanDrawing, Pt } from '../src/server/floorplan/model';
import { detectFormat, readDrawing } from '../src/server/floorplan/read';
import { readDxf } from '../src/server/floorplan/read-dxf';
import { isPdf, PDF_PATH_LAYER, PDF_TEXT_LAYER, readPdf, scaleFromTexts } from '../src/server/floorplan/read-pdf';
import { startConversion } from '../src/server/floorplan/run';

const enc = (s: string) => new TextEncoder().encode(s);
const statuses = (r: ConvertResult, status: string) =>
  r.rooms
    .filter((x) => x.status === status)
    .map((x) => x.code)
    .sort();
const byLayer = (items: { layer: string }[]) => items.reduce<Record<string, number>>((m, x) => ({ ...m, [x.layer]: (m[x.layer] ?? 0) + 1 }), {});
/** 1:100 的图上 1 点是多少实际毫米 */
const MM_PER_PT_100 = (25.4 / 72) * 100;
/** PDF 样例里楼层的实际坐标 → 读出来的坐标：三层在第一页（原点在纸上 60, 100 毫米）；二层画在 x = 80 米处，
 *  第二页在第一页（宽 42 米）之后再隔 50 米、原点在纸上 50, 70 毫米 */
const shiftOf = (x: number): Pt => (x < 50_000 ? [6000, 10_000] : [97_000 - 80_000, 7000]);
const FURNITURE = 'P-活动家具';

describe('认格式', () => {
  it('PDF 看文件头「%PDF-」（前 1024 字节里）；DWG、DXF 照旧', () => {
    const pdf = floorplanSamplePdf();
    expect(isPdf(pdf)).toBe(true);
    expect(detectFormat(pdf)).toBe('pdf');
    expect(detectFormat(enc('%PDF-1.4\n'))).toBe('pdf');
    expect(detectFormat(enc(`${' '.repeat(100)}%PDF-1.7`))).toBe('pdf');
    expect(detectFormat(enc(`${' '.repeat(1100)}%PDF-1.7`))).toBeNull();
    expect(detectFormat(enc('AC1032\0\0\0'))).toBe('dwg');
    expect(detectFormat(enc(floorplanSampleDxf()))).toBe('dxf');
    expect(isPdf(enc(floorplanSampleDxf()))).toBe(false);
  });
});

describe('图纸比例的文字', () => {
  it('认「1:N」：取出现最多的；一样多时先取写了「比例 / SCALE」的，再取大的；时间、前导零、小数、超出 1–10000 的不算', () => {
    expect(scaleFromTexts(['三层平面图 1:100'])).toBe(100);
    expect(scaleFromTexts(['比例 1：150'])).toBe(150);
    expect(scaleFromTexts(['SCALE 1:200'])).toBe(200);
    expect(scaleFromTexts(['Scale 1 : 50'])).toBe(50);
    expect(scaleFromTexts(['1:10000'])).toBe(10_000);
    expect(scaleFromTexts(['坡道 1:12', '1:12', '平面图 1:100'])).toBe(12);
    expect(scaleFromTexts(['坡道 1:12', '平面图 1:100'])).toBe(100);
    expect(scaleFromTexts(['1:200', '比例 1:100'])).toBe(100);
    expect(scaleFromTexts(['11:30', '21:00', '1:05', '1:2.5', '1:20000', '1:100:2', '图号 A-101', 'T301'])).toBeNull();
    expect(scaleFromTexts([])).toBeNull();
  });
});

describe('读 PDF：合成样例', () => {
  let pdf: PlanDrawing;
  let dxf: PlanDrawing;
  beforeAll(async () => {
    pdf = await readPdf(floorplanSamplePdf());
    dxf = readDxf(enc(floorplanSampleDxf(1)));
  });

  it('线与文字的数量与 DXF 第一版相同（不画家具；文字多两段比例）；没有图层时线都在「PDF-墙」、文字都在「PDF-区域文字」', () => {
    const lines = dxf.paths.filter((p) => p.layer !== FURNITURE);
    expect(pdf.paths).toHaveLength(lines.length);
    expect(pdf.texts).toHaveLength(dxf.texts.length + 2);
    expect(byLayer(pdf.paths)).toEqual({ [PDF_PATH_LAYER]: lines.length });
    expect(byLayer(pdf.texts)).toEqual({ [PDF_TEXT_LAYER]: dxf.texts.length + 2 });
    expect(pdf.layerCounts).toEqual({ [PDF_PATH_LAYER]: lines.length, [PDF_TEXT_LAYER]: dxf.texts.length + 2 });
    expect(pdf.stats).toEqual({
      entities: lines.length + dxf.texts.length + 2,
      layers: 2,
      inserts: 0,
      skipped: {},
      pdf: { pages: 2, scale: 100, scaleFrom: 'text', textScale: 100 },
    });
  });

  it('单位：纸上的点按 1:100 换成实际毫米、y 朝上，与 DXF 的坐标只差每页的平移；门的开启弧线（贝塞尔曲线）折成圆弧上的点', () => {
    const lines = dxf.paths.filter((p) => p.layer !== FURNITURE);
    let arcs = 0;
    lines.forEach((d, i) => {
      const p = pdf.paths[i]!;
      const [dx, dy] = shiftOf(d.pts[0]![0]);
      expect(p.closed, `第 ${i} 条`).toBe(d.closed);
      if (!d.closed && d.pts.length > 2) {
        // DXF 按圆弧折、PDF 按贝塞尔曲线折，点数不同：两头对上，点都在以铰点（门扇的起点）为圆心、900 毫米的圆上
        arcs++;
        const [hx, hy] = pdf.paths[i - 1]!.pts[0]!;
        for (const [j, k] of [
          [0, 0],
          [d.pts.length - 1, p.pts.length - 1],
        ] as const) {
          expect(p.pts[k]![0]).toBeCloseTo(d.pts[j]![0] + dx, 1);
          expect(p.pts[k]![1]).toBeCloseTo(d.pts[j]![1] + dy, 1);
        }
        for (const [x, y] of p.pts) expect(Math.abs(Math.hypot(x - hx, y - hy) - 900)).toBeLessThan(1);
        return;
      }
      expect(p.pts).toHaveLength(d.pts.length);
      d.pts.forEach(([x, y], j) => {
        expect(p.pts[j]![0]).toBeCloseTo(x + dx, 1);
        expect(p.pts[j]![1]).toBeCloseTo(y + dy, 1);
      });
    });
    expect(arcs).toBe(13);
  });

  it('文字：基线起点（ax = ay = 0）、字高按文字矩阵、不旋转；中心点与 DXF 样例的文字中心对得上', () => {
    const labels = pdf.texts.filter((t) => !t.text.includes('1:100'));
    expect(labels).toHaveLength(dxf.texts.length);
    expect(labels.map((t) => t.text)).toEqual(expect.arrayContaining(['SPA T301', 'ROOM W302', 'CORRIDOR', 'L3', 'PARTY X201', 'L2']));
    dxf.texts.forEach((d, i) => {
      const p = labels[i]!;
      expect(p).toMatchObject({ ax: 0, ay: 0, rotation: 0 });
      expect(p.height).toBeCloseTo(d.height, 1);
      const [cx, cy] = textCenter(d);
      const [dx, dy] = shiftOf(cx);
      const [px, py] = textCenter(p);
      expect(px).toBeCloseTo(cx + dx, 0);
      expect(py).toBeCloseTo(cy + dy, 0);
    });
  });
});

describe('转换：PDF 样例', () => {
  it('与 DXF 同样的转换：两层、楼层标题取图上的；房间与固定预期一致（与 DXF 只差 W306，见 floorplan-expected.json 的 pdf.说明）', async () => {
    const r = convertDrawing(await readPdf(floorplanSamplePdf()));
    expect(r.floors.map((f) => f.code)).toEqual(expected.pdf.floors);
    expect(r.floors.map((f) => f.title)).toEqual(expected.pdf.titles);
    expect(statuses(r, 'ok')).toEqual(expected.pdf.ok);
    expect(statuses(r, 'merged')).toEqual(expected.pdf.merged);
    expect(statuses(r, 'leak')).toEqual(expected.pdf.leak);
    expect(r.rooms).toHaveLength(11);
    expect(r.issues).toEqual([]);
    const d = convertDrawing(readDxf(enc(floorplanSampleDxf(1))));
    expect(r.floors.map((f) => [f.width, f.height, f.pathCount])).toEqual(d.floors.map((f) => [f.width, f.height, f.pathCount]));
    for (const room of r.rooms.filter((x) => x.status === 'ok' && x.code !== 'W306')) {
      expect(Math.abs(room.areaM2! - d.rooms.find((x) => x.code === room.code)!.areaM2!), room.code).toBeLessThan(0.5);
    }
    // W306 朝走道开着 3 米的洞，样例没有「走道」文字认不出走廊：轮廓连着整条走道
    expect(r.rooms.find((x) => x.code === 'W306')!.areaM2).toBeGreaterThan(80);
    // 底图：不带编码的区域文字照样画进去
    const svg = r.floors.find((f) => f.code === 'L3')!.svg;
    expect(svg).toContain('>CORRIDOR</text>');
    expect(svg).not.toContain('T301');
  });

  it('同样的输入读、转换两次结果一样（可重跑）', async () => {
    const a = convertDrawing(await readPdf(floorplanSamplePdf()));
    const b = convertDrawing(await readPdf(floorplanSamplePdf()));
    expect(JSON.stringify({ ...b, convertMs: 0 })).toBe(JSON.stringify({ ...a, convertMs: 0 }));
  });

  it('带图层（可选内容组）的 PDF：线与文字按所在组的名字当图层，白名单照用（家具剔除、门窗楼梯分开）；结果与没有图层的一样', async () => {
    const d = await readPdf(floorplanSamplePdf('layers'));
    const dxf = readDxf(enc(floorplanSampleDxf(1)));
    expect(byLayer(d.paths)).toEqual(byLayer(dxf.paths));
    expect(byLayer(d.texts)).toEqual({ 'W-区域文字': 15, 'W-文字': 4 });
    expect(d.texts.find((t) => t.text === 'L3')!.layer).toBe('W-文字');
    expect(d.texts.find((t) => t.text === 'SCALE 1:100')!.layer).toBe('W-文字');
    expect(d.texts.find((t) => t.text === 'SPA T301')!.layer).toBe('W-区域文字');
    expect(d.stats.layers).toBe(7);
    const r = convertDrawing(d);
    expect(r.layers.find((l) => l.name === FURNITURE)).toMatchObject({ cls: 'exclude', count: 3 });
    expect(r.layers.find((l) => l.name === 'A-DOOR')).toMatchObject({ cls: 'base', kind: 'door', count: 26 });
    expect(statuses(r, 'ok')).toEqual(expected.pdf.ok);
    expect(statuses(r, 'merged')).toEqual(expected.pdf.merged);
    expect(statuses(r, 'leak')).toEqual(expected.pdf.leak);
    const svg = r.floors.find((f) => f.code === 'L3')!.svg;
    for (const cls of ['wall', 'door', 'window', 'stair']) expect(svg).toContain(`class="${cls}"`);
  });
});

describe('图纸比例：上传时填的、图上的文字、都没有', () => {
  it('上传时填了就按填的（「按页面大小打印」的 PDF 上写的比例不准，要能改正）、记下图上写的；没填按图上的；都没有拒绝；填的比例不在 1–10000 之内拒绝', async () => {
    const std = await readPdf(floorplanSamplePdf());
    const same = await readPdf(floorplanSamplePdf(), { scale: 100 });
    expect(same.stats.pdf).toEqual({ pages: 2, scale: 100, scaleFrom: 'option', textScale: 100 });
    expect(same.paths).toEqual(std.paths);
    // 填 1:50：尺寸都减半，图上写的 1:100 照样记下（报告里提示两者不同）
    const half = await readPdf(floorplanSamplePdf(), { scale: 50 });
    expect(half.stats.pdf).toEqual({ pages: 2, scale: 50, scaleFrom: 'option', textScale: 100 });
    const p0 = std.paths.find((p) => p.pts[0]![0] < 50_000 && p.pts.length > 1)!;
    const h0 = half.paths[std.paths.indexOf(p0)]!;
    expect(Math.abs(h0.pts[1]![0] - h0.pts[0]![0])).toBeCloseTo(Math.abs(p0.pts[1]![0] - p0.pts[0]![0]) / 2, 1);

    await expect(readPdf(floorplanSamplePdf('no-scale'))).rejects.toThrow('PDF 上没有认出图纸比例（如 1:100），请在上传时填写比例');
    const at100 = await readPdf(floorplanSamplePdf('no-scale'), { scale: 100 });
    expect(at100.stats.pdf).toEqual({ pages: 2, scale: 100, scaleFrom: 'option', textScale: null });
    expect(at100.paths).toEqual(std.paths);
    expect(at100.texts).toEqual(std.texts.filter((t) => !t.text.includes('1:100')));
    // 1:200：第一页的尺寸都翻倍（坐标取到 0.01 毫米）
    const at200 = await readPdf(floorplanSamplePdf('no-scale'), { scale: 200 });
    const firstPage = std.paths.filter((p) => p.pts[0]![0] < 50_000);
    expect(firstPage.length).toBeGreaterThan(50);
    firstPage.forEach((p, i) => {
      const doubled = at200.paths[i]!.pts;
      expect(doubled).toHaveLength(p.pts.length);
      p.pts.forEach(([x, y], j) => expect(Math.max(Math.abs(doubled[j]![0] - 2 * x), Math.abs(doubled[j]![1] - 2 * y))).toBeLessThanOrEqual(0.03));
    });

    for (const scale of [0, 0.5, 20_000, Number.NaN]) await expect(readPdf(floorplanSamplePdf(), { scale })).rejects.toThrow('图纸比例要在 1 到 10000 之间');
  });

  it('readDrawing 把上传时填的比例交给 PDF；DWG / DXF 不受影响', async () => {
    const viaRead = await readDrawing(floorplanSamplePdf('no-scale'), { pdfScale: 100 });
    expect(viaRead.format).toBe('pdf');
    expect(viaRead.drawing.stats.pdf).toEqual({ pages: 2, scale: 100, scaleFrom: 'option', textScale: null });
    const dxf = await readDrawing(enc(floorplanSampleDxf()), { pdfScale: 100 });
    expect(dxf.format).toBe('dxf');
    expect(dxf.drawing).toEqual(readDxf(enc(floorplanSampleDxf())));
  });
});

describe('拒绝', () => {
  it('没有任何文字（导出时文字转成了曲线）：认不出房号', async () => {
    await expect(readPdf(floorplanSamplePdf('no-text'), { scale: 100 })).rejects.toThrow(/^PDF 里没有可读的文字（可能导出时把文字转成了曲线），认不出房号/);
  });

  it('只有图片（扫描件，带看不见的识别文字）：没有矢量线条，写明有几张图片', async () => {
    await expect(readPdf(floorplanSamplePdf('scanned'))).rejects.toThrow(/^PDF 里没有矢量线条（只有 1 张图片），可能是扫描件或图片转成的 PDF/);
  });

  it('只有裁剪路径、零长度的线、页面外的线：都不算矢量线条', async () => {
    const bytes = writePdf([{ width: 200, height: 100, content: '10 10 40 20 re W n 5 5 m 5 5 l S 500 500 m 600 600 l S BT /F1 10 Tf 20 20 Td (G301 1:100) Tj ET' }]);
    await expect(readPdf(bytes)).rejects.toThrow(/^PDF 里没有矢量线条，可能是扫描件/);
  });

  it('坏文件', async () => {
    await expect(readPdf(enc('%PDF-1.7\nhello\n'))).rejects.toThrow(/^读不了这个 PDF：文件损坏或不是 PDF/);
  });
});

describe('读 PDF：页面旋转、表单、可选内容、裁剪、填充与曲线', () => {
  it('按页面显示的方向转好（/Rotate 90 顺时针）；表单乘上自己的矩阵、带可选内容的表单里的线与文字归那一组；裁剪路径、零长度、页面外的不要', async () => {
    const content = [
      '5 5 m 5 5 l S', // 零长度
      '10 10 40 20 re W n', // 只做裁剪
      'q 1 0 0 1 100 0 cm 10 10 m 30 10 l S Q',
      '20 50 m 40 50 l 40 70 l f', // 填充：自动闭合
      '50 50 m 50 80 80 80 80 50 c S',
      '500 500 m 600 600 l S', // 页面外
      '/OC /L0 BDC /Fm0 Do EMC',
      '/Fm1 Do',
      'BT /F1 10 Tf 1 0 0 1 150 20 Tm (G301) Tj ET',
    ].join('\n');
    const bytes = writePdf(
      [
        {
          width: 200,
          height: 100,
          rotate: 90,
          content,
          xobjects: {
            Fm0: { dict: '/Type /XObject /Subtype /Form /BBox [0 0 50 50] /Matrix [2 0 0 2 0 0]', stream: '0 0 m 10 0 l S' },
            Fm1: { dict: '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /OC {L1}', stream: 'BT /F1 8 Tf 1 0 0 1 60 30 Tm (G302 ROOM) Tj ET 0 90 m 10 90 l S' },
          },
        },
      ],
      { layers: ['A-WALL', 'W-区域文字'] },
    );
    const d = await readPdf(bytes, { scale: 100 });
    // 顺时针转 90° 显示（宽 100、高 200）：用户空间的 (x, y) 在显示的页面上是 (y, 200 − x)
    const at = (x: number, y: number): Pt => [y * MM_PER_PT_100, (200 - x) * MM_PER_PT_100];
    const near = (pts: Pt[], want: Pt[]) => {
      expect(pts).toHaveLength(want.length);
      pts.forEach(([x, y], i) => {
        expect(x).toBeCloseTo(want[i]![0], 1);
        expect(y).toBeCloseTo(want[i]![1], 1);
      });
    };
    expect(d.paths.map((p) => [p.layer, p.closed])).toEqual([
      [PDF_PATH_LAYER, false],
      [PDF_PATH_LAYER, true],
      [PDF_PATH_LAYER, false],
      ['A-WALL', false],
      ['W-区域文字', false],
    ]);
    near(d.paths[0]!.pts, [at(110, 10), at(130, 10)]);
    near(d.paths[1]!.pts, [at(20, 50), at(40, 50), at(40, 70)]);
    const curve = d.paths[2]!.pts;
    expect(curve.length).toBeGreaterThan(8);
    near([curve[0]!, curve[curve.length - 1]!], [at(50, 50), at(80, 50)]);
    // 曲线中点：(50, 50) (50, 80) (80, 80) (80, 50) 在 t = 0.5 处是 (65, 72.5)
    expect(curve.some(([x, y]) => Math.hypot(x - at(65, 72.5)[0], y - at(65, 72.5)[1]) < 20)).toBe(true);
    near(d.paths[3]!.pts, [at(0, 0), at(20, 0)]);
    near(d.paths[4]!.pts, [at(0, 90), at(10, 90)]);

    expect(d.texts.map((t) => [t.layer, t.text])).toEqual([
      ['W-区域文字', 'G302 ROOM'],
      [PDF_TEXT_LAYER, 'G301'],
    ]);
    for (const [t, [x, y], size] of [
      [d.texts[0]!, at(60, 30), 8],
      [d.texts[1]!, at(150, 20), 10],
    ] as const) {
      expect(t.x).toBeCloseTo(x, 1);
      expect(t.y).toBeCloseTo(y, 1);
      expect(t.height).toBeCloseTo(size * MM_PER_PT_100, 1);
      // 文字朝右写，页面顺时针转 90° 后朝下
      expect(t.rotation).toBeCloseTo(-Math.PI / 2, 6);
    }
    expect(d.stats).toMatchObject({ layers: 4, inserts: 0, skipped: {}, pdf: { pages: 1, scale: 100, scaleFrom: 'option' } });
    expect(d.layerCounts).toEqual({ [PDF_PATH_LAYER]: 3, 'A-WALL': 1, 'W-区域文字': 2, [PDF_TEXT_LAYER]: 1 });
  });
});

describe('转换进程', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yuzu-floorplan-pdf-test-'));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('单独的进程转换 PDF 样例：没传比例用图上的；没有比例文字的用传进去的比例，没传记失败原因', async () => {
    await writeFile(join(dir, 'a.pdf'), floorplanSamplePdf());
    await writeFile(join(dir, 'b.pdf'), floorplanSamplePdf('no-scale'));
    const [out, scaled, missing] = await Promise.all([
      startConversion(join(dir, 'a.pdf'), join(dir, 'a.json'), 90_000).done,
      startConversion(join(dir, 'b.pdf'), join(dir, 'b.json'), 90_000, { pdfScale: 100 }).done,
      startConversion(join(dir, 'b.pdf'), join(dir, 'c.json'), 90_000).done,
    ]);
    expect(out.ok, out.error).toBe(true);
    expect(out.format).toBe('pdf');
    expect(out.pdf).toEqual({ pages: 2, scale: 100, scaleFrom: 'text', textScale: 100 });
    expect(out.result!.floors.map((f) => f.code)).toEqual(expected.pdf.floors);
    expect(statuses(out.result!, 'ok')).toEqual(expected.pdf.ok);
    expect(out.peakRssMb).toBeGreaterThan(0);
    expect(scaled.ok, scaled.error).toBe(true);
    expect(scaled.pdf).toEqual({ pages: 2, scale: 100, scaleFrom: 'option', textScale: null });
    expect(statuses(scaled.result!, 'ok')).toEqual(expected.pdf.ok);
    expect(missing).toMatchObject({ ok: false, error: 'PDF 上没有认出图纸比例（如 1:100），请在上传时填写比例' });
  }, 120_000);
});
