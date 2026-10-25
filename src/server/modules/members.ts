import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LedgerRow, MemberDetail, MemberSummary } from '@shared/types';
import { isUniqueViolation, type Db, type Sql } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { conflict, notFound } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { listLedger } from './ledger';

const MEMBER_COLUMNS = (db: Db) => db`
  m.id, m.member_no, m.name, m.phone, m.gender, m.birthday::text AS birthday, m.note,
  m.principal_balance, m.bonus_balance, m.status, m.is_synthetic, m.created_at,
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
});
export type MemberInputData = z.infer<typeof MemberInput>;

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
  return { ...member, createdByName: extra?.createdByName ?? null, stats: extra!.stats };
}

export async function createMember(sql: Sql, input: MemberInputData, ctx: OpContext): Promise<MemberSummary> {
  try {
    const id = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO members (member_no, name, phone, gender, birthday, note, created_by)
        VALUES ('YZ' || lpad(nextval('member_no_seq')::text, 5, '0'),
                ${input.name}, ${input.phone}, ${input.gender}, ${input.birthday}, ${input.note}, ${ctx.actor.id})
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'member_created',
        targetType: 'member',
        targetId: row!.id,
        detail: { name: input.name, phone: input.phone },
        ip: ctx.ip,
      });
      return row!.id;
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

export function registerMemberRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/members', { preHandler: guard('member.read') }, async (req) => {
    const { q, limit } = parse(SearchQuery, req.query);
    return searchMembers(sql, q, limit);
  });

  app.get('/api/members/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getMemberDetail(sql, id);
  });

  app.get('/api/members/:id/activity', { preHandler: guard('member.read') }, async (req): Promise<LedgerRow[]> => {
    const { id } = parse(idParam, req.params);
    await getMember(sql, id);
    return listLedger(sql, { memberId: id, limit: 100 });
  });

  app.post('/api/members', { preHandler: guard('member.write') }, async (req, reply) => {
    const input = parse(MemberInput, req.body);
    const member = await createMember(sql, input, { actor: req.actor, ip: req.ip });
    reply.code(201);
    return member;
  });

  app.put('/api/members/:id', { preHandler: guard('member.write') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(MemberInput, req.body);
    const before = await getMember(sql, id);
    try {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE members SET name = ${input.name}, phone = ${input.phone}, gender = ${input.gender},
                 birthday = ${input.birthday}, note = ${input.note}, updated_at = now()
          WHERE id = ${id}`;
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'member_updated',
          targetType: 'member',
          targetId: id,
          detail: {
            before: { name: before.name, phone: before.phone, note: before.note },
            after: { name: input.name, phone: input.phone, note: input.note },
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
