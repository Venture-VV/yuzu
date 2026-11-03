// 网口直连（v0.7.21，docs/HARDWARE.md 第 2 节）：服务端按 IP 与端口建 TCP 连接发指令、查实时状态，门店不装程序。
//
// 打印：每次连接与发送限时；**还没开始发**就连不上的可以重试，**已经开始发**的不重发：发完后打印机正常关连接（收完）才算打出，
// 中途断开、发完后对方复位或出错、到时没确认的都记 DEVICE_INTERRUPTED（可能已打出一部分，由人看过再打）。写入回调成功只说明
// 数据交给了本机网络，不说明打印机收下了（Codex 预检 3efa3fe）。心跳：连上后发实时状态查询，按回复判断缺纸、开盖、故障；
// 连上但不回状态的按在线处理。

import net from 'node:net';
import type { DeviceErrorCode } from '@shared/devices';
import { JOB_ATTEMPT_TIMEOUT_MS, JOB_CONFIRM_TIMEOUT_MS, JOB_RETRIES, PROBE_TIMEOUT_MS } from '@shared/devices';
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

/**
 * 一次连接发完数据：连上后写入、半关闭，等打印机收完关连接。
 * 打印机正常关连接（对方 FIN、没有错误）才算打出；写完之后对方复位、出错，或 confirmMs 内没关的，记「中断」（不重发）。
 */
function sendOnce(ep: Endpoint, data: Buffer, timeoutMs: number, confirmMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let started = false;
    // 全部数据已交给本机网络（写入回调成功）：只说明本机写完了，还要等打印机正常关连接
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
    const onTimeout = () => {
      if (written) return finish(new DeviceIoError('DEVICE_INTERRUPTED', `已发出，打印机 ${confirmMs / 1000} 秒内没有确认收完（可能已打出），没有自动重发`, true));
      finish(new DeviceIoError(started ? 'DEVICE_INTERRUPTED' : 'DEVICE_TIMEOUT', started ? '发送超时（可能已打出一部分）' : `连接超时（${timeoutMs / 1000} 秒）`, started));
    };
    let timer = setTimeout(onTimeout, timeoutMs);
    socket.on('connect', () => {
      started = true;
      socket.write(data, (err) => {
        if (err) return finish(new DeviceIoError('DEVICE_INTERRUPTED', `发送到一半断开：${err.message}`, true));
        written = true;
        // 写完后半关闭，等打印机收完、关连接
        clearTimeout(timer);
        timer = setTimeout(onTimeout, confirmMs);
        socket.end();
      });
    });
    socket.on('close', (hadError) => {
      if (written && !hadError) return finish();
      if (written) return finish(new DeviceIoError('DEVICE_INTERRUPTED', '发出后连接被对方异常关闭（可能没打完），没有自动重发', true));
      finish(new DeviceIoError(started ? 'DEVICE_INTERRUPTED' : 'DEVICE_REFUSED', started ? '发送到一半连接被关闭' : '连接被关闭', started));
    });
    socket.on('error', (err) => {
      if (written) return finish(new DeviceIoError('DEVICE_INTERRUPTED', `发出后连接被对方复位或出错（可能没打完），没有自动重发：${err.message}`, true));
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

/** 发一个打印任务：没开始发就连不上的重试 JOB_RETRIES 次；开始发了的（中途断开、发完没确认）不重试 */
export async function sendToPrinter(
  ep: Endpoint,
  data: Buffer,
  opts: { timeoutMs?: number; confirmTimeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): Promise<SendResult> {
  const timeoutMs = opts.timeoutMs ?? JOB_ATTEMPT_TIMEOUT_MS;
  const confirmMs = opts.confirmTimeoutMs ?? JOB_CONFIRM_TIMEOUT_MS;
  const retries = opts.retries ?? JOB_RETRIES;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await sendOnce(ep, data, timeoutMs, confirmMs);
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
