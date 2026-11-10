// 本部门小仓（v0.7.11，飞书需求 RQ-002 第一步，见 docs/WAREHOUSES.md）：部门申购看本部门小仓的结存、签收仓库登记的领料、
// 本部门的期初、耗用、报损、盘点；财务成本岗（deptStock.audit）看所有部门，给部门盘点、登记耗用。
// 急采与补采购单 8.0.1 起收拢到采购（采购组整改 05，CG05）：部门只看给本部门买的急采，不能登记、补单。
// 部门的员工没有「查看库存与物资单据」，这组接口只给能看的部门的小仓，不含总仓的参考价与结存；
// 单据的登记、生效、冲销都走库存单据的同一套逻辑（docs.ts），权限在那里再按仓核对一次。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CENTRAL_WAREHOUSE_ID, INV_DOC_TYPES, ISSUE_SIGN_DUE_DAYS, type DeptStockMeta, type InvDoc } from '@shared/inventory';
import { shiftDate } from '@shared/labels';
import type { ConsumptionRecord } from '@shared/supply';
import { can } from '@shared/permissions';
import { readSnapshot, type Db } from '../../db';
import { guardAny } from '../../auth/guard';
import type { Actor, Deps } from '../../lib/context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { csvReply, toCsv } from '../../lib/csv';
import { checkDateRange, todayIn } from '../../lib/dates';
import { loadSettings } from '../settings';
import { idParam, parse } from '../../lib/validate';
import { actorDepartmentId, deptBalances, docDateSchema, loadInventorySettings } from './common';
import {
  assertCanOperate,
  cancelDoc,
  createDoc,
  getDoc,
  listDocs,
  refreshCountBook,
  signIssue,
  submitDoc,
  updateDoc,
  warehouseRef,
  type CreateDocInput,
  type DocBodyInput,
} from './docs';
import { deptStocktakeReminder } from './cycles';
import { warehouseStock } from './reports';

const anyDept = guardAny('deptStock.operate', 'deptStock.audit');

/** 能看所有部门：店主、财务成本岗 */
const seesAll = (actor: Actor) => actor.role === 'owner' || can(actor, 'deptStock.audit');

/** 当前账号能看的部门（在用的）：店主与成本岗是所有部门，部门申购只有自己所属的部门 */
export async function visibleDepartments(db: Db, actor: Actor): Promise<DeptStockMeta['departments']> {
  const all = seesAll(actor);
  const mine = all ? null : await actorDepartmentId(db, actor.id);
  if (!all && (mine === null || !can(actor, 'deptStock.operate'))) return [];
  return db<DeptStockMeta['departments']>`
    SELECT d.id, d.name, w.id AS warehouse_id FROM departments d JOIN warehouses w ON w.department_id = d.id
    WHERE d.active ${all ? db`` : db`AND d.id = ${mine}`}
    ORDER BY d.sort_order, d.id`;
}

async function assertVisibleDept(db: Db, actor: Actor, departmentId: number) {
  const d = (await visibleDepartments(db, actor)).find((x) => x.id === departmentId);
  if (!d) throw forbidden('只能看自己所属部门的小仓；员工档案里没有所属部门的，请店主在「员工」里设置');
  return d;
}

/** 单据要在能看的部门小仓里（领料、退回按部门那一头） */
async function assertVisibleDoc(db: Db, actor: Actor, docId: number) {
  const [row] = await db<{ kind: 'central' | 'department' | null; departmentId: number | null }[]>`
    SELECT w.kind, w.department_id FROM inv_docs d LEFT JOIN warehouses w ON w.id = d.warehouse_id WHERE d.id = ${docId}`;
  if (!row) throw notFound('单据不存在');
  if (row.kind !== 'department' || row.departmentId === null) throw forbidden('这张单据不在部门小仓');
  await assertVisibleDept(db, actor, row.departmentId);
}

/**
 * 给部门看的单据：行上的「当前结存」换成这个部门小仓的（领料单原来显示总仓的），去掉与全公司历史成交价的比较；
 * 部门的员工没有「查看库存」，不能借单据看到总仓结存与别的采购价格。
 */
async function deptSafeDoc(db: Db, doc: InvDoc): Promise<InvDoc> {
  const whId = doc.warehouse?.kind === 'department' ? doc.warehouse.id : null;
  const balances = whId ? await deptBalances(db, whId, doc.lines.map((l) => l.materialId)) : new Map<number, { stockMilli: number }>();
  return {
    ...doc,
    lines: doc.lines.map(({ compare: _compare, ...l }) => ({ ...l, stockMilli: balances.get(l.materialId)?.stockMilli ?? 0 })),
  };
}

/** 部门能登记的单据：本部门小仓的期初、耗用、报损、盘点（按采购单收货、领料、退回由仓库办理；急采 8.0.1 起由采购登记） */
const DEPT_DOC_TYPES = ['opening', 'direct_use', 'damage', 'count'] as const;
const DeptBodyHead = z.looseObject({
  docType: z
    .enum(INV_DOC_TYPES)
    .refine((t) => (DEPT_DOC_TYPES as readonly string[]).includes(t), '部门只能登记期初、耗用、报损、盘点；领料、退回由仓库登记，急采由采购在「采购 → 急采」登记'),
  warehouseId: z.number().int().positive().optional(),
  urgent: z.boolean().optional(),
  departmentId: z.number().int().positive().nullable().optional(),
});

async function assertDeptBody(db: Db, actor: Actor, raw: unknown) {
  const b = parse(DeptBodyHead, raw);
  if (!b.warehouseId || b.warehouseId === CENTRAL_WAREHOUSE_ID) throw badRequest('请选部门的小仓；总仓的单据由仓库登记');
  const wh = await warehouseRef(db, b.warehouseId);
  if (!wh || wh.departmentId === null) throw badRequest('请选部门的小仓');
  await assertVisibleDept(db, actor, wh.departmentId);
}

export async function deptStockMeta(db: Db, actor: Actor): Promise<DeptStockMeta> {
  const settings = await loadInventorySettings(db);
  return {
    departments: await visibleDepartments(db, actor),
    myDepartmentId: await actorDepartmentId(db, actor.id),
    canOperate: actor.role === 'owner' || can(actor, 'deptStock.operate'),
    canAudit: seesAll(actor),
    urgentCapCents: settings.urgentCapCents,
    signDueDays: ISSUE_SIGN_DUE_DAYS,
    approvalRules: settings.approvalRules,
    // 盘点大差异（v0.7.30，A8）：页面提示要写原因（部门看不到参考价，只按比例；服务端照两样核对）
    countBigPct: settings.countBigPct,
    countBigCents: settings.countBigCents,
    // 台面日耗品（v0.7.13）：部门小仓不登记它的期初、耗用、报损、盘点，急采照常（验收后即算耗用）
    materials: await db<DeptStockMeta['materials']>`
      SELECT id, code, name, category, specification, inventory_unit, decimals, purchase_unit, purchase_factor_milli, counter_use, weighed
      FROM materials WHERE active AND tracked ORDER BY code`,
    suppliers: await db<DeptStockMeta['suppliers']>`SELECT id, code, name FROM suppliers WHERE active ORDER BY code`,
    // 耗用的用途与经办人（8.0.7 2.3）
    purposes: (await loadSettings(db)).consumptionPurposes,
    staff: await db<DeptStockMeta['staff']>`SELECT id, display_name AS name FROM staff WHERE active ORDER BY display_name, id`,
  };
}

const ConsumptionQuery = z.object({
  from: docDateSchema.optional(),
  to: docDateSchema.optional(),
  purpose: z.string().trim().max(12).optional(),
  handlerId: z.coerce.number().int().positive().optional(),
});

/**
 * 部门的耗用记录（8.0.7 2.3）：这个部门小仓生效、冲销的耗用单，按行列出（用途、经办人、说明、物料、数量）；
 * 不给价格（部门的员工看不到采购价）。8.0.7 以前的耗用单用途、经办人为空。默认看近 31 天。
 */
export async function consumptionRecords(db: Db, warehouseId: number, timeZone: string, raw: unknown): Promise<ConsumptionRecord[]> {
  const q = parse(ConsumptionQuery, raw);
  const to = q.to ?? todayIn(timeZone);
  const from = q.from ?? shiftDate(to, -30);
  checkDateRange(from, to);
  const rows = await db<ConsumptionRecord[]>`
    SELECT d.id AS doc_id, d.doc_no, d.doc_date::text AS doc_date, dep.id AS department_id, dep.name AS department_name,
           d.use_purpose AS purpose, d.use_handler_id AS handler_id, h.display_name AS handler_name, d.note,
           m.code AS material_code, m.name AS material_name, m.inventory_unit, m.decimals, l.qty_milli AS quantity_milli, d.status
    FROM inv_docs d JOIN inv_doc_lines l ON l.doc_id = d.id JOIN materials m ON m.id = l.material_id
    JOIN warehouses w ON w.id = d.warehouse_id JOIN departments dep ON dep.id = w.department_id
    LEFT JOIN staff h ON h.id = d.use_handler_id
    WHERE d.doc_type = 'direct_use' AND d.warehouse_id = ${warehouseId} AND d.status IN ('confirmed', 'voided')
      AND d.doc_date BETWEEN ${from} AND ${to}
      ${q.purpose ? db`AND d.use_purpose = ${q.purpose}` : db``}
      ${q.handlerId ? db`AND d.use_handler_id = ${q.handlerId}` : db``}
    ORDER BY d.doc_date DESC, d.id DESC, l.line_no
    LIMIT 2000`;
  return rows.map((r) => ({
    ...r,
    docId: Number(r.docId),
    departmentId: Number(r.departmentId),
    handlerId: r.handlerId === null ? null : Number(r.handlerId),
    quantityMilli: Number(r.quantityMilli),
  }));
}

const DocsQuery = z.object({
  type: z.enum(INV_DOC_TYPES).optional(),
  status: z.string().max(32).optional(),
  from: docDateSchema.optional(),
  to: docDateSchema.optional(),
  unsigned: z.enum(['1']).optional(),
  urgent: z.enum(['1', '0']).optional(),
});

export function registerDeptStockRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const docId = (req: FastifyRequest) => parse(idParam, req.params).id;
  const visibleDoc = async (req: FastifyRequest) => {
    const id = docId(req);
    await assertVisibleDoc(sql, req.actor, id);
    return id;
  };

  app.get('/api/erp/dept-stock/meta', { preHandler: anyDept }, async (req) => readSnapshot(sql, (tx) => deptStockMeta(tx, req.actor)));

  app.get('/api/erp/dept-stock/:id/stock', { preHandler: anyDept }, async (req) => {
    const d = await assertVisibleDept(sql, req.actor, parse(idParam, req.params).id);
    return warehouseStock(sql, d.warehouseId, deps.config.timezone);
  });

  // 本月盘点提醒（#23，v0.7.13）：这个部门小仓月初有结存的物料本月盘到了几种
  app.get('/api/erp/dept-stock/:id/stocktake', { preHandler: anyDept }, async (req) => {
    const d = await assertVisibleDept(sql, req.actor, parse(idParam, req.params).id);
    return readSnapshot(sql, (tx) =>
      deptStocktakeReminder(tx, { id: d.warehouseId, name: `${d.name}小仓`, kind: 'department', departmentId: d.id }, deps.config.timezone),
    );
  });

  // 耗用记录（8.0.7 2.3）：按日期、用途、经办人筛，能导出
  app.get('/api/erp/dept-stock/:id/consumption', { preHandler: anyDept }, async (req) => {
    const d = await assertVisibleDept(sql, req.actor, parse(idParam, req.params).id);
    return consumptionRecords(sql, d.warehouseId, deps.config.timezone, req.query);
  });
  app.get('/api/erp/dept-stock/:id/consumption/export', { preHandler: anyDept }, async (req, reply) => {
    const d = await assertVisibleDept(sql, req.actor, parse(idParam, req.params).id);
    const rows = await consumptionRecords(sql, d.warehouseId, deps.config.timezone, req.query);
    const qty = (milli: number, decimals: number) => (milli / 1000).toFixed(decimals);
    const csv = toCsv([
      ['日期', '单号', '部门', '用途', '经办人', '说明', '物料编码', '物料', '数量', '单位', '状态'],
      ...rows.map((r) => [
        r.docDate,
        r.docNo,
        r.departmentName,
        r.purpose ?? '（v8.0.7 以前没记）',
        r.handlerName ?? '',
        r.note,
        r.materialCode,
        r.materialName,
        qty(r.quantityMilli, r.decimals),
        r.inventoryUnit,
        r.status === 'voided' ? '已冲销' : '已生效',
      ]),
    ]);
    return csvReply(reply, `耗用记录_${d.name}.csv`, csv);
  });

  app.get('/api/erp/dept-stock/:id/docs', { preHandler: anyDept }, async (req) => {
    const d = await assertVisibleDept(sql, req.actor, parse(idParam, req.params).id);
    const q = parse(DocsQuery, req.query);
    return listDocs(sql, {
      ...q,
      warehouseId: d.warehouseId,
      unsigned: q.unsigned === '1',
      urgent: q.urgent === undefined ? undefined : q.urgent === '1',
      limit: 100,
    });
  });

  app.get('/api/erp/dept-stock/docs/by-key/:key', { preHandler: anyDept }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid() }), req.params);
    const [row] = await sql<{ id: number }[]>`SELECT id FROM inv_docs WHERE client_key = ${key}`;
    if (!row) return { found: false };
    await assertVisibleDoc(sql, req.actor, row.id);
    return { found: true, doc: await deptSafeDoc(sql, await getDoc(sql, row.id, deps.config.timezone)) };
  });
  app.get('/api/erp/dept-stock/docs/:id', { preHandler: anyDept }, async (req): Promise<InvDoc> =>
    deptSafeDoc(sql, await getDoc(sql, await visibleDoc(req), deps.config.timezone)),
  );

  app.post('/api/erp/dept-stock/docs', { preHandler: anyDept }, async (req, reply) => {
    await assertDeptBody(sql, req.actor, req.body);
    const result = await createDoc(deps, req.body as CreateDocInput, req.actor, req.ip);
    reply.code(result.replayed ? 200 : 201);
    return { ...result, doc: await deptSafeDoc(sql, result.doc) };
  });
  app.put('/api/erp/dept-stock/docs/:id', { preHandler: anyDept }, async (req) => {
    const id = await visibleDoc(req);
    await assertDeptBody(sql, req.actor, req.body);
    return deptSafeDoc(sql, await updateDoc(deps, id, req.body as DocBodyInput, req.actor));
  });
  app.post('/api/erp/dept-stock/docs/:id/submit', { preHandler: anyDept }, async (req) => deptSafeDoc(sql, await submitDoc(deps, await visibleDoc(req), req.actor)));
  app.post('/api/erp/dept-stock/docs/:id/cancel', { preHandler: anyDept }, async (req) => {
    const id = await visibleDoc(req);
    const [row] = await sql<{ docType: InvDoc['docType']; warehouseId: number | null }[]>`SELECT doc_type, warehouse_id FROM inv_docs WHERE id = ${id}`;
    await assertCanOperate(sql, req.actor, row!.docType, await warehouseRef(sql, row!.warehouseId));
    return deptSafeDoc(sql, await cancelDoc(deps, id, req.body, req.actor));
  });
  app.post('/api/erp/dept-stock/docs/:id/refresh-book', { preHandler: anyDept }, async (req) => deptSafeDoc(sql, await refreshCountBook(deps, await visibleDoc(req), req.actor)));
  // #17 第二次验收：部门签收仓库登记的领料
  app.post('/api/erp/dept-stock/docs/:id/sign', { preHandler: anyDept }, async (req) => deptSafeDoc(sql, await signIssue(deps, await visibleDoc(req), req.body, req.actor)));
}
