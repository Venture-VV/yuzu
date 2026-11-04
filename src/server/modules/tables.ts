// 餐饮第二步：桌台、开台（不洗浴客人的桌台账单）、桌台点单与退菜、转台、撤台、桌台结账。
//
// 钱只在账单明细里：桌台账单与手牌账单是同一张 bills 表（kind = 'table'），明细同样只追加、作废留痕；
// 结账走与手牌结账同一套收款处理（frontdesk/checkout.ts 的 recordCheckoutPayments），结账单、交班、日结、对账包同一口径；
// 反结账在 frontdesk/checkout.ts 的 voidCheckout 里一起处理（恢复开台与账单）。
// 加锁顺序：经办人的班次（结账，共享锁）→ 桌台（开台、转台，id 升序）→ 开台（id 升序）→ 账单 → 明细 → 估清 → 出品单 → 会员。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CheckoutDetail } from '@shared/checkout';
import {
  MAX_DISH_NOTE,
  MAX_TABLE_AREA,
  MAX_TABLE_NAME,
  MAX_TABLES_PER_CHECKOUT,
  type PendingDish,
  type TableCheckoutPreview,
  type TableSessionDetail,
  type TablesAdmin,
  type TablesBoard,
} from '@shared/dining';
import type { BillLine } from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import type { Db, Tx } from '../db';
import { consumeDiscountGrant } from '../auth/grants';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { cents, idParam, parse, positiveCents } from '../lib/validate';
import { expireMemberBonus } from './bonus';
import { cancelKitchenItem, createKitchenItems, kitchenStationsOf, loadDiningRules, takeDishLimits, type KitchenLine } from './dining';
import { assertSettled, getCheckout, Payment, recordCheckoutPayments, snapshotCheckoutItems, splitPayments } from './frontdesk/checkout';
import { couponLines, memberCouponOptions } from './coupon-checkout';
import { assertCanFix, businessDate, hashRequest, loadFrontdeskRules, nextDocNo, runIdempotent, saveKey, setTxTimeouts } from './frontdesk/common';
import { loadPricedItems, priceLine } from './pricing';
import { lockPaymentShift, openShiftOf } from './shifts';
import { ctxOf } from '../lib/context';

// ───────────────────────── 后台：桌台 ─────────────────────────

const TableInput = z.object({
  name: z.string('请填写桌号').trim().min(1, '请填写桌号').max(MAX_TABLE_NAME, `桌号最多 ${MAX_TABLE_NAME} 字`),
  area: z.string().trim().max(MAX_TABLE_AREA, `区域最多 ${MAX_TABLE_AREA} 字`).default(''),
  seats: z.number('座位数必须是整数').int('座位数必须是整数').min(1, '至少 1 个座位').max(99, '最多 99 个座位').default(4),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
});

export async function tablesAdmin(db: Db): Promise<TablesAdmin> {
  const tables = await db<TablesAdmin['tables']>`
    SELECT t.id, t.name, t.area, t.seats, t.sort_order, t.active,
           (SELECT count(*) FROM table_sessions s WHERE s.table_id = t.id)::int AS session_count
    FROM dining_tables t ORDER BY t.sort_order, t.id`;
  return { tables };
}

async function saveTable(deps: Deps, id: number | null, raw: unknown, ctx: OpContext) {
  const t = parse(TableInput, raw);
  await deps.sql.begin(async (tx) => {
    const [dup] = await tx<{ id: number }[]>`
      SELECT id FROM dining_tables WHERE lower(btrim(name)) = lower(${t.name}) AND id IS DISTINCT FROM ${id}`;
    if (dup) throw conflict('TABLE_NAME_TAKEN', `已有桌台「${t.name}」`);
    if (id === null) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO dining_tables (name, area, seats, sort_order, active, created_by)
        VALUES (${t.name}, ${t.area}, ${t.seats}, ${t.sortOrder}, ${t.active}, ${ctx.actor.id}) RETURNING id`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'dining_table_saved', targetType: 'dining_table', targetId: row!.id, detail: { summary: `新建桌台「${t.name}」` }, ip: ctx.ip });
      return;
    }
    const [cur] = await tx<{ name: string }[]>`SELECT name FROM dining_tables WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('桌台不存在');
    if (!t.active) {
      const [busy] = await tx<{ sessionNo: string }[]>`SELECT session_no FROM table_sessions WHERE table_id = ${id} AND status = 'open'`;
      if (busy) throw conflict('TABLE_IN_USE', `桌台「${cur.name}」正在用餐（${busy.sessionNo}），结账或转台后才能停用`);
    }
    await tx`
      UPDATE dining_tables SET name = ${t.name}, area = ${t.area}, seats = ${t.seats}, sort_order = ${t.sortOrder}, active = ${t.active}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'dining_table_saved',
      targetType: 'dining_table',
      targetId: id,
      detail: { summary: `修改桌台「${cur.name}」${cur.name !== t.name ? ` → 「${t.name}」` : ''}${t.active ? '' : '（停用）'}` },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 看板、详情 ─────────────────────────

export async function tablesBoard(db: Db, deps: Deps): Promise<TablesBoard> {
  const now = new Date();
  // 停用的桌台还有没结的开台时照样显示，结完为止
  const rows = await db<(TablesBoard['tables'][number] & { sessionId: number | null })[]>`
    SELECT t.id, t.name, t.area, t.seats, t.sort_order, t.active, s.id AS session_id
    FROM dining_tables t LEFT JOIN table_sessions s ON s.table_id = t.id AND s.status = 'open'
    WHERE t.active OR s.id IS NOT NULL
    ORDER BY t.sort_order, t.id`;
  const ids = rows.flatMap((r) => (r.sessionId ? [r.sessionId] : []));
  const sessions = ids.length
    ? await db<NonNullable<TablesBoard['tables'][number]['session']>[]>`
        SELECT s.id, s.session_no, s.table_id, s.guests, s.guest_label, s.member_id, m.name AS member_name, s.opened_at,
               st.display_name AS opened_by_name, b.amount_cents AS amount, b.line_count,
               (SELECT coalesce(sum(k.quantity), 0) FROM kitchen_items k
                WHERE k.table_session_id = s.id AND k.status IN ('queued', 'cooking', 'done'))::int AS pending_dishes
        FROM table_sessions s JOIN bills b ON b.id = s.bill_id JOIN staff st ON st.id = s.opened_by LEFT JOIN members m ON m.id = s.member_id
        WHERE s.id IN ${db(ids)}`
    : [];
  return {
    serverTime: now.toISOString(),
    businessDate: await businessDate(db as Tx, deps, now),
    tables: rows.map(({ sessionId, ...t }) => ({ ...t, session: sessions.find((s) => s.id === sessionId) ?? null })),
  };
}

export async function getTableSession(db: Db, id: number): Promise<TableSessionDetail> {
  const [s] = await db<(Omit<TableSessionDetail, 'lines' | 'moves' | 'member'> & { memberId: number | null; memberNo: string | null; memberName: string | null })[]>`
    SELECT s.id, s.session_no, s.status, s.table_id, t.name AS table_name, t.area, s.guests, s.guest_label, s.member_id, m.member_no,
           m.name AS member_name, s.opened_at, st.display_name AS opened_by_name, s.closed_at, s.close_reason, s.bill_id, b.bill_no,
           b.amount_cents AS amount
    FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id JOIN bills b ON b.id = s.bill_id JOIN staff st ON st.id = s.opened_by
    LEFT JOIN members m ON m.id = s.member_id
    WHERE s.id = ${id}`;
  if (!s) throw notFound('开台记录不存在');
  const lines = await db<BillLine[]>`
    SELECT l.id, l.source, l.item_id, l.tier, l.name, l.unit_price, l.quantity, l.amount, l.status, l.post_key, l.business_date,
           l.posted_by AS posted_by_id, p.display_name AS posted_by_name, l.posted_at, l.void_reason, vs.display_name AS voided_by_name,
           l.voided_at, NULL AS backfill, NULL AS technician, l.session_id,
           (SELECT json_build_object('status', k.status, 'note', k.note, 'orderNo', k.order_no) FROM kitchen_items k WHERE k.bill_line_id = l.id) AS kitchen
    FROM bill_lines l JOIN staff p ON p.id = l.posted_by LEFT JOIN staff vs ON vs.id = l.voided_by
    WHERE l.bill_id = ${s.billId} ORDER BY l.id`;
  const pending = await db<PendingDish[]>`
    SELECT k.id, k.bill_line_id, i.name, k.quantity, k.note, k.status, k.rush_count, k.created_at
    FROM kitchen_items k JOIN service_items i ON i.id = k.item_id
    WHERE k.table_session_id = ${id} AND k.status IN ('queued', 'cooking', 'done') ORDER BY k.id`;
  const moves = await db<TableSessionDetail['moves']>`
    SELECT ft.name AS from_table, tt.name AS to_table, mv.reason, st.display_name AS operator_name, mv.created_at AS at
    FROM table_session_moves mv JOIN dining_tables ft ON ft.id = mv.from_table_id JOIN dining_tables tt ON tt.id = mv.to_table_id
    JOIN staff st ON st.id = mv.operator_id WHERE mv.session_id = ${id} ORDER BY mv.id`;
  const { memberId, memberNo, memberName, ...rest } = s;
  return { ...rest, member: memberId ? { id: memberId, memberNo: memberNo!, name: memberName! } : null, lines, pending, moves };
}

// ───────────────────────── 开台、改人数、转台、撤台 ─────────────────────────

interface LockedSession {
  id: number;
  sessionNo: string;
  billId: number;
  tableId: number;
  guests: number;
  memberId: number | null;
  status: string;
  openedBy: number;
  openedAt: string;
}

/** 开台按 id 升序加锁 */
async function lockSessions(tx: Tx, ids: number[]): Promise<Map<number, LockedSession>> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) return new Map();
  const rows = await tx<LockedSession[]>`
    SELECT id, session_no, bill_id, table_id, guests, member_id, status, opened_by, opened_at
    FROM table_sessions WHERE id IN ${tx(unique)} ORDER BY id FOR UPDATE`;
  if (rows.length !== unique.length) throw notFound('开台记录不存在，请刷新后重试');
  return new Map(rows.map((r) => [r.id, r]));
}

function assertSessionOpen(s: LockedSession) {
  if (s.status !== 'open') throw conflict('TABLE_CLOSED', `开台 ${s.sessionNo} 已${s.status === 'settled' ? '结账' : '撤台'}，不能再操作`);
}

async function assertDiningEnabled(db: Db) {
  if (!(await loadDiningRules(db)).enabled) throw unprocessable('DINING_DISABLED', '餐饮功能已关闭，请刷新页面');
}

const guestFields = {
  guests: z.number('请填写用餐人数').int('人数必须是整数').min(1, '至少 1 人').max(99, '最多 99 人'),
  guestLabel: z.string().trim().max(16, '客人称呼最多 16 字').default(''),
  /** 登记会员（可以用这位会员的储值结账）；散客不带 */
  memberId: z.number().int().positive().nullish().transform((v) => v ?? undefined),
};
export const OpenTableInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  tableId: z.number('请选择桌台').int().positive('请选择桌台'),
  ...guestFields,
});

async function assertMember(tx: Tx, memberId: number | undefined) {
  if (memberId === undefined) return;
  const [m] = await tx<{ id: number }[]>`SELECT id FROM members WHERE id = ${memberId}`;
  if (!m) throw notFound('会员不存在，请重新选择');
}

export async function openTable(deps: Deps, raw: unknown, ctx: OpContext): Promise<TableSessionDetail> {
  const input = parse(OpenTableInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const run = await runIdempotent(deps, { key, opType: 'table_open', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    await assertDiningEnabled(tx);
    // ① 桌台：启用、空闲（部分唯一索引兜底）
    const [t] = await tx<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM dining_tables WHERE id = ${input.tableId} FOR UPDATE`;
    if (!t) throw notFound('桌台不存在，请刷新后重试');
    if (!t.active) throw conflict('TABLE_INACTIVE', `桌台「${t.name}」已停用，请换一张桌`);
    const [busy] = await tx<{ sessionNo: string }[]>`SELECT session_no FROM table_sessions WHERE table_id = ${t.id} AND status = 'open'`;
    if (busy) throw conflict('TABLE_TAKEN', `桌台「${t.name}」正在用餐（${busy.sessionNo}），请换一张空桌`);
    await assertMember(tx, input.memberId);
    const date = await businessDate(tx, deps, at);
    const billNo = await nextDocNo(tx, 'bill', 'ZD', date);
    const [bill] = await tx<{ id: number }[]>`
      INSERT INTO bills (bill_no, kind, business_date, opened_at) VALUES (${billNo}, 'table', ${date}, ${at}) RETURNING id`;
    const sessionNo = await nextDocNo(tx, 'table_session', 'KT', date);
    const [s] = await tx<{ id: number }[]>`
      INSERT INTO table_sessions (session_no, bill_id, table_id, guests, guest_label, member_id, business_date, opened_at, opened_by, open_key)
      VALUES (${sessionNo}, ${bill!.id}, ${t.id}, ${input.guests}, ${input.guestLabel}, ${input.memberId ?? null}, ${date}, ${at}, ${ctx.actor.id}, ${key})
      RETURNING id`;
    await saveKey(tx, key, 'table_open', requestHash, s!.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_open',
      targetType: 'table_session',
      targetId: s!.id,
      detail: { sessionNo, table: t.name, guests: input.guests, guestLabel: input.guestLabel, memberId: input.memberId ?? null },
      ip: ctx.ip,
      businessDate: date,
    });
    return s!.id;
  });
  return getTableSession(deps.sql, run.refId);
}

const UpdateInput = z.object(guestFields);

/** 改人数、称呼、登记的会员（用餐中） */
export async function updateTableSession(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<TableSessionDetail> {
  const input = parse(UpdateInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const s = (await lockSessions(tx, [id])).get(id)!;
    assertSessionOpen(s);
    await assertMember(tx, input.memberId);
    await tx`
      UPDATE table_sessions SET guests = ${input.guests}, guest_label = ${input.guestLabel}, member_id = ${input.memberId ?? null} WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_update',
      targetType: 'table_session',
      targetId: id,
      detail: { sessionNo: s.sessionNo, guests: input.guests, guestLabel: input.guestLabel, memberId: input.memberId ?? null },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, ctx.at ?? new Date()),
    });
  });
  return getTableSession(deps.sql, id);
}

const MoveInput = z.object({
  toTableId: z.number('请选择要转去的桌台').int().positive('请选择要转去的桌台'),
  reason: z.string('请填写转台原因').trim().min(2, '请填写转台原因（至少 2 个字）').max(100, '原因最多 100 字'),
});

/** 转台：账单跟着开台走；要转去的桌台必须启用、空闲 */
export async function moveTable(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<TableSessionDetail> {
  const input = parse(MoveInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [peek] = await tx<{ tableId: number }[]>`SELECT table_id FROM table_sessions WHERE id = ${id}`;
    if (!peek) throw notFound('开台记录不存在');
    if (peek.tableId === input.toTableId) throw badRequest('已经在这张桌台上了');
    // ① 两张桌台按 id 升序加锁 → ② 开台；加锁后核对没有被其他终端转走
    const tables = await tx<{ id: number; name: string; active: boolean }[]>`
      SELECT id, name, active FROM dining_tables WHERE id IN ${tx([peek.tableId, input.toTableId])} ORDER BY id FOR UPDATE`;
    const to = tables.find((t) => t.id === input.toTableId);
    if (!to) throw notFound('要转去的桌台不存在');
    const s = (await lockSessions(tx, [id])).get(id)!;
    assertSessionOpen(s);
    if (s.tableId !== peek.tableId) throw conflict('SESSION_CHANGED', '这桌刚刚被其他终端转台了，请刷新后重试');
    if (!to.active) throw conflict('TABLE_INACTIVE', `桌台「${to.name}」已停用，请换一张桌`);
    const [busy] = await tx<{ sessionNo: string }[]>`SELECT session_no FROM table_sessions WHERE table_id = ${to.id} AND status = 'open'`;
    if (busy) throw conflict('TABLE_TAKEN', `桌台「${to.name}」正在用餐（${busy.sessionNo}），请换一张空桌`);
    await tx`UPDATE table_sessions SET table_id = ${to.id} WHERE id = ${id}`;
    await tx`
      INSERT INTO table_session_moves (session_id, from_table_id, to_table_id, reason, operator_id)
      VALUES (${id}, ${peek.tableId}, ${to.id}, ${input.reason}, ${ctx.actor.id})`;
    const from = tables.find((t) => t.id === peek.tableId)!;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_move',
      targetType: 'table_session',
      targetId: id,
      detail: { sessionNo: s.sessionNo, from: from.name, to: to.name, reason: input.reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, ctx.at ?? new Date()),
    });
  });
  return getTableSession(deps.sql, id);
}

const CancelInput = z.object({
  reason: z.string('请填写撤台原因').trim().min(2, '请填写撤台原因（至少 2 个字）').max(200, '原因最多 200 字'),
});

/** 撤台：开错台、客人没点就走了；账单上还有有效明细时不能撤（先退菜或结账），时限与作废明细相同 */
export async function cancelTable(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<TableSessionDetail> {
  const { reason } = parse(CancelInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const s = (await lockSessions(tx, [id])).get(id)!;
    assertSessionOpen(s);
    const [bill] = await tx<{ lineCount: number; amountCents: number }[]>`SELECT line_count, amount_cents FROM bills WHERE id = ${s.billId} FOR UPDATE`;
    if (bill!.lineCount > 0) {
      throw conflict('BILL_UNSETTLED', `这桌还有 ${bill!.lineCount} 项没结的消费（${formatYuan(bill!.amountCents)}），不能撤台；请结账，或先退掉点错的菜`, {
        lineCount: bill!.lineCount,
        amountCents: bill!.amountCents,
      });
    }
    assertCanFix(ctx.actor, s.openedBy, s.openedAt, await loadFrontdeskRules(tx), at, '这次开台');
    await tx`UPDATE bills SET status = 'cancelled', closed_at = ${at} WHERE id = ${s.billId}`;
    await tx`UPDATE table_sessions SET status = 'cancelled', closed_at = ${at}, closed_by = ${ctx.actor.id}, close_reason = ${reason} WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_cancel',
      targetType: 'table_session',
      targetId: id,
      detail: { sessionNo: s.sessionNo, reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getTableSession(deps.sql, id);
}

// ───────────────────────── 点单、退菜 ─────────────────────────

export const TablePostInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  lines: z
    .array(
      z.object({
        itemId: z.number().int().positive(),
        quantity: z.number().int().min(1, '数量至少为 1').max(99, '单项数量最多 99'),
        note: z
          .string()
          .trim()
          .max(MAX_DISH_NOTE, `口味备注最多 ${MAX_DISH_NOTE} 字`)
          .nullish()
          .transform((v) => v || undefined),
      }),
    )
    .min(1, '请至少点一道菜')
    .max(30, '一次最多点 30 项'),
  /** 员工确认时看到的本次合计；与服务端按当前价格计算的不一致时拒绝 */
  expectedTotal: positiveCents('本次合计'),
});

/** 给一桌点菜（挂到这桌的账单上）：只能点进厨房的菜；同一个事务里扣估清、建出品单 */
export async function postTableCharges(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<TableSessionDetail> {
  const input = parse(TablePostInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ sessionId: id, ...payload });
  await runIdempotent(deps, { key, opType: 'table_post', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    // ② 开台 → 账单
    const s = (await lockSessions(tx, [id])).get(id)!;
    assertSessionOpen(s);
    const [bill] = await tx<{ status: string }[]>`SELECT status FROM bills WHERE id = ${s.billId} FOR UPDATE`;
    if (bill!.status !== 'open') throw conflict('BILL_CLOSED', '账单已结束，不能再点单');
    const items = await loadPricedItems(tx, input.lines.map((l) => l.itemId));
    const stations = await kitchenStationsOf(tx, input.lines.map((l) => l.itemId));
    const lines = input.lines.map((l) => {
      const item = items.get(l.itemId);
      const priced = priceLine(item, undefined, l.quantity, '有菜已停用，请刷新后重新点');
      const stationId = stations.get(l.itemId) ?? null;
      if (stationId === null) throw unprocessable('DISH_NOT_KITCHEN', `「${item!.name}」不是点单的菜，桌台只能点进厨房的菜`);
      return { ...priced, stationId, note: l.note ?? '' };
    });
    const total = lines.reduce((sum, l) => sum + l.amount, 0);
    if (total !== input.expectedTotal) {
      throw conflict('PRICE_CHANGED', '菜价刚刚有调整，本次合计与确认时不同，请核对后重新确认', { total });
    }
    const date = await businessDate(tx, deps, at);
    // 估清（明细之前）：今天还剩的份数不够整笔拒绝
    const limited = await takeDishLimits(tx, lines.map((l) => ({ itemId: l.itemId!, name: l.name, quantity: l.quantity })), date);
    const kitchen: KitchenLine[] = [];
    for (const l of lines) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO bill_lines (bill_id, source, item_id, tier, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at)
        VALUES (${s.billId}, 'dining', ${l.itemId}, ${l.tier}, ${l.name}, ${l.unitPrice}, ${l.quantity}, ${l.amount}, ${key}, ${date},
                ${ctx.actor.id}, ${at})
        RETURNING id`;
      kitchen.push({ billLineId: row!.id, itemId: l.itemId!, stationId: l.stationId, quantity: l.quantity, note: l.note, limitTaken: limited.has(l.itemId!) });
    }
    await createKitchenItems(tx, { visitId: null, tableSessionId: s.id, lines: kitchen, date, at, actor: ctx.actor, backfill: false });
    await tx`UPDATE bills SET amount_cents = amount_cents + ${total}, line_count = line_count + ${lines.length} WHERE id = ${s.billId}`;
    await saveKey(tx, key, 'table_post', requestHash, s.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_post',
      targetType: 'table_session',
      targetId: s.id,
      detail: { sessionNo: s.sessionNo, total, lines: lines.map((l) => `${l.name}×${l.quantity}${l.note ? `（${l.note}）` : ''}`) },
      ip: ctx.ip,
      businessDate: date,
    });
    return s.id;
  });
  return getTableSession(deps.sql, id);
}

const VoidInput = z.object({
  reason: z.string().trim().min(2, '请填写退菜原因（至少 2 个字）').max(200, '原因最多 200 字'),
});

/** 退菜：作废桌台账单的一条明细（规则与前台作废相同）；出品单改为已退，扣过估清的按原份数加回 */
export async function voidTableLine(deps: Deps, lineId: number, raw: unknown, ctx: OpContext): Promise<TableSessionDetail> {
  const input = parse(VoidInput, raw);
  const [peek] = await deps.sql<{ sessionId: number }[]>`
    SELECT s.id AS session_id FROM bill_lines l JOIN table_sessions s ON s.bill_id = l.bill_id WHERE l.id = ${lineId}`;
  if (!peek) throw notFound('这桌的账单明细不存在');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const s = (await lockSessions(tx, [peek.sessionId])).get(peek.sessionId)!;
    assertSessionOpen(s);
    await tx`SELECT id FROM bills WHERE id = ${s.billId} FOR UPDATE`;
    const [line] = await tx<{ id: number; name: string; quantity: number; amount: number; status: string; postedBy: number; postedAt: string; voidedByName: string | null }[]>`
      SELECT l.id, l.name, l.quantity, l.amount, l.status, l.posted_by, l.posted_at, vs.display_name AS voided_by_name
      FROM bill_lines l LEFT JOIN staff vs ON vs.id = l.voided_by WHERE l.id = ${lineId} FOR UPDATE OF l`;
    if (line!.status === 'voided') throw conflict('ALREADY_VOIDED', `这项明细已由${line!.voidedByName ?? '其他人'}作废，不会重复冲减`);
    assertCanFix(ctx.actor, line!.postedBy, line!.postedAt, await loadFrontdeskRules(tx), at, '这项明细');
    await tx`
      UPDATE bill_lines SET status = 'voided', void_reason = ${input.reason}, voided_by = ${ctx.actor.id}, voided_at = ${at} WHERE id = ${line!.id}`;
    await tx`UPDATE bills SET amount_cents = amount_cents - ${line!.amount}, line_count = line_count - 1 WHERE id = ${s.billId}`;
    await cancelKitchenItem(tx, line!.id, `退菜：${input.reason}`, ctx.actor, at);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_void',
      targetType: 'table_session',
      targetId: s.id,
      detail: { sessionNo: s.sessionNo, name: line!.name, quantity: line!.quantity, amount: line!.amount, reason: input.reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getTableSession(deps.sql, peek.sessionId);
}

// ───────────────────────── 桌台结账 ─────────────────────────

const minutesBetween = (from: string | Date, to: Date) => Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 60_000));

/** 结账前核对（只读）：这几桌的明细、合计、登记的会员与还没上的菜 */
export async function previewTableCheckout(deps: Deps, sessionIds: number[], at = new Date()): Promise<TableCheckoutPreview> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) throw badRequest('请选择要结账的桌');
  // 会员到期的赠金先作废，员工核对的余额与入账时一致
  const memberIds = await deps.sql<{ memberId: number }[]>`SELECT DISTINCT member_id FROM table_sessions WHERE id IN ${deps.sql(ids)} AND member_id IS NOT NULL`;
  for (const m of memberIds) await expireMemberBonus(deps, m.memberId, at);
  return deps.sql.begin('isolation level repeatable read read only', async (tx) => {
    const rows = await tx<{ id: number; sessionNo: string; billId: number; status: string; tableName: string; guests: number; guestLabel: string; memberId: number | null; memberName: string | null; openedAt: string; amount: number }[]>`
      SELECT s.id, s.session_no, s.bill_id, s.status, t.name AS table_name, s.guests, s.guest_label, s.member_id, m.name AS member_name,
             s.opened_at, b.amount_cents AS amount
      FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id JOIN bills b ON b.id = s.bill_id LEFT JOIN members m ON m.id = s.member_id
      WHERE s.id IN ${tx(ids)} ORDER BY t.sort_order, t.id`;
    if (rows.length !== ids.length) throw notFound('有开台记录不存在，请刷新后重试');
    const closed = rows.find((r) => r.status !== 'open');
    if (closed) throw conflict('TABLE_CLOSED', `桌台「${closed.tableName}」的这次开台已结束，请刷新后重新选择`);
    const lines = await tx<{ id: number; billId: number; name: string; quantity: number; amount: number }[]>`
      SELECT id, bill_id, name, quantity, amount FROM bill_lines WHERE status = 'active' AND bill_id IN ${tx(rows.map((r) => r.billId))} ORDER BY id`;
    const members = rows.some((r) => r.memberId)
      ? await tx<TableCheckoutPreview['members']>`
          SELECT id, name, member_no, status, principal_balance, bonus_balance FROM members
          WHERE id IN ${tx(rows.flatMap((r) => (r.memberId ? [r.memberId] : [])))} ORDER BY id`
      : [];
    const dishes = await tx<TableCheckoutPreview['dishes']>`
      SELECT t.name AS table_name, i.name, k.quantity, k.status
      FROM kitchen_items k JOIN service_items i ON i.id = k.item_id JOIN table_sessions s ON s.id = k.table_session_id JOIN dining_tables t ON t.id = s.table_id
      WHERE k.table_session_id IN ${tx(ids)} AND k.status IN ('queued', 'cooking', 'done') ORDER BY k.id`;
    const sessions = rows.map((r) => ({
      sessionId: r.id,
      sessionNo: r.sessionNo,
      billId: r.billId,
      tableName: r.tableName,
      guests: r.guests,
      guestLabel: r.guestLabel,
      memberId: r.memberId,
      memberName: r.memberName,
      openedAt: new Date(r.openedAt).toISOString(),
      lines: lines.filter((l) => l.billId === r.billId).map(({ billId: _b, ...l }) => l),
      amount: r.amount,
    }));
    // 这几桌登记的会员的券（v0.7.20）
    const storeCoupons = await memberCouponOptions(tx, members.map((m) => m.id), await couponLines(tx, rows.map((r) => r.billId)), await businessDate(tx, deps, at));
    return { sessions, totalAmount: sessions.reduce((sum, x) => sum + x.amount, 0), members, storeCoupons, pricedAt: at.toISOString(), dishes };
  });
}

export const TableCheckoutInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  sessionIds: z.array(z.number().int().positive()).min(1, '请选择要结账的桌').max(MAX_TABLES_PER_CHECKOUT, `一次最多合并 ${MAX_TABLES_PER_CHECKOUT} 桌`),
  /** 员工确认时看到的应收合计；与服务端此刻计算的不一致时拒绝 */
  expectedTotal: cents('应收合计'),
  payments: z.array(Payment).max(10, '收款最多 10 笔').default([]),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
});

/**
 * 桌台结账：一张结账单结清所选的几桌，账单与开台一起结束，桌台空出来。
 * 收款方式、储值（只能是这几桌登记的会员）、团购券、优惠授权（对象是这几桌）、先开班与手牌结账相同。
 */
export async function checkoutTables(deps: Deps, raw: unknown, ctx: OpContext): Promise<CheckoutDetail> {
  const input = parse(TableCheckoutInput, raw);
  const ids = [...new Set(input.sessionIds)];
  if (ids.length !== input.sessionIds.length) throw badRequest('同一桌不能重复结账');
  const { wallets, discounts, memberDiscounts, countCards } = splitPayments(input.payments, ctx.actor);
  // 会员折扣（v0.7.25）只在手牌结账时自动算，桌台结账不算（M48）
  if (memberDiscounts.length) throw badRequest('桌台结账不算会员折扣（会员折扣只在手牌结账时自动算）');
  // 次卡（v0.7.28）只在手牌结账时用（卡是会员的，桌台没有会员手牌）
  if (countCards.length) throw badRequest('桌台结账不能用次卡（次卡只在会员的手牌结账时用）');
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  // 收款开始处理时经办人所在的班次：入账前这个班次已交班则整笔拒绝（见 shifts.ts lockPaymentShift）
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  for (const w of wallets) await expireMemberBonus(deps, w.memberId, ctx.at ?? new Date());

  const run = await runIdempotent(deps, { key, opType: 'table_checkout', requestHash }, async (tx) => {
    // ① 班次（共享锁）→ ② 开台 → 账单
    const shiftId = await lockPaymentShift(tx, ctx.actor.id, seenShift);
    const at = ctx.at ?? new Date();
    const locked = await lockSessions(tx, ids);
    for (const s of locked.values()) assertSessionOpen(s);
    // 储值只能由这几桌登记的会员支付，不能扣不在这张结账单上的会员（串单）
    const guests = new Set([...locked.values()].map((s) => s.memberId));
    const outsider = wallets.find((w) => !guests.has(w.memberId));
    if (outsider) {
      throw unprocessable('WALLET_MEMBER_NOT_IN_CHECKOUT', '只能用这几桌登记的会员储值支付；要用会员储值，请先在这桌登记会员', { memberId: outsider.memberId });
    }
    const billIds = [...locked.values()].map((s) => s.billId).sort((a, b) => a - b);
    await tx`SELECT id FROM bills WHERE id IN ${tx(billIds)} ORDER BY id FOR UPDATE`;
    const rows = await tx<{ id: number; billId: number; amount: number; guests: number; openedAt: string; tableName: string }[]>`
      SELECT s.id, s.bill_id, b.amount_cents AS amount, s.guests, s.opened_at, t.name AS table_name
      FROM table_sessions s JOIN bills b ON b.id = s.bill_id JOIN dining_tables t ON t.id = s.table_id
      WHERE s.id IN ${tx(ids)} ORDER BY t.name`;
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    if (total !== input.expectedTotal) {
      throw conflict('PRICE_CHANGED', `应收合计刚刚变为 ${formatYuan(total)}（这几桌的明细有变化），请核对后重新确认`, { total });
    }
    const paid = assertSettled(input.payments, total);
    // 优惠 / 免单：核销值班经理及以上的当场授权（这几桌、这个金额）
    const discount = discounts[0]
      ? await consumeDiscountGrant(tx, { grantId: discounts[0].grantId, actor: ctx.actor, visitIds: [], tableSessionIds: ids, amount: discounts[0].amount, usedRef: `checkout:${key}` })
      : null;
    const date = await businessDate(tx, deps, at);
    const checkoutNo = await nextDocNo(tx, 'checkout', 'JZ', date);
    const [c] = await tx<{ id: number }[]>`
      INSERT INTO checkouts (checkout_no, client_key, total_amount, paid_amount, note, business_date, operator_id, created_at, shift_id)
      VALUES (${checkoutNo}, ${key}, ${total}, ${paid}, ${input.note}, ${date}, ${ctx.actor.id}, ${at}, ${shiftId})
      RETURNING id`;
    const checkoutId = c!.id;
    for (const r of rows) {
      await tx`
        INSERT INTO checkout_bills (checkout_id, bill_id, visit_id, table_session_id, amount, stay_minutes, guests)
        VALUES (${checkoutId}, ${r.billId}, NULL, ${r.id}, ${r.amount}, ${minutesBetween(r.openedAt, at)}, ${r.guests})`;
    }
    const tables = rows.map((r) => r.tableName);
    const memberIds = [...guests].filter((m): m is number => m !== null);
    await recordCheckoutPayments(tx, deps, { checkoutId, checkoutNo, payments: input.payments, discount, tagCodes: [], tables, billIds, memberIds, date, at, ctx });
    await snapshotCheckoutItems(tx, checkoutId);
    // 结清：账单与开台结束，桌台空出来
    await tx`UPDATE bills SET status = 'settled', closed_at = ${at} WHERE id IN ${tx(billIds)}`;
    await tx`UPDATE table_sessions SET status = 'settled', closed_at = ${at}, closed_by = ${ctx.actor.id} WHERE id IN ${tx(ids)}`;
    await saveKey(tx, key, 'table_checkout', requestHash, checkoutId, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_checkout',
      targetType: 'checkout',
      targetId: checkoutId,
      detail: {
        docNo: checkoutNo,
        tags: [],
        tables,
        total,
        payments: input.payments.map((p) => ({ method: p.method, amount: p.amount })),
        ...(discount ? { discount: { amount: discounts[0]!.amount, reason: discount.reason, approverId: discount.approverId, approverName: discount.approverName } } : {}),
      },
      ip: ctx.ip,
      businessDate: date,
    });
    return checkoutId;
  });
  return getCheckout(deps.sql, run.refId);
}

// ───────────────────────── 路由 ─────────────────────────

export function registerTableRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // 后台「餐饮」：桌台（能管理价目的岗位）
  app.get('/api/admin/dining/tables', { preHandler: guardAny('settings.manage', 'catalog.manage') }, async () => tablesAdmin(sql));
  app.post('/api/admin/dining/tables', { preHandler: guard('catalog.manage') }, async (req) => {
    await saveTable(deps, null, req.body, ctxOf(req));
    return tablesAdmin(sql);
  });
  app.put('/api/admin/dining/tables/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    await saveTable(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return tablesAdmin(sql);
  });

  // 桌台看板与详情：点单、厨房、收银都要看
  app.get('/api/dining/tables', { preHandler: guardAny('dining.order', 'dining.kitchen', 'frontdesk.checkout') }, async () => tablesBoard(sql, deps));
  app.get('/api/dining/tables/sessions/:id', { preHandler: guardAny('dining.order', 'frontdesk.checkout') }, async (req) =>
    getTableSession(sql, parse(idParam, req.params).id),
  );

  // 开台、改人数、转台、撤台、点单、退菜：与前台挂账一样还要「前台挂账」权限（结果待确认按前台的操作编号查回、作废）
  const orderGuard = guard('dining.order', 'frontdesk.operate');
  app.post('/api/dining/tables/open', { preHandler: orderGuard }, async (req) => openTable(deps, req.body, ctxOf(req)));
  app.put('/api/dining/tables/sessions/:id', { preHandler: orderGuard }, async (req) => updateTableSession(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/dining/tables/sessions/:id/move', { preHandler: orderGuard }, async (req) => moveTable(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/dining/tables/sessions/:id/cancel', { preHandler: orderGuard }, async (req) => cancelTable(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/dining/tables/sessions/:id/orders', { preHandler: orderGuard }, async (req) => postTableCharges(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/dining/tables/lines/:id/void', { preHandler: orderGuard }, async (req) => voidTableLine(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));

  // 桌台结账：与前台结账同一权限
  app.get('/api/dining/tables/checkout-preview', { preHandler: guard('frontdesk.checkout') }, async (req) => {
    const { ids } = parse(z.object({ ids: z.string('请选择要结账的桌') }), req.query ?? {});
    const list = ids.split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
    if (list.length === 0 || list.length > MAX_TABLES_PER_CHECKOUT) throw badRequest('请选择要结账的桌');
    return previewTableCheckout(deps, list);
  });
  app.post('/api/dining/tables/checkout', { preHandler: guard('frontdesk.checkout') }, async (req) => checkoutTables(deps, req.body, ctxOf(req)));
}
