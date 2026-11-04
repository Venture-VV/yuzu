import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { checkCustomValues, type MemberCustomValues } from '@shared/member-fields';
import { MEMBER_CHANNEL_KEY, type BonusLotRow } from '@shared/members';
import type { LedgerRow, MemberDetail, MemberSummary } from '@shared/types';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { expireMemberBonus, openLots } from './bonus';
import { issueOpenCardCoupons } from './coupons';
import { onMemberSaved } from './benefits';
import { listLedger } from './ledger';
import { memberGradeInfo } from './membership';
import { loadSettings } from './settings';

const MEMBER_COLUMNS = (db: Db) => db`
  m.id, m.member_no, m.name, m.phone, m.gender, m.birthday::text AS birthday, m.note,
  m.principal_balance, m.bonus_balance, m.status, m.is_synthetic, m.created_at, m.custom_fields, m.channel,
  m.grade, m.tier, m.cycle_end, m.grace_until,
  (SELECT max(le.created_at) FROM ledger_entries le WHERE le.member_id = m.id) AS last_activity_at`;

const MemberInput = z.object({
  name: z.string().trim().min(1, '请填写会员姓名').max(32, '姓名最多 32 个字'),
  phone: z
    .string()
    .transform((s) => s.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^1\d{10}$/, '请输入 11 位手机号')),
  gender: z.enum(['female', 'male']).nullable().default(null),
  birthday: z.iso.date('生日格式应为 YYYY-MM-DD').nullable().default(null),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  /** 自定义字段的值（键为字段编号）；编辑时不带则保持原值 */
  customFields: z.record(z.string(), z.unknown(), '自定义字段格式不正确').optional(),
  /** 渠道来源的编号；编辑时不带则保持原值，null 为清空 */
  channel: z.string().regex(MEMBER_CHANNEL_KEY, '渠道来源不正确').nullable().optional(),
});
export type MemberInputData = z.input<typeof MemberInput>;

const SearchQuery = z.object({
  q: z.string().trim().max(32).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function getMember(db: Db, id: number): Promise<MemberSummary> {
  const [row] = await db<MemberSummary[]>`SELECT ${MEMBER_COLUMNS(db)} FROM members m WHERE m.id = ${id}`;
  if (!row) throw notFound('会员不存在');
  return row;
}

export async function searchMembers(db: Db, q: string, limit: number): Promise<MemberSummary[]> {
  if (!q) {
    return db<MemberSummary[]>`
      SELECT ${MEMBER_COLUMNS(db)} FROM members m
      ORDER BY last_activity_at DESC NULLS LAST, m.id DESC LIMIT ${limit}`;
  }
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // 只有搜索词全是数字（可带空格、横线、+、括号）时才按手机号找；「张三-999」这类文字里的数字不当作手机号片段
  const digits = /^[\d\s()+-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  return db<MemberSummary[]>`
    SELECT ${MEMBER_COLUMNS(db)} FROM members m
    WHERE m.name ILIKE ${like}
       OR m.member_no ILIKE ${like}
       OR (${digits.length >= 3} AND m.phone LIKE ${`%${digits}%`})
    ORDER BY (m.phone = ${digits}) DESC,
             (m.member_no ILIKE ${q}) DESC,
             (m.phone LIKE ${`%${digits}`}) DESC,
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
  return {
    ...member,
    createdByName: extra?.createdByName ?? null,
    gradeInfo: await memberGradeInfo(db, id, today),
    bonusLotHistory,
    stats: extra!.stats,
    bonusLots: lots.map((l) => ({ remaining: l.remaining, expiresAt: l.expiresAt ? new Date(l.expiresAt).toISOString() : null })),
    opening: opening ?? null,
    mergedInto: mergedInto ? { ...mergedInto, id: Number(mergedInto.id) } : null,
  };
}

/** 按当前字段定义核对自定义字段；不合格时 400 并指出字段 */
async function customValuesFor(
  db: Db,
  input: Record<string, unknown>,
  previous: MemberCustomValues,
  enforceRequired: boolean,
): Promise<MemberCustomValues> {
  const { memberFields } = await loadSettings(db);
  const result = checkCustomValues(memberFields, input, previous, { enforceRequired });
  if (!result.ok) throw badRequest(result.message, result.field ? { field: `customFields.${result.field}` } : undefined);
  return result.values;
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

interface InsertMemberOptions {
  /** false 用于期初导入等批量来源：必填的自定义字段可以先空着，之后编辑会员时再补 */
  enforceRequired?: boolean;
  /** false 时不逐位写审计（期初导入整批记一条审计） */
  audit?: boolean;
}

interface CreateMemberOptions extends InsertMemberOptions {
  /** 发开卡礼（v0.7.20，按后台的发券规则）：建档页面建的会员发；演示数据、期初导入不带，不发 */
  openCard?: Pick<Deps, 'config'>;
}

/** 在调用方的事务里建档，返回会员 id。手机号重复时抛出唯一约束错误（members_phone_key），由调用方处理 */
export async function insertMember(tx: Tx, raw: MemberInputData, ctx: OpContext, options: InsertMemberOptions = {}): Promise<number> {
  const input = parse(MemberInput, raw);
  const customFields = await customValuesFor(tx, input.customFields ?? {}, {}, options.enforceRequired ?? true);
  const channel = await channelFor(tx, input.channel, null);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO members (member_no, name, phone, gender, birthday, note, custom_fields, channel, created_by)
    VALUES ('YZ' || lpad(nextval('member_no_seq')::text, 5, '0'),
            ${input.name}, ${input.phone}, ${input.gender}, ${input.birthday}, ${input.note}, ${tx.json(customFields)}, ${channel}, ${ctx.actor.id})
    RETURNING id`;
  if (options.audit ?? true) {
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'member_created',
      targetType: 'member',
      targetId: row!.id,
      detail: { name: input.name, phone: input.phone },
      ip: ctx.ip,
    });
  }
  return row!.id;
}

/** 建档；带 openCard 时在同一事务里按发券规则发开卡礼 */
export async function createMember(sql: Sql, raw: MemberInputData, ctx: OpContext, options: CreateMemberOptions = {}): Promise<MemberSummary> {
  const input = parse(MemberInput, raw);
  try {
    const id = await sql.begin(async (tx) => {
      const memberId = await insertMember(tx, raw, ctx, options);
      if (options.openCard) {
        await issueOpenCardCoupons(tx, options.openCard, memberId, ctx);
        // 会员权益（v0.7.24）：「L0·会员」起点的券类当场发本期的，生日在这个月的发生日礼
        await onMemberSaved(tx, options.openCard, memberId, ctx);
      }
      return memberId;
    });
    return getMember(sql, id);
  } catch (error) {
    if (isUniqueViolation(error, 'members_phone_key')) {
      const [existing] = await sql<{ id: number; name: string }[]>`SELECT id, name FROM members WHERE phone = ${input.phone}`;
      throw conflict('PHONE_EXISTS', `手机号已登记为会员「${existing?.name ?? ''}」`, { memberId: existing?.id });
    }
    throw error;
  }
}

export function registerMemberRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const todayOf = async () => businessDateOf(new Date(), deps.config.timezone, (await loadSettings(sql)).businessDayStartHour);
  app.get('/api/members', { preHandler: guard('member.read') }, async (req) => {
    const { q, limit } = parse(SearchQuery, req.query);
    return searchMembers(sql, q, limit);
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
    const member = await createMember(sql, req.body as MemberInputData, { actor: req.actor, ip: req.ip }, { openCard: deps });
    reply.code(201);
    return member;
  });

  app.put('/api/members/:id', { preHandler: guard('member.write') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(MemberInput, req.body);
    const before = await getMember(sql, id);
    try {
      await sql.begin(async (tx) => {
        // 自定义字段在会员行锁内按最新的字段定义核对；没带时保持原值（停用字段的值始终保留）
        const [locked] = await tx<{ customFields: MemberCustomValues; channel: string | null; birthday: string | null }[]>`
          SELECT custom_fields, channel, birthday::text AS birthday FROM members WHERE id = ${id} FOR UPDATE`;
        const customFields = input.customFields === undefined ? locked!.customFields : await customValuesFor(tx, input.customFields, locked!.customFields, true);
        const channel = await channelFor(tx, input.channel, locked!.channel);
        await tx`
          UPDATE members SET name = ${input.name}, phone = ${input.phone}, gender = ${input.gender},
                 birthday = ${input.birthday}, note = ${input.note}, custom_fields = ${tx.json(customFields)}, channel = ${channel}, updated_at = now()
          WHERE id = ${id}`;
        const keys = new Set([...Object.keys(customFields), ...Object.keys(locked!.customFields)]);
        const fieldsChanged = [...keys].some((k) => customFields[k] !== locked!.customFields[k]);
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'member_updated',
          targetType: 'member',
          targetId: id,
          detail: {
            before: {
              name: before.name,
              phone: before.phone,
              note: before.note,
              ...(fieldsChanged ? { customFields: locked!.customFields } : {}),
              ...(channel !== locked!.channel ? { channel: locked!.channel } : {}),
            },
            after: {
              name: input.name,
              phone: input.phone,
              note: input.note,
              ...(fieldsChanged ? { customFields } : {}),
              ...(channel !== locked!.channel ? { channel } : {}),
            },
          },
          ip: req.ip,
        });
        // 会员权益（v0.7.24）：补填、改了生日的当场看生日礼（Codex 自动审查 98806a3）
        if (input.birthday !== locked!.birthday) await onMemberSaved(tx, deps, id, { actor: req.actor, ip: req.ip });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'members_phone_key')) {
        throw conflict('PHONE_EXISTS', '这个手机号已被其他会员使用');
      }
      throw error;
    }
    return getMemberDetail(sql, id, await todayOf());
  });
}
