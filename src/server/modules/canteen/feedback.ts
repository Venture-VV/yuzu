// 员工食堂 · 跟柚子说（docs/CANTEEN.md 第 16 节，店主 2026-11-06，K16）：员工写给柚子的心愿（想要柚子在汤崎的线上空间做的事）
// 和碎碎念；管理员在 ERP「员工食堂 → 柚子信箱」看、标为看过、回一句话，员工在柚子饭堂里看得到回信。
// 食堂负责人也能在手机上看柚子信箱、标看过、回信（店主 2026-11-10，第 18 节，K20，迁移 096）：看过的人记第一次看过的那位，
// 回信的人记最后一次回信的那位，管理员记 read_by / replied_by，负责人记 read_by_employee / replied_by_employee，各自正好一个。
//
// 说出去的内容只追加（触发器挡着改与删），只能标看过、回信。同一个操作编号重发返回同一条（回复没收到时原样重发）。
// 锁：员工发一条先锁那位员工一行（同一个人的几条串行，数「今天说了几条」不会多算）；看过只锁那一条；
// 回信先取操作编号的咨询锁（管理员的与「确认作废」串行；负责人的同一个编号排队），再锁那一条。

import { z } from 'zod';
import { FEEDBACK_KINDS, FEEDBACK_KIND_LABELS, FEEDBACK_LIMITS, type CanteenFeedbackList, type CanteenFeedbackRow, type MyFeedbackRow } from '@shared/canteen';
import { businessDateOf } from '@shared/business-date';
import type { Db, Sql } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { OpContext } from '../../lib/context';
import { conflict, notFound, unauthorized, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import type { CanteenSessionEmployee } from './portal-auth';

const MY_ROW = (db: Db) => db`
  SELECT id, kind, content, created_at, read_at IS NOT NULL AS read, reply, replied_at FROM canteen_feedback`;

const SubmitInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  kind: z.enum(FEEDBACK_KINDS, '选一下：想要柚子做的，还是碎碎念'),
  content: z
    .string('写点什么吧')
    .trim()
    .min(1, '写点什么吧')
    .max(FEEDBACK_LIMITS.content, `最多 ${FEEDBACK_LIMITS.content} 个字`),
});

/** 员工发一条：每人每天（门店时间）最多 20 条；同一个操作编号重发返回原来那条 */
export async function submitFeedback(sql: Sql, me: CanteenSessionEmployee, raw: unknown, timeZone: string, nowMs = Date.now()): Promise<MyFeedbackRow> {
  const input = parse(SubmitInput, raw);
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [e] = await tx<{ name: string }[]>`SELECT name FROM canteen_employees WHERE id = ${me.id} AND active FOR UPDATE`;
    if (!e) throw unauthorized('请先登录柚子饭堂');
    const [old] = await tx<(MyFeedbackRow & { employeeId: number })[]>`
      SELECT id, employee_id, kind, content, created_at, read_at IS NOT NULL AS read, reply, replied_at FROM canteen_feedback WHERE client_key = ${input.clientKey}`;
    if (old) {
      if (old.employeeId !== me.id) throw conflict('CLIENT_KEY_USED', '这个操作编号已经用过了，请刷新后再发');
      const { employeeId: _, ...row } = old;
      return row;
    }
    const today = businessDateOf(new Date(nowMs), timeZone, 0);
    const [n] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM canteen_feedback
      WHERE employee_id = ${me.id} AND (created_at AT TIME ZONE ${timeZone})::date = ${today}::date`;
    if (n!.n >= FEEDBACK_LIMITS.perDay) {
      throw unprocessable('FEEDBACK_DAILY_LIMIT', `今天已经跟柚子说了 ${FEEDBACK_LIMITS.perDay} 条啦，柚子慢慢看，明天再来吧`);
    }
    const [row] = await tx<MyFeedbackRow[]>`
      INSERT INTO canteen_feedback (employee_id, employee_name, kind, content, client_key)
      VALUES (${me.id}, ${e.name}, ${input.kind}, ${input.content}, ${input.clientKey})
      RETURNING id, kind, content, created_at, false AS read, reply, replied_at`;
    return row!;
  });
}

/** 员工自己说过的（最近 50 条） */
export async function myFeedback(db: Db, employeeId: number): Promise<MyFeedbackRow[]> {
  return db<MyFeedbackRow[]>`${MY_ROW(db)} WHERE employee_id = ${employeeId} ORDER BY created_at DESC, id DESC LIMIT 50`;
}

// ── 管理后台：柚子信箱 ──

// 看过、回信的人：管理员写系统账号的名字，食堂负责人写名单上的名字加「（食堂负责人）」
const ADMIN_ROW = (db: Db) => db`
  SELECT f.id, f.employee_id, f.employee_name AS name, e.emp_no, e.avatar, f.kind, f.content, f.created_at,
         f.read_at, coalesce(rs.display_name, re.name || '（食堂负责人）') AS read_by_name,
         f.reply, f.replied_at, coalesce(ps.display_name, pe.name || '（食堂负责人）') AS replied_by_name
  FROM canteen_feedback f
  JOIN canteen_employees e ON e.id = f.employee_id
  LEFT JOIN staff rs ON rs.id = f.read_by
  LEFT JOIN staff ps ON ps.id = f.replied_by
  LEFT JOIN canteen_employees re ON re.id = f.read_by_employee
  LEFT JOIN canteen_employees pe ON pe.id = f.replied_by_employee`;

const ListQuery = z.object({
  status: z.enum(['all', 'unread', 'read', 'replied']).default('all'),
  kind: z.enum(['all', ...FEEDBACK_KINDS]).default('all'),
});

/** 页面一次最多列这么多条（合计照实给；要全部的导出表格） */
const PAGE_LIMIT = 500;

function filters(db: Db, q: z.infer<typeof ListQuery>) {
  return db`
    WHERE true
      ${q.status === 'unread' ? db`AND f.read_at IS NULL` : q.status === 'read' ? db`AND f.read_at IS NOT NULL` : q.status === 'replied' ? db`AND f.reply IS NOT NULL` : db``}
      ${q.kind === 'all' ? db`` : db`AND f.kind = ${q.kind}`}`;
}

/** 柚子信箱：没看过的排前面、再按时间从新到旧 */
export async function listFeedback(db: Db, raw: unknown, limit: number | null = PAGE_LIMIT): Promise<CanteenFeedbackList> {
  const q = parse(ListQuery, raw ?? {});
  const rows = await db<CanteenFeedbackRow[]>`
    ${ADMIN_ROW(db)} ${filters(db, q)}
    ORDER BY (f.read_at IS NULL) DESC, f.created_at DESC, f.id DESC
    ${limit === null ? db`` : db`LIMIT ${limit}`}`;
  const [c] = await db<{ total: number; unread: number }[]>`
    SELECT (SELECT count(*)::int FROM canteen_feedback f ${filters(db, q)}) AS total,
           (SELECT count(*)::int FROM canteen_feedback WHERE read_at IS NULL) AS unread`;
  return { rows, total: c!.total, unread: c!.unread };
}

export async function unreadFeedbackCount(db: Db): Promise<number> {
  const [c] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_feedback WHERE read_at IS NULL`;
  return c!.n;
}

async function feedbackRow(db: Db, id: number): Promise<CanteenFeedbackRow> {
  const [row] = await db<CanteenFeedbackRow[]>`${ADMIN_ROW(db)} WHERE f.id = ${id}`;
  if (!row) throw notFound('没有这一条');
  return row;
}

/** 标为看过（看过的再点不变） */
export async function markFeedbackRead(sql: Sql, id: number, ctx: OpContext): Promise<CanteenFeedbackRow> {
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<{ readAt: string | null }[]>`SELECT read_at FROM canteen_feedback WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('没有这一条');
    if (!cur.readAt) await tx`UPDATE canteen_feedback SET read_at = now(), read_by = ${ctx.actor.id} WHERE id = ${id}`;
    return feedbackRow(tx, id);
  });
}

const ReplyInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  reply: z
    .string('写一句回信')
    .trim()
    .min(1, '写一句回信')
    .max(FEEDBACK_LIMITS.reply, `回信最多 ${FEEDBACK_LIMITS.reply} 个字`),
});

/**
 * 回一句话（回信自动算看过）；再回一次是改回信，员工看到的是最新的那句。
 * 结果待确认（AGENTS.md）：每次回信带操作编号，记在 idempotency_keys（canteen_reply，ref_id 是那一条）。同一个编号再交只返回那一条、
 * 不再改一遍（之后改过的回信不会被晚到的旧请求改回去）；「确认作废」之后才到的整笔不改。
 * 锁：操作编号的咨询锁（与「确认作废」串行）→ 那一条。
 */
export async function replyFeedback(sql: Sql, id: number, raw: unknown, ctx: OpContext): Promise<CanteenFeedbackRow> {
  const { clientKey, reply } = parse(ReplyInput, raw);
  const requestHash = hashRequest({ id, reply });
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await assertNotFenced(tx, clientKey, 'canteen_reply', erpOpAbandoned);
    const [done] = await tx<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${clientKey}`;
    if (done) {
      if (done.opType !== 'canteen_reply' || done.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用过了（内容不一样）：刷新页面再回信');
      return feedbackRow(tx, Number(done.refId));
    }
    const [cur] = await tx<{ reply: string | null }[]>`SELECT reply FROM canteen_feedback WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('没有这一条');
    if (cur.reply !== reply) {
      // 回信的人换成这位管理员（负责人那一列清空）；看过的人只在还没人看过时记这位（负责人看过的照旧是负责人）
      await tx`
        UPDATE canteen_feedback SET reply = ${reply}, replied_at = now(), replied_by = ${ctx.actor.id}, replied_by_employee = NULL,
               read_by = CASE WHEN read_at IS NULL THEN ${ctx.actor.id} ELSE read_by END, read_at = coalesce(read_at, now())
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'canteen_feedback',
        targetType: 'canteen_feedback',
        targetId: id,
        detail: { op: cur.reply === null ? 'reply' : 'edit_reply', before: cur.reply, after: reply },
        ip: ctx.ip,
      });
    }
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${clientKey}, 'canteen_reply', ${requestHash}, ${id}, ${ctx.actor.id})`;
    return feedbackRow(tx, id);
  });
}

// ── 食堂负责人在手机上：柚子信箱（店主 2026-11-10，docs/CANTEEN.md 第 18 节，K20）──
// 与后台同一份信箱：同样的筛选与排序，看过、回信两边都看得到（谁看过、谁回的写在后台）；员工看到的回信照旧是「柚子回信」。

/** 手机上一次最多列这么多条（合计照实给） */
export const MAILBOX_PAGE_LIMIT = 200;

export async function managerMailbox(db: Db, raw: unknown): Promise<CanteenFeedbackList> {
  return listFeedback(db, raw, MAILBOX_PAGE_LIMIT);
}

/** 负责人标为看过（看过的再点不变：第一次看过的那位不变） */
export async function managerMarkRead(sql: Sql, id: number, me: CanteenSessionEmployee): Promise<CanteenFeedbackRow> {
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<{ readAt: string | null }[]>`SELECT read_at FROM canteen_feedback WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('没有这一条');
    if (!cur.readAt) await tx`UPDATE canteen_feedback SET read_at = now(), read_by_employee = ${me.id} WHERE id = ${id}`;
    return feedbackRow(tx, id);
  });
}

/**
 * 负责人回一句话（回信自动算看过；再回一次是改回信，员工看到的是最新的那句）。
 * 结果待确认：每次回信带操作编号，记在 canteen_feedback_reply_ops。同一个编号再交只返回那一条、不再改一遍
 * （之后改过的回信——管理员的或别的负责人的——不会被晚到的旧请求改回去）；同一个编号换了内容拒绝。
 * 锁：操作编号的咨询锁（同一个编号的重发、连点排队）→ 那一条。
 */
export async function managerReplyFeedback(sql: Sql, id: number, raw: unknown, me: CanteenSessionEmployee, ip?: string): Promise<CanteenFeedbackRow> {
  const { clientKey, reply } = parse(ReplyInput, raw);
  const requestHash = hashRequest({ id, reply });
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, clientKey);
    const [done] = await tx<{ feedbackId: number; employeeId: number; requestHash: string }[]>`
      SELECT feedback_id, employee_id, request_hash FROM canteen_feedback_reply_ops WHERE client_key = ${clientKey}`;
    if (done) {
      if (Number(done.employeeId) !== me.id || done.requestHash !== requestHash) {
        throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用过了（内容不一样）：刷新一下再回信');
      }
      return feedbackRow(tx, Number(done.feedbackId));
    }
    const [cur] = await tx<{ reply: string | null }[]>`SELECT reply FROM canteen_feedback WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('没有这一条');
    if (cur.reply !== reply) {
      // 回信的人换成这位负责人（管理员那一列清空）；看过的人只在还没人看过时记这位
      await tx`
        UPDATE canteen_feedback SET reply = ${reply}, replied_at = now(), replied_by = NULL, replied_by_employee = ${me.id},
               read_by_employee = CASE WHEN read_at IS NULL THEN ${me.id} ELSE read_by_employee END, read_at = coalesce(read_at, now())
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: null,
        action: 'canteen_feedback',
        targetType: 'canteen_feedback',
        targetId: id,
        detail: { op: cur.reply === null ? 'reply' : 'edit_reply', before: cur.reply, after: reply, by: 'canteen_manager', employeeId: me.id, employeeName: me.name },
        ip,
      });
    }
    await tx`
      INSERT INTO canteen_feedback_reply_ops (client_key, feedback_id, employee_id, request_hash)
      VALUES (${clientKey}, ${id}, ${me.id}, ${requestHash})`;
    return feedbackRow(tx, id);
  });
}

/** 导出表格的行（不截断） */
export function feedbackCsvRows(rows: CanteenFeedbackRow[], timeZone: string): string[][] {
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const at = (iso: string | null) => (iso ? fmt.format(new Date(iso)) : '');
  // 员工随手写的话：以 - 开头的也加一个单引号（toCsv 只挡 = + @ 和不是负数的 -），免得表格软件当成公式
  const text = (v: string) => (/^-/.test(v) ? `'${v}` : v);
  return [
    ['时间', '工号', '名字', '种类', '内容', '看过', '回信', '回信时间', '回信人'],
    ...rows.map((r) => [at(r.createdAt), r.empNo, text(r.name), FEEDBACK_KIND_LABELS[r.kind], text(r.content), r.readAt ? '看过' : '没看', text(r.reply ?? ''), at(r.repliedAt), r.repliedByName ?? '']),
  ];
}
