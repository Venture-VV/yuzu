// UI 工作台（8.1.1，docs/WORKBENCH_V811.md）：设计师在系统里改版面、预览、检查、发布、回滚；平板读已发布的那一版。
//
// 加锁与幂等（写进 AGENTS.md）：
//   · 存草稿只锁这份版面一行（带版本号 rev，对不上拒绝 STUDIO_REV），不带操作编号（自动保存，重复存同一份没有副作用）；
//   · 发布、回滚：操作编号的咨询锁（与「确认作废」串行，业务类型 studio_publish，编号记在 studio_versions.client_key）
//     → 「界面 + 门店」的版本咨询锁（同一家店的发布、回滚排队，版本号一个接一个）→ 发布再锁草稿一行（核对 rev）→ 写新的一版；
//   · 素材按内容摘要存（主键去重，不加锁）；预览码只写自己一行。都不碰任何业务表的锁。
// 门店：草稿、版本、预览码按店分（GZ11）；这家店没发布过的，平板用本店（编号 1）的，再没有就用代码里内置的默认版面。

import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  changedScreens,
  checkStudioDoc,
  defaultStudioDoc,
  docAssets,
  DocSchema,
  STUDIO_LIMITS,
  STUDIO_SURFACE_LABELS,
  STUDIO_SURFACES,
  upgradeStudioDoc,
  validateStudioDoc,
  type StudioAssetView,
  type StudioDoc,
  type StudioOverview,
  type StudioPreviewCode,
  type StudioState,
  type StudioSurface,
  type StudioVersionView,
} from '@shared/studio';
import { guard, guardAny } from '../../auth/guard';
import { readSnapshot, type Db, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { currentStoreId, DEFAULT_STORE_ID } from '../../lib/store-context';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import { EMENU_PERIODS } from '@shared/emenu';
import { emenuMenu, loadEmenuRules } from '../emenu/core';
import { assetHeaders, parseStudioAsset } from './assets';
import { registerStudioCollab } from './collab';
import { studioPublishedRef } from './published';

export { studioPublishedRef };

/** 预览码多久有效 */
const PREVIEW_MINUTES = 30;
const PREVIEW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const SurfaceParam = z.object({ surface: z.enum(STUDIO_SURFACES, '没有这个界面') });

/** 存进库、读出来的版面：先升到现在的格式、按格式与界面登记核对 */
function parseDoc(raw: unknown, surface: StudioSurface): StudioDoc {
  let upgraded: unknown;
  try {
    upgraded = upgradeStudioDoc(raw);
  } catch (e) {
    throw unprocessable('STUDIO_FORMAT', e instanceof Error ? e.message : '版面格式不对');
  }
  const r = DocSchema.safeParse(upgraded);
  if (!r.success) {
    const first = r.error.issues[0];
    throw unprocessable('STUDIO_FORMAT', `版面格式不对：${first ? `${first.path.join('.')} ${first.message}` : ''}`.trim());
  }
  if (r.data.surface !== surface) throw unprocessable('STUDIO_FORMAT', '版面不是这个界面的');
  return r.data;
}

const versionColumns = (db: Db) => db`
  v.id, v.version, v.kind, v.rollback_of, v.note, v.screens_changed, v.published_at, coalesce(s.display_name, '') AS published_by,
  v.effective_at, c.cancelled_at, cs.display_name AS cancelled_by`;
/** 版本连着发布的人、撤销（定时发布还没生效就撤了的，8.1.2） */
const versionFrom = (db: Db) => db`
  studio_versions v LEFT JOIN staff s ON s.id = v.published_by
  LEFT JOIN studio_version_cancels c ON c.version_id = v.id LEFT JOIN staff cs ON cs.id = c.cancelled_by`;

function versionView(r: Record<string, unknown>): StudioVersionView {
  return {
    id: Number(r.id),
    version: Number(r.version),
    kind: r.kind as StudioVersionView['kind'],
    rollbackOf: r.rollbackOf === null || r.rollbackOf === undefined ? null : Number(r.rollbackOf),
    note: String(r.note ?? ''),
    screensChanged: (r.screensChanged as string[] | null) ?? [],
    publishedAt: new Date(r.publishedAt as string).toISOString(),
    publishedBy: String(r.publishedBy ?? ''),
    effectiveAt: r.effectiveAt ? new Date(r.effectiveAt as string).toISOString() : null,
    cancelledAt: r.cancelledAt ? new Date(r.cancelledAt as string).toISOString() : null,
    cancelledBy: r.cancelledAt ? String(r.cancelledBy ?? '') : null,
  };
}

/** 这家店最新的一版（没有返回空） */
async function latestVersion(db: Db, surface: StudioSurface, storeId: number): Promise<(StudioVersionView & { doc: unknown }) | null> {
  const [r] = await db<Record<string, unknown>[]>`
    SELECT ${versionColumns(db)}, v.doc FROM ${versionFrom(db)}
    WHERE v.surface = ${surface} AND v.store_id = ${storeId} ORDER BY v.version DESC LIMIT 1`;
  return r ? { ...versionView(r), doc: r.doc } : null;
}

/** 编辑器打开时的草稿：这家店存过的；没存过的从这家店（或本店）最新发布的那一版开始，再没有就是默认版面 */
async function loadDraft(db: Db, surface: StudioSurface): Promise<StudioState['draft']> {
  const [row] = await db<{ doc: unknown; rev: number; updatedAt: string; updatedBy: string }[]>`
    SELECT d.doc, d.rev, d.updated_at, coalesce(s.display_name, '') AS updated_by FROM studio_designs d LEFT JOIN staff s ON s.id = d.updated_by
    WHERE d.surface = ${surface} AND d.store_id = ${currentStoreId()}`;
  if (row) return { doc: parseDoc(row.doc, surface), rev: Number(row.rev), updatedAt: new Date(row.updatedAt).toISOString(), updatedBy: row.updatedBy };
  const ref = await studioPublishedRef(db, surface);
  if (ref) {
    const [v] = await db<{ doc: unknown }[]>`SELECT doc FROM studio_versions WHERE id = ${ref.id}`;
    if (v) return { doc: parseDoc(v.doc, surface), rev: 0, updatedAt: null, updatedBy: null };
  }
  return { doc: defaultStudioDoc(surface), rev: 0, updatedAt: null, updatedBy: null };
}

async function langSwitchOn(db: Db, surface: StudioSurface): Promise<boolean> {
  return surface === 'emenu' ? (await loadEmenuRules(db)).langSwitch : false;
}

/** 素材库里有的（编号 → 字节数） */
async function assetSizes(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db<{ id: string; sizeBytes: number }[]>`SELECT id, size_bytes FROM studio_assets WHERE id IN ${db(ids)}`;
  return new Map(rows.map((r) => [r.id, Number(r.sizeBytes)]));
}

/** 存草稿：版本号对不上拒绝；不合格式、按界面登记核对不过的存不进去 */
const DraftInput = z.object({ rev: z.number().int().min(0), doc: z.unknown() });

async function saveDraft(deps: Deps, surface: StudioSurface, body: unknown, ctx: OpContext): Promise<{ rev: number; updatedAt: string }> {
  const input = parse(DraftInput, body);
  const doc = parseDoc(input.doc, surface);
  if (JSON.stringify(doc).length > STUDIO_LIMITS.bytes) throw unprocessable('STUDIO_TOO_LARGE', '版面太大了（超过 512 KB）：删掉一些图层再存');
  const issues = validateStudioDoc(doc).filter((i) => i.level === 'error');
  if (issues.length) throw unprocessable('STUDIO_INVALID', issues[0]!.message, { issues });
  const storeId = currentStoreId();
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [row] = await tx<{ id: number; rev: number }[]>`
      SELECT id, rev FROM studio_designs WHERE surface = ${surface} AND store_id = ${storeId} FOR UPDATE`;
    const current = row ? Number(row.rev) : 0;
    const stale = () => conflict('STUDIO_REV', '这份版面刚刚在别处改过（另一个人或另一个窗口）：刷新以后再改', { rev: current });
    if (input.rev !== current) throw stale();
    const saved = row
      ? await tx<{ rev: number; updatedAt: string }[]>`
          UPDATE studio_designs SET doc = ${tx.json(doc as never)}, rev = rev + 1, updated_by = ${ctx.actor.id}, updated_at = now()
          WHERE id = ${row.id} RETURNING rev, updated_at`
      : await tx<{ rev: number; updatedAt: string }[]>`
          INSERT INTO studio_designs (surface, store_id, doc, rev, updated_by) VALUES (${surface}, ${storeId}, ${tx.json(doc as never)}, 1, ${ctx.actor.id})
          ON CONFLICT (surface, store_id) DO NOTHING RETURNING rev, updated_at`;
    // 两个窗口同时第一次存：后到的那一次插不进去，照「别处改过」处理
    if (!saved[0]) throw stale();
    return { rev: Number(saved[0].rev), updatedAt: new Date(saved[0].updatedAt).toISOString() };
  });
}

const PublishInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  rev: z.number().int().min(1, '先存一次草稿再发布'),
  note: z.string().trim().min(1, '写一句改了什么').max(200, '最多 200 字'),
  /** 定时发布（8.1.2，GZ27）：定在以后什么时候生效（不给 = 现在就生效） */
  effectiveAt: z.iso.datetime({ offset: true, message: '生效时间写成 2026-11-20T10:00:00+08:00 这样' }).nullable().optional(),
});
/** 定时发布最早 2 分钟以后、最晚 60 天以内 */
const SCHEDULE_MIN_MS = 2 * 60_000;
const SCHEDULE_MAX_MS = 60 * 86_400_000;
/**
 * 离生效不到这么久的定时发布不能再撤（8.1.2，PR #116 测试会话在 045560f 报的 P2）：撤销要等「界面 + 门店」的版本锁、写完再提交，
 * 这期间到了点，平板、员工手机可能已经读到这一版在用；提交以后再撤，现在用的那一版又退回去。锁最多等 5 秒、每条语句最多 10 秒，
 * 留一分钟足够。
 */
const CANCEL_CUTOFF_SEC = 60;
const CancelInput = z.object({ reason: z.string().trim().max(200, '最多 200 字').default('') });
const RollbackInput = z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'), version: z.number().int().min(1), note: z.string().trim().max(200, '最多 200 字').default('') });

/** 发布、回滚共用：写新的一版（在调用方的事务里，已经取了操作编号的锁、核对过没有作废） */
async function insertVersion(
  tx: Tx,
  a: {
    surface: StudioSurface;
    storeId: number;
    doc: StudioDoc;
    kind: 'publish' | 'rollback';
    rollbackOf: number | null;
    note: string;
    clientKey: string;
    requestHash: string;
    ctx: OpContext;
    effectiveAt?: string | null;
  },
): Promise<StudioVersionView> {
  // 检查（GZ7）：红的不能发布
  const issues = checkStudioDoc(a.doc, { assets: await assetSizes(tx, docAssets(a.doc)), langSwitch: await langSwitchOn(tx, a.surface) });
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) throw unprocessable('STUDIO_CHECK', `检查没过：${errors[0]!.message}`, { issues });
  const last = await latestVersion(tx, a.surface, a.storeId);
  const before = last ? (DocSchema.safeParse(last.doc).data ?? null) : defaultStudioDoc(a.surface);
  const screens = changedScreens(before, a.doc);
  const version = (last?.version ?? 0) + 1;
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO studio_versions (surface, store_id, version, kind, rollback_of, doc, doc_hash, note, screens_changed, client_key, request_hash, published_by, effective_at)
    VALUES (${a.surface}, ${a.storeId}, ${version}, ${a.kind}, ${a.rollbackOf}, ${tx.json(a.doc as never)}, ${hashRequest(a.doc)}, ${a.note}, ${screens},
            ${a.clientKey}, ${a.requestHash}, ${a.ctx.actor.id}, ${a.effectiveAt ?? null})
    RETURNING id`;
  await writeAudit(tx, {
    staffId: a.ctx.actor.id,
    action: a.kind === 'publish' ? 'studio_publish' : 'studio_rollback',
    targetType: 'studio_version',
    targetId: Number(row!.id),
    detail: { surface: a.surface, version, rollbackOf: a.rollbackOf, note: a.note, screens, warnings: issues.length, effectiveAt: a.effectiveAt ?? null },
    ip: a.ctx.ip,
  });
  return (await versionById(tx, Number(row!.id)))!;
}

async function versionById(db: Db, id: number): Promise<StudioVersionView | null> {
  const [r] = await db<Record<string, unknown>[]>`SELECT ${versionColumns(db)} FROM ${versionFrom(db)} WHERE v.id = ${id}`;
  return r ? versionView(r) : null;
}

/** 操作编号已经有结果：内容一样返回那一版，不一样拒绝 */
async function replay(tx: Tx, clientKey: string, requestHash: string): Promise<StudioVersionView | null> {
  const [seen] = await tx<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM studio_versions WHERE client_key = ${clientKey}`;
  if (!seen) return null;
  if (seen.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用在另一次发布上，请刷新页面后重新发布');
  return versionById(tx, Number(seen.id));
}

/** 同一家店的发布、回滚排队：版本号一个接一个 */
const lockVersions = (tx: Tx, surface: StudioSurface, storeId: number) => tx`SELECT pg_advisory_xact_lock(hashtextextended(${`studio_versions:${surface}:${storeId}`}, 0))`;

async function publish(deps: Deps, surface: StudioSurface, body: unknown, ctx: OpContext): Promise<StudioVersionView> {
  const input = parse(PublishInput, body);
  const storeId = currentStoreId();
  const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt).toISOString() : null;
  const requestHash = hashRequest({ kind: 'publish', surface, storeId, rev: input.rev, note: input.note, ...(effectiveAt ? { effectiveAt } : {}) });
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, input.clientKey);
    const again = await replay(tx, input.clientKey, requestHash);
    if (again) return again;
    await assertNotFenced(tx, input.clientKey, 'studio_publish', erpOpAbandoned);
    await lockVersions(tx, surface, storeId);
    const [design] = await tx<{ doc: unknown; rev: number }[]>`
      SELECT doc, rev FROM studio_designs WHERE surface = ${surface} AND store_id = ${storeId} FOR UPDATE`;
    if (!design || Number(design.rev) !== input.rev) throw conflict('STUDIO_REV', '草稿在你看过以后又改过：刷新、看一眼再发布', { rev: design ? Number(design.rev) : 0 });
    if (effectiveAt) {
      // 按数据库的时钟核对：至少 2 分钟以后、60 天以内（等过锁，用此刻的时钟 clock_timestamp()，不用事务开始的 now()）
      const [clock] = await tx<{ now: string }[]>`SELECT clock_timestamp() AS now`;
      const ahead = Date.parse(effectiveAt) - new Date(clock!.now).getTime();
      if (ahead < SCHEDULE_MIN_MS) throw unprocessable('STUDIO_SCHEDULE', '定时发布的时间至少要在 2 分钟以后；马上要换就选「现在生效」');
      if (ahead > SCHEDULE_MAX_MS) throw unprocessable('STUDIO_SCHEDULE', '定时发布最多定在 60 天以内');
    }
    return insertVersion(tx, { surface, storeId, doc: parseDoc(design.doc, surface), kind: 'publish', rollbackOf: null, note: input.note, clientKey: input.clientKey, requestHash, ctx, effectiveAt });
  });
}

async function rollback(deps: Deps, surface: StudioSurface, body: unknown, ctx: OpContext): Promise<StudioVersionView> {
  const input = parse(RollbackInput, body);
  const storeId = currentStoreId();
  const requestHash = hashRequest({ kind: 'rollback', surface, storeId, version: input.version, note: input.note });
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, input.clientKey);
    const again = await replay(tx, input.clientKey, requestHash);
    if (again) return again;
    await assertNotFenced(tx, input.clientKey, 'studio_publish', erpOpAbandoned);
    await lockVersions(tx, surface, storeId);
    const [target] = await tx<{ doc: unknown }[]>`
      SELECT doc FROM studio_versions WHERE surface = ${surface} AND store_id = ${storeId} AND version = ${input.version}`;
    if (!target) throw notFound(`没有第 ${input.version} 版`);
    // 旧的一版按现在的格式与界面登记再核对一遍（界面登记以后可能改过）
    const doc = parseDoc(target.doc, surface);
    const invalid = validateStudioDoc(doc).filter((i) => i.level === 'error');
    if (invalid.length) throw unprocessable('STUDIO_INVALID', `第 ${input.version} 版现在用不了：${invalid[0]!.message}`, { issues: invalid });
    return insertVersion(tx, { surface, storeId, doc, kind: 'rollback', rollbackOf: input.version, note: input.note || `回到第 ${input.version} 版`, clientKey: input.clientKey, requestHash, ctx });
  });
}

/**
 * 撤销定时发布（8.1.2）：只撤还没生效、离生效还有一分钟以上的那一版（撤了永远不生效）；撤过的原样返回。
 * 生效没有按锁之后此刻的时钟（clock_timestamp()）判断——事务开始的 now() 在等锁时不走，等过了点还会当成没生效。
 */
async function cancelScheduled(deps: Deps, surface: StudioSurface, version: number, body: unknown, ctx: OpContext): Promise<StudioVersionView> {
  const input = parse(CancelInput, body ?? {});
  const storeId = currentStoreId();
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockVersions(tx, surface, storeId);
    const [v] = await tx<{ id: number; effectiveAt: string | null; live: boolean; imminent: boolean; cancelled: boolean }[]>`
      SELECT v.id, v.effective_at, coalesce(v.effective_at, v.published_at) <= clock_timestamp() AS live,
             coalesce(v.effective_at, v.published_at) <= clock_timestamp() + make_interval(secs => ${CANCEL_CUTOFF_SEC}) AS imminent,
             EXISTS (SELECT 1 FROM studio_version_cancels c WHERE c.version_id = v.id) AS cancelled
      FROM studio_versions v WHERE v.surface = ${surface} AND v.store_id = ${storeId} AND v.version = ${version}`;
    if (!v) throw notFound(`没有第 ${version} 版`);
    if (v.cancelled) return (await versionById(tx, Number(v.id)))!;
    if (!v.effectiveAt) throw unprocessable('STUDIO_NOT_SCHEDULED', `第 ${version} 版不是定时发布的：要换回去就「回到」上一版`);
    if (v.live) throw unprocessable('STUDIO_ALREADY_LIVE', `第 ${version} 版已经生效了，撤不了：要换回去就「回到」上一版`);
    if (v.imminent) throw unprocessable('STUDIO_ALREADY_LIVE', `第 ${version} 版不到一分钟就要生效了，来不及撤：生效以后要换回去就「回到」上一版`);
    await tx`INSERT INTO studio_version_cancels (version_id, cancelled_by, reason) VALUES (${v.id}, ${ctx.actor.id}, ${input.reason})`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'studio_cancel',
      targetType: 'studio_version',
      targetId: Number(v.id),
      detail: { surface, version, effectiveAt: v.effectiveAt, reason: input.reason },
      ip: ctx.ip,
    });
    return (await versionById(tx, Number(v.id)))!;
  });
}

const AssetInput = z.object({ name: z.string().trim().max(80).default(''), data: z.string().min(1, '没有图片内容') });

function assetView(r: Record<string, unknown>): StudioAssetView {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    mime: String(r.mime),
    size: Number(r.sizeBytes),
    width: r.width === null ? null : Number(r.width),
    height: r.height === null ? null : Number(r.height),
    uploadedAt: new Date(r.uploadedAt as string).toISOString(),
    uploadedBy: String(r.uploadedBy ?? ''),
  };
}
const assetColumns = (db: Db) => db`a.id, a.name, a.mime, a.size_bytes, a.width, a.height, a.uploaded_at, coalesce(s.display_name, '') AS uploaded_by`;

function previewCode(): string {
  return Array.from({ length: 8 }, () => PREVIEW_ALPHABET[randomInt(PREVIEW_ALPHABET.length)]).join('');
}

export function registerStudioRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const edit = guard('studio.edit');
  const publishGuard = guard('studio.publish');
  // 平板、维护电子菜单的人、设计师都要读已发布的版面与素材
  const reader = guardAny('studio.edit', 'emenu.view', 'emenu.manage');
  const surfaceOf = (params: unknown) => parse(SurfaceParam, params).surface;

  app.get(
    '/api/studio',
    { preHandler: edit },
    async (): Promise<StudioOverview> =>
      readSnapshot(sql, async (tx) => ({
        surfaces: await Promise.all(
          STUDIO_SURFACES.map(async (surface) => {
            const draft = await loadDraft(tx, surface);
            const ref = await studioPublishedRef(tx, surface);
            const [next] = await tx<Record<string, unknown>[]>`
              SELECT ${versionColumns(tx)} FROM ${versionFrom(tx)}
              WHERE v.surface = ${surface} AND v.store_id = ${currentStoreId()} AND v.effective_at > now() AND c.version_id IS NULL ORDER BY v.effective_at, v.version LIMIT 1`;
            const [open] = await tx<{ n: number }[]>`
              SELECT count(*)::int AS n FROM studio_comments WHERE surface = ${surface} AND store_id = ${currentStoreId()} AND parent_id IS NULL AND resolved_at IS NULL`;
            return {
              surface,
              label: STUDIO_SURFACE_LABELS[surface],
              draftUpdatedAt: draft.updatedAt,
              draftUpdatedBy: draft.updatedBy,
              published: ref ? await versionById(tx, ref.id) : null,
              inherited: ref?.inherited ?? false,
              scheduled: next ? versionView(next) : null,
              openComments: Number(open?.n ?? 0),
            };
          }),
        ),
      })),
  );

  app.get('/api/studio/:surface', { preHandler: edit }, async (req): Promise<StudioState> => {
    const surface = surfaceOf(req.params);
    return readSnapshot(sql, async (tx) => {
      const ref = await studioPublishedRef(tx, surface);
      const scheduled = await tx<Record<string, unknown>[]>`
        SELECT ${versionColumns(tx)} FROM ${versionFrom(tx)}
        WHERE v.surface = ${surface} AND v.store_id = ${currentStoreId()} AND v.effective_at > now() AND c.version_id IS NULL ORDER BY v.effective_at, v.version`;
      return {
        surface,
        draft: await loadDraft(tx, surface),
        published: ref ? await versionById(tx, ref.id) : null,
        inherited: ref?.inherited ?? false,
        langSwitch: await langSwitchOn(tx, surface),
        scheduled: scheduled.map(versionView),
      };
    });
  });

  app.put('/api/studio/:surface/draft', { preHandler: edit, bodyLimit: STUDIO_LIMITS.bytes * 2 }, async (req) => saveDraft(deps, surfaceOf(req.params), req.body, ctxOf(req)));
  app.post('/api/studio/:surface/publish', { preHandler: publishGuard }, async (req) => publish(deps, surfaceOf(req.params), req.body, ctxOf(req)));
  app.post('/api/studio/:surface/rollback', { preHandler: publishGuard }, async (req) => rollback(deps, surfaceOf(req.params), req.body, ctxOf(req)));
  // 批注、谁在改、设计包（8.1.2）
  registerStudioCollab(app, deps, { edit, surfaceOf, parseDoc, draftDoc: async (db, surface) => (await loadDraft(db, surface)).doc });
  app.post('/api/studio/:surface/versions/:version/cancel', { preHandler: publishGuard }, async (req) => {
    const { version } = parse(z.object({ version: z.coerce.number().int().min(1) }), req.params);
    return cancelScheduled(deps, surfaceOf(req.params), version, req.body, ctxOf(req));
  });

  app.get('/api/studio/:surface/versions', { preHandler: edit }, async (req): Promise<StudioVersionView[]> => {
    const surface = surfaceOf(req.params);
    const rows = await sql<Record<string, unknown>[]>`
      SELECT ${versionColumns(sql)} FROM ${versionFrom(sql)}
      WHERE v.surface = ${surface} AND v.store_id = ${currentStoreId()} ORDER BY v.version DESC LIMIT 200`;
    // 现在用的是哪一版（定时发布的到点才算；这家店没发布过时一版都不是）
    const ref = await studioPublishedRef(sql, surface);
    return rows.map((r) => ({ ...versionView(r), current: !!ref && !ref.inherited && Number(r.id) === ref.id }));
  });

  app.get('/api/studio/:surface/versions/:version', { preHandler: edit }, async (req) => {
    const surface = surfaceOf(req.params);
    const { version } = parse(z.object({ version: z.coerce.number().int().min(1) }), req.params);
    const [r] = await sql<Record<string, unknown>[]>`
      SELECT ${versionColumns(sql)}, v.doc FROM ${versionFrom(sql)}
      WHERE v.surface = ${surface} AND v.store_id = ${currentStoreId()} AND v.version = ${version}`;
    if (!r) throw notFound(`没有第 ${version} 版`);
    return { ...versionView(r), doc: parseDoc(r.doc, surface) };
  });

  // 平板按全局编号取已发布的版面：内容不会变（只追加），浏览器长期缓存
  app.get('/api/studio/docs/:id', { preHandler: reader }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const [r] = await sql<{ id: number; version: number; surface: StudioSurface; storeId: number; doc: unknown }[]>`
      SELECT id, version, surface, store_id, doc FROM studio_versions WHERE id = ${id}`;
    // 只给这家店的或本店的（GZ11）
    if (!r || (Number(r.storeId) !== currentStoreId() && Number(r.storeId) !== DEFAULT_STORE_ID)) throw notFound('没有这一版');
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return { id: Number(r.id), version: Number(r.version), doc: parseDoc(r.doc, r.surface) };
  });

  // 「在平板上看」：存当时草稿的一份快照，30 分钟有效；点餐平板打开 /emenu?studio=<码> 进预览（不能下单）
  app.post('/api/studio/:surface/preview-code', { preHandler: edit }, async (req): Promise<StudioPreviewCode> => {
    const surface = surfaceOf(req.params);
    const body = parse(z.object({ doc: z.unknown() }), req.body ?? {});
    const doc = parseDoc(body.doc, surface);
    const invalid = validateStudioDoc(doc).filter((i) => i.level === 'error');
    if (invalid.length) throw unprocessable('STUDIO_INVALID', invalid[0]!.message, { issues: invalid });
    await sql`DELETE FROM studio_preview_codes WHERE expires_at < now() - interval '1 day'`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = previewCode();
      const rows = await sql<{ expiresAt: string }[]>`
        INSERT INTO studio_preview_codes (code, surface, store_id, doc, created_by, expires_at)
        VALUES (${code}, ${surface}, ${currentStoreId()}, ${sql.json(doc as never)}, ${req.actor.id}, now() + ${PREVIEW_MINUTES} * interval '1 minute')
        ON CONFLICT (code) DO NOTHING RETURNING expires_at`;
      if (rows[0]) return { code, expiresAt: new Date(rows[0].expiresAt).toISOString() };
    }
    throw conflict('STUDIO_PREVIEW', '预览码没生成出来，再点一次');
  });

  app.get('/api/studio/preview/:code', { preHandler: reader }, async (req) => {
    const { code } = parse(
      z.object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z2-9]{8}$/, '预览码不对'),
      }),
      req.params,
    );
    const [r] = await sql<{ surface: StudioSurface; doc: unknown; expiresAt: string }[]>`
      SELECT surface, doc, expires_at FROM studio_preview_codes WHERE code = ${code} AND expires_at > now()`;
    if (!r) throw notFound('预览码不对或已经过期（30 分钟有效）：在工作台里重新生成');
    return { surface: r.surface, doc: parseDoc(r.doc, r.surface), expiresAt: new Date(r.expiresAt).toISOString() };
  });

  // 编辑器里用真实的菜单画菜单页、顶栏（设计师看不到「打开平板点餐」的接口）：与平板读的是同一份。
  // period（8.1.5，PP8）：按早餐 / 午餐 / 晚餐某一段看、all 看全部分类；不给是现在
  app.get('/api/studio/emenu/menu', { preHandler: edit }, async (req) => {
    const { period } = parse(z.object({ period: z.enum([...EMENU_PERIODS, 'all'], '时段不对').optional() }), req.query);
    return readSnapshot(sql, (tx) => emenuMenu(tx, deps, period));
  });

  // ── 素材 ──
  app.get('/api/studio/assets', { preHandler: edit }, async (): Promise<StudioAssetView[]> => {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT ${assetColumns(sql)} FROM studio_assets a LEFT JOIN staff s ON s.id = a.uploaded_by ORDER BY a.uploaded_at DESC LIMIT 500`;
    return rows.map(assetView);
  });

  // 一张最大 5 MB（Base64 以后约 6.7 MB）
  app.post('/api/studio/assets', { preHandler: edit, bodyLimit: 7_200_000 }, async (req): Promise<StudioAssetView> => {
    const input = parse(AssetInput, req.body);
    const asset = parseStudioAsset(input.data);
    await sql`
      INSERT INTO studio_assets (id, mime, data, size_bytes, width, height, name, uploaded_by)
      VALUES (${asset.id}, ${asset.mime}, ${asset.bytes}, ${asset.bytes.length}, ${asset.width}, ${asset.height}, ${input.name || '未命名'}, ${req.actor.id})
      ON CONFLICT (id) DO NOTHING`;
    const [r] = await sql<Record<string, unknown>[]>`SELECT ${assetColumns(sql)} FROM studio_assets a LEFT JOIN staff s ON s.id = a.uploaded_by WHERE a.id = ${asset.id}`;
    return assetView(r!);
  });

  app.get('/api/studio/assets/:id', { preHandler: reader }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/, '素材编号不对') }), req.params);
    const [r] = await sql<{ mime: string; data: Buffer }[]>`SELECT mime, data FROM studio_assets WHERE id = ${id}`;
    if (!r) throw notFound('没有这张图');
    reply.headers(assetHeaders(r.mime));
    return reply.send(r.data);
  });

  // 素材的大小：发布前检查用（编辑器里也显示）
  app.get('/api/studio/assets-sizes', { preHandler: edit }, async (req) => {
    const { ids } = parse(
      z.object({
        ids: z
          .string()
          .max(65 * 400)
          .default(''),
      }),
      req.query ?? {},
    );
    const list = ids.split(',').filter((x) => /^[0-9a-f]{64}$/.test(x));
    if (list.length > 400) throw badRequest('一次最多查 400 张');
    return Object.fromEntries(await assetSizes(sql, list));
  });
}
