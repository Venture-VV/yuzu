// 解绑满 3 年清除（小程序线，MP16，docs/MP_PRIVACY.md：绑定期间保存，解绑后再保存 3 年，期满删除）。
//   · 绑定记录解绑满 3 年：去掉手机号与微信标识（openid），解绑原因换成固定的一句（原因是员工写的，可能写了手机号），记下清除时间；
//     记录本身留着：线上充值单、领券记录、到期提醒的同意都引用它，会员档案与储值是门店的账目，按账目的规定保存；
//   · 同一条绑定下的线上充值单、领券记录、到期提醒的同意：去掉 openid；
//   · 「结果待确认」的作废登记（只在当时有用）满 3 年的删掉。
// 一条绑定一个事务：先锁绑定记录一行，再清它下面的几张表（各表的触发器只放开这一种改法）。小程序端口每小时看一次。

import type { Deps } from '../../lib/context';
import { setTxTimeouts } from '../../lib/tx';

/** 清除以后解绑原因写这一句（触发器也认这一句） */
export const PURGED_REASON = '解绑满 3 年，已清除';

export async function purgeOldBindings(deps: Deps, at: Date = new Date(), limit = 200): Promise<{ bindings: number; fences: number }> {
  const due = await deps.sql<{ id: number }[]>`
    SELECT id FROM mp_bindings
    WHERE unbound_at IS NOT NULL AND purged_at IS NULL AND unbound_at <= ${at}::timestamptz - interval '3 years'
    ORDER BY unbound_at, id LIMIT ${limit}`;
  let bindings = 0;
  for (const { id } of due) {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [b] = await tx<{ id: number }[]>`SELECT id FROM mp_bindings WHERE id = ${id} AND purged_at IS NULL FOR UPDATE`;
      if (!b) return;
      await tx`UPDATE mp_bindings SET openid = NULL, phone = NULL, unbind_reason = ${PURGED_REASON}, purged_at = ${at} WHERE id = ${id}`;
      await tx`UPDATE mp_recharge_orders SET openid = NULL WHERE binding_id = ${id} AND openid IS NOT NULL`;
      await tx`UPDATE mp_coupon_claims SET openid = NULL WHERE binding_id = ${id} AND openid IS NOT NULL`;
      await tx`UPDATE mp_reminder_consents SET openid = NULL WHERE binding_id = ${id} AND openid IS NOT NULL`;
      bindings += 1;
    });
  }
  const fences = await deps.sql`DELETE FROM mp_op_fences WHERE created_at <= ${at}::timestamptz - interval '3 years'`;
  return { bindings, fences: fences.count };
}
