// 8.0.20 用料与配方、销售与出品扣库存（docs/ERP_V8020.md 第 2 节，JX-A / JX-B；迁移 128）。
//
// · 价目项目的用料 item_recipes（零售品就是只有一行的配方），带版本：改用料 = 旧的停用、写一份新的；
// · 结账（不进厨房的明细）、出品（进厨房的明细）时只往 stock_usage_events 追加一行，不碰库存的锁；冲回是一条 sign = -1 的；
// · 每分钟的任务 processStockUsage 按「种类 + 仓 + 物料」轧差：净数大于 0 且库存够的合成一张耗用单（一轮一个仓一张），
//   净数为 0 的记成已轧平，净数为负的留着等后面的正数来抵；库存不够的那样物料先不扣、留着（待扣料）。
//
// 锁与幂等：
// · 记事件在结账 / 出品事务的末尾，只插入；结账单一行、出品单一行调用方已经锁住，同一来源的事件是串行的，部分唯一索引兜底。
// · 改用料先取「项目用料」的咨询锁（同一个项目串行），带页面看到的版本号，对不上拒绝（RECIPE_CHANGED）；同一项目同时只有一份在用靠部分唯一索引。
// · 任务先取「扣料任务」的咨询锁（会话级，同一时刻只有一个在跑）；批次带自己的操作编号开耗用单（库存单据原来的锁），
//   开了单没记下结果的下一轮按操作编号对账：已经开出来的认下，没开的放回去重来。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_DINING_RULES } from '@shared/dining';
import { CENTRAL_WAREHOUSE_ID } from '@shared/inventory';
import { can } from '@shared/permissions';
import { fitsDecimals } from '@shared/quantity';
import {
  DEFAULT_STOCK_USAGE_RULES,
  STOCK_USAGE_KIND_LABELS,
  usageMilli,
  type ItemRecipe,
  type PendingUsage,
  type RecipeLine,
  type StockUsageKind,
  type StockUsageOverview,
  type StockUsageRules,
  type UsageBatch,
} from '@shared/stock-usage';
import { guard } from '../auth/guard';
import { readSnapshot, type Db, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Actor, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { saveRuleSetting } from '../lib/rule-settings';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { moveCostCents, todayIn } from './inventory/common';
import { createDoc } from './inventory/docs';
import { systemStockActor } from './system-staff';

const KEY = 'stock_usage_rules';

export async function loadStockUsageRules(db: Db): Promise<StockUsageRules> {
  const [row] = await db<{ value: Partial<StockUsageRules> }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  return { ...DEFAULT_STOCK_USAGE_RULES, ...(row?.value ?? {}) };
}

const RulesInput = z.object({
  enabled: z.boolean('请选择开还是关'),
  saleWarehouseId: z.number().int().positive(),
  recipeWarehouseId: z.number().int().positive(),
});

// ───────────────────────── 用料 ─────────────────────────

const canSeeCost = (actor: Actor) => can(actor, 'inventory.cost');

/** 全部价目项目与它在用的用料（没设的 version = 0） */
export async function listRecipes(db: Db, actor: Actor): Promise<ItemRecipe[]> {
  // 餐饮开没开（不从 dining 模块引，它要反过来引这里记扣料）
  const [dr] = await db<{ value: { enabled?: boolean } }[]>`SELECT value FROM settings WHERE key = 'dining_rules'`;
  const dining = { enabled: dr?.value?.enabled ?? DEFAULT_DINING_RULES.enabled };
  const cost = canSeeCost(actor);
  const items = await db<
    { id: number; name: string; category: string; price: number; active: boolean; kitchen: boolean; recipeId: number | null; version: number | null; warehouseId: number | null; note: string | null; createdAt: string | null; createdBy: string | null }[]
  >`
    SELECT i.id, i.name, i.category, i.price, i.active,
           (i.station_id IS NOT NULL AND NOT i.technician_required AND COALESCE(ks.active, false)) AS kitchen,
           r.id AS recipe_id, r.version, r.warehouse_id, r.note, r.created_at, st.display_name AS created_by
    FROM service_items i
    LEFT JOIN kitchen_stations ks ON ks.id = i.station_id
    LEFT JOIN item_recipes r ON r.item_id = i.id AND r.status = 'active'
    LEFT JOIN staff st ON st.id = r.created_by
    ORDER BY (r.id IS NULL), i.category, i.sort_order, i.id`;
  const recipeIds = items.map((i) => i.recipeId).filter((x): x is number => x !== null);
  type LineRow = { recipeId: number; materialId: number; code: string; name: string; inventoryUnit: string; decimals: number; qtyMilli: number; lossBp: number; avgCostE4: number; costKnown: boolean };
  const lines: LineRow[] = recipeIds.length
    ? await db<LineRow[]>`
        SELECT l.recipe_id, l.material_id, m.code, m.name, m.inventory_unit, m.decimals, l.qty_milli, l.loss_bp,
               -- 还没有成本的物料（平均成本是 0 而且还是估的）按参考价起算，与入库时的起算一样；成本真的是 0 的就是 0
               (CASE WHEN m.avg_cost_e4 > 0 OR NOT m.cost_estimated THEN m.avg_cost_e4
                     WHEN m.ref_price_cents IS NOT NULL AND m.purchase_factor_milli > 0 THEN round(m.ref_price_cents::numeric * 10000000 / m.purchase_factor_milli)
                     ELSE 0 END)::bigint AS avg_cost_e4,
               (m.avg_cost_e4 > 0 OR NOT m.cost_estimated OR (m.ref_price_cents IS NOT NULL AND m.purchase_factor_milli > 0)) AS cost_known
        FROM item_recipe_lines l JOIN materials m ON m.id = l.material_id WHERE l.recipe_id IN ${db(recipeIds)} ORDER BY l.id`
    : [];
  const byRecipe = new Map<number, LineRow[]>();
  for (const l of lines) byRecipe.set(Number(l.recipeId), [...(byRecipe.get(Number(l.recipeId)) ?? []), l]);
  return items.map((i) => {
    const own = i.recipeId === null ? [] : (byRecipe.get(Number(i.recipeId)) ?? []);
    const recipeLines: RecipeLine[] = own.map((l) => ({
      materialId: Number(l.materialId),
      materialCode: l.code,
      materialName: l.name,
      inventoryUnit: l.inventoryUnit,
      decimals: l.decimals,
      qtyMilli: Number(l.qtyMilli),
      lossBp: l.lossBp,
      avgCostE4: cost ? Number(l.avgCostE4) : null,
    }));
    // 一份的理论成本：各样用料（含损耗，按物料的小数位向上取整——与卖一份实际扣的一样）× 现在的平均成本；有物料还没有成本的不给数
    const complete = own.length > 0 && own.every((l) => l.costKnown);
    const unitCostCents = cost && complete ? own.reduce((sum, l) => sum + moveCostCents(usageMilli(Number(l.qtyMilli), 1, l.lossBp, l.decimals), Number(l.avgCostE4)), 0) : null;
    return {
      itemId: Number(i.id),
      itemName: i.name,
      category: i.category,
      price: Number(i.price),
      active: i.active,
      kitchen: dining.enabled && i.kitchen,
      version: i.version ?? 0,
      warehouseId: i.warehouseId === null ? null : Number(i.warehouseId),
      note: i.note ?? '',
      lines: recipeLines,
      unitCostCents,
      updatedAt: i.createdAt ? new Date(i.createdAt).toISOString() : null,
      updatedBy: i.createdBy,
    };
  });
}

const RecipeInput = z.object({
  /** 页面看到的版本（没设过 = 0）；对不上拒绝 */
  expectedVersion: z.number().int().min(0),
  warehouseId: z.number().int().positive().nullable().default(null),
  note: z.string().trim().max(100, '备注最多 100 个字').default(''),
  /** 空 = 不再扣（停用现在这一份） */
  lines: z
    .array(
      z.object({
        materialId: z.number().int().positive(),
        qtyMilli: z.number().int().min(1, '用量要大于 0').max(1_000_000_000),
        lossBp: z.number().int().min(0).max(5000, '损耗率最多 50%').default(0),
      }),
    )
    .max(30, '一个项目最多 30 样用料'),
});

/** 改一个项目的用料：旧的停用、写一份新版本（已经发生的扣料不回头改） */
export async function saveRecipe(deps: Deps, itemId: number, raw: unknown, ctx: OpContext): Promise<{ version: number }> {
  const input = parse(RecipeInput, raw);
  const ids = input.lines.map((l) => l.materialId);
  if (new Set(ids).size !== ids.length) throw badRequest('同一样物料只能出现一次');
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`item_recipe:${itemId}`}, 0))`;
    const [item] = await tx<{ id: number; name: string }[]>`SELECT id, name FROM service_items WHERE id = ${itemId}`;
    if (!item) throw notFound('项目不存在');
    const [cur] = await tx<{ id: number; version: number }[]>`SELECT id, version FROM item_recipes WHERE item_id = ${itemId} AND status = 'active'`;
    if ((cur?.version ?? 0) !== input.expectedVersion) throw conflict('RECIPE_CHANGED', '这个项目的用料刚刚被别人改过，请刷新后再改');
    if (!cur && input.lines.length === 0) throw badRequest('请至少添加一样用料');
    if (input.lines.length) {
      const mats = await tx<{ id: number; name: string; decimals: number; inventoryUnit: string; active: boolean; tracked: boolean }[]>`
        SELECT id, name, decimals, inventory_unit, active, tracked FROM materials WHERE id IN ${tx(ids)}`;
      const byId = new Map(mats.map((m) => [Number(m.id), m]));
      for (const l of input.lines) {
        const m = byId.get(l.materialId);
        if (!m) throw unprocessable('MATERIAL_NOT_FOUND', '有物料不存在，请刷新后重试');
        if (!m.active) throw unprocessable('MATERIAL_INACTIVE', `物料「${m.name}」已停用，不能设成用料`);
        if (!m.tracked) throw unprocessable('MATERIAL_UNTRACKED', `物料「${m.name}」不管库存，不能设成用料`);
        if (!fitsDecimals(l.qtyMilli, m.decimals)) throw badRequest(`「${m.name}」的用量最多 ${m.decimals} 位小数（单位：${m.inventoryUnit}）`);
      }
      if (input.warehouseId !== null) {
        const [wh] = await tx<{ id: number }[]>`
          SELECT w.id FROM warehouses w LEFT JOIN departments d ON d.id = w.department_id WHERE w.id = ${input.warehouseId} AND (w.department_id IS NULL OR d.active)`;
        if (!wh) throw unprocessable('WAREHOUSE_INVALID', '选的仓不存在或它的部门已停用');
      }
    }
    const [max] = await tx<{ v: number | null }[]>`SELECT max(version) AS v FROM item_recipes WHERE item_id = ${itemId}`;
    if (cur) await tx`UPDATE item_recipes SET status = 'retired', retired_by = ${ctx.actor.id}, retired_at = now() WHERE id = ${cur.id}`;
    let version = 0;
    if (input.lines.length) {
      version = (max?.v ?? 0) + 1;
      const [made] = await tx<{ id: number }[]>`
        INSERT INTO item_recipes (item_id, version, warehouse_id, note, created_by)
        VALUES (${itemId}, ${version}, ${input.warehouseId}, ${input.note}, ${ctx.actor.id}) RETURNING id`;
      for (const l of input.lines) {
        await tx`INSERT INTO item_recipe_lines (recipe_id, material_id, qty_milli, loss_bp) VALUES (${made!.id}, ${l.materialId}, ${l.qtyMilli}, ${l.lossBp})`;
      }
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'item_recipe',
      targetType: 'service_item',
      targetId: itemId,
      detail: { item: item.name, from: cur?.version ?? 0, to: version, lines: input.lines, warehouseId: input.warehouseId },
      ip: ctx.ip,
    });
    return { version };
  });
}

// ───────────────────────── 记扣料事件（在业务事务里） ─────────────────────────

/** 一份用量 × 份数 ×（1 + 损耗率），按物料的小数位向上取整（与 @shared/stock-usage 的 usageMilli 同一个算法） */
const usageSql = (tx: Tx) => tx`
  (ceil(ceil(rl.qty_milli::numeric * src.quantity * (10000 + rl.loss_bp) / 10000) / power(10, 3 - m.decimals)) * power(10, 3 - m.decimals))::bigint`;

/**
 * 结账生效时（结账单、账单、明细调用方已锁）：这几张账单上有效的、**不进厨房**的明细按用料记「该扣多少」。
 * 进厨房的明细出品时已经记过，不重复。没设用料的项目不记。规则关着时不记。
 */
export async function recordSaleUsage(tx: Tx, checkoutId: number, billIds: number[], date: string): Promise<number> {
  if (billIds.length === 0) return 0;
  const rules = await loadStockUsageRules(tx);
  if (!rules.enabled) return 0;
  const rows = await tx`
    INSERT INTO stock_usage_events (kind, sign, checkout_id, bill_line_id, item_id, item_name, quantity, recipe_id, material_id, warehouse_id, qty_milli, business_date)
    SELECT 'sale', 1, ${checkoutId}, src.id, src.item_id, src.name, src.quantity, r.id, rl.material_id, COALESCE(r.warehouse_id, ${rules.saleWarehouseId}), ${usageSql(tx)}, ${date}
    FROM bill_lines src
    JOIN item_recipes r ON r.item_id = src.item_id AND r.status = 'active'
    JOIN item_recipe_lines rl ON rl.recipe_id = r.id
    JOIN materials m ON m.id = rl.material_id
    WHERE src.bill_id IN ${tx(billIds)} AND src.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM kitchen_items k WHERE k.bill_line_id = src.id)
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return rows.length;
}

/** 反结账（结账单调用方已锁）：这张结账单记过的、还没冲回的，各记一条冲回 */
export async function reverseSaleUsage(tx: Tx, checkoutId: number): Promise<number> {
  return reverse(tx, tx`checkout_id = ${checkoutId} AND kind = 'sale'`);
}

/**
 * 出品完成时（出品单一行调用方已锁；补录的一建就是已上桌，建单时调）：按用料记「该扣多少」。
 * 同一张出品单撤回后再完成，是冲回一条、再记一条。
 */
export async function recordRecipeUsage(tx: Tx, kitchenItemIds: number[]): Promise<number> {
  if (kitchenItemIds.length === 0) return 0;
  const rules = await loadStockUsageRules(tx);
  if (!rules.enabled) return 0;
  const rows = await tx`
    INSERT INTO stock_usage_events (kind, sign, kitchen_item_id, bill_line_id, item_id, item_name, quantity, recipe_id, material_id, warehouse_id, qty_milli, business_date)
    SELECT 'recipe', 1, src.id, src.bill_line_id, src.item_id, i.name, src.quantity, r.id, rl.material_id, COALESCE(r.warehouse_id, ${rules.recipeWarehouseId}), ${usageSql(tx)}, src.business_date
    FROM kitchen_items src
    JOIN service_items i ON i.id = src.item_id
    JOIN item_recipes r ON r.item_id = src.item_id AND r.status = 'active'
    JOIN item_recipe_lines rl ON rl.recipe_id = r.id
    JOIN materials m ON m.id = rl.material_id
    WHERE src.id IN ${tx(kitchenItemIds)}
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return rows.length;
}

/** 撤回出品（出品单一行调用方已锁） */
export async function reverseRecipeUsage(tx: Tx, kitchenItemId: number): Promise<number> {
  return reverse(tx, tx`kitchen_item_id = ${kitchenItemId} AND kind = 'recipe'`);
}

async function reverse(tx: Tx, where: ReturnType<Tx>): Promise<number> {
  const rows = await tx`
    WITH orig AS (
      UPDATE stock_usage_events SET reversed_at = now() WHERE ${where} AND sign = 1 AND reversed_at IS NULL RETURNING *
    )
    INSERT INTO stock_usage_events (kind, sign, checkout_id, kitchen_item_id, bill_line_id, reverses_id, item_id, item_name, quantity, recipe_id, material_id, warehouse_id, qty_milli, business_date)
    SELECT kind, -1, checkout_id, kitchen_item_id, bill_line_id, id, item_id, item_name, quantity, recipe_id, material_id, warehouse_id, qty_milli, business_date FROM orig
    RETURNING id`;
  return rows.length;
}

// ───────────────────────── 每分钟：轧差、开耗用单 ─────────────────────────

const JOB_LOCK = 'stock_usage_job';
/** 一张耗用单最多几样物料（库存单据一张最多 100 行，留余量） */
const BATCH_MAX_LINES = 60;

export interface StockUsageRun {
  /** 开出来的耗用单 */
  docs: number;
  /** 这一轮扣掉的物料行数 */
  lines: number;
  /** 库存不够、留着没扣的物料数 */
  blocked: number;
  /** 上一轮没记下结果、这一轮对上账的批次 */
  reconciled: number;
  /** 开单出错放回去的批次 */
  released: number;
}

/**
 * 把还没入账的扣料事件轧差后开成耗用单。同一时刻只有一个在跑（会话级咨询锁，拿不到直接返回）。
 * 每一个「种类 + 仓」一轮最多一张单；库存不够的物料留着，库存补上以后自动扣。
 */
export async function processStockUsage(deps: Pick<Deps, 'sql' | 'config'>): Promise<StockUsageRun> {
  const { sql, config } = deps;
  const run: StockUsageRun = { docs: 0, lines: 0, blocked: 0, reconciled: 0, released: 0 };
  const lockConn = await sql.reserve();
  try {
    const [got] = await lockConn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended(${JOB_LOCK}, 0)) AS ok`;
    if (!got?.ok) return run;
    try {
      await reconcileBatches(sql, run);
      const groups = await sql<{ kind: StockUsageKind; warehouseId: number }[]>`
        SELECT DISTINCT kind, warehouse_id FROM stock_usage_events WHERE state = 'pending' ORDER BY kind, warehouse_id`;
      if (groups.length === 0) return run;
      const actor = await systemStockActor(sql);
      for (const g of groups) await postGroup(deps, g.kind, Number(g.warehouseId), actor, todayIn(config.timezone), run);
    } finally {
      await lockConn`SELECT pg_advisory_unlock(hashtextextended(${JOB_LOCK}, 0))`;
    }
  } finally {
    lockConn.release();
  }
  return run;
}

/** 上一轮开了单没记下结果的批次：按操作编号对账——单已经生效的认下，没有的把事件放回去 */
async function reconcileBatches(sql: Deps['sql'], run: StockUsageRun) {
  const stuck = await sql<{ id: number; clientKey: string }[]>`SELECT id, client_key FROM stock_usage_batches WHERE status = 'posting' ORDER BY id`;
  for (const b of stuck) {
    const [doc] = await sql<{ id: number; status: string }[]>`SELECT id, status FROM inv_docs WHERE client_key = ${b.clientKey}`;
    if (doc?.status === 'confirmed') {
      await finishBatch(sql, Number(b.id), Number(doc.id));
      run.reconciled += 1;
    } else {
      await releaseBatch(sql, Number(b.id), doc ? `耗用单是「${doc.status}」，没有生效` : '耗用单没有开出来');
      run.released += 1;
    }
  }
}

async function finishBatch(sql: Deps['sql'], batchId: number, docId: number) {
  await sql.begin(async (tx) => {
    await tx`UPDATE stock_usage_batches SET status = 'done', inv_doc_id = ${docId}, finished_at = now(), error = NULL WHERE id = ${batchId} AND status = 'posting'`;
    await tx`UPDATE stock_usage_events SET state = 'batched', blocked_at = NULL WHERE batch_id = ${batchId}`;
  });
}

async function releaseBatch(sql: Deps['sql'], batchId: number, error: string) {
  await sql.begin(async (tx) => {
    await tx`UPDATE stock_usage_batches SET status = 'released', finished_at = now(), error = ${error.slice(0, 250)} WHERE id = ${batchId} AND status = 'posting'`;
    await tx`UPDATE stock_usage_events SET state = 'pending', batch_id = NULL WHERE batch_id = ${batchId}`;
  });
}

async function postGroup(deps: Pick<Deps, 'sql' | 'config'>, kind: StockUsageKind, warehouseId: number, actor: Actor, docDate: string, run: StockUsageRun) {
  const { sql } = deps;
  // 1. 认领：在一个事务里算净数、定下这一批带哪些事件（之后新来的事件留到下一轮）
  //    不用给事件加锁：改处理状态的只有这个任务（咨询锁保证同一时刻一个），业务事务只插入新行
  const claimed = await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const nets = await tx<{ materialId: number; net: number; ids: number[]; name: string; stock: number; usable: boolean }[]>`
      SELECT e.material_id, sum(e.sign * e.qty_milli)::bigint AS net, array_agg(e.id ORDER BY e.id) AS ids, m.name, (m.active AND m.tracked) AS usable,
             (CASE WHEN ${warehouseId} = ${CENTRAL_WAREHOUSE_ID} THEN m.stock_milli
                   ELSE COALESCE((SELECT ws.stock_milli FROM warehouse_stock ws WHERE ws.warehouse_id = ${warehouseId} AND ws.material_id = e.material_id), 0) END)::bigint AS stock
      FROM stock_usage_events e JOIN materials m ON m.id = e.material_id
      WHERE e.state = 'pending' AND e.kind = ${kind} AND e.warehouse_id = ${warehouseId}
      GROUP BY e.material_id, m.name, m.stock_milli, m.active, m.tracked ORDER BY e.material_id`;
    const lines: { materialId: number; qtyMilli: number; ids: number[] }[] = [];
    for (const n of nets) {
      const net = Number(n.net);
      const ids = n.ids.map(Number);
      if (net === 0) {
        // 正的与冲回的正好抵掉：不用出库
        await tx`UPDATE stock_usage_events SET state = 'netted', blocked_at = NULL WHERE id IN ${tx(ids)}`;
      } else if (net > 0) {
        if (!n.usable || Number(n.stock) < net) {
          // 库存不够：这样物料先不扣，留着（待扣料里看得到），库存补上后自动扣。
          // 记下事件以后物料被停用了（或退回成候选）的也留着、不进这一批：耗用单不收停用的物料，带上它整张单开不出来，
          // 同一个仓别的物料会跟着一直扣不了（合并前 Codex 审查 35d8b16）；重新启用以后自动扣
          await tx`UPDATE stock_usage_events SET blocked_at = COALESCE(blocked_at, now()) WHERE id IN ${tx(ids)}`;
          run.blocked += 1;
        } else if (lines.length < BATCH_MAX_LINES) lines.push({ materialId: Number(n.materialId), qtyMilli: net, ids });
      }
      // net < 0：冲回的比扣的多，留着等后面的正数来抵
    }
    if (lines.length === 0) return null;
    const [batch] = await tx<{ id: number; clientKey: string }[]>`
      INSERT INTO stock_usage_batches (kind, warehouse_id, doc_date, line_count) VALUES (${kind}, ${warehouseId}, ${docDate}, ${lines.length}) RETURNING id, client_key`;
    await tx`UPDATE stock_usage_events SET batch_id = ${batch!.id} WHERE id IN ${tx(lines.flatMap((l) => l.ids))}`;
    return { batchId: Number(batch!.id), clientKey: batch!.clientKey, lines };
  });
  if (!claimed) return;
  // 2. 开耗用单（库存单据原来的事务与锁）；批次的操作编号就是单据的操作编号，重来不会开两张
  try {
    const { doc } = await createDoc(
      deps as Deps,
      {
        clientKey: claimed.clientKey,
        action: 'submit',
        approveNow: false,
        docType: 'direct_use',
        docDate,
        warehouseId,
        // 用途留空（「用途」只能从门店自己维护的清单里选，自动生成的耗用不带）；是哪一种看说明与批次
        purpose: null,
        note: `${STOCK_USAGE_KIND_LABELS[kind]}（自动扣料第 ${claimed.batchId} 批）`,
        lines: claimed.lines.map((l) => ({ materialId: l.materialId, qtyMilli: l.qtyMilli, note: '' })),
      },
      actor,
    );
    if (doc.status !== 'confirmed') throw new Error(`耗用单 ${doc.docNo} 是「${doc.status}」，没有生效`);
    await finishBatch(sql, claimed.batchId, doc.id);
    run.docs += 1;
    run.lines += claimed.lines.length;
  } catch (error) {
    // 开单失败（多半是这一刻库存又不够了）：单没有开出来才放回去；说不清的留给下一轮按操作编号对账
    const [doc] = await sql<{ id: number; status: string }[]>`SELECT id, status FROM inv_docs WHERE client_key = ${claimed.clientKey}`;
    if (doc?.status === 'confirmed') {
      await finishBatch(sql, claimed.batchId, Number(doc.id));
      run.docs += 1;
      run.lines += claimed.lines.length;
    } else {
      await releaseBatch(sql, claimed.batchId, error instanceof Error ? error.message : String(error));
      run.released += 1;
    }
  }
}

// ───────────────────────── 待扣料、最近的批次 ─────────────────────────

export async function stockUsageOverview(db: Db, actor: Actor): Promise<StockUsageOverview> {
  const pending = await db<Record<string, unknown>[]>`
    SELECT e.kind, e.warehouse_id, COALESCE(d.name, '总仓') AS warehouse_name, e.material_id, m.code, m.name, m.inventory_unit,
           sum(e.sign * e.qty_milli)::bigint AS net, count(*)::int AS events, min(e.created_at) AS since, bool_or(e.blocked_at IS NOT NULL) AS blocked,
           NOT (m.active AND m.tracked) AS inactive,
           (CASE WHEN e.warehouse_id = ${CENTRAL_WAREHOUSE_ID} THEN m.stock_milli
                 ELSE COALESCE((SELECT ws.stock_milli FROM warehouse_stock ws WHERE ws.warehouse_id = e.warehouse_id AND ws.material_id = e.material_id), 0) END)::bigint AS stock
    FROM stock_usage_events e JOIN materials m ON m.id = e.material_id
    LEFT JOIN warehouses w ON w.id = e.warehouse_id LEFT JOIN departments d ON d.id = w.department_id
    WHERE e.state = 'pending'
    GROUP BY e.kind, e.warehouse_id, d.name, e.material_id, m.code, m.name, m.inventory_unit, m.stock_milli, m.active, m.tracked
    ORDER BY bool_or(e.blocked_at IS NOT NULL) DESC, min(e.created_at)`;
  const batches = await db<Record<string, unknown>[]>`
    SELECT b.id, b.kind, COALESCE(dp.name, '总仓') AS warehouse_name, b.status, b.inv_doc_id, d.doc_no, b.doc_date::text AS doc_date, b.line_count, b.error, b.created_at
    FROM stock_usage_batches b LEFT JOIN inv_docs d ON d.id = b.inv_doc_id
    LEFT JOIN warehouses w ON w.id = b.warehouse_id LEFT JOIN departments dp ON dp.id = w.department_id
    ORDER BY b.id DESC LIMIT 30`;
  return {
    rules: await loadStockUsageRules(db),
    pending: pending.map(
      (r): PendingUsage => ({
        kind: r.kind as StockUsageKind,
        warehouseId: Number(r.warehouseId),
        warehouseName: String(r.warehouseName),
        materialId: Number(r.materialId),
        materialCode: String(r.code),
        materialName: String(r.name),
        inventoryUnit: String(r.inventoryUnit),
        netMilli: Number(r.net),
        stockMilli: Number(r.stock),
        since: new Date(r.since as string).toISOString(),
        blocked: Boolean(r.blocked),
        inactive: Boolean(r.inactive),
        events: Number(r.events),
      }),
    ),
    batches: batches.map(
      (r): UsageBatch => ({
        id: Number(r.id),
        kind: r.kind as StockUsageKind,
        warehouseName: String(r.warehouseName),
        status: r.status as UsageBatch['status'],
        docId: r.invDocId === null ? null : Number(r.invDocId),
        docNo: (r.docNo as string | null) ?? null,
        docDate: String(r.docDate),
        lineCount: Number(r.lineCount),
        error: (r.error as string | null) ?? null,
        createdAt: new Date(r.createdAt as string).toISOString(),
      }),
    ),
    canEdit: can(actor, 'inventory.master'),
    canSeeCost: canSeeCost(actor),
  };
}

export function registerStockUsageRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/inventory/recipes', { preHandler: guard('inventory.read') }, async (req) => readSnapshot(sql, (tx) => listRecipes(tx, req.actor)));
  app.put('/api/inventory/recipes/:id', { preHandler: guard('inventory.master') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return saveRecipe(deps, id, req.body, ctxOf(req));
  });
  app.get('/api/inventory/usage', { preHandler: guard('inventory.read') }, async (req) => readSnapshot(sql, (tx) => stockUsageOverview(tx, req.actor)));
  app.put('/api/inventory/usage/rules', { preHandler: guard('purchase.rules') }, async (req) =>
    saveRuleSetting(
      sql,
      KEY,
      loadStockUsageRules,
      async (before, tx) => {
        const next = parse(RulesInput, { ...before, ...parse(RulesInput.partial(), req.body) });
        for (const id of new Set([next.saleWarehouseId, next.recipeWarehouseId])) {
          const [wh] = await tx<{ id: number }[]>`
            SELECT w.id FROM warehouses w LEFT JOIN departments d ON d.id = w.department_id WHERE w.id = ${id} AND (w.department_id IS NULL OR d.active)`;
          if (!wh) throw unprocessable('WAREHOUSE_INVALID', '选的仓不存在或它的部门已停用');
        }
        return next;
      },
      ctxOf(req),
    ),
  );
  /** 现在扣一次（不等下一分钟）：物资经办补了库存以后用 */
  app.post('/api/inventory/usage/run', { preHandler: guard('inventory.operate') }, async () => processStockUsage(deps));
}
