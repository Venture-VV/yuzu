// 发牌后的异常处置（8.1.15《浴族系统需求汇总》块 A，docs/FRONTDESK_RISK_V8115.md 第 4 节）：
//   · 提醒：记一条「已提醒」；
//   · 加收：挂一笔「超时加收」——就是一条手动金额的明细，走原来的挂账（postChargesTx），不另建余额；值班经理及以上直接加，别人要当场授权；
//   · 上报：记一条上报、指给一位责任人，进「异常待办」；
//   · 临时外出 / 返回：来访标「外出」，牌照旧占着；
//   · 未结离店：记一条待办（应收多少、责任人），这位会员下次发牌要当场授权（risk.ts）。
// 异常与处理记录都只追加（迁移 187 的触发器不许改、不许删）。手牌丢失不另记：就是换牌（visit_tag_changes）。
//
// 锁（docs/LOCKING.md 第 1 节）：
//   · 登记异常：来访（FOR UPDATE）→ 加收时照挂账的顺序（账单）→ 授权凭据 → 写异常；带操作编号（visit_incident），
//     同一编号重提返回第一次的结果，写编号前与「确认作废」串行；
//   · 指派、写处理结果：只锁那一条异常（FOR UPDATE），不锁来访；一条待办只有一个处理结果靠部分唯一索引兜底。

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { MAX_SURCHARGE_CENTS, SURCHARGE_LINE_NAME, type IncidentTodoList, type VisitIncident } from '@shared/frontdesk-risk';
import { formatYuan } from '@shared/money';
import { can } from '@shared/permissions';
import { consumeSurchargeGrant } from '../../auth/grants';
import { guard } from '../../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { currentStoreId } from '../../lib/store-context';
import { idParam, parse, positiveCents } from '../../lib/validate';
import { postChargesTx, type PostInputParsed } from './bills';
import { assertOpen, businessDate, hashRequest, lockVisits, runIdempotent, saveKey, setTxTimeouts } from './common';
import { ASSIGNEE_ROLES, listTodos } from './incident-read';
import { getVisit } from './visits';

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const optionalNote = z.string().trim().max(200, '备注最多 200 字').default('');
const reason = (what: string) => z.string(`请填写${what}`).trim().min(2, `请填写${what}（至少 2 个字）`).max(200, `${what}最多 200 字`);
const assigneeId = z.number().int().positive('责任人不正确').nullable().default(null);

export const IncidentInput = z.discriminatedUnion(
  'kind',
  [
    z.object({ clientKey, kind: z.literal('remind'), note: optionalNote }),
    z.object({
      clientKey,
      kind: z.literal('surcharge'),
      amount: positiveCents('加收金额').max(MAX_SURCHARGE_CENTS, `加收一笔最多 ${formatYuan(MAX_SURCHARGE_CENTS)}`),
      note: z.string('请填写加收的原因').trim().min(2, '请填写加收的原因（至少 2 个字）').max(100, '加收的原因最多 100 字'),
      /** 没有「前台风控的当场授权」的人加收时，值班经理及以上签发的授权（用途 checkin_risk，绑定这次来访与金额） */
      grantId: z.uuid('授权编号格式不正确').nullable().default(null),
    }),
    z.object({ clientKey, kind: z.literal('report'), note: reason('上报的情况'), assigneeId }),
    z.object({ clientKey, kind: z.literal('away'), note: optionalNote }),
    z.object({ clientKey, kind: z.literal('return'), note: optionalNote }),
    z.object({ clientKey, kind: z.literal('unsettled'), amount: positiveCents('应收金额'), note: reason('未结离店的情况'), assigneeId }),
  ],
  '请选择异常的处置方式',
);
export type IncidentInputData = z.input<typeof IncidentInput>;

async function assertAssignee(tx: Db, id: number): Promise<string> {
  const [s] = await tx<{ displayName: string; active: boolean; role: string }[]>`SELECT display_name, active, role FROM staff WHERE id = ${id}`;
  if (!s || !s.active || !(ASSIGNEE_ROLES as readonly string[]).includes(s.role)) throw unprocessable('ASSIGNEE_INVALID', '责任人不存在或已停用，请重新选择');
  return s.displayName;
}

/** 登记一条异常（带操作编号；同一编号重提返回第一次的结果）。返回这次来访的最新详情 */
export async function createIncident(deps: Deps, visitId: number, raw: IncidentInputData, ctx: OpContext) {
  const input = parse(IncidentInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ visitId, ...payload });
  await runIdempotent(deps, { key, opType: 'visit_incident', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    // 来访（FOR UPDATE）：同一次来访上的异常串行（外出 / 返回、未结离店都按锁住以后的状态判断）
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    const date = await businessDate(tx, deps, at);
    const [state] = await tx<{ awaySince: string | null; tagCode: string }[]>`
      SELECT v.away_since, t.code AS tag_code FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE v.id = ${visit.id}`;
    let amount: number | null = null;
    let billLineId: number | null = null;
    let approval: { approverId: number; approverName: string } | null = null;
    let assignee: { id: number; name: string } | null = null;
    let keySaved = false;

    if (input.kind === 'away') {
      if (state!.awaySince) throw conflict('ALREADY_AWAY', `手牌 ${state!.tagCode} 已经标了外出，请刷新`);
      await tx`UPDATE visits SET away_since = ${at}, away_by = ${ctx.actor.id} WHERE id = ${visit.id}`;
    } else if (input.kind === 'return') {
      if (!state!.awaySince) throw conflict('NOT_AWAY', `手牌 ${state!.tagCode} 没有标外出，请刷新`);
      await tx`UPDATE visits SET away_since = NULL, away_by = NULL WHERE id = ${visit.id}`;
    } else if (input.kind === 'report' || input.kind === 'unsettled') {
      if (input.assigneeId !== null) assignee = { id: input.assigneeId, name: await assertAssignee(tx, input.assigneeId) };
      if (input.kind === 'unsettled') {
        // 同一次来访同时只有一条没处理完的未结离店（来访锁住了，这里的核对与另一笔登记串行）
        const [open] = await tx<{ id: number }[]>`
          SELECT i.id FROM visit_incidents i WHERE i.visit_id = ${visit.id} AND i.kind = 'unsettled'
            AND NOT EXISTS (SELECT 1 FROM visit_incident_events e WHERE e.incident_id = i.id AND e.action = 'resolve') LIMIT 1`;
        if (open) throw conflict('ALREADY_UNSETTLED', `手牌 ${state!.tagCode} 已经记过未结离店，还没处理完；请在「异常待办」里跟进`);
        amount = input.amount;
      }
    } else if (input.kind === 'surcharge') {
      // 值班经理及以上直接加收；别人要带当场授权（没带的在挂账之前就拒绝，不做无用功）
      const direct = can(ctx.actor, 'auth.checkinRisk');
      if (!direct && !input.grantId) {
        throw unprocessable('SURCHARGE_AUTH_REQUIRED', '超时加收要值班经理、店总或店主当场授权', { visitId: visit.id, amount: input.amount });
      }
      // 走原来的挂账：一条手动金额的明细（来访 → 账单；编号由挂账那一步写下，类型记成 visit_incident）
      const post: PostInputParsed = { clientKey: key, lines: [], customLines: [{ name: SURCHARGE_LINE_NAME, amount: input.amount }], expectedTotal: input.amount, backfill: undefined };
      const posted = await postChargesTx(tx, deps, visit.id, post, { key, requestHash, backfill: null, opType: 'visit_incident' }, ctx);
      keySaved = true;
      amount = input.amount;
      billLineId = posted.lines[0]!.lineId;
      // 授权凭据最后加锁并核销（业务回滚时一起回滚）
      if (!direct) approval = await consumeSurchargeGrant(tx, { grantId: input.grantId!, actor: ctx.actor, visitId: visit.id, amount: input.amount, usedRef: `visit_incident:${key}` });
    }

    const [row] = await tx<{ id: number }[]>`
      INSERT INTO visit_incidents (visit_id, member_id, kind, note, amount_cents, bill_line_id, approved_by, assignee_id, op_key, business_date, created_by, created_at)
      VALUES (${visit.id}, ${visit.memberId}, ${input.kind}, ${input.note}, ${amount}, ${billLineId}, ${approval?.approverId ?? null}, ${assignee?.id ?? null},
              ${key}, ${date}, ${ctx.actor.id}, ${at})
      RETURNING id`;
    if (!keySaved) await saveKey(tx, key, 'visit_incident', requestHash, visit.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'visit_incident',
      targetType: 'visit',
      targetId: visit.id,
      detail: {
        visitNo: visit.visitNo,
        tagCode: state!.tagCode,
        incidentId: Number(row!.id),
        kind: input.kind,
        note: input.note,
        ...(amount !== null ? { amount } : {}),
        ...(assignee ? { assigneeId: assignee.id, assigneeName: assignee.name } : {}),
        ...(approval ? { approverId: approval.approverId, approverName: approval.approverName, grantId: input.kind === 'surcharge' ? input.grantId : null } : {}),
      },
      ip: ctx.ip,
      businessDate: date,
    });
    return visit.id;
  });
  return getVisit(deps.sql, visitId, deps.config.timezone);
}

// ───────────────────────── 指派、处理结果 ─────────────────────────

interface LockedIncident {
  id: number;
  visitId: number;
  kind: VisitIncident['kind'];
  visitNo: string;
  assigneeId: number | null;
  resolved: boolean;
}

/** 锁住一条待办（本店的上报、未结离店、超时提醒），带上现在的责任人与有没有处理结果 */
async function lockTodo(tx: Tx, id: number): Promise<LockedIncident> {
  const [row] = await tx<{ id: number; visitId: number; kind: VisitIncident['kind'] }[]>`
    SELECT id, visit_id, kind FROM visit_incidents WHERE id = ${id} AND store_id = ${currentStoreId()} FOR UPDATE`;
  if (!row) throw notFound('这条异常不存在，请刷新');
  if (row.kind !== 'report' && row.kind !== 'unsettled' && row.kind !== 'overtime') throw unprocessable('NOT_TODO', '只有上报、未结离店、超时提醒要指派和写处理结果');
  const [more] = await tx<{ visitNo: string; assigneeId: number | null; resolved: boolean }[]>`
    SELECT v.visit_no,
           coalesce((SELECT e.assignee_id FROM visit_incident_events e WHERE e.incident_id = i.id AND e.action = 'assign' ORDER BY e.id DESC LIMIT 1), i.assignee_id) AS assignee_id,
           EXISTS (SELECT 1 FROM visit_incident_events e WHERE e.incident_id = i.id AND e.action = 'resolve') AS resolved
    FROM visit_incidents i JOIN visits v ON v.id = i.visit_id WHERE i.id = ${id}`;
  return {
    id: Number(row.id),
    visitId: Number(row.visitId),
    kind: row.kind,
    visitNo: more!.visitNo,
    assigneeId: more!.assigneeId === null ? null : Number(more!.assigneeId),
    resolved: more!.resolved,
  };
}

const resolvedError = () => conflict('ALREADY_RESOLVED', '这条待办已经处理完了，请刷新');

const AssignInput = z.object({ assigneeId: z.number('请选择责任人').int().positive('请选择责任人') });

/** 指派（改派）责任人：已经是这位的不重复记 */
export async function assignIncident(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<IncidentTodoList> {
  const input = parse(AssignInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const todo = await lockTodo(tx, id);
    if (todo.resolved) throw resolvedError();
    if (todo.assigneeId === input.assigneeId) return;
    const name = await assertAssignee(tx, input.assigneeId);
    await tx`INSERT INTO visit_incident_events (incident_id, action, assignee_id, operator_id) VALUES (${id}, 'assign', ${input.assigneeId}, ${ctx.actor.id})`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'incident_assigned',
      targetType: 'visit',
      targetId: todo.visitId,
      detail: { visitNo: todo.visitNo, incidentId: id, kind: todo.kind, assigneeId: input.assigneeId, assigneeName: name },
      ip: ctx.ip,
    });
  });
  return listTodos(deps.sql);
}

const ResolveInput = z.object({ note: z.string('请填写处理结果').trim().min(2, '请填写处理结果（至少 2 个字）').max(200, '处理结果最多 200 字') });

/**
 * 写处理结果（一条待办只能写一次）。未结离店处理完，这位会员下次发牌就不再拦——所以要值班经理及以上（前台风控的当场授权那一项权限）；
 * 上报的待办有发牌、挂账权限的人都能写
 */
export async function resolveIncident(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<IncidentTodoList> {
  const input = parse(ResolveInput, raw);
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const todo = await lockTodo(tx, id);
      if (todo.resolved) throw resolvedError();
      if (todo.kind === 'unsettled' && !can(ctx.actor, 'auth.checkinRisk')) throw forbidden('未结离店的待办要值班经理、店总或店主写处理结果');
      await tx`INSERT INTO visit_incident_events (incident_id, action, note, operator_id) VALUES (${id}, 'resolve', ${input.note}, ${ctx.actor.id})`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'incident_resolved',
        targetType: 'visit',
        targetId: todo.visitId,
        detail: { visitNo: todo.visitNo, incidentId: id, kind: todo.kind, note: input.note },
        ip: ctx.ip,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'visit_incident_events_resolved_uq')) throw resolvedError();
    throw error;
  }
  return listTodos(deps.sql);
}

// ───────────────────────── 路由 ─────────────────────────

export function registerIncidentRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // 客人卡上的「异常处置」：提醒、加收、上报、临时外出 / 返回、未结离店（手牌丢失走换牌）
  app.post('/api/frontdesk/visits/:id/incidents', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return createIncident(deps, id, req.body as IncidentInputData, ctxOf(req));
  });

  // 发卡台顶上的「异常待办」：没处理完的上报、未结离店
  app.get('/api/frontdesk/incidents/todos', { preHandler: guard('frontdesk.read') }, async () => readSnapshot(sql, (tx) => listTodos(tx)));

  app.post('/api/frontdesk/incidents/:id/assign', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return assignIncident(deps, id, req.body, ctxOf(req));
  });

  app.post('/api/frontdesk/incidents/:id/resolve', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return resolveIncident(deps, id, req.body, ctxOf(req));
  });
}
