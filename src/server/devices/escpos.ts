// 网口打印的指令（v0.7.21，docs/HARDWARE.md 第 2 节）：ESC/POS（小票机、爱普生标签机）与 TSPL（芯烨标签机）。
//
// 中文按 GB18030 编码：用 Node 自带的 GB18030 解码表反查（不加依赖）；表里没有的字（四字节区的生僻字、表情）打「?」。
// 只做测试页、测试标签需要的指令；业务单据的版式后置（见设计稿「这一版不做」）。

import type { DeviceErrorCode } from '@shared/devices';

let gbTable: Map<string, [number, number]> | null = null;

/** GB18030 双字节区的反查表：一次解码全部双字节编码（每对解出一个 BMP 字符），再按字符建表 */
function gb18030Table(): Map<string, [number, number]> {
  if (gbTable) return gbTable;
  const pairs: [number, number][] = [];
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) if (trail !== 0x7f) pairs.push([lead, trail]);
  }
  const bytes = new Uint8Array(pairs.length * 2);
  pairs.forEach(([a, b], i) => {
    bytes[i * 2] = a;
    bytes[i * 2 + 1] = b;
  });
  const text = new TextDecoder('gb18030').decode(bytes);
  const table = new Map<string, [number, number]>();
  // 双字节编码都落在 BMP：解码结果与编码对一一对应（无效的对解成 U+FFFD）
  if (text.length === pairs.length) {
    for (let i = 0; i < pairs.length; i++) {
      const ch = text[i]!;
      if (ch !== '�' && !table.has(ch)) table.set(ch, pairs[i]!);
    }
  }
  gbTable = table;
  return table;
}

/** 文字按 GB18030 编码：ASCII 原样，汉字与全角标点两个字节，表里没有的打「?」 */
export function encodeGb18030(text: string): number[] {
  const table = gb18030Table();
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const pair = table.get(ch);
    if (pair) out.push(pair[0], pair[1]);
    else out.push(0x3f);
  }
  return out;
}

/** 文字的显示宽度（半角 1、全角 2），按纸宽截断、对齐用 */
export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! < 0x80 ? 1 : 2;
  return w;
}

/** ESC/POS 指令拼装 */
export class EscPos {
  private readonly out: number[] = [];
  /** ESC @ 初始化；FS & 进入汉字模式（中文版爱普生、芯烨按 GB18030 / GBK 打汉字） */
  init() {
    this.out.push(0x1b, 0x40, 0x1c, 0x26);
    return this;
  }
  /** 0 左、1 中、2 右 */
  align(n: 0 | 1 | 2) {
    this.out.push(0x1b, 0x61, n);
    return this;
  }
  /** 倍宽倍高：1–8 倍 */
  size(width: number, height: number) {
    const w = Math.min(8, Math.max(1, width)) - 1;
    const h = Math.min(8, Math.max(1, height)) - 1;
    this.out.push(0x1d, 0x21, (w << 4) | h);
    // 汉字模式下的倍宽倍高（FS !）
    this.out.push(0x1c, 0x21, (w > 0 ? 0x04 : 0) | (h > 0 ? 0x08 : 0));
    return this;
  }
  bold(on: boolean) {
    this.out.push(0x1b, 0x45, on ? 1 : 0);
    return this;
  }
  text(s: string) {
    this.out.push(...encodeGb18030(s));
    return this;
  }
  line(s = '') {
    return this.text(s).newline();
  }
  newline() {
    this.out.push(0x0a);
    return this;
  }
  /** 走纸 n 行 */
  feed(n: number) {
    this.out.push(0x1b, 0x64, Math.min(255, Math.max(0, n)));
    return this;
  }
  /** 走纸后半切（GS V 66 n） */
  cut() {
    this.out.push(0x1d, 0x56, 0x42, 0x03);
    return this;
  }
  /** 一整行的分隔线 */
  rule(columns: number, ch = '-') {
    return this.line(ch.repeat(columns));
  }
  /** 左右两栏（左文字、右文字），按显示宽度补空格 */
  pair(left: string, right: string, columns: number) {
    const gap = Math.max(1, columns - textWidth(left) - textWidth(right));
    return this.line(`${left}${' '.repeat(gap)}${right}`);
  }
  bytes(): Buffer {
    return Buffer.from(this.out);
  }
}

/** 纸宽对应的每行半角字数（Font A 12×24） */
export const columnsOf = (paperWidth: 58 | 80 | undefined) => (paperWidth === 58 ? 32 : 48);

export interface TestPageInfo {
  storeName: string;
  /** 实例标识（不是正式服时醒目标出） */
  instanceLabel: string;
  production: boolean;
  version: string;
  device: { code: string; name: string; area: string; model: string; host: string | null; port: number | null };
  paperWidth?: 58 | 80;
  /** 打印时间（已按门店时区格式化） */
  printedAt: string;
  jobId: number;
}

/** 中文测试页：门店、实例、设备信息、中文样张、倍高倍宽大字、打印时间，最后切纸 */
export function buildTestPage(info: TestPageInfo): Buffer {
  const cols = columnsOf(info.paperWidth);
  const p = new EscPos().init().align(1).size(2, 2).bold(true).line(info.storeName).size(1, 1).bold(false).line('打印测试页');
  if (!info.production) p.bold(true).line(`【${info.instanceLabel} · 不是正式服】`).bold(false);
  p.align(0).rule(cols);
  p.pair('设备编号', info.device.code, cols);
  p.pair('设备名称', info.device.name, cols);
  p.pair('区域', info.device.area, cols);
  p.pair('型号', info.device.model || '—', cols);
  p.pair('地址', info.device.host ? `${info.device.host}:${info.device.port ?? ''}` : '—', cols);
  p.rule(cols);
  p.line('中文样张：浴族 yuzu 门店系统');
  p.line('汤泉、助浴、水吧、餐厅、客房、钟房');
  p.line('全角标点：，。、；：？！（）【】《》');
  p.line('数字字母：0123456789 ABCabc ¥1,234.50');
  p.align(1).size(2, 2).line('大字测试').size(1, 1).align(0);
  p.rule(cols);
  p.pair('打印时间', info.printedAt, cols);
  p.pair('任务号', String(info.jobId), cols);
  p.pair('版本', info.version, cols);
  return p.feed(4).cut().bytes();
}

/** 测试标签：芯烨 TSPL（中文字库 TSS24.BF2）或 ESC/POS（爱普生 TM-L100） */
export function buildTestLabel(info: TestPageInfo & { labelLanguage?: 'tspl' | 'escpos'; labelWidthMm?: number; labelHeightMm?: number }): Buffer {
  if (info.labelLanguage === 'escpos') {
    const p = new EscPos().init().align(1).bold(true).line(info.storeName).bold(false).line('测试标签');
    p.line(`${info.device.code} · ${info.device.area}`).line(info.printedAt);
    return p.feed(2).cut().bytes();
  }
  const w = info.labelWidthMm ?? 40;
  const h = info.labelHeightMm ?? 30;
  const quote = (s: string) => s.replace(/"/g, "'");
  const lines = [
    `SIZE ${w} mm,${h} mm`,
    'GAP 2 mm,0 mm',
    'DIRECTION 1',
    'CLS',
    `TEXT 16,16,"TSS24.BF2",0,1,1,"${quote(info.storeName)} 测试标签"`,
    `TEXT 16,56,"TSS24.BF2",0,1,1,"${quote(info.device.code)} ${quote(info.device.area)}"`,
    `TEXT 16,96,"TSS24.BF2",0,1,1,"${quote(info.printedAt)}"`,
    'PRINT 1,1',
    '',
  ].join('\r\n');
  return Buffer.from(encodeGb18030(lines));
}

// ── 实时状态（DLE EOT n）──

/** 查实时状态的指令：打印机状态、脱机原因、纸卷传感器 */
export const STATUS_QUERY = Buffer.from([0x10, 0x04, 0x01, 0x10, 0x04, 0x02, 0x10, 0x04, 0x04]);
/** TSPL 标签机查状态（ESC ! ?） */
export const TSPL_STATUS_QUERY = Buffer.from([0x1b, 0x21, 0x3f]);

/** 状态字节都有固定位（bit1 = 1、bit4 = 1、bit0 = 0、bit7 = 0） */
const isStatusByte = (b: number) => (b & 0x93) === 0x12;

/**
 * 解析 DLE EOT 1 / 2 / 4 的回复（按顺序各一个字节）。回复不全或不是状态字节时按「在线、详情未知」处理（有的型号网口不回）。
 * 返回 null 表示正常。
 */
export function parseEscPosStatus(reply: Buffer): DeviceErrorCode | null {
  const bytes = [...reply].filter(isStatusByte);
  if (bytes.length < 2) return null;
  const [printer, offline, paper] = bytes as [number, number, number | undefined];
  if (offline & 0x04) return 'DEVICE_COVER_OPEN';
  if ((offline & 0x20) || (paper !== undefined && (paper & 0x60) === 0x60)) return 'DEVICE_PAPER_OUT';
  if (offline & 0x40) return 'DEVICE_FAULT';
  if (printer & 0x08) return 'DEVICE_FAULT';
  return null;
}

/** 解析 TSPL 的 ESC ! ? 回复：0 正常；bit0 开盖、bit1 卡纸、bit2 缺纸、其他位按故障 */
export function parseTsplStatus(reply: Buffer): DeviceErrorCode | null {
  if (reply.length < 1) return null;
  const b = reply[0]!;
  if (b === 0) return null;
  if (b & 0x01) return 'DEVICE_COVER_OPEN';
  if (b & 0x04) return 'DEVICE_PAPER_OUT';
  return 'DEVICE_FAULT';
}

/**
 * 把收到的 ESC/POS（或 TSPL）字节还原成文字（模拟打印机、测试核对用）：去掉控制指令，按 GB18030 解码。
 * 认识的指令：ESC @、ESC a n、ESC E n、ESC d n、GS ! n、GS V m [n]、FS &、FS ! n、DLE EOT n。
 */
export function decodePrintedText(buf: Buffer): string {
  const text: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0x1b) {
      const c = buf[i + 1];
      if (c === 0x40) i += 1;
      else if (c === 0x61 || c === 0x45 || c === 0x64 || c === 0x21) i += 2;
      else i += 1;
      continue;
    }
    if (b === 0x1d) {
      const c = buf[i + 1];
      if (c === 0x21) i += 2;
      else if (c === 0x56) i += buf[i + 2] === 0x41 || buf[i + 2] === 0x42 ? 3 : 2;
      else i += 1;
      continue;
    }
    if (b === 0x1c) {
      const c = buf[i + 1];
      if (c === 0x21) i += 2;
      else i += 1;
      continue;
    }
    if (b === 0x10 && buf[i + 1] === 0x04) {
      i += 2;
      continue;
    }
    if (b === 0x0a || b === 0x0d || b >= 0x20) text.push(b);
  }
  return new TextDecoder('gb18030').decode(Uint8Array.from(text));
}
