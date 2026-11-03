// 事务里的通用小工具（原来放在库存模块里、被十几个模块借用；v0.7.22 代码整理时移到这里）。

import type { Tx } from '../db';

/** 限制等待时间：页面 15 秒超时之前，这笔操作要么已提交、要么已回滚，查回的结果才可信 */
export async function setTxTimeouts(tx: Tx) {
  await tx.unsafe("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s'");
}

/** 单号：前缀 + 单据日期 + 当日流水号，例如 RK20261020-0001（按单据种类与日期各自从 1 起） */
export async function nextDocNo(tx: Tx, kind: string, prefix: string, date: string): Promise<string> {
  const [row] = await tx<{ lastNo: number }[]>`
    INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES (${kind}, ${date}, 1)
    ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no + 1
    RETURNING last_no`;
  return `${prefix}${date.replaceAll('-', '')}-${String(row!.lastNo).padStart(4, '0')}`;
}
