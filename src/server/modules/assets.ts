// 资产与易耗台账（8.0.7 ERP P2 3.2，docs/ERP_V807.md，迁移 102）：
//   · 资产卡片：从收货单的某一行「转资产建卡」（一件一张，不超过收货数量）或手工建（期初）；编号 ZC + 日期 + 序号。
//   · 调拨（换部门、位置、保管人）、改状态（在用 / 闲置 / 维修）、报废（写原因）都记变动记录（只追加），卡片带版本号。
//   · 标签：二维码就是资产编号（页面上打印）；扫码盘点：开一次盘点（全部或某个部门），扫码或手输编号，
//     结束时列出没扫到的（盘亏）与不在范围里的；结果只记录，不自动改卡片（V15）。
// 锁：建卡先取操作编号的咨询锁（与「确认作废」串行），转资产建卡再锁那一行收货明细（FOR UPDATE，核对张数）；
// 改卡片只锁卡片一行（带版本号）；盘点：扫码只锁盘点一行（共享锁，核对没结束），结束锁盘点一行。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ASSET_BATCH_MAX, ASSET_CATEGORIES, ASSET_STATUSES, type AssetCard, type AssetChange, type AssetDetail, type AssetReceiptLine, type AssetStocktake } from '@shared/assets';
import type { Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { todayIn } from '../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { dateSchema, idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';

const CARD_SELECT = (db: Db) => db`
  SELECT c.id, c.asset_no, c.name, c.category, c.department_id, d.name AS department_name, c.location, c.keeper, c.original_cents,
         c.acquired_on::text AS acquired_on, c.status, c.material_id, c.note, c.version, c.created_at,
         CASE WHEN c.receipt_line_id IS NULL THEN NULL
              ELSE json_build_object('docId', doc.id, 'docNo', doc.doc_no, 'lineId', c.receipt_line_id) END AS receipt
  FROM asset_cards c
  LEFT JOIN departments d ON d.id = c.department_id
  LEFT JOIN inv_doc_lines l ON l.id = c.receipt_line_id
  LEFT JOIN inv_docs doc ON doc.id = l.doc_id`;

const toCard = (r: AssetCard): AssetCard => ({
  ...r,
  id: Number(r.id),
  departmentId: r.departmentId === null ? null : Number(r.departmentId),
  originalCents: Number(r.originalCents),
  materialId: r.materialId === null ? null : Number(r.materialId),
});

const ListQuery = z.object({
  q: z.string().trim().max(40).optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  category: z.enum(ASSET_CATEGORIES).optional(),
});

export async function listAssets(db: Db, raw: unknown): Promise<AssetCard[]> {
  const q = parse(ListQuery, raw);
  const rows = await db<AssetCard[]>`
    ${CARD_SELECT(db)}
    WHERE true
      ${q.departmentId ? db`AND c.department_id = ${q.departmentId}` : db``}
      ${q.status ? db`AND c.status = ${q.status}` : db``}
      ${q.category ? db`AND c.category = ${q.category}` : db``}
      ${q.q ? db`AND (c.asset_no ILIKE ${'%' + q.q + '%'} OR c.name ILIKE ${'%' + q.q + '%'} OR c.keeper ILIKE ${'%' + q.q + '%'})` : db``}
    ORDER BY c.status = 'scrapped', c.asset_no DESC LIMIT 1000`;
  return rows.map(toCard);
}

export async function getAsset(db: Db, id: number): Promise<AssetDetail> {
  const [r] = await db<AssetCard[]>`${CARD_SELECT(db)} WHERE c.id = ${id}`;
  if (!r) throw notFound('资产卡片不存在');
  const changes = await db<AssetChange[]>`
    SELECT x.id, x.kind, x.detail, x.reason, s.display_name AS created_by_name, x.created_at
    FROM asset_changes x JOIN staff s ON s.id = x.created_by WHERE x.asset_id = ${id} ORDER BY x.id DESC`;
  return { ...toCard(r), changes: changes.map((c) => ({ ...c, id: Number(c.id) })) };
}

/** 按收货单号找能转资产建卡的行：生效的收货单，按整件算还能建几张 */
export async function receiptLinesFor(db: Db, docNo: string): Promise<AssetReceiptLine[]> {
  const rows = await db<{ lineId: number; docId: number; docNo: string; docDate: string; materialId: number; materialName: string; inventoryUnit: string; qtyMilli: string; carded: number; amountCents: string | null }[]>`
    SELECT l.id AS line_id, d.id AS doc_id, d.doc_no, d.doc_date::text AS doc_date, l.material_id, m.name AS material_name, m.inventory_unit,
           l.qty_milli::text AS qty_milli, (SELECT count(*)::int FROM asset_cards c WHERE c.receipt_line_id = l.id) AS carded, l.amount_cents::text AS amount_cents
    FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id JOIN materials m ON m.id = l.material_id
    WHERE d.doc_no = ${docNo.trim()} AND d.doc_type = 'receipt' AND d.status = 'confirmed' AND l.qty_milli > 0
    ORDER BY l.line_no`;
  return rows.map((r) => {
    const quantity = Math.floor(Number(r.qtyMilli) / 1000);
    return {
      lineId: Number(r.lineId),
      docId: Number(r.docId),
      docNo: r.docNo,
      docDate: r.docDate,
      materialId: Number(r.materialId),
      materialName: r.materialName,
      inventoryUnit: r.inventoryUnit,
      quantity,
      carded: r.carded,
      unitCents: r.amountCents && Number(r.qtyMilli) > 0 ? Math.round((Number(r.amountCents) * 1000) / Number(r.qtyMilli)) : 0,
    };
  });
}

const CreateInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  name: z.string('请填写名称').trim().min(1, '请填写名称').max(60, '名称最多 60 个字'),
  category: z.enum(ASSET_CATEGORIES, '请选择类别'),
  departmentId: z.number().int().positive().nullable().default(null),
  location: z.string().trim().max(60, '存放位置最多 60 个字').default(''),
  keeper: z.string().trim().max(20, '保管人最多 20 个字').default(''),
  originalCents: z.number('请填写原值').int().min(0, '原值不能为负').max(100_000_000_000),
  acquiredOn: dateSchema('取得日期'),
  /** 建几张（一件一张） */
  quantity: z.number().int().min(1).max(ASSET_BATCH_MAX, `一次最多建 ${ASSET_BATCH_MAX} 张`).default(1),
  /** 从收货单的哪一行转来；手工建（期初）不填 */
  receiptLineId: z.number().int().positive().nullable().default(null),
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
});

export async function createAssets(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ ids: number[]; replayed: boolean }> {
  const input = parse(CreateInput, raw);
  if (input.acquiredOn > todayIn(deps.config.timezone)) throw badRequest('取得日期不能晚于今天');
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, input.clientKey);
    await assertNotFenced(tx, input.clientKey, 'asset_card', erpOpAbandoned);
    const existing = await tx<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM asset_cards WHERE client_key = ${input.clientKey} ORDER BY id`;
    if (existing.length) {
      if (existing[0]!.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次建卡，请刷新页面后重新填写');
      return { ids: existing.map((e) => Number(e.id)), replayed: true };
    }
    if (input.departmentId) {
      const [d] = await tx<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${input.departmentId}`;
      if (!d || !d.active) throw unprocessable('DEPARTMENT_INACTIVE', '使用部门不存在或已停用');
    }
    let materialId: number | null = null;
    if (input.receiptLineId) {
      const [l] = await tx<{ qtyMilli: string; materialId: number; docType: string; status: string; docNo: string }[]>`
        SELECT l.qty_milli::text AS qty_milli, l.material_id, d.doc_type, d.status, d.doc_no
        FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id WHERE l.id = ${input.receiptLineId} FOR UPDATE OF l`;
      if (!l || l.docType !== 'receipt' || l.status !== 'confirmed') throw unprocessable('RECEIPT_LINE_INVALID', '只能从生效的收货单转资产建卡');
      const [c] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_cards WHERE receipt_line_id = ${input.receiptLineId}`;
      const max = Math.floor(Number(l.qtyMilli) / 1000);
      if (c!.n + input.quantity > max) {
        throw unprocessable('ASSET_OVER_RECEIPT', `收货单 ${l.docNo} 这一行收了 ${max} 件，已经建了 ${c!.n} 张，最多还能建 ${Math.max(0, max - c!.n)} 张`);
      }
      materialId = Number(l.materialId);
    }
    const ids: number[] = [];
    for (let i = 0; i < input.quantity; i += 1) {
      const assetNo = await nextDocNo(tx, 'asset', 'ZC', input.acquiredOn);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO asset_cards (asset_no, name, category, department_id, location, keeper, original_cents, acquired_on, material_id, receipt_line_id, note, client_key, request_hash, created_by)
        VALUES (${assetNo}, ${input.name}, ${input.category}, ${input.departmentId}, ${input.location}, ${input.keeper}, ${input.originalCents}, ${input.acquiredOn},
                ${materialId}, ${input.receiptLineId}, ${input.note}, ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      ids.push(Number(row!.id));
      await tx`INSERT INTO asset_changes (asset_id, kind, detail, created_by) VALUES (${row!.id}, 'create', ${tx.json({ assetNo, receiptLineId: input.receiptLineId } as never)}, ${actor.id})`;
    }
    await writeAudit(tx, { staffId: actor.id, action: 'asset_card', targetType: 'asset_card', targetId: ids[0], detail: { op: 'create', name: input.name, quantity: input.quantity, receiptLineId: input.receiptLineId }, ip });
    return { ids, replayed: false };
  });
}

const ChangeInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('transfer'),
    expectedVersion: z.number().int().positive(),
    departmentId: z.number().int().positive().nullable(),
    location: z.string().trim().max(60, '存放位置最多 60 个字'),
    keeper: z.string().trim().max(20, '保管人最多 20 个字'),
    reason: z.string().trim().max(200).default(''),
  }),
  z.object({ kind: z.literal('status'), expectedVersion: z.number().int().positive(), status: z.enum(['in_use', 'idle', 'repair'], '请选择状态'), reason: z.string().trim().max(200).default('') }),
  z.object({ kind: z.literal('scrap'), expectedVersion: z.number().int().positive(), reason: z.string('请写报废原因').trim().min(2, '请写报废原因（至少 2 个字）').max(200) }),
  z.object({ kind: z.literal('edit'), expectedVersion: z.number().int().positive(), name: z.string().trim().min(1, '请填写名称').max(60), note: z.string().trim().max(200).default('') }),
]);

/** 调拨、改状态、报废、改名称与备注：只锁卡片一行，带版本号；记变动记录 */
export async function changeAsset(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(ChangeInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [c] = await tx<{ version: number; status: string; departmentId: number | null; location: string; keeper: string; name: string; assetNo: string }[]>`
      SELECT version, status, department_id, location, keeper, name, asset_no FROM asset_cards WHERE id = ${id} FOR UPDATE`;
    if (!c) throw notFound('资产卡片不存在');
    if (c.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '卡片刚被别人改过，请刷新后再改');
    if (c.status === 'scrapped') throw conflict('INVALID_STATE', '报废的资产卡片不能再改');
    if (input.kind === 'transfer') {
      if (input.departmentId) {
        const [d] = await tx<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${input.departmentId}`;
        if (!d || !d.active) throw unprocessable('DEPARTMENT_INACTIVE', '使用部门不存在或已停用');
      }
      await tx`UPDATE asset_cards SET department_id = ${input.departmentId}, location = ${input.location}, keeper = ${input.keeper}, version = version + 1, updated_at = now() WHERE id = ${id}`;
      await tx`INSERT INTO asset_changes (asset_id, kind, detail, reason, created_by) VALUES (${id}, 'transfer', ${tx.json({ from: { departmentId: c.departmentId, location: c.location, keeper: c.keeper }, to: { departmentId: input.departmentId, location: input.location, keeper: input.keeper } } as never)}, ${input.reason}, ${actor.id})`;
    } else if (input.kind === 'status') {
      await tx`UPDATE asset_cards SET status = ${input.status}, version = version + 1, updated_at = now() WHERE id = ${id}`;
      await tx`INSERT INTO asset_changes (asset_id, kind, detail, reason, created_by) VALUES (${id}, 'status', ${tx.json({ from: c.status, to: input.status } as never)}, ${input.reason}, ${actor.id})`;
    } else if (input.kind === 'scrap') {
      await tx`INSERT INTO asset_changes (asset_id, kind, detail, reason, created_by) VALUES (${id}, 'scrap', ${tx.json({ from: c.status } as never)}, ${input.reason}, ${actor.id})`;
      await tx`UPDATE asset_cards SET status = 'scrapped', version = version + 1, updated_at = now() WHERE id = ${id}`;
    } else {
      await tx`UPDATE asset_cards SET name = ${input.name}, note = ${input.note}, version = version + 1, updated_at = now() WHERE id = ${id}`;
      await tx`INSERT INTO asset_changes (asset_id, kind, detail, created_by) VALUES (${id}, 'edit', ${tx.json({ from: c.name, to: input.name } as never)}, ${actor.id})`;
    }
    await writeAudit(tx, { staffId: actor.id, action: 'asset_card', targetType: 'asset_card', targetId: id, detail: { op: input.kind, assetNo: c.assetNo }, ip });
  });
  return getAsset(deps.sql, id);
}

// ───────────────────────── 扫码盘点 ─────────────────────────

type StocktakeResult = Pick<AssetStocktake, 'expected' | 'found' | 'missing' | 'extra'>;

/** 按现在的卡片算这次盘点的结果：范围是这个部门（或全部）没报废的卡片；扫到的不在范围里、对不上的单列 */
async function liveResult(db: Db, id: number, departmentId: number | null): Promise<StocktakeResult> {
  const scope = await db<{ id: number; assetNo: string; name: string; location: string; keeper: string }[]>`
    SELECT id, asset_no, name, location, keeper FROM asset_cards
    WHERE status <> 'scrapped' ${departmentId ? db`AND department_id = ${departmentId}` : db``} ORDER BY asset_no`;
  const scans = await db<{ code: string; assetId: number | null; assetNo: string | null; name: string | null; departmentName: string | null }[]>`
    SELECT x.code, x.asset_id, c.asset_no, c.name, d.name AS department_name
    FROM asset_stocktake_scans x LEFT JOIN asset_cards c ON c.id = x.asset_id LEFT JOIN departments d ON d.id = c.department_id
    WHERE x.stocktake_id = ${id} ORDER BY x.scanned_at`;
  const inScope = new Set(scope.map((a) => Number(a.id)));
  const scannedIds = new Set(scans.filter((x) => x.assetId !== null).map((x) => Number(x.assetId)));
  return {
    expected: scope.length,
    found: [...scannedIds].filter((x) => inScope.has(x)).length,
    missing: scope.filter((a) => !scannedIds.has(Number(a.id))).map((a) => ({ ...a, id: Number(a.id) })),
    extra: scans
      .filter((x) => x.assetId === null || !inScope.has(Number(x.assetId)))
      .map((x) => ({ code: x.code, assetNo: x.assetNo, name: x.name, departmentName: x.departmentName })),
  };
}

export async function getStocktake(db: Db, id: number): Promise<AssetStocktake> {
  const [s] = await db<{ id: number; docNo: string; departmentId: number | null; departmentName: string | null; status: 'open' | 'closed'; note: string; startedByName: string; startedAt: string; closedAt: string | null; result: StocktakeResult | null }[]>`
    SELECT t.id, t.doc_no, t.department_id, d.name AS department_name, t.status, t.note, s.display_name AS started_by_name, t.started_at, t.closed_at, t.result
    FROM asset_stocktakes t JOIN staff s ON s.id = t.started_by LEFT JOIN departments d ON d.id = t.department_id WHERE t.id = ${id}`;
  if (!s) throw notFound('盘点不存在');
  const departmentId = s.departmentId === null ? null : Number(s.departmentId);
  // 结束了的按结束时记下的结果（迁移 105，之后建卡、调拨、报废不改写）；8.0.7 早先结束、没记结果的照旧现算；进行中的现算、还不列盘亏
  const result = s.status === 'closed' && s.result ? s.result : await liveResult(db, Number(s.id), departmentId);
  const scans = await db<{ code: string; assetNo: string | null; name: string | null; scannedAt: string }[]>`
    SELECT x.code, c.asset_no, c.name, x.scanned_at
    FROM asset_stocktake_scans x LEFT JOIN asset_cards c ON c.id = x.asset_id
    WHERE x.stocktake_id = ${id} ORDER BY x.scanned_at`;
  const { result: _stored, ...head } = s;
  return {
    ...head,
    id: Number(s.id),
    departmentId,
    expected: result.expected,
    found: result.found,
    missing: s.status === 'closed' ? result.missing : [],
    extra: result.extra,
    scans: scans.map((x) => ({ code: x.code, assetNo: x.assetNo, name: x.name, scannedAt: x.scannedAt })),
  };
}

export async function listStocktakes(db: Db): Promise<{ id: number; docNo: string; departmentName: string | null; status: string; startedAt: string; closedAt: string | null }[]> {
  const rows = await db<{ id: number; docNo: string; departmentName: string | null; status: string; startedAt: string; closedAt: string | null }[]>`
    SELECT t.id, t.doc_no, d.name AS department_name, t.status, t.started_at, t.closed_at
    FROM asset_stocktakes t LEFT JOIN departments d ON d.id = t.department_id ORDER BY t.id DESC LIMIT 50`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function startStocktake(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(z.object({ departmentId: z.number().int().positive().nullable().default(null), note: z.string().trim().max(200).default('') }), raw);
  const id = await deps.sql.begin(async (tx) => {
    const docNo = await nextDocNo(tx, 'asset_stocktake', 'ZP', todayIn(deps.config.timezone));
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO asset_stocktakes (doc_no, department_id, note, started_by) VALUES (${docNo}, ${input.departmentId}, ${input.note}, ${actor.id}) RETURNING id`;
    await writeAudit(tx, { staffId: actor.id, action: 'asset_stocktake', targetType: 'asset_stocktake', targetId: row!.id, detail: { op: 'start', docNo, departmentId: input.departmentId }, ip });
    return Number(row!.id);
  });
  return getStocktake(deps.sql, id);
}

/** 扫一个码（资产编号）：同一个码只记一次；对不上的也记下（结束时列在「不在范围里的」） */
export async function scanStocktake(deps: Deps, id: number, raw: unknown, actor: Actor) {
  const { code } = parse(z.object({ code: z.string('请扫码或输入资产编号').trim().min(1, '请扫码或输入资产编号').max(40, '编号太长了') }), raw);
  const norm = code.toUpperCase();
  await deps.sql.begin(async (tx) => {
    const [s] = await tx<{ status: string }[]>`SELECT status FROM asset_stocktakes WHERE id = ${id} FOR SHARE`;
    if (!s) throw notFound('盘点不存在');
    if (s.status !== 'open') throw conflict('INVALID_STATE', '这次盘点已经结束了');
    const [c] = await tx<{ id: number }[]>`SELECT id FROM asset_cards WHERE asset_no = ${norm}`;
    await tx`
      INSERT INTO asset_stocktake_scans (stocktake_id, code, asset_id, scanned_by) VALUES (${id}, ${norm}, ${c ? c.id : null}, ${actor.id})
      ON CONFLICT (stocktake_id, code) DO NOTHING`;
  });
  return getStocktake(deps.sql, id);
}

export async function closeStocktake(deps: Deps, id: number, actor: Actor, ip?: string) {
  await deps.sql.begin(async (tx) => {
    const [s] = await tx<{ status: string; docNo: string; departmentId: number | null }[]>`SELECT status, doc_no, department_id FROM asset_stocktakes WHERE id = ${id} FOR UPDATE`;
    if (!s) throw notFound('盘点不存在');
    if (s.status === 'closed') return;
    // 结束时记下结果：之后建卡、调拨、报废不改写这次盘点（Codex 审查 d8b314b）。锁住盘点一行以后再算，扫码已经停了（扫码要共享锁、核对没结束）
    const result = await liveResult(tx, id, s.departmentId === null ? null : Number(s.departmentId));
    await tx`UPDATE asset_stocktakes SET status = 'closed', closed_by = ${actor.id}, closed_at = now(), result = ${tx.json(result as never)} WHERE id = ${id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'asset_stocktake', targetType: 'asset_stocktake', targetId: id, detail: { op: 'close', docNo: s.docNo }, ip });
  });
  return getStocktake(deps.sql, id);
}

export function registerAssetRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const READ = guard('asset.read');
  const MANAGE = guard('asset.manage');
  app.get('/api/erp/assets', { preHandler: READ }, async (req) => listAssets(sql, req.query));
  app.get('/api/erp/assets/receipt-lines', { preHandler: MANAGE }, async (req) => {
    const { docNo } = parse(z.object({ docNo: z.string().trim().min(1, '请输入收货单号').max(40) }), req.query);
    return receiptLinesFor(sql, docNo);
  });
  app.get('/api/erp/assets/stocktakes', { preHandler: READ }, async () => listStocktakes(sql));
  app.get('/api/erp/assets/stocktakes/:id', { preHandler: READ }, async (req) => getStocktake(sql, parse(idParam, req.params).id));
  app.post('/api/erp/assets/stocktakes', { preHandler: MANAGE }, async (req, reply) => {
    const r = await startStocktake(deps, req.body, req.actor, req.ip);
    reply.code(201);
    return r;
  });
  app.post('/api/erp/assets/stocktakes/:id/scan', { preHandler: MANAGE }, async (req) => scanStocktake(deps, parse(idParam, req.params).id, req.body, req.actor));
  app.post('/api/erp/assets/stocktakes/:id/close', { preHandler: MANAGE }, async (req) => closeStocktake(deps, parse(idParam, req.params).id, req.actor, req.ip));
  app.get('/api/erp/assets/:id', { preHandler: READ }, async (req) => getAsset(sql, parse(idParam, req.params).id));
  app.post('/api/erp/assets', { preHandler: MANAGE }, async (req, reply) => {
    const r = await createAssets(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    const cards = [];
    for (const id of r.ids) cards.push(await getAsset(sql, id));
    return { card: cards[0], cards, replayed: r.replayed };
  });
  app.post('/api/erp/assets/:id/change', { preHandler: MANAGE }, async (req) => changeAsset(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
}
