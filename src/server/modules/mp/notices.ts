// 会员端提醒（RQ-014，接主线 8.0.4 批量发券的「会员端弹窗」，docs/MEMBERSHIP_V804.md 第 6 节；弹的时机按 HY16，待确认）：
// 小程序首页打开时弹出这位会员今天要看的提醒，看过记已读。读写都用主线 member-notices.ts 的两个函数，小程序线不另写一份：
//   · 列表 listMemberNotices(db, 会员, 门店营业日)：没读过、在显示的日子里、券还能用的，新的在前，最多 20 条；
//   · 已读 markMemberNoticeRead(db, 会员, 编号)：只记这位会员自己的、没读过的那一条，只记一次（只锁那一条）。
//
// 会员按这个微信此刻有效的绑定，读绑定与读、记提醒在同一个事务里、拿着这个微信绑定状态那把锁（`mp_bind:<openid>`）的共享模式
// （绑定、解绑、换绑拿排他的，与充值建单、领券同一个做法）：请求先拿到锁的，解绑、换绑等它做完；解绑、换绑先拿到的，请求等它提交、
// 读到的是之后的绑定（小程序线测试 29aa0cc 的 P1：原来先单独读绑定，等锁期间换绑了，仍按旧会员读、记）。
//   · 列表带回这一刻的绑定状态版本号：小程序丢掉比它见过的更旧的回答（换绑以前发出去、换绑以后才回来的）；
//   · 记已读要带看到提醒时的版本号：之后解绑、换绑过（版本号变了）的拒绝（BIND_STALE），旧会员的提醒照旧没读；
//     主线函数再按会员核对编号，别的会员的编号记不上。原样重提、同时重提、断网后补发都只记一次。
// 现有的微信订阅消息（3a 到期提醒）是另一套，不在这里。

import { z } from 'zod';
import { MP_NOTICE_READ_MAX, type MpNoticeRead, type MpNotices } from '@shared/mp';
import type { Deps } from '../../lib/context';
import { AppError, conflict } from '../../lib/errors';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { listMemberNotices, markMemberNoticeRead } from '../member-notices';
import { bindingStateOf, lockOpenidShared } from './member';
import { mpToday } from './public';

export async function getNotices(deps: Deps, openid: string): Promise<MpNotices> {
  const today = await mpToday(deps.sql, deps.config.timezone);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpenidShared(tx, openid);
    const { binding, version } = await bindingStateOf(tx, openid);
    if (!binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
    const rows = await listMemberNotices(tx, binding.memberId, today);
    return { notices: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body })), bindVersion: version };
  });
}

const ReadInput = z.object({
  ids: z
    .array(z.number('提醒的编号不正确').int('提醒的编号不正确').positive('提醒的编号不正确').max(Number.MAX_SAFE_INTEGER), '缺少要记已读的提醒')
    .min(1, '缺少要记已读的提醒')
    .max(MP_NOTICE_READ_MAX, `一次最多记 ${MP_NOTICE_READ_MAX} 条`)
    .refine((ids) => new Set(ids).size === ids.length, '提醒的编号重复了'),
  bindVersion: z.number('请刷新后再试').int('请刷新后再试').min(0, '请刷新后再试'),
});

/** 记已读：在绑定状态的共享锁里核对版本号，再一条一条记（每条只锁那一条）；中途断了小程序原样重提，已经记过的不再记 */
export async function readNotices(deps: Deps, openid: string, raw: unknown): Promise<MpNoticeRead> {
  const { ids, bindVersion } = parse(ReadInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpenidShared(tx, openid);
    const { binding, version } = await bindingStateOf(tx, openid);
    if (!binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
    if (version !== bindVersion) throw conflict('BIND_STALE', '会员绑定刚变过，这几条提醒没有记成已读');
    const read: number[] = [];
    for (const id of ids) if (await markMemberNoticeRead(tx, binding.memberId, id)) read.push(id);
    return { read };
  });
}
