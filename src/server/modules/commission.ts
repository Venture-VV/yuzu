// 技师提成（S6 第二步，v0.7.1）：提成规则按版本保存（只追加），每条技师明细按它所在结账单的结账时刻取当时有效的规则；
// 改规则只影响之后结账的钟，已经结了的钟照旧（反结账按原结账时刻的规则冲回，正负完全相抵）。
//
// 口径与技师业绩、部门构成相同：结账那一刻账单上的技师明细，时段内结账的计入、时段内反结账的冲回；
// 优惠 / 免单是结账的收款方式，技师照常提成（店里承担）；退钟、取消作废的明细不提成。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRICE_TIERS, type PriceTier } from '@shared/catalog';
import { DEFAULT_COMMISSION_RULES, lineCommission, MAX_RATE_BP, type CommissionRules, type CommissionSettings, type CommissionVersion } from '@shared/clockroom';
import type { CallType } from '@shared/technicians';
import type { Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { badRequest } from '../lib/errors';
import { cents, parse } from '../lib/validate';

interface VersionRow {
  id: number;
  rules: CommissionRules;
  effectiveAt: string;
  note: string;
  createdByName: string | null;
}

async function versions(db: Db): Promise<VersionRow[]> {
  return db<VersionRow[]>`
    SELECT v.id, v.rules, v.effective_at, v.note, s.display_name AS created_by_name
    FROM commission_rule_versions v LEFT JOIN staff s ON s.id = v.created_by ORDER BY v.effective_at, v.id`;
}

const normalize = (r: Partial<CommissionRules> | null | undefined): CommissionRules => ({ ...DEFAULT_COMMISSION_RULES, ...(r ?? {}), items: { ...(r?.items ?? {}) } });

/** 某一时刻有效的规则：最后一个生效时间不晚于它的版本；还没有保存过任何版本时为默认规则 */
export function rulesAt(list: VersionRow[], at: Date): { rules: CommissionRules; versionId: number | null } {
  let pick: VersionRow | undefined;
  for (const v of list) if (new Date(v.effectiveAt).getTime() <= at.getTime()) pick = v;
  return pick ? { rules: normalize(pick.rules), versionId: pick.id } : { rules: DEFAULT_COMMISSION_RULES, versionId: null };
}

export async function commissionSettings(db: Db): Promise<CommissionSettings> {
  const list = await versions(db);
  const toVersion = (v: VersionRow): CommissionVersion => ({
    id: v.id,
    rules: normalize(v.rules),
    effectiveAt: new Date(v.effectiveAt).toISOString(),
    note: v.note,
    createdByName: v.createdByName,
  });
  const latest = list.at(-1);
  return {
    current: latest ? toVersion(latest) : { id: null, rules: DEFAULT_COMMISSION_RULES, effectiveAt: null, note: '默认规则（待确认）', createdByName: null },
    history: list.slice(-20).reverse().map(toVersion),
  };
}

export interface CommissionLine {
  sign: 1 | -1;
  checkoutId: number;
  checkoutNo: string;
  checkoutAt: string;
  businessDate: string;
  tagCode: string;
  technicianId: number;
  itemId: number | null;
  name: string;
  tier: PriceTier | null;
  quantity: number;
  amount: number;
  callType: CallType;
}

/** 时段内结账（计正数）与反结账（计负数）的技师明细，结账那一刻账单上的（与部门构成同一口径） */
export async function settledTechnicianLines(db: Db, from: string, to: string): Promise<CommissionLine[]> {
  return db<CommissionLine[]>`
    WITH k AS (
      SELECT id, checkout_no, created_at, business_date, 1 AS sign FROM checkouts WHERE business_date BETWEEN ${from} AND ${to}
      UNION ALL
      SELECT id, checkout_no, created_at, void_business_date, -1 FROM checkouts WHERE void_business_date BETWEEN ${from} AND ${to}
    )
    SELECT k.sign, k.id AS checkout_id, k.checkout_no, k.created_at AS checkout_at, k.business_date::text AS business_date,
           h.code AS tag_code, l.technician_id, l.item_id, l.name, l.tier, l.quantity, l.amount, l.call_type
    FROM k JOIN checkout_bills cb ON cb.checkout_id = k.id
    JOIN bill_lines l ON l.bill_id = cb.bill_id AND l.posted_at <= k.created_at AND (l.voided_at IS NULL OR l.voided_at > k.created_at)
    JOIN visits v ON v.id = cb.visit_id JOIN hand_tags h ON h.id = v.tag_id
    WHERE l.technician_id IS NOT NULL
    ORDER BY k.created_at, k.id, l.id`;
}

/** 每条明细的提成（按结账时刻的规则；冲回的取同一规则再取负数） */
export async function withCommission(db: Db, lines: CommissionLine[]) {
  const list = await versions(db);
  return lines.map((l) => {
    const { rules, versionId } = rulesAt(list, new Date(l.checkoutAt));
    const c = lineCommission(rules, { itemId: l.itemId, tier: l.tier, quantity: l.quantity, amount: l.amount, callType: l.callType });
    return { ...l, versionId, base: l.sign * c.base, bonus: l.sign * c.bonus };
  });
}

const baseInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), rateBp: z.number().int('比例最多两位小数').min(0, '比例不能为负').max(MAX_RATE_BP, '比例不能超过 100%') }),
  z.object({
    kind: z.literal('fixed'),
    perClock: z
      .object({ standard: cents('每钟金额').max(1_000_000).optional(), professional: cents('每钟金额').max(1_000_000).optional(), premium: cents('每钟金额').max(1_000_000).optional() })
      .refine((p) => PRICE_TIERS.some((t) => p[t] !== undefined), '每钟固定金额请至少填一档'),
  }),
]);

export const CommissionInput = z.object({
  rules: z.object({
    base: baseInput,
    designatedBonus: cents('点钟奖励').max(1_000_000, '点钟奖励过大'),
    items: z.record(z.string().regex(/^\d+$/, '项目编号不正确'), baseInput).default({}),
  }),
  note: z.string().trim().max(100, '说明最多 100 字').default(''),
});

export function registerCommissionRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/admin/technicians/commission', { preHandler: guardAny('settings.manage', 'report.commission') }, async () => commissionSettings(sql));

  // 保存即新增一个版本，立即生效（之后结账的钟按新规则）；旧版本保留，可在历史里看
  app.put('/api/admin/technicians/commission', { preHandler: guard('settings.manage') }, async (req) => {
    const { rules, note } = parse(CommissionInput, req.body);
    const itemIds = Object.keys(rules.items).map(Number);
    if (itemIds.length) {
      const found = await sql<{ id: number }[]>`SELECT id FROM service_items WHERE id IN ${sql(itemIds)}`;
      if (found.length !== itemIds.length) throw badRequest('有项目不存在，请刷新后重试');
    }
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('settings'))`;
      const before = (await commissionSettings(tx)).current.rules;
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO commission_rule_versions (rules, note, created_by) VALUES (${tx.json(rules as never)}, ${note}, ${req.actor.id}) RETURNING id`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'settings_updated',
        targetType: 'settings',
        targetId: row!.id,
        detail: { key: 'commission_rules', before, after: rules, note },
        ip: req.ip,
      });
    });
    return commissionSettings(sql);
  });
}
