// 需求单草稿箱（供应链二次整改 03，docs/ERP_ROUND2.md）。
//
// · 草稿存在服务端、按人存，只有本人看得到；不是单据：没有单号、不进审核，能改能删。
// · 填单页每 30 秒把改过的内容存一次，离开、关页面时再存一次；内容不按提交的规则核对（只限长度与行数）。
// · 版本号（rev）：别处存过以后这边再存对不上、拒绝，不会悄悄盖掉；保存编号（saveId）：没收到回复、再发一次的同一次保存只算一次。
// · 提交成需求单、手动删除、需求单结束审核以后，草稿先标「已关闭」（挡住迟到的保存请求），第二天由每分钟的自动任务清掉；
//   30 天没再保存的也由它清掉。
// 加锁：保存、删除只锁草稿一行（读需求单不加锁）；提交、修改、审核需求单在各自已有的锁之后才关草稿——没有先锁草稿再锁需求单的路径。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DRAFT_KEEP_DAYS,
  DRAFT_LIMITS,
  DRAFT_MAX_PER_STAFF,
  imageUrl,
  MAX_LINE_IMAGES,
  type RequestDraft,
  type RequestDraftBody,
  type RequestDraftsList,
  type RequestDraftSummary,
} from '@shared/requests';
import { isUniqueViolation, type Db } from '../db';
import { guardAny } from '../auth/guard';
import type { Actor, Deps } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { setTxTimeouts } from '../lib/tx';
import { parse } from '../lib/validate';

const KIND = 'purchase_request';
const id = z.number().int().positive();
const text = (max: number) => z.string().max(max, `草稿里有一栏超过 ${max} 个字`).default('');

const DraftLine = z.object({
  kind: z.enum(['material', 'new']).default('new'),
  materialId: id.nullable().default(null),
  name: text(DRAFT_LIMITS.name),
  purpose: text(DRAFT_LIMITS.purpose),
  qty: text(DRAFT_LIMITS.qty),
  unit: text(DRAFT_LIMITS.unit),
  refPrice: text(DRAFT_LIMITS.refPrice),
  link: text(DRAFT_LIMITS.link),
  details: text(DRAFT_LIMITS.details),
  note: text(DRAFT_LIMITS.lineNote),
  imageIds: z.array(id).max(MAX_LINE_IMAGES, `每一行最多 ${MAX_LINE_IMAGES} 张图片`).default([]),
});
const DraftBody = z.object({
  departmentId: id.nullable().default(null),
  needBy: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, '日期格式应为 YYYY-MM-DD').default(''),
  priority: z.enum(['urgent', 'normal']).default('normal'),
  note: text(DRAFT_LIMITS.note),
  lines: z.array(DraftLine).min(1, '至少一行').max(50, '一张需求单最多 50 行'),
});
const SaveInput = z.object({
  rev: z.number().int().min(0),
  saveId: z.uuid('缺少有效的保存编号'),
  requestId: id.nullable().default(null),
  body: DraftBody,
});
type StoredBody = z.infer<typeof DraftBody>;

const KeyParam = z.object({ key: z.uuid('草稿编号格式不正确') });
const ListQuery = z.object({ requestId: z.coerce.number().int().positive().optional() });
/** 提交、修改需求单时带上的草稿编号（不算进原请求的摘要，见 requests.ts） */
export const DraftRef = z.object({ draftKey: z.uuid().nullable().default(null) });

interface SummaryRow {
  key: string;
  refId: number | null;
  docNo: string | null;
  departmentName: string | null;
  title: string;
  lineCount: number;
  rev: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

const toSummary = (r: SummaryRow): RequestDraftSummary => ({
  key: r.key,
  request: r.refId !== null && r.docNo ? { id: Number(r.refId), docNo: r.docNo } : null,
  departmentName: r.departmentName,
  title: r.title,
  lineCount: Number(r.lineCount),
  rev: Number(r.rev),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  expiresAt: r.expiresAt,
});

/** 自己的、没关闭、没过期的草稿；修改草稿对应的需求单已经结束审核的不算 */
const SUMMARY = (db: Db, actor: Actor, extra: ReturnType<Db>) => db<(SummaryRow & { payload: StoredBody })[]>`
  SELECT d.key, d.ref_id, r.doc_no, coalesce(rd.name, pd.name) AS department_name, d.title, d.line_count, d.rev, d.created_at, d.updated_at,
         d.updated_at + make_interval(days => ${DRAFT_KEEP_DAYS}) AS expires_at, d.payload
  FROM erp_drafts d
  LEFT JOIN purchase_requests r ON r.id = d.ref_id
  LEFT JOIN departments rd ON rd.id = r.department_id
  LEFT JOIN departments pd ON pd.id = (d.payload->>'departmentId')::bigint
  WHERE d.staff_id = ${actor.id} AND d.kind = ${KIND} AND d.closed_at IS NULL
    AND d.updated_at > now() - make_interval(days => ${DRAFT_KEEP_DAYS})
    AND (d.ref_id IS NULL OR r.status IN ('submitted', 'returned'))
    ${extra}
  ORDER BY d.updated_at DESC, d.id DESC`;

export async function listDrafts(db: Db, actor: Actor, raw: unknown): Promise<RequestDraftsList> {
  const q = parse(ListQuery, raw ?? {});
  const rows = await SUMMARY(db, actor, q.requestId ? db`AND d.ref_id = ${q.requestId}` : db``);
  return { drafts: rows.map(toSummary), max: DRAFT_MAX_PER_STAFF, keepDays: DRAFT_KEEP_DAYS };
}

function bodyOf(p: StoredBody): RequestDraftBody {
  return {
    departmentId: p.departmentId ?? null,
    needBy: p.needBy ?? '',
    priority: p.priority ?? 'normal',
    note: p.note ?? '',
    lines: (p.lines ?? []).map(({ imageIds, ...l }) => ({ ...l, images: (imageIds ?? []).map((i) => ({ id: Number(i), url: imageUrl(Number(i)) })) })),
  };
}

export async function getDraft(db: Db, actor: Actor, key: string): Promise<RequestDraft> {
  const [row] = await SUMMARY(db, actor, db`AND d.key = ${key}`);
  if (!row) throw notFound('这份草稿已经不在了（已提交、已删除或已过期）');
  return { ...toSummary(row), body: bodyOf(row.payload) };
}

const titleOf = (body: StoredBody) =>
  body.lines
    .map((l) => l.name.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('、')
    .slice(0, 200);

async function saveOnce(deps: Deps, key: string, input: z.infer<typeof SaveInput>, actor: Actor): Promise<RequestDraftSummary> {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [row] = await tx<{ id: number; staffId: number; refId: number | null; rev: number; lastSaveId: string; closedReason: string | null; updatedAt: Date }[]>`
      SELECT id, staff_id, ref_id, rev, last_save_id, closed_reason, updated_at FROM erp_drafts WHERE key = ${key} FOR UPDATE`;
    // 别人的草稿编号：当作不存在
    if (row && Number(row.staffId) !== actor.id) throw notFound('草稿不存在');
    if (row?.closedReason) {
      throw conflict('DRAFT_CLOSED', row.closedReason === 'submitted' ? '这份草稿已经提交成需求单了，不再保存' : row.closedReason === 'deleted' ? '这份草稿已经删除，不再保存' : '这张需求单已经结束审核，草稿不再保存', {
        reason: row.closedReason,
      });
    }
    // 同一次保存再发一次（上一次没收到回复）：已经存过了
    if (row && row.lastSaveId === input.saveId) return;
    if (row && Number(row.rev) !== input.rev) {
      throw conflict('DRAFT_CHANGED', '这份草稿在别的页面或别的电脑上改过了，这一页不再自动保存', { rev: Number(row.rev), updatedAt: row.updatedAt });
    }
    if (!row && input.rev !== 0) throw conflict('DRAFT_GONE', '这份草稿已经不在了（已删除或已过期），这一页不再自动保存');
    const imageIds = [...new Set(input.body.lines.flatMap((l) => l.imageIds))];
    if (imageIds.length) {
      const found = await tx<{ id: number }[]>`SELECT id FROM erp_images WHERE id IN ${tx(imageIds)} AND scope = 'general'`;
      if (found.length !== imageIds.length) throw unprocessable('IMAGE_NOT_FOUND', '有图片没有上传成功，请重新上传');
    }
    const title = titleOf(input.body);
    if (row) {
      if ((row.refId === null ? null : Number(row.refId)) !== input.requestId) throw badRequest('草稿对应的需求单不能改');
      await tx`
        UPDATE erp_drafts SET payload = ${tx.json(input.body as never)}, image_ids = ${imageIds}::bigint[], title = ${title}, line_count = ${input.body.lines.length},
               rev = rev + 1, last_save_id = ${input.saveId}, updated_at = now()
        WHERE id = ${row.id}`;
      return;
    }
    if (input.requestId !== null) {
      // 修改草稿：那张需求单要是自己能改的（待审核、退回）。只读核对，不锁需求单
      const [r] = await tx<{ requesterId: number; status: string }[]>`SELECT requester_id, status FROM purchase_requests WHERE id = ${input.requestId}`;
      if (!r || (Number(r.requesterId) !== actor.id && actor.role !== 'owner')) throw notFound('需求单不存在');
      if (r.status !== 'submitted' && r.status !== 'returned') throw conflict('DRAFT_CLOSED', '这张需求单已经结束审核，草稿不再保存', { reason: 'obsolete' });
      // 同一张需求单一人一份：别的页面留下的那份先关掉
      await tx`
        UPDATE erp_drafts SET closed_at = now(), closed_reason = 'obsolete'
        WHERE staff_id = ${actor.id} AND kind = ${KIND} AND ref_id = ${input.requestId} AND closed_at IS NULL`;
    } else {
      const [n] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM erp_drafts
        WHERE staff_id = ${actor.id} AND kind = ${KIND} AND closed_at IS NULL AND updated_at > now() - make_interval(days => ${DRAFT_KEEP_DAYS})`;
      if (n!.count >= DRAFT_MAX_PER_STAFF) throw conflict('DRAFT_LIMIT', `草稿箱已经有 ${DRAFT_MAX_PER_STAFF} 份草稿，请先删掉不用的，这一页的内容才能存成草稿`);
    }
    await tx`
      INSERT INTO erp_drafts (key, kind, staff_id, ref_id, payload, image_ids, title, line_count, rev, last_save_id)
      VALUES (${key}, ${KIND}, ${actor.id}, ${input.requestId}, ${tx.json(input.body as never)}, ${imageIds}::bigint[], ${title}, ${input.body.lines.length}, 1, ${input.saveId})`;
  });
  const [saved] = await deps.sql<SummaryRow[]>`
    SELECT d.key, d.ref_id, r.doc_no, NULL::text AS department_name, d.title, d.line_count, d.rev, d.created_at, d.updated_at,
           d.updated_at + make_interval(days => ${DRAFT_KEEP_DAYS}) AS expires_at
    FROM erp_drafts d LEFT JOIN purchase_requests r ON r.id = d.ref_id
    WHERE d.key = ${key} AND d.staff_id = ${actor.id}`;
  if (!saved) throw conflict('DRAFT_GONE', '这份草稿已经不在了（已删除或已过期），这一页不再自动保存');
  return toSummary(saved);
}

export async function saveDraft(deps: Deps, key: string, raw: unknown, actor: Actor): Promise<RequestDraftSummary> {
  const input = parse(SaveInput, raw);
  try {
    return await saveOnce(deps, key, input, actor);
  } catch (error) {
    // 同一份草稿的两次第一次保存撞在一起（重发）：再走一遍，这一次按已有的那一行处理
    if (isUniqueViolation(error, 'erp_drafts_key_key') || isUniqueViolation(error, 'erp_drafts_ref_uq')) return saveOnce(deps, key, input, actor);
    throw error;
  }
}

/** 手动删除：标已关闭（草稿箱里看不到；迟到的保存请求不会把它又建出来） */
export async function deleteDraft(db: Db, actor: Actor, key: string) {
  const rows = await db<{ id: number }[]>`
    UPDATE erp_drafts SET closed_at = now(), closed_reason = 'deleted'
    WHERE key = ${key} AND staff_id = ${actor.id} AND kind = ${KIND} AND closed_at IS NULL RETURNING id`;
  if (rows.length === 0) {
    const [any] = await db<{ id: number }[]>`SELECT id FROM erp_drafts WHERE key = ${key} AND staff_id = ${actor.id}`;
    if (!any) throw notFound('这份草稿已经不在了（已提交、已删除或已过期）');
  }
  return { ok: true };
}

/**
 * 提交成需求单（新提的、修改的）时在同一个事务里关掉草稿：这份草稿不会留着被再提一次。
 * 草稿还没来得及存过的（第一次保存的请求还在路上）也记一条已关闭的，迟到的那次保存到了会被拒绝。
 */
export async function closeDraftsOnSubmit(tx: Db, staffId: number, opts: { draftKey: string | null; requestId?: number }) {
  if (opts.requestId) {
    await tx`
      UPDATE erp_drafts SET closed_at = now(), closed_reason = 'submitted'
      WHERE staff_id = ${staffId} AND kind = ${KIND} AND ref_id = ${opts.requestId} AND closed_at IS NULL`;
  }
  if (opts.draftKey) {
    await tx`
      INSERT INTO erp_drafts (key, kind, staff_id, payload, last_save_id, closed_at, closed_reason)
      VALUES (${opts.draftKey}, ${KIND}, ${staffId}, '{}'::jsonb, gen_random_uuid(), now(), 'submitted')
      ON CONFLICT (key) DO UPDATE SET closed_at = now(), closed_reason = 'submitted'
        WHERE erp_drafts.staff_id = EXCLUDED.staff_id AND erp_drafts.closed_at IS NULL`;
  }
}

/** 需求单通过、定为不采购、撤回以后：它的修改草稿（不管谁的）都用不上了 */
export async function closeDraftsOfRequest(tx: Db, requestId: number) {
  await tx`UPDATE erp_drafts SET closed_at = now(), closed_reason = 'obsolete' WHERE kind = ${KIND} AND ref_id = ${requestId} AND closed_at IS NULL`;
}

/** 每分钟的自动任务：清掉 30 天没再保存的草稿，与关闭满一天的 */
export async function sweepDrafts(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db<{ id: number }[]>`
    DELETE FROM erp_drafts
    WHERE updated_at < ${now}::timestamptz - make_interval(days => ${DRAFT_KEEP_DAYS})
       OR (closed_at IS NOT NULL AND closed_at < ${now}::timestamptz - interval '1 day')
    RETURNING id`;
  return rows.length;
}

export function registerRequestDraftRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const pre = guardAny('request.create');
  const keyOf = (req: { params: unknown }) => parse(KeyParam, req.params).key;
  app.get('/api/erp/requests/drafts', { preHandler: pre }, async (req) => listDrafts(sql, req.actor, req.query));
  app.get('/api/erp/requests/drafts/:key', { preHandler: pre }, async (req) => getDraft(sql, req.actor, keyOf(req)));
  app.put('/api/erp/requests/drafts/:key', { preHandler: pre, bodyLimit: 400_000 }, async (req) => saveDraft(deps, keyOf(req), req.body, req.actor));
  app.post('/api/erp/requests/drafts/:key/delete', { preHandler: pre }, async (req) => deleteDraft(sql, req.actor, keyOf(req)));
}
