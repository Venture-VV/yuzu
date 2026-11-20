// 来访异常的读取（8.1.15，docs/FRONTDESK_RISK_V8115.md 第 4 节）：一次来访上的异常、经办记录里的一句话、「异常待办」。
// 都是只读、不加锁；写入在 incidents.ts（它要读来访详情，来访详情又要读这里，所以读的这一半单放一个文件）。

import { INCIDENT_KIND_LABELS, type IncidentTodo, type IncidentTodoList, type VisitIncident } from '@shared/frontdesk-risk';
import { ROLE_LABELS } from '@shared/labels';
import { formatYuan } from '@shared/money';
import type { Db } from '../../db';
import { currentStoreId } from '../../lib/store-context';

/** 能被指成责任人的：在职的前台岗位 */
export const ASSIGNEE_ROLES = ['owner', 'store_manager', 'duty_manager', 'clerk'] as const;

type IncidentRow = Omit<VisitIncident, 'resolved'> & { resolvedNote: string | null; resolvedByName: string | null; resolvedAt: string | null };

const INCIDENT_COLUMNS = (db: Db) => db`
  i.id, i.visit_id, i.kind, i.note, i.amount_cents, ap.display_name AS approved_by_name, cs.display_name AS created_by_name, i.created_at,
  a.assignee_id, asg.display_name AS assignee_name, r.note AS resolved_note, rs.display_name AS resolved_by_name, r.created_at AS resolved_at`;
/** 现在的责任人 = 最后一次指派的那位，没指派过的是登记时指的 */
const INCIDENT_FROM = (db: Db) => db`
  visit_incidents i JOIN staff cs ON cs.id = i.created_by LEFT JOIN staff ap ON ap.id = i.approved_by
  LEFT JOIN LATERAL (
    SELECT coalesce((SELECT e.assignee_id FROM visit_incident_events e WHERE e.incident_id = i.id AND e.action = 'assign' ORDER BY e.id DESC LIMIT 1), i.assignee_id) AS assignee_id
  ) a ON true
  LEFT JOIN staff asg ON asg.id = a.assignee_id
  LEFT JOIN visit_incident_events r ON r.incident_id = i.id AND r.action = 'resolve'
  LEFT JOIN staff rs ON rs.id = r.operator_id`;

const toIncident = <T extends IncidentRow>({ resolvedNote, resolvedByName, resolvedAt, ...r }: T) => ({
  ...r,
  id: Number(r.id),
  visitId: Number(r.visitId),
  amountCents: r.amountCents === null ? null : Number(r.amountCents),
  assigneeId: r.assigneeId === null ? null : Number(r.assigneeId),
  resolved: resolvedAt ? { note: resolvedNote ?? '', byName: resolvedByName ?? '', at: resolvedAt } : null,
});

/** 一次来访上登记的异常，按时间先后 */
export async function visitIncidents(db: Db, visitId: number): Promise<VisitIncident[]> {
  const rows = await db<IncidentRow[]>`SELECT ${INCIDENT_COLUMNS(db)} FROM ${INCIDENT_FROM(db)} WHERE i.visit_id = ${visitId} ORDER BY i.id`;
  return rows.map(toIncident);
}

/** 一次来访上异常的处理记录（指派、处理结果），给经办记录用 */
export async function visitIncidentEvents(db: Db, visitId: number) {
  return db<{ kind: VisitIncident['kind']; action: 'assign' | 'resolve'; note: string; assigneeName: string | null; operatorName: string; createdAt: string }[]>`
    SELECT i.kind, e.action, e.note, asg.display_name AS assignee_name, s.display_name AS operator_name, e.created_at
    FROM visit_incident_events e JOIN visit_incidents i ON i.id = e.incident_id JOIN staff s ON s.id = e.operator_id
    LEFT JOIN staff asg ON asg.id = e.assignee_id
    WHERE i.visit_id = ${visitId} ORDER BY e.id`;
}

/** 经办记录里的一句话 */
export function incidentText(i: Pick<VisitIncident, 'kind' | 'note' | 'amountCents' | 'approvedByName' | 'assigneeName'>): string {
  const label = INCIDENT_KIND_LABELS[i.kind];
  const parts = [
    ...(i.amountCents !== null ? [i.kind === 'unsettled' ? `应收 ${formatYuan(i.amountCents)}` : formatYuan(i.amountCents)] : []),
    ...(i.note ? [i.note] : []),
    ...(i.approvedByName ? [`由${i.approvedByName}当场授权`] : []),
  ];
  return `异常 · ${label}${parts.length ? `（${parts.join('，')}）` : ''}`;
}

/** 没处理完的待办条数：本店全部，或某几次来访各几条 */
export async function openTodoCount(db: Db): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM visit_incidents i
    WHERE i.store_id = ${currentStoreId()} AND i.kind IN ('report', 'unsettled')
      AND NOT EXISTS (SELECT 1 FROM visit_incident_events e WHERE e.incident_id = i.id AND e.action = 'resolve')`;
  return row!.n;
}

/** 「异常待办」：本店没处理完的上报、未结离店（先登记的在前），与能指派给谁 */
export async function listTodos(db: Db): Promise<IncidentTodoList> {
  const rows = await db<(IncidentRow & Omit<IncidentTodo, keyof VisitIncident>)[]>`
    SELECT ${INCIDENT_COLUMNS(db)}, v.visit_no, v.status AS visit_status, t.code AS tag_code, v.zone, m.name AS member_name, v.guest_label,
           b.amount_cents AS bill_amount_cents, v.checked_in_at
    FROM ${INCIDENT_FROM(db)}
    JOIN visits v ON v.id = i.visit_id JOIN hand_tags t ON t.id = v.tag_id JOIN bills b ON b.id = v.bill_id LEFT JOIN members m ON m.id = i.member_id
    WHERE i.store_id = ${currentStoreId()} AND i.kind IN ('report', 'unsettled') AND r.id IS NULL
    ORDER BY i.id LIMIT 200`;
  const staff = await db<{ id: number; name: string; role: keyof typeof ROLE_LABELS }[]>`
    SELECT id, display_name AS name, role FROM staff WHERE active AND role IN ${db(ASSIGNEE_ROLES as unknown as string[])} ORDER BY display_name, id`;
  return {
    todos: rows.map((r) => ({ ...toIncident(r), billAmountCents: Number(r.billAmountCents) })),
    assignees: staff.map((s) => ({ id: Number(s.id), name: s.name, role: ROLE_LABELS[s.role] ?? s.role })),
  };
}
