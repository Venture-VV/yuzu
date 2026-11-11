// 8.0.8 前台整改 · 餐饮（docs/FRONTDESK_V808.md 第 5 节）：
//   · 退菜分级（B02）：小额（单条 ≤ 上限，默认 ¥50）能下单的（前台挂账，桌台上的还要点单）就能直接退；超过的照旧（本人 15 分钟内、经理），
//     或值班经理及以上当场授权（line_void）；怎么批的记在审计里，「退菜记录」按日期列出；
//   · 餐饮台账（B06）：按营业日起止、菜品分类、状态筛选，页面与导出用同一个查询，合计一致。
// 都只读，退菜的锁顺序照旧（来访 / 桌台 → 账单 → 明细 → 出品单 → 估清），授权在同一事务里核销。

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { can } from '@shared/permissions';
import { businessDayStart, ISO_DATE } from '@shared/business-date';
import { formatYuan } from '@shared/money';
import { isSmallDishVoid, MAX_DINING_LEDGER_DAYS, type DiningLedger, type DiningLedgerRow, type DishVoidRow } from '@shared/dining';
import type { Db, Tx } from '../db';
import type { Actor, Deps } from '../lib/context';
import { AppError, badRequest } from '../lib/errors';
import { parse } from '../lib/validate';
import { checkDateRange, daysBetween } from '../lib/dates';
import { csvReply, toCsv } from '../lib/csv';
import { guardAny } from '../auth/guard';
import { consumeLineVoidGrant } from '../auth/grants';
import { assertCanFix, loadFrontdeskRules } from './frontdesk/common';
import { loadDiningRules } from './dining';
import { loadSettings } from './settings';

export type VoidApproval = { approval: 'small' | 'self' | 'manager' | 'grant'; approverName?: string; approverId?: number };

/**
 * 退一条明细要怎么批（8.0.8，B02）：小额的菜（单条 ≤ 上限）直接退；有更正权限的直接退；餐饮的菜带了当场授权的核销授权；
 * 其余按原来的「本人 15 分钟内」。餐饮的菜超过上限又不能自己退时，提示请值班经理及以上当场授权（VOID_NEEDS_GRANT）。
 * 调用前已锁好来访 / 桌台、账单与这条明细
 */
export async function authorizeLineVoid(
  tx: Tx,
  opts: { line: { id: number; source: string; amount: number; name: string; postedBy: number; postedAt: string }; actor: Actor; at: Date; grantId?: string; what: string },
): Promise<VoidApproval> {
  const { line, actor } = opts;
  const dining = await loadDiningRules(tx);
  // 小额直接退与下单同一套权限：要「前台挂账」（手牌、桌台的退菜接口本来就要；桌台上的还要「点单」，由接口拦），
  // 只有「点单」、没有「前台挂账」的岗位本来就不能下单，也不能退（Codex 审查 f14210c）
  if (isSmallDishVoid(dining, { source: line.source, amount: Number(line.amount) }) && can(actor, 'frontdesk.operate')) {
    return { approval: 'small' };
  }
  if (can(actor, 'frontdesk.correct')) return { approval: 'manager' };
  // 当场授权只用于餐饮的菜：别的明细带着授权也不核销，照原来的「本人 15 分钟内」（Codex 审查 d034bc6）
  if (opts.grantId && line.source === 'dining') {
    const g = await consumeLineVoidGrant(tx, { grantId: opts.grantId, actor, lineId: line.id, amount: Number(line.amount), usedRef: `line:${line.id}` });
    return { approval: 'grant', approverName: g.approverName, approverId: g.approverId };
  }
  try {
    assertCanFix(actor, line.postedBy, line.postedAt, await loadFrontdeskRules(tx), opts.at, opts.what);
  } catch (e) {
    if (line.source !== 'dining') throw e;
    throw new AppError(
      403,
      'VOID_NEEDS_GRANT',
      `「${line.name}」${formatYuan(Number(line.amount))}${dining.voidFreeCents > 0 ? ` 超过小额退菜上限 ${formatYuan(dining.voidFreeCents)}` : ''}，请值班经理及以上当场授权后再退`,
    );
  }
  return { approval: 'self' };
}

export const VOID_APPROVAL_LABELS: Record<VoidApproval['approval'], string> = {
  small: '小额直接退',
  self: '本人 15 分钟内',
  manager: '经理',
  grant: '当场授权',
};

// ───────────────────────── 餐饮台账（B06） ─────────────────────────

const LedgerQuery = z.object({
  from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  /** 菜品分类，多个用英文逗号隔开；不带为全部 */
  categories: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [])),
  status: z.enum(['active', 'voided', 'all']).default('all'),
});
export type DiningLedgerQuery = z.output<typeof LedgerQuery>;

/** 餐饮明细（手牌、桌台、小程序扫码点餐都在）：按挂账的营业日、分类、状态筛选；分类按价目表，没写的记「未分类」 */
function checkLedgerRange(from: string, to: string) {
  checkDateRange(from, to);
  if (daysBetween(from, to) >= MAX_DINING_LEDGER_DAYS) throw badRequest(`一次最多查 ${MAX_DINING_LEDGER_DAYS} 天`);
}

export async function diningLedger(db: Db, q: DiningLedgerQuery): Promise<DiningLedger> {
  checkLedgerRange(q.from, q.to);
  const rows = await db<(Omit<DiningLedgerRow, 'postedAt'> & { postedAt: string })[]>`
    SELECT l.id, l.business_date::text AS business_date, l.posted_at, coalesce(h.code, '') AS tag_code, coalesce(dt.name, '') AS table_name,
           l.name, coalesce(nullif(si.category, ''), '未分类') AS category, l.quantity, l.unit_price, l.amount, l.status, l.void_reason,
           ki.status AS kitchen_status, st.display_name AS posted_by_name
    FROM bill_lines l JOIN staff st ON st.id = l.posted_by
    LEFT JOIN service_items si ON si.id = l.item_id
    LEFT JOIN visits v ON v.bill_id = l.bill_id LEFT JOIN hand_tags h ON h.id = v.tag_id
    LEFT JOIN table_sessions ts ON ts.bill_id = l.bill_id LEFT JOIN dining_tables dt ON dt.id = ts.table_id
    LEFT JOIN kitchen_items ki ON ki.bill_line_id = l.id
    WHERE l.source = 'dining' AND l.business_date BETWEEN ${q.from} AND ${q.to}
      AND ${q.categories.length ? db`coalesce(nullif(si.category, ''), '未分类') IN ${db(q.categories)}` : db`true`}
      AND ${q.status === 'all' ? db`true` : db`l.status = ${q.status}`}
    ORDER BY l.posted_at, l.id`;
  const categories = await db<{ category: string }[]>`
    SELECT DISTINCT coalesce(nullif(si.category, ''), '未分类') AS category
    FROM bill_lines l LEFT JOIN service_items si ON si.id = l.item_id
    WHERE l.source = 'dining' AND l.business_date BETWEEN ${q.from} AND ${q.to} ORDER BY 1`;
  const list = rows.map((r) => ({ ...r, id: Number(r.id), postedAt: new Date(r.postedAt).toISOString() }));
  const active = list.filter((r) => r.status === 'active');
  const voided = list.filter((r) => r.status === 'voided');
  return {
    from: q.from,
    to: q.to,
    categories: categories.map((c) => c.category),
    rows: list,
    totals: {
      lines: list.length,
      quantity: active.reduce((n, r) => n + r.quantity, 0),
      amount: active.reduce((n, r) => n + Number(r.amount), 0),
      voidedLines: voided.length,
      voidedAmount: voided.reduce((n, r) => n + Number(r.amount), 0),
    },
  };
}

const KITCHEN_TEXT: Record<string, string> = { queued: '待做', cooking: '制作中', done: '已出餐', served: '已上菜', cancelled: '已退' };

export function diningLedgerCsv(l: DiningLedger, timeZone: string): string {
  const time = (iso: string) => new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const yuan = (c: number) => (c / 100).toFixed(2);
  return toCsv([
    ['营业日', '时间', '手牌', '桌台', '菜名', '分类', '数量', '单价', '金额', '状态', '退菜原因', '出品', '点单人'],
    ...l.rows.map((r) => [
      r.businessDate,
      time(r.postedAt),
      r.tagCode,
      r.tableName,
      r.name,
      r.category,
      r.quantity,
      yuan(r.unitPrice),
      yuan(r.amount),
      r.status === 'active' ? '有效' : '已退',
      r.voidReason ?? '',
      r.kitchenStatus ? KITCHEN_TEXT[r.kitchenStatus] ?? r.kitchenStatus : '',
      r.postedByName,
    ]),
    ['合计', '', '', '', `${l.totals.lines} 条（有效 ${l.totals.lines - l.totals.voidedLines}、已退 ${l.totals.voidedLines}）`, '', l.totals.quantity, '', yuan(l.totals.amount), '有效金额', `已退 ${yuan(l.totals.voidedAmount)}`, '', ''],
  ]);
}

// ───────────────────────── 退菜记录（B02） ─────────────────────────

/** 按营业日起止列出退的菜（餐饮明细），带怎么批的（审计里记的；升级前退的没有，记「—」） */
export async function dishVoids(db: Db, deps: Deps, q: { from: string; to: string }): Promise<DishVoidRow[]> {
  checkLedgerRange(q.from, q.to);
  const settings = await loadSettings(db);
  const start = businessDayStart(q.from, deps.config.timezone, settings.businessDayStartHour);
  const end = new Date(businessDayStart(q.to, deps.config.timezone, settings.businessDayStartHour).getTime() + 86_400_000);
  const rows = await db<(Omit<DishVoidRow, 'voidedAt' | 'approvalText'> & { voidedAt: string; approval: string | null; approverName: string | null })[]>`
    SELECT l.id, l.name, l.quantity, l.amount, l.void_reason, l.voided_at, vs.display_name AS voided_by_name, ps.display_name AS posted_by_name,
           coalesce(h.code, '') AS tag_code, coalesce(dt.name, '') AS table_name,
           a.detail->>'approval' AS approval, a.detail->>'approverName' AS approver_name
    FROM bill_lines l JOIN staff vs ON vs.id = l.voided_by JOIN staff ps ON ps.id = l.posted_by
    LEFT JOIN visits v ON v.bill_id = l.bill_id LEFT JOIN hand_tags h ON h.id = v.tag_id
    LEFT JOIN table_sessions ts ON ts.bill_id = l.bill_id LEFT JOIN dining_tables dt ON dt.id = ts.table_id
    LEFT JOIN LATERAL (
      SELECT detail FROM audit_logs WHERE action IN ('frontdesk_void', 'table_void') AND (detail->>'lineId')::bigint = l.id ORDER BY id DESC LIMIT 1
    ) a ON true
    WHERE l.source = 'dining' AND l.status = 'voided' AND l.voided_at >= ${start} AND l.voided_at < ${end}
    ORDER BY l.voided_at DESC, l.id DESC`;
  return rows.map(({ approval, approverName, ...r }) => ({
    ...r,
    id: Number(r.id),
    voidedAt: new Date(r.voidedAt).toISOString(),
    approvalText: approval ? `${VOID_APPROVAL_LABELS[approval as VoidApproval['approval']] ?? approval}${approverName ? `（${approverName}）` : ''}` : '—',
  }));
}

export function dishVoidsCsv(rows: DishVoidRow[], timeZone: string): string {
  const at = (iso: string) =>
    new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const yuan = (c: number) => (c / 100).toFixed(2);
  return toCsv([
    ['退菜时间', '手牌', '桌台', '菜名', '数量', '金额', '原因', '谁退的', '谁点的', '怎么批的'],
    ...rows.map((r) => [at(r.voidedAt), r.tagCode, r.tableName, r.name, r.quantity, yuan(r.amount), r.voidReason ?? '', r.voidedByName, r.postedByName, r.approvalText]),
    ['合计', '', '', `${rows.length} 条`, rows.reduce((n, r) => n + r.quantity, 0), yuan(rows.reduce((n, r) => n + Number(r.amount), 0)), '', '', '', ''],
  ]);
}

export function registerDining808Routes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 餐饮台账：点单的岗位与看日结的都能看、能导出
  const read = guardAny('dining.order', 'ledger.export', 'report.executive');
  app.get('/api/dining/ledger', { preHandler: read }, async (req) => diningLedger(sql, parse(LedgerQuery, req.query)));
  app.get('/api/dining/ledger/export', { preHandler: read }, async (req, reply) => {
    const q = parse(LedgerQuery, req.query);
    const l = await diningLedger(sql, q);
    return csvReply(reply, `餐饮台账-${q.from}至${q.to}${q.categories.length ? `-${q.categories.join('、')}` : ''}.csv`, diningLedgerCsv(l, deps.config.timezone));
  });
  const VoidsQuery = z.object({ from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'), to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD') });
  app.get('/api/dining/voids', { preHandler: read }, async (req) => dishVoids(sql, deps, parse(VoidsQuery, req.query)));
  app.get('/api/dining/voids/export', { preHandler: read }, async (req, reply) => {
    const q = parse(VoidsQuery, req.query);
    return csvReply(reply, `退菜记录-${q.from}至${q.to}.csv`, dishVoidsCsv(await dishVoids(sql, deps, q), deps.config.timezone));
  });
}
