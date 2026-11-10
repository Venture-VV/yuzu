// 会员端提醒（RQ-014，接主线 8.0.4 批量发券的「会员端弹窗」，docs/MEMBERSHIP_V804.md 第 6 节；弹的时机按 HY16，待确认）：
// 小程序首页打开时弹出这位会员今天要看的提醒，看过记已读。读写都用主线 member-notices.ts 的两个函数，小程序线不另写一份：
//   · 列表 listMemberNotices(db, 会员, 门店营业日)：没读过、在显示的日子里、券还能用的，新的在前，最多 20 条；
//   · 已读 markMemberNoticeRead(db, 会员, 编号)：只记这位会员自己的、没读过的那一条，只记一次（只锁那一条）。
// 会员按这个微信此刻有效的绑定：没绑定的不能看、不能记；解绑、换绑到别的会员以后，之前那位会员的提醒编号记不上
// （主线函数按会员核对），所以原样重提、断网后重试、解绑 / 换绑以后晚到的请求都串不到别的会员。
// 现有的微信订阅消息（3a 到期提醒）是另一套，不在这里。

import { z } from 'zod';
import { MP_NOTICE_READ_MAX, type MpNoticeRead, type MpNotices } from '@shared/mp';
import type { Deps } from '../../lib/context';
import { parse } from '../../lib/validate';
import { listMemberNotices, markMemberNoticeRead } from '../member-notices';
import { boundMemberId } from './member';
import { mpToday } from './public';

export async function getNotices(deps: Deps, openid: string): Promise<MpNotices> {
  const memberId = await boundMemberId(deps.sql, openid);
  const today = await mpToday(deps.sql, deps.config.timezone);
  const rows = await listMemberNotices(deps.sql, memberId, today);
  return { notices: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body })) };
}

const ReadInput = z.object({
  ids: z
    .array(z.number('提醒的编号不正确').int('提醒的编号不正确').positive('提醒的编号不正确').max(Number.MAX_SAFE_INTEGER), '缺少要记已读的提醒')
    .min(1, '缺少要记已读的提醒')
    .max(MP_NOTICE_READ_MAX, `一次最多记 ${MP_NOTICE_READ_MAX} 条`)
    .refine((ids) => new Set(ids).size === ids.length, '提醒的编号重复了'),
});

/** 记已读：一条一条记（每条只锁那一条、各自提交），中途断了小程序原样重提，已经记过的不再记 */
export async function readNotices(deps: Deps, openid: string, raw: unknown): Promise<MpNoticeRead> {
  const { ids } = parse(ReadInput, raw);
  const memberId = await boundMemberId(deps.sql, openid);
  const read: number[] = [];
  for (const id of ids) if (await markMemberNoticeRead(deps.sql, memberId, id)) read.push(id);
  return { read };
}
