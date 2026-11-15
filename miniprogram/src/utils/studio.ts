// 工作台 · 小程序已发布版面的拉取、本机缓存与前台刷新（8.1.2，docs/STUDIO_MP.md 第 5、6 节）。
//   · 设计师可以「定时发布」：到点前读到旧版，到点后读到新版；因此每次进页面（Page.onShow）、回到前台（wx.onAppShow）都重新问一次 /v1/studio；
//   · id 不变时版面内容不变（只追加），沿用已解析的版面、不重复触发 setData 闪烁；id 变了（含首次发布、定时到点、撤销回退、全撤回 null）立即通知当前页面重画；
//   · 网络或门店系统不通时回退本机最近 7 天存下的有效版面；本机也没有或格式不认识时返回 null，页面照旧画原来的样子。

import type { MpStudioDoc, MpStudioResponse } from '../../../src/shared/mp';
import { gatewayBase } from '../config/env';
import { buildThemeStyle, validateMpStudioDoc } from './studio-style';

export interface ActiveMpStudio {
  id: number;
  version: number;
  doc: MpStudioDoc;
  themeStyle: string;
}

interface StoredStudio {
  at: number;
  id: number;
  version: number;
  doc: MpStudioDoc;
}

const STORAGE_KEY = 'tq_studio_mp';
const CACHE_MAX_MS = 7 * 86400 * 1000;

let loadedFromStorage = false;
let current: ActiveMpStudio | null = null;
let inflight: Promise<ActiveMpStudio | null> | null = null;
let inflightAt = 0;
let refetchAfter = false;
const watchers: ((studio: ActiveMpStudio | null) => void)[] = [];

function readStoredStudio(): ActiveMpStudio | null {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY) as StoredStudio | '';
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.at !== 'number' || Date.now() - raw.at >= CACHE_MAX_MS) return null;
    if (typeof raw.id !== 'number' || typeof raw.version !== 'number') return null;
    const doc = validateMpStudioDoc(raw.doc);
    if (!doc) return null;
    return { id: raw.id, version: raw.version, doc, themeStyle: buildThemeStyle(doc.theme) };
  } catch {
    return null;
  }
}

function writeStoredStudio(next: ActiveMpStudio | null, at: number): void {
  try {
    if (!next) wx.removeStorageSync(STORAGE_KEY);
    else wx.setStorageSync(STORAGE_KEY, { at, id: next.id, version: next.version, doc: next.doc });
  } catch {
    // 存储写不下时本次内存照用
  }
}

function ensureInitialLoaded(): void {
  if (loadedFromStorage) return;
  loadedFromStorage = true;
  current = readStoredStudio();
}

function notifyWatchers(): void {
  const snap = current;
  const copy = watchers.slice();
  for (let i = 0; i < copy.length; i++) {
    try {
      copy[i]!(snap);
    } catch {
      // 单个页面出错不影响别的监听者
    }
  }
}

function fetchStudioRaw(): Promise<{ status: number; data: unknown; cache: string; fetchedAt: string }> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: gatewayBase() + '/v1/studio',
      method: 'GET',
      header: { 'content-type': 'application/json' },
      timeout: 8000,
      success: (res) => {
        const h = (res.header || {}) as Record<string, string>;
        resolve({
          status: res.statusCode,
          data: res.data,
          cache: h['x-cache'] || h['X-Cache'] || '',
          fetchedAt: h['x-fetched-at'] || h['X-Fetched-At'] || '',
        });
      },
      fail: (err) => reject(err),
    });
  });
}

/** 版面里用到的素材地址（SHA-256 64 位十六进制） */
export function studioAssetUrl(assetId: string): string {
  return gatewayBase() + '/v1/studio/assets/' + assetId;
}

/** 当前内存或本机缓存里生效的版面（同步，首次渲染不白屏） */
export function currentStudio(): ActiveMpStudio | null {
  ensureInitialLoaded();
  return current;
}

/** 当前主题的 CSS 变量串 */
export function currentThemeStyle(): string {
  const s = currentStudio();
  return s ? s.themeStyle : '';
}

/** 订阅版面变化（id 改变或从有变无时触发） */
export function watchStudio(fn: (studio: ActiveMpStudio | null) => void): () => void {
  ensureInitialLoaded();
  watchers.push(fn);
  return () => {
    const idx = watchers.indexOf(fn);
    if (idx >= 0) watchers.splice(idx, 1);
  };
}

async function doRefresh(): Promise<ActiveMpStudio | null> {
  ensureInitialLoaded();
  try {
    const res = await fetchStudioRaw();
    if (res.status < 200 || res.status >= 300 || !res.data || typeof res.data !== 'object') {
      return current;
    }
    const body = res.data as Partial<MpStudioResponse>;
    if (!('layout' in body)) return current;

    const prevId = current ? current.id : null;
    if (body.layout === null) {
      current = null;
      writeStoredStudio(null, 0);
      if (prevId !== null) notifyWatchers();
      return null;
    }

    const rawLayout = body.layout;
    if (!rawLayout || typeof rawLayout !== 'object' || typeof rawLayout.id !== 'number') {
      return current;
    }

    const fetchedMs = Date.parse(res.fetchedAt);
    const savedAt = res.cache === 'stale' && isFinite(fetchedMs) ? fetchedMs : Date.now();
    if (Date.now() - savedAt >= CACHE_MAX_MS) {
      return current;
    }

    // id 没变：内容按约定不变，直接复用内存里已校验过的 doc，不触发多余重绘
    if (current && current.id === rawLayout.id) {
      if (res.cache !== 'stale') writeStoredStudio(current, savedAt);
      return current;
    }

    const doc = validateMpStudioDoc(rawLayout.doc);
    if (!doc) {
      // schema 不认识或格式坏了：照第 6 节回退原来的页面，不把坏版面存进缓存
      current = null;
      if (prevId !== null) notifyWatchers();
      return null;
    }

    const next: ActiveMpStudio = {
      id: rawLayout.id,
      version: typeof rawLayout.version === 'number' ? rawLayout.version : 1,
      doc,
      themeStyle: buildThemeStyle(doc.theme),
    };
    current = next;
    writeStoredStudio(next, savedAt);
    if (prevId !== next.id) notifyWatchers();
    return next;
  } catch {
    // 断网或网关不通：用内存或本机 7 天内的旧版面；都没有就是 null
    return current;
  }
}

/**
 * 重新向网关取一次当前已发布的版面：每次进页面（onShow）、回到前台（wx.onAppShow）都调它，确保定时发布到点立即切换。
 * 同一刻（50ms 内，如 wx.onAppShow 与 Page.onShow 同时触发）共用同一个请求；慢请求飞行途中又有新的页面进入时，等这一轮回来立刻补问一次。
 */
export function refreshStudio(): Promise<ActiveMpStudio | null> {
  ensureInitialLoaded();
  const now = Date.now();
  if (inflight) {
    if (now - inflightAt >= 50) refetchAfter = true;
    return inflight;
  }
  inflightAt = now;
  inflight = doRefresh().finally(() => {
    inflight = null;
    if (refetchAfter) {
      refetchAfter = false;
      refreshStudio().catch(() => undefined);
    }
  });
  return inflight;
}

/** 给 Page 自动挂上主题变量与进页刷新（不开放结构的页面也跟主题走，且进任何一页都刷新定时发布） */
export function installStudioPageHook(): void {
  const rawPage = Page;
  Page = ((options: Record<string, unknown>) => {
    const origLoad = typeof options.onLoad === 'function' ? (options.onLoad as (...a: unknown[]) => void) : null;
    const origShow = typeof options.onShow === 'function' ? (options.onShow as (...a: unknown[]) => void) : null;
    const origUnload = typeof options.onUnload === 'function' ? (options.onUnload as (...a: unknown[]) => void) : null;
    const data = options.data && typeof options.data === 'object' ? (options.data as Record<string, unknown>) : {};
    if (!('themeStyle' in data)) data.themeStyle = '';
    options.data = data;

    options.onLoad = function (this: { data: Record<string, unknown>; setData: (d: Record<string, unknown>) => void; __stopStudioTheme?: (() => void) | null }, ...args: unknown[]) {
      const apply = (s: ActiveMpStudio | null) => {
        const nextStyle = s ? s.themeStyle : '';
        if (this.data && this.data.themeStyle !== nextStyle) this.setData({ themeStyle: nextStyle });
      };
      apply(currentStudio());
      this.__stopStudioTheme = watchStudio(apply);
      if (origLoad) origLoad.apply(this, args);
    };

    options.onShow = function (this: unknown, ...args: unknown[]) {
      refreshStudio().catch(() => undefined);
      if (origShow) origShow.apply(this, args);
    };

    options.onUnload = function (this: { __stopStudioTheme?: (() => void) | null }, ...args: unknown[]) {
      if (this.__stopStudioTheme) {
        this.__stopStudioTheme();
        this.__stopStudioTheme = null;
      }
      if (origUnload) origUnload.apply(this, args);
    };

    return rawPage(options as WechatMiniprogram.Page.Options<WechatMiniprogram.Page.DataOption, WechatMiniprogram.Page.CustomOption>);
  }) as typeof Page;
}
