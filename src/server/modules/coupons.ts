// 券与会员权益（v0.7.20，飞书 RQ-006 后半；docs/COUPONS.md）：券模板、发券规则、发券（手动、无记名批次、开卡礼、升级礼、生日礼、
// 充值赠券）、作废、会员的券、统计。结账用券与反结账退回在 coupon-checkout.ts。
//
//   · 模板发过券后，面额、折扣、门槛、范围、有效期、限定等级不能改（数据库触发器兜底）；发券在同一事务里对模板加共享锁，
//     改模板加排他锁，两边不会交错（改模板时看得到刚发的券）；
//   · 有效期按营业日算好写在券上：固定起止日期，或发券当天起 N 天；模板的固定有效期已过不能再发；
//   · 自动发券按「规则 + 会员 + 年份 / 充值单」去重（coupon_issues.dedupe_key 唯一），几个进程同时跑也只发一次；
//   · 手动发、批次、新建模板与发券规则带页面的操作编号（client_key 唯一），重复提交返回原记录；
//   · 券的状态是变动记录（coupon_events，只追加）的结果；过期不改数据，按有效期算。
// 加锁顺序：会员（充值事务里已锁）→ 模板（共享）；结账用券在会员、赠金批次之后锁券一行；作废只锁券（id 升序）。

import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import {
  COUPON_ALPHABET,
  COUPON_KINDS,
  COUPON_RULE_KINDS,
  COUPON_SCOPES,
  COUPON_VALIDITIES,
  couponState,
  couponTermsText,
  formatStoreCouponCode,
  MAX_BATCH_COUPONS,
  MAX_MANUAL_COUPONS,
  type CouponBatch,
  type CouponIssueKind,
  type CouponIssueResult,
  type CouponMeta,
  type CouponRow,
  type CouponRule,
  type CouponRuleKind,
  type CouponState,
  type CouponStats,
  type CouponTemplate,
  type CouponTerms,
  type MemberCoupons,
} from '@shared/coupons';
import { levelOf } from '@shared/frontdesk';
import { shiftDate } from '@shared/labels';
import { levelName } from '@shared/members';
import { can } from '@shared/permissions';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../db';
import { assertNotFenced } from '../lib/fences';
import { erpOpAbandoned } from './erp-ops';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { toCsv } from '../lib/csv';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { cents, idParam, parse, positiveCents } from '../lib/validate';
import { loadFrontdeskRules } from './frontdesk/common';
import { memberLevels } from './frontdesk/vip';
import { nextDocNo } from './inventory/common';
import { loadSettings } from './settings';

// ───────────────────────── 模板 ─────────────────────────

const TemplateFields = z.object({
  name: z.string('请填写券的名称').trim().min(1, '请填写券的名称').max(24, '名称最多 24 个字'),
  kind: z.enum(COUPON_KINDS, '请选择券的种类'),
  faceValue: positiveCents('面额').max(1_000_000, '面额最多 10,000 元').nullable().default(null),
  ratePercent: z.number('折扣必须是整数').int('折扣按百分比填，例如 88 表示 8.8 折').min(10, '折扣最低 1 折').max(99, '折扣最高 9.9 折').nullable().default(null),
  maxOff: positiveCents('最多抵扣').max(1_000_000, '最多抵扣 10,000 元').nullable().default(null),
  threshold: cents('门槛').max(100_000_000, '门槛过大').default(0),
  scope: z.enum(COUPON_SCOPES, '请选择适用范围').default('all'),
  scopeCategories: z.array(z.string().trim().min(1).max(64)).max(30, '最多选 30 个部门').default([]),
  scopeItems: z.array(z.number().int().positive()).max(100, '最多选 100 个项目').default([]),
  exchangeItemId: z.number().int().positive().nullable().default(null),
  exchangeTicketTypeId: z.number().int().positive().nullable().default(null),
  validity: z.enum(COUPON_VALIDITIES, '请选择有效期'),
  validFrom: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').nullable().default(null),
  validTo: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').nullable().default(null),
  validDays: z.number('有效天数必须是整数').int('有效天数必须是整数').min(1, '至少 1 天').max(3650, '最多 3650 天').nullable().default(null),
  levels: z.array(z.number().int().min(1).max(9)).max(9).default([]),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  active: z.boolean().default(true),
});
const TemplateInput = TemplateFields.superRefine((t, c) => {
  const issue = (message: string, path: string) => c.addIssue({ code: 'custom', message, path: [path] });
  if (t.kind === 'cash' && t.faceValue === null) issue('代金券请填写面额', 'faceValue');
  if (t.kind === 'discount' && t.ratePercent === null) issue('折扣券请填写几折', 'ratePercent');
  if (t.kind === 'exchange' && (t.exchangeItemId === null) === (t.exchangeTicketTypeId === null)) issue('兑换券请选一个价目项目或一个票种', 'exchangeItemId');
  if (t.kind !== 'exchange' && t.scope === 'categories' && t.scopeCategories.length === 0) issue('请选择适用的部门', 'scopeCategories');
  if (t.kind !== 'exchange' && t.scope === 'items' && t.scopeItems.length === 0) issue('请选择适用的项目', 'scopeItems');
  if (t.validity === 'fixed' && (!t.validFrom || !t.validTo)) issue('请填写起止日期', 'validFrom');
  if (t.validity === 'fixed' && t.validFrom && t.validTo && t.validFrom > t.validTo) issue('结束日期不能早于开始日期', 'validTo');
  if (t.validity === 'days' && t.validDays === null) issue('请填写有效天数', 'validDays');
});
const TemplateUpdate = TemplateFields.extend({ expectedVersion: z.number().int().positive('缺少版本号，请刷新后重试') });

/** 只留下这个种类用得到的条件，其余清空（与数据库约束一致） */
function normalizeTerms(t: z.infer<typeof TemplateFields>) {
  const exchange = t.kind === 'exchange';
  return {
    name: t.name,
    kind: t.kind,
    faceValue: t.kind === 'cash' ? t.faceValue : null,
    ratePercent: t.kind === 'discount' ? t.ratePercent : null,
    maxOff: t.kind === 'cash' ? null : t.maxOff,
    threshold: exchange ? 0 : t.threshold,
    scope: exchange ? ('all' as const) : t.scope,
    scopeCategories: !exchange && t.scope === 'categories' ? [...new Set(t.scopeCategories)] : [],
    scopeItems: !exchange && t.scope === 'items' ? [...new Set(t.scopeItems)].sort((a, b) => a - b) : [],
    exchangeItemId: exchange ? t.exchangeItemId : null,
    exchangeTicketTypeId: exchange ? t.exchangeTicketTypeId : null,
    validity: t.validity,
    validFrom: t.validity === 'fixed' ? t.validFrom : null,
    validTo: t.validity === 'fixed' ? t.validTo : null,
    validDays: t.validity === 'days' ? t.validDays : null,
    levels: [...new Set(t.levels)].sort((a, b) => a - b),
    note: t.note,
    active: t.active,
  };
}
type Normalized = ReturnType<typeof normalizeTerms>;

async function assertRefs(db: Db, t: Normalized) {
  if (t.scopeItems.length) {
    const found = await db<{ id: number }[]>`SELECT id FROM service_items WHERE id IN ${db(t.scopeItems)}`;
    if (found.length !== t.scopeItems.length) throw badRequest('有选中的项目不存在，请刷新后重选', { field: 'scopeItems' });
  }
  if (t.exchangeItemId !== null && !(await db`SELECT 1 FROM service_items WHERE id = ${t.exchangeItemId}`).length) {
    throw badRequest('兑换的项目不存在，请刷新后重选', { field: 'exchangeItemId' });
  }
  if (t.exchangeTicketTypeId !== null && !(await db`SELECT 1 FROM ticket_types WHERE id = ${t.exchangeTicketTypeId}`).length) {
    throw badRequest('兑换的票种不存在，请刷新后重选', { field: 'exchangeTicketTypeId' });
  }
  const rules = await loadFrontdeskRules(db);
  if (t.levels.some((l) => l > rules.vipLevelThresholds.length)) throw badRequest(`会员等级只有 ${rules.vipLevelThresholds.length} 级`, { field: 'levels' });
}

const TEMPLATE_SELECT = (db: Db) => db`
  SELECT t.id, t.name, t.kind, t.face_value, t.rate_percent, t.max_off, t.threshold, t.scope, t.scope_categories, t.scope_items,
         t.exchange_item_id, t.exchange_ticket_type_id, t.validity, t.valid_from, t.valid_to, t.valid_days, t.levels, t.note, t.active,
         t.version, t.created_at, s.display_name AS created_by_name, xi.name AS exchange_item_name, xt.name AS exchange_ticket_name,
         (SELECT count(*) FROM coupons c WHERE c.template_id = t.id)::int AS issued
  FROM coupon_templates t JOIN staff s ON s.id = t.created_by
  LEFT JOIN service_items xi ON xi.id = t.exchange_item_id LEFT JOIN ticket_types xt ON xt.id = t.exchange_ticket_type_id`;

type TemplateRow = Omit<CouponTemplate, 'summary'> & { exchangeItemName: string | null; exchangeTicketName: string | null };

const termsOf = (t: CouponTerms): CouponTerms => ({
  kind: t.kind,
  faceValue: t.faceValue === null ? null : Number(t.faceValue),
  ratePercent: t.ratePercent,
  maxOff: t.maxOff === null ? null : Number(t.maxOff),
  threshold: Number(t.threshold),
  scope: t.scope,
  scopeCategories: t.scopeCategories,
  scopeItems: t.scopeItems.map(Number),
  exchangeItemId: t.exchangeItemId === null ? null : Number(t.exchangeItemId),
  exchangeTicketTypeId: t.exchangeTicketTypeId === null ? null : Number(t.exchangeTicketTypeId),
});
const summaryOf = (t: CouponTerms & { exchangeItemName?: string | null; exchangeTicketName?: string | null }) =>
  couponTermsText(termsOf(t), {
    items: t.exchangeItemId !== null && t.exchangeItemName ? { [Number(t.exchangeItemId)]: t.exchangeItemName } : {},
    ticketTypes: t.exchangeTicketTypeId !== null && t.exchangeTicketName ? { [Number(t.exchangeTicketTypeId)]: t.exchangeTicketName } : {},
  });

function toTemplate(r: TemplateRow): CouponTemplate {
  const { exchangeItemName: _i, exchangeTicketName: _t, ...rest } = r;
  return {
    ...rest,
    ...termsOf(r),
    levels: r.levels.map(Number),
    createdAt: new Date(r.createdAt).toISOString(),
    summary: summaryOf(r),
  };
}

export async function listTemplates(db: Db): Promise<CouponTemplate[]> {
  const rows = await db<TemplateRow[]>`${TEMPLATE_SELECT(db)} ORDER BY t.active DESC, t.id DESC`;
  return rows.map(toTemplate);
}

export async function getTemplate(db: Db, id: number): Promise<CouponTemplate> {
  const [r] = await db<TemplateRow[]>`${TEMPLATE_SELECT(db)} WHERE t.id = ${id}`;
  if (!r) throw notFound('券模板不存在');
  return toTemplate(r);
}

const CreateKey = z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') });

export async function createTemplate(deps: Deps, raw: unknown, ctx: OpContext): Promise<CouponTemplate> {
  const { clientKey } = parse(CreateKey, raw);
  const t = normalizeTerms(parse(TemplateInput, raw));
  // 同一操作编号已建过（没收到结果再提交）：同一个人、同一种券返回原来那个，否则拒绝（名称之后可能改过，不比）
  const replay = async () => {
    const [p] = await deps.sql<{ id: number; kind: string; createdBy: number }[]>`SELECT id, kind, created_by FROM coupon_templates WHERE client_key = ${clientKey}`;
    if (!p) return null;
    if (p.kind !== t.kind || Number(p.createdBy) !== ctx.actor.id) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一个券模板，请刷新页面后重新填写');
    return getTemplate(deps.sql, p.id);
  };
  const prior = await replay();
  if (prior) return prior;
  try {
    const id = await deps.sql.begin(async (tx) => {
      // 与「确认作废」串行：已作废的编号整笔拒绝（结果待确认，Codex 复审 6c3765c）
      await assertNotFenced(tx, clientKey, 'coupon_template', erpOpAbandoned);
      await assertRefs(tx, t);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO coupon_templates (name, kind, face_value, rate_percent, max_off, threshold, scope, scope_categories, scope_items,
                                      exchange_item_id, exchange_ticket_type_id, validity, valid_from, valid_to, valid_days, levels, note, active, created_by, client_key)
        VALUES (${t.name}, ${t.kind}, ${t.faceValue}, ${t.ratePercent}, ${t.maxOff}, ${t.threshold}, ${t.scope}, ${t.scopeCategories}::text[],
                ${t.scopeItems}::bigint[], ${t.exchangeItemId}, ${t.exchangeTicketTypeId}, ${t.validity}, ${t.validFrom}, ${t.validTo}, ${t.validDays},
                ${t.levels}::smallint[], ${t.note}, ${t.active}, ${ctx.actor.id}, ${clientKey})
        RETURNING id`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'coupon_template_saved', targetType: 'coupon_template', targetId: row!.id, detail: { created: t }, ip: ctx.ip });
      return row!.id;
    });
    return getTemplate(deps.sql, id);
  } catch (error) {
    // 同一编号的两次提交同时到：后到的一次等先到的提交后撞唯一约束，返回先到的那个
    if (isUniqueViolation(error, 'coupon_templates_client_key_key')) {
      const again = await replay();
      if (again) return again;
    }
    throw error;
  }
}

const TERM_KEYS = [
  'kind', 'faceValue', 'ratePercent', 'maxOff', 'threshold', 'scope', 'scopeCategories', 'scopeItems', 'exchangeItemId', 'exchangeTicketTypeId',
  'validity', 'validFrom', 'validTo', 'validDays', 'levels',
] as const;

/** 改模板：带版本号（对不上拒绝）；发过券的只能改名称、备注、停用 */
export async function updateTemplate(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<CouponTemplate> {
  const input = parse(TemplateUpdate, raw);
  const t = normalizeTerms(parse(TemplateInput, input));
  await deps.sql.begin(async (tx) => {
    const [cur] = await tx<TemplateRow[]>`${TEMPLATE_SELECT(tx)} WHERE t.id = ${id} FOR UPDATE OF t`;
    if (!cur) throw notFound('券模板不存在');
    if (cur.version !== input.expectedVersion) throw conflict('TEMPLATE_STALE', '这个券模板刚刚被别人改过，请刷新后重新填写');
    // 排他锁之后再数一次已发的券（发券对模板加共享锁，排在这之前的已经提交）
    const [counted] = await tx<{ issued: number }[]>`SELECT count(*)::int AS issued FROM coupons WHERE template_id = ${id}`;
    const issued = counted!.issued;
    const before = { ...termsOf(cur), validity: cur.validity, validFrom: cur.validFrom, validTo: cur.validTo, validDays: cur.validDays, levels: cur.levels.map(Number) };
    const changed = TERM_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(t[k]));
    if (issued > 0 && changed.length) {
      throw conflict('TEMPLATE_LOCKED', `这个模板已经发过 ${issued} 张券，面额、折扣、门槛、范围、有效期、等级都不能改，只能改名称、备注或停用；要改请另建模板`, {
        fields: changed,
      });
    }
    await assertRefs(tx, t);
    await tx`
      UPDATE coupon_templates SET name = ${t.name}, kind = ${t.kind}, face_value = ${t.faceValue}, rate_percent = ${t.ratePercent}, max_off = ${t.maxOff},
             threshold = ${t.threshold}, scope = ${t.scope}, scope_categories = ${t.scopeCategories}::text[], scope_items = ${t.scopeItems}::bigint[],
             exchange_item_id = ${t.exchangeItemId}, exchange_ticket_type_id = ${t.exchangeTicketTypeId}, validity = ${t.validity},
             valid_from = ${t.validFrom}, valid_to = ${t.validTo}, valid_days = ${t.validDays}, levels = ${t.levels}::smallint[], note = ${t.note},
             active = ${t.active}, version = version + 1, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'coupon_template_saved',
      targetType: 'coupon_template',
      targetId: id,
      detail: { name: t.name, active: t.active, changed: changed.length ? changed : undefined, nameBefore: cur.name, activeBefore: cur.active },
      ip: ctx.ip,
    });
  });
  return getTemplate(deps.sql, id);
}

// ───────────────────────── 发券 ─────────────────────────

interface LockedTemplate extends CouponTerms {
  id: number;
  name: string;
  validity: 'fixed' | 'days';
  validFrom: string | null;
  validTo: string | null;
  validDays: number | null;
  levels: number[];
  active: boolean;
}

/** 发券前对模板加共享锁（改模板加排他锁，两边串行） */
async function lockTemplate(tx: Tx, id: number): Promise<LockedTemplate | null> {
  const [t] = await tx<LockedTemplate[]>`
    SELECT id, name, kind, face_value, rate_percent, max_off, threshold, scope, scope_categories, scope_items, exchange_item_id, exchange_ticket_type_id,
           validity, valid_from, valid_to, valid_days, levels, active
    FROM coupon_templates WHERE id = ${id} FOR SHARE`;
  return t ? { ...t, ...termsOf(t), levels: t.levels.map(Number) } : null;
}

/** 这张模板在营业日 date 发的券的有效期；固定有效期已过返回 null */
export function validRange(t: Pick<LockedTemplate, 'validity' | 'validFrom' | 'validTo' | 'validDays'>, date: string): { from: string; to: string } | null {
  if (t.validity === 'fixed') return t.validTo! < date ? null : { from: t.validFrom!, to: t.validTo! };
  return { from: date, to: shiftDate(date, t.validDays! - 1) };
}

function newCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += COUPON_ALPHABET[randomInt(COUPON_ALPHABET.length)];
  return s;
}

interface IssueSpec {
  kind: CouponIssueKind;
  template: LockedTemplate;
  memberId: number | null;
  quantity: number;
  ruleId?: number | null;
  rechargeId?: number | null;
  level?: number | null;
  reason?: string;
  clientKey?: string | null;
  dedupeKey?: string | null;
  staffId: number | null;
  at: Date;
  date: string;
}

/**
 * 写一次发券（在调用方的事务里，模板已加共享锁）：发券记录 + quantity 张券。自动发券带去重键，已发过返回 null；
 * 模板固定有效期已过：手动、批次报错，自动的跳过（返回 null）
 */
async function writeIssue(tx: Tx, o: IssueSpec): Promise<{ issueId: number; issueNo: string; couponIds: number[] } | null> {
  const range = validRange(o.template, o.date);
  if (!range) {
    if (o.dedupeKey) return null;
    throw unprocessable('TEMPLATE_EXPIRED', `券模板「${o.template.name}」的有效期到 ${o.template.validTo} 已经过了，不能再发；请另建模板`);
  }
  const issueNo = await nextDocNo(tx, 'coupon_issue', 'FQ', o.date);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, rule_id, recharge_id, level, reason, client_key, dedupe_key,
                               issued_by, issued_at, business_date)
    VALUES (${issueNo}, ${o.kind}, ${o.template.id}, ${o.memberId}, ${o.quantity}, ${o.ruleId ?? null}, ${o.rechargeId ?? null}, ${o.level ?? null},
            ${o.reason ?? ''}, ${o.clientKey ?? null}, ${o.dedupeKey ?? null}, ${o.staffId}, ${o.at}, ${o.date})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id`;
  if (!row) return null;
  const couponIds: number[] = [];
  for (let i = 0; i < o.quantity; i++) {
    // 券码 12 位、32 个字符（约 1.2 × 10¹⁸ 种），撞上已有的就换一个
    for (let attempt = 0; ; attempt++) {
      const code = newCode();
      const [c] = await tx<{ id: number }[]>`
        INSERT INTO coupons (code, issue_id, template_id, member_id, valid_from, valid_to, created_at)
        VALUES (${code}, ${row.id}, ${o.template.id}, ${o.memberId}, ${range.from}, ${range.to}, ${o.at})
        ON CONFLICT (code) DO NOTHING RETURNING id`;
      if (c) {
        couponIds.push(c.id);
        break;
      }
      if (attempt > 5) throw new Error('券码连续重复，请重试');
    }
  }
  return { issueId: row.id, issueNo, couponIds };
}

const levelAllowed = (t: Pick<LockedTemplate, 'levels'>, level: number) => t.levels.length === 0 || t.levels.includes(level);

async function issueDate(db: Db, deps: Pick<Deps, 'config'>, at: Date) {
  const settings = await loadSettings(db);
  return businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
}

/**
 * 按规则自动发券（开卡礼、升级礼、生日礼、充值赠券），在调用方的事务里：停用的规则、停用的模板、等级不在模板限定里的、
 * 模板固定有效期已过的都跳过；按去重键只发一次。返回发出的发券记录
 */
export async function issueByRules(
  tx: Tx,
  o: { kind: CouponRuleKind; memberId: number; memberLevel: number; ruleLevel?: number; planId?: number; rechargeId?: number; year?: string; staffId: number | null; at: Date; date: string },
) {
  const rules = await tx<{ id: number; templateId: number; quantity: number; level: number | null }[]>`
    SELECT id, template_id, quantity, level FROM coupon_rules
    WHERE active AND kind = ${o.kind}
      AND (${o.ruleLevel ?? null}::smallint IS NULL OR level = ${o.ruleLevel ?? null})
      AND (${o.planId ?? null}::bigint IS NULL OR plan_id = ${o.planId ?? null})
    ORDER BY id`;
  const issued: { issueNo: string; templateId: number; quantity: number }[] = [];
  for (const r of rules) {
    const dedupeKey =
      o.kind === 'open_card'
        ? `open_card:r${r.id}:m${o.memberId}`
        : o.kind === 'level_up'
          ? `level_up:r${r.id}:m${o.memberId}`
          : o.kind === 'birthday'
            ? `birthday:r${r.id}:m${o.memberId}:y${o.year}`
            : `recharge:r${r.id}:k${o.rechargeId}`;
    if ((await tx`SELECT 1 FROM coupon_issues WHERE dedupe_key = ${dedupeKey}`).length) continue;
    const template = await lockTemplate(tx, r.templateId);
    if (!template?.active || !levelAllowed(template, o.memberLevel)) continue;
    const done = await writeIssue(tx, {
      kind: o.kind,
      template,
      memberId: o.memberId,
      quantity: r.quantity,
      ruleId: r.id,
      rechargeId: o.rechargeId ?? null,
      level: o.kind === 'level_up' || o.kind === 'birthday' ? (r.level ?? o.memberLevel) : null,
      dedupeKey,
      staffId: o.staffId,
      at: o.at,
      date: o.date,
    });
    if (done) issued.push({ issueNo: done.issueNo, templateId: template.id, quantity: r.quantity });
  }
  return issued;
}

/** 开卡礼：会员建档的事务里调用（期初导入的会员不走这里） */
export async function issueOpenCardCoupons(tx: Tx, deps: Pick<Deps, 'config'>, memberId: number, ctx: OpContext) {
  const at = ctx.at ?? new Date();
  const rules = await loadFrontdeskRules(tx);
  const issued = await issueByRules(tx, {
    kind: 'open_card',
    memberId,
    memberLevel: levelOf(0, rules.vipLevelThresholds),
    staffId: ctx.actor.id,
    at,
    date: await issueDate(tx, deps, at),
  });
  if (issued.length) {
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'coupon_issued', targetType: 'member', targetId: memberId, detail: { kind: 'open_card', issued }, ip: ctx.ip });
  }
}

/**
 * 充值赠券与升级礼：充值的事务里（会员已锁、充值单已记）调用。
 * levelBefore / levelAfter 是这笔充值前后的等级（与 VIP 柜同一口径）；新达到的每一级发升级礼
 */
export async function issueRechargeCoupons(
  tx: Tx,
  o: { memberId: number; planId: number | null; rechargeId: number; levelBefore: number; levelAfter: number; staffId: number; at: Date; date: string; ip?: string },
) {
  const issued = [];
  if (o.planId !== null) {
    issued.push(...(await issueByRules(tx, { kind: 'recharge', memberId: o.memberId, memberLevel: o.levelAfter, planId: o.planId, rechargeId: o.rechargeId, staffId: o.staffId, at: o.at, date: o.date })));
  }
  for (let level = o.levelBefore + 1; level <= o.levelAfter; level++) {
    issued.push(...(await issueByRules(tx, { kind: 'level_up', memberId: o.memberId, memberLevel: level, ruleLevel: level, staffId: o.staffId, at: o.at, date: o.date })));
  }
  if (issued.length) {
    await writeAudit(tx, {
      staffId: o.staffId,
      action: 'coupon_issued',
      targetType: 'member',
      targetId: o.memberId,
      detail: { kind: 'recharge', rechargeId: o.rechargeId, levelBefore: o.levelBefore, levelAfter: o.levelAfter, issued },
      ip: o.ip,
      businessDate: o.date,
    });
  }
  return issued;
}

/**
 * 生日礼：会员生日当月发（营业日的月份），每年每条规则一次，按此刻的等级选规则；当月才建档、才补填生日的下一次检查时补发。
 * 由应用的定时任务每 10 分钟调用；返回这次发了几位会员
 */
export async function issueBirthdayCoupons(deps: Pick<Deps, 'sql' | 'config'>, now = new Date()): Promise<number> {
  const { sql } = deps;
  const rules = await sql<{ id: number; level: number }[]>`
    SELECT r.id, r.level FROM coupon_rules r JOIN coupon_templates t ON t.id = r.template_id
    WHERE r.active AND r.kind = 'birthday' AND t.active`;
  if (!rules.length) return 0;
  const date = await issueDate(sql, deps, now);
  const year = date.slice(0, 4);
  const month = date.slice(5, 7);
  const candidates = await sql<{ id: number }[]>`
    SELECT m.id FROM members m
    WHERE m.status = 'active' AND m.birthday IS NOT NULL AND to_char(m.birthday, 'MM') = ${month}
      AND EXISTS (SELECT 1 FROM coupon_rules r WHERE r.active AND r.kind = 'birthday'
                  AND NOT EXISTS (SELECT 1 FROM coupon_issues i WHERE i.dedupe_key = 'birthday:r' || r.id || ':m' || m.id || ':y' || ${year}))
    ORDER BY m.id LIMIT 500`;
  if (!candidates.length) return 0;
  const levels = await memberLevels(sql, candidates.map((c) => c.id), await loadFrontdeskRules(sql));
  let members = 0;
  for (const c of candidates) {
    const level = levels.get(c.id)?.level ?? 0;
    if (!rules.some((r) => r.level === level)) continue;
    const issued = await sql.begin(async (tx) => {
      const out = await issueByRules(tx, { kind: 'birthday', memberId: c.id, memberLevel: level, ruleLevel: level, year, staffId: null, at: now, date });
      if (out.length) {
        await writeAudit(tx, { staffId: null, action: 'coupon_issued', targetType: 'member', targetId: c.id, detail: { kind: 'birthday', year, level, issued: out }, businessDate: date });
      }
      return out.length;
    });
    if (issued) members += 1;
  }
  return members;
}

// ── 手动发、无记名批次 ──

const ManualIssueInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  templateId: z.number('请选择券').int().positive('请选择券'),
  quantity: z.number('张数必须是整数').int('张数必须是整数').min(1, '至少 1 张').max(MAX_MANUAL_COUPONS, `一次最多发 ${MAX_MANUAL_COUPONS} 张`),
  reason: z.string('请填写发券原因').trim().min(2, '请填写发券原因（至少 2 个字）').max(200, '原因最多 200 字'),
});
const BatchInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  templateId: z.number('请选择券').int().positive('请选择券'),
  quantity: z.number('张数必须是整数').int('张数必须是整数').min(1, '至少 1 张').max(MAX_BATCH_COUPONS, `一批最多 ${MAX_BATCH_COUPONS} 张`),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
});

/** 同一操作编号已有发券记录：同一笔返回原记录，不同的拒绝 */
async function replayIssue(db: Db, key: string, expect: { kind: 'manual' | 'batch'; templateId: number; memberId: number | null; quantity: number }) {
  const [r] = await db<{ id: number; issueNo: string; kind: string; templateId: number; memberId: number | null; quantity: number }[]>`
    SELECT id, issue_no, kind, template_id, member_id, quantity FROM coupon_issues WHERE client_key = ${key}`;
  if (!r) return null;
  if (r.kind !== expect.kind || r.templateId !== expect.templateId || r.memberId !== expect.memberId || r.quantity !== expect.quantity) {
    throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔发券，请刷新页面后重新发起');
  }
  return r;
}

export async function issueToMember(deps: Deps, memberId: number, raw: unknown, ctx: OpContext): Promise<CouponIssueResult> {
  const input = parse(ManualIssueInput, raw);
  const expect = { kind: 'manual' as const, templateId: input.templateId, memberId, quantity: input.quantity };
  const prior = await replayIssue(deps.sql, input.clientKey, expect);
  const now = async () => issueDate(deps.sql, deps, new Date());
  if (prior) return { issueId: prior.id, issueNo: prior.issueNo, replayed: true, coupons: await couponsOfIssue(deps.sql, prior.id, await now()) };
  try {
    const issue = await deps.sql.begin(async (tx) => {
      await assertNotFenced(tx, input.clientKey, 'coupon_issue', erpOpAbandoned);
      const [m] = await tx<{ id: number; name: string; status: string }[]>`SELECT id, name, status FROM members WHERE id = ${memberId}`;
      if (!m) throw notFound('会员不存在');
      if (m.status !== 'active') throw unprocessable('MEMBER_FROZEN', `会员「${m.name}」已停用，不能发券`);
      const template = await lockTemplate(tx, input.templateId);
      if (!template) throw notFound('券模板不存在');
      if (!template.active) throw unprocessable('TEMPLATE_INACTIVE', `券「${template.name}」已停用，不能再发`);
      const level = (await memberLevels(tx, [memberId], await loadFrontdeskRules(tx))).get(memberId)?.level ?? 0;
      if (!levelAllowed(template, level)) {
        throw unprocessable('COUPON_LEVEL', `券「${template.name}」只发给第 ${template.levels.join('、')} 级会员，这位会员现在是第 ${level} 级`);
      }
      const at = ctx.at ?? new Date();
      const date = await issueDate(tx, deps, at);
      const done = (await writeIssue(tx, {
        kind: 'manual',
        template,
        memberId,
        quantity: input.quantity,
        reason: input.reason,
        clientKey: input.clientKey,
        staffId: ctx.actor.id,
        at,
        date,
      }))!;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'coupon_issued',
        targetType: 'member',
        targetId: memberId,
        detail: { kind: 'manual', issueNo: done.issueNo, template: template.name, quantity: input.quantity, reason: input.reason },
        ip: ctx.ip,
        businessDate: date,
      });
      return { ...done, date };
    });
    return { issueId: issue.issueId, issueNo: issue.issueNo, replayed: false, coupons: await couponsOfIssue(deps.sql, issue.issueId, issue.date) };
  } catch (error) {
    // 同一编号并发提交：后到的撞上唯一约束，查回第一次的结果
    if (isUniqueViolation(error, 'coupon_issues_client_key_key')) {
      const again = await replayIssue(deps.sql, input.clientKey, expect);
      if (again) return { issueId: again.id, issueNo: again.issueNo, replayed: true, coupons: await couponsOfIssue(deps.sql, again.id, await now()) };
    }
    throw error;
  }
}

/** 生成一批无记名券，返回批次（发券记录）编号 */
export async function createBatch(deps: Deps, raw: unknown, ctx: OpContext): Promise<{ id: number; replayed: boolean }> {
  const input = parse(BatchInput, raw);
  const expect = { kind: 'batch' as const, templateId: input.templateId, memberId: null, quantity: input.quantity };
  const prior = await replayIssue(deps.sql, input.clientKey, expect);
  if (prior) return { id: prior.id, replayed: true };
  try {
    const id = await deps.sql.begin(async (tx) => {
      await assertNotFenced(tx, input.clientKey, 'coupon_batch', erpOpAbandoned);
      const template = await lockTemplate(tx, input.templateId);
      if (!template) throw notFound('券模板不存在');
      if (!template.active) throw unprocessable('TEMPLATE_INACTIVE', `券「${template.name}」已停用，不能再发`);
      if (template.levels.length) throw unprocessable('COUPON_LEVEL', `券「${template.name}」限定了会员等级，无记名券不能用；请另建不限等级的模板`);
      const at = ctx.at ?? new Date();
      const date = await issueDate(tx, deps, at);
      const done = (await writeIssue(tx, { kind: 'batch', template, memberId: null, quantity: input.quantity, reason: input.note, clientKey: input.clientKey, staffId: ctx.actor.id, at, date }))!;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'coupon_batch_created',
        targetType: 'coupon_issue',
        targetId: done.issueId,
        detail: { issueNo: done.issueNo, template: template.name, quantity: input.quantity, note: input.note },
        ip: ctx.ip,
        businessDate: date,
      });
      return done.issueId;
    });
    return { id, replayed: false };
  } catch (error) {
    if (isUniqueViolation(error, 'coupon_issues_client_key_key')) {
      const again = await replayIssue(deps.sql, input.clientKey, expect);
      if (again) return { id: again.id, replayed: true };
    }
    throw error;
  }
}

// ───────────────────────── 作废 ─────────────────────────

const VoidInput = z.object({ reason: z.string('请填写作废原因').trim().min(2, '请填写作废原因（至少 2 个字）').max(200, '原因最多 200 字') });

/** 作废没用过的券（含已过期的）；用过的不能作废（反结账会退回） */
export async function voidCoupon(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<void> {
  const { reason } = parse(VoidInput, raw);
  await deps.sql.begin(async (tx) => {
    const [c] = await tx<{ id: number; code: string; status: string; memberId: number | null }[]>`
      SELECT id, code, status, member_id FROM coupons WHERE id = ${id} FOR UPDATE`;
    if (!c) throw notFound('券不存在');
    if (c.status === 'voided') throw conflict('ALREADY_VOIDED', '这张券已经作废');
    if (c.status === 'used') throw conflict('COUPON_USED', '这张券已经用过了，不能作废；要退回请反结账');
    const at = ctx.at ?? new Date();
    const date = await issueDate(tx, deps, at);
    await tx`UPDATE coupons SET status = 'voided' WHERE id = ${c.id}`;
    await tx`INSERT INTO coupon_events (coupon_id, kind, reason, staff_id, at, business_date) VALUES (${c.id}, 'void', ${reason}, ${ctx.actor.id}, ${at}, ${date})`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'coupon_voided', targetType: 'coupon', targetId: c.id, detail: { code: formatStoreCouponCode(c.code), memberId: c.memberId, reason }, ip: ctx.ip, businessDate: date });
  });
}

/** 按批次作废还没用的无记名券（id 升序锁券） */
export async function voidBatch(deps: Deps, issueId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const { reason } = parse(VoidInput, raw);
  await deps.sql.begin(async (tx) => {
    const [b] = await tx<{ id: number; issueNo: string; kind: string }[]>`SELECT id, issue_no, kind FROM coupon_issues WHERE id = ${issueId}`;
    if (!b || b.kind !== 'batch') throw notFound('无记名券批次不存在');
    const rows = await tx<{ id: number }[]>`SELECT id FROM coupons WHERE issue_id = ${issueId} AND status = 'available' ORDER BY id FOR UPDATE`;
    if (!rows.length) throw conflict('NOTHING_TO_VOID', `批次 ${b.issueNo} 没有还没用的券`);
    const at = ctx.at ?? new Date();
    const date = await issueDate(tx, deps, at);
    const ids = rows.map((r) => r.id);
    await tx`UPDATE coupons SET status = 'voided' WHERE id IN ${tx(ids)}`;
    await tx`
      INSERT INTO coupon_events (coupon_id, kind, reason, staff_id, at, business_date)
      SELECT unnest(${ids}::bigint[]), 'void', ${reason}, ${ctx.actor.id}, ${at}, ${date}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'coupon_voided', targetType: 'coupon_issue', targetId: issueId, detail: { issueNo: b.issueNo, count: ids.length, reason }, ip: ctx.ip, businessDate: date });
  });
}

// ───────────────────────── 发券规则 ─────────────────────────

const RuleInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  kind: z.enum(COUPON_RULE_KINDS, '请选择规则的种类'),
  level: z.number().int().min(1).max(9).nullable().default(null),
  planId: z.number().int().positive().nullable().default(null),
  templateId: z.number('请选择券').int().positive('请选择券'),
  quantity: z.number('张数必须是整数').int('张数必须是整数').min(1, '至少 1 张').max(MAX_MANUAL_COUPONS, `最多 ${MAX_MANUAL_COUPONS} 张`),
});

export async function listRules(db: Db): Promise<CouponRule[]> {
  const rows = await db<CouponRule[]>`
    SELECT r.id, r.kind, r.level, r.plan_id, p.name AS plan_name, r.template_id, t.name AS template_name, t.active AS template_active, r.quantity, r.active,
           r.created_at, cs.display_name AS created_by_name, r.deactivated_at, ds.display_name AS deactivated_by_name,
           (SELECT count(*) FROM coupon_issues i WHERE i.rule_id = r.id)::int AS issued_times
    FROM coupon_rules r JOIN coupon_templates t ON t.id = r.template_id JOIN staff cs ON cs.id = r.created_by
    LEFT JOIN recharge_plans p ON p.id = r.plan_id LEFT JOIN staff ds ON ds.id = r.deactivated_by
    ORDER BY r.active DESC, r.kind, r.level NULLS FIRST, r.id`;
  return rows.map((r) => ({
    ...r,
    createdAt: new Date(r.createdAt).toISOString(),
    deactivatedAt: r.deactivatedAt ? new Date(r.deactivatedAt).toISOString() : null,
  }));
}

export async function createRule(deps: Deps, raw: unknown, ctx: OpContext): Promise<{ ruleId: number; rules: CouponRule[] }> {
  const input = parse(RuleInput, raw);
  const needsLevel = input.kind === 'level_up' || input.kind === 'birthday';
  if (needsLevel && input.level === null) throw badRequest('升级礼、生日礼请选择会员等级', { field: 'level' });
  if (input.kind === 'recharge' && input.planId === null) throw badRequest('充值赠券请选择充值套餐', { field: 'planId' });
  const level = needsLevel ? input.level : null;
  const planId = input.kind === 'recharge' ? input.planId : null;
  // 同一操作编号已加过（没收到结果再提交）：同一条返回那条规则，不同的拒绝——重复的规则会重复发券
  const replayed = async (db: Db) => {
    const [p] = await db<{ id: number; kind: string; level: number | null; planId: number | null; templateId: number; quantity: number }[]>`
      SELECT id, kind, level, plan_id, template_id, quantity FROM coupon_rules WHERE client_key = ${input.clientKey}`;
    if (!p) return null;
    const same = p.kind === input.kind && p.level === level && (p.planId === null ? null : Number(p.planId)) === planId && Number(p.templateId) === input.templateId && p.quantity === input.quantity;
    if (!same) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一条发券规则，请刷新页面后重新填写');
    return Number(p.id);
  };
  const prior = await replayed(deps.sql);
  if (prior !== null) return { ruleId: prior, rules: await listRules(deps.sql) };
  let ruleId: number;
  try {
    ruleId = await deps.sql.begin(async (tx) => {
      // 与「确认作废」串行：已作废的编号整笔拒绝；同一编号的两次提交排队，后到的返回先到的那条
      await assertNotFenced(tx, input.clientKey, 'coupon_rule', erpOpAbandoned);
      const again = await replayed(tx);
      if (again !== null) return again;
      const template = await lockTemplate(tx, input.templateId);
      if (!template) throw notFound('券模板不存在');
      if (!template.active) throw unprocessable('TEMPLATE_INACTIVE', `券「${template.name}」已停用`);
      const rules = await loadFrontdeskRules(tx);
      if (needsLevel && input.level! > rules.vipLevelThresholds.length) throw badRequest(`会员等级只有 ${rules.vipLevelThresholds.length} 级`, { field: 'level' });
      if (needsLevel && !levelAllowed(template, input.level!)) {
        throw unprocessable('COUPON_LEVEL', `券「${template.name}」只发给第 ${template.levels.join('、')} 级会员，不能配给第 ${input.level} 级`);
      }
      if (input.kind === 'recharge' && !(await tx`SELECT 1 FROM recharge_plans WHERE id = ${input.planId}`).length) throw notFound('充值套餐不存在');
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO coupon_rules (kind, level, plan_id, template_id, quantity, created_by, client_key)
        VALUES (${input.kind}, ${level}, ${planId}, ${input.templateId}, ${input.quantity}, ${ctx.actor.id}, ${input.clientKey})
        RETURNING id`;
      const { clientKey: _key, ...created } = input;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'coupon_rule_saved', targetType: 'coupon_rule', targetId: row!.id, detail: { created, template: template.name }, ip: ctx.ip });
      return Number(row!.id);
    });
  } catch (error) {
    // 同一编号的两次提交同时到：后到的一次撞唯一约束，按先到的那条返回
    const again = isUniqueViolation(error, 'coupon_rules_client_key_key') ? await replayed(deps.sql) : null;
    if (again === null) throw error;
    ruleId = again;
  }
  return { ruleId, rules: await listRules(deps.sql) };
}

export async function deactivateRule(deps: Deps, id: number, ctx: OpContext): Promise<CouponRule[]> {
  await deps.sql.begin(async (tx) => {
    const [r] = await tx<{ id: number; active: boolean }[]>`SELECT id, active FROM coupon_rules WHERE id = ${id} FOR UPDATE`;
    if (!r) throw notFound('发券规则不存在');
    if (!r.active) return;
    await tx`UPDATE coupon_rules SET active = false, deactivated_by = ${ctx.actor.id}, deactivated_at = now() WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'coupon_rule_saved', targetType: 'coupon_rule', targetId: id, detail: { deactivated: true }, ip: ctx.ip });
  });
  return listRules(deps.sql);
}

// ───────────────────────── 查询 ─────────────────────────

const COUPON_SELECT = (db: Db) => db`
  SELECT c.id, c.code, c.template_id, t.name AS template_name, t.kind, t.face_value, t.rate_percent, t.max_off, t.threshold, t.scope,
         t.scope_categories, t.scope_items, t.exchange_item_id, t.exchange_ticket_type_id, xi.name AS exchange_item_name, xt.name AS exchange_ticket_name,
         c.member_id, m.name AS member_name, c.valid_from, c.valid_to, c.status, i.issue_no, i.kind AS issue_kind, i.issued_at,
         s.display_name AS issued_by_name, ck.checkout_no,
         (SELECT e.amount FROM coupon_events e WHERE e.coupon_id = c.id AND e.kind = 'use' AND e.checkout_id = c.checkout_id ORDER BY e.id DESC LIMIT 1) AS used_amount,
         (SELECT e.reason FROM coupon_events e WHERE e.coupon_id = c.id AND e.kind = 'void' ORDER BY e.id DESC LIMIT 1) AS void_reason
  FROM coupons c JOIN coupon_templates t ON t.id = c.template_id JOIN coupon_issues i ON i.id = c.issue_id
  LEFT JOIN members m ON m.id = c.member_id LEFT JOIN staff s ON s.id = i.issued_by LEFT JOIN checkouts ck ON ck.id = c.checkout_id
  LEFT JOIN service_items xi ON xi.id = t.exchange_item_id LEFT JOIN ticket_types xt ON xt.id = t.exchange_ticket_type_id`;

type CouponDbRow = Omit<CouponRow, 'summary' | 'state'> & CouponTerms & { exchangeItemName: string | null; exchangeTicketName: string | null };

export function toCouponRow(r: CouponDbRow, today: string): CouponRow {
  return {
    id: r.id,
    code: r.code,
    templateId: r.templateId,
    templateName: r.templateName,
    kind: r.kind,
    summary: summaryOf(r),
    memberId: r.memberId,
    memberName: r.memberName,
    validFrom: r.validFrom,
    validTo: r.validTo,
    status: r.status,
    state: couponState(r, today),
    issueNo: r.issueNo,
    issueKind: r.issueKind,
    issuedAt: new Date(r.issuedAt).toISOString(),
    issuedByName: r.issuedByName,
    checkoutNo: r.checkoutNo,
    usedAmount: r.usedAmount === null ? null : Number(r.usedAmount),
    voidReason: r.voidReason,
  };
}

export async function couponsOfIssue(db: Db, issueId: number, today: string): Promise<CouponRow[]> {
  const rows = await db<CouponDbRow[]>`${COUPON_SELECT(db)} WHERE c.issue_id = ${issueId} ORDER BY c.id`;
  return rows.map((r) => toCouponRow(r, today));
}

export async function getCoupon(db: Db, id: number, today: string): Promise<CouponRow> {
  const [r] = await db<CouponDbRow[]>`${COUPON_SELECT(db)} WHERE c.id = ${id}`;
  if (!r) throw notFound('券不存在');
  return toCouponRow(r, today);
}

const emptyCounts = (): Record<CouponState, number> => ({ available: 0, pending: 0, expired: 0, used: 0, voided: 0 });

export async function memberCoupons(db: Db, memberId: number, today: string): Promise<MemberCoupons> {
  const rows = await db<CouponDbRow[]>`${COUPON_SELECT(db)} WHERE c.member_id = ${memberId} ORDER BY c.id DESC LIMIT 300`;
  const coupons = rows.map((r) => toCouponRow(r, today));
  const counts = emptyCounts();
  for (const c of coupons) counts[c.state] += 1;
  return { coupons, counts };
}

const BATCH_SELECT = (db: Db) => db`
  SELECT i.id, i.issue_no, i.template_id, t.name AS template_name, t.kind, t.face_value, t.rate_percent, t.max_off, t.threshold, t.scope,
         t.scope_categories, t.scope_items, t.exchange_item_id, t.exchange_ticket_type_id, xi.name AS exchange_item_name, xt.name AS exchange_ticket_name,
         i.quantity, i.reason AS note, i.issued_at, s.display_name AS issued_by_name,
         (SELECT min(valid_from) FROM coupons WHERE issue_id = i.id) AS valid_from, (SELECT max(valid_to) FROM coupons WHERE issue_id = i.id) AS valid_to,
         (SELECT json_agg(json_build_object('status', status, 'validFrom', valid_from, 'validTo', valid_to)) FROM coupons WHERE issue_id = i.id) AS coupons
  FROM coupon_issues i JOIN coupon_templates t ON t.id = i.template_id LEFT JOIN staff s ON s.id = i.issued_by
  LEFT JOIN service_items xi ON xi.id = t.exchange_item_id LEFT JOIN ticket_types xt ON xt.id = t.exchange_ticket_type_id
  WHERE i.kind = 'batch'`;
type BatchRow = Omit<CouponBatch, 'summary' | 'counts'> & CouponTerms & { exchangeItemName: string | null; exchangeTicketName: string | null; coupons: { status: 'available' | 'used' | 'voided'; validFrom: string; validTo: string }[] };

function toBatch(r: BatchRow, today: string): CouponBatch {
  const counts = emptyCounts();
  for (const c of r.coupons ?? []) counts[couponState(c, today)] += 1;
  return {
    id: r.id,
    issueNo: r.issueNo,
    templateId: r.templateId,
    templateName: r.templateName,
    summary: summaryOf(r),
    quantity: r.quantity,
    validFrom: r.validFrom,
    validTo: r.validTo,
    note: r.note,
    issuedAt: new Date(r.issuedAt).toISOString(),
    issuedByName: r.issuedByName,
    counts,
  };
}

export async function listBatches(db: Db, today: string): Promise<CouponBatch[]> {
  const rows = await db<BatchRow[]>`${BATCH_SELECT(db)} ORDER BY i.id DESC LIMIT 100`;
  return rows.map((r) => toBatch(r, today));
}

export async function getBatch(db: Db, id: number, today: string): Promise<CouponBatch> {
  const [r] = await db<BatchRow[]>`${BATCH_SELECT(db)} AND i.id = ${id}`;
  if (!r) throw notFound('无记名券批次不存在');
  return toBatch(r, today);
}

export async function couponMeta(db: Db): Promise<CouponMeta> {
  const items = await db<CouponMeta['items']>`SELECT id, name, coalesce(nullif(category, ''), '未分类') AS category, active FROM service_items ORDER BY active DESC, category, name`;
  const ticketTypes = await db<CouponMeta['ticketTypes']>`SELECT id, name, active FROM ticket_types ORDER BY active DESC, sort_order, id`;
  const plans = await db<CouponMeta['plans']>`SELECT id, name, pay_amount, bonus_amount, active FROM recharge_plans ORDER BY active DESC, sort_order, id`;
  const rules = await loadFrontdeskRules(db);
  const categories = ['门票', '客房', ...new Set(items.map((i) => i.category).filter((c) => c !== '未分类')), '未分类', '其他（手动金额、赔偿等）'];
  return {
    categories: [...new Set(categories)],
    items,
    ticketTypes,
    plans,
    levels: rules.vipLevelThresholds.map((_, i) => ({ level: i + 1, name: levelName(i + 1, rules.vipLevelNames) })),
  };
}

/** 统计：时段内按模板列发券、用券（张数、抵扣金额，反结账退回的冲减）、过期、作废 */
export async function couponStats(db: Db, from: string, to: string, today: string): Promise<CouponStats> {
  const rows = await db<CouponStats['rows']>`
    WITH iss AS (
      SELECT c.template_id, count(*)::int AS n FROM coupons c JOIN coupon_issues i ON i.id = c.issue_id
      WHERE i.business_date BETWEEN ${from} AND ${to} GROUP BY 1
    ), ev AS (
      SELECT c.template_id,
             (count(*) FILTER (WHERE e.kind = 'use') - count(*) FILTER (WHERE e.kind = 'return'))::int AS used,
             (coalesce(sum(e.amount) FILTER (WHERE e.kind = 'use'), 0) - coalesce(sum(e.amount) FILTER (WHERE e.kind = 'return'), 0))::bigint AS used_amount,
             count(*) FILTER (WHERE e.kind = 'void')::int AS voided
      FROM coupon_events e JOIN coupons c ON c.id = e.coupon_id WHERE e.business_date BETWEEN ${from} AND ${to} GROUP BY 1
    ), ex AS (
      SELECT template_id, count(*)::int AS n FROM coupons
      WHERE status = 'available' AND valid_to BETWEEN ${from} AND ${to} AND valid_to < ${today} GROUP BY 1
    )
    SELECT t.id AS template_id, t.name, t.kind, coalesce(iss.n, 0) AS issued, coalesce(ev.used, 0) AS used, coalesce(ev.used_amount, 0) AS used_amount,
           coalesce(ex.n, 0) AS expired, coalesce(ev.voided, 0) AS voided
    FROM coupon_templates t LEFT JOIN iss ON iss.template_id = t.id LEFT JOIN ev ON ev.template_id = t.id LEFT JOIN ex ON ex.template_id = t.id
    WHERE coalesce(iss.n, 0) <> 0 OR coalesce(ev.used, 0) <> 0 OR coalesce(ev.used_amount, 0) <> 0 OR coalesce(ex.n, 0) <> 0 OR coalesce(ev.voided, 0) <> 0
    ORDER BY t.id`;
  const totals = rows.reduce(
    (s, r) => ({ issued: s.issued + r.issued, used: s.used + r.used, usedAmount: s.usedAmount + Number(r.usedAmount), expired: s.expired + r.expired, voided: s.voided + r.voided }),
    { issued: 0, used: 0, usedAmount: 0, expired: 0, voided: 0 },
  );
  return { from, to, rows: rows.map((r) => ({ ...r, usedAmount: Number(r.usedAmount) })), totals };
}

/** 充值套餐挂的券（充值页选套餐时显示「另赠」） */
/**
 * 充值页的「另赠」：启用的充值赠券规则与模板；固定有效期已过的模板入账时不会发（自动发券跳过），这里也不列；
 * 限定了等级的带上等级（入账时按充值后的等级发，页面写明）
 */
export async function planGifts(db: Db, today: string) {
  const rows = await db<{ planId: number; templateId: number; templateName: string; quantity: number; levels: number[] }[]>`
    SELECT r.plan_id, r.template_id, t.name AS template_name, r.quantity, t.levels
    FROM coupon_rules r JOIN coupon_templates t ON t.id = r.template_id
    WHERE r.active AND r.kind = 'recharge' AND t.active AND NOT (t.validity = 'fixed' AND t.valid_to < ${today})
    ORDER BY r.plan_id, r.id`;
  return rows.map((r) => ({ ...r, planId: Number(r.planId), templateId: Number(r.templateId), levels: r.levels.map(Number) }));
}

// ───────────────────────── 接口 ─────────────────────────

export function registerCouponRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const ctxOf = (req: import('fastify').FastifyRequest): OpContext => ({ actor: req.actor, ip: req.ip });
  const today = () => issueDate(sql, deps, new Date());
  const Range = z.object({ from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'), to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD') });

  app.get('/api/coupons/meta', { preHandler: guard('coupon.manage') }, async () => couponMeta(sql));

  // 模板：维护要 coupon.manage；发券的人要能看到模板（选券）
  app.get('/api/coupons/templates', { preHandler: guard() }, async (req) => {
    if (!can(req.actor, 'coupon.manage') && !can(req.actor, 'coupon.issue')) throw forbidden('没有查看券模板的权限');
    return listTemplates(sql);
  });
  app.post('/api/coupons/templates', { preHandler: guard('coupon.manage') }, async (req) => createTemplate(deps, req.body, ctxOf(req)));
  app.put('/api/coupons/templates/:id', { preHandler: guard('coupon.manage') }, async (req) => updateTemplate(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));

  app.get('/api/coupons/rules', { preHandler: guard('coupon.manage') }, async () => listRules(sql));
  app.post('/api/coupons/rules', { preHandler: guard('coupon.manage') }, async (req) => createRule(deps, req.body, ctxOf(req)));
  app.post('/api/coupons/rules/:id/deactivate', { preHandler: guard('coupon.manage') }, async (req) => deactivateRule(deps, parse(idParam, req.params).id, ctxOf(req)));

  app.get('/api/coupons/plan-gifts', { preHandler: guard('recharge.create') }, async () => planGifts(sql, await today()));

  // 会员的券（看会员的岗位都能看）；手动发券
  app.get('/api/members/:id/coupons', { preHandler: guard('member.read') }, async (req) => memberCoupons(sql, parse(idParam, req.params).id, await today()));
  app.post('/api/members/:id/coupons', { preHandler: guard('coupon.issue') }, async (req, reply) => {
    const result = await issueToMember(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    reply.status(result.replayed ? 200 : 201);
    return result;
  });
  app.post('/api/coupons/:id/void', { preHandler: guard('coupon.void') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await voidCoupon(deps, id, req.body, ctxOf(req));
    return getCoupon(sql, id, await today());
  });

  // 无记名券：生成、列表、导出券码、按批次作废没用的
  app.get('/api/coupons/batches', { preHandler: guard('coupon.manage') }, async () => listBatches(sql, await today()));
  app.post('/api/coupons/batches', { preHandler: guard('coupon.manage') }, async (req, reply) => {
    const { id, replayed } = await createBatch(deps, req.body, ctxOf(req));
    reply.status(replayed ? 200 : 201);
    return getBatch(sql, id, await today());
  });
  app.get('/api/coupons/batches/:id/codes.csv', { preHandler: guard('coupon.manage') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const d = await today();
    const batch = await getBatch(sql, id, d);
    const rows = await sql<{ code: string; status: 'available' | 'used' | 'voided'; validFrom: string; validTo: string }[]>`
      SELECT code, status, valid_from, valid_to FROM coupons WHERE issue_id = ${id} ORDER BY id`;
    await writeAudit(sql, { staffId: req.actor.id, action: 'coupon_batch_exported', targetType: 'coupon_issue', targetId: id, detail: { issueNo: batch.issueNo, count: rows.length }, ip: req.ip });
    const csv = toCsv([
      ['券码', '券', '说明', '有效期', '状态'],
      ...rows.map((r) => [formatStoreCouponCode(r.code), batch.templateName, batch.summary, `${r.validFrom} 至 ${r.validTo}`, couponStateLabel(couponState(r, d))]),
    ]);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`无记名券-${batch.issueNo}.csv`)}`);
    reply.header('cache-control', 'no-store');
    return csv;
  });
  app.post('/api/coupons/batches/:id/void', { preHandler: guard('coupon.void') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await voidBatch(deps, id, req.body, ctxOf(req));
    return getBatch(sql, id, await today());
  });

  app.get('/api/coupons/stats', { preHandler: guard() }, async (req) => {
    if (!can(req.actor, 'coupon.manage') && !can(req.actor, 'report.members')) throw forbidden('没有查看券统计的权限');
    const { from, to } = parse(Range, req.query);
    if (from > to) throw badRequest('开始日期不能晚于结束日期');
    return readSnapshot(sql, async (tx) => couponStats(tx, from, to, await today()));
  });
}

const couponStateLabel = (s: CouponState) => ({ available: '可用', pending: '未生效', expired: '已过期', used: '已用', voided: '已作废' })[s];

