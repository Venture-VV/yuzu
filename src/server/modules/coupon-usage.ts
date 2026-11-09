// 权益使用率看板（8.0.4 需求表 08，docs/MEMBERSHIP_V804.md 第 8 节，HY10）：按发放的时间段圈一批券，看领取、核销到今天的情况。
// 口径见 @shared/coupon-usage。只读（一致的快照），不加锁；导出记审计。
// 给能维护券（coupon.manage）或看会员总览（report.members）的人看，与券的「统计」一样。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { COUPON_ISSUE_KIND_LABELS, COUPON_KIND_LABELS, type CouponIssueKind, type CouponKind } from '@shared/coupons';
import { addUsage, EMPTY_USAGE, rateText, USAGE_GROUP_LABELS, USAGE_GROUPS, type CouponUsage, type UsageCounts, type UsageGroup, type UsageRow } from '@shared/coupon-usage';
import type { MembershipRules } from '@shared/membership';
import { guardAny } from '../auth/guard';
import { readSnapshot, type Db } from '../db';
import { writeAudit } from '../lib/audit';
import { csvReply, toCsv } from '../lib/csv';
import { checkDateRange } from '../lib/dates';
import type { Deps } from '../lib/context';
import { parse } from '../lib/validate';
import { loadMembershipRules } from './membership';
import { businessToday } from './coupons';

export const UsageQuery = z.object({
  from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  grade: z.coerce.number().int().min(0).max(6).optional(),
  tagId: z.coerce.number().int().positive().optional(),
});
type UsageQueryInput = z.infer<typeof UsageQuery>;

/** 最细的一格：券 × 发放方式 × 权益 × 会员档级（会员现在的档级；无记名券为空） */
export interface CouponCell {
  templateId: number;
  source: CouponIssueKind;
  benefitId: number | null;
  grade: number | null;
}
interface GroupKey {
  key: string;
  label: string;
  note: string | null;
  order: number | string;
}
type CellRow = CouponCell & UsageCounts;

const NO_MEMBER = '无记名券（没有会员）';

/** 按会员档级、标签圈：只看发给会员的券（无记名券没有会员，圈了就不算） */
function memberFilter(db: Db, col: ReturnType<Db>, q: Pick<UsageQueryInput, 'grade' | 'tagId'>) {
  return db`
    ${q.grade !== undefined ? db`AND m.grade = ${q.grade}` : db``}
    ${q.tagId !== undefined ? db`AND EXISTS (SELECT 1 FROM member_tag_links l WHERE l.member_id = ${col} AND l.tag_id = ${q.tagId})` : db``}`;
}

/** 四种看法各自的分组键与名称（券名与种类、发放方式、权益编号与名称、档级）；不是权益发的券不进「按会员权益」 */
export async function couponGroupKeys(db: Db, cells: readonly CouponCell[], rules: MembershipRules): Promise<Record<UsageGroup, (c: CouponCell) => GroupKey | null>> {
  const templateIds = [...new Set(cells.map((c) => Number(c.templateId)))];
  const benefitIds = [...new Set(cells.filter((c) => c.benefitId !== null).map((c) => Number(c.benefitId)))];
  const templates = new Map(
    (templateIds.length ? await db<{ id: number; name: string; kind: CouponKind }[]>`SELECT id, name, kind FROM coupon_templates WHERE id IN ${db(templateIds)}` : []).map((t) => [Number(t.id), t]),
  );
  const benefits = new Map(
    (benefitIds.length ? await db<{ id: number; code: string; name: string }[]>`SELECT id, code, name FROM benefits WHERE id IN ${db(benefitIds)}` : []).map((b) => [Number(b.id), b]),
  );
  const gradeName = (g: number | null) => (g === null ? NO_MEMBER : `L${g} ${rules.grades[g]?.name ?? ''}`.trim());
  return {
    template: (c) => {
      const t = templates.get(Number(c.templateId));
      return { key: `template:${c.templateId}`, label: t?.name ?? `模板 ${c.templateId}`, note: t ? COUPON_KIND_LABELS[t.kind] : null, order: Number(c.templateId) };
    },
    source: (c) => ({ key: `source:${c.source}`, label: COUPON_ISSUE_KIND_LABELS[c.source] ?? c.source, note: null, order: c.source }),
    benefit: (c) => {
      if (c.benefitId === null) return null;
      const b = benefits.get(Number(c.benefitId));
      return { key: `benefit:${c.benefitId}`, label: b?.name ?? `权益 ${c.benefitId}`, note: b?.code ?? null, order: b?.code ?? String(c.benefitId) };
    },
    grade: (c) => ({ key: `grade:${c.grade ?? 'none'}`, label: gradeName(c.grade === null ? null : Number(c.grade)), note: null, order: c.grade === null ? 99 : Number(c.grade) }),
  };
}

/**
 * 把最细的格子合成四种看法（同一批格子，各看法与合计一致）：value 取一格的数，add 相加；
 * 按券、按权益的看法按 size 从大到小排，发放方式、档级按固定顺序
 */
export function rollUp<C extends CouponCell, V extends object>(
  cells: readonly C[],
  keys: Record<UsageGroup, (c: CouponCell) => GroupKey | null>,
  value: (c: C) => V,
  add: (a: V, b: V) => V,
  zero: V,
  size: (v: V) => number,
): { totals: V; groups: Record<UsageGroup, (Omit<GroupKey, 'order'> & V)[]> } {
  let totals = zero;
  const acc = Object.fromEntries(USAGE_GROUPS.map((g) => [g, new Map<string, { k: GroupKey; v: V }>()])) as Record<UsageGroup, Map<string, { k: GroupKey; v: V }>>;
  for (const cell of cells) {
    const v = value(cell);
    totals = add(totals, v);
    for (const g of USAGE_GROUPS) {
      const k = keys[g](cell);
      if (!k) continue;
      const prev = acc[g].get(k.key);
      acc[g].set(k.key, { k: prev?.k ?? k, v: add(prev?.v ?? zero, v) });
    }
  }
  const groups = Object.fromEntries(
    USAGE_GROUPS.map((g) => [
      g,
      [...acc[g].values()]
        .sort((a, b) =>
          g === 'template' || g === 'benefit'
            ? size(b.v) - size(a.v) || String(a.k.order).localeCompare(String(b.k.order))
            : a.k.order < b.k.order ? -1 : a.k.order > b.k.order ? 1 : 0,
        )
        .map(({ k: { order: _order, ...k }, v }) => ({ ...k, ...v })),
    ]),
  ) as Record<UsageGroup, (Omit<GroupKey, 'order'> & V)[]>;
  return { totals, groups };
}

export async function couponUsage(db: Db, q: UsageQueryInput, today: string, rules: MembershipRules): Promise<CouponUsage> {
  checkDateRange(q.from, q.to);
  // 先按「券 × 发放方式 × 权益 × 会员档级」分到最细，再合成四种看法与合计（同一次查询，合计一致）
  const cells = await db<CellRow[]>`
    SELECT c.template_id, i.kind AS source, g.benefit_id, m.grade,
           count(*)::int AS issued,
           count(*) FILTER (WHERE c.member_id IS NOT NULL OR c.status = 'used')::int AS claimed,
           count(*) FILTER (WHERE c.status = 'used')::int AS used,
           coalesce(sum(p.amount) FILTER (WHERE c.status = 'used'), 0)::bigint AS used_amount,
           count(*) FILTER (WHERE c.status = 'available' AND c.valid_to < ${today})::int AS expired,
           count(*) FILTER (WHERE c.status = 'voided')::int AS voided
    FROM coupons c
    JOIN coupon_issues i ON i.id = c.issue_id
    LEFT JOIN benefit_grants g ON g.coupon_issue_id = i.id
    LEFT JOIN members m ON m.id = c.member_id
    LEFT JOIN checkout_payments p ON p.checkout_id = c.checkout_id AND p.method = 'store_coupon' AND p.store_coupon_id = c.id
    WHERE i.business_date BETWEEN ${q.from} AND ${q.to} ${memberFilter(db, db`c.member_id`, q)}
    GROUP BY 1, 2, 3, 4`;
  const { totals, groups } = rollUp(
    cells,
    await couponGroupKeys(db, cells, rules),
    (c): UsageCounts => ({ issued: c.issued, claimed: c.claimed, used: c.used, usedAmount: Number(c.usedAmount), expired: c.expired, voided: c.voided }),
    addUsage,
    EMPTY_USAGE,
    (v) => v.issued,
  );

  const services = await db<CouponUsage['services']>`
    SELECT u.benefit_id, b.code, b.name, sum(u.quantity)::int AS uses, count(DISTINCT u.member_id)::int AS members
    FROM benefit_uses u JOIN benefits b ON b.id = u.benefit_id LEFT JOIN members m ON m.id = u.member_id
    WHERE u.status = 'active' AND u.business_date BETWEEN ${q.from} AND ${q.to} ${memberFilter(db, db`u.member_id`, q)}
    GROUP BY 1, 2, 3 ORDER BY b.code`;

  return {
    from: q.from,
    to: q.to,
    today,
    grade: q.grade ?? null,
    tagId: q.tagId ?? null,
    totals,
    groups,
    services: services.map((s) => ({ ...s, benefitId: Number(s.benefitId) })),
  };
}

const yuan = (cents: number) => (cents / 100).toFixed(2);

export function usageCsv(u: CouponUsage): string {
  const line = (group: string, r: UsageRow | (UsageCounts & { label: string; note: string | null })) => [
    group,
    r.label,
    r.note ?? '',
    r.issued,
    r.claimed,
    rateText(r.claimed, r.issued),
    r.used,
    rateText(r.used, r.issued),
    yuan(r.usedAmount),
    r.expired,
    r.voided,
  ];
  return toCsv([
    ['看法', '名称', '说明', '发放（张）', '领取（张）', '领取率', '核销（张）', '核销率', '核销金额（元）', '过期（张）', '作废（张）'],
    line('合计', { ...u.totals, label: `${u.from} 至 ${u.to} 发放`, note: `过期按 ${u.today} 算` }),
    ...USAGE_GROUPS.flatMap((g) => u.groups[g].map((r) => line(USAGE_GROUP_LABELS[g], r))),
    ...u.services.map((s) => ['服务类权益（登记使用）', s.name, s.code, '', '', '', s.uses, '', '', '', `${s.members} 位会员`]),
  ]);
}

export function registerCouponUsageRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const load = (q: UsageQueryInput) =>
    readSnapshot(sql, async (tx) => couponUsage(tx, q, await businessToday(tx, deps), await loadMembershipRules(tx)));

  app.get('/api/coupons/usage', { preHandler: guardAny('coupon.manage', 'report.members') }, async (req) => load(parse(UsageQuery, req.query ?? {})));

  app.get('/api/coupons/usage.csv', { preHandler: guardAny('coupon.manage', 'report.members') }, async (req, reply) => {
    const q = parse(UsageQuery, req.query ?? {});
    const u = await load(q);
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'coupon_usage_exported',
      targetType: 'coupon_template',
      detail: { from: q.from, to: q.to, grade: q.grade ?? null, tagId: q.tagId ?? null, issued: u.totals.issued, used: u.totals.used },
      ip: req.ip,
    });
    return csvReply(reply, `券的使用率-${q.from}至${q.to}.csv`, usageCsv(u));
  });
}
