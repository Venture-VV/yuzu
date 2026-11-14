import type { Db } from '../../db';
import type { CheckLine } from '../../ops/consistency';

/** Customer projections must have a complete append-only history; native funds are checked by the wallet checks. */
export async function customerChecks(db: Db): Promise<CheckLine[]> {
  const [schema] = await db<{ present: boolean }[]>`SELECT to_regclass('customer_bindings') IS NOT NULL AS present`;
  if (!schema?.present) return [];
  const issues = await db<{ ref: string }[]>`
    SELECT ref FROM (
      SELECT '维护绑定 ' || b.member_id AS ref FROM customer_bindings b
      WHERE (SELECT count(*) FROM customer_binding_events e WHERE e.member_id=b.member_id AND e.version BETWEEN 1 AND b.version)<>b.version
        OR EXISTS(SELECT 1 FROM customer_binding_events e WHERE e.member_id=b.member_id AND e.version>b.version)
        OR (b.version=0 AND b.maintainer_staff_id IS NOT NULL)
        OR (b.version>0 AND NOT EXISTS(SELECT 1 FROM customer_binding_events e WHERE e.member_id=b.member_id AND e.version=b.version AND e.to_staff_id=b.maintainer_staff_id))
      UNION ALL
      SELECT '绑定审批 ' || r.id FROM customer_binding_requests r
      WHERE (r.status='approved') IS DISTINCT FROM EXISTS(SELECT 1 FROM customer_binding_events e WHERE e.request_id=r.id)
      UNION ALL
      SELECT '绑定历史 ' || e.id FROM customer_binding_events e JOIN customer_binding_requests r ON r.id=e.request_id
      WHERE e.member_id<>r.member_id OR e.to_staff_id<>r.to_staff_id OR e.from_staff_id IS DISTINCT FROM r.from_staff_id
        OR e.approved_by IS DISTINCT FROM r.reviewed_by OR e.version<>r.expected_version+1
      UNION ALL
      SELECT '成交归属 ' || c.id FROM customer_recharge_credits c
      WHERE (SELECT count(*) FROM customer_credit_events e WHERE e.credit_id=c.id AND e.version BETWEEN 1 AND c.version)<>c.version
        OR EXISTS(SELECT 1 FROM customer_credit_events e WHERE e.credit_id=c.id AND e.version>c.version)
      UNION ALL
      SELECT '月份目标 ' || t.id FROM customer_month_targets t
      WHERE (SELECT count(*) FROM customer_target_versions v WHERE v.target_id=t.id AND v.version BETWEEN 1 AND t.version)<>t.version
        OR EXISTS(SELECT 1 FROM customer_target_versions v WHERE v.target_id=t.id AND v.version>t.version)
    ) x LIMIT 5`;
  const noteIssues = await db<{ id: number }[]>`WITH RECURSIVE family AS (
    SELECT id AS member_id,id AS canonical_id FROM members WHERE merged_into_id IS NULL
    UNION SELECT m.id,f.canonical_id FROM members m JOIN family f ON m.merged_into_id=f.member_id
  ) SELECT n.id FROM customer_service_notes n JOIN visits v ON v.id=n.visit_id
    JOIN family nf ON nf.member_id=n.member_id JOIN family vf ON vf.member_id=v.member_id
    WHERE nf.canonical_id<>vf.canonical_id LIMIT 5`;
  const [counts] = await db<{ notes: number; credits: number; bindings: number; targets: number }[]>`SELECT
    (SELECT count(*)::int FROM customer_service_notes) AS notes,
    (SELECT count(*)::int FROM customer_recharge_credits) AS credits,
    (SELECT count(*)::int FROM customer_binding_events) AS bindings,
    (SELECT count(*)::int FROM customer_target_versions) AS targets`;
  const bad = [...issues.map((r) => r.ref), ...noteIssues.map((r) => '服务会员关联 ' + r.id)];
  return [{
    label: '客户部的服务、维护绑定、成交归属及目标历史一致',
    ok: bad.length === 0,
    detail: bad.length ? bad.join('、') : `${counts!.notes}条服务记录、${counts!.bindings}次维护绑定、${counts!.credits}笔成交归属、${counts!.targets}份目标修订；未建立第二套资金账本`,
  }];
}
