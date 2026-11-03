// 连网关（docs/MINIPROGRAM.md 第 1、12 节）：小程序只连网关，网关再连门店系统。
//   · 登录：wx.login 的 code 换网关会话（7 天，只有 openid），存在本机；会话失效（401 SESSION_REQUIRED）时重新登录、重发一次；
//   · 展示内容（门店信息、价目、导览）：成功时存一份在本机，网关或门店连不上时先给本机的旧内容（最多 7 天），页面上标「之前的信息」；
//   · 会员相关（余额、流水、券、会员码）：不存本机，连不上时页面显示「门店系统连接中」；
//   · 网关是「模拟微信」时（只在开发版、体验版，正式版一律不用）：登录用 mock-<名字>，绑定用手动填的手机号。
// 网关与门店系统返回的错误文字面向顾客，原样显示。

import { envVersion, gatewayBase } from '../config/env';

export interface ApiError {
  readonly api: true;
  /** 网关或门店系统的错误码；NETWORK = 小程序连不上网关 */
  code: string;
  message: string;
  status: number;
}

export function apiError(code: string, message: string, status: number): ApiError {
  return { api: true, code, message, status };
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && (e as { api?: unknown }).api === true;
}

/** 连不上：小程序连不上网关（NETWORK），或网关连不上门店（STORE_OFFLINE） */
export function isOffline(e: unknown): boolean {
  return isApiError(e) && (e.code === 'NETWORK' || e.code === 'STORE_OFFLINE');
}

/** 给页面显示的一句话 */
export function messageOf(e: unknown): string {
  if (isApiError(e)) return e.message;
  return '出了点问题，请稍后再试';
}

interface Raw {
  status: number;
  data: unknown;
  cache: string;
}

function send(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, token: string | null): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const header: Record<string, string> = { 'content-type': 'application/json' };
    if (token) header.authorization = 'Bearer ' + token;
    wx.request({
      url: gatewayBase() + path,
      method,
      // POST 一律带 JSON（空的也写 {}）：网关按 JSON 解析
      data: method === 'POST' ? body || {} : undefined,
      header,
      timeout: 10000,
      success: (res) => {
        const h = (res.header || {}) as Record<string, string>;
        resolve({ status: res.statusCode, data: res.data, cache: h['x-cache'] || h['X-Cache'] || '' });
      },
      fail: () => reject(apiError('NETWORK', '网络不太好，请稍后再试', 0)),
    });
  });
}

function errorOf(r: Raw): ApiError {
  const body = r.data && typeof r.data === 'object' ? (r.data as { error?: { code?: unknown; message?: unknown } }) : {};
  const e = body.error;
  const code = e && typeof e.code === 'string' ? e.code : r.status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
  const message = e && typeof e.message === 'string' && e.message ? e.message : '网络出了点问题，请稍后再试';
  return apiError(code, message, r.status);
}

const ok = (r: Raw) => r.status >= 200 && r.status < 300;

// ── 模拟微信（开发版、体验版连「模拟微信」的网关时）──

let mock: boolean | null = null;
const MOCK_USER_KEY = 'tq_mock_user';

/** 网关是不是模拟微信：正式版一律 false；问不到网关时这次按 false，下次再问 */
export async function mockWechat(): Promise<boolean> {
  if (envVersion() === 'release') return false;
  if (mock !== null) return mock;
  try {
    const r = await send('GET', '/v1/health', undefined, null);
    mock = r.status === 200 && !!r.data && (r.data as { mockWechat?: unknown }).mockWechat === true;
    return mock;
  } catch {
    return false;
  }
}

function randomName(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += 'abcdefghijkmnpqrstuvwxyz23456789'.charAt(Math.floor(Math.random() * 32));
  return s;
}

/** 模拟的微信用户：一台手机一个，换一个就像换了一个微信 */
export function mockUser(): string {
  let name = '';
  try {
    name = wx.getStorageSync(MOCK_USER_KEY) as string;
  } catch {
    name = '';
  }
  if (!name) {
    name = 'dev' + randomName();
    try {
      wx.setStorageSync(MOCK_USER_KEY, name);
    } catch {
      // 存不了：这次用新的
    }
  }
  return name;
}

export function switchMockUser(): string {
  try {
    wx.removeStorageSync(MOCK_USER_KEY);
  } catch {
    // 删不了就覆盖
  }
  clearSession();
  return mockUser();
}

// ── 会话 ──

const SESSION_KEY = 'tq_session';
interface Session {
  token: string;
  expiresAt: string;
}

function readSession(): Session | null {
  try {
    const s = wx.getStorageSync(SESSION_KEY) as Session | '';
    // 还剩不到 1 小时的不用，免得用到一半过期
    if (s && typeof s.token === 'string' && Date.parse(s.expiresAt) - Date.now() > 3600 * 1000) return s;
  } catch {
    // 读不了就重新登录
  }
  return null;
}

export function clearSession(): void {
  try {
    wx.removeStorageSync(SESSION_KEY);
  } catch {
    // 删不了：下次登录覆盖
  }
}

function wxLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => (r.code ? resolve(r.code) : reject(apiError('WX_LOGIN_FAILED', '微信登录没成功，请稍后再试', 0))),
      fail: () => reject(apiError('WX_LOGIN_FAILED', '微信登录没成功，请稍后再试', 0)),
    });
  });
}

async function login(): Promise<string> {
  const code = (await mockWechat()) ? 'mock-' + mockUser() : await wxLoginCode();
  const r = await send('POST', '/v1/login', { code }, null);
  const d = (r.data || {}) as Partial<Session>;
  if (!ok(r) || typeof d.token !== 'string' || typeof d.expiresAt !== 'string') throw errorOf(r);
  try {
    wx.setStorageSync(SESSION_KEY, { token: d.token, expiresAt: d.expiresAt });
  } catch {
    // 存不了：这次照用，下次再登录
  }
  return d.token;
}

let logging: Promise<string> | null = null;

/** 网关会话：本机有就用，没有就登录（同时只登录一次） */
export function ensureSession(): Promise<string> {
  const s = readSession();
  if (s) return Promise.resolve(s.token);
  if (!logging) {
    logging = login().then(
      (t) => {
        logging = null;
        return t;
      },
      (e) => {
        logging = null;
        throw e;
      },
    );
  }
  return logging;
}

/** 会员相关的接口：带网关会话；会话失效时重新登录、重发一次 */
export async function member<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
  let r = await send(method, path, body, await ensureSession());
  if (r.status === 401 && errorOf(r).code === 'SESSION_REQUIRED') {
    clearSession();
    r = await send(method, path, body, await ensureSession());
  }
  if (ok(r)) return r.data as T;
  throw errorOf(r);
}

// ── 展示内容 ──

export interface Shown<T> {
  data: T;
  /** 门店连不上时给的是之前的信息（网关缓存或本机存的） */
  stale: boolean;
}

const CACHE_PREFIX = 'tq_show:';
const CACHE_DAYS = 7;

function readCache<T>(path: string): T | null {
  try {
    const c = wx.getStorageSync(CACHE_PREFIX + path) as { at: number; data: T } | '';
    if (c && typeof c.at === 'number' && Date.now() - c.at < CACHE_DAYS * 86400 * 1000) return c.data;
  } catch {
    // 读不了当没有
  }
  return null;
}

/** 门店信息、价目、导览：不用登录 */
export async function show<T>(path: string): Promise<Shown<T>> {
  try {
    const r = await send('GET', path, undefined, null);
    if (!ok(r)) throw errorOf(r);
    try {
      wx.setStorageSync(CACHE_PREFIX + path, { at: Date.now(), data: r.data });
    } catch {
      // 太大或存不了：只是下次断网时没有旧的
    }
    return { data: r.data as T, stale: r.cache === 'stale' };
  } catch (e) {
    if (isOffline(e)) {
      const cached = readCache<T>(path);
      if (cached) return { data: cached, stale: true };
    }
    throw e;
  }
}

/** 网关上的图片（门店、轮播、项目介绍） */
export function imageUrl(id: number): string {
  return gatewayBase() + '/v1/images/' + id;
}
