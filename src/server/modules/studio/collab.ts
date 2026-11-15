// UI 工作台的协作（8.1.2，docs/WORKBENCH_V811.md 第 13 节）：批注（在画布上留言，设计师和店主来回说，GZ28）、
// 「谁在改」（这个界面的编辑器还有谁开着）、设计包（版面连同用到的图导出成一个文件，在别的环境导进来接着改）。
//
// 锁：批注新建只写新的一行（操作编号的唯一约束兜底，原样重提返回那一条），标解决 / 重新打开只改那一条；
// 「谁在改」只在进程里记（不进数据库，重启就清空，45 秒没报到的不算）；导入设计包先按内容存图（主键去重，不加锁）、
// 不碰草稿——版面交回编辑器，照常存草稿（带版本号）、发布。都不碰业务表。

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { docAssets, validateStudioDoc, type StudioCommentView, type StudioDoc, type StudioPack, type StudioPresence, type StudioSurface } from '@shared/studio';
import type { Db } from '../../db';
import { writeAudit } from '../../lib/audit';
import { attachment } from '../../lib/csv';
import { ctxOf, type Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { currentStoreId } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { parseStudioAsset } from './assets';

const NodeId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, '节点编号不对');
const CommentInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  screen: z.string().regex(/^@?[A-Za-z0-9_-]{1,40}$/, '屏的名字不对'),
  nodeId: NodeId.nullable().optional(),
  x: z.number().finite().min(-10000).max(30000),
  y: z.number().finite().min(-10000).max(30000),
  parentId: z.number().int().positive().nullable().optional(),
  body: z.string().trim().min(1, '写点什么').max(1000, '最多 1000 字'),
});

const commentColumns = (db: Db) => db`
  m.id, m.screen, m.node_id, m.x, m.y, m.parent_id, m.body, m.created_by AS created_by_id, coalesce(a.display_name, '') AS created_by, m.created_at,
  m.resolved_at, r.display_name AS resolved_by`;
const commentFrom = (db: Db) => db`studio_comments m LEFT JOIN staff a ON a.id = m.created_by LEFT JOIN staff r ON r.id = m.resolved_by`;

function commentView(r: Record<string, unknown>): StudioCommentView {
  return {
    id: Number(r.id),
    screen: String(r.screen),
    nodeId: (r.nodeId as string | null) ?? null,
    x: Number(r.x),
    y: Number(r.y),
    parentId: r.parentId === null || r.parentId === undefined ? null : Number(r.parentId),
    body: String(r.body),
    createdById: Number(r.createdById),
    createdBy: String(r.createdBy ?? ''),
    createdAt: new Date(r.createdAt as string).toISOString(),
    resolvedAt: r.resolvedAt ? new Date(r.resolvedAt as string).toISOString() : null,
    resolvedBy: r.resolvedAt ? String(r.resolvedBy ?? '') : null,
  };
}

/** 「谁在改」：界面 + 门店 → 员工 → 最近一次报到 */
const presence = new Map<string, Map<number, { name: string; at: number }>>();
const PRESENCE_MS = 45_000;

const PackInput = z.object({
  kind: z.literal('yuzu-studio-pack', '这不是工作台导出的设计包'),
  version: z.literal(1, '设计包的格式版本认不出来'),
  surface: z.string(),
  exportedAt: z.string().optional(),
  doc: z.unknown(),
  assets: z
    .array(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/, '设计包里图的编号不对'), name: z.string().max(80).default(''), mime: z.string().max(40), data: z.string().min(1) }))
    .max(200, '设计包里最多 200 张图'),
});

export function registerStudioCollab(
  app: FastifyInstance,
  deps: Deps,
  o: {
    edit: preHandlerHookHandler;
    surfaceOf: (params: unknown) => StudioSurface;
    parseDoc: (raw: unknown, surface: StudioSurface) => StudioDoc;
    draftDoc: (db: Db, surface: StudioSurface) => Promise<StudioDoc>;
  },
) {
  const { sql } = deps;

  // ── 批注 ──
  app.get('/api/studio/:surface/comments', { preHandler: o.edit }, async (req): Promise<StudioCommentView[]> => {
    const surface = o.surfaceOf(req.params);
    const rows = await sql<Record<string, unknown>[]>`
      SELECT ${commentColumns(sql)} FROM ${commentFrom(sql)} WHERE m.surface = ${surface} AND m.store_id = ${currentStoreId()} ORDER BY m.created_at, m.id LIMIT 2000`;
    return rows.map(commentView);
  });

  app.post('/api/studio/:surface/comments', { preHandler: o.edit }, async (req): Promise<StudioCommentView> => {
    const surface = o.surfaceOf(req.params);
    const input = parse(CommentInput, req.body);
    const storeId = currentStoreId();
    if (input.parentId) {
      const [p] = await sql<{ parentId: number | null; screen: string }[]>`
        SELECT parent_id, screen FROM studio_comments WHERE id = ${input.parentId} AND surface = ${surface} AND store_id = ${storeId}`;
      if (!p) throw notFound('要回复的那条批注不在了');
      if (p.parentId !== null) throw unprocessable('STUDIO_COMMENT', '回复挂在第一条下面（不能回复回复）');
    }
    const [made] = await sql<{ id: number }[]>`
      INSERT INTO studio_comments (surface, store_id, screen, node_id, x, y, parent_id, body, client_key, created_by)
      VALUES (${surface}, ${storeId}, ${input.screen}, ${input.nodeId ?? null}, ${input.x}, ${input.y}, ${input.parentId ?? null}, ${input.body}, ${input.clientKey}, ${req.actor.id})
      ON CONFLICT (client_key) DO NOTHING RETURNING id`;
    const id = made ? Number(made.id) : null;
    const [r] = await sql<Record<string, unknown>[]>`SELECT ${commentColumns(sql)} FROM ${commentFrom(sql)} WHERE ${id ? sql`m.id = ${id}` : sql`m.client_key = ${input.clientKey}`}`;
    // 原样重提：同一个人、同一句话返回那一条；别的拒绝
    if (!r || Number(r.createdById) !== req.actor.id || String(r.body) !== input.body) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用在另一条批注上，请刷新页面后重新写');
    return commentView(r);
  });

  app.post('/api/studio/comments/:id/resolve', { preHandler: o.edit }, async (req): Promise<StudioCommentView> => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { resolved } = parse(z.object({ resolved: z.boolean() }), req.body ?? {});
    const [r] = await sql<{ id: number }[]>`
      UPDATE studio_comments SET resolved_at = ${resolved ? sql`now()` : null}, resolved_by = ${resolved ? req.actor.id : null}
      WHERE id = ${id} AND store_id = ${currentStoreId()} AND parent_id IS NULL RETURNING id`;
    if (!r) throw notFound('没有这条批注（回复不用单独标解决）');
    const [row] = await sql<Record<string, unknown>[]>`SELECT ${commentColumns(sql)} FROM ${commentFrom(sql)} WHERE m.id = ${id}`;
    return commentView(row!);
  });

  // ── 谁在改 ──
  app.post('/api/studio/:surface/presence', { preHandler: o.edit }, async (req): Promise<StudioPresence[]> => {
    const surface = o.surfaceOf(req.params);
    const key = `${surface}:${currentStoreId()}`;
    const now = Date.now();
    const here = presence.get(key) ?? new Map<number, { name: string; at: number }>();
    here.set(req.actor.id, { name: req.actor.displayName, at: now });
    for (const [staffId, p] of here) if (now - p.at > PRESENCE_MS * 4) here.delete(staffId);
    presence.set(key, here);
    return [...here.entries()]
      .filter(([staffId, p]) => staffId !== req.actor.id && now - p.at <= PRESENCE_MS)
      .map(([staffId, p]) => ({ staffId, name: p.name, seenAt: new Date(p.at).toISOString() }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  });

  // ── 设计包 ──
  app.get('/api/studio/:surface/pack', { preHandler: o.edit }, async (req, reply) => {
    const surface = o.surfaceOf(req.params);
    const doc = await o.draftDoc(sql, surface);
    const ids = docAssets(doc);
    const assets = ids.length ? await sql<{ id: string; name: string; mime: string; data: Buffer }[]>`SELECT id, name, mime, data FROM studio_assets WHERE id = ANY(${ids}::text[])` : [];
    const pack: StudioPack = {
      kind: 'yuzu-studio-pack',
      version: 1,
      surface,
      exportedAt: new Date().toISOString(),
      doc,
      assets: assets.map((a) => ({ id: a.id, name: a.name, mime: a.mime, data: a.data.toString('base64') })),
    };
    const day = new Date().toISOString().slice(0, 10);
    attachment(reply, `设计包-${surface}-${day}.json`, 'application/json; charset=utf-8');
    return JSON.stringify(pack);
  });

  app.post('/api/studio/:surface/pack', { preHandler: o.edit, bodyLimit: 64 * 1024 * 1024 }, async (req) => {
    const surface = o.surfaceOf(req.params);
    const pack = parse(PackInput, req.body);
    if (pack.surface !== surface) throw unprocessable('STUDIO_PACK', `这是「${pack.surface}」的设计包，不能导进这个界面`);
    // 图：按内容重新核对（格式、SVG 里不能有脚本、内容与编号对得上），再按内容存（同一张只存一份）
    let added = 0;
    for (const a of pack.assets) {
      const parsed = parseStudioAsset(a.data);
      if (parsed.id !== a.id) throw unprocessable('STUDIO_PACK', `设计包里的图「${a.name || a.id.slice(0, 8)}」内容和编号对不上（文件被改过）`);
      const [r] = await sql<{ id: string }[]>`
        INSERT INTO studio_assets (id, mime, data, size_bytes, width, height, name, uploaded_by)
        VALUES (${parsed.id}, ${parsed.mime}, ${parsed.bytes}, ${parsed.bytes.length}, ${parsed.width}, ${parsed.height}, ${a.name || '设计包里的图'}, ${req.actor.id})
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      if (r) added += 1;
    }
    const doc = o.parseDoc(pack.doc, surface);
    const invalid = validateStudioDoc(doc).filter((i) => i.level === 'error');
    if (invalid.length) throw unprocessable('STUDIO_INVALID', `设计包里的版面用不了：${invalid[0]!.message}`, { issues: invalid });
    const need = docAssets(doc);
    if (need.length) {
      const have = await sql<{ id: string }[]>`SELECT id FROM studio_assets WHERE id = ANY(${need}::text[])`;
      if (have.length < need.length) throw unprocessable('STUDIO_PACK', '设计包里少了版面用到的图：在原来的环境重新导出一次');
    }
    const ctx = ctxOf(req);
    await writeAudit(sql, {
      staffId: ctx.actor.id,
      action: 'studio_pack_import',
      targetType: 'studio_design',
      detail: { surface, exportedAt: pack.exportedAt ?? null, assets: pack.assets.length, added },
      ip: ctx.ip,
    });
    return { doc, assets: pack.assets.length, added };
  });
}
