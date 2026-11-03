// 模拟网口打印机（v0.7.21，docs/HARDWARE.md 第 2、8 节）：本机 TCP，懂 ESC/POS 与 TSPL 的状态查询，收下打印内容。
// 真机没到时代替：浏览器验收、集成测试、device-selftest 与命令行 device-printer-mock 都用它。
//
// 模式：normal 正常；paper_out 缺纸；cover_open 开盖；fault 故障；silent 不回状态（有的型号网口不回）；
// drop 收到打印内容就复位连接（模拟发送到一半断开）。stop() 关掉端口（模拟拔线），start() 在同一端口重新开（插回）。

import net from 'node:net';
import { decodePrintedText } from './escpos';

export const MOCK_PRINTER_MODES = ['normal', 'paper_out', 'cover_open', 'fault', 'silent', 'drop'] as const;
export type MockPrinterMode = (typeof MOCK_PRINTER_MODES)[number];

export interface MockPrinter {
  host: string;
  port: number;
  /** 收到的打印内容（每个连接一份，去掉了状态查询） */
  jobs: Buffer[];
  /** 打印内容还原成的文字 */
  texts(): string[];
  setMode(mode: MockPrinterMode): void;
  setDelay(ms: number): void;
  /** 模拟拔线：关端口、断开已有连接 */
  stop(): Promise<void>;
  /** 模拟插回：同一端口重新开 */
  start(): Promise<void>;
  close(): Promise<void>;
  onJob?: (job: Buffer) => void;
}

/** DLE EOT n 的回复（固定位 0x12） */
function escposStatus(n: number, mode: MockPrinterMode): number {
  const trouble = mode === 'paper_out' || mode === 'cover_open' || mode === 'fault';
  if (n === 1) return trouble ? 0x1e : 0x16;
  if (n === 2) return mode === 'cover_open' ? 0x16 : mode === 'paper_out' ? 0x32 : mode === 'fault' ? 0x52 : 0x12;
  if (n === 4) return mode === 'paper_out' ? 0x72 : 0x12;
  return 0x12;
}
/** TSPL 的 ESC ! ? 回复 */
const tsplStatus = (mode: MockPrinterMode) => (mode === 'cover_open' ? 0x01 : mode === 'paper_out' ? 0x04 : mode === 'fault' ? 0x02 : 0x00);

export async function startMockPrinter(opts: { host?: string; port?: number; mode?: MockPrinterMode; delayMs?: number } = {}): Promise<MockPrinter> {
  const host = opts.host ?? '127.0.0.1';
  let mode: MockPrinterMode = opts.mode ?? 'normal';
  let delay = opts.delayMs ?? 0;
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;
  let port = opts.port ?? 0;

  const handle = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const content: number[] = [];
    let reset = false;
    socket.on('data', (chunk: Buffer) => {
      if (reset) return;
      const replies: number[] = [];
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i]!;
        if (b === 0x10 && chunk[i + 1] === 0x04 && chunk[i + 2] !== undefined) {
          replies.push(escposStatus(chunk[i + 2]!, mode));
          i += 2;
          continue;
        }
        if (b === 0x1b && chunk[i + 1] === 0x21 && chunk[i + 2] === 0x3f) {
          replies.push(tsplStatus(mode));
          i += 2;
          continue;
        }
        content.push(b);
      }
      if (content.length > 0 && mode === 'drop') {
        reset = true;
        socket.resetAndDestroy();
        return;
      }
      if (replies.length > 0 && mode !== 'silent') {
        const send = () => {
          if (!socket.destroyed) socket.write(Buffer.from(replies));
        };
        if (delay > 0) setTimeout(send, delay);
        else send();
      }
    });
    socket.on('end', () => {
      if (content.length > 0 && !reset) {
        const job = Buffer.from(content);
        printer.jobs.push(job);
        printer.onJob?.(job);
      }
      socket.end();
    });
  };

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server = net.createServer(handle);
      server.once('error', reject);
      server.listen(port, host, () => {
        port = (server!.address() as net.AddressInfo).port;
        printer.port = port;
        resolve();
      });
    });
  const shut = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (!server) return resolve();
      server.close(() => resolve());
      server = null;
    });

  const printer: MockPrinter = {
    host,
    port,
    jobs: [],
    texts: () => printer.jobs.map((j) => decodePrintedText(j)),
    setMode: (m) => {
      mode = m;
    },
    setDelay: (ms) => {
      delay = ms;
    },
    stop: shut,
    start: listen,
    close: shut,
  };
  await listen();
  return printer;
}
