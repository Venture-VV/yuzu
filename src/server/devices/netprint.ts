// 网口直连（v0.7.21，docs/HARDWARE.md 第 2 节）：服务端按 IP 与端口建 TCP 连接发指令、查实时状态，门店不装程序。
//
// 打印：每次连接与发送限时；**还没开始发**就连不上的可以重试，**已经开始发**中途断开的记 DEVICE_INTERRUPTED、不重发
// （可能已打出一半，由人看过再打）。心跳：连上后发实时状态查询，按回复判断缺纸、开盖、故障；连上但不回状态的按在线处理。

import net from 'node:net';
import type { DeviceErrorCode } from '@shared/devices';
import { JOB_ATTEMPT_TIMEOUT_MS, JOB_RETRIES, PROBE_TIMEOUT_MS } from '@shared/devices';
import { parseEscPosStatus, parseTsplStatus, STATUS_QUERY, TSPL_STATUS_QUERY } from './escpos';

export interface Endpoint {
  host: string;
  port: number;
}

/** 系统错误换成设备错误码 */
export function errorCodeOf(error: unknown): DeviceErrorCode {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ECONNREFUSED') return 'DEVICE_REFUSED';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EADDRNOTAVAIL') return 'DEVICE_UNREACHABLE';
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return 'DEVICE_TIMEOUT';
  return 'DEVICE_TIMEOUT';
}

class DeviceIoError extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    message: string,
    /** 失败时是否已经开始发（开始发了就不能重试） */
    readonly started: boolean,
  ) {
    super(message);
  }
}

/** 一次连接发完数据：连上后写入、等对方收下再关；超时、拒绝、中途断开都给出错误码 */
function sendOnce(ep: Endpoint, data: Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let started = false;
    // 全部数据已交给网络（写入回调成功）：之后对方直接断开（不少打印机收完就复位连接）也算发完
    let written = false;
    let settled = false;
    const socket = net.connect({ host: ep.host, port: ep.port });
    const finish = (error?: DeviceIoError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (written) return finish();
      finish(new DeviceIoError(started ? 'DEVICE_INTERRUPTED' : 'DEVICE_TIMEOUT', started ? '发送超时（可能已打出一部分）' : `连接超时（${timeoutMs / 1000} 秒）`, started));
    }, timeoutMs);
    socket.on('connect', () => {
      started = true;
      socket.write(data, (err) => {
        if (err) return finish(new DeviceIoError('DEVICE_INTERRUPTED', `发送到一半断开：${err.message}`, true));
        written = true;
        // 写完后半关闭，等对方收下关连接；对方不关，超时时也算发完
        socket.end();
      });
    });
    socket.on('close', () => {
      if (written) return finish();
      finish(new DeviceIoError(started ? 'DEVICE_INTERRUPTED' : 'DEVICE_REFUSED', started ? '发送到一半连接被关闭' : '连接被关闭', started));
    });
    socket.on('error', (err) => {
      if (written) return finish();
      if (started) finish(new DeviceIoError('DEVICE_INTERRUPTED', `发送到一半断开：${err.message}`, true));
      else finish(new DeviceIoError(errorCodeOf(err), err.message, false));
    });
  });
}

export interface SendResult {
  ok: boolean;
  attempts: number;
  errorCode?: DeviceErrorCode;
  errorMessage?: string;
}

/** 发一个打印任务：没开始发就连不上的重试 JOB_RETRIES 次，开始发了中途断开的不重试 */
export async function sendToPrinter(ep: Endpoint, data: Buffer, opts: { timeoutMs?: number; retries?: number; retryDelayMs?: number } = {}): Promise<SendResult> {
  const timeoutMs = opts.timeoutMs ?? JOB_ATTEMPT_TIMEOUT_MS;
  const retries = opts.retries ?? JOB_RETRIES;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await sendOnce(ep, data, timeoutMs);
      return { ok: true, attempts };
    } catch (e) {
      const err = e instanceof DeviceIoError ? e : new DeviceIoError(errorCodeOf(e), (e as Error).message, false);
      if (err.started || attempts > retries) return { ok: false, attempts, errorCode: err.code, errorMessage: err.message };
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 300));
    }
  }
}

export interface ProbeResult {
  /** 连上了没有 */
  reachable: boolean;
  /** 连上时：缺纸、开盖、故障（null 为正常或详情未知）；连不上时：连接的错误码 */
  code: DeviceErrorCode | null;
}

/**
 * 心跳：连上后发实时状态查询，等回复（最多 timeoutMs）；连上但不回的按在线、详情未知。
 * mode：escpos 发 DLE EOT 1/2/4；tspl 发 ESC ! ?；connect 只看能不能连上（打印服务器）。
 */
export function probe(ep: Endpoint, mode: 'escpos' | 'tspl' | 'connect', timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const chunks: Buffer[] = [];
    const socket = net.connect({ host: ep.host, port: ep.port });
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const expected = mode === 'escpos' ? 3 : 1;
    const parse = () => {
      const reply = Buffer.concat(chunks);
      return mode === 'escpos' ? parseEscPosStatus(reply) : mode === 'tspl' ? parseTsplStatus(reply) : null;
    };
    const timer = setTimeout(() => finish(connected ? { reachable: true, code: parse() } : { reachable: false, code: 'DEVICE_TIMEOUT' }), timeoutMs);
    socket.on('connect', () => {
      connected = true;
      if (mode === 'connect') return finish({ reachable: true, code: null });
      socket.write(mode === 'escpos' ? STATUS_QUERY : TSPL_STATUS_QUERY);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length >= expected) finish({ reachable: true, code: parse() });
    });
    socket.on('error', (err) => finish(connected ? { reachable: true, code: parse() } : { reachable: false, code: errorCodeOf(err) }));
    socket.on('close', () => finish(connected ? { reachable: true, code: parse() } : { reachable: false, code: 'DEVICE_REFUSED' }));
  });
}
