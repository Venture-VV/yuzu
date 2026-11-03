// 开单即占用（D37 / D39，v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 1 节）：派对房、宠物轰趴房、娱乐室的使用单。
//   · 开单：选在店客人的手牌（使用人，费用挂在他的手牌账单上，与前台挂账同一个口径）、人数、备注；开单即「使用中」；
//     同一间房同时只有一张开着的使用单（部分唯一索引兜底）；
//   · 释放：手动「结束使用」、使用人结账（frontdesk/checkout.ts）、撤销来访（frontdesk/visits.ts）时自动结束、开错了「撤单」（写原因）；
//   · 实时位置：开单时使用人在那间房；结束、撤单时离开那间房（只在他现在就在那里时）。
// 写操作带操作编号（断网时走「结果待确认」，可以确认作废）。
// 加锁顺序：开单：来访（共享锁，挡住同时结账、撤销）→ 空间一行（与空间台账的编辑串行）→ 当前位置；
//          结束、撤单：使用单一行 → 当前位置；结账、撤销来访：在各自已有的锁之后，锁这几位客人开着的使用单（id 升序）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { isTechnicianBusinessType, ROOM_BUSINESS_TYPE } from '@shared/spaces';
import { DEFAULT_USAGE_RULES, MAX_USAGE_GUESTS, MAX_USAGE_NOTE, type UsageDetail, type UsageRules } from '@shared/usages';
import type { Db, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { docDateSchema } from './inventory/common';
import { assertCanFix, businessDate, hashRequest, loadFrontdeskRules, nextDocNo, runIdempotent, saveKey } from './frontdesk/common';
import { leaveUsages, locateUsage } from './locations';
import { ctxOf } from '../lib/context';
import { saveRuleSetting } from '../lib/rule-settings';

// ───────────────────────── 规则 ─────────────────────────

export async function loadUsageRules(db: Db): Promise<UsageRules> {
  const [row] = await db<{ value: Partial<UsageRules> }[]>`SELECT value FROM settings WHERE key = 'usage_rules'`;
  return { ...DEFAULT_USAGE_RULES, ...(row?.value ?? {}) };
}

const MAX_BUSINESS_TYPE = 8;
const RulesInput = z.object({
  businessTypes: z
    .array(z.string('业态不正确').trim().min(1, '业态不能为空').max(MAX_BUSINESS_TYPE, `业态最多 ${MAX_BUSINESS_TYPE} 字`), '请选择业态')
    .max(20, '业态最多 20 个')
    .transform((list) => [...new Set(list)])
    .refine((list) => !list.includes(ROOM_BUSINESS_TYPE), { message: '「客房」按入住单算占用，不能设成开单即占用' })
    .refine((list) => !list.some(isTechnicianBusinessType), { message: '技师服务类的房间按钟单算占用，不能设成开单即占用' }),
});

async function saveUsageRules(deps: Deps, raw: unknown, ctx: OpContext) {
  const next = parse(RulesInput, raw);
  await saveRuleSetting(deps.sql, 'usage_rules', loadUsageRules, () => next, ctx);
  return loadUsageRules(deps.sql);
}

// ───────────────────────── 读取 ─────────────────────────

const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

async function readUsages(db: Db, where: { id?: number; date?: string; spaceId?: number }): Promise<UsageDetail[]> {
  const rows = await db<(Omit<UsageDetail, 'openedAt' | 'closedAt'> & { openedAt: string; closedAt: string | null })[]>`
    SELECT u.id, u.usage_no, u.space_id, sp.code AS space_code, sp.display_name AS space_name, sp.business_type,
           u.visit_id, h.code AS tag_code, v.status AS visit_status, u.guests, u.note, u.status, u.business_date::text AS business_date,
           u.opened_at, so.display_name AS opened_by_name, u.closed_at, sc.display_name AS closed_by_name, u.close_kind, u.close_reason
    FROM space_usages u JOIN spaces sp ON sp.id = u.space_id JOIN visits v ON v.id = u.visit_id JOIN hand_tags h ON h.id = v.tag_id
    JOIN staff so ON so.id = u.opened_by LEFT JOIN staff sc ON sc.id = u.closed_by
    WHERE ${where.id !== undefined ? db`u.id = ${where.id}` : db`true`}
      AND ${where.date !== undefined ? db`u.business_date = ${where.date}` : db`true`}
      AND ${where.spaceId !== undefined ? db`u.space_id = ${where.spaceId}` : db`true`}
    ORDER BY u.opened_at, u.id`;
  return rows.map((r) => ({ ...r, openedAt: iso(r.openedAt)!, closedAt: iso(r.closedAt) }));
}

export async function getUsage(db: Db, id: number): Promise<UsageDetail> {
  const [u] = await readUsages(db, { id });
  if (!u) throw notFound('使用单不存在');
  return u;
}

/** 某个营业日开的使用单（对账包、页面的当天清单） */
export const listUsages = (db: Db, date: string, spaceId?: number) => readUsages(db, { date, ...(spaceId ? { spaceId } : {}) });

// ───────────────────────── 开单 ─────────────────────────

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const TAG_REQUIRED = '请填写使用人的手牌号：使用人要先在前台接待、买门票，再开单';

export const OpenUsageInput = z.object({
  clientKey,
  spaceId: z.number('请选择房间').int().positive('请选择房间'),
  /** 使用人：在店客人的手牌号（费用挂在他的手牌账单上） */
  tagCode: z
    .string(TAG_REQUIRED)
    .transform((v) => normalizeTagCode(v))
    .pipe(z.string().min(1, TAG_REQUIRED).regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）')),
  guests: z.number('请填写人数').int('人数必须是整数').min(1, '至少 1 人').max(MAX_USAGE_GUESTS, `最多 ${MAX_USAGE_GUESTS} 人`).default(1),
  note: z.string().trim().max(MAX_USAGE_NOTE, `备注最多 ${MAX_USAGE_NOTE} 字`).default(''),
});

export async function openUsage(deps: Deps, raw: unknown, ctx: OpContext): Promise<UsageDetail> {
  const input = parse(OpenUsageInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const run = await runIdempotent(deps, { key, opType: 'usage_open', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const rules = await loadUsageRules(tx);
    // ① 来访（共享锁：开单不改来访，但要挡住同时结账、撤销）
    const [peek] = await tx<{ id: number }[]>`
      SELECT v.id FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${input.tagCode} AND v.status = 'open'`;
    if (!peek) throw conflict('TAG_NOT_IN_STORE', `手牌 ${input.tagCode} 没有在店客人，请核对牌号；使用人要先在前台接待、买门票，再开单`);
    const [visit] = await tx<{ id: number; visitNo: string; billId: number; status: string }[]>`
      SELECT id, visit_no, bill_id, status FROM visits WHERE id = ${peek.id} FOR SHARE`;
    if (visit!.status !== 'open') throw conflict('VISIT_CLOSED', `来访 ${visit!.visitNo} 已${visit!.status === 'settled' ? '结账离店' : '撤销'}，不能开单`);
    // ② 空间一行（与空间台账的停用、改业态串行；不挡外键检查）
    const [space] = await tx<{ id: number; code: string; displayName: string; businessType: string; active: boolean; sellable: boolean }[]>`
      SELECT id, code, display_name, business_type, active, sellable FROM spaces WHERE id = ${input.spaceId} FOR NO KEY UPDATE`;
    if (!space) throw notFound('空间不存在，请刷新后重试');
    if (!rules.businessTypes.includes(space.businessType)) {
      throw unprocessable(
        'USAGE_NOT_ALLOWED',
        `${space.code}（${space.businessType}）不按「开单即占用」算${rules.businessTypes.length ? `，能开单的业态：${rules.businessTypes.join('、')}` : '；后台还没设能开单的业态'}`,
      );
    }
    if (!space.active || !space.sellable) throw conflict('SPACE_INACTIVE', `${space.code} 在空间台账里停用或不可售，不能开单，请换一间`);
    const [busy] = await tx<{ usageNo: string; tagCode: string }[]>`
      SELECT u.usage_no, h.code AS tag_code FROM space_usages u JOIN visits v ON v.id = u.visit_id JOIN hand_tags h ON h.id = v.tag_id
      WHERE u.space_id = ${space.id} AND u.status = 'open'`;
    if (busy) throw conflict('USAGE_TAKEN', `${space.code} 正在使用（${busy.usageNo}，手牌 ${busy.tagCode}），先结束这张再开单`);
    const date = await businessDate(tx, deps, at);
    const usageNo = await nextDocNo(tx, 'space_usage', 'SY', date);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO space_usages (usage_no, space_id, visit_id, bill_id, guests, note, business_date, opened_at, opened_by, open_key)
      VALUES (${usageNo}, ${space.id}, ${visit!.id}, ${visit!.billId}, ${input.guests}, ${input.note}, ${date}, ${at}, ${ctx.actor.id}, ${key})
      RETURNING id`;
    const usageId = row!.id;
    // 实时位置：使用人在那间房
    await locateUsage(tx, visit!.id, space.id, usageId, { at, staffId: ctx.actor.id });
    await saveKey(tx, key, 'usage_open', requestHash, usageId, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'usage_open',
      targetType: 'space_usage',
      targetId: usageId,
      detail: { usageNo, space: space.code, tagCode: input.tagCode, guests: input.guests, ...(input.note ? { note: input.note } : {}) },
      ip: ctx.ip,
      businessDate: date,
    });
    return usageId;
  });
  return getUsage(deps.sql, run.refId);
}

// ───────────────────────── 结束、撤单 ─────────────────────────

interface LockedUsage {
  id: number;
  usageNo: string;
  spaceId: number;
  visitId: number;
  status: 'open' | 'closed' | 'cancelled';
  openedBy: number;
  openedAt: string;
  spaceCode: string;
}

async function lockUsage(tx: Tx, id: number): Promise<LockedUsage> {
  const [u] = await tx<LockedUsage[]>`
    SELECT u.id, u.usage_no, u.space_id, u.visit_id, u.status, u.opened_by, u.opened_at, sp.code AS space_code
    FROM space_usages u JOIN spaces sp ON sp.id = u.space_id WHERE u.id = ${id} FOR UPDATE OF u`;
  if (!u) throw notFound('使用单不存在');
  if (u.status !== 'open') {
    throw conflict('USAGE_CLOSED', `使用单 ${u.usageNo}（${u.spaceCode}）已${u.status === 'cancelled' ? '撤单' : '结束'}，请刷新`);
  }
  return u;
}

export const EndUsageInput = z.object({ clientKey });

export async function endUsage(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<UsageDetail> {
  const input = parse(EndUsageInput, raw);
  const requestHash = hashRequest({ id });
  await runIdempotent(deps, { key: input.clientKey, opType: 'usage_end', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const u = await lockUsage(tx, id);
    await tx`
      UPDATE space_usages SET status = 'closed', closed_at = greatest(opened_at, ${at}), closed_by = ${ctx.actor.id}, close_kind = 'end'
      WHERE id = ${id}`;
    await leaveUsages(tx, [{ id, visitId: u.visitId, spaceId: u.spaceId }], { at, staffId: ctx.actor.id });
    await saveKey(tx, input.clientKey, 'usage_end', requestHash, id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'usage_end',
      targetType: 'space_usage',
      targetId: id,
      detail: { usageNo: u.usageNo, space: u.spaceCode },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
    return id;
  });
  return getUsage(deps.sql, id);
}

export const CancelUsageInput = z.object({
  clientKey,
  reason: z.string('请填写撤单原因（至少 2 个字）').trim().min(2, '请填写撤单原因（至少 2 个字）').max(200, '原因最多 200 字'),
});

/** 开错了撤单（写原因）：与作废明细同一条规则——前台只能撤自己开的、开单后一定时间内的，超出由店主处理；挂过的费用另到前台作废 */
export async function cancelUsage(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<UsageDetail> {
  const input = parse(CancelUsageInput, raw);
  const requestHash = hashRequest({ id, reason: input.reason });
  await runIdempotent(deps, { key: input.clientKey, opType: 'usage_cancel', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const u = await lockUsage(tx, id);
    assertCanFix(ctx.actor, u.openedBy, u.openedAt, await loadFrontdeskRules(tx), at, '这张使用单');
    await tx`
      UPDATE space_usages SET status = 'cancelled', closed_at = greatest(opened_at, ${at}), closed_by = ${ctx.actor.id}, close_kind = 'cancel',
             close_reason = ${input.reason}
      WHERE id = ${id}`;
    await leaveUsages(tx, [{ id, visitId: u.visitId, spaceId: u.spaceId }], { at, staffId: ctx.actor.id });
    await saveKey(tx, input.clientKey, 'usage_cancel', requestHash, id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'usage_cancel',
      targetType: 'space_usage',
      targetId: id,
      detail: { usageNo: u.usageNo, space: u.spaceCode, reason: input.reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
    return id;
  });
  return getUsage(deps.sql, id);
}

/**
 * 使用人结账、撤销来访时一起结束他开着的使用单（在调用方已有的锁之后，按 id 升序锁）。
 * 位置不在这里处理：调用方接着清掉这几位客人的位置（离店）。返回结束的使用单号。
 */
export async function closeUsagesOfVisits(tx: Tx, visitIds: number[], kind: 'checkout' | 'visit_cancel', c: { at: Date; staffId: number }): Promise<string[]> {
  if (visitIds.length === 0) return [];
  const rows = await tx<{ id: number; usageNo: string }[]>`
    SELECT id, usage_no FROM space_usages WHERE visit_id IN ${tx(visitIds)} AND status = 'open' ORDER BY id FOR UPDATE`;
  if (rows.length === 0) return [];
  await tx`
    UPDATE space_usages SET status = 'closed', closed_at = greatest(opened_at, ${c.at}), closed_by = ${c.staffId}, close_kind = ${kind}
    WHERE id IN ${tx(rows.map((r) => r.id))}`;
  return rows.map((r) => r.usageNo);
}

/** 这几位客人开着的使用单（结账预览里提示「结账后自动结束」） */
export async function openUsagesOf(db: Db, visitIds: number[]) {
  if (visitIds.length === 0) return [];
  return db<{ usageId: number; usageNo: string; tagCode: string; spaceCode: string; spaceName: string }[]>`
    SELECT u.id AS usage_id, u.usage_no, h.code AS tag_code, sp.code AS space_code, sp.display_name AS space_name
    FROM space_usages u JOIN visits v ON v.id = u.visit_id JOIN hand_tags h ON h.id = v.tag_id JOIN spaces sp ON sp.id = u.space_id
    WHERE u.visit_id IN ${db(visitIds)} AND u.status = 'open' ORDER BY h.code, sp.code`;
}

/** 空间里开着的使用单（空间台账停用、改业态前核对） */
export async function openUsageIn(tx: Tx, spaceId: number) {
  const [row] = await tx<{ usageNo: string }[]>`SELECT usage_no FROM space_usages WHERE space_id = ${spaceId} AND status = 'open'`;
  return row ?? null;
}

// ───────────────────────── 自检 ─────────────────────────

/** 开着的使用单的使用人都在店、账单就是他的手牌账单；结过账、撤销了来访的客人没有开着的使用单 */
export async function usageCheck(db: Db) {
  const diff = await db<{ ref: string }[]>`
    SELECT u.usage_no AS ref FROM space_usages u JOIN visits v ON v.id = u.visit_id
    WHERE (u.status = 'open' AND v.status <> 'open') OR u.bill_id <> v.bill_id
    LIMIT 5`;
  const [n] = await db<{ open: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*)::int AS total FROM space_usages`;
  return {
    key: 'space_usages',
    label: '派对房等使用单与在店客人一致',
    ok: diff.length === 0,
    detail: diff.length
      ? `${diff.length} 张使用单的使用人已离店或账单不符（如 ${diff.map((d) => d.ref).join('、')}）`
      : `使用单 ${n!.total} 张，开着的 ${n!.open} 张：一间房最多一张，使用人都在店，结过账、撤销了来访的客人没有开着的使用单`,
  };
}

// ───────────────────────── 路由 ─────────────────────────

const ListQuery = z.object({ date: docDateSchema, spaceId: z.coerce.number().int().positive().optional() });

export function registerUsageRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 与「客房」页（房态看板、平面图）同一组岗位能看；开单、结束、撤单沿用「客房入住、退房」
  const read = guardAny('room.operate', 'room.housekeep', 'frontdesk.checkout');
  app.get('/api/usages', { preHandler: read }, async (req) => {
    const q = parse(ListQuery, req.query);
    return listUsages(sql, q.date, q.spaceId);
  });
  app.get('/api/usages/:id', { preHandler: read }, async (req) => getUsage(sql, parse(idParam, req.params).id));
  const op = guard('room.operate');
  app.post('/api/usages', { preHandler: op }, async (req) => openUsage(deps, req.body, ctxOf(req)));
  app.post('/api/usages/:id/end', { preHandler: op }, async (req) => endUsage(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/usages/:id/cancel', { preHandler: op }, async (req) => cancelUsage(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  // 后台：开单即占用的业态（店主）
  app.get('/api/admin/usage-rules', { preHandler: guardAny('settings.manage', 'catalog.manage') }, async () => loadUsageRules(sql));
  app.put('/api/admin/usage-rules', { preHandler: guard('settings.manage') }, async (req) => {
    if (!req.body || typeof req.body !== 'object') throw badRequest('请选择业态');
    return saveUsageRules(deps, req.body, ctxOf(req));
  });
}
