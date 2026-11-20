// 8.1.17 退主菜带加料（BW8，docs/DISHES_V8117.md 第 4 节）：退一道主菜时，页面问「它的加料一起退吗」（默认勾上），
// 勾上的请求带 withAddons——在同一个事务里把挂在这一行主菜上、还没退的加料（bill_lines.addon_of，下单时记下的）一起退。
//
// 只在手牌（前台作废明细）与桌台的退菜里各加两句（锁加料行、退加料行），退菜原来的核对一行不改：
//   · 锁：主菜那一行锁住以后，按 id 升序锁它没退的加料行（同一张账单；来访 / 开台、账单调用方已锁），
//     之后每一行照旧：明细 → 出品单 → 沽清（cancelKitchenItem）；
//   · 授权：每一行加料照退菜原来的核对（authorizeLineVoid：小额直接退、经理、本人规定分钟内……出品口的退菜权限也在它里面）；
//     这一行要当场授权的，照主菜的授权——主菜用了当场授权（授权弹窗里写着连同加料）就算同一次授权；主菜不用授权（小额、本人、经理）
//     而这一行加料要的，整笔拒绝（ADDON_NEEDS_GRANT）：小额的主菜申请不到授权，请先只退主菜（不勾「加料一起退」），再单独退这份加料；
//   · 原因、责任岗位照主菜的；每一行各记一条退菜的审计（detail 带 addonOf = 主菜那一行），台账上照样写怎么批的。

import { z } from 'zod';
import type { Db, Tx } from '../db';
import { writeAudit, type AuditAction } from '../lib/audit';
import type { Actor } from '../lib/context';
import { formatYuan } from '@shared/money';
import { AppError } from '../lib/errors';
import { cancelKitchenItem } from './dining';
import { authorizeLineVoid, type VoidApproval } from './dining-808';

/**
 * 还没上的菜（点单页、桌台详情）每一道带上挂在它上面、还没退的加料（不管上没上），退菜弹窗问「加料一起退吗」用。
 * 写在查询里的一列，账单明细的别名要是 l
 */
export const pendingAddonsColumn = (db: Db) => db`
  coalesce((SELECT json_agg(json_build_object('billLineId', a.id, 'name', a.name, 'quantity', a.quantity, 'amount', a.amount) ORDER BY a.id)
            FROM bill_lines a WHERE a.addon_of = l.id AND a.status = 'active'), '[]'::json) AS addons`;

/** 退菜请求多一项：连同这道菜的加料一起退（不带当不一起退，与升级前一样） */
export const WithAddonsField = z.boolean('「加料一起退」的写法不对').optional();

export interface AddonLine {
  id: number;
  name: string;
  source: string;
  quantity: number;
  amount: number;
  status: string;
  postedBy: number;
  postedAt: string;
}

/** 主菜那一行锁住以后：按 id 升序锁挂在它上面、还没退的加料行 */
export async function lockAddonLines(tx: Tx, mainLineId: number): Promise<AddonLine[]> {
  return tx<AddonLine[]>`
    SELECT id, name, source, quantity, amount, status, posted_by, posted_at FROM bill_lines
    WHERE addon_of = ${mainLineId} AND status = 'active' ORDER BY id FOR UPDATE`;
}

/**
 * 把锁住的加料行一起退（主菜已经退好、审计已经记了）：照主菜的原因、授权，账单冲减、出品单改已退、沽清加回，各记一条审计。
 * 返回一起退了几行、多少钱
 */
export async function voidAddonLines(
  tx: Tx,
  addons: AddonLine[],
  opts: {
    billId: number;
    main: { id: number; name: string; amount: number };
    mainApproval: VoidApproval;
    reason: string;
    actor: Actor;
    at: Date;
    businessDate: string;
    ip?: string;
    audit: { action: Extract<AuditAction, 'frontdesk_void' | 'table_void'>; targetType: string; targetId: number; detail: Record<string, unknown> };
  },
): Promise<{ count: number; amount: number }> {
  // 主菜用了当场授权的，加料照这一次授权（授权弹窗里写着连同加料一起退）
  const shared: VoidApproval | null = opts.mainApproval.approval === 'grant' ? opts.mainApproval : null;
  for (const a of addons) {
    let approval: VoidApproval;
    try {
      approval = await authorizeLineVoid(tx, { line: a, actor: opts.actor, at: opts.at, what: `加料「${a.name}」` });
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'VOID_NEEDS_GRANT')) throw e;
      if (!shared) {
        throw new AppError(
          403,
          'ADDON_NEEDS_GRANT',
          `加料「${a.name}」${formatYuan(Number(a.amount))}要请值班经理及以上当场授权才能退：请不勾「加料一起退」，先退「${opts.main.name}」，再单独退这份加料`,
        );
      }
      approval = shared;
    }
    await tx`
      UPDATE bill_lines SET status = 'voided', void_reason = ${opts.reason}, voided_by = ${opts.actor.id}, voided_at = ${opts.at} WHERE id = ${a.id}`;
    await tx`UPDATE bills SET amount_cents = amount_cents - ${a.amount}, line_count = line_count - 1 WHERE id = ${opts.billId}`;
    await cancelKitchenItem(tx, a.id, `退菜：${opts.reason}`, opts.actor, opts.at);
    await writeAudit(tx, {
      staffId: opts.actor.id,
      action: opts.audit.action,
      targetType: opts.audit.targetType,
      targetId: opts.audit.targetId,
      detail: { ...opts.audit.detail, lineId: a.id, name: a.name, quantity: a.quantity, amount: a.amount, reason: opts.reason, addonOf: opts.main.id, ...approval },
      ip: opts.ip,
      businessDate: opts.businessDate,
    });
  }
  return { count: addons.length, amount: addons.reduce((s, a) => s + a.amount, 0) };
}
