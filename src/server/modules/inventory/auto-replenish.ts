// 8.0.20 自动补货（docs/ERP_V8020.md 第 3 节，JX-D）：每天过了设定的时间，把补货建议里有供应商的行按供应商各建一张
// **采购单草稿**（系统经办，不提交）；人确认、改数量后自己提交，不要的撤掉。没有供应商的行只记个数。
//
// 幂等：一天一行 replenish_runs（主键是日期，先插入占住再干活）；同一时刻只有一个在跑（咨询锁）。
// 建好的草稿算在途，建议里不再出现那些物料——所以这一天重跑（上次中途断了，或页面上点「现在跑一次」）只补还没建的，不会多建。
// 不加业务锁：建草稿走采购单原来的事务；建议是只读快照。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../../auth/guard';
import { readSnapshot, type Db } from '../../db';
import { ctxOf, type Deps } from '../../lib/context';
import { clockIn, dateIn } from '../../lib/dates';
import { saveRuleSetting } from '../../lib/rule-settings';
import { parse } from '../../lib/validate';
import { enabledErpModules } from '../erp';
import { systemStockActor } from '../system-staff';
import { createPo } from './purchasing';
import { replenishSuggestions } from './replenish';

export interface AutoReplenishRules {
  enabled: boolean;
  /** 每天几点以后跑（门店时区，HH:MM） */
  time: string;
}
export const DEFAULT_AUTO_REPLENISH: AutoReplenishRules = { enabled: true, time: '05:30' };
const KEY = 'auto_replenish';
const RulesInput = z.object({ enabled: z.boolean('请选择开还是关'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间写成 05:30 这样') });

export async function loadAutoReplenish(db: Db): Promise<AutoReplenishRules> {
  const [row] = await db<{ value: Partial<AutoReplenishRules> }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  return { ...DEFAULT_AUTO_REPLENISH, ...(row?.value ?? {}) };
}

export interface AutoReplenishRun {
  date: string;
  status: 'running' | 'done' | 'failed';
  poIds: number[];
  poNos: string[];
  lineCount: number;
  skippedNoSupplier: number;
  error: string | null;
  createdAt: string;
}

const PO_MAX_LINES = 100;
const JOB_LOCK = 'auto_replenish_job';

/**
 * 每分钟调：开着、过了时间、今天还没跑过才干活。返回这一次的结果；不用跑返回 null。
 * force（页面上「现在跑一次」）：今天跑过也再跑——已经建过的草稿算在途，建议里不会再有那些物料，只补新出现的。
 */
export async function runAutoReplenish(deps: Pick<Deps, 'sql' | 'config'>, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<AutoReplenishRun | null> {
  const { sql, config } = deps;
  const rules = await loadAutoReplenish(sql);
  if (!rules.enabled && !opts.force) return null;
  const date = dateIn(now, config.timezone);
  if (!opts.force && clockIn(config.timezone, now) < rules.time) return null;
  if (!(await enabledErpModules(sql)).has('purchasing')) return null;
  // 同一时刻只有一个在跑（会话级咨询锁，拿不到直接返回）：两个一起跑会各建一份草稿
  const lockConn = await sql.reserve();
  try {
    const [got] = await lockConn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended(${JOB_LOCK}, 0)) AS ok`;
    if (!got?.ok) return null;
    try {
      // 占住今天这一行：已经跑完的不再跑（force 除外）；上次中途断了的接着跑——断之前建好的草稿已经算在途，不会重复
      const [claim] = await sql<{ poIds: number[]; lineCount: number }[]>`
        INSERT INTO replenish_runs (run_date) VALUES (${date})
        ON CONFLICT (run_date) DO UPDATE SET status = 'running', error = NULL WHERE replenish_runs.status <> 'done' OR ${opts.force ?? false}
        RETURNING po_ids, line_count`;
      if (!claim) return null;
      const actor = await systemStockActor(sql);
      const poIds = claim.poIds.map(Number);
      let lineCount = claim.lineCount;
      let skipped = 0;
      let error: string | null = null;
      try {
        const suggestions = await readSnapshot(sql, (tx) => replenishSuggestions(tx, config.timezone));
        for (const g of suggestions.groups) {
          if (!g.supplier) {
            skipped += g.lines.length;
            continue;
          }
          const lines = g.lines.filter((l) => l.suggestedPurchaseMilli > 0);
          for (let i = 0; i < lines.length; i += PO_MAX_LINES) {
            const chunk = lines.slice(i, i + PO_MAX_LINES);
            const made = await createPo(
              deps as Deps,
              {
                clientKey: randomUUID(),
                action: 'save',
                supplierId: g.supplier.id,
                orderDate: date,
                note: `自动补货 ${date}（草稿，确认数量后再提交）`,
                lines: chunk.map((l) => ({ materialId: l.materialId, purchaseQtyMilli: l.suggestedPurchaseMilli, priceCents: l.priceCents ?? 0 })),
              },
              actor,
            );
            poIds.push(Number((made as { po: { id: number } }).po.id));
            lineCount += chunk.length;
          }
        }
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 250);
      }
      await sql`
        UPDATE replenish_runs SET status = ${error ? 'failed' : 'done'}, po_ids = ${poIds}, line_count = ${lineCount}, skipped_no_supplier = ${skipped},
               error = ${error}, finished_at = now() WHERE run_date = ${date}`;
      return (await autoReplenishRuns(sql, 1))[0] ?? null;
    } finally {
      await lockConn`SELECT pg_advisory_unlock(hashtextextended(${JOB_LOCK}, 0))`;
    }
  } finally {
    lockConn.release();
  }
}

export async function autoReplenishRuns(db: Db, limit = 7): Promise<AutoReplenishRun[]> {
  const rows = await db<{ runDate: string; status: AutoReplenishRun['status']; poIds: number[]; lineCount: number; skippedNoSupplier: number; error: string | null; createdAt: string; poNos: string[] | null }[]>`
    SELECT r.run_date::text AS run_date, r.status, r.po_ids, r.line_count, r.skipped_no_supplier, r.error, r.created_at,
           (SELECT array_agg(p.doc_no ORDER BY p.id) FROM purchase_orders p WHERE p.id = ANY (r.po_ids)) AS po_nos
    FROM replenish_runs r ORDER BY r.run_date DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    date: r.runDate,
    status: r.status,
    poIds: r.poIds.map(Number),
    poNos: r.poNos ?? [],
    lineCount: r.lineCount,
    skippedNoSupplier: r.skippedNoSupplier,
    error: r.error,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

export function registerAutoReplenishRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/purchase-suggestions/auto', { preHandler: guard('inventory.read') }, async () =>
    readSnapshot(sql, async (tx) => ({ rules: await loadAutoReplenish(tx), runs: await autoReplenishRuns(tx) })),
  );
  app.put('/api/purchase-suggestions/auto/rules', { preHandler: guard('purchase.rules') }, async (req) =>
    saveRuleSetting(sql, KEY, loadAutoReplenish, (before) => parse(RulesInput, { ...before, ...parse(RulesInput.partial(), req.body) }), ctxOf(req)),
  );
  /** 现在跑一次（今天跑过也再跑：已经建过的草稿不会重复建，只补新出现的建议） */
  app.post('/api/purchase-suggestions/auto/run', { preHandler: guard('purchase.manage') }, async () => runAutoReplenish(deps, new Date(), { force: true }));
}
