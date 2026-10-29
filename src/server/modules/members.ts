import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkCustomValues, type MemberCustomValues } from '@shared/member-fields';
import type { LedgerRow, MemberDetail, MemberSummary } from '@shared/types';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { expireMemberBonus, openLots } from './bonus';
import { listLedger } from './ledger';
import { loadSettings } from './settings';

const MEMBER_COLUMNS = (db: Db) => db`
  m.id, m.member_no, m.name, m.phone, m.gender, m.birthday::text AS birthday, m.note,
  m.principal_balance, m.bonus_balance, m.status, m.is_synthetic, m.created_at, m.custom_fields,
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
  const digits = q.replace(/\D/g, '');
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

export async function getMemberDetail(db: Db, id: number): Promise<MemberDetail> {
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
  // 期初导入（旧系统余额）：一位会员最多一笔有效的期初
  const [opening] = await db<NonNullable<MemberDetail['opening']>[]>`
    SELECT i.import_no, b.doc_no, i.source, b.legacy_no, b.principal, b.bonus, b.legacy_recharged, i.created_at AS imported_at
    FROM opening_balances b JOIN opening_imports i ON i.id = b.import_id
    WHERE b.member_id = ${id} AND b.status = 'active'`;
  return {
    ...member,
    createdByName: extra?.createdByName ?? null,
    stats: extra!.stats,
    bonusLots: lots.map((l) => ({ remaining: l.remaining, expiresAt: l.expiresAt ? new Date(l.expiresAt).toISOString() : null })),
    opening: opening ?? null,
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

interface InsertMemberOptions {
  /** false 用于期初导入等批量来源：必填的自定义字段可以先空着，之后编辑会员时再补 */
  enforceRequired?: boolean;
  /** false 时不逐位写审计（期初导入整批记一条审计） */
  audit?: boolean;
}

/** 在调用方的事务里建档，返回会员 id。手机号重复时抛出唯一约束错误（members_phone_key），由调用方处理 */
export async function insertMember(tx: Tx, raw: MemberInputData, ctx: OpContext, options: InsertMemberOptions = {}): Promise<number> {
  const input = parse(MemberInput, raw);
  const customFields = await customValuesFor(tx, input.customFields ?? {}, {}, options.enforceRequired ?? true);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO members (member_no, name, phone, gender, birthday, note, custom_fields, created_by)
    VALUES ('YZ' || lpad(nextval('member_no_seq')::text, 5, '0'),
            ${input.name}, ${input.phone}, ${input.gender}, ${input.birthday}, ${input.note}, ${tx.json(customFields)}, ${ctx.actor.id})
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

/** 建档 */
export async function createMember(sql: Sql, raw: MemberInputData, ctx: OpContext, options: InsertMemberOptions = {}): Promise<MemberSummary> {
  const input = parse(MemberInput, raw);
  try {
    const id = await sql.begin((tx) => insertMember(tx, raw, ctx, options));
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
  app.get('/api/members', { preHandler: guard('member.read') }, async (req) => {
    const { q, limit } = parse(SearchQuery, req.query);
    return searchMembers(sql, q, limit);
  });

  app.get('/api/members/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    // 先作废这位会员到期的赠金，员工看到的余额才是可用余额
    await expireMemberBonus(deps, id);
    return getMemberDetail(sql, id);
  });

  app.get('/api/members/:id/activity', { preHandler: guard('member.read') }, async (req): Promise<LedgerRow[]> => {
    const { id } = parse(idParam, req.params);
    await getMember(sql, id);
    return listLedger(sql, { memberId: id, limit: 100 });
  });

  app.post('/api/members', { preHandler: guard('member.write') }, async (req, reply) => {
    const member = await createMember(sql, req.body as MemberInputData, { actor: req.actor, ip: req.ip });
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
        const [locked] = await tx<{ customFields: MemberCustomValues }[]>`SELECT custom_fields FROM members WHERE id = ${id} FOR UPDATE`;
        const customFields = input.customFields === undefined ? locked!.customFields : await customValuesFor(tx, input.customFields, locked!.customFields, true);
        await tx`
          UPDATE members SET name = ${input.name}, phone = ${input.phone}, gender = ${input.gender},
                 birthday = ${input.birthday}, note = ${input.note}, custom_fields = ${tx.json(customFields)}, updated_at = now()
          WHERE id = ${id}`;
        const keys = new Set([...Object.keys(customFields), ...Object.keys(locked!.customFields)]);
        const fieldsChanged = [...keys].some((k) => customFields[k] !== locked!.customFields[k]);
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'member_updated',
          targetType: 'member',
          targetId: id,
          detail: {
            before: { name: before.name, phone: before.phone, note: before.note, ...(fieldsChanged ? { customFields: locked!.customFields } : {}) },
            after: { name: input.name, phone: input.phone, note: input.note, ...(fieldsChanged ? { customFields } : {}) },
          },
          ip: req.ip,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'members_phone_key')) {
        throw conflict('PHONE_EXISTS', '这个手机号已被其他会员使用');
      }
      throw error;
    }
    return getMemberDetail(sql, id);
  });
}
