// 本机终端（v0.7.21，docs/HARDWARE.md 第 3 节）：连本机的设备服务（桥）收读卡、扫码与设备状态，开着页面就替桥每 2 秒上报服务端。
//
// · 这台终端是哪一台、桥的地址记在本机（localStorage，存不了就只在这次打开时有效）；没选终端不上报。
// · 桥的报文按协议 v1 解析，不对的不认（页面上提示 BRIDGE_PROTOCOL）；断开后每 2 秒重连。
// · 读卡、扫码事件带编号，上报失败下次再报，服务端按编号去重。
// · 模拟键盘（扫码盒、读卡器的键盘模式）在设备页上收，也作为这台终端的事件上报（设备键 keyboard）。

import { useEffect, useSyncExternalStore } from 'react';
import {
  BRIDGE_REPORT_INTERVAL_MS,
  bridgeErrorEventValue,
  DEFAULT_BRIDGE_PORT,
  parseBridgeMessage,
  type BridgeDeviceKind,
  type BridgeReportResult,
  type DeviceErrorCode,
  type DeviceStatus,
} from '@shared/devices';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { uuid } from '../../lib/utils';

const TERMINAL_KEY = 'yuzu.device.terminal';
const BRIDGE_URL_KEY = 'yuzu.device.bridgeUrl';
export const DEFAULT_BRIDGE_URL = `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;

export interface TerminalEvent {
  id: string;
  key: string;
  type: 'card' | 'scan' | 'error';
  value: string;
  at: string;
  source: 'bridge' | 'keyboard';
}

export interface TerminalState {
  terminal: string | null;
  bridgeUrl: string;
  connected: boolean;
  bridgeVersion: string | null;
  /** 桥报上来的终端编号（与页面选的不同时提示） */
  bridgeTerminal: string | null;
  devices: { key: string; kind: BridgeDeviceKind; status: DeviceStatus; code?: DeviceErrorCode }[];
  events: TerminalEvent[];
  protocolError: string | null;
  lastReport: { at: string; ok: boolean; message?: string; result?: BridgeReportResult } | null;
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 存不了就只在这次打开时有效 */
  }
};

let state: TerminalState = {
  terminal: read(TERMINAL_KEY),
  bridgeUrl: read(BRIDGE_URL_KEY) || DEFAULT_BRIDGE_URL,
  connected: false,
  bridgeVersion: null,
  bridgeTerminal: null,
  devices: [],
  events: [],
  protocolError: null,
  lastReport: null,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<TerminalState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** 还没报给服务端的事件 */
let unsent: TerminalEvent[] = [];
const MAX_EVENTS = 30;

function addEvent(e: Omit<TerminalEvent, 'id'>) {
  const event = { ...e, id: uuid() };
  set({ events: [event, ...state.events].slice(0, MAX_EVENTS) });
  if (e.type !== 'error' || e.source === 'bridge') unsent = [...unsent, event].slice(-50);
}

let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let users = 0;

function connect() {
  if (socket || users === 0) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(state.bridgeUrl);
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;
  // 换了地址或重连后，旧连接晚到的回调一律不管：不能把新连接的状态清掉（Codex 自动审查 9ca8a95）
  ws.onopen = () => {
    if (socket !== ws) {
      ws.close();
      return;
    }
    set({ connected: true, protocolError: null });
    ws.send(JSON.stringify({ v: 1, type: 'hello', page: 'yuzu' }));
  };
  ws.onmessage = (ev) => {
    if (socket !== ws) return;
    const r = parseBridgeMessage(String(ev.data));
    if (!r.ok) {
      set({ protocolError: r.reason });
      return;
    }
    const m = r.message;
    if (m.type === 'hello') set({ bridgeVersion: m.bridge.version, bridgeTerminal: m.bridge.terminal, devices: m.devices });
    else if (m.type === 'status') {
      const known = state.devices.some((d) => d.key === m.key);
      set({
        devices: known
          ? state.devices.map((d) => (d.key === m.key ? { ...d, status: m.status, ...(m.code ? { code: m.code } : { code: undefined }) } : d))
          : [...state.devices, { key: m.key, kind: 'card_reader', status: m.status, ...(m.code ? { code: m.code } : {}) }],
      });
    } else if (m.type === 'card') addEvent({ key: m.key, type: 'card', value: m.cardNo, at: m.at, source: 'bridge' });
    else if (m.type === 'scan') addEvent({ key: m.key, type: 'scan', value: m.code, at: m.at, source: 'bridge' });
    else if (m.type === 'error') addEvent({ key: m.key ?? 'bridge', type: 'error', value: bridgeErrorEventValue(m.code, m.message), at: new Date().toISOString(), source: 'bridge' });
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    set({ connected: false, devices: [] });
    scheduleRetry();
  };
  ws.onerror = () => {
    /* onclose 接着来，在那里重连 */
  };
}

function scheduleRetry() {
  if (retry || users === 0) return;
  retry = setTimeout(() => {
    retry = null;
    connect();
  }, 2_000);
}

function disconnect() {
  if (retry) clearTimeout(retry);
  retry = null;
  const s = socket;
  socket = null;
  s?.close();
  set({ connected: false, devices: [] });
}

let reporting = false;
async function report() {
  if (!state.terminal || reporting) return;
  reporting = true;
  const events = unsent.slice(0, 50);
  try {
    const result = await api.post<BridgeReportResult>('/api/devices/bridge-report', {
      terminal: state.terminal,
      bridge: { connected: state.connected, ...(state.bridgeVersion ? { version: state.bridgeVersion } : {}) },
      devices: state.devices.map((d) => ({ key: d.key, status: d.status, code: d.code ?? null })),
      events: events.map(({ id, key, type, value, at }) => ({ id, key, type, value, at })),
    });
    const sent = new Set(events.map((e) => e.id));
    unsent = unsent.filter((e) => !sent.has(e.id));
    set({ lastReport: { at: new Date().toISOString(), ok: true, result } });
  } catch (e) {
    set({ lastReport: { at: new Date().toISOString(), ok: false, message: errorMessage(e) } });
  } finally {
    reporting = false;
  }
}

export const terminalActions = {
  setTerminal(code: string | null) {
    write(TERMINAL_KEY, code);
    set({ terminal: code, lastReport: null });
  },
  setBridgeUrl(url: string) {
    const next = url.trim() || DEFAULT_BRIDGE_URL;
    write(BRIDGE_URL_KEY, next === DEFAULT_BRIDGE_URL ? null : next);
    set({ bridgeUrl: next });
    disconnect();
    connect();
  },
  /** 设备页收到的模拟键盘输入（扫码盒、读卡器的键盘模式） */
  keyboardInput(code: string) {
    addEvent({ key: 'keyboard', type: 'scan', value: code, at: new Date().toISOString(), source: 'keyboard' });
  },
  reportNow: report,
};

export function useTerminalState(): TerminalState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * 在门店外壳里常开：选了这台终端、有「看设备状态」权限时连本机的桥、每 2 秒替它上报（不在设备页也照常上报）。
 * 设备页打开时也会挂上（还没选终端时可以先看桥连没连上）。
 */
export function useTerminalBridge(active: boolean) {
  const can = useCan();
  const terminal = useTerminalState().terminal;
  const on = active && can('device.view');
  useEffect(() => {
    if (!on) return;
    users += 1;
    connect();
    return () => {
      users -= 1;
      if (users === 0) disconnect();
    };
  }, [on]);
  useEffect(() => {
    if (!on || !terminal) return;
    void report();
    const t = setInterval(() => void report(), BRIDGE_REPORT_INTERVAL_MS);
    return () => clearInterval(t);
  }, [on, terminal]);
}

/** 门店外壳里用：选了终端才连桥、上报 */
export function TerminalBridgeRunner() {
  const terminal = useTerminalState().terminal;
  useTerminalBridge(!!terminal);
  return null;
}
