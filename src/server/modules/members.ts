import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { MEMBER_CHANNEL_KEY, type BonusLotRow } from '@shared/members';
import {
  MAX_PREFERRED_ITEM_LENGTH,
  MAX_PREFERRED_ITEMS,
  MEMBER_CARD_TYPE_LABELS,
  MEMBER_CARD_TYPES,
  MEMBER_FORM_FIELD_LABELS,
  type MemberCardType,
  type MemberFormField,
  type MemberFormRules,
} from '@shared/member-form';
import { MAX_GRADE } from '@shared/membership';
import type { LedgerRow, MemberDetail, MemberSummary } from '@shared/types';
import { looksLikeCardNo, normalizeCardNo } from '@shared/member-cards';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { consumeMemberPhoneGrant } from '../auth/grants';
import { can } from '@shared/permissions';
import { idParam, parse } from '../lib/validate';
import { expireMemberBonus, openLots } from './bonus';
import { issueOpenCardCoupons } from './coupons';
import { onMemberSaved } from './benefits';
import { erpOpAbandoned } from './erp-ops';
import { listLedger } from './ledger';
import { assertDepositPay, CardNo, DepositPayInput, heldCardDeposit } from './member-card-deposits';
import { issueCardInTx } from './member-cards';
import { assignInitialGrade, memberGradeInfo } from './membership';
import { loadSettings } from './settings';
import { lockPaymentShift, openShiftOf } from './shifts';
import { memberTagsOf, setMemberTags, TagIdsField } from './member-tags';
import { spendQuotaOf } from './spend-quota';

const MEMBER_COLUMNS = (db: Db) => db`
  m.id, m.member_no, m.name, m.phone, m.card_type, m.gender, m.birthday::text AS birthday, m.note,
  m.principal_balance, m.bonus_balance, m.status, m.is_synthetic, m.created_at, m.channel,
  m.grade, m.tier, m.cycle_end, m.grace_until, m.merged_into_id, m.referrer_member_id, m.preferred_items,
  (SELECT max(le.created_at) FROM ledger_entries le WHERE le.member_id = m.id) AS last_activity_at`;

const MemberInput = z.object({
  name: z.string().trim().min(1, '请填写会员姓名').max(32, '姓名最多 32 个字'),
  /** 手机号：只有匿名卡可以不留（8.1.15）——不带、null、空着都算没留；留了的照旧是 11 位手机号 */
  phone: z
    .string()
    .nullish()
    .transform((s) => (s ?? '').replace(/[\s-]/g, ''))
    .refine((s) => s === '' || /^1\d{10}$/.test(s), '请输入 11 位手机号')
    .transform((s) => s || null),
  gender: z.enum(['female', 'male']).nullable().default(null),
  birthday: z.iso.date('生日格式应为 YYYY-MM-DD').nullable().default(null),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  /** 会员标签（8.0.4，替代原来的自定义字段）：整组替换；编辑时不带则保持原样 */
  tagIds: TagIdsField.optional(),
  /** 渠道来源的编号；编辑时不带则保持原值，null 为清空 */
  channel: z.string().regex(MEMBER_CHANNEL_KEY, '渠道来源不正确').nullable().optional(),
  /** 推荐人（8.1.15）：另一位会员的编号；编辑时不带则保持原样，null 为清空 */
  referrerMemberId: z.number('推荐人不正确').int().positive('推荐人不正确').nullable().optional(),
  /** 偏好项目（8.1.15）：一组短文字，整组替换；编辑时不带则保持原样 */
  preferredItems: z
    .array(z.string().trim().min(1, '偏好项目不能为空').max(MAX_PREFERRED_ITEM_LENGTH, `每个偏好项目最多 ${MAX_PREFERRED_ITEM_LENGTH} 个字`), '偏好项目要是一组文字')
    .max(MAX_PREFERRED_ITEMS, `偏好项目最多 ${MAX_PREFERRED_ITEMS} 个`)
    .transform((l) => [...new Set(l)])
    .optional(),
});
export type MemberInputData = z.input<typeof MemberInput>;

/** 建档（8.1.15）：先选卡类型，再填表 */
const CreateInput = MemberInput.extend({
  /** 操作编号：匿名卡（没有手机号去重）、实体卡（同时收押金）必带；电子卡靠手机号不重复，原来的调用方可以不带 */
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试').optional(),
  cardType: z.enum(MEMBER_CARD_TYPES, '请选择卡类型').default('ecard'),
  /** 会员等级：不带、null = 按规则自动（从 L0 起，充值升档）；手动指定要「手动调整会员档阶」权限，要写原因 */
  grade: z
    .object({
      grade: z.number('请选择档级').int().min(0, '档级是 L0–L6').max(MAX_GRADE, '档级是 L0–L6'),
      tier: z.number('请选择阶位').int().min(0, '阶位是初、享、尊').max(2, '阶位是初、享、尊').nullable(),
      reason: z.string('请填写指定等级的原因').trim().min(2, '请填写指定等级的原因（至少 2 个字）').max(200, '原因最多 200 字'),
    })
    .refine((v) => (v.grade === 0) === (v.tier === null), { message: '只有 L0 没有阶位，L1–L6 请选择初、享、尊', path: ['tier'] })
    .nullish()
    .transform((v) => v ?? null),
  /** 实体卡：卡号与押金。实体卡必带；匿名卡可以带（配一张卡刷卡认人）；电子卡不带 */
  card: z
    .object({
      cardNo: CardNo,
      note: z.string().trim().max(100, '备注最多 100 字').default(''),
      deposit: DepositPayInput.nullish().transform((v) => v ?? null),
    })
    .nullish()
    .transform((v) => v ?? null),
});
export type MemberCreateData = z.input<typeof CreateInput>;
type ParsedCreate = z.output<typeof CreateInput>;

/** 编辑会员时改手机号（v0.7.26，M77）：要写原因；没有「改会员手机号」权限的要值班经理及以上当场授权（授权绑定这位会员与新号码） */
const PhoneChangeInput = z.object({
  phoneReason: z.string().trim().max(200, '原因最多 200 字').optional(),
  phoneGrantId: z.uuid('授权编号不正确，请重新授权').optional(),
  /** 匿名卡转实名（8.1.15）：留了手机号的匿名卡转成电子卡（名下有在用的实体卡的转成实体卡） */
  convertToNamed: z.boolean().optional(),
});

const SearchQuery = z.object({
  q: z.string().trim().max(32).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** 按标签筛（8.0.4 需求表 05） */
  tagId: z.coerce.number().int().positive().optional(),
});

export async function getMember(db: Db, id: number): Promise<MemberSummary> {
  const [row] = await db<MemberSummary[]>`SELECT ${MEMBER_COLUMNS(db)} FROM members m WHERE m.id = ${id}`;
  if (!row) throw notFound('会员不存在');
  return row;
}

/**
 * 在用的会员实体卡是哪位会员的（v0.7.28 ⑦）：合并过的找到最后合并到的那位（与线上收款一样沿「合并到」找）；没有在用的这张卡为 null
 */
export async function activeCardMemberId(db: Db, cardNo: string): Promise<number | null> {
  const [row] = await db<{ id: number }[]>`
    WITH RECURSIVE chain AS (
      SELECT m.id, m.merged_into_id, 0 AS depth FROM member_cards c JOIN members m ON m.id = c.member_id WHERE c.card_no = ${cardNo} AND c.status = 'active'
      UNION ALL
      SELECT m.id, m.merged_into_id, chain.depth + 1 FROM members m JOIN chain ON m.id = chain.merged_into_id WHERE chain.depth < 20
    )
    SELECT id FROM chain WHERE merged_into_id IS NULL LIMIT 1`;
  return row ? Number(row.id) : null;
}

export async function searchMembers(db: Db, q: string, limit: number, tagId?: number): Promise<MemberSummary[]> {
  // 按标签筛（8.0.4 需求表 05）：只列挂着这个标签的会员
  const tagged = tagId ? db`AND EXISTS (SELECT 1 FROM member_tag_links tl WHERE tl.member_id = m.id AND tl.tag_id = ${tagId})` : db``;
  if (!q) {
    return db<MemberSummary[]>`
      SELECT ${MEMBER_COLUMNS(db)} FROM members m WHERE true ${tagged}
      ORDER BY last_activity_at DESC NULLS LAST, m.id DESC LIMIT ${limit}`;
  }
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // 只有搜索词全是数字（可带空格、横线、+、括号）时才按手机号找；「张三-999」这类文字里的数字不当作手机号片段
  const digits = /^[\d\s()+-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  // 刷卡（v0.7.28 ⑦）：读卡器把卡号打进查找框，整串是在用的会员卡号时排在最前（挂失的卡号查不到人，页面另外提醒）
  const cardMember = looksLikeCardNo(q) ? await activeCardMemberId(db, normalizeCardNo(q)) : null;
  return db<MemberSummary[]>`
    SELECT ${MEMBER_COLUMNS(db)} FROM members m
    WHERE (m.name ILIKE ${like}
       OR m.member_no ILIKE ${like}
       OR (${digits.length >= 3} AND m.phone LIKE ${`%${digits}%`})
       OR m.id = ${cardMember ?? 0}) ${tagged}
    -- 没留手机号的（匿名卡，8.1.15）按空字符串比：不然 NULL 在降序里排到最前面
    ORDER BY (m.id = ${cardMember ?? 0}) DESC,
             (coalesce(m.phone, '') = ${digits}) DESC,
             (m.member_no ILIKE ${q}) DESC,
             (coalesce(m.phone, '') LIKE ${`%${digits}`}) DESC,
             (m.name = ${q}) DESC,
             last_activity_at DESC NULLS LAST, m.id DESC
    LIMIT ${limit}`;
}

/** today 是门店当前的营业日（等级卡按它推算到期与提醒） */
export async function getMemberDetail(db: Db, id: number, today: string): Promise<MemberDetail> {
  const member = await getMember(db, id);
  const [extra] = await db<{ createdByName: string | null; stats: MemberDetail['stats'] }[]>`
    SELECT
      (SELECT display_name FROM staff WHERE id = m.created_by) AS created_by_name,
      json_build_object(
        'totalPaid', (SELECT coalesce(sum(paid_amount), 0) FROM recharges WHERE member_id = m.id),
        'totalBonusGranted', (SELECT coalesce(sum(bonus_amount), 0) FROM recharges WHERE member_id = m.id),
        'rechargeCount', (SELECT count(*) FROM recharges WHERE member_id = m.id),
        'totalConsumed', (SELECT coalesce(sum(total_amount), 0) FROM consumptions WHERE member_id = m.id AND status = 'completed'),
        'consumeCount', (SELECT count(*) FROM consumptions WHERE member_id = m.id AND status = 'completed'),
        'reversedCount', (SELECT count(*) FROM consumptions WHERE member_id = m.id AND status = 'reversed')
      ) AS stats
    FROM members m WHERE m.id = ${id}`;
  const lots = await openLots(db, id);
  // 全部赠金批次（可用、已用完、已过期）：消费扣用与撤销恢复相抵为「已用」，到期作废为「已过期」
  const lotRows = await db<(Omit<BonusLotRow, 'status' | 'used' | 'expired'> & { used: string; expired: string })[]>`
    SELECT l.id, l.source, r.doc_no, l.amount, l.remaining, l.expires_at, l.created_at,
           -coalesce(sum(mv.amount) FILTER (WHERE mv.kind IN ('consume', 'restore', 'refund', 'merge_out')), 0) AS used,
           -coalesce(sum(mv.amount) FILTER (WHERE mv.kind = 'expire'), 0) AS expired
    FROM bonus_lots l LEFT JOIN recharges r ON r.id = l.recharge_id LEFT JOIN bonus_lot_moves mv ON mv.lot_id = l.id
    WHERE l.member_id = ${id}
    GROUP BY l.id, r.doc_no ORDER BY l.created_at DESC, l.id DESC LIMIT 100`;
  const bonusLotHistory: BonusLotRow[] = lotRows.map((l) => {
    const expired = Number(l.expired);
    return {
      ...l,
      amount: Number(l.amount),
      remaining: Number(l.remaining),
      used: Number(l.used),
      expired,
      status: Number(l.remaining) > 0 ? 'active' : expired > 0 ? 'expired' : 'used',
    };
  });
  // 期初导入（旧系统余额）：一位会员最多一笔有效的期初
  const [opening] = await db<NonNullable<MemberDetail['opening']>[]>`
    SELECT i.import_no, b.doc_no, i.source, b.legacy_no, b.principal, b.bonus, b.legacy_recharged, i.created_at AS imported_at
    FROM opening_balances b JOIN opening_imports i ON i.id = b.import_id
    WHERE b.member_id = ${id} AND b.status = 'active'`;
  // 合并（v0.7.26）：被并到了谁
  const [mergedInto] = await db<{ id: number; memberNo: string; name: string }[]>`
    SELECT t.id, t.member_no, t.name FROM members m JOIN members t ON t.id = m.merged_into_id WHERE m.id = ${id}`;
  // 推荐人（8.1.15）
  const [referrer] = await db<{ id: number; memberNo: string; name: string }[]>`
    SELECT t.id, t.member_no, t.name FROM members m JOIN members t ON t.id = m.referrer_member_id WHERE m.id = ${id}`;
  return {
    ...member,
    createdByName: extra?.createdByName ?? null,
    referrer: referrer ? { ...referrer, id: Number(referrer.id) } : null,
    // 押着的实体卡押金（8.1.15）：负债，不在储值余额里
    cardDepositHeld: await heldCardDeposit(db, id),
    gradeInfo: await memberGradeInfo(db, id, today),
    bonusLotHistory,
    stats: extra!.stats,
    bonusLots: lots.map((l) => ({ remaining: l.remaining, expiresAt: l.expiresAt ? new Date(l.expiresAt).toISOString() : null })),
    opening: opening ?? null,
    mergedInto: mergedInto ? { ...mergedInto, id: Number(mergedInto.id) } : null,
    // 会员标签（8.0.4 需求表 05）
    tags: (await memberTagsOf(db, [id])).get(id) ?? [],
    // 充值当日的储值额度（8.0.4 需求表 04）
    spendQuota: await spendQuotaOf(db, id, today, (await loadSettings(db)).rechargeSpendPct),
  };
}

/** 渠道来源：新选的渠道必须是后台启用中的；没改的（包括已停用的旧渠道）照常保留 */
async function channelFor(db: Db, input: string | null | undefined, previous: string | null): Promise<string | null> {
  if (input === undefined) return previous;
  if (input === null || input === previous) return input;
  const { memberChannels } = await loadSettings(db);
  const c = memberChannels.find((x) => x.key === input);
  if (!c) throw badRequest('没有这个渠道来源，请刷新页面后重选', { field: 'channel' });
  if (!c.active) throw badRequest(`渠道「${c.label}」已停用，请选其他渠道`, { field: 'channel' });
  return input;
}

/** 推荐人：新选的要是一位没合并的会员、不能是自己；没改的照常保留 */
async function referrerFor(db: Db, input: number | null | undefined, previous: number | null, selfId: number | null): Promise<number | null> {
  if (input === undefined) return previous;
  if (input === null || input === previous) return input;
  if (input === selfId) throw badRequest('推荐人不能是会员自己', { field: 'referrerMemberId' });
  const [m] = await db<{ name: string; mergedIntoId: number | null }[]>`SELECT name, merged_into_id FROM members WHERE id = ${input}`;
  if (!m) throw badRequest('没有这位推荐人，请重新选择', { field: 'referrerMemberId' });
  if (m.mergedIntoId !== null) throw badRequest(`推荐人「${m.name}」已合并到另一位会员，请选合并到的那位`, { field: 'referrerMemberId' });
  return input;
}

interface OptionalFields {
  gender: 'female' | 'male' | null;
  birthday: string | null;
  note: string;
  channel?: string | null;
  referrerMemberId?: number | null;
  preferredItems?: string[];
  tagIds?: number[];
}

const FIELD_PROMPTS: Record<MemberFormField, string> = {
  gender: '请选择性别',
  birthday: '请填写生日',
  channel: '请选择来源渠道',
  referrer: '请选择推荐人',
  preferredItems: '请填写偏好项目',
  tags: '请选择会员标签',
  note: '请填写备注',
};
/** 接口里的字段名（出错时页面按它把提示放到对应的输入框下面） */
const FIELD_PATHS: Record<MemberFormField, string> = {
  gender: 'gender',
  birthday: 'birthday',
  channel: 'channel',
  referrer: 'referrerMemberId',
  preferredItems: 'preferredItems',
  tags: 'tagIds',
  note: 'note',
};

/**
 * 按后台设的建档表单（8.1.15，按门店）核对选填项：
 *   · 不显示的字段不收——建档时按没填算，编辑时保持原样（previous）；
 *   · 必填的没填就拒绝（提示里写是后台设成必填的）。
 * 标签、偏好项目「不带」表示不改：编辑时拿原来的算有没有填。
 */
function applyFormRules(
  rules: MemberFormRules,
  input: OptionalFields,
  previous: { gender: 'female' | 'male' | null; birthday: string | null; note: string; channel: string | null; referrerMemberId: number | null; preferredItems: string[]; tagCount: number } | null,
): OptionalFields {
  const f = rules.fields;
  const out: OptionalFields = {
    gender: f.gender.show ? input.gender : (previous?.gender ?? null),
    birthday: f.birthday.show ? input.birthday : (previous?.birthday ?? null),
    note: f.note.show ? input.note : (previous?.note ?? ''),
    // 不带 = 保持原样（渠道、推荐人在各自的核对里按原值处理）
    channel: f.channel.show ? input.channel : undefined,
    referrerMemberId: f.referrer.show ? input.referrerMemberId : undefined,
    preferredItems: f.preferredItems.show ? input.preferredItems : undefined,
    tagIds: f.tags.show ? input.tagIds : undefined,
  };
  const filled: Record<MemberFormField, boolean> = {
    gender: out.gender !== null,
    birthday: out.birthday !== null,
    note: out.note.length > 0,
    channel: (out.channel === undefined ? (previous?.channel ?? null) : out.channel) !== null,
    referrer: (out.referrerMemberId === undefined ? (previous?.referrerMemberId ?? null) : out.referrerMemberId) !== null,
    preferredItems: (out.preferredItems === undefined ? (previous?.preferredItems ?? []) : out.preferredItems).length > 0,
    tags: (out.tagIds === undefined ? (previous?.tagCount ?? 0) : out.tagIds.length) > 0,
  };
  for (const key of Object.keys(filled) as MemberFormField[]) {
    if (f[key].show && f[key].required && !filled[key]) {
      throw badRequest(`${FIELD_PROMPTS[key]}（后台把「${MEMBER_FORM_FIELD_LABELS[key]}」设成了必填）`, { field: FIELD_PATHS[key] });
    }
  }
  return out;
}

interface InsertMemberOptions {
  /**
   * false 时不按后台设的建档表单核对选填项（8.1.15）：期初导入、邀请体验当场建档、演示数据带什么写什么；
   * 页面建档（默认）不显示的字段不收、必填的没填就拒绝
   */
  enforceRequired?: boolean;
  /** false 时不逐位写审计（期初导入整批记一条审计） */
  audit?: boolean;
}

interface CreateMemberOptions extends InsertMemberOptions {
  /** 发开卡礼（v0.7.20，按后台的发券规则）：建档页面建的会员发；演示数据、期初导入不带，不发 */
  openCard?: Pick<Deps, 'config'>;
}

/** 在调用方的事务里写会员一行（卡类型、操作编号由建档带进来），返回会员 id */
async function insertMemberRow(tx: Tx, input: ParsedCreate, ctx: OpContext, options: InsertMemberOptions, op: { key: string; requestHash: string } | null): Promise<number> {
  if (input.cardType !== 'anonymous' && !input.phone) throw badRequest('请输入 11 位手机号', { field: 'phone' });
  const fields: OptionalFields =
    (options.enforceRequired ?? true)
      ? applyFormRules((await loadSettings(tx)).memberForm, input, null)
      : { gender: input.gender, birthday: input.birthday, note: input.note, channel: input.channel, referrerMemberId: input.referrerMemberId, preferredItems: input.preferredItems, tagIds: input.tagIds };
  const channel = await channelFor(tx, fields.channel, null);
  const referrerId = await referrerFor(tx, fields.referrerMemberId ?? null, null, null);
  const preferred = fields.preferredItems ?? [];
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO members (member_no, name, phone, card_type, gender, birthday, note, channel, referrer_member_id, preferred_items, created_by, client_key, request_hash)
    VALUES ('YZ' || lpad(nextval('member_no_seq')::text, 5, '0'),
            ${input.name}, ${input.phone}, ${input.cardType}, ${fields.gender}, ${fields.birthday}, ${fields.note}, ${channel}, ${referrerId},
            ${preferred}::text[], ${ctx.actor.id}, ${op?.key ?? null}, ${op?.requestHash ?? null})
    RETURNING id`;
  // 会员标签（8.0.4）：新建时挂的标签
  const tags = fields.tagIds?.length ? await setMemberTags(tx, row!.id, fields.tagIds, ctx.actor.id) : null;
  if (options.audit ?? true) {
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'member_created',
      targetType: 'member',
      targetId: row!.id,
      detail: {
        name: input.name,
        phone: input.phone ?? undefined,
        // 电子卡是以往的建档，不另写；实体卡、匿名卡写明
        ...(input.cardType !== 'ecard' ? { cardType: MEMBER_CARD_TYPE_LABELS[input.cardType] } : {}),
        ...(referrerId !== null ? { referrerMemberId: referrerId } : {}),
        ...(preferred.length ? { preferredItems: preferred } : {}),
        ...(tags?.added.length ? { tags: tags.added } : {}),
      },
      ip: ctx.ip,
    });
  }
  return row!.id;
}

/**
 * 在调用方的事务里建档（电子卡），返回会员 id：期初导入、邀请体验当场建档用。
 * 手机号重复时抛出唯一约束错误（members_phone_key），由调用方处理
 */
export async function insertMember(tx: Tx, raw: MemberInputData, ctx: OpContext, options: InsertMemberOptions = {}): Promise<number> {
  const input = parse(CreateInput, { ...raw, cardType: 'ecard', clientKey: undefined, grade: null, card: null });
  return insertMemberRow(tx, input, ctx, options, null);
}

/**
 * 建档（8.1.15 起分卡类型，docs/MEMBERS_V8115.md）：
 *   · 电子卡：要手机号（全公司不重复）；
 *   · 实体卡：要手机号、卡号，同一事务里发卡并按后台设的金额收押金（押金是负债，不进储值）；
 *   · 匿名卡：手机号可以不留；可以配一张实体卡（同样收押金）；
 *   · 等级默认按规则自动；手动指定要「手动调整会员档阶」权限，走手动调整的同一条路。
 * 带操作编号的（匿名卡、实体卡必带）同一编号重提返回原来那位；结果待确认时可以「确认作废」。带 openCard 时同一事务里按发券规则发开卡礼。
 * 锁：操作编号的咨询锁 → 经办人的班次（共享锁，收押金时）→ 写会员一行 → 卡（同号的在用、挂失卡）→ 押金台账。
 */
export async function createMemberOp(sql: Sql, raw: MemberCreateData, ctx: OpContext, options: CreateMemberOptions = {}): Promise<{ member: MemberSummary; replayed: boolean }> {
  const input = parse(CreateInput, raw);
  const deps = options.openCard;
  if (input.cardType === 'ecard' && input.card) throw badRequest('电子卡不发实体卡；要发卡请选实体卡或匿名卡', { field: 'cardType' });
  if (input.cardType === 'physical' && !input.card) throw badRequest('实体卡请刷卡或输入卡号', { field: 'card.cardNo' });
  if (input.cardType !== 'ecard' && !input.clientKey) throw badRequest('缺少有效的操作编号，请刷新页面后重试', { field: 'clientKey' });
  if (input.card && !can(ctx.actor, 'member.card')) throw forbidden('建档同时发实体卡要有「会员实体卡：发卡、挂失、补卡」的权限');
  const grade = input.grade && input.grade.grade > 0 ? input.grade : null;
  if (grade && !can(ctx.actor, 'member.adjust')) throw forbidden('手动指定会员等级要有「手动调整会员档阶」的权限；没有的请选「按规则自动」');
  if ((input.card || grade) && !deps) throw new Error('建档同时发卡、指定等级要带 openCard（营业日按门店的切换时间算）');
  assertDepositPay(input.card?.deposit);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM members WHERE client_key = ${key ?? null}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次建档，请刷新页面后重新办理');
    return Number(p.id);
  };
  // 收押金是收款：开始处理时记下经办人所在的班次，入账事务里在写业务行之前对它加共享锁（交班了就整笔拒绝）
  const deposit = input.card?.deposit ?? null;
  const seenShift = deposit ? await openShiftOf(sql, ctx.actor.id) : null;
  try {
    const out = await sql.begin(async (tx) => {
      if (key) {
        await setTxTimeouts(tx);
        await assertNotFenced(tx, key, 'member_create', erpOpAbandoned);
        const prior = await replay(tx);
        if (prior !== null) return { id: prior, replayed: true };
      }
      const shiftId = deposit ? await lockPaymentShift(tx, ctx.actor.id, seenShift) : null;
      const at = ctx.at ?? new Date();
      const memberId = await insertMemberRow(tx, input, ctx, options, key ? { key, requestHash } : null);
      if (options.openCard) {
        await issueOpenCardCoupons(tx, options.openCard, memberId, ctx);
        // 会员权益（v0.7.24）：「L0·会员」起点的券类当场发本期的，生日在这个月的发生日礼
        await onMemberSaved(tx, options.openCard, memberId, ctx);
      }
      if (grade && deps) {
        const date = businessDateOf(at, deps.config.timezone, (await loadSettings(tx)).businessDayStartHour);
        await assignInitialGrade(tx, memberId, grade, ctx, date);
      }
      if (input.card && deps && key) {
        await issueCardInTx(
          tx,
          deps,
          { memberId, memberName: input.name, cardNo: input.card.cardNo, replace: false, replaceReason: '', note: input.card.note, deposit, shiftId, key, requestHash, at },
          ctx,
        );
      }
      return { id: memberId, replayed: false };
    });
    return { member: await getMember(sql, out.id), replayed: out.replayed };
  } catch (error) {
    if (isUniqueViolation(error, 'members_phone_key') && input.phone) {
      const [existing] = await sql<{ id: number; name: string }[]>`SELECT id, name FROM members WHERE phone = ${input.phone}`;
      throw conflict('PHONE_EXISTS', `手机号已登记为会员「${existing?.name ?? ''}」`, { memberId: existing?.id });
    }
    // 同一编号并发提交：后到的一笔撞上唯一约束，按原来那位返回
    if (isUniqueViolation(error, 'members_client_key_key')) {
      const id = await replay(sql);
      if (id !== null) return { member: await getMember(sql, id), replayed: true };
    }
    // 两个人同时发同一张卡：数据库唯一索引兜底（整笔回滚，会员也没有建）
    if (isUniqueViolation(error, 'member_cards_no_uq')) throw conflict('CARD_TAKEN', '这张卡刚刚发给了别人，没有建档，请换一张卡');
    // 这个编号以前用在别的发卡、押金上
    if (isUniqueViolation(error, 'member_cards_client_key_key') || isUniqueViolation(error, 'member_card_deposits_client_key_key')) {
      throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次办理，请刷新页面后重新办理');
    }
    throw error;
  }
}

/** 建档，返回会员（原来的调用方：演示数据、接口）；带 openCard 时在同一事务里按发券规则发开卡礼 */
export async function createMember(sql: Sql, raw: MemberCreateData, ctx: OpContext, options: CreateMemberOptions = {}): Promise<MemberSummary> {
  return (await createMemberOp(sql, raw, ctx, options)).member;
}

export function registerMemberRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const todayOf = async () => businessDateOf(new Date(), deps.config.timezone, (await loadSettings(sql)).businessDayStartHour);
  app.get('/api/members', { preHandler: guard('member.read') }, async (req) => {
    const { q, limit, tagId } = parse(SearchQuery, req.query);
    return searchMembers(sql, q, limit, tagId);
  });

  app.get('/api/members/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    // 先作废这位会员到期的赠金，员工看到的余额才是可用余额
    await expireMemberBonus(deps, id);
    return getMemberDetail(sql, id, await todayOf());
  });

  app.get('/api/members/:id/activity', { preHandler: guard('member.read') }, async (req): Promise<LedgerRow[]> => {
    const { id } = parse(idParam, req.params);
    await getMember(sql, id);
    return listLedger(sql, { memberId: id, limit: 100 });
  });

  app.post('/api/members', { preHandler: guard('member.write') }, async (req, reply) => {
    const { member, replayed } = await createMemberOp(sql, req.body as MemberCreateData, { actor: req.actor, ip: req.ip }, { openCard: deps });
    // 原样重提（同一操作编号）返回原来那位：不是新建的
    reply.code(replayed ? 200 : 201);
    return member;
  });

  app.put('/api/members/:id', { preHandler: guard('member.write') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const raw = parse(MemberInput, req.body);
    const phoneChange = parse(PhoneChangeInput, req.body);
    const before = await getMember(sql, id);
    const date = await todayOf();
    try {
      await sql.begin(async (tx) => {
        const [locked] = await tx<
          {
            channel: string | null;
            birthday: string | null;
            phone: string | null;
            mergedIntoId: number | null;
            cardType: MemberCardType;
            gender: 'female' | 'male' | null;
            note: string;
            referrerMemberId: number | null;
            preferredItems: string[];
            tagCount: number;
          }[]
        >`
          SELECT channel, birthday::text AS birthday, phone, merged_into_id, card_type, gender, note, referrer_member_id, preferred_items,
                 (SELECT count(*)::int FROM member_tag_links tl WHERE tl.member_id = members.id) AS tag_count
          FROM members WHERE id = ${id} FOR UPDATE`;
        if (!locked) throw notFound('会员不存在');
        // 已合并的会员（v0.7.26）：档案停用、历史单据留在这里，资料不再改
        if (locked.mergedIntoId !== null) throw unprocessable('MEMBER_MERGED', '这位会员已合并到另一位会员，资料不能再改；请到那位会员那里改');
        // 后台设的建档表单（8.1.15）：不显示的字段保持原样，必填的没填就拒绝
        const input = { ...raw, ...applyFormRules((await loadSettings(tx)).memberForm, raw, locked) };
        // 手机号（8.1.15）：只有匿名卡可以不留；留过的不能清空，只能改
        if (input.phone === null && locked.cardType !== 'anonymous') throw badRequest('请输入 11 位手机号', { field: 'phone' });
        if (input.phone === null && locked.phone !== null) throw badRequest('手机号登记以后不能清空，只能改成别的号', { field: 'phone' });
        // 匿名卡转实名（8.1.15）：留了手机号的匿名卡可以转成电子卡（名下有在用的实体卡的转成实体卡）
        const toNamed = phoneChange.convertToNamed === true && locked.cardType === 'anonymous';
        if (toNamed && input.phone === null) throw badRequest('转成实名的卡要先登记手机号', { field: 'phone' });
        // 改手机号（v0.7.26，M77）：写原因；没有「改会员手机号」权限的核销值班经理及以上的当场授权（授权绑定会员与新号码）。
        // 匿名卡补登手机号也算改号：谁登记了手机号，谁就能凭它认领这份档案
        let phoneApprover: { approverId: number; approverName: string } | null = null;
        if (input.phone !== null && input.phone !== locked.phone) {
          const reason = phoneChange.phoneReason ?? '';
          if (reason.length < 2) throw badRequest('改手机号要写原因（至少 2 个字）', { field: 'phoneReason' });
          if (!can(req.actor, 'member.phone')) {
            if (!phoneChange.phoneGrantId) throw unprocessable('PHONE_AUTH_REQUIRED', '改手机号要值班经理、店总或店主当场授权');
            phoneApprover = await consumeMemberPhoneGrant(tx, { grantId: phoneChange.phoneGrantId, actor: req.actor, scope: { memberId: id, phone: input.phone }, usedRef: `member_phone:${id}` });
          }
        }
        const channel = await channelFor(tx, input.channel, locked.channel);
        const referrerId = await referrerFor(tx, input.referrerMemberId, locked.referrerMemberId, id);
        const preferred = input.preferredItems ?? locked.preferredItems;
        const [card] = toNamed ? await tx<{ id: number }[]>`SELECT id FROM member_cards WHERE member_id = ${id} AND status = 'active'` : [];
        const cardType: MemberCardType = toNamed ? (card ? 'physical' : 'ecard') : locked.cardType;
        await tx`
          UPDATE members SET name = ${input.name}, phone = ${input.phone}, gender = ${input.gender},
                 birthday = ${input.birthday}, note = ${input.note}, channel = ${channel},
                 referrer_member_id = ${referrerId}, preferred_items = ${preferred}::text[], card_type = ${cardType}, updated_at = now()
          WHERE id = ${id}`;
        // 会员标签（8.0.4）：带了才整组替换，在会员一行锁里写
        const tags = input.tagIds === undefined ? null : await setMemberTags(tx, id, input.tagIds, req.actor.id);
        const tagsChanged = !!tags && (tags.added.length > 0 || tags.removed.length > 0);
        const preferredChanged = preferred.join('\n') !== locked.preferredItems.join('\n');
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'member_updated',
          targetType: 'member',
          targetId: id,
          detail: {
            before: {
              name: before.name,
              phone: before.phone ?? undefined,
              note: before.note,
              ...(tagsChanged ? { tagsRemoved: tags!.removed } : {}),
              ...(channel !== locked.channel ? { channel: locked.channel } : {}),
              ...(referrerId !== locked.referrerMemberId ? { referrerMemberId: locked.referrerMemberId } : {}),
              ...(preferredChanged ? { preferredItems: locked.preferredItems } : {}),
              ...(cardType !== locked.cardType ? { cardType: MEMBER_CARD_TYPE_LABELS[locked.cardType] } : {}),
            },
            after: {
              name: input.name,
              phone: input.phone ?? undefined,
              note: input.note,
              ...(tagsChanged ? { tagsAdded: tags!.added } : {}),
              ...(channel !== locked.channel ? { channel } : {}),
              ...(referrerId !== locked.referrerMemberId ? { referrerMemberId: referrerId } : {}),
              ...(preferredChanged ? { preferredItems: preferred } : {}),
              ...(cardType !== locked.cardType ? { cardType: MEMBER_CARD_TYPE_LABELS[cardType] } : {}),
            },
          },
          ip: req.ip,
        });
        if (input.phone !== null && input.phone !== locked.phone) {
          await tx`
            INSERT INTO member_phone_changes (member_id, old_phone, new_phone, reason, staff_id, approved_by, business_date)
            VALUES (${id}, ${locked.phone}, ${input.phone}, ${phoneChange.phoneReason ?? ''}, ${req.actor.id}, ${phoneApprover?.approverId ?? null}, ${date})`;
          await writeAudit(tx, {
            staffId: req.actor.id,
            action: 'member_phone_changed',
            targetType: 'member',
            targetId: id,
            detail: {
              memberNo: before.memberNo,
              name: input.name,
              from: locked.phone ?? '未留手机号',
              to: input.phone,
              reason: phoneChange.phoneReason,
              ...(phoneApprover ? { approverName: phoneApprover.approverName } : {}),
            },
            ip: req.ip,
            businessDate: date,
          });
        }
        // 会员权益（v0.7.24）：补填、改了生日的当场看生日礼（Codex 自动审查 98806a3）
        if (input.birthday !== locked.birthday) await onMemberSaved(tx, deps, id, { actor: req.actor, ip: req.ip });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'members_phone_key')) {
        throw conflict('PHONE_EXISTS', '这个手机号已被其他会员使用');
      }
      throw error;
    }
    return getMemberDetail(sql, id, date);
  });
}
