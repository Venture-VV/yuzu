// 小程序第二期 2c：线上领券（小程序线，docs/MP_COUPONS.md；MP22、MP27）。
//   · 领券中心的设置（settings 的 mp_coupon_rules，带版本号）：开关、可领的券（券模板、每人限领 N 张或不限领、停领），
//     后台「微信小程序 → 领券中心」维护（权限 mp.coupon）；
//   · 顾客：领券中心的列表（按这位会员此刻算：领过几张、能不能领、为什么不能）、领取、确认作废；
//   · 领取在一个事务里：这个微信的咨询锁（mp_coupon:<openid>）→ 作废登记、同一个编号 → 这个微信绑定状态的共享锁 →
//     有效绑定 → 会员一行 → 数已领 → 主线的发券入口 issueMpClaimCoupon（会员一行、模板共享锁；拒绝时整个回滚）→ 写领取记录。
//     限领按会员数：换绑一个微信也不能多领；合并进来的会员卡领的也算。券本身（有效期、门槛、范围、限定档级）照模板。

import { z } from 'zod';
import type { CouponTemplate } from '@shared/coupons';
import {
  MP_COUPON_OFFERS_MAX,
  MP_COUPON_PER_MEMBER_MAX,
  MP_COUPON_RULES_KEY,
  type MpCouponAbandonResult,
  type MpCouponAdminData,
  type MpCouponCenter,
  type MpCouponCenterItem,
  type MpCouponClaimAdmin,
  type MpCouponClaimed,
  type MpCouponOffer,
  type MpCouponRules,
} from '@shared/mp';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import type { Deps, OpContext } from '../../lib/context';
import { AppError, badRequest, conflict, unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { getCoupon, issueMpClaimCoupon, listTemplates, mpClaimEligibility } from '../coupons';
import { activeBinding, bindingStateOf, lockOpenidShared } from './member';
import { mpToday } from './public';
import { loadCouponRules } from './rules';

interface ClaimRow {
  id: number;
  clientKey: string;
  templateId: number;
  memberId: number;
  bindingId: number;
  openid: string;
  seq: number;
  issueId: number;
  couponId: number;
  createdAt: string;
}

/** 领取、确认作废都先取这个微信的这把咨询锁：同一个编号的领取与作废串行 */
const lockCouponOpenid = (tx: Tx, openid: string) => tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_coupon:${openid}`}))`;

async function boundMember(db: Db, openid: string): Promise<{ bindingId: number; memberId: number }> {
  const b = await activeBinding(db, openid);
  if (!b) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
  return { bindingId: b.id, memberId: b.memberId };
}

/** 这位会员（连同合并进来的会员卡）每张券模板领了几张：限领按会员算，合并掉的会员卡领过的也算 */
async function claimedCounts(db: Db, memberId: number): Promise<Map<number, number>> {
  const rows = await db<{ templateId: number; n: number }[]>`
    WITH RECURSIVE fam(id) AS (
      SELECT ${memberId}::bigint
      UNION
      SELECT m.id FROM members m JOIN fam ON m.merged_into_id = fam.id
    )
    SELECT template_id, count(*)::int AS n FROM mp_coupon_claims WHERE member_id IN (SELECT id FROM fam) GROUP BY template_id`;
  return new Map(rows.map((r) => [Number(r.templateId), r.n]));
}

/** 「L3」「L2–L6」「L1、L3」 */
function levelsText(levels: number[]): string {
  const ls = [...new Set(levels)].sort((a, b) => a - b);
  if (ls.length > 1 && ls.every((l, i) => i === 0 || l === ls[i - 1]! + 1)) return `L${ls[0]}–L${ls.at(-1)}`;
  return ls.map((l) => `L${l}`).join('、');
}

const validityText = (t: Pick<CouponTemplate, 'validity' | 'validFrom' | 'validTo' | 'validDays'>) =>
  t.validity === 'fixed' ? `${t.validFrom} 至 ${t.validTo} 有效` : `领取后 ${t.validDays} 天内有效`;

const limitText = (o: MpCouponOffer) => (o.limit === 'unlimited' ? '不限领' : `每人限领 ${o.perMember} 张`);

/** 主线发券入口与只读判断的拒绝码 → 给顾客看的话（主线的原话写的是「这位会员」，是给员工看的） */
function customerReason(code: string | undefined, t?: Pick<CouponTemplate, 'levels'>): string {
  switch (code) {
    case 'MEMBER_MERGED':
      return '会员卡已合并到另一张，请到前台换绑后再领';
    case 'MEMBER_FROZEN':
      return '会员已停用，请到前台咨询';
    case 'COUPON_LEVEL':
      return t?.levels.length ? `只给 ${levelsText(t.levels)} 的会员领` : '你现在的会员等级领不了这张券';
    case 'TEMPLATE_INACTIVE':
      return '这张券已经停领了';
    case 'TEMPLATE_EXPIRED':
      return '这张券已经过了领取期';
    case 'NOT_FOUND':
      return '这张券已经下架了';
    default:
      return '现在领不了这张券，请稍后再试';
  }
}
/** 券模板停了、过了期：谁都领不了，列表里不显示 */
const HIDDEN = new Set(['TEMPLATE_INACTIVE', 'TEMPLATE_EXPIRED', 'NOT_FOUND']);

/** 领取中心开着、有可领的券：「我的」页显示「领券中心」 */
export async function couponCenterOpen(db: Db): Promise<boolean> {
  const r = await loadCouponRules(db);
  return r.enabled && r.offers.some((o) => o.active);
}

/** 领券中心的列表：按这位会员此刻算（只读，不加锁；以领取时的结果为准） */
export async function couponCenter(deps: Deps, openid: string): Promise<MpCouponCenter> {
  // 绑定与版本号用一条语句读（同一个快照）：领取时带回来的版本号与这里列的会员是同一条绑定
  const { binding, version: bindVersion } = await bindingStateOf(deps.sql, openid);
  if (!binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
  const { memberId } = binding;
  const rules = await loadCouponRules(deps.sql);
  if (!rules.enabled) return { open: false, notice: '领券中心还没开放', items: [], bindVersion };
  const [m] = await deps.sql<{ status: string; mergedIntoId: number | null }[]>`SELECT status, merged_into_id FROM members WHERE id = ${memberId}`;
  const notice = !m ? null : m.mergedIntoId !== null ? customerReason('MEMBER_MERGED') : m.status !== 'active' ? customerReason('MEMBER_FROZEN') : null;
  const templates = new Map((await listTemplates(deps.sql)).map((t) => [t.id, t]));
  const counts = await claimedCounts(deps.sql, memberId);
  const items: MpCouponCenterItem[] = [];
  for (const o of rules.offers) {
    const t = templates.get(o.templateId);
    if (!o.active || !t) continue;
    const claimed = counts.get(t.id) ?? 0;
    const e = await mpClaimEligibility(deps.sql, deps, { templateId: t.id, memberId });
    if (!e.ok && HIDDEN.has(e.code ?? '')) continue;
    const full = o.limit === 'per_member' && claimed >= o.perMember;
    const reason = full ? `每人限领 ${o.perMember} 张，已经领满了` : e.ok ? null : customerReason(e.code, t);
    items.push({
      templateId: t.id,
      name: t.name,
      kind: t.kind,
      summary: t.summary,
      validity: validityText(t),
      limitText: limitText(o),
      claimed,
      canClaim: reason === null,
      reason,
    });
  }
  return { open: true, notice, items, bindVersion };
}

async function claimedView(db: Db, deps: Deps, row: ClaimRow, replayed: boolean): Promise<MpCouponClaimed> {
  const c = await getCoupon(db, row.couponId, await mpToday(db, deps.config.timezone));
  return {
    claimId: row.id,
    templateId: Number(row.templateId),
    replayed,
    coupon: { code: c.code, name: c.templateName, summary: c.summary, validFrom: c.validFrom, validTo: c.validTo },
  };
}

const ClaimInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  templateId: z.number('请选择要领的券').int('请选择要领的券').positive('请选择要领的券'),
  /** 顾客点领取时看到的绑定状态版本号（领券中心列表里的 bindVersion） */
  bindVersion: z.number('请刷新领券中心后再领').int('请刷新领券中心后再领').min(0, '请刷新领券中心后再领'),
});

/** 主线发券入口的拒绝码：换成给顾客看的话，码不变 */
const ISSUE_CODES = new Set(['MEMBER_MERGED', 'MEMBER_FROZEN', 'COUPON_LEVEL', 'TEMPLATE_INACTIVE', 'TEMPLATE_EXPIRED', 'NOT_FOUND']);

/** 领一张券：同一个编号重提返回第一次领到的那张，不另发 */
export async function claimCoupon(deps: Deps, openid: string, raw: unknown): Promise<MpCouponClaimed> {
  const input = parse(ClaimInput, raw);
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockCouponOpenid(tx, openid);
      // 这个编号已经确认作废（结果不确定时小程序请门店系统作废的）：晚到的原请求不再发券
      const [fenced] = await tx`SELECT 1 FROM mp_op_fences WHERE key = ${input.clientKey} AND op_type = 'mp_coupon' AND openid = ${openid}`;
      if (fenced) throw conflict('OP_ABANDONED', '这次领取已经放弃，请重新点领取');
      // 这个微信绑定状态的共享锁（解绑拿排他的）：读到的有效绑定到写入、提交之前不会被解绑
      await lockOpenidShared(tx, openid);
      const state = await bindingStateOf(tx, openid);
      if (!state.binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
      // 点领取时看到的是哪一条绑定：之后解绑、换绑过（版本号变了），这是之前的请求，不发券——
      // 否则换绑以后才到的旧请求会把券发给换绑以后的会员（与充值建单同一个做法，小程序线测试 #52 的 P1）
      if (state.version !== input.bindVersion) throw conflict('BIND_STALE', '会员绑定刚变过，这次没有领，请回到领券中心重新领');
      const { id: bindingId, memberId } = state.binding;
      const [prev] = await tx<ClaimRow[]>`SELECT * FROM mp_coupon_claims WHERE client_key = ${input.clientKey}`;
      if (prev) {
        // 同一个编号重提：只认同一个微信、同一位会员、同一张券；换绑到别的会员后不再给这个微信看
        if (prev.openid !== openid || Number(prev.memberId) !== memberId || Number(prev.templateId) !== input.templateId) {
          throw conflict('CLIENT_KEY_REUSED', '这次领取的编号已经用过，请重新点领取');
        }
        return claimedView(tx, deps, prev, true);
      }
      const rules = await loadCouponRules(tx);
      if (!rules.enabled) throw new AppError(403, 'MP_COUPON_DISABLED', '领券中心还没开放');
      const offer = rules.offers.find((o) => o.active && o.templateId === input.templateId);
      if (!offer) throw unprocessable('OFFER_UNAVAILABLE', '这张券现在不能在小程序领了，请刷新');
      // 会员一行：同一位会员的领取串行（数已领、第几张）；主线的发券入口锁的也是这一行，后面不会再等
      await tx`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`;
      const claimed = (await claimedCounts(tx, memberId)).get(input.templateId) ?? 0;
      if (offer.limit === 'per_member' && claimed >= offer.perMember) {
        throw unprocessable('CLAIM_LIMIT', `每人限领 ${offer.perMember} 张，已经领满了`);
      }
      const [next] = await tx<{ seq: number }[]>`
        SELECT coalesce(max(seq), 0)::int + 1 AS seq FROM mp_coupon_claims WHERE template_id = ${input.templateId} AND member_id = ${memberId}`;
      const issued = await issueMpClaimCoupon(tx, deps, { templateId: input.templateId, memberId, claimId: input.clientKey });
      const [row] = await tx<ClaimRow[]>`
        INSERT INTO mp_coupon_claims (client_key, template_id, member_id, binding_id, openid, seq, issue_id, coupon_id)
        VALUES (${input.clientKey}, ${input.templateId}, ${memberId}, ${bindingId}, ${openid}, ${next!.seq}, ${issued.issueId}, ${issued.coupon.id})
        RETURNING *`;
      return {
        claimId: row!.id,
        templateId: input.templateId,
        replayed: false,
        coupon: { code: issued.coupon.code, name: issued.coupon.templateName, summary: issued.coupon.summary, validFrom: issued.coupon.validFrom, validTo: issued.coupon.validTo },
      };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'mp_coupon_claims_client_key_key')) throw conflict('CLIENT_KEY_REUSED', '这次领取的编号已经用过，请重新点领取');
    if (error instanceof AppError && ISSUE_CODES.has(error.code)) throw new AppError(error.status, error.code, customerReason(error.code));
    throw error;
  }
}

const AbandonInput = z.object({ clientKey: z.uuid('操作编号不正确') });

/** 领取结果不确定时确认作废这个编号：与领取取同一把咨询锁；已经领到了就返回那张，还没有就登记作废 */
export async function abandonCouponClaim(deps: Deps, openid: string, raw: unknown): Promise<MpCouponAbandonResult> {
  const { clientKey } = parse(AbandonInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockCouponOpenid(tx, openid);
    const [prev] = await tx<ClaimRow[]>`SELECT * FROM mp_coupon_claims WHERE client_key = ${clientKey}`;
    if (prev) {
      if (prev.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次领取的编号已经用过，请重新点领取');
      // 换绑到别的会员之前领的：券在原来那位会员名下，不再给这个微信看；对现在的会员来说这个编号就是作废了
      const b = await activeBinding(tx, openid);
      if (!b || b.memberId !== Number(prev.memberId)) return { status: 'abandoned' as const };
      return { status: 'claimed' as const, claimed: await claimedView(tx, deps, prev, true) };
    }
    await tx`
      INSERT INTO mp_op_fences (key, op_type, openid) VALUES (${clientKey}, 'mp_coupon', ${openid})
      ON CONFLICT (key, op_type) DO NOTHING`;
    const [fence] = await tx<{ openid: string }[]>`SELECT openid FROM mp_op_fences WHERE key = ${clientKey} AND op_type = 'mp_coupon'`;
    if (fence?.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次领取的编号已经用过，请重新点领取');
    return { status: 'abandoned' as const };
  });
}

// ── 后台：领券中心（权限 mp.coupon）──

export async function couponAdminData(deps: Deps): Promise<MpCouponAdminData> {
  const rules = await loadCouponRules(deps.sql);
  const offered = new Set(rules.offers.map((o) => o.templateId));
  // 勾选用：启用的券模板；已经放进领券中心、后来停用的也列出来（好看清、好拿掉）
  const templates = (await listTemplates(deps.sql))
    .filter((t) => t.active || offered.has(t.id))
    .map((t) => ({ id: t.id, name: t.active ? t.name : `${t.name}（已停用）`, summary: t.summary, validity: validityText(t), levels: t.levels }));
  const stats = await deps.sql<{ templateId: number; total: number; last7Days: number }[]>`
    SELECT template_id, count(*)::int AS total, (count(*) FILTER (WHERE created_at > now() - interval '7 days'))::int AS last7_days
    FROM mp_coupon_claims GROUP BY template_id ORDER BY template_id`;
  const recent = await deps.sql<MpCouponClaimAdmin[]>`
    SELECT c.id, c.created_at, c.member_id, m.name AS member_name, c.template_id, t.name AS template_name, cp.code AS coupon_code, i.issue_no, c.seq
    FROM mp_coupon_claims c
    JOIN members m ON m.id = c.member_id
    JOIN coupon_templates t ON t.id = c.template_id
    JOIN coupons cp ON cp.id = c.coupon_id
    JOIN coupon_issues i ON i.id = c.issue_id
    ORDER BY c.id DESC LIMIT 50`;
  return {
    rules,
    templates,
    stats: stats.map((s) => ({ templateId: Number(s.templateId), total: s.total, last7Days: s.last7Days })),
    recent: recent.map((r) => ({ ...r, templateId: Number(r.templateId), memberId: Number(r.memberId), createdAt: new Date(r.createdAt).toISOString() })),
  };
}

const OfferInput = z.object({
  templateId: z.number('请选择券模板').int().positive('请选择券模板'),
  limit: z.enum(['unlimited', 'per_member'], '请选择领取限制'),
  perMember: z.number('请填每人限领几张').int('请填整数').min(1, '每人至少限领 1 张').max(MP_COUPON_PER_MEMBER_MAX, `每人最多限领 ${MP_COUPON_PER_MEMBER_MAX} 张`),
  active: z.boolean(),
});
const RulesInput = z.object({
  enabled: z.boolean(),
  offers: z.array(OfferInput).max(MP_COUPON_OFFERS_MAX, `领券中心最多放 ${MP_COUPON_OFFERS_MAX} 张券`),
  /** 打开时看到的版本号；不带的不核对（只给脚本用） */
  version: z.number().int().min(0).optional(),
});

export async function saveCouponRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<MpCouponRules> {
  const input = parse(RulesInput, raw);
  const ids = input.offers.map((o) => o.templateId);
  if (new Set(ids).size !== ids.length) throw badRequest('同一张券模板只能放一次');
  return saveRuleSetting(
    deps.sql,
    MP_COUPON_RULES_KEY,
    loadCouponRules,
    async (before, tx) => {
      if (input.version !== undefined && input.version !== before.version) throw conflict('VERSION_CONFLICT', '领券中心的设置刚被别人改过，请刷新后再改');
      // 只核对这次新加的：新放进来的券模板要是启用的；之前放进来、后来停用的原样保存不拦（列表里不显示、领不了），
      // 「放弃这次修改」按现在的内容原样保存一次，不会因为这些被拒
      const added = ids.filter((id) => !before.offers.some((o) => o.templateId === id));
      const found = added.length ? await tx<{ id: number }[]>`SELECT id FROM coupon_templates WHERE active AND id = ANY(${added}::bigint[])` : [];
      if (found.length !== added.length) throw unprocessable('TEMPLATE_UNAVAILABLE', '选的券模板里有停用或不存在的，请刷新后再选');
      // 内容没变也加一：后台「放弃这次修改」靠它让原来那次请求的版本号对不上
      return { enabled: input.enabled, offers: input.offers, version: before.version + 1 };
    },
    ctx,
  );
}
