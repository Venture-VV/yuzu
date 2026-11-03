// 展示内容的缓存：门店信息、价目、导览、图片。新鲜的直接给；门店断外网时给旧的（最多 7 天），小程序照常能看。
// 按写入顺序淘汰，总大小有上限（图片占大头）。

import type { UpstreamResponse } from './upstream';

interface Entry {
  value: UpstreamResponse;
  freshUntil: number;
  staleUntil: number;
}

export class ShowCache {
  private readonly map = new Map<string, Entry>();
  private bytes = 0;
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  get(key: string, now = Date.now()): { value: UpstreamResponse; fresh: boolean } | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.staleUntil <= now) {
      this.delete(key);
      return null;
    }
    return { value: e.value, fresh: e.freshUntil > now };
  }

  set(key: string, value: UpstreamResponse, freshMs: number, staleMs = 7 * 86_400_000, now = Date.now()) {
    if (value.body.length > this.maxBytes) return;
    this.delete(key);
    this.map.set(key, { value, freshUntil: now + freshMs, staleUntil: now + staleMs });
    this.bytes += value.body.length;
    for (const k of this.map.keys()) {
      if (this.bytes <= this.maxBytes) break;
      this.delete(k);
    }
  }

  private delete(key: string) {
    const e = this.map.get(key);
    if (!e) return;
    this.bytes -= e.value.body.length;
    this.map.delete(key);
  }
}
