// 模拟桥（v0.7.21，docs/HARDWARE.md 第 3 节）：代替终端上的设备服务，在本机开 WebSocket，按协议 v1 发 hello、状态、读卡、扫码。
// 真机（RC300、小闪2、商米 NFC）与 APK 没到之前，浏览器验收、device-selftest 与命令行 device-bridge-mock 都用它。
//
// 只实现模拟需要的 WebSocket（RFC 6455）：握手、文本帧、ping / pong、关闭；页面发来的 ping 回 pong。
// 真机的设备服务要核对来源（Origin 是门店系统的地址）才接受连接；模拟桥只在本机开，不核对。

import { createHash } from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { DEVICE_PROTOCOL_VERSION, type BridgeDeviceKind, type BridgeMessage, type DeviceErrorCode, type DeviceStatus } from '@shared/devices';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface MockBridgeDevice {
  key: string;
  kind: BridgeDeviceKind;
  status: DeviceStatus;
  code?: DeviceErrorCode;
}

export interface MockBridge {
  port: number;
  url: string;
  terminal: string;
  devices: MockBridgeDevice[];
  /** 当前连着的页面数 */
  clients(): number;
  /** 页面发来的报文（已解析的 JSON） */
  received: unknown[];
  sendCard(cardNo: string, key?: string): void;
  sendScan(code: string, key?: string): void;
  /** 设备插拔：发状态报文 */
  setDevice(key: string, status: DeviceStatus, code?: DeviceErrorCode): void;
  /** 读卡失败：发 error 报文 */
  failRead(key?: string): void;
  /** 发一条原样的文本（测试协议错误） */
  sendRaw(text: string): void;
  /** 断开所有页面（模拟设备服务重启） */
  disconnectAll(): void;
  close(): Promise<void>;
}

/** 文本帧（服务端发的不加掩码） */
function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]) : Buffer.alloc(10);
  if (len >= 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** 解析客户端发来的帧（带掩码）；不完整时返回 null */
function readFrame(buf: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskAt = offset;
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buf[maskAt + (i % 4)]!;
  return { opcode, payload, size: offset + len };
}

export async function startMockBridge(
  opts: { host?: string; port?: number; terminal?: string; devices?: MockBridgeDevice[]; delayMs?: number; version?: string } = {},
): Promise<MockBridge> {
  const host = opts.host ?? '127.0.0.1';
  const delay = opts.delayMs ?? 0;
  const sockets = new Set<Duplex>();
  const devices: MockBridgeDevice[] = (opts.devices ?? [
    { key: 'rc300', kind: 'card_reader', status: 'online' },
    { key: 'scanner', kind: 'scanner', status: 'online' },
    { key: 'nfc', kind: 'card_reader', status: 'online' },
  ]).map((d) => ({ ...d }));
  const terminal = opts.terminal ?? 'TRM-MOCK-01';

  const send = (socket: Duplex, text: string) => {
    const go = () => {
      if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(text)));
    };
    if (delay > 0) setTimeout(go, delay);
    else go();
  };
  const broadcast = (message: BridgeMessage | Record<string, unknown>) => {
    const text = JSON.stringify(message);
    for (const s of sockets) send(s, text);
  };
  const hello = (): BridgeMessage => ({ v: 1, type: 'hello', bridge: { terminal, version: opts.version ?? '0.1.0-mock' }, devices: devices.map((d) => ({ ...d })) });

  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('模拟桥只接 WebSocket');
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const f = readFrame(pending);
        if (!f) break;
        pending = pending.subarray(f.size);
        if (f.opcode === 0x8) {
          socket.end(frame(0x8, Buffer.alloc(0)));
          sockets.delete(socket);
          return;
        }
        if (f.opcode === 0x9) {
          socket.write(frame(0xa, f.payload));
          continue;
        }
        if (f.opcode !== 0x1) continue;
        let data: unknown;
        try {
          data = JSON.parse(f.payload.toString('utf8'));
        } catch {
          continue;
        }
        bridge.received.push(data);
        if ((data as { type?: string }).type === 'ping') send(socket, JSON.stringify({ v: DEVICE_PROTOCOL_VERSION, type: 'pong' }));
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    send(socket, JSON.stringify(hello()));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const now = () => new Date().toISOString();

  const bridge: MockBridge = {
    port,
    url: `ws://${host}:${port}`,
    terminal,
    devices,
    clients: () => sockets.size,
    received: [],
    sendCard: (cardNo, key = 'rc300') => broadcast({ v: 1, type: 'card', key, cardNo, at: now() }),
    sendScan: (code, key = 'scanner') => broadcast({ v: 1, type: 'scan', key, code, at: now() }),
    setDevice: (key, status, code) => {
      const d = devices.find((x) => x.key === key);
      if (d) {
        d.status = status;
        if (code) d.code = code;
        else delete d.code;
      }
      broadcast({ v: 1, type: 'status', key, status, ...(code ? { code } : {}) });
    },
    failRead: (key = 'rc300') => broadcast({ v: 1, type: 'error', key, code: 'READ_FAILED', message: '模拟：读卡失败' }),
    sendRaw: (text) => {
      for (const s of sockets) send(s, text);
    },
    disconnectAll: () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
  return bridge;
}
