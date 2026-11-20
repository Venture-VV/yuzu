// 发牌前风控（8.1.15《浴族系统需求汇总》块 A，docs/FRONTDESK_RISK_V8115.md 第 3 节）：
//   · 黑名单：会员或手机号，登记 → 解除，只追加；发牌时命中的会员拒绝；
//   · 未结离店：会员名下有没处理完的「未结离店」待办时，要值班经理及以上当场授权才能发；
//   · 当日重复到店：只提示，不拦；
//   · 预约：今天待到店的预约带出来，发牌成功后在同一个事务里标「已到店」并挂上这张牌（派对房要开使用单，不自动标）。
// 页面预先看 memberRisk()；发牌的事务里再核对一遍（visits.ts 的 checkin），页面看到的不算数。
//
// 锁：
//   · 登记黑名单：会员一行（FOR UPDATE，与发牌对会员一行的共享锁串行）→ 写一条；解除只锁那一条。
//   · 发牌带出预约：在手牌之前先锁这几张预约（id 升序，FOR UPDATE）——预约的确认、到店、取消都是先锁预约一行，方向一致。

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_FRONTDESK_RISK_RULES, type BlacklistEntry, type FrontdeskRiskRules, type MemberRisk, type RiskBooking, type UnsettledDebt } from '@shared/frontdesk-risk';
import { guard } from '../../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { currentStoreId } from '../../lib/store-context';
import { settingRow } from '../../lib/store-settings';
import { idParam, parse } from '../../lib/validate';
import { businessDate, setTxTimeouts } from './common';

// ───────────────────────── 开关 ─────────────────────────

export const RISK_RULES_KEY = 'frontdesk_risk_rules';

export async function loadRiskRules(db: Db): Promise<FrontdeskRiskRules> {
  const row = await settingRow<Partial<FrontdeskRiskRules>>(db, RISK_RULES_KEY);
  return { enabled: typeof row?.value?.enabled === 'boolean' ? row.value.enabled : DEFAULT_FRONTDESK_RISK_RULES.enabled };
}

const RulesInput = z.object({ enabled: z.boolean('请选择开或关') });

// ───────────────────────── 黑名单 ─────────────────────────

const ENTRY_COLUMNS = (db: Db) => db`
  b.id, b.member_id, m.member_no, b.phone, b.name, b.reason, cs.display_name AS created_by_name, b.created_at,
  ls.display_name AS lifted_by_name, b.lifted_at, b.lift_reason`;
const ENTRY_FROM = (db: Db) => db`
  guest_blacklist b JOIN staff cs ON cs.id = b.created_by LEFT JOIN staff ls ON ls.id = b.lifted_by LEFT JOIN members m ON m.id = b.member_id`;

const toEntry = (r: BlacklistEntry): BlacklistEntry => ({ ...r, id: Number(r.id), memberId: r.memberId === null ? null : Number(r.memberId) });

/** 黑名单清单：默认只看没解除的；all 时连解除了的一起（留痕） */
export async function listBlacklist(db: Db, all: boolean): Promise<BlacklistEntry[]> {
  const rows = await db<BlacklistEntry[]>`
    SELECT ${ENTRY_COLUMNS(db)} FROM ${ENTRY_FROM(db)}
    WHERE ${all ? db`true` : db`b.lifted_at IS NULL`}
    ORDER BY (b.lifted_at IS NULL) DESC, b.id DESC LIMIT 500`;
  return rows.map(toEntry);
}

/**
 * 这位会员现在命中的黑名单（按会员登记的，或按他现在的手机号登记的）；没有返回 null。
 * 黑名单跟着人走：合并到这位会员身上的会员（沿合并关系往回找，合并过几次都算）在合并前登记的也算——
 * 合并不转移黑名单（登记只追加、不能改），这里不往回找就会漏掉（Codex 审查 35c4338）
 */
export async function memberBlacklist(db: Db, memberId: number): Promise<BlacklistEntry | null> {
  const [row] = await db<BlacklistEntry[]>`
    WITH RECURSIVE fam(id) AS (
      SELECT id FROM members WHERE id = ${memberId}
      UNION
      SELECT x.id FROM fam f JOIN members x ON x.merged_into_id = f.id
    )
    SELECT ${ENTRY_COLUMNS(db)} FROM ${ENTRY_FROM(db)}
    WHERE b.lifted_at IS NULL
      AND (b.member_id IN (SELECT id FROM fam) OR b.phone IN (SELECT x.phone FROM members x JOIN fam f ON f.id = x.id))
    ORDER BY b.id LIMIT 1`;
  return row ? toEntry(row) : null;
}

export interface BlacklistHit {
  id: number;
  /** 来发牌的这位会员 */
  memberId: number;
  memberName: string;
  /** 黑名单登记在合并到他身上的那位会员上时，那位的姓名（合并前登记的）；登记在他本人上的为 null */
  viaName: string | null;
  reason: string;
  createdByName: string;
  createdAt: string;
}

/**
 * 这几位会员里命中黑名单的（发牌的事务里用；只读）。合并到他们身上的会员（沿合并关系往回找）在合并前登记的也算：
 * 合并不转移黑名单，只看本人的编号与手机号会漏掉（Codex 审查 35c4338）。新的登记只能记在没合并的会员上（MEMBER_MERGED），
 * 与发牌对那位会员一行的共享锁串行；合并前的登记不会再变，只会被解除
 */
export async function blacklistHits(db: Db, memberIds: number[]): Promise<BlacklistHit[]> {
  if (memberIds.length === 0) return [];
  const rows = await db<BlacklistHit[]>`
    WITH RECURSIVE fam(root, id) AS (
      SELECT id, id FROM members WHERE id IN ${db(memberIds)}
      UNION
      SELECT f.root, x.id FROM fam f JOIN members x ON x.merged_into_id = f.id
    )
    SELECT b.id, r.id AS member_id, r.name AS member_name, CASE WHEN m.id <> r.id THEN m.name END AS via_name,
           b.reason, s.display_name AS created_by_name, b.created_at
    FROM fam f JOIN members r ON r.id = f.root JOIN members m ON m.id = f.id
    JOIN guest_blacklist b ON b.lifted_at IS NULL AND (b.member_id = m.id OR b.phone = m.phone)
    JOIN staff s ON s.id = b.created_by
    ORDER BY r.id, b.id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), memberId: Number(r.memberId) }));
}

/** 黑名单的称呼：登记在合并前的会员上的，写明是合并前的哪一位 */
const hitName = (hit: BlacklistHit) => (hit.viaName ? `${hit.memberName}（合并前的「${hit.viaName}」）` : hit.memberName);

export const blacklistedError = (hit: BlacklistHit) =>
  unprocessable('GUEST_BLACKLISTED', `会员「${hitName(hit)}」在黑名单里（${hit.reason}；${hit.createdByName}登记），不能发牌。确有需要请值班经理及以上先在会员详情里解除`, {
    memberId: hit.memberId,
    blacklistId: hit.id,
    reason: hit.reason,
    createdByName: hit.createdByName,
  });

const phone = z
  .string('请填写手机号')
  .trim()
  .regex(/^1\d{10}$/, '手机号应为 11 位数字');
const AddInput = z
  .object({
    memberId: z.number().int().positive('会员编号不正确').optional(),
    phone: phone.optional(),
    /** 只按手机号登记（不是会员）时要写称呼；按会员登记的用会员的姓名 */
    name: z.string().trim().max(32, '称呼最多 32 字').default(''),
    reason: z.string('请填写加入黑名单的原因').trim().min(2, '请填写加入黑名单的原因（至少 2 个字）').max(200, '原因最多 200 字'),
  })
  .refine((v) => (v.memberId === undefined) !== (v.phone === undefined), '请选择一位会员，或填写一个手机号（二选一）');

/**
 * 加入黑名单。按手机号登记时，这个号码已经是会员的按那位会员登记（以后换了号码照样拦）。
 * 同一位会员、同一个手机号同时只有一条没解除的（唯一索引兜底），已经在里面的拒绝。
 */
export async function addBlacklist(deps: Deps, raw: unknown, ctx: OpContext): Promise<BlacklistEntry> {
  const input = parse(AddInput, raw);
  try {
    const id = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 会员一行（FOR UPDATE）：发牌在写来访之前对会员一行加共享锁、锁住以后再查黑名单，两边串行——
      // 不会出现「黑名单已经登记成功，同一刻的发牌照样发出去」
      const [member] =
        input.memberId !== undefined
          ? await tx<{ id: number; name: string; mergedIntoNo: string | null }[]>`
              SELECT m.id, m.name, (SELECT t.member_no FROM members t WHERE t.id = m.merged_into_id) AS merged_into_no
              FROM members m WHERE m.id = ${input.memberId} FOR UPDATE OF m`
          : await tx<{ id: number; name: string; mergedIntoNo: string | null }[]>`
              SELECT m.id, m.name, (SELECT t.member_no FROM members t WHERE t.id = m.merged_into_id) AS merged_into_no
              FROM members m WHERE m.phone = ${input.phone!} FOR UPDATE OF m`;
      if (input.memberId !== undefined && !member) throw notFound('会员不存在，请重新查找');
      if (member?.mergedIntoNo) throw unprocessable('MEMBER_MERGED', `会员「${member.name}」已合并到 ${member.mergedIntoNo}，请对那位会员操作`);
      if (!member && !input.name) throw badRequest('只按手机号登记时请填写称呼（方便以后认人）');
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO guest_blacklist (member_id, phone, name, reason, created_by)
        VALUES (${member ? member.id : null}, ${member ? null : input.phone!}, ${member ? member.name : input.name}, ${input.reason}, ${ctx.actor.id})
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'blacklist_added',
        targetType: 'guest_blacklist',
        targetId: row!.id,
        detail: { memberId: member ? Number(member.id) : null, phone: member ? null : input.phone, name: member ? member.name : input.name, reason: input.reason },
        ip: ctx.ip,
      });
      return Number(row!.id);
    });
    return await getBlacklistEntry(deps.sql, id);
  } catch (error) {
    if (isUniqueViolation(error, 'guest_blacklist_member_active_uq') || isUniqueViolation(error, 'guest_blacklist_phone_active_uq')) {
      throw conflict('ALREADY_BLACKLISTED', '已经在黑名单里了，不用重复登记');
    }
    throw error;
  }
}

async function getBlacklistEntry(db: Db, id: number): Promise<BlacklistEntry> {
  const [row] = await db<BlacklistEntry[]>`SELECT ${ENTRY_COLUMNS(db)} FROM ${ENTRY_FROM(db)} WHERE b.id = ${id}`;
  if (!row) throw notFound('黑名单记录不存在');
  return toEntry(row);
}

const LiftInput = z.object({ reason: z.string('请填写解除的原因').trim().min(2, '请填写解除的原因（至少 2 个字）').max(200, '原因最多 200 字') });

/** 解除黑名单：只锁那一条；已经解除的拒绝（不重复记） */
export async function liftBlacklist(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<BlacklistEntry> {
  const input = parse(LiftInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [row] = await tx<{ id: number; name: string; liftedAt: string | null }[]>`SELECT id, name, lifted_at FROM guest_blacklist WHERE id = ${id} FOR UPDATE`;
    if (!row) throw notFound('黑名单记录不存在');
    if (row.liftedAt) throw conflict('ALREADY_LIFTED', `「${row.name}」已经解除过了，请刷新`);
    await tx`UPDATE guest_blacklist SET lifted_by = ${ctx.actor.id}, lifted_at = now(), lift_reason = ${input.reason} WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'blacklist_lifted',
      targetType: 'guest_blacklist',
      targetId: id,
      detail: { name: row.name, reason: input.reason },
      ip: ctx.ip,
    });
  });
  return getBlacklistEntry(deps.sql, id);
}

// ───────────────────────── 未结离店、重复到店、预约 ─────────────────────────

/** 这几位会员名下没处理完的「未结离店」（哪家店登记的都算：会员全公司一套） */
export async function unsettledDebts(db: Db, memberIds: number[]): Promise<(UnsettledDebt & { memberId: number })[]> {
  if (memberIds.length === 0) return [];
  const rows = await db<(UnsettledDebt & { memberId: number })[]>`
    SELECT i.id AS incident_id, i.member_id, i.visit_id, v.visit_no, t.code AS tag_code, i.amount_cents, i.note,
           cs.display_name AS created_by_name, i.created_at,
           (SELECT s.display_name FROM staff s
            WHERE s.id = coalesce((SELECT e.assignee_id FROM visit_incident_events e WHERE e.incident_id = i.id AND e.action = 'assign' ORDER BY e.id DESC LIMIT 1), i.assignee_id)
           ) AS assignee_name
    FROM visit_incidents i JOIN visits v ON v.id = i.visit_id JOIN hand_tags t ON t.id = v.tag_id JOIN staff cs ON cs.id = i.created_by
    WHERE i.kind = 'unsettled' AND i.member_id IN ${db(memberIds)}
      AND NOT EXISTS (SELECT 1 FROM visit_incident_events e WHERE e.incident_id = i.id AND e.action = 'resolve')
    ORDER BY i.id`;
  return rows.map((r) => ({ ...r, incidentId: Number(r.incidentId), memberId: Number(r.memberId), visitId: Number(r.visitId), amountCents: Number(r.amountCents) }));
}

/** 这位会员今天（营业日）在本店来过几次（不算撤销的），与最后一次的牌号、离店时间 */
export async function visitsToday(db: Db, memberId: number, date: string): Promise<MemberRisk['visitsToday']> {
  const rows = await db<{ tagCode: string; visitNo: string; closedAt: string | null }[]>`
    SELECT t.code AS tag_code, v.visit_no, v.closed_at
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id
    WHERE v.member_id = ${memberId} AND v.business_date = ${date} AND v.status <> 'cancelled' AND v.store_id = ${currentStoreId()}
    ORDER BY v.checked_in_at DESC, v.id DESC`;
  return { count: rows.length, last: rows[0] ?? null };
}

/** 这几位会员今天待到店的预约（本店） */
export async function openBookings(db: Db, memberIds: number[], date: string): Promise<(RiskBooking & { memberId: number })[]> {
  if (memberIds.length === 0) return [];
  const rows = await db<(Omit<RiskBooking, 'autoArrive'> & { memberId: number })[]>`
    SELECT b.id, b.member_id, b.booking_no, b.kind, b.status, b.starts_at, b.note,
           coalesce(i.name, sp.display_name, rt.name, '') AS what,
           CASE WHEN t.id IS NOT NULL THEN t.tech_no || ' 号 ' || t.name WHEN b.kind = 'technician' THEN '不指定' END AS technician_text
    FROM bookings b LEFT JOIN service_items i ON i.id = b.item_id LEFT JOIN technicians t ON t.id = b.technician_id
    LEFT JOIN spaces sp ON sp.id = b.space_id LEFT JOIN room_types rt ON rt.id = b.room_type_id
    WHERE b.member_id IN ${db(memberIds)} AND b.status IN ('pending', 'confirmed') AND b.business_date = ${date} AND b.store_id = ${currentStoreId()}
    ORDER BY b.starts_at, b.id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), memberId: Number(r.memberId), startsAt: new Date(r.startsAt).toISOString(), autoArrive: r.kind !== 'space' }));
}

/** 一位会员发牌前的风控结果（只读；页面预先看） */
export async function memberRisk(db: Db, deps: Deps, memberId: number): Promise<MemberRisk> {
  const [member] = await db<{ id: number }[]>`SELECT id FROM members WHERE id = ${memberId}`;
  if (!member) throw notFound('会员不存在');
  const rules = await loadRiskRules(db);
  if (!rules.enabled) return { enabled: false, memberId, blacklist: null, unsettled: [], visitsToday: { count: 0, last: null }, bookings: [] };
  const date = await businessDate(db, deps, new Date());
  const hit = (await blacklistHits(db, [memberId]))[0];
  return {
    enabled: true,
    memberId,
    blacklist: hit ? { id: hit.id, name: hitName(hit), reason: hit.reason, createdByName: hit.createdByName, createdAt: hit.createdAt } : null,
    unsettled: (await unsettledDebts(db, [memberId])).map(({ memberId: _m, ...d }) => d),
    visitsToday: await visitsToday(db, memberId, date),
    bookings: (await openBookings(db, [memberId], date)).map(({ memberId: _m, ...b }) => b),
  };
}

// ───────────────────────── 发牌的事务里用 ─────────────────────────

export interface LockedRiskBooking {
  id: number;
  bookingNo: string;
  memberId: number;
}

/**
 * 发牌带出预约：在锁手牌之前先锁这几位会员今天待到店的预约（技师、客房；id 升序）。
 * 锁的那一句带上全部候选条件（本店、这几位会员、这个营业日、待确认 / 已确认、不是派对房）：读已提交级别下，
 * 等锁的行在锁到以后按最新的一版重新核对条件，等锁期间被取消、记了爽约、别的终端点了到店、改到别的营业日的都不会被锁住、不动
 * （只核对状态不够：改期只改营业日、状态照旧，Codex 审查 f6327a4）。
 */
export async function lockArrivableBookings(tx: Tx, memberIds: number[], date: string): Promise<LockedRiskBooking[]> {
  const candidates = (await openBookings(tx, memberIds, date)).filter((b) => b.autoArrive).map((b) => b.id);
  if (candidates.length === 0) return [];
  const rows = await tx<{ id: number; bookingNo: string; memberId: number }[]>`
    SELECT id, booking_no, member_id FROM bookings
    WHERE id IN ${tx(candidates)} AND member_id IN ${tx(memberIds)} AND business_date = ${date} AND store_id = ${currentStoreId()}
      AND status IN ('pending', 'confirmed') AND kind <> 'space'
    ORDER BY id FOR UPDATE`;
  return rows.map((r) => ({ id: Number(r.id), bookingNo: r.bookingNo, memberId: Number(r.memberId) }));
}

/** 发牌成功后把锁住的预约标「已到店」、挂上这位会员刚发的手牌（与「预约」页点到店写的一样；审计里写明是发牌带出的） */
export async function arriveBookingsTx(
  tx: Tx,
  bookings: LockedRiskBooking[],
  visitOf: Map<number, { visitId: number; tagCode: string }>,
  opts: { at: Date; staffId: number; ip?: string; businessDate: string },
): Promise<void> {
  for (const b of bookings) {
    const v = visitOf.get(b.memberId);
    if (!v) continue;
    await tx`
      UPDATE bookings SET status = 'arrived', arrived_by = ${opts.staffId}, arrived_at = ${opts.at}, arrival_visit_id = ${v.visitId},
             confirmed_by = coalesce(confirmed_by, ${opts.staffId}), confirmed_at = coalesce(confirmed_at, ${opts.at}), version = version + 1
      WHERE id = ${b.id}`;
    await writeAudit(tx, {
      staffId: opts.staffId,
      action: 'booking_arrive',
      targetType: 'booking',
      targetId: b.id,
      detail: { bookingNo: b.bookingNo, tagCode: v.tagCode, via: 'checkin' },
      ip: opts.ip,
      businessDate: opts.businessDate,
    });
  }
}

// ───────────────────────── 路由 ─────────────────────────

export function registerRiskRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // 发牌前风控的开关（功能开关）：看板也带着；改要「修改经营规则」
  app.get('/api/frontdesk/risk-rules', { preHandler: guard('frontdesk.read') }, async () => loadRiskRules(sql));
  app.put('/api/frontdesk/risk-rules', { preHandler: guard('settings.manage') }, async (req) =>
    saveRuleSetting(sql, RISK_RULES_KEY, loadRiskRules, (before) => parse(RulesInput, { ...before, ...parse(RulesInput.partial(), req.body) }), ctxOf(req)),
  );

  // 页面预先看：黑名单、未结离店、今天第几次到店、待到店的预约；同一个只读快照
  app.get('/api/frontdesk/members/:id/risk', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return readSnapshot(sql, (tx) => memberRisk(tx, deps, id));
  });

  // 黑名单清单（后台）；会员详情里看这位在不在黑名单（能看会员的人都看得到，改要「维护黑名单」）
  app.get('/api/frontdesk/blacklist', { preHandler: guard('frontdesk.blacklist') }, async (req) => {
    const { all } = parse(z.object({ all: z.string().optional() }), req.query ?? {});
    return listBlacklist(sql, all === '1');
  });
  app.get('/api/frontdesk/blacklist/member/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { entry: await memberBlacklist(sql, id) };
  });
  app.post('/api/frontdesk/blacklist', { preHandler: guard('frontdesk.blacklist') }, async (req, reply) => {
    const entry = await addBlacklist(deps, req.body, ctxOf(req));
    reply.status(201);
    return entry;
  });
  app.post('/api/frontdesk/blacklist/:id/lift', { preHandler: guard('frontdesk.blacklist') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return liftBlacklist(deps, id, req.body, ctxOf(req));
  });
}
