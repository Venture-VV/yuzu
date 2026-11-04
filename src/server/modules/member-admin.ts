// 会员停用 / 启用、合并（v0.7.26，docs/MEMBERSHIP_FINISH.md 第 3、4 节；PENDING_DECISIONS M76、M78、M79）。
// 换手机号在编辑会员里（members.ts，M77），记录在这里一起读。
//
//   · 停用 / 启用：店主、店总（「停用、启用会员」），写原因；有在店手牌的不能停用；已合并的不能再改。每次一条记录（只追加）；
//   · 合并：店主、店总（「合并会员」），来源会员并进目标会员，不能撤销：
//       余额全部转过去（两条余额流水「合并转出」「合并转入」），赠金批次按原来的到期日搬过去，
//       目标会员取两位里高的状态（记一条状态变化「合并」），来源会员停用、记「合并到」；
//     前提：两位都在用、不是同一位；来源会员没有在店手牌、没有体验中的临时身份、没有能用的券、今天没有储值消费
//     （今天的单子可能还要撤销、反结账；合并以后来源会员合并之前的消费不能再撤销到这份档案上）。
//
// 加锁：先取操作编号的咨询锁（与「确认作废」串行）→ 会员一行（合并按 id 升序锁两位）；赠金批次在会员之后（与消费、撤销一样）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import type { MemberAccountHistory, MemberMergeDetail, MemberPhoneChange, MemberStatus, MemberStatusEvent, MergeCheck, MergeParty } from '@shared/member-admin';
import { gradeLabel, type Grade, type Tier } from '@shared/membership';
import { formatYuan } from '@shared/money';
import { guard } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { cents, idParam, parse } from '../lib/validate';
import { expireDueLots, moveLotsForMerge } from './bonus';
import { erpOpAbandoned } from './erp-ops';
import { applyMergeGrade, loadMembershipRules, previewMergeGrade } from './membership';
import { loadSettings } from './settings';
import { applyBalance, type LockedMember } from './wallet-core';

const reasonField = z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 字');
const clientKeyField = z.uuid('缺少有效的操作编号，请刷新页面后重试');

async function businessDate(db: Db, deps: Deps, at: Date) {
  const settings = await loadSettings(db);
  return businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
}

// ───────────────────────── 停用 / 启用 ─────────────────────────

const StatusInput = z.object({ clientKey: clientKeyField, status: z.enum(['active', 'frozen']), reason: reasonField });
export type MemberStatusInputData = z.input<typeof StatusInput>;

const STATUS_EVENT_SQL = (db: Db) => db`
  SELECT e.id, e.member_id, e.from_status, e.to_status, e.reason, s.display_name AS staff_name, e.business_date, e.created_at, g.merge_no
  FROM member_status_events e JOIN staff s ON s.id = e.staff_id LEFT JOIN member_merges g ON g.id = e.member_merge_id`;

const toStatusEvent = (r: MemberStatusEvent): MemberStatusEvent => ({ ...r, id: Number(r.id), memberId: Number(r.memberId), createdAt: new Date(r.createdAt).toISOString() });

export async function getStatusEvent(db: Db, id: number): Promise<MemberStatusEvent> {
  const [row] = await db<MemberStatusEvent[]>`${STATUS_EVENT_SQL(db)} WHERE e.id = ${id}`;
  if (!row) throw notFound('记录不存在');
  return toStatusEvent(row);
}

/** 有在店手牌（来访没结账）时返回手牌号 */
async function openTags(db: Db, memberId: number): Promise<string | null> {
  const [v] = await db<{ tags: string | null }[]>`
    SELECT string_agg(t.code, '、' ORDER BY t.code) AS tags FROM visits v JOIN hand_tags t ON t.id = v.tag_id
    WHERE v.status = 'open' AND v.member_id = ${memberId}`;
  return v?.tags ?? null;
}

/** 停用 / 启用（M76）。同一编号重提返回原来那条；结果待确认时可以「确认作废」，之后原请求晚到也不生效 */
export async function setMemberStatus(deps: Deps, memberId: number, raw: unknown, ctx: OpContext): Promise<{ memberId: number; event: MemberStatusEvent; replayed: boolean }> {
  const input = parse(StatusInput, raw);
  const requestHash = hashRequest({ memberId, status: input.status, reason: input.reason });
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM member_status_events WHERE client_key = ${input.clientKey}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次停用 / 启用，请刷新页面后重新办理');
    return Number(p.id);
  };
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, input.clientKey, 'member_status', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const at = ctx.at ?? new Date();
      const date = await businessDate(tx, deps, at);
      const [m] = await tx<{ id: number; memberNo: string; name: string; status: MemberStatus; mergedIntoId: number | null }[]>`
        SELECT id, member_no, name, status, merged_into_id FROM members WHERE id = ${memberId} FOR UPDATE`;
      if (!m) throw notFound('会员不存在');
      if (m.mergedIntoId !== null) throw unprocessable('MEMBER_MERGED', '这位会员已合并到另一位会员，不能再停用或启用');
      if (m.status === input.status) {
        throw conflict('STATUS_UNCHANGED', input.status === 'frozen' ? '这位会员已经停用了，请刷新后再看' : '这位会员已经启用了，请刷新后再看');
      }
      if (input.status === 'frozen') {
        const tags = await openTags(tx, memberId);
        if (tags) throw unprocessable('MEMBER_IN_STORE', `这位会员有在店手牌 ${tags}，先结账再停用`);
      }
      await tx`UPDATE members SET status = ${input.status}, updated_at = now() WHERE id = ${memberId}`;
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO member_status_events (member_id, from_status, to_status, reason, staff_id, business_date, created_at, client_key, request_hash)
        VALUES (${memberId}, ${m.status}, ${input.status}, ${input.reason}, ${ctx.actor.id}, ${date}, ${at}, ${input.clientKey}, ${requestHash})
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'member_status_changed',
        targetType: 'member',
        targetId: memberId,
        detail: { memberNo: m.memberNo, name: m.name, from: m.status, to: input.status, reason: input.reason, summary: `${input.status === 'frozen' ? '停用' : '启用'}会员 ${m.name}（${m.memberNo}）` },
        ip: ctx.ip,
        businessDate: date,
      });
      return { id: Number(row!.id), replayed: false };
    });
    return { memberId, event: await getStatusEvent(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    // 同一编号并发提交：后到的一笔撞上唯一约束，按原来那条返回
    if (isUniqueViolation(error, 'member_status_events_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { memberId, event: await getStatusEvent(deps.sql, id), replayed: true };
    }
    throw error;
  }
}

// ───────────────────────── 合并 ─────────────────────────

const MergeInput = z.object({
  clientKey: clientKeyField,
  targetId: z.number('请选择合并到哪位会员').int().positive('请选择合并到哪位会员'),
  reason: reasonField,
  /** 页面核对时看到的要转过去的本金、赠金：与此刻的不一致拒绝（中间有人充值、消费过） */
  expectedPrincipal: cents('本金'),
  expectedBonus: cents('赠金'),
});
export type MemberMergeInputData = z.input<typeof MergeInput>;

interface MergeMemberRow extends MergeParty {
  status: MemberStatus;
  mergedIntoId: number | null;
  principalBalance: number;
  bonusBalance: number;
}

async function mergeRows(db: Db, ids: number[], lock: boolean): Promise<MergeMemberRow[]> {
  const rows = await db<MergeMemberRow[]>`
    SELECT id, member_no, name, phone, status, merged_into_id, principal_balance, bonus_balance FROM members
    WHERE id IN ${db(ids)} ORDER BY id ${lock ? db`FOR UPDATE` : db``}`;
  return rows.map((r) => ({ ...r, id: Number(r.id), mergedIntoId: r.mergedIntoId === null ? null : Number(r.mergedIntoId) }));
}

/** 不能合并的原因（只读；合并时在两位会员一行锁住之后再查一次） */
async function mergeProblems(db: Db, source: MergeMemberRow, target: MergeMemberRow, today: string): Promise<string[]> {
  const out: string[] = [];
  if (source.mergedIntoId !== null) out.push(`「${source.name}」已经合并过了`);
  else if (source.status !== 'active') out.push(`「${source.name}」已停用：先启用再合并`);
  if (target.mergedIntoId !== null) out.push(`「${target.name}」已合并到别的会员，请合并到那位`);
  else if (target.status !== 'active') out.push(`「${target.name}」已停用：先启用再合并`);
  const tags = await openTags(db, source.id);
  if (tags) out.push(`「${source.name}」有在店手牌 ${tags}，先结账再合并`);
  const [trial] = await db<{ endsOn: string }[]>`
    SELECT ends_on::text AS ends_on FROM member_trials
    WHERE member_id = ${source.id} AND status = 'active' AND starts_on <= ${today}::date AND ends_on >= ${today}::date`;
  if (trial) out.push(`「${source.name}」有体验中的临时身份（到 ${trial.endsOn}），等到期或撤销后再合并`);
  const [coupons] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM coupons WHERE member_id = ${source.id} AND status = 'available' AND valid_to >= ${today}::date`;
  if (coupons!.n > 0) out.push(`「${source.name}」还有 ${coupons!.n} 张能用的券：先用掉，或作废后给「${target.name}」补发`);
  const [spent] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM consumptions WHERE member_id = ${source.id} AND status = 'completed' AND business_date = ${today}`;
  if (spent!.n > 0) out.push(`「${source.name}」今天有储值消费（可能还要撤销或反结账），明天再合并`);
  return out;
}

const party = (r: MergeMemberRow): MergeParty => ({ id: r.id, memberNo: r.memberNo, name: r.name, phone: r.phone });

/** 合并前核对（只读）：页面在确认前看两位的余额、档阶、合并以后的档阶与不能合并的原因 */
export async function mergeCheck(deps: Deps, sourceId: number, targetId: number): Promise<MergeCheck> {
  if (sourceId === targetId) throw unprocessable('MERGE_SELF', '不能合并到自己：请选另一位会员');
  return readSnapshot(deps.sql, async (db) => {
    const now = new Date();
    const today = await businessDate(db, deps, now);
    const rows = await mergeRows(db, [sourceId, targetId], false);
    const source = rows.find((r) => r.id === sourceId);
    const target = rows.find((r) => r.id === targetId);
    if (!source || !target) throw notFound('会员不存在');
    // 到期没用完的赠金在合并时先作废：按此刻会作废的扣掉
    const [due] = await db<{ amount: number }[]>`
      SELECT coalesce(sum(remaining), 0)::bigint AS amount FROM bonus_lots WHERE member_id = ${sourceId} AND remaining > 0 AND expires_at <= ${now}`;
    const grade = await previewMergeGrade(db, sourceId, targetId, today);
    return {
      source: { ...party(source), principal: source.principalBalance, bonus: source.bonusBalance, grade: grade.source, status: source.status },
      target: { ...party(target), principal: target.principalBalance, bonus: target.bonusBalance, grade: grade.target, status: target.status },
      principal: source.principalBalance,
      bonus: source.bonusBalance - Number(due!.amount),
      gradeAfter: grade.after,
      gradeChanged: grade.changed,
      problems: await mergeProblems(db, source, target, today),
    };
  });
}

const MERGE_SQL = (db: Db) => db`
  SELECT g.id, g.merge_no, g.principal, g.bonus, g.reason, s.display_name AS staff_name, g.business_date, g.created_at,
         json_build_object('id', a.id, 'memberNo', a.member_no, 'name', a.name, 'phone', a.phone) AS source,
         json_build_object('id', b.id, 'memberNo', b.member_no, 'name', b.name, 'phone', b.phone) AS target,
         (SELECT json_build_object('fromGrade', e.from_grade, 'fromTier', e.from_tier, 'toGrade', e.to_grade, 'toTier', e.to_tier)
          FROM member_grade_events e WHERE e.member_merge_id = g.id LIMIT 1) AS grade_event
  FROM member_merges g JOIN members a ON a.id = g.source_id JOIN members b ON b.id = g.target_id JOIN staff s ON s.id = g.staff_id`;

type MergeRow = Omit<MemberMergeDetail, 'grade'> & { gradeEvent: { fromGrade: number; fromTier: number | null; toGrade: number; toTier: number | null } | null };

async function toMergeDetails(db: Db, rows: MergeRow[]): Promise<MemberMergeDetail[]> {
  if (!rows.length) return [];
  const rules = await loadMembershipRules(db);
  return rows.map(({ gradeEvent: e, ...r }) => ({
    ...r,
    id: Number(r.id),
    principal: Number(r.principal),
    bonus: Number(r.bonus),
    createdAt: new Date(r.createdAt).toISOString(),
    source: { ...r.source, id: Number(r.source.id) },
    target: { ...r.target, id: Number(r.target.id) },
    grade: e ? { from: gradeLabel(rules, e.fromGrade as Grade, e.fromTier as Tier | null), to: gradeLabel(rules, e.toGrade as Grade, e.toTier as Tier | null) } : null,
  }));
}

export async function getMemberMerge(db: Db, id: number): Promise<MemberMergeDetail> {
  const rows = await db<MergeRow[]>`${MERGE_SQL(db)} WHERE g.id = ${id}`;
  const [detail] = await toMergeDetails(db, rows);
  if (!detail) throw notFound('合并单不存在');
  return detail;
}

/**
 * 合并（M78、M79）：来源会员（memberId）并进目标会员。同一编号重提返回原来那张；结果待确认时可以「确认作废」。
 * 两位会员按 id 升序锁；到期没用完的赠金先作废、到期没处理的档阶先处理，再按处理完的转
 */
export async function mergeMember(deps: Deps, sourceId: number, raw: unknown, ctx: OpContext): Promise<{ merge: MemberMergeDetail; replayed: boolean }> {
  const input = parse(MergeInput, raw);
  if (input.targetId === sourceId) throw unprocessable('MERGE_SELF', '不能合并到自己：请选另一位会员');
  const requestHash = hashRequest({ sourceId, targetId: input.targetId, reason: input.reason, principal: input.expectedPrincipal, bonus: input.expectedBonus });
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM member_merges WHERE client_key = ${input.clientKey}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次合并，请刷新页面后重新办理');
    return Number(p.id);
  };
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, input.clientKey, 'member_merge', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const at = ctx.at ?? new Date();
      const date = await businessDate(tx, deps, at);
      const rows = await mergeRows(tx, [sourceId, input.targetId], true);
      const source = rows.find((r) => r.id === sourceId);
      const target = rows.find((r) => r.id === input.targetId);
      if (!source || !target) throw notFound('会员不存在');
      const problems = await mergeProblems(tx, source, target, date);
      if (problems.length) throw unprocessable('MERGE_BLOCKED', problems[0]!, { problems });
      // 到期没用完的赠金先作废（两位都是，按 id 升序），转的是作废之后的余额
      const locked = new Map<number, LockedMember>();
      for (const r of rows) {
        locked.set(r.id, await expireDueLots(tx, deps, { id: r.id, name: r.name, principalBalance: r.principalBalance, bonusBalance: r.bonusBalance, status: r.status }, at));
      }
      const from = locked.get(sourceId)!;
      const into = locked.get(input.targetId)!;
      if (from.principalBalance !== input.expectedPrincipal || from.bonusBalance !== input.expectedBonus) {
        throw conflict('MERGE_CHANGED', `「${source.name}」的余额刚刚有变化（现在本金 ${formatYuan(from.principalBalance)}、赠金 ${formatYuan(from.bonusBalance)}），请重新核对`, {
          principal: from.principalBalance,
          bonus: from.bonusBalance,
        });
      }
      const mergeNo = await nextDocNo(tx, 'member_merge', 'HB', date);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO member_merges (merge_no, source_id, target_id, principal, bonus, reason, staff_id, business_date, created_at, client_key, request_hash)
        VALUES (${mergeNo}, ${sourceId}, ${input.targetId}, ${from.principalBalance}, ${from.bonusBalance}, ${input.reason}, ${ctx.actor.id}, ${date}, ${at},
                ${input.clientKey}, ${requestHash})
        RETURNING id`;
      const mergeId = Number(row!.id);
      // 余额：来源「合并转出」、目标「合并转入」；赠金批次按原来的到期日搬过去
      if (from.principalBalance + from.bonusBalance > 0) {
        await applyBalance(tx, from, { principal: -from.principalBalance, bonus: -from.bonusBalance }, {
          entryType: 'merge_out', docNo: mergeNo, memberMergeId: mergeId, businessDate: date, operatorId: ctx.actor.id, at,
        });
        await applyBalance(tx, into, { principal: from.principalBalance, bonus: from.bonusBalance }, {
          entryType: 'merge_in', docNo: mergeNo, memberMergeId: mergeId, businessDate: date, operatorId: ctx.actor.id, at,
        });
      }
      await moveLotsForMerge(tx, { sourceId, targetId: input.targetId, mergeId, amount: from.bonusBalance, at });
      // 档阶：目标会员取两位里高的状态
      const grade = await applyMergeGrade(tx, { sourceId, targetId: input.targetId, mergeId, today: date, staffId: ctx.actor.id, reason: input.reason });
      // 来源会员停用、记「合并到」（停用记录指向合并单）
      await tx`UPDATE members SET status = 'frozen', merged_into_id = ${input.targetId}, updated_at = now() WHERE id = ${sourceId}`;
      await tx`
        INSERT INTO member_status_events (member_id, from_status, to_status, member_merge_id, reason, staff_id, business_date, created_at)
        VALUES (${sourceId}, 'active', 'frozen', ${mergeId}, ${`合并到 ${target.memberNo}：${input.reason}`.slice(0, 200)}, ${ctx.actor.id}, ${date}, ${at})`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'member_merged',
        targetType: 'member',
        targetId: input.targetId,
        detail: {
          docNo: mergeNo,
          sourceId,
          source: `${source.name}（${source.memberNo}）`,
          target: `${target.name}（${target.memberNo}）`,
          principal: from.principalBalance,
          bonus: from.bonusBalance,
          grade: grade.changed ? `${grade.from} → ${grade.to}` : undefined,
          reason: input.reason,
          summary: `${source.name}（${source.memberNo}）并进 ${target.name}（${target.memberNo}）：本金 ${formatYuan(from.principalBalance)}、赠金 ${formatYuan(from.bonusBalance)}`,
        },
        ip: ctx.ip,
        businessDate: date,
      });
      return { id: mergeId, replayed: false };
    });
    return { merge: await getMemberMerge(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    if (isUniqueViolation(error, 'member_merges_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { merge: await getMemberMerge(deps.sql, id), replayed: true };
    }
    // 同一位来源会员同时被并两次：后到的一笔撞上唯一约束
    if (isUniqueViolation(error, 'member_merges_source_id_key')) throw conflict('MERGE_DONE', '这位会员刚刚已经合并过了，请刷新后再看');
    throw error;
  }
}

// ───────────────────────── 读取 ─────────────────────────

export async function memberAccountHistory(db: Db, memberId: number): Promise<MemberAccountHistory> {
  const statusEvents = (await db<MemberStatusEvent[]>`${STATUS_EVENT_SQL(db)} WHERE e.member_id = ${memberId} ORDER BY e.id DESC`).map(toStatusEvent);
  const phoneChanges = (
    await db<MemberPhoneChange[]>`
      SELECT c.id, c.member_id, c.old_phone, c.new_phone, c.reason, s.display_name AS staff_name, a.display_name AS approver_name, c.business_date, c.created_at
      FROM member_phone_changes c JOIN staff s ON s.id = c.staff_id LEFT JOIN staff a ON a.id = c.approved_by
      WHERE c.member_id = ${memberId} ORDER BY c.id DESC`
  ).map((r) => ({ ...r, id: Number(r.id), memberId: Number(r.memberId), createdAt: new Date(r.createdAt).toISOString() }));
  const mergedFrom = await toMergeDetails(db, await db<MergeRow[]>`${MERGE_SQL(db)} WHERE g.target_id = ${memberId} ORDER BY g.id DESC`);
  const [into] = await toMergeDetails(db, await db<MergeRow[]>`${MERGE_SQL(db)} WHERE g.source_id = ${memberId}`);
  return { statusEvents, phoneChanges, mergedFrom, mergedInto: into ?? null };
}

// ───────────────────────── 自检 ─────────────────────────

/**
 * 合并的自检（2 项）：每张合并单的余额流水（转出 = 转入 = 单子上的）、赠金批次（转出 = 搬过去 = 单子上的赠金）、来源会员停用并记合并到目标；
 * 被并走的会员余额为 0（以后什么都不能记到它上面）
 */
export async function memberMergeChecks(db: Db): Promise<{ label: string; ok: boolean; detail: string }[]> {
  const [a] = await db<{ n: number; bad: number }[]>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE
             (g.principal + g.bonus > 0 AND (
               NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.member_merge_id = g.id AND e.entry_type = 'merge_out' AND e.member_id = g.source_id
                                                         AND e.principal_delta = -g.principal AND e.bonus_delta = -g.bonus)
               OR NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.member_merge_id = g.id AND e.entry_type = 'merge_in' AND e.member_id = g.target_id
                                                            AND e.principal_delta = g.principal AND e.bonus_delta = g.bonus)))
             OR (SELECT count(*) FROM ledger_entries e WHERE e.member_merge_id = g.id) <> CASE WHEN g.principal + g.bonus > 0 THEN 2 ELSE 0 END
             OR g.bonus <> -(SELECT coalesce(sum(mv.amount), 0) FROM bonus_lot_moves mv WHERE mv.member_merge_id = g.id AND mv.kind = 'merge_out')
             OR g.bonus <> (SELECT coalesce(sum(l.amount), 0) FROM bonus_lots l WHERE l.member_merge_id = g.id AND l.member_id = g.target_id)
             OR NOT EXISTS (SELECT 1 FROM members m WHERE m.id = g.source_id AND m.merged_into_id = g.target_id AND m.status = 'frozen'))::int AS bad
    FROM member_merges g`;
  // 被并走的会员：余额为 0，也没有在店的来访（接待与合并在会员一行上串行；测试会话 dcbf252 的 P2）
  const [b] = await db<{ n: number; bad: number; inStore: number }[]>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE principal_balance <> 0 OR bonus_balance <> 0)::int AS bad,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM visits v WHERE v.member_id = m.id AND v.status = 'open'))::int AS in_store
    FROM members m WHERE merged_into_id IS NOT NULL`;
  return [
    {
      label: '会员合并：合并单 = 转出 = 转入 = 搬过去的赠金批次',
      ok: a!.bad === 0,
      detail: a!.bad ? `${a!.bad} 张合并单的流水、赠金批次或来源会员的状态对不上` : `共 ${a!.n} 张合并单，逐张核对一致`,
    },
    {
      label: '会员合并：被并走的会员余额为 0、不在店',
      ok: b!.bad === 0 && b!.inStore === 0,
      detail:
        b!.bad || b!.inStore
          ? [b!.bad ? `${b!.bad} 位被并走的会员还有余额` : '', b!.inStore ? `${b!.inStore} 位被并走的会员还有在店手牌` : ''].filter(Boolean).join('；')
          : `被并走的会员 ${b!.n} 位，余额都是 0、都不在店`,
    },
  ];
}

// ───────────────────────── 接口 ─────────────────────────

const MergeCheckQuery = z.object({ targetId: z.coerce.number().int().positive('请选择合并到哪位会员') });

export function registerMemberAdminRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.post('/api/members/:id/status', { preHandler: guard('member.status') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return setMemberStatus(deps, id, req.body, ctxOf(req));
  });
  app.get('/api/members/:id/merge-check', { preHandler: guard('member.merge') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { targetId } = parse(MergeCheckQuery, req.query ?? {});
    return mergeCheck(deps, id, targetId);
  });
  app.post('/api/members/:id/merge', { preHandler: guard('member.merge') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return mergeMember(deps, id, req.body, ctxOf(req));
  });
  app.get('/api/members/:id/account-history', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return memberAccountHistory(sql, id);
  });
  app.get('/api/member-merges/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getMemberMerge(sql, id);
  });
}
