// 底图转换的合成样例图纸（RQ-004 第二段，v0.7.15）：两层（L3、L2）、ASCII DXF、毫米。全是编的，不是门店图纸。
// 编码与 docs/data/space-ledger-sample.csv 对应，故意留了几处例外与差异，演示、测试与验收用：
//   · L3：T301、T302、T303、V312、W301、W302 配上轮廓；W303 与 W305 之间没有隔墙（连成一片）；W306 朝走道开了 3 米宽的洞（连到走廊）；
//   · L2：X201、X202；
//   · 与样例台账比对：图上多 T303、W303、W305、W306、X202，台账多 U310；T302 的原文与台账的原始标注不同（1人间 / 2人间）。
// 第二版（variant 2，演示「与在用的那一批比对」）：T303 改成 T305（同一位置换编码），W306 的洞改成门，X202 拆掉。
// 门画成块参照（门扇 + 开启弧线，画在 0 层随块参照的图层），W302 的名称用多行文字，家具画在剔除的图层上。

const DEG = 180 / Math.PI;

class DxfWriter {
  private out: string[] = [];
  private pair(code: number, value: string | number) {
    this.out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  }
  line(layer: string, x1: number, y1: number, x2: number, y2: number) {
    this.pair(0, 'LINE');
    this.pair(8, layer);
    this.pair(10, x1);
    this.pair(20, y1);
    this.pair(11, x2);
    this.pair(21, y2);
  }
  poly(layer: string, pts: [number, number][], closed: boolean) {
    this.pair(0, 'LWPOLYLINE');
    this.pair(8, layer);
    this.pair(90, pts.length);
    this.pair(70, closed ? 1 : 0);
    for (const [x, y] of pts) {
      this.pair(10, x);
      this.pair(20, y);
    }
  }
  rect(layer: string, x0: number, y0: number, x1: number, y1: number) {
    this.poly(layer, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);
  }
  arc(layer: string, cx: number, cy: number, r: number, a0: number, a1: number) {
    this.pair(0, 'ARC');
    this.pair(8, layer);
    this.pair(10, cx);
    this.pair(20, cy);
    this.pair(40, r);
    this.pair(50, a0);
    this.pair(51, a1);
  }
  /** 居中对齐的单行文字（第二对齐点在 (x, y)） */
  text(layer: string, x: number, y: number, h: number, s: string) {
    this.pair(0, 'TEXT');
    this.pair(8, layer);
    this.pair(10, x);
    this.pair(20, y);
    this.pair(40, h);
    this.pair(1, s);
    this.pair(72, 1);
    this.pair(11, x);
    this.pair(21, y);
    this.pair(73, 2);
  }
  /** 中心对齐的多行文字 */
  mtext(layer: string, x: number, y: number, h: number, s: string) {
    this.pair(0, 'MTEXT');
    this.pair(8, layer);
    this.pair(10, x);
    this.pair(20, y);
    this.pair(40, h);
    this.pair(71, 5);
    this.pair(1, s);
  }
  insert(layer: string, name: string, x: number, y: number, rotationRad: number) {
    this.pair(0, 'INSERT');
    this.pair(8, layer);
    this.pair(2, name);
    this.pair(10, x);
    this.pair(20, y);
    this.pair(50, rotationRad * DEG);
  }
  raw(code: number, value: string | number) {
    this.pair(code, value);
  }
  toString() {
    return this.out.join('\n') + '\n';
  }
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));

const WALL = 'A-WALL';
const DOOR = 'A-DOOR';
const LABEL = 'W-区域文字';

/** 横墙（画成墙体轮廓），openings 是门洞的 [x0, x1] */
function wallH(w: DxfWriter, x0: number, x1: number, y: number, t: number, openings: [number, number][] = []) {
  let from = x0;
  for (const [a, b] of [...openings].sort((p, q) => p[0] - q[0])) {
    if (a > from) w.rect(WALL, from, y - t / 2, a, y + t / 2);
    from = b;
  }
  if (x1 > from) w.rect(WALL, from, y - t / 2, x1, y + t / 2);
}
function wallV(w: DxfWriter, x: number, y0: number, y1: number, t: number, openings: [number, number][] = []) {
  let from = y0;
  for (const [a, b] of [...openings].sort((p, q) => p[0] - q[0])) {
    if (a > from) w.rect(WALL, x - t / 2, from, x + t / 2, a);
    from = b;
  }
  if (y1 > from) w.rect(WALL, x - t / 2, from, x + t / 2, y1);
}

/** 横墙上的门（900 宽）：into = 1 往北开、-1 往南开 */
function doorH(w: DxfWriter, x: number, y: number, into: 1 | -1) {
  if (into === 1) w.insert(DOOR, 'DOOR900', x, y, 0);
  else w.insert(DOOR, 'DOOR900', x + 900, y, Math.PI);
}

function floor3(w: DxfWriter, variant: 1 | 2) {
  // 外墙 30 × 14 米，南面一排房间，中间走道（y 6–8 米），北面一排
  wallH(w, 0, 30000, 0, 200);
  wallH(w, 0, 30000, 14000, 200);
  wallV(w, 0, 0, 14000, 200);
  wallV(w, 30000, 0, 14000, 200);
  w.rect('A-WIND', 1000, -60, 4000, 60);
  w.rect('A-WIND', 6000, -60, 9000, 60);
  // 走道南墙：每间一个门
  const south: [number, number][] = [3500, 8500, 13500, 20500, 24500, 28500].map((x) => [x, x + 900]);
  wallH(w, 0, 30000, 6000, 100, south);
  for (const [x] of south) doorH(w, x, 6000, -1);
  for (const x of [5000, 10000, 15000, 22000, 26000]) wallV(w, x, 0, 6000, 100);
  // 走道北墙：W303/W305 两个门；W306 第一版是 3 米宽的洞，第二版是门；设备间、楼梯间、布草间
  const north: [number, number][] = [
    [2000, 2900],
    [7000, 7900],
    variant === 1 ? [11000, 14000] : [12000, 12900],
    [17000, 17900],
    [21500, 22400],
    [26000, 26900],
  ];
  wallH(w, 0, 30000, 8000, 100, north);
  for (const [x0, x1] of north) if (x1 - x0 === 900) doorH(w, x0, 8000, 1);
  // W303 与 W305 之间（x = 5 米）没有隔墙
  for (const x of [10000, 15000, 20000, 24000]) wallV(w, x, 8000, 14000, 100);
  // 楼梯
  w.rect('A-STAIR', 20600, 10000, 23400, 13400);
  for (let y = 10300; y < 13400; y += 300) w.line('A-STAIR', 20600, y, 23400, y);
  // 家具（剔除的图层，不参与围合）：客房里的床
  w.rect('P-活动家具', 22500, 1000, 24500, 3000);
  w.rect('P-活动家具', 26500, 1000, 28500, 3000);
  w.line('P-活动家具', 1000, 3000, 4000, 3000);
  // 房号与房间名
  w.text(LABEL, 2500, 3000, 300, '样例 SPA T301 1人间');
  w.text(LABEL, 7500, 3000, 300, '样例 SPA T302 1人间');
  w.text(LABEL, 12500, 3000, 300, variant === 1 ? '样例 SPA T303 2人间' : '样例 SPA T305 2人间');
  w.text(LABEL, 18500, 3000, 300, '样例 V312 4人间');
  w.text(LABEL, 24000, 4500, 300, '样例客房 W301');
  w.mtext(LABEL, 28000, 4500, 300, '样例客房 W302');
  w.text(LABEL, 2500, 11000, 300, '样例客房 W303');
  w.text(LABEL, 7500, 11000, 300, '样例客房 W305');
  w.text(LABEL, 12500, 11000, 300, '样例踩背 W306');
  w.text(LABEL, 17500, 11000, 300, '设备间');
  w.text(LABEL, 27000, 11000, 300, '布草间');
  w.text(LABEL, 15000, 7000, 300, '走道');
  w.text('W-文字', 15000, -3000, 800, '三层平面图');
}

function floor2(w: DxfWriter, variant: 1 | 2) {
  const ox = 80000;
  wallH(w, ox, ox + 20000, 0, 200);
  wallH(w, ox, ox + 20000, 12000, 200);
  wallV(w, ox, 0, 12000, 200);
  wallV(w, ox + 20000, 0, 12000, 200);
  const south: [number, number][] = [
    [ox + 4000, ox + 4900],
    [ox + 14000, ox + 14900],
  ];
  wallH(w, ox, ox + 20000, 5000, 100, south);
  for (const [x] of south) doorH(w, x, 5000, -1);
  // 第二版拆掉 X201 与 X202 之间的墙、去掉 X202 的编码
  if (variant === 1) wallV(w, ox + 10000, 0, 5000, 100);
  wallH(w, ox, ox + 20000, 7000, 100, [[ox + 9000, ox + 11000]]);
  w.text(LABEL, ox + 5000, 2500, 350, '样例派对房X201');
  if (variant === 1) w.text(LABEL, ox + 15000, 2500, 350, '样例派对房X202');
  w.text(LABEL, ox + 10000, 9500, 350, '大厅');
  w.text('W-文字', ox + 10000, -3000, 800, '二层平面图');
}

/** 合成样例图纸（ASCII DXF 文本） */
export function floorplanSampleDxf(variant: 1 | 2 = 1): string {
  const w = new DxfWriter();
  w.raw(999, '浴族 yuzu 底图转换合成样例（不是门店图纸）');
  w.raw(0, 'SECTION');
  w.raw(2, 'HEADER');
  w.raw(9, '$ACADVER');
  w.raw(1, 'AC1021');
  w.raw(9, '$INSUNITS');
  w.raw(70, 4);
  w.raw(0, 'ENDSEC');
  w.raw(0, 'SECTION');
  w.raw(2, 'TABLES');
  w.raw(0, 'TABLE');
  w.raw(2, 'LAYER');
  for (const name of ['0', WALL, DOOR, 'A-WIND', 'A-STAIR', LABEL, 'W-文字', 'P-活动家具']) {
    w.raw(0, 'LAYER');
    w.raw(2, name);
    w.raw(70, 0);
  }
  w.raw(0, 'ENDTAB');
  w.raw(0, 'ENDSEC');
  // 门：铰点在原点，门扇朝 +y，弧线从 0° 到 90°；画在 0 层，随块参照的图层
  w.raw(0, 'SECTION');
  w.raw(2, 'BLOCKS');
  w.raw(0, 'BLOCK');
  w.raw(8, '0');
  w.raw(2, 'DOOR900');
  w.raw(70, 0);
  w.raw(10, 0);
  w.raw(20, 0);
  w.line('0', 0, 0, 0, 900);
  w.arc('0', 0, 0, 900, 0, 90);
  w.raw(0, 'ENDBLK');
  w.raw(0, 'ENDSEC');
  w.raw(0, 'SECTION');
  w.raw(2, 'ENTITIES');
  floor3(w, variant);
  floor2(w, variant);
  w.raw(0, 'ENDSEC');
  w.raw(0, 'EOF');
  return w.toString();
}

/** 样例的固定预期（与 floorplan-expected.json 一致；测试与验收按这个核对） */
export const FLOORPLAN_SAMPLE_EXPECTED = {
  floors: ['L2', 'L3'],
  rooms: 11,
  ok: ['T301', 'T302', 'T303', 'V312', 'W301', 'W302', 'X201', 'X202'],
  merged: ['W303', 'W305'],
  leak: ['W306'],
};

/**
 * 第二版上把三层的 T305 与二层的 X201 对调：同一个编码换了楼层（v0.7.15 验收的 F22 场景），
 * 与第二版比对只列在「换了楼层」里，不算增减、不算挪动。图纸在 docs/data/floorplan-sample-v2-swap.dxf。
 */
export function floorplanSampleFloorSwapDxf(): string {
  return floorplanSampleDxf(2).replace('样例 SPA T305 2人间', '样例 SPA X201 2人间').replace('样例派对房X201', '样例派对房T305');
}
