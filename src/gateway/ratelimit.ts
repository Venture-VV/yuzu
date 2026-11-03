// 简单限流（单个网关进程、内存里）：每个键每分钟最多 n 次。

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; until: number }>();
  constructor(private readonly perMinute: number) {}

  /** 还没超过限额返回 true，并记一次 */
  take(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.until <= now) {
      this.hits.set(key, { count: 1, until: now + 60_000 });
      if (this.hits.size > 50_000) this.sweep(now);
      return true;
    }
    if (h.count >= this.perMinute) return false;
    h.count += 1;
    return true;
  }

  private sweep(now: number) {
    for (const [k, h] of this.hits) if (h.until <= now) this.hits.delete(k);
  }
}
