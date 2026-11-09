// 营销成本测算（8.0.4 需求表 10、11，docs/MEMBERSHIP_V804.md 第 10 节，HY14、HY15）：口径见 @shared/marketing-cost。
// 只读、现算（一致的快照，不加锁），不写进日结、交班、对账包、营业数据与 ERP 的任何账；权限「营销成本测算」（有财务职责的账号没有）。
// 测算单价：服务类权益每登记一次按多少钱算，只在这一页改（marketing_cost_params，一项一行，写入是覆盖、重复提交结果相同），留审计。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { formatStoreCouponCode } from '@shared/coupons';
import { USAGE_GROUP_LABELS, USAGE_GROUPS } from '@shared/coupon-usage';
import { GIFT_OUT_STATUS_LABELS, type CostParam, type CouponCostRow, type GiftOutStatus, type MarketingCost } from '@shared/marketing-cost';
import type { MembershipRules } from '@shared/membership';
import { guard } from '../auth/guard';
import { readSnapshot, type Db } from '../db';
import { writeAudit } from '../lib/audit';
import { csvReply, toCsv } from '../lib/csv';
import { checkDateRange } from '../lib/dates';
import type { Deps } from '../lib/context';
import { badRequest, notFound } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { couponGroupKeys, rollUp, type CouponCell } from './coupon-usage';
import { loadMembershipRules } from './membership';

const Range = z.object({
  from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
});

/** 最多列几条赠品出库 */
const MAX_GIFT_ITEMS = 200;

type CostCell = CouponCell & { used: number; amount: number };

export async function marketingCost(db: Db, from: string, to: string, rules: MembershipRules): Promise<MarketingCost> {
  checkDateRange(from, to);
  // ① 券：这段时间、没反结账的结账单上的券抵扣（一张结账单最多一笔），按「券 × 发放方式 × 权益 × 会员档级」分到最细再合
  const cells = await db<CostCell[]>`
    SELECT c.template_id, i.kind AS source, g.benefit_id, m.grade, count(*)::int AS used, sum(p.amount)::bigint AS amount
    FROM checkout_payments p
    JOIN checkouts k ON k.id = p.checkout_id
    JOIN coupons c ON c.id = p.store_coupon_id
    JOIN coupon_issues i ON i.id = c.issue_id
    LEFT JOIN benefit_grants g ON g.coupon_issue_id = i.id
    LEFT JOIN members m ON m.id = c.member_id
    WHERE p.method = 'store_coupon' AND k.status = 'completed' AND k.business_date BETWEEN ${from} AND ${to}
    GROUP BY 1, 2, 3, 4`;
  const coupons = rollUp(
    cells,
    await couponGroupKeys(db, cells, rules),
    (c) => ({ used: c.used, amount: Number(c.amount) }),
    (a, b) => ({ used: a.used + b.used, amount: a.amount + b.amount }),
    { used: 0, amount: 0 },
    (v) => v.amount,
  );
  const [issued] = await db<{ n: number; face: number }[]>`
    SELECT count(*)::int AS n, coalesce(sum(t.face_value) FILTER (WHERE t.kind = 'cash'), 0)::bigint AS face
    FROM coupons c JOIN coupon_issues i ON i.id = c.issue_id JOIN coupon_templates t ON t.id = c.template_id
    WHERE i.business_date BETWEEN ${from} AND ${to}`;

  // ② 赠金：储值消费用掉的赠金，撤销的冲减（按流水的营业日）；充值送出的、到期作废的只做参考
  const [bonus] = await db<{ consumed: number; issued: number; expired: number }[]>`
    SELECT coalesce(-sum(bonus_delta) FILTER (WHERE entry_type IN ('consume', 'reversal')), 0)::bigint AS consumed,
           coalesce(sum(bonus_delta) FILTER (WHERE entry_type = 'recharge'), 0)::bigint AS issued,
           coalesce(-sum(bonus_delta) FILTER (WHERE entry_type = 'expire'), 0)::bigint AS expired
    FROM ledger_entries WHERE business_date BETWEEN ${from} AND ${to}`;

  // ③ 会员折扣：没反结账的结账单上记的会员折扣，按权益
  const discounts = await db<MarketingCost['discounts']['rows']>`
    SELECT p.benefit_id, b.code, b.name, count(DISTINCT p.checkout_id)::int AS checkouts, sum(p.amount)::bigint AS amount
    FROM checkout_payments p JOIN checkouts k ON k.id = p.checkout_id JOIN benefits b ON b.id = p.benefit_id
    WHERE p.method = 'member_discount' AND k.status = 'completed' AND k.business_date BETWEEN ${from} AND ${to}
    GROUP BY 1, 2, 3 ORDER BY b.code`;

  // ④ 服务类权益：登记使用（作废的不算）× 测算单价
  const services = await db<{ benefitId: number; code: string; name: string; uses: number; members: number; unitCost: number | null }[]>`
    SELECT u.benefit_id, b.code, b.name, sum(u.quantity)::int AS uses, count(DISTINCT u.member_id)::int AS members, mp.unit_cost
    FROM benefit_uses u JOIN benefits b ON b.id = u.benefit_id LEFT JOIN marketing_cost_params mp ON mp.benefit_id = u.benefit_id
    WHERE u.status = 'active' AND u.business_date BETWEEN ${from} AND ${to}
    GROUP BY 1, 2, 3, mp.unit_cost ORDER BY b.code`;
  const serviceRows = services.map((s) => {
    const unitCost = s.unitCost === null ? null : Number(s.unitCost);
    return { ...s, benefitId: Number(s.benefitId), unitCost, amount: unitCost === null ? null : unitCost * s.uses };
  });

  // ⑤ 买一赠一的赠品出库：这段时间的状态，另加不在这段时间但还要处理的（失败的）
  const giftCounts = await db<{ status: GiftOutStatus; n: number }[]>`
    SELECT status, count(*)::int AS n FROM coupon_gift_outs WHERE business_date BETWEEN ${from} AND ${to} GROUP BY 1`;
  const giftItems = await db<MarketingCost['giftOuts']['items']>`
    SELECT g.id, g.status, g.business_date::text AS business_date, c.code AS coupon_code, k.checkout_no, t.name AS template_name,
           mt.name AS material_name, mt.inventory_unit AS unit, g.qty_milli,
           CASE WHEN w.kind = 'central' THEN coalesce((SELECT value #>> '{}' FROM settings WHERE key = 'inventory_scope_name'), '后勤总库')
                ELSE wd.name || '小仓' END AS warehouse_name,
           d.doc_no AS inv_doc_no, g.last_error
    FROM coupon_gift_outs g
    JOIN coupons c ON c.id = g.coupon_id JOIN checkouts k ON k.id = g.checkout_id JOIN coupon_templates t ON t.id = g.template_id
    JOIN materials mt ON mt.id = g.material_id JOIN warehouses w ON w.id = g.warehouse_id LEFT JOIN departments wd ON wd.id = w.department_id
    LEFT JOIN inv_docs d ON d.id = g.inv_doc_id
    WHERE g.business_date BETWEEN ${from} AND ${to} OR g.status IN ('failed', 'void_failed')
    ORDER BY (g.status IN ('failed', 'void_failed')) DESC, g.id DESC LIMIT ${MAX_GIFT_ITEMS}`;

  const discountRows = discounts.map((d) => ({ ...d, benefitId: Number(d.benefitId), amount: Number(d.amount) }));
  const couponAmount = coupons.totals.amount;
  const bonusConsumed = Number(bonus?.consumed ?? 0);
  const discountAmount = discountRows.reduce((s, d) => s + d.amount, 0);
  const serviceAmount = serviceRows.reduce((s, r) => s + (r.amount ?? 0), 0);
  return {
    from,
    to,
    total: couponAmount + bonusConsumed + discountAmount + serviceAmount,
    coupons: {
      used: coupons.totals.used,
      amount: couponAmount,
      issued: issued?.n ?? 0,
      issuedFace: Number(issued?.face ?? 0),
      groups: coupons.groups as Record<keyof typeof coupons.groups, CouponCostRow[]>,
    },
    bonus: { consumed: bonusConsumed, issued: Number(bonus?.issued ?? 0), expired: Number(bonus?.expired ?? 0) },
    discounts: { checkouts: discountRows.reduce((s, d) => s + d.checkouts, 0), amount: discountAmount, rows: discountRows },
    services: { uses: serviceRows.reduce((s, r) => s + r.uses, 0), amount: serviceAmount, rows: serviceRows },
    giftOuts: {
      counts: Object.fromEntries(giftCounts.map((g) => [g.status, g.n])),
      items: giftItems.map((g) => ({ ...g, id: Number(g.id), qtyMilli: Number(g.qtyMilli), couponCode: formatStoreCouponCode(g.couponCode) })),
    },
  };
}

const yuan = (cents: number) => (cents / 100).toFixed(2);

export function marketingCostCsv(m: MarketingCost): string {
  const rows: (string | number)[][] = [
    ['项目', '分组', '名称', '说明', '次数 / 张数', '成本（元）'],
    ['合计', '', `${m.from} 至 ${m.to}`, '券 + 赠金 + 会员折扣 + 填了单价的服务类权益（实核）', '', yuan(m.total)],
    ['券', '合计', '', `参考：这段时间发出 ${m.coupons.issued} 张，代金券面值 ${yuan(m.coupons.issuedFace)} 元`, m.coupons.used, yuan(m.coupons.amount)],
    ...USAGE_GROUPS.flatMap((g) => m.coupons.groups[g].map((r) => ['券', USAGE_GROUP_LABELS[g], r.label, r.note ?? '', r.used, yuan(r.amount)])),
    ['赠金', '用掉的赠金', '', `参考：充值送出 ${yuan(m.bonus.issued)} 元，到期作废 ${yuan(m.bonus.expired)} 元`, '', yuan(m.bonus.consumed)],
    ['会员折扣', '合计', '', '', m.discounts.checkouts, yuan(m.discounts.amount)],
    ...m.discounts.rows.map((d) => ['会员折扣', '按权益', d.name, d.code, d.checkouts, yuan(d.amount)]),
    ['服务类权益', '合计', '', '只算填了测算单价的', m.services.uses, yuan(m.services.amount)],
    ...m.services.rows.map((s) => [
      '服务类权益',
      '按权益',
      s.name,
      `${s.code}；${s.members} 位会员；${s.unitCost === null ? '没填测算单价' : `单价 ${yuan(s.unitCost)} 元`}`,
      s.uses,
      s.amount === null ? '' : yuan(s.amount),
    ]),
    ...Object.entries(m.giftOuts.counts).map(([status, n]) => ['买一赠一赠品出库', GIFT_OUT_STATUS_LABELS[status as GiftOutStatus], '', '真实的库存出库，成本在库存账', n ?? 0, '']),
  ];
  return toCsv(rows);
}

export async function listCostParams(db: Db): Promise<CostParam[]> {
  const rows = await db<CostParam[]>`
    SELECT b.id AS benefit_id, b.code, b.name, b.status, mp.unit_cost, s.display_name AS updated_by_name, mp.updated_at
    FROM benefits b LEFT JOIN marketing_cost_params mp ON mp.benefit_id = b.id LEFT JOIN staff s ON s.id = mp.updated_by
    WHERE b.category = 'service' ORDER BY b.code`;
  return rows.map((r) => ({
    ...r,
    benefitId: Number(r.benefitId),
    unitCost: r.unitCost === null ? null : Number(r.unitCost),
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  }));
}

const ParamInput = z.object({
  // 分；null = 不测算（只列次数）
  unitCost: z.number('测算单价不对').int('测算单价最多两位小数').min(0, '测算单价不能是负数').max(100_000_000, '测算单价过大').nullable(),
});

/** 改一项的测算单价（覆盖写入，重复提交结果相同）；null 删掉这一项的单价 */
export async function saveCostParam(deps: Deps, benefitId: number, raw: unknown, actor: { id: number }, ip?: string): Promise<CostParam> {
  const { unitCost } = parse(ParamInput, raw);
  const { sql } = deps;
  const [b] = await sql<{ category: string; code: string }[]>`SELECT category, code FROM benefits WHERE id = ${benefitId}`;
  if (!b) throw notFound('这项权益不存在');
  if (b.category !== 'service') throw badRequest('只有服务类权益按次数测算单价');
  await sql.begin(async (tx) => {
    const [before] = await tx<{ unitCost: number }[]>`SELECT unit_cost FROM marketing_cost_params WHERE benefit_id = ${benefitId} FOR UPDATE`;
    if (unitCost === null) await tx`DELETE FROM marketing_cost_params WHERE benefit_id = ${benefitId}`;
    else
      await tx`
        INSERT INTO marketing_cost_params (benefit_id, unit_cost, updated_by) VALUES (${benefitId}, ${unitCost}, ${actor.id})
        ON CONFLICT (benefit_id) DO UPDATE SET unit_cost = EXCLUDED.unit_cost, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'marketing_cost_param_saved',
      targetType: 'benefit',
      targetId: benefitId,
      detail: { code: b.code, before: before ? Number(before.unitCost) : null, after: unitCost },
      ip,
    });
  });
  const saved = (await listCostParams(sql)).find((p) => p.benefitId === benefitId);
  return saved!;
}

export function registerMarketingCostRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const load = (from: string, to: string) => readSnapshot(sql, async (tx) => marketingCost(tx, from, to, await loadMembershipRules(tx)));

  app.get('/api/marketing-cost', { preHandler: guard('marketing.cost') }, async (req) => {
    const { from, to } = parse(Range, req.query ?? {});
    return load(from, to);
  });
  app.get('/api/marketing-cost.csv', { preHandler: guard('marketing.cost') }, async (req, reply) => {
    const { from, to } = parse(Range, req.query ?? {});
    const m = await load(from, to);
    await writeAudit(sql, { staffId: req.actor.id, action: 'marketing_cost_exported', targetType: 'marketing_cost', detail: { from, to, total: m.total }, ip: req.ip });
    return csvReply(reply, `营销成本测算-${from}至${to}.csv`, marketingCostCsv(m));
  });
  app.get('/api/marketing-cost/params', { preHandler: guard('marketing.cost') }, async () => listCostParams(sql));
  app.put('/api/marketing-cost/params/:id', { preHandler: guard('marketing.cost') }, async (req) =>
    saveCostParam(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip),
  );
}
