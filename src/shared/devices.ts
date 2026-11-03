// 硬件连接（飞书需求 RQ-001，v0.7.21，docs/HARDWARE.md）：协议 v0.1 的类型定义，服务端、页面、终端上的设备服务（桥）共用一份。
//
// 设备分六种：打印机、标签机、读卡器、扫码（四类能力设备），以及承载它们的终端、打印服务器。
// 接法分五种：网口直连、经打印服务器（与网口同一条路）、终端设备服务（桥）、模拟键盘、无（终端与打印服务器本身）。

/** 协议版本：桥的报文、设备事件都带它；对不上的报文不认（BRIDGE_PROTOCOL） */
export const DEVICE_PROTOCOL_VERSION = 1;

export const DEVICE_KINDS = ['printer', 'label_printer', 'card_reader', 'scanner', 'terminal', 'print_server'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_KIND_LABELS: Record<DeviceKind, string> = {
  printer: '小票打印机',
  label_printer: '标签打印机',
  card_reader: '读卡器',
  scanner: '扫码',
  terminal: '终端',
  print_server: '打印服务器',
};
/** 设备编号的前缀（类型前缀 + 区域 + 序号，如 PRN-SY-01） */
export const DEVICE_KIND_PREFIX: Record<DeviceKind, string> = {
  printer: 'PRN',
  label_printer: 'LBL',
  card_reader: 'RDR',
  scanner: 'SCN',
  terminal: 'TRM',
  print_server: 'PSV',
};

export const DEVICE_CONNECTIONS = ['network', 'print_server', 'bridge', 'keyboard', 'none'] as const;
export type DeviceConnection = (typeof DEVICE_CONNECTIONS)[number];
export const DEVICE_CONNECTION_LABELS: Record<DeviceConnection, string> = {
  network: '网口直连',
  print_server: '经打印服务器',
  bridge: '终端设备服务',
  keyboard: '模拟键盘',
  none: '本机',
};
/** 每种设备能选的接法（第一个是默认） */
export const DEVICE_KIND_CONNECTIONS: Record<DeviceKind, readonly DeviceConnection[]> = {
  printer: ['network', 'print_server'],
  label_printer: ['network', 'print_server'],
  card_reader: ['bridge', 'keyboard'],
  scanner: ['bridge', 'keyboard'],
  terminal: ['none'],
  print_server: ['network'],
};
/** 服务端按 IP 与端口直连的接法（心跳查状态、打印任务直接发） */
export const NETWORK_CONNECTIONS: readonly DeviceConnection[] = ['network', 'print_server'];
export const DEFAULT_PRINTER_PORT = 9100;

export const DEVICE_STATUSES = ['unknown', 'online', 'offline', 'error'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];
export const DEVICE_STATUS_LABELS: Record<DeviceStatus, string> = { unknown: '未知', online: '在线', offline: '离线', error: '故障' };

/** 错误码：指令失败与状态原因都用这一套 */
export const DEVICE_ERROR_CODES = [
  'DEVICE_OFFLINE',
  'DEVICE_TIMEOUT',
  'DEVICE_REFUSED',
  'DEVICE_UNREACHABLE',
  'DEVICE_INTERRUPTED',
  'DEVICE_PAPER_OUT',
  'DEVICE_COVER_OPEN',
  'DEVICE_FAULT',
  'DEVICE_BUSY',
  'DEVICE_DISABLED',
  'DEVICE_UNSUPPORTED',
  'DEVICE_NOT_CONFIGURED',
  'BRIDGE_OFFLINE',
  'BRIDGE_PROTOCOL',
  'READ_FAILED',
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];
export const DEVICE_ERROR_LABELS: Record<DeviceErrorCode, string> = {
  DEVICE_OFFLINE: '设备离线',
  DEVICE_TIMEOUT: '连接或回复超时',
  DEVICE_REFUSED: '连接被拒（端口没开或设备拒绝）',
  DEVICE_UNREACHABLE: '网络不通（地址不对或没有路由）',
  DEVICE_INTERRUPTED: '发送到一半断开（可能已打出一部分，没有自动重发）',
  DEVICE_PAPER_OUT: '缺纸',
  DEVICE_COVER_OPEN: '开盖',
  DEVICE_FAULT: '打印机报错（切刀、过热等）',
  DEVICE_BUSY: '正在打别的，排队超时',
  DEVICE_DISABLED: '设备已停用',
  DEVICE_UNSUPPORTED: '这种设备不接这条指令',
  DEVICE_NOT_CONFIGURED: '还没配好（没填 IP 与端口，或没指定挂在哪台终端）',
  BRIDGE_OFFLINE: '终端的设备服务没连上',
  BRIDGE_PROTOCOL: '设备服务的报文不对（版本不符或字段缺失）',
  READ_FAILED: '读卡或扫码失败',
};
export const isDeviceErrorCode = (v: unknown): v is DeviceErrorCode => typeof v === 'string' && (DEVICE_ERROR_CODES as readonly string[]).includes(v);

/** 区域（采购清单的十个区域）：编码用于设备编号 */
export const DEVICE_AREAS = [
  { code: 'JD', name: '接待' },
  { code: 'SY', name: '收银' },
  { code: 'ZY', name: '助浴' },
  { code: 'SB', name: '水吧' },
  { code: 'YL', name: '娱乐' },
  { code: 'CT', name: '餐厅' },
  { code: 'XX', name: '休息' },
  { code: 'AM', name: '按摩' },
  { code: 'HC', name: '后厨' },
  { code: 'HZ', name: '候钟房' },
] as const;
export type DeviceAreaName = (typeof DEVICE_AREAS)[number]['name'];

// ── 心跳与超时（v0.1 的默认值，见 PENDING_DECISIONS「硬件连接」）──
/** 服务端查网口设备、检查终端上报的间隔 */
export const HEARTBEAT_INTERVAL_MS = 2_000;
/** 最近一次联系上超过这么久记离线（加上页面 2 秒刷新，拔线 10 秒内在页面上变灰） */
export const OFFLINE_AFTER_MS = 5_000;
/** 单次心跳的连接与回复限时 */
export const PROBE_TIMEOUT_MS = 1_500;
/** 打印任务每次连接与发送的限时、没开始发就连不上时的重试次数 */
export const JOB_ATTEMPT_TIMEOUT_MS = 5_000;
export const JOB_RETRIES = 2;
/** 开着页面的终端替桥上报的间隔 */
export const BRIDGE_REPORT_INTERVAL_MS = 2_000;
/** 终端设备服务（桥）默认的本机端口 */
export const DEFAULT_BRIDGE_PORT = 17890;

// ── 设备登记 ──

export interface DeviceOptions {
  /** 小票打印机：纸宽（毫米） */
  paperWidth?: 58 | 80;
  /** 标签机：指令语言（芯烨 TSPL，爱普生 TM-L100 是 ESC/POS） */
  labelLanguage?: 'tspl' | 'escpos';
  /** 标签机：标签尺寸（毫米） */
  labelWidthMm?: number;
  labelHeightMm?: number;
}

export interface Device {
  id: number;
  code: string;
  name: string;
  kind: DeviceKind;
  brand: string;
  model: string;
  area: string;
  connection: DeviceConnection;
  host: string | null;
  port: number | null;
  /** 挂在哪台终端（读卡、扫码）或打印服务器（USB 打印机）下 */
  hostDeviceId: number | null;
  hostDeviceCode: string | null;
  /** 桥里这台设备的键（同一台终端下唯一），如 rc300、scanner */
  bridgeKey: string | null;
  options: DeviceOptions;
  enabled: boolean;
  status: DeviceStatus;
  statusCode: DeviceErrorCode | null;
  lastSeenAt: string | null;
  statusChangedAt: string | null;
  /** 采购清单的哪一行（按清单导入的） */
  catalogKey: string | null;
  note: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 一屏看全部设备：每种型号的采购数、已登记、在线 */
export interface DeviceCatalogCount {
  key: string;
  category: string;
  brand: string;
  model: string;
  kind: DeviceKind;
  purchased: number;
  registered: number;
  online: number;
}

export interface DeviceOverview {
  devices: Device[];
  counts: Record<DeviceStatus, number> & { total: number; disabled: number };
  catalog: DeviceCatalogCount[];
  checkedAt: string;
}

export const DEVICE_JOB_KINDS = ['test_page', 'label_test'] as const;
export type DeviceJobKind = (typeof DEVICE_JOB_KINDS)[number];
export const DEVICE_JOB_KIND_LABELS: Record<DeviceJobKind, string> = { test_page: '测试页', label_test: '测试标签' };
export const DEVICE_JOB_STATUSES = ['queued', 'sending', 'done', 'failed'] as const;
export type DeviceJobStatus = (typeof DEVICE_JOB_STATUSES)[number];
export const DEVICE_JOB_STATUS_LABELS: Record<DeviceJobStatus, string> = { queued: '排队', sending: '发送中', done: '完成', failed: '失败' };

export interface DeviceJob {
  id: number;
  deviceId: number;
  deviceCode: string;
  deviceName: string;
  kind: DeviceJobKind;
  status: DeviceJobStatus;
  attempts: number;
  errorCode: DeviceErrorCode | null;
  errorMessage: string | null;
  createdByName: string;
  createdAt: string;
  finishedAt: string | null;
}

export const DEVICE_EVENT_TYPES = ['status', 'card', 'scan', 'error'] as const;
export type DeviceEventType = (typeof DEVICE_EVENT_TYPES)[number];
export interface DeviceEvent {
  id: number;
  deviceId: number | null;
  deviceCode: string | null;
  type: DeviceEventType;
  data: Record<string, unknown>;
  staffName: string | null;
  createdAt: string;
}

/** 开着页面的终端替桥上报（POST /api/devices/bridge-report） */
export interface BridgeReport {
  /** 这台终端的设备编号 */
  terminal: string;
  /** 页面连上了本机的桥没有；没连上时挂在这台终端下的设备都记离线（BRIDGE_OFFLINE） */
  bridge: { connected: boolean; version?: string };
  devices: { key: string; status: DeviceStatus; code?: DeviceErrorCode | null }[];
  /** 读卡、扫码事件（编号去重：重发不会记两次） */
  events: { id: string; key: string; type: 'card' | 'scan' | 'error'; value: string; at: string }[];
}
export interface BridgeReportResult {
  terminal: { code: string; name: string };
  /** 桥报上来、在登记里对上的设备 */
  matched: { key: string; code: string; name: string }[];
  /** 桥报上来、登记里没有的设备键（在后台把设备挂到这台终端、填上设备键） */
  unknownKeys: string[];
  /** 这次新记下的事件数（重发的不算） */
  recorded: number;
}

// ── 桥的报文（v1） ──

export type BridgeDeviceKind = 'card_reader' | 'scanner';
export type BridgeMessage =
  | { v: 1; type: 'hello'; bridge: { terminal: string; version: string }; devices: { key: string; kind: BridgeDeviceKind; status: DeviceStatus; code?: DeviceErrorCode }[] }
  | { v: 1; type: 'status'; key: string; status: DeviceStatus; code?: DeviceErrorCode }
  | { v: 1; type: 'card'; key: string; cardNo: string; at: string }
  | { v: 1; type: 'scan'; key: string; code: string; at: string }
  | { v: 1; type: 'error'; key?: string; code: DeviceErrorCode; message: string }
  | { v: 1; type: 'pong' };

export type BridgeParse = { ok: true; message: BridgeMessage } | { ok: false; code: 'BRIDGE_PROTOCOL'; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isStatus = (v: unknown): v is DeviceStatus => typeof v === 'string' && (DEVICE_STATUSES as readonly string[]).includes(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
/** 卡号、条码：可见字符，1–64 个 */
const CODE_RE = /^[\x21-\x7e]{1,64}$/;

/** 解析桥发来的一条报文；版本不符、字段缺失、类型不认识都返回 BRIDGE_PROTOCOL 与原因 */
export function parseBridgeMessage(raw: string): BridgeParse {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'BRIDGE_PROTOCOL', reason: '不是 JSON' };
  }
  if (!isObj(data)) return { ok: false, code: 'BRIDGE_PROTOCOL', reason: '不是对象' };
  if (data.v !== DEVICE_PROTOCOL_VERSION) return { ok: false, code: 'BRIDGE_PROTOCOL', reason: `协议版本 ${String(data.v)} 与页面的 ${DEVICE_PROTOCOL_VERSION} 不符` };
  const bad = (reason: string): BridgeParse => ({ ok: false, code: 'BRIDGE_PROTOCOL', reason });
  switch (data.type) {
    case 'hello': {
      const b = data.bridge;
      if (!isObj(b) || !str(b.terminal, 32) || !str(b.version, 32)) return bad('hello 缺少 bridge.terminal 或 bridge.version');
      if (!Array.isArray(data.devices)) return bad('hello 缺少 devices');
      const devices: Extract<BridgeMessage, { type: 'hello' }>['devices'] = [];
      for (const d of data.devices) {
        if (!isObj(d) || !str(d.key, 40) || (d.kind !== 'card_reader' && d.kind !== 'scanner') || !isStatus(d.status)) return bad('hello 的设备缺少 key、kind 或 status');
        devices.push({ key: d.key, kind: d.kind, status: d.status, ...(isDeviceErrorCode(d.code) ? { code: d.code } : {}) });
      }
      return { ok: true, message: { v: 1, type: 'hello', bridge: { terminal: b.terminal, version: b.version }, devices } };
    }
    case 'status':
      if (!str(data.key, 40) || !isStatus(data.status)) return bad('status 缺少 key 或 status');
      return { ok: true, message: { v: 1, type: 'status', key: data.key, status: data.status, ...(isDeviceErrorCode(data.code) ? { code: data.code } : {}) } };
    case 'card':
      if (!str(data.key, 40) || typeof data.cardNo !== 'string' || !CODE_RE.test(data.cardNo) || !isIso(data.at)) return bad('card 缺少 key、cardNo 或 at（卡号是 1–64 个可见字符）');
      return { ok: true, message: { v: 1, type: 'card', key: data.key, cardNo: data.cardNo, at: data.at } };
    case 'scan':
      if (!str(data.key, 40) || typeof data.code !== 'string' || !CODE_RE.test(data.code) || !isIso(data.at)) return bad('scan 缺少 key、code 或 at（条码是 1–64 个可见字符）');
      return { ok: true, message: { v: 1, type: 'scan', key: data.key, code: data.code, at: data.at } };
    case 'error':
      if (!isDeviceErrorCode(data.code) || typeof data.message !== 'string') return bad('error 缺少 code 或 message');
      return { ok: true, message: { v: 1, type: 'error', ...(str(data.key, 40) ? { key: data.key } : {}), code: data.code, message: data.message.slice(0, 200) } };
    case 'pong':
      return { ok: true, message: { v: 1, type: 'pong' } };
    default:
      return bad(`不认识的报文类型 ${String(data.type)}`);
  }
}

// ── 模拟键盘（扫码盒、读卡器工作在「模拟键盘」模式时号码像键盘一样打进页面）──

export const WEDGE_MAX_GAP_MS = 50;
export const WEDGE_MIN_LENGTH = 4;

/**
 * 认「很短时间内连续输入、以回车结束」为一次扫码 / 读卡，与人打字区分：字符间隔不超过 maxGapMs、至少 minLength 个字符。
 * feed 每个按键（key 为 KeyboardEvent.key、at 为毫秒时间）；认出一次返回号码，否则返回 null。
 */
export function createWedgeRecognizer(opts: { maxGapMs?: number; minLength?: number } = {}) {
  const maxGap = opts.maxGapMs ?? WEDGE_MAX_GAP_MS;
  const minLength = opts.minLength ?? WEDGE_MIN_LENGTH;
  let buffer = '';
  let last = -Infinity;
  return {
    feed(key: string, at: number): string | null {
      if (at - last > maxGap) buffer = '';
      last = at;
      if (key === 'Enter') {
        const code = buffer;
        buffer = '';
        return code.length >= minLength && CODE_RE.test(code) ? code : null;
      }
      if (key.length === 1) buffer += key;
      else if (key !== 'Shift') buffer = '';
      return null;
    },
    reset() {
      buffer = '';
      last = -Infinity;
    },
  };
}

// ── 采购清单（深圳市蔚瀚科技智能化硬件报价单，2025-12-17；不含价格）──

export interface DeviceQuoteLine {
  key: string;
  category: string;
  brand: string;
  model: string;
  kind: DeviceKind;
  connection: DeviceConnection;
  quantity: number;
  /** 按区域分配（按顺序，合计等于数量） */
  areas: { area: DeviceAreaName; count: number }[];
  priority: 'P0' | 'P1';
  bridgeKey?: string;
  options?: DeviceOptions;
  note?: string;
}

/**
 * 需求文档里的采购清单（12 行，81 台）。爱普生 TM-T83III 的区域分配合计 16、数量 14（文档注「含重叠」）：
 * 按区域顺序分满 14 台，按摩区的 2 台与其他区域重叠，现场核对后在后台改区域。
 */
export const DEVICE_QUOTE: DeviceQuoteLine[] = [
  {
    key: 'rc300', category: '手牌感应器（读卡）', brand: '普瑞迪', model: 'RC300', kind: 'card_reader', connection: 'bridge', quantity: 16, priority: 'P0', bridgeKey: 'rc300',
    areas: [{ area: '接待', count: 2 }, { area: '收银', count: 4 }, { area: '助浴', count: 2 }, { area: '水吧', count: 2 }, { area: '娱乐', count: 2 }, { area: '餐厅', count: 1 }, { area: '休息', count: 1 }, { area: '按摩', count: 2 }],
    note: '终端 USB；通信方式待规格（模拟键盘或串口）',
  },
  { key: 'd3pro', category: '智能台式终端', brand: '商米', model: 'D3 Pro 单屏', kind: 'terminal', connection: 'none', quantity: 8, priority: 'P0', areas: [{ area: '助浴', count: 2 }, { area: '水吧', count: 2 }, { area: '娱乐', count: 2 }, { area: '餐厅', count: 1 }, { area: '候钟房', count: 1 }] },
  { key: 'm3', category: '智能移动终端', brand: '商米', model: 'M3 NFC 版', kind: 'terminal', connection: 'none', quantity: 5, priority: 'P1', areas: [{ area: '餐厅', count: 2 }, { area: '休息', count: 3 }], note: '带 NFC 读卡' },
  { key: 'v3', category: '智能移动终端', brand: '商米', model: 'V3 NFC 版', kind: 'terminal', connection: 'none', quantity: 6, priority: 'P1', areas: [{ area: '接待', count: 2 }, { area: '助浴', count: 2 }, { area: '按摩', count: 2 }], note: '带 NFC 读卡' },
  { key: 'ft2', category: '智能交互终端', brand: '商米', model: 'FT2', kind: 'terminal', connection: 'none', quantity: 2, priority: 'P1', areas: [{ area: '助浴', count: 2 }], note: '自助交互' },
  { key: 'cpad', category: '智能商业平板', brand: '商米', model: 'Cpad 11 寸 4G 版', kind: 'terminal', connection: 'none', quantity: 2, priority: 'P1', areas: [{ area: '收银', count: 2 }] },
  {
    key: 'flash2', category: '扫码支付盒', brand: '商米', model: '小闪2', kind: 'scanner', connection: 'bridge', quantity: 9, priority: 'P1', bridgeKey: 'scanner',
    areas: [{ area: '接待', count: 2 }, { area: '收银', count: 4 }, { area: '休息', count: 1 }, { area: '按摩', count: 2 }],
    note: '终端 USB；模拟键盘模式可不经设备服务',
  },
  { key: 'g4', category: '打印服务器', brand: '华科', model: 'G4', kind: 'print_server', connection: 'network', quantity: 1, priority: 'P0', areas: [{ area: '后厨', count: 1 }], note: '集中转接后厨的 USB 打印机' },
  {
    key: 'xpc260m', category: '小票打印机', brand: '芯烨', model: 'XP-C260M', kind: 'printer', connection: 'network', quantity: 14, priority: 'P0', options: { paperWidth: 80 },
    areas: [{ area: '后厨', count: 13 }, { area: '候钟房', count: 1 }], note: 'USB + 网口；后厨的也可经华科 G4',
  },
  { key: 'xp246b', category: '标签打印机', brand: '芯烨', model: 'XP-246B', kind: 'label_printer', connection: 'network', quantity: 1, priority: 'P1', options: { labelLanguage: 'tspl', labelWidthMm: 40, labelHeightMm: 30 }, areas: [{ area: '后厨', count: 1 }], note: 'USB + 网口，TSPL' },
  {
    key: 'tmt83', category: '小票打印机', brand: '爱普生', model: 'TM-T83III', kind: 'printer', connection: 'network', quantity: 14, priority: 'P0', options: { paperWidth: 80 },
    areas: [{ area: '接待', count: 2 }, { area: '收银', count: 4 }, { area: '助浴', count: 2 }, { area: '水吧', count: 2 }, { area: '娱乐', count: 2 }, { area: '餐厅', count: 1 }, { area: '休息', count: 1 }],
    note: '接口版本待确认（网口 / USB + 串口）；清单另列按摩 2 台，与其他区域重叠，现场核对',
  },
  { key: 'tml100', category: '标签打印机', brand: '爱普生', model: 'TM-L100', kind: 'label_printer', connection: 'network', quantity: 3, priority: 'P1', options: { labelLanguage: 'escpos', labelWidthMm: 58, labelHeightMm: 40 }, areas: [{ area: '水吧', count: 3 }], note: '接口版本待确认' },
];

export interface DeviceImportPreview {
  /** 会新建的设备 */
  create: { code: string; name: string; kind: DeviceKind; model: string; area: string; catalogKey: string }[];
  /** 编号已有、跳过的设备 */
  skipped: string[];
  total: number;
}

const areaCode = (name: string) => DEVICE_AREAS.find((a) => a.name === name)?.code ?? 'QT';

/** 按采购清单生成设备编号与名称（类型前缀 + 区域 + 序号，同一区域同一类型按清单顺序编号） */
export function plannedQuoteDevices(quote: readonly DeviceQuoteLine[] = DEVICE_QUOTE) {
  const seq = new Map<string, number>();
  const out: { code: string; name: string; line: DeviceQuoteLine; area: string }[] = [];
  for (const line of quote) {
    for (const a of line.areas) {
      for (let i = 0; i < a.count; i++) {
        const prefix = `${DEVICE_KIND_PREFIX[line.kind]}-${areaCode(a.area)}`;
        const n = (seq.get(prefix) ?? 0) + 1;
        seq.set(prefix, n);
        out.push({ code: `${prefix}-${String(n).padStart(2, '0')}`, name: `${a.area} · ${line.model} ${n}`, line, area: a.area });
      }
    }
  }
  return out;
}
