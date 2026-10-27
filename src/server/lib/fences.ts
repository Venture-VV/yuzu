// 「确认作废」登记（op_fences）：操作编号 + 声明的业务类型 + 经办人。
//
// 串行：登记作废与「原请求写入操作编号」都先按编号取事务级咨询锁，二者不会交错。
//   · 作废先登记：原请求写编号前发现同一类型的作废登记 → 整笔回滚（OP_ABANDONED）；
//   · 原请求先写编号：作废等它提交后看到编号已有结果 → 只返回查回结果，不作废。
// 只认「声明类型 = 原请求真实类型」的登记：伪报类型或从别的模块作废，都拦不下原请求；
// 作废接口按声明的类型检查权限，所以能让作废生效的人，必须具备这项业务本身的权限。

import type { Db, Tx } from '../db';

export const FENCED_OPS = ['recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap'] as const;
export type FencedOp = (typeof FENCED_OPS)[number];

const lockKey = (tx: Tx, key: string) => tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

/** 是否已有给定类型之一的作废登记（只读，不加锁） */
export async function isFenced(db: Db, key: string, opTypes: readonly FencedOp[]): Promise<boolean> {
  const [row] = await db<{ hit: number }[]>`SELECT 1 AS hit FROM op_fences WHERE key = ${key} AND op_type IN ${db(opTypes)}`;
  return !!row;
}

/** 原请求写入操作编号之前调用：与登记作废串行，并确认这笔没有被作废（同一类型） */
export async function assertNotFenced(tx: Tx, key: string, opType: FencedOp, abandoned: () => Error) {
  await lockKey(tx, key);
  if (await isFenced(tx, key, [opType])) throw abandoned();
}

/**
 * 登记作废（在调用方的事务里，与原请求写编号串行）。
 * 编号已有结果时返回 { existingOpType }，由调用方查回；否则登记（重复登记不报错）。
 */
export async function fenceKey(
  tx: Tx,
  key: string,
  opType: FencedOp,
  staffId: number,
): Promise<{ existingOpType: string } | { inserted: boolean }> {
  await lockKey(tx, key);
  const [existing] = await tx<{ opType: string }[]>`SELECT op_type FROM idempotency_keys WHERE key = ${key}`;
  if (existing) return { existingOpType: existing.opType };
  const rows = await tx`
    INSERT INTO op_fences (key, op_type, staff_id) VALUES (${key}, ${opType}, ${staffId})
    ON CONFLICT (key, op_type) DO NOTHING RETURNING key`;
  return { inserted: rows.length > 0 };
}
