// 小程序第三期 3b：邀请好友（小程序线，docs/MP_PHASE3.md 第 2 节；MP30、MP31）。主线 v0.7.28 的 createTrialInviteFromMp 建临时身份。
//   · 设置（settings 的 mp_invite_rules，带版本号）：开关，后台「微信小程序 → 邀请好友」维护（权限 mp.invite）；
//   · 邀请人：能不能邀请、好友能体验的档阶（主线的 trialOptions），发出去的邀请；发一个邀请码（7 天内有效，MP30）、收回。
//     发出去还没人领、还在有效期里的占着本月的次数，收回、过期的退回；
//   · 好友：打开分享卡片看邀请；用微信手机号快速验证领取（网关换手机号，同绑定一样）——主线照前台的「邀请体验」建临时身份，
//     好友还不是会员的当场建档（渠道「老带新」）；这个微信还没绑定的顺带绑上这位会员（会员已经绑了别的微信的不绑）。
//     领取在一个事务里：这个码的咨询锁（与收回串行）→ 这个微信的绑定锁（排他，可能要绑定）→ 作废登记 → 核对绑定版本号 →
//     邀请码一行 → 主线的入口（它自己的编号锁 → 两位会员一行）→ 绑定记录 → 记下领取。结果不确定时请门店系统确认作废这个编号。
// 不动钱；赠送会籍（QY-042）先不放进小程序（MP31）。

import { randomInt } from 'node:crypto';
import { z } from 'zod';
import {
  MP_INVITE_CODE,
  MP_INVITE_RULES_KEY,
  MP_INVITE_VALID_DAYS,
  type MpInviteAbandonResult,
  type MpInviteAdmin,
  type MpInviteAdminData,
  type MpInviteClaimed,
  type MpInviteCreated,
  type MpInviteHome,
  type MpInviteItem,
  type MpInviteRules,
  type MpInviteState,
  type MpInviteTrial,
  type MpInviteView,
} from '@shared/mp';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import type { Deps, OpContext } from '../../lib/context';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { getTrial, trialOptions } from '../member-trials';
import { createTrialInviteFromMp } from '../mp-entries';
import { bindingStateOf, lockOpenid, lockOpenidShared } from './member';
import { mpToday } from './public';
import { loadInviteRules } from './rules';

// ───────────────────────── 小工具 ─────────────────────────

const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => Array.from({ length: 10 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

/** 名字只露第一个字：「王*」 */
const maskName = (name: string | null | undefined) => {
  const chars = [...(name ?? '').trim()];
  return chars.length ? `${chars[0]}*` : '会员';
};

const stateOf = (status: string, expiresAt: string | Date, now = Date.now()): MpInviteState =>
  status === 'open' && new Date(expiresAt).getTime() <= now ? 'expired' : (status as MpInviteState);

/** 发起、收回的咨询锁：同一个微信的发起串行（数还没人领的邀请不会两次都过） */
const lockInviter = (tx: Tx, openid: string) => tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_invite:${openid}`}))`;
/** 同一个码的领取与收回串行 */
const lockCode = (tx: Tx, code: string) => tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_invite_code:${code}`}))`;

interface InviteRow {
  id: number;
  code: string;
  clientKey: string;
  inviterMemberId: number;
  inviterBindingId: number;
  label: string;
  createdAt: string;
  expiresAt: string;
  status: 'open' | 'used' | 'revoked';
  claimClientKey: string | null;
  inviteeMemberId: number | null;
  inviteeBindingId: number | null;
  trialId: number | null;
  usedAt: string | null;
}

async function trialOf(db: Db, trialId: number): Promise<MpInviteTrial> {
  const t = await getTrial(db, trialId);
  return { label: t.label, startsOn: t.startsOn, endsOn: t.endsOn, status: t.status };
}

/** 这位会员（邀请人）还没人领、还在有效期里的邀请有几份 */
async function pendingOf(db: Db, memberId: number): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM mp_invites WHERE inviter_member_id = ${memberId} AND status = 'open' AND expires_at > now()`;
  return r?.n ?? 0;
}

/** 会员卡能不能用来邀请、领取（合并掉的、停用的不行） */
async function memberProblem(db: Db, memberId: number): Promise<string | null> {
  const [m] = await db<{ status: string; mergedIntoId: number | null }[]>`SELECT status, merged_into_id FROM members WHERE id = ${memberId}`;
  if (!m) return '会员不存在';
  if (m.mergedIntoId !== null) return '这张会员卡已合并，请到前台换绑';
  if (m.status !== 'active') return '会员卡已停用，请到前台咨询';
  return null;
}

// ───────────────────────── 设置 ─────────────────────────

const RulesInput = z.object({ enabled: z.boolean(), version: z.number().int().min(0).optional() });

export async function saveInviteRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<MpInviteRules> {
  const input = parse(RulesInput, raw);
  return saveRuleSetting(
    deps.sql,
    MP_INVITE_RULES_KEY,
    loadInviteRules,
    async (before) => {
      if (input.version !== undefined && input.version !== before.version) throw conflict('VERSION_CONFLICT', '邀请好友的设置刚被别人改过，请刷新后再改');
      return { enabled: input.enabled, version: before.version + 1 };
    },
    ctx,
  );
}

// ───────────────────────── 邀请人 ─────────────────────────

export async function inviteHome(deps: Deps, openid: string): Promise<MpInviteHome> {
  const [rules, state] = await Promise.all([loadInviteRules(deps.sql), bindingStateOf(deps.sql, openid)]);
  const closed = (notice: string): MpInviteHome => ({ open: false, notice, bindVersion: state.version, option: null, invites: [] });
  if (!rules.enabled) return closed('邀请好友还没开放');
  if (!state.binding) return closed('请先绑定会员');
  const memberId = state.binding.memberId;
  const problem = await memberProblem(deps.sql, memberId);
  if (problem) return closed(problem);
  const date = await mpToday(deps.sql, deps.config.timezone);
  const [opts, pending, rows] = await Promise.all([
    trialOptions(deps.sql, memberId, date),
    pendingOf(deps.sql, memberId),
    deps.sql<(InviteRow & { friendName: string | null })[]>`
      SELECT i.*, m.name AS friend_name FROM mp_invites i LEFT JOIN members m ON m.id = i.invitee_member_id
      WHERE i.inviter_member_id = ${memberId} ORDER BY i.id DESC LIMIT 20`,
  ]);
  const inv = opts.invite;
  const full = inv.limit !== null && inv.used + pending >= inv.limit;
  const invites: MpInviteItem[] = [];
  for (const r of rows) {
    invites.push({
      code: r.code,
      state: stateOf(r.status, r.expiresAt),
      label: r.label,
      createdAt: new Date(r.createdAt).toISOString(),
      expiresAt: new Date(r.expiresAt).toISOString(),
      friend: r.trialId ? { name: maskName(r.friendName), trial: await trialOf(deps.sql, Number(r.trialId)) } : null,
    });
  }
  return {
    open: true,
    notice: null,
    bindVersion: state.version,
    option: {
      allowed: inv.allowed && !full,
      reason: !inv.allowed ? inv.reason : full ? '这个月的邀请已经发出去了：好友还没领，可以收回再发' : null,
      label: inv.label,
      endsOn: inv.endsOn,
      used: inv.used,
      limit: inv.limit,
      limitText: inv.limitText,
      pending,
    },
    invites,
  };
}

const CreateInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  bindVersion: z.number('请刷新后再邀请').int().min(0),
});

export async function createInvite(deps: Deps, openid: string, raw: unknown): Promise<MpInviteCreated> {
  const input = parse(CreateInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockInviter(tx, openid);
    await lockOpenidShared(tx, openid);
    const state = await bindingStateOf(tx, openid);
    // 同一个编号重提先查（独立审查 3b/3c 的 P3）：发出去了、回答路上丢了，之后绑定又变过的，原样重提照样回那个码
    // （码在那位会员的邀请里、占着本月的次数，不能说成没发出）；只认同一个微信发的
    const [prev] = await tx<(InviteRow & { bindingOpenid: string | null })[]>`
      SELECT i.*, b.openid AS binding_openid FROM mp_invites i JOIN mp_bindings b ON b.id = i.inviter_binding_id WHERE i.client_key = ${input.clientKey}`;
    if (prev) {
      if (prev.bindingOpenid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次邀请的编号已经用过，请重新点');
      return { code: prev.code, label: prev.label, expiresAt: new Date(prev.expiresAt).toISOString(), replayed: true };
    }
    if (!state.binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
    if (state.version !== input.bindVersion) throw conflict('BIND_STALE', '会员绑定刚变过，这次没有发出邀请，请刷新后再点');
    const { id: bindingId, memberId } = state.binding;
    if (!(await loadInviteRules(tx)).enabled) throw new AppError(403, 'MP_INVITE_DISABLED', '邀请好友还没开放');
    const problem = await memberProblem(tx, memberId);
    if (problem) throw unprocessable('MEMBER_UNAVAILABLE', problem);
    const opts = await trialOptions(tx, memberId, await mpToday(tx, deps.config.timezone));
    const inv = opts.invite;
    if (!inv.allowed || !inv.label) throw unprocessable('INVITE_NOT_ALLOWED', inv.reason ?? '现在不能邀请');
    if (inv.limit !== null && inv.used + (await pendingOf(tx, memberId)) >= inv.limit) {
      throw unprocessable('INVITE_NOT_ALLOWED', '这个月的邀请已经发出去了：好友还没领，可以收回再发');
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const [row] = await tx.savepoint((sp) => sp<InviteRow[]>`
          INSERT INTO mp_invites (code, client_key, inviter_member_id, inviter_binding_id, label, expires_at)
          VALUES (${newCode()}, ${input.clientKey}, ${memberId}, ${bindingId}, ${inv.label}, now() + ${`${MP_INVITE_VALID_DAYS} days`}::interval)
          RETURNING *`);
        return { code: row!.code, label: row!.label, expiresAt: new Date(row!.expiresAt).toISOString(), replayed: false };
      } catch (error) {
        // 码撞了（十位、三十二个字，几乎不会）：换一个再试
        if (attempt < 3 && isUniqueViolation(error, 'mp_invites_code_key')) continue;
        throw error;
      }
    }
  });
}

/** 收回：只能收回自己发的、还没人领的；已经收回、过期的照样回现在的样子 */
export async function revokeInvite(deps: Deps, openid: string, code: string): Promise<MpInviteItem> {
  if (!MP_INVITE_CODE.test(code)) throw notFound('邀请不存在');
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockCode(tx, code);
    await lockOpenidShared(tx, openid);
    const state = await bindingStateOf(tx, openid);
    if (!state.binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
    const [r] = await tx<InviteRow[]>`SELECT * FROM mp_invites WHERE code = ${code} FOR UPDATE`;
    if (!r || Number(r.inviterMemberId) !== state.binding.memberId) throw notFound('邀请不存在');
    if (r.status === 'used') throw conflict('INVITE_USED', '好友已经领了，收不回来了');
    let row = r;
    if (r.status === 'open' && new Date(r.expiresAt).getTime() > Date.now()) {
      const [revoked] = await tx<InviteRow[]>`UPDATE mp_invites SET status = 'revoked', revoked_at = now() WHERE id = ${r.id} RETURNING *`;
      row = revoked!;
    }
    return { code: row.code, state: stateOf(row.status, row.expiresAt), label: row.label, createdAt: new Date(row.createdAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(), friend: null };
  });
}

// ───────────────────────── 好友 ─────────────────────────

export async function inviteView(deps: Deps, openid: string, code: string): Promise<MpInviteView> {
  if (!MP_INVITE_CODE.test(code)) throw notFound('邀请不存在');
  if (!(await loadInviteRules(deps.sql)).enabled) throw new AppError(403, 'MP_INVITE_DISABLED', '邀请好友还没开放');
  const [r] = await deps.sql<(InviteRow & { inviterName: string })[]>`
    SELECT i.*, m.name AS inviter_name FROM mp_invites i JOIN members m ON m.id = i.inviter_member_id WHERE i.code = ${code}`;
  if (!r) throw notFound('邀请不存在');
  const state = await bindingStateOf(deps.sql, openid);
  return {
    code: r.code,
    state: stateOf(r.status, r.expiresAt),
    inviterName: maskName(r.inviterName),
    label: r.label,
    expiresAt: new Date(r.expiresAt).toISOString(),
    mine: state.binding?.memberId === Number(r.inviterMemberId),
    bound: state.binding !== null,
    bindVersion: state.version,
  };
}

const ClaimInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  phone: z.string().regex(/^1\d{10}$/, '手机号不正确'),
  /** 还不是会员时当场建档用（好友自己填） */
  name: z.string().trim().max(32, '姓名最多 32 个字').optional(),
  bindVersion: z.number('请刷新后再领取').int().min(0),
  mock: z.boolean().default(false),
});

/** 主线的拒绝写给好友看 */
function friendlyTrialError(error: unknown): unknown {
  if (!(error instanceof AppError)) return error;
  const say = (code: string, message: string) => new AppError(error.status, code, message);
  switch (error.code) {
    case 'TRIAL_SELF':
      return say('TRIAL_SELF', '不能领自己发出的邀请');
    case 'TRIAL_NOT_ALLOWED':
      return say('TRIAL_NOT_ALLOWED', '这份邀请现在用不了（邀请人这个月不能再邀请了），请让好友重新发一份');
    case 'TRIAL_INVITEE':
      return say('TRIAL_INVITEE', error.message.replace(/^这位会员/, '你').replace(/^已经在体验中/, '你已经在体验中').replace(/^(\d+ 个月内)/, '你 $1'));
    case 'TRIAL_ACTIVE':
      return say('TRIAL_ACTIVE', '你刚刚有了一个体验身份，请刷新看看');
    case 'MEMBER_CHANGED':
    case 'PHONE_EXISTS':
      return say(error.code, '会员信息刚变过，请再点一次领取');
    case 'BAD_REQUEST':
      if (error.details?.field === 'name') return new AppError(400, 'NAME_REQUIRED', '你还不是会员：填一下姓名，就能开卡体验');
      return error;
    default:
      return error;
  }
}

async function claimedView(db: Db, r: InviteRow, replayed: boolean, notice: string | null = null): Promise<MpInviteClaimed> {
  return { code: r.code, trial: await trialOf(db, Number(r.trialId)), bound: r.inviteeBindingId !== null, notice, replayed };
}

export async function claimInvite(deps: Deps, openid: string, code: string, raw: unknown): Promise<MpInviteClaimed> {
  if (!MP_INVITE_CODE.test(code)) throw notFound('邀请不存在');
  const input = parse(ClaimInput, raw);
  if (input.mock && deps.config.env !== 'development' && deps.config.env !== 'test') {
    throw new AppError(403, 'MP_MOCK_REFUSED', '这个门店系统不接受模拟微信');
  }
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockCode(tx, code);
      // 这个微信的绑定锁（排他）：可能要绑定；确认作废也取这一把，作废登记要在它里面查
      await lockOpenid(tx, openid);
      const [fenced] = await tx`SELECT 1 FROM mp_op_fences WHERE key = ${input.clientKey} AND op_type = 'mp_invite' AND openid = ${openid}`;
      if (fenced) throw conflict('OP_ABANDONED', '这次领取已经放弃，请重新领取');
      const state = await bindingStateOf(tx, openid);
      const [r] = await tx<InviteRow[]>`SELECT * FROM mp_invites WHERE code = ${code} FOR UPDATE`;
      if (!r) throw notFound('邀请不存在');
      if (r.claimClientKey === input.clientKey) return claimedView(tx, r, true);
      if (state.version !== input.bindVersion) throw conflict('BIND_STALE', '这个微信的绑定刚变过，请刷新后再领取');
      if (!(await loadInviteRules(tx)).enabled) throw new AppError(403, 'MP_INVITE_DISABLED', '邀请好友还没开放');
      const st = stateOf(r.status, r.expiresAt);
      if (st === 'used') throw conflict('INVITE_USED', '这份邀请已经被领走了');
      if (st === 'revoked') throw unprocessable('INVITE_REVOKED', '邀请人收回了这份邀请');
      if (st === 'expired') throw unprocessable('INVITE_EXPIRED', `这份邀请已经过期了（${MP_INVITE_VALID_DAYS} 天内有效）`);
      if (state.binding) {
        // 这个微信已经绑了会员：验证的手机号要是这位会员的（不能拿别人的手机号领）
        const [bm] = await tx<{ phone: string }[]>`SELECT phone FROM members WHERE id = ${state.binding.memberId}`;
        if (bm?.phone !== input.phone) throw conflict('OPENID_BOUND', '这个微信绑定的会员不是这个手机号：请用绑定的会员的手机号领取');
      }
      const result = await createTrialInviteFromMp(tx, deps, {
        inviterId: Number(r.inviterMemberId),
        invitee: { phone: input.phone, ...(input.name ? { name: input.name } : {}) },
        claimKey: `inv-${r.id}`,
      });
      const memberId = Number(result.trial.memberId);
      let bindingId: number | null = state.binding?.id ?? null;
      let notice: string | null = null;
      if (!state.binding) {
        const [other] = await tx`SELECT 1 FROM mp_bindings WHERE member_id = ${memberId} AND unbound_at IS NULL`;
        if (other) {
          notice = '会员卡已经绑了别的微信，这个微信没有绑上；要换绑请到前台办理';
        } else {
          const [b] = await tx<{ id: number }[]>`
            INSERT INTO mp_bindings (openid, member_id, phone, mock, client_key)
            VALUES (${openid}, ${memberId}, ${input.phone}, ${input.mock}, ${input.clientKey}) RETURNING id`;
          bindingId = Number(b!.id);
        }
      }
      const [used] = await tx<InviteRow[]>`
        UPDATE mp_invites SET status = 'used', claim_client_key = ${input.clientKey}, invitee_member_id = ${memberId},
          invitee_binding_id = ${bindingId}, trial_id = ${result.trial.id}, used_at = now()
        WHERE id = ${r.id} RETURNING *`;
      return claimedView(tx, used!, false, notice);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'mp_invites_claim_client_key_key') || isUniqueViolation(error, 'mp_bindings_client_key_key')) {
      throw conflict('CLIENT_KEY_REUSED', '这次领取的编号已经用过，请重新领取');
    }
    if (isUniqueViolation(error, 'mp_bindings_member_active_uq')) throw conflict('MEMBER_BOUND', '会员卡刚刚绑了别的微信，请再点一次领取');
    throw friendlyTrialError(error);
  }
}

const AbandonInput = z.object({ clientKey: z.uuid('操作编号不正确') });

/** 领取结果不确定时：已经领到了返回那一次；还没有就登记作废（与领取取同一把绑定锁，作废以后原请求再到也不生效） */
export async function abandonInviteClaim(deps: Deps, openid: string, raw: unknown): Promise<MpInviteAbandonResult> {
  const { clientKey } = parse(AbandonInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpenid(tx, openid);
    const [r] = await tx<InviteRow[]>`SELECT * FROM mp_invites WHERE claim_client_key = ${clientKey}`;
    if (r) return { status: 'claimed' as const, claimed: await claimedView(tx, r, true) };
    await tx`INSERT INTO mp_op_fences (key, op_type, openid) VALUES (${clientKey}, 'mp_invite', ${openid}) ON CONFLICT (key, op_type) DO NOTHING`;
    const [fence] = await tx<{ openid: string }[]>`SELECT openid FROM mp_op_fences WHERE key = ${clientKey} AND op_type = 'mp_invite'`;
    if (fence?.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次领取的编号已经用过，请重新领取');
    return { status: 'abandoned' as const };
  });
}

// ───────────────────────── 后台 ─────────────────────────

export async function inviteAdminData(deps: Deps): Promise<MpInviteAdminData> {
  const rules = await loadInviteRules(deps.sql);
  const [counts, rows] = await Promise.all([
    deps.sql<{ status: string; expired: boolean; n: number }[]>`
      SELECT status, (status = 'open' AND expires_at <= now()) AS expired, count(*)::int AS n
      FROM mp_invites WHERE created_at > now() - interval '30 days' GROUP BY 1, 2`,
    deps.sql<(InviteRow & { inviterName: string; inviteeName: string | null })[]>`
      SELECT i.*, a.name AS inviter_name, b.name AS invitee_name
      FROM mp_invites i JOIN members a ON a.id = i.inviter_member_id LEFT JOIN members b ON b.id = i.invitee_member_id
      ORDER BY i.id DESC LIMIT 50`,
  ]);
  const stats: Record<MpInviteState, number> = { open: 0, used: 0, revoked: 0, expired: 0 };
  for (const c of counts) stats[c.expired ? 'expired' : (c.status as MpInviteState)] += c.n;
  const recent: MpInviteAdmin[] = [];
  for (const r of rows) {
    recent.push({
      id: Number(r.id),
      code: r.code,
      state: stateOf(r.status, r.expiresAt),
      createdAt: new Date(r.createdAt).toISOString(),
      expiresAt: new Date(r.expiresAt).toISOString(),
      inviterId: Number(r.inviterMemberId),
      inviterName: r.inviterName,
      inviteeId: r.inviteeMemberId === null ? null : Number(r.inviteeMemberId),
      inviteeName: r.inviteeName,
      trial: r.trialId ? await trialOf(deps.sql, Number(r.trialId)) : null,
      usedAt: r.usedAt ? new Date(r.usedAt).toISOString() : null,
    });
  }
  return { rules, stats, recent };
}
