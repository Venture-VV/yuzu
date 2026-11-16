// 服务端的防护（8.1.3，docs/RESILIENCE_V813.md 第 3.5 节，WL8–WL10）：访问网段、过载保护、频率限制。
//
// 照 fastify/under-pressure（事件循环卡顿、同时处理的请求太多时，请求一进来就回 503 + Retry-After）与
// fastify/fastify-rate-limit（令牌桶，超了回 429 + Retry-After）的做法自己写，没有引入它们：要按我们的会话算
// （门店几台电脑共用一个出口 IP，登录了的不能按 IP 限）、回我们的错误格式，而且这几种拒绝都发生在处理之前——
// 页面据此判断「确定没处理」，带原操作编号自动重发（WL5，src/client/lib/api.ts）。

import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { decodedPath } from './paths';
import { SESSION_COOKIE } from '../auth/session';

export interface ProtectionConfig {
  /** 同时在处理的接口请求超过这个数，新来的回「系统正忙」；0 = 不看 */
  maxInFlight: number;
  /** 事件循环平均卡顿超过这么多毫秒（每秒算一次），新来的回「系统正忙」；0 = 不看 */
  maxLagMs: number;
  /** 登录了的每个会话每分钟多少次；0 = 不限 */
  sessionPerMin: number;
  /** 没登录的每个 IP 每分钟多少次；0 = 不限 */
  ipPerMin: number;
  /** 只有这些网段能用接口（ACCESS_ALLOW_CIDRS）；空 = 不限（默认，与 Z5 一致） */
  allowCidrs: string[];
}

export const DEFAULT_PROTECTION: ProtectionConfig = { maxInFlight: 256, maxLagMs: 1000, sessionPerMin: 600, ipPerMin: 300, allowCidrs: [] };

/** 从环境变量读；写错的数字、网段直接报错（启动不了比悄悄不生效好）。测试环境默认不看事件循环卡顿（跑用例的机器忙起来会误判） */
export function loadProtectionConfig(env: NodeJS.ProcessEnv, appEnv: string): ProtectionConfig {
  const num = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} 要写不小于 0 的整数（0 = 关掉），当前是「${raw}」`);
    return n;
  };
  const allowCidrs = (env.ACCESS_ALLOW_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  buildAllowList(allowCidrs); // 写错的网段在启动时就报出来
  return {
    maxInFlight: num('OVERLOAD_MAX_INFLIGHT', DEFAULT_PROTECTION.maxInFlight),
    maxLagMs: num('OVERLOAD_MAX_LAG_MS', appEnv === 'test' ? 0 : DEFAULT_PROTECTION.maxLagMs),
    sessionPerMin: num('RATE_LIMIT_SESSION_PER_MIN', DEFAULT_PROTECTION.sessionPerMin),
    ipPerMin: num('RATE_LIMIT_IP_PER_MIN', DEFAULT_PROTECTION.ipPerMin),
    allowCidrs,
  };
}

/** 「网段」写法：192.168.1.0/24、100.64.0.0/10、fd7a:115c:a1e0::/48，或者单个地址 */
export function buildAllowList(cidrs: string[]): BlockList | null {
  if (!cidrs.length) return null;
  const list = new BlockList();
  for (const raw of cidrs) {
    const [addr, bits] = raw.split('/') as [string, string | undefined];
    const family = isIP(addr);
    if (!family) throw new Error(`ACCESS_ALLOW_CIDRS 里「${raw}」不是地址或网段`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) {
      list.addAddress(addr, type);
      continue;
    }
    const prefix = Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) throw new Error(`ACCESS_ALLOW_CIDRS 里「${raw}」的前缀长度不对`);
    list.addSubnet(addr, prefix, type);
  }
  return list;
}

/** 来源地址在不在允许的网段里（IPv4 映射成 IPv6 的 ::ffff:a.b.c.d 按 IPv4 认） */
export function ipAllowed(list: BlockList, ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? mapped[1]! : ip;
  const family = isIP(addr);
  if (!family) return false;
  return list.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

/** 令牌桶：每个键最多攒 capacity 个，按每秒 refillPerSec 个补；只在内存里，重启清空 */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    /** 键太多（例如有人换着地址刷）时先丢最早的，内存有上限 */
    private readonly maxKeys = 20_000,
  ) {}

  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        const drop = Math.ceil(this.maxKeys / 10);
        let i = 0;
        for (const k of this.buckets.keys()) {
          if (i++ >= drop) break;
          this.buckets.delete(k);
        }
      }
      b = { tokens: this.capacity, at: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
      b.at = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerSec)) };
  }

  /** 早就补满的桶删掉（和新的一样） */
  sweep(now = Date.now()): void {
    const full = (this.capacity / this.refillPerSec) * 1000;
    for (const [k, b] of this.buckets) if (now - b.at > full) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** 不受过载保护、频率限制、访问网段影响的：页面问「连不连得上」、健康检查 */
const PROBE_PATHS = new Set(['/api/ping', '/api/health', '/api/canteen/ping']);
/** 访问网段放行的：供应商、对账链接（对外） */
const PUBLIC_PREFIX = '/api/public/';

export interface ProtectionStats {
  inFlight: number;
  lagMs: number;
  overloaded: boolean;
  shed: number;
  limited: number;
  denied: number;
}

export interface Protection {
  /** 第一道（在读会话之前）：访问网段、过载保护，并记下同时在处理的请求数 */
  gate: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;
  /** 处理完（onResponse）或对方断开（onRequestAbort）：同时在处理的请求数减一（每个请求只减一次） */
  done: (req: FastifyRequest) => Promise<void>;
  /** 第二道（读完会话之后）：频率限制——登录了的按会话，没登录的按 IP */
  limit: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;
  stats: () => ProtectionStats;
  close: () => void;
}

/** 事件循环卡顿：每秒取一次这一秒里的平均值（under-pressure 的算法），单次垃圾回收的停顿不会触发 */
function lagMonitor(intervalMs = 1000) {
  const resolution = 10;
  const h = monitorEventLoopDelay({ resolution });
  h.enable();
  let lagMs = 0;
  const timer = setInterval(() => {
    const mean = h.mean / 1e6;
    lagMs = Number.isFinite(mean) ? Math.max(0, mean - resolution) : 0;
    h.reset();
  }, intervalMs);
  timer.unref();
  return {
    current: () => lagMs,
    stop: () => {
      clearInterval(timer);
      h.disable();
    },
  };
}

function reject(reply: FastifyReply, status: number, code: string, message: string, retryAfterSec?: number): FastifyReply {
  if (retryAfterSec !== undefined) reply.header('retry-after', String(retryAfterSec));
  return reply.code(status).send({ error: { code, message } });
}

export function createProtection(cfg: ProtectionConfig): Protection {
  const allow = buildAllowList(cfg.allowCidrs);
  const lag = cfg.maxLagMs > 0 ? lagMonitor() : null;
  const sessions = cfg.sessionPerMin > 0 ? new TokenBuckets(cfg.sessionPerMin, cfg.sessionPerMin / 60) : null;
  const ips = cfg.ipPerMin > 0 ? new TokenBuckets(cfg.ipPerMin, cfg.ipPerMin / 60) : null;
  const sweeper = setInterval(() => {
    sessions?.sweep();
    ips?.sweep();
  }, 60_000);
  sweeper.unref();
  let inFlight = 0;
  const counters = { shed: 0, limited: 0, denied: 0 };
  const counted = new WeakSet<FastifyRequest>();

  const overloaded = () => (cfg.maxInFlight > 0 && inFlight >= cfg.maxInFlight) || (lag !== null && lag.current() > cfg.maxLagMs);

  return {
    async gate(req, reply) {
      const path = decodedPath(req.url);
      if (!path.startsWith('/api/') || PROBE_PATHS.has(path)) return undefined;
      if (allow && !path.startsWith(PUBLIC_PREFIX) && !ipAllowed(allow, req.ip)) {
        counters.denied += 1;
        req.log.warn({ ip: req.ip, path }, '不在允许的网段里，拒绝');
        return reject(reply, 403, 'ACCESS_DENIED', '这个网络不能使用系统（店主设了只有门店等指定的网络能用），请换到门店的网络再试');
      }
      if (overloaded()) {
        counters.shed += 1;
        req.log.warn({ inFlight, lagMs: Math.round(lag?.current() ?? 0), path }, '系统正忙，这次没处理');
        return reject(reply, 503, 'OVERLOADED', '系统正忙，这次没有处理，页面会自动稍后再试', 2);
      }
      inFlight += 1;
      counted.add(req);
      return undefined;
    },

    async done(req) {
      if (counted.delete(req)) inFlight -= 1;
    },

    async limit(req, reply) {
      const path = decodedPath(req.url);
      if (!path.startsWith('/api/') || PROBE_PATHS.has(path)) return undefined;
      const token = req.hasSession ? req.cookies[SESSION_COOKIE] : undefined;
      const hit = token ? sessions?.take(`s:${createHash('sha256').update(token).digest('base64url').slice(0, 22)}`) : ips?.take(`ip:${req.ip}`);
      if (!hit || hit.ok) return undefined;
      counters.limited += 1;
      req.log.warn({ ip: req.ip, path, session: Boolean(token) }, '请求太频繁，这次没处理');
      return reject(reply, 429, 'RATE_LIMITED', '请求太频繁，这次没有处理，请稍等几秒', hit.retryAfterSec);
    },

    stats() {
      return { inFlight, lagMs: Math.round(lag?.current() ?? 0), overloaded: overloaded(), ...counters };
    },

    close() {
      clearInterval(sweeper);
      lag?.stop();
    },
  };
}
