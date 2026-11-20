// 全局签赠（8.1.9，docs/GIFTS_V819.md，PENDING_DECISIONS「8.1.9 签赠」SZ1–SZ8）。
//
// 口径：
//   · 签赠券类型 = 券模板里标了 gift 的（兑换券或代金券），板块、权益内容、规则说明存在模板上（知识库）；新建、修改走券模板的同一条路
//    （coupons.ts 的 createTemplate / updateTemplate 带上 GiftInfo），发过券以后送什么、有效期不能改（原来的模板守卫管）。
//   · 签赠 = 人工发券（coupon_issues.kind = 'manual'）+ 授权人 authorized_by + 发放渠道 gift_channel；签赠券类型只能这样发
//    （普通发券、发券规则、无记名、批量发券、会员权益、小程序领取都拒绝，迁移 184 的触发器兜底）。
//   · 核销、反结账退回、作废、过期都是券原来的（coupon-checkout.ts、coupons.ts）；台账从券、发券记录、券的变动记录现查，不另存。
//   · 配置（settings 的 gift_rules，全公司一份）：开关（默认开）、板块与渠道的选项、签赠总则。关了不能再发，已发的照常能用、台账照常看。
// 加锁：
//   · 新建类型：操作编号的咨询锁（与「确认作废」串行，业务类型 gift_type）→ 写模板；修改：只锁模板一行（带版本号）。
//   · 发放：操作编号的咨询锁（gift_issue，与「确认作废」串行）→ 模板（共享锁，与改模板串行）；会员、授权人只读核对、不加锁；
//     发券记录的操作编号唯一约束兜底。
//   · 作废：券原来的（只锁那张券）。台账、知识库：只读快照，不加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { formatStoreCouponCode, type CouponTemplate } from '@shared/coupons';
import {
  DEFAULT_GIFT_RULES,
  GIFT_LEDGER_ROW_LIMIT,
  GIFT_STATUS_LABELS,
  giftValidityText,
  MAX_GIFT_QUANTITY,
  type GiftAuthorizer,
  type GiftCountRow,
  type GiftIssueResult,
  type GiftLedger,
  type GiftLedgerRow,
  type GiftMemberOption,
  type GiftRules,
  type GiftShare,
  type GiftStatus,
  type GiftType,
} from '@shared/gifts';
import { formatAmount } from '@shared/money';
import { can, permissionsOf, type Duty, type Role } from '@shared/permissions';
import { loadRoleOverrides, staffSubject } from '../auth/role-permissions';
import { guard, guardAny } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Actor, type Deps, type OpContext } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { checkDateRange } from '../lib/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { saveRuleSetting } from '../lib/rule-settings';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { businessToday, couponsOfIssue, createTemplate, getTemplate, issueDate, listTemplates, lockTemplate, updateTemplate, voidCoupon, writeIssue } from './coupons';
import { maskCustomerPhones } from './customer/routes';
import { erpOpAbandoned } from './erp-ops';
import { searchMembers } from './members';

const SETTING_KEY = 'gift_rules';
const SHARE_TOP = 8;
const BY_PERSON_LIMIT = 50;
const EXPORT_LIMIT = 20_000;
const yuan = (cents: number) => formatAmount(cents).replace(/,/g, '');

// ───────────────────────── 配置 ─────────────────────────

const stringList = (v: unknown, fallback: string[]) => (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string') ? (v as string[]) : fallback);

export async function loadGiftRules(db: Db): Promise<GiftRules> {
  const [row] = await db<{ value: Partial<GiftRules> }[]>`SELECT value FROM settings WHERE key = ${SETTING_KEY}`;
  const v = row?.value ?? {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_GIFT_RULES.enabled,
    segments: stringList(v.segments, DEFAULT_GIFT_RULES.segments),
    channels: stringList(v.channels, DEFAULT_GIFT_RULES.channels),
    generalRules: typeof v.generalRules === 'string' ? v.generalRules : DEFAULT_GIFT_RULES.generalRules,
  };
}

const OptionList = (what: string) =>
  z
    .array(z.string(`${what}要写成文字`).trim().min(1, `${what}不能是空的`).max(20, `${what}最多 20 个字`), `请填写${what}`)
    .min(1, `至少留一个${what}`)
    .max(20, `${what}最多 20 个`)
    .transform((list) => [...new Set(list)]);
const RulesInput = z.object({
  enabled: z.boolean('请选择开还是关'),
  segments: OptionList('板块'),
  channels: OptionList('发放渠道'),
  generalRules: z.string().trim().max(2000, '签赠总则最多 2000 字').default(''),
});

async function saveGiftRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<GiftRules> {
  const input = parse(RulesInput, raw);
  return saveRuleSetting(deps.sql, SETTING_KEY, loadGiftRules, () => input, ctx);
}

// ───────────────────────── 知识库（签赠券类型） ─────────────────────────

const GiftInfoInput = z.object({
  segment: z.string('请选择板块').trim().min(1, '请选择板块').max(20, '板块最多 20 个字'),
  content: z.string().trim().max(1000, '权益内容最多 1000 字').default(''),
  rules: z.string().trim().max(1000, '规则说明最多 1000 字').default(''),
});

type Counts = Omit<GiftCountRow, 'issued'>;

async function typeCounts(db: Db, today: string, ids?: number[]): Promise<Map<number, Counts>> {
  const rows = await db<(Counts & { templateId: number })[]>`
    SELECT c.template_id,
           count(*) FILTER (WHERE c.status = 'used')::int AS used,
           count(*) FILTER (WHERE c.status = 'voided')::int AS voided,
           count(*) FILTER (WHERE c.status = 'available' AND c.valid_to < ${today})::int AS expired,
           count(*) FILTER (WHERE c.status = 'available' AND c.valid_to >= ${today})::int AS available
    FROM coupons c JOIN coupon_templates t ON t.id = c.template_id AND t.gift
    ${ids ? db`WHERE c.template_id IN ${db(ids)}` : db``}
    GROUP BY c.template_id`;
  return new Map(rows.map((r) => [Number(r.templateId), r]));
}

const toGiftType = (t: CouponTemplate, n: Counts | undefined): GiftType => ({
  ...t,
  validityText: giftValidityText(t),
  used: n?.used ?? 0,
  available: n?.available ?? 0,
  voided: n?.voided ?? 0,
  expired: n?.expired ?? 0,
});

export async function listGiftTypes(db: Db, today: string): Promise<GiftType[]> {
  const types = await listTemplates(db, { gift: true });
  const counts = await typeCounts(db, today);
  return types.map((t) => toGiftType(t, counts.get(t.id)));
}

export async function getGiftType(db: Db, id: number, today: string): Promise<GiftType> {
  const t = await getTemplate(db, id);
  if (!t.gift) throw notFound('签赠券类型不存在');
  return toGiftType(t, (await typeCounts(db, today, [id])).get(id));
}

/** 板块要从配置的选项里选；配置里后来删掉的板块，原来就是它的类型改别的内容时可以留着 */
async function assertSegment(db: Db, segment: string, current: string | null) {
  const rules = await loadGiftRules(db);
  if (!rules.segments.includes(segment) && segment !== current) throw badRequest(`板块「${segment}」不在配置的选项里，请刷新后重选`, { field: 'segment' });
}

/** 新建签赠券类型（同一操作编号重复提交返回原来那个）；签赠券不限会员档级 */
export async function createGiftType(deps: Deps, raw: unknown, ctx: OpContext): Promise<GiftType> {
  const gift = parse(GiftInfoInput, raw);
  await assertSegment(deps.sql, gift.segment, null);
  const t = await createTemplate(deps, { ...(raw as object), levels: [] }, ctx, gift);
  return getGiftType(deps.sql, t.id, await businessToday(deps.sql, deps));
}

/** 改签赠券类型：名称、板块、权益内容、规则说明、停用随时能改；发过券以后送什么、有效期不能改（带版本号） */
export async function updateGiftType(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<GiftType> {
  const gift = parse(GiftInfoInput, raw);
  const [cur] = await deps.sql<{ giftSegment: string }[]>`SELECT gift_segment FROM coupon_templates WHERE id = ${id} AND gift`;
  if (!cur) throw notFound('签赠券类型不存在');
  await assertSegment(deps.sql, gift.segment, cur.giftSegment);
  await updateTemplate(deps, id, { ...(raw as object), levels: [] }, ctx, gift);
  return getGiftType(deps.sql, id, await businessToday(deps.sql, deps));
}

// ───────────────────────── 授权人、会员 ─────────────────────────

/** 能被选作授权人的：在职、有「签赠授权」（按岗位权限，含后台改过的） */
export async function giftAuthorizers(db: Db): Promise<GiftAuthorizer[]> {
  const rows = await db<{ id: number; name: string; role: Role; duties: Duty[] | null; position: unknown; permissionAdjust: unknown }[]>`
    SELECT id, display_name AS name, role, duties, position, permission_adjust FROM staff WHERE active AND NOT system ORDER BY display_name, id`;
  const overrides = await loadRoleOverrides(db);
  return rows.filter((r) => permissionsOf(staffSubject(r), overrides).includes('gift.authorize')).map((r) => ({ id: Number(r.id), name: r.name }));
}

/** 核对授权人（只读、不加锁）：在职、有「签赠授权」；返回名字 */
async function assertAuthorizer(db: Db, staffId: number): Promise<string> {
  const [s] = await db<{ name: string; role: Role; duties: Duty[] | null; position: unknown; permissionAdjust: unknown; active: boolean; system: boolean }[]>`
    SELECT display_name AS name, role, duties, position, permission_adjust, active, system FROM staff WHERE id = ${staffId}`;
  if (!s || !s.active || s.system) throw unprocessable('AUTHORIZER_INVALID', '选的授权人不存在或已停用，请重新选择');
  const overrides = await loadRoleOverrides(db);
  if (!permissionsOf(staffSubject(s), overrides).includes('gift.authorize')) {
    throw unprocessable('AUTHORIZER_INVALID', `「${s.name}」没有「签赠授权」的权限，不能做授权人；请重新选择（后台「岗位权限」里可以加）`);
  }
  return s.name;
}

/** 发放时找会员（手机号、卡号、姓名）：没有搜索词不列；停用、合并过的标不能发 */
async function giftMembers(db: Db, q: string): Promise<GiftMemberOption[]> {
  if (!q) return [];
  const rows = await searchMembers(db, q, 20);
  return rows.map((m) => ({
    id: Number(m.id),
    memberNo: m.memberNo,
    name: m.name,
    phone: m.phone,
    grade: m.grade,
    usable: m.status === 'active' && m.mergedIntoId === null,
  }));
}

// ───────────────────────── 发放 ─────────────────────────

const IssueInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  memberId: z.number('请选择会员').int().positive('请选择会员'),
  templateId: z.number('请选择签赠券类型').int().positive('请选择签赠券类型'),
  quantity: z.number('张数必须是整数').int('张数必须是整数').min(1, '至少 1 张').max(MAX_GIFT_QUANTITY, `一次最多发 ${MAX_GIFT_QUANTITY} 张`),
  authorizedBy: z.number('请选择授权人').int().positive('请选择授权人'),
  channel: z.string('请选择发放渠道').trim().min(1, '请选择发放渠道').max(20, '发放渠道最多 20 个字'),
  reason: z.string('请填写事由').trim().min(2, '请填写事由（至少 2 个字）').max(200, '事由最多 200 字'),
});
type IssueInput = z.infer<typeof IssueInput>;

/** 同一操作编号已发过：同一笔返回原记录，不同的拒绝 */
async function replayGiftIssue(db: Db, input: IssueInput): Promise<{ id: number; issueNo: string } | null> {
  const [r] = await db<
    { id: number; issueNo: string; kind: string; templateId: number; memberId: number | null; quantity: number; authorizedBy: number | null; giftChannel: string | null }[]
  >`SELECT id, issue_no, kind, template_id, member_id, quantity, authorized_by, gift_channel FROM coupon_issues WHERE client_key = ${input.clientKey}`;
  if (!r) return null;
  const same =
    r.kind === 'manual' &&
    r.authorizedBy !== null &&
    Number(r.authorizedBy) === input.authorizedBy &&
    Number(r.templateId) === input.templateId &&
    Number(r.memberId) === input.memberId &&
    r.quantity === input.quantity &&
    r.giftChannel === input.channel;
  if (!same) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔发券，请刷新页面后重新发起');
  return { id: Number(r.id), issueNo: r.issueNo };
}

export async function issueGift(deps: Deps, raw: unknown, ctx: OpContext): Promise<GiftIssueResult> {
  const input = parse(IssueInput, raw);
  const result = async (issue: { id: number; issueNo: string }, replayed: boolean, date?: string): Promise<GiftIssueResult> => ({
    issueId: issue.id,
    issueNo: issue.issueNo,
    replayed,
    coupons: (await couponsOfIssue(deps.sql, issue.id, date ?? (await businessToday(deps.sql, deps)))).map((c) => ({ id: c.id, code: c.code, validTo: c.validTo })),
  });
  const prior = await replayGiftIssue(deps.sql, input);
  if (prior) return result(prior, true);
  try {
    const done = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 与「确认作废」串行：已作废的编号整笔拒绝
      await assertNotFenced(tx, input.clientKey, 'gift_issue', erpOpAbandoned);
      const rules = await loadGiftRules(tx);
      if (!rules.enabled) throw unprocessable('GIFT_OFF', '签赠已在后台「签赠 → 配置」里关掉，不能再发；已发的照常能用');
      if (!rules.channels.includes(input.channel)) throw badRequest(`发放渠道「${input.channel}」不在配置的选项里，请刷新后重选`, { field: 'channel' });
      // 会员一行（FOR UPDATE，与停用、合并串行；锁住以后再核对）→ 模板（共享锁），与小程序领取同一个顺序。
      // 不锁的话，合并可以在这里读完之后、写券之前核对「来源没有能用的券」并提交，券就发到了合并掉的会员名下（Codex 审查 cf81873）
      const [m] = await tx<{ name: string; status: string; mergedIntoId: number | null }[]>`
        SELECT name, status, merged_into_id FROM members WHERE id = ${input.memberId} FOR UPDATE`;
      if (!m) throw notFound('会员不存在');
      if (m.mergedIntoId !== null) throw unprocessable('MEMBER_MERGED', `会员「${m.name}」已合并到另一位会员，请发给合并后的那位`);
      if (m.status !== 'active') throw unprocessable('MEMBER_FROZEN', `会员「${m.name}」已停用，不能发签赠`);
      const template = await lockTemplate(tx, input.templateId);
      if (!template?.gift) throw notFound('签赠券类型不存在');
      if (!template.active) throw unprocessable('TEMPLATE_INACTIVE', `签赠券类型「${template.name}」已停用，不能再发`);
      const authorizer = await assertAuthorizer(tx, input.authorizedBy);
      const at = ctx.at ?? new Date();
      const date = await issueDate(tx, deps, at);
      const issue = (await writeIssue(tx, {
        kind: 'manual',
        template,
        memberId: input.memberId,
        quantity: input.quantity,
        reason: input.reason,
        clientKey: input.clientKey,
        staffId: ctx.actor.id,
        at,
        date,
        authorizedBy: input.authorizedBy,
        giftChannel: input.channel,
      }))!;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'gift_issue',
        targetType: 'member',
        targetId: input.memberId,
        detail: {
          issueNo: issue.issueNo,
          type: template.name,
          quantity: input.quantity,
          authorizer: { id: input.authorizedBy, name: authorizer },
          channel: input.channel,
          reason: input.reason,
        },
        ip: ctx.ip,
        businessDate: date,
      });
      return { id: issue.issueId, issueNo: issue.issueNo, date };
    });
    return result(done, false, done.date);
  } catch (error) {
    // 同一编号并发提交：后到的撞上唯一约束，查回第一次的结果
    if (isUniqueViolation(error, 'coupon_issues_client_key_key')) {
      const again = await replayGiftIssue(deps.sql, input);
      if (again) return result(again, true);
    }
    throw error;
  }
}

/** 作废没用过的签赠券（券原来的那一套；只认签赠券，「维护签赠」的人作废不了普通券） */
async function voidGift(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<void> {
  const [c] = await deps.sql<{ gift: boolean }[]>`SELECT t.gift FROM coupons c JOIN coupon_templates t ON t.id = c.template_id WHERE c.id = ${id}`;
  if (!c?.gift) throw notFound('签赠券不存在');
  await voidCoupon(deps, id, raw, ctx);
}

// ───────────────────────── 台账 ─────────────────────────

const optId = z.coerce.number().int().positive().optional();
const optText = z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).max(20).optional());
const LedgerQuery = z.object({
  from: z.string('请选择开始日期').regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  to: z.string('请选择结束日期').regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  channel: optText,
  templateId: optId,
  authorizerId: optId,
  memberId: optId,
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['available', 'used', 'voided', 'expired']).optional()),
});
export type LedgerFilter = z.infer<typeof LedgerQuery>;

function ledgerFilter(raw: unknown): LedgerFilter {
  const q = parse(LedgerQuery, raw);
  checkDateRange(q.from, q.to);
  return q;
}

/** 签赠券与它的类型、发券记录、授权人、会员 */
const GIFT_FROM = (db: Db) => db`
  FROM coupons c
  JOIN coupon_templates t ON t.id = c.template_id AND t.gift
  JOIN coupon_issues ci ON ci.id = c.issue_id
  JOIN staff au ON au.id = ci.authorized_by
  LEFT JOIN members m ON m.id = c.member_id`;

/** 筛选（发放日期在区间里）；状态按推算到今天的算（没用、过了有效期的算已过期） */
const GIFT_WHERE = (db: Db, f: LedgerFilter, today: string) => db`
  WHERE ci.business_date BETWEEN ${f.from} AND ${f.to}
    ${f.channel ? db`AND ci.gift_channel = ${f.channel}` : db``}
    ${f.templateId ? db`AND c.template_id = ${f.templateId}` : db``}
    ${f.authorizerId ? db`AND ci.authorized_by = ${f.authorizerId}` : db``}
    ${f.memberId ? db`AND c.member_id = ${f.memberId}` : db``}
    ${
      f.status === 'used' || f.status === 'voided'
        ? db`AND c.status = ${f.status}`
        : f.status === 'expired'
          ? db`AND c.status = 'available' AND c.valid_to < ${today}`
          : f.status === 'available'
            ? db`AND c.status = 'available' AND c.valid_to >= ${today}`
            : db``
    }`;

const statusOf = (status: string, validTo: string, today: string): GiftStatus => (status === 'used' ? 'used' : status === 'voided' ? 'voided' : validTo < today ? 'expired' : 'available');

type DetailRow = Omit<GiftLedgerRow, 'type' | 'member' | 'authorizer' | 'status' | 'issuedAt' | 'usedAt' | 'voidedAt'> & {
  status: string;
  templateId: number;
  templateName: string;
  memberId: number | null;
  memberName: string | null;
  memberPhone: string | null;
  authorizerId: number;
  authorizerName: string;
  issuedAt: Date;
  usedAt: Date | null;
  voidedAt: Date | null;
};

async function ledgerRows(db: Db, f: LedgerFilter, today: string, limit: number): Promise<GiftLedgerRow[]> {
  const rows = await db<DetailRow[]>`
    SELECT c.id AS coupon_id, c.code, c.status, c.valid_to, t.id AS template_id, t.name AS template_name, t.gift_segment AS segment,
           c.member_id, m.name AS member_name, m.phone AS member_phone, au.id AS authorizer_id, au.display_name AS authorizer_name,
           ib.display_name AS issued_by_name, ci.gift_channel AS channel, ci.reason, ci.issue_no, ci.issued_at, ci.business_date,
           ue.at AS used_at, ue.checkout_id, ck.checkout_no, us.display_name AS used_by_name, ue.amount AS used_cents,
           ve.at AS voided_at, vs.display_name AS voided_by_name, ve.reason AS void_reason
    ${GIFT_FROM(db)}
    LEFT JOIN staff ib ON ib.id = ci.issued_by
    LEFT JOIN LATERAL (SELECT e.at, e.checkout_id, e.amount, e.staff_id FROM coupon_events e WHERE e.coupon_id = c.id AND e.kind = 'use' ORDER BY e.id DESC LIMIT 1) ue
      ON c.status = 'used'
    LEFT JOIN checkouts ck ON ck.id = ue.checkout_id
    LEFT JOIN staff us ON us.id = ue.staff_id
    LEFT JOIN LATERAL (SELECT e.at, e.reason, e.staff_id FROM coupon_events e WHERE e.coupon_id = c.id AND e.kind = 'void' ORDER BY e.id DESC LIMIT 1) ve
      ON c.status = 'voided'
    LEFT JOIN staff vs ON vs.id = ve.staff_id
    ${GIFT_WHERE(db, f, today)}
    ORDER BY ci.issued_at DESC, c.id DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    couponId: Number(r.couponId),
    code: r.code,
    type: { id: Number(r.templateId), name: r.templateName },
    segment: r.segment,
    member: r.memberId === null ? null : { id: Number(r.memberId), name: r.memberName ?? '', phone: r.memberPhone ?? '' },
    authorizer: { id: Number(r.authorizerId), name: r.authorizerName },
    issuedByName: r.issuedByName,
    channel: r.channel,
    reason: r.reason,
    issueNo: r.issueNo,
    issuedAt: new Date(r.issuedAt).toISOString(),
    businessDate: r.businessDate,
    validTo: r.validTo,
    status: statusOf(r.status, r.validTo, today),
    usedAt: r.usedAt ? new Date(r.usedAt).toISOString() : null,
    checkoutId: r.checkoutId === null ? null : Number(r.checkoutId),
    checkoutNo: r.checkoutNo,
    usedByName: r.usedByName,
    usedCents: r.usedCents === null ? null : Number(r.usedCents),
    voidedAt: r.voidedAt ? new Date(r.voidedAt).toISOString() : null,
    voidedByName: r.voidedByName,
    voidReason: r.voidReason,
  }));
}

const emptyCounts = (): GiftCountRow => ({ issued: 0, used: 0, available: 0, voided: 0, expired: 0 });

/** 前 SHARE_TOP 项，其余并成「其他」；占比按总数四舍五入 */
function sharesOf(counts: Map<string, number>): GiftShare[] {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  const sorted = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
  const top = sorted.slice(0, SHARE_TOP);
  const rest = sorted.slice(SHARE_TOP).reduce((a, [, n]) => a + n, 0);
  const list = rest > 0 ? [...top, ['其他', rest] as [string, number]] : top;
  return list.map(([label, count]) => ({ label, count, pct: Math.round((count * 100) / total) }));
}

export async function giftLedger(db: Db, f: LedgerFilter, today: string): Promise<GiftLedger> {
  // 统计按全部（不受明细条数限制）：只取统计要的几列
  const all = await db<
    {
      status: string;
      validTo: string;
      memberId: number | null;
      memberName: string | null;
      memberPhone: string | null;
      templateName: string;
      segment: string;
      channel: string;
      authorizerId: number;
      authorizerName: string;
      usedCents: number | null;
    }[]
  >`
    SELECT c.status, c.valid_to, c.member_id, m.name AS member_name, m.phone AS member_phone, t.name AS template_name, t.gift_segment AS segment,
           ci.gift_channel AS channel, au.id AS authorizer_id, au.display_name AS authorizer_name,
           CASE WHEN c.status = 'used' THEN (SELECT e.amount FROM coupon_events e WHERE e.coupon_id = c.id AND e.kind = 'use' ORDER BY e.id DESC LIMIT 1) END AS used_cents
    ${GIFT_FROM(db)} ${GIFT_WHERE(db, f, today)}`;
  const totals = { ...emptyCounts(), usedCents: 0 };
  const byAuthorizer = new Map<number, GiftCountRow & { authorizer: { id: number; name: string } }>();
  const byPerson = new Map<number, GiftLedger['byPerson'][number]>();
  const usedBy = { authorizer: new Map<string, number>(), segment: new Map<string, number>(), type: new Map<string, number>() };
  const issuedByChannel = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of all) {
    const st = statusOf(r.status, r.validTo, today);
    const cents = st === 'used' ? Number(r.usedCents ?? 0) : 0;
    totals.issued++;
    totals[st]++;
    totals.usedCents += cents;
    const aid = Number(r.authorizerId);
    const a = byAuthorizer.get(aid) ?? { ...emptyCounts(), authorizer: { id: aid, name: r.authorizerName } };
    a.issued++;
    a[st]++;
    byAuthorizer.set(aid, a);
    if (r.memberId !== null) {
      const mid = Number(r.memberId);
      const p = byPerson.get(mid) ?? { member: { id: mid, name: r.memberName ?? '', phone: r.memberPhone ?? '' }, issued: 0, used: 0, usedCents: 0 };
      p.issued++;
      if (st === 'used') {
        p.used++;
        p.usedCents += cents;
      }
      byPerson.set(mid, p);
    }
    bump(issuedByChannel, r.channel);
    if (st === 'used') {
      bump(usedBy.authorizer, r.authorizerName);
      bump(usedBy.segment, r.segment);
      bump(usedBy.type, r.templateName);
    }
  }
  const rows = await ledgerRows(db, f, today, GIFT_LEDGER_ROW_LIMIT);
  return {
    rows,
    truncated: all.length > rows.length,
    totals,
    byAuthorizer: [...byAuthorizer.values()].sort((x, y) => y.issued - x.issued || x.authorizer.name.localeCompare(y.authorizer.name, 'zh')),
    byPerson: [...byPerson.values()].sort((x, y) => y.used - x.used || y.usedCents - x.usedCents || y.issued - x.issued || x.member.id - y.member.id).slice(0, BY_PERSON_LIMIT),
    shares: { authorizer: sharesOf(usedBy.authorizer), segment: sharesOf(usedBy.segment), type: sharesOf(usedBy.type), channel: sharesOf(issuedByChannel) },
  };
}

/**
 * 导出明细。一次最多 EXPORT_LIMIT 张：多取一张，超过就整份拒绝、请缩短日期范围（与零采备用金的导出一样），
 * 不悄悄截掉早的那些——否则导出的少了、与台账上的合计对不上（Codex 审查 cf81873）。limit 只给用例换小。
 */
export async function giftLedgerCsv(db: Db, f: LedgerFilter, today: string, actor: Actor, limit = EXPORT_LIMIT): Promise<string> {
  const all = await ledgerRows(db, f, today, limit + 1);
  if (all.length > limit) throw unprocessable('EXPORT_TOO_LARGE', `一次最多导出 ${limit} 张，请缩短日期范围，或按授权人、渠道、券种筛选后再导`);
  const rows = maskCustomerPhones(all, actor);
  return toCsv([
    ['券码', '券种', '板块', '会员', '手机号', '授权人', '经办', '渠道', '事由', '发放单号', '发放日期', '有效期到', '状态', '核销结账单', '核销时间', '核销经办', '抵扣（元）', '作废原因'],
    ...rows.map((r) => [
      formatStoreCouponCode(r.code),
      r.type.name,
      r.segment,
      r.member?.name ?? '',
      r.member?.phone ?? '',
      r.authorizer.name,
      r.issuedByName ?? '',
      r.channel,
      r.reason,
      r.issueNo,
      r.businessDate,
      r.validTo,
      GIFT_STATUS_LABELS[r.status],
      r.checkoutNo ?? '',
      r.usedAt ?? '',
      r.usedByName ?? '',
      r.usedCents === null ? '' : yuan(r.usedCents),
      r.voidReason ?? '',
    ]),
  ]);
}

// ───────────────────────── 接口 ─────────────────────────

/** 台账：管家部、客户部的页签与后台「签赠 → 台账」同一份（gift.read，或者能看管家部 / 客户部的） */
const LEDGER_PERMS = ['gift.read', 'gift.manage', 'concierge.read', 'customer.read'] as const;

/** 签赠的接口（名字与库存的赠品登记 registerGiftRoutes 区分开） */
export function registerSignGiftRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const today = () => businessToday(sql, deps);

  // 配置：发放、看台账的人也要读（开关、渠道、板块的选项、总则）
  app.get('/api/gifts/rules', { preHandler: guardAny('gift.manage', 'gift.issue', ...LEDGER_PERMS) }, async () => loadGiftRules(sql));
  app.put('/api/gifts/rules', { preHandler: guard('gift.manage') }, async (req) => saveGiftRules(deps, req.body, ctxOf(req)));

  // 知识库：发放的人选券种、前台看说明也要读
  app.get('/api/gifts/types', { preHandler: guardAny('gift.manage', 'gift.issue', ...LEDGER_PERMS) }, async () => readSnapshot(sql, async (tx) => listGiftTypes(tx, await today())));
  app.get('/api/gifts/meta', { preHandler: guard('gift.manage') }, async () => {
    const [items, ticketTypes] = [
      await sql<{ id: number; name: string; category: string; active: boolean }[]>`
        SELECT id, name, coalesce(nullif(category, ''), '未分类') AS category, active FROM service_items ORDER BY active DESC, category, name`,
      await sql<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM ticket_types ORDER BY active DESC, sort_order, id`,
    ];
    const categories = ['门票', '客房', ...new Set(items.map((i) => i.category).filter((c) => c !== '未分类')), '未分类'];
    return { items, ticketTypes, categories: [...new Set(categories)] };
  });
  app.post('/api/gifts/types', { preHandler: guard('gift.manage') }, async (req, reply) => {
    const t = await createGiftType(deps, req.body, ctxOf(req));
    reply.code(201);
    return t;
  });
  app.put('/api/gifts/types/:id', { preHandler: guard('gift.manage') }, async (req) => updateGiftType(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));

  // 发放
  app.get('/api/gifts/authorizers', { preHandler: guard('gift.issue') }, async () => giftAuthorizers(sql));
  app.get('/api/gifts/members', { preHandler: guard('gift.issue') }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { q } = parse(z.object({ q: z.string().trim().max(40, '搜索词最多 40 个字').default('') }), req.query ?? {});
    return maskCustomerPhones(await giftMembers(sql, q), req.actor);
  });
  app.post('/api/gifts/issues', { preHandler: guard('gift.issue') }, async (req, reply) => {
    const r = await issueGift(deps, req.body, ctxOf(req));
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  // 结果待确认时查回（不能断定没生效，只能原样重提或确认作废）
  app.get('/api/gifts/issues/by-key/:key', { preHandler: guard('gift.issue') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid('操作编号格式不正确') }), req.params);
    const [r] = await sql<{ id: number; issueNo: string }[]>`SELECT id, issue_no FROM coupon_issues WHERE client_key = ${key} AND authorized_by IS NOT NULL`;
    if (!r) throw notFound('没有找到这笔签赠');
    const coupons = await couponsOfIssue(sql, Number(r.id), await today());
    return { issueId: Number(r.id), issueNo: r.issueNo, replayed: true, coupons: coupons.map((c) => ({ id: c.id, code: c.code, validTo: c.validTo })) } satisfies GiftIssueResult;
  });

  // 作废签赠券：与券一样要「作废券」，或者「维护签赠」
  app.post('/api/gifts/coupons/:id/void', { preHandler: guardAny('coupon.void', 'gift.manage') }, async (req) => {
    await voidGift(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return { ok: true };
  });

  // 台账
  app.get('/api/gifts/ledger', { preHandler: guardAny(...LEDGER_PERMS) }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const f = ledgerFilter(req.query);
    return maskCustomerPhones(await readSnapshot(sql, async (tx) => giftLedger(tx, f, await today())), req.actor);
  });
  app.get('/api/gifts/ledger/export', { preHandler: guardAny(...LEDGER_PERMS) }, async (req, reply) => {
    const f = ledgerFilter(req.query);
    // 导出整份名单：维护签赠、管家部导出、客户部管理的人（只看台账的不能导）
    if (!can(req.actor, 'gift.manage') && !can(req.actor, 'concierge.export') && !can(req.actor, 'customer.manage')) throw forbidden('没有导出签赠台账的权限');
    const d = await today();
    const csv = await readSnapshot(sql, (tx) => giftLedgerCsv(tx, f, d, req.actor));
    return csvReply(reply, `签赠台账-${f.from}至${f.to}.csv`, csv);
  });
}
