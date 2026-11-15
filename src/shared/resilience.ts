// 网络波动防护（8.1.3，docs/RESILIENCE_V813.md）：页面与服务器共用的格式与常量。

/** GET /api/ping：页面问「连不连得上」（不查数据库、不读会话） */
export interface PingReply {
  ok: true;
  version: string;
  commit: string;
  instance: string;
  /** 服务器上这一版页面的入口文件（/assets/index-xxxx.js）；开发模式、没有构建产物时为空 */
  client: string | null;
  time: string;
}

/** 页面报上来的错误（服务器内存里留最近 200 条，重启清空） */
export interface ClientErrorRecord {
  id: number;
  at: string;
  kind: 'render' | 'chunk' | 'error' | 'rejection';
  message: string;
  stack: string | null;
  /** 出错的页面地址（不带查询参数） */
  path: string;
  /** 那一页的入口文件：和服务器上的不一样说明是更新前打开的旧页面 */
  entry: string | null;
  userAgent: string;
  ip: string;
  staff: { id: number; name: string } | null;
}

/**
 * 服务器明确没有处理的拒绝（8.1.3 WL5）：都发生在处理之前或事务已经回滚，页面原样（同一个操作编号）自动重发。
 * BUSY：等锁超时、语句超时、死锁、串行化冲突；RATE_LIMITED：请求太频繁；OVERLOADED：系统正忙（过载保护）。
 */
export const NOT_APPLIED_CODES = ['BUSY', 'RATE_LIMITED', 'OVERLOADED'] as const;
export type NotAppliedCode = (typeof NOT_APPLIED_CODES)[number];
