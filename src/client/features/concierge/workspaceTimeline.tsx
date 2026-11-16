// 管家部工作区的「经过」时间线与原始内容显示（8.1.3 从 Workspace.tsx 拆出来，内容没改）
import { resourceLabel } from "./NativeIntegration";

import type {
  WorkspaceData,
} from "./types";
import { date } from "./WorkspaceParts";

export function pretty(value: unknown) {
  if (!value) return "无";
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
export type TimelineEntry = {
  id: string;
  type: string;
  at: string;
  title: string;
  content: string;
  actor: string;
  amountCents?: number | null;
  source?: string;
  sourceId?: string;
};
export function timelineFor(data: WorkspaceData, id: string): TimelineEntry[] {
  const m = data.members.find((x) => x.id === id);
  const entries: TimelineEntry[] = [];
  if (m)
    entries.push({
      id: `member-${id}`,
      type: "建档",
      at: m.createdAt,
      title: `会员档案 ${m.code}`,
      content: `${m.name} · 收银卡号 ${m.cardNo || "未填写"}`,
      actor: m.createdByName || "已记录",
    });
  for (const a of data.appointments.filter((x) => x.memberId === id))
    entries.push({
      id: `appointment-${a.id}`,
      type: "预约",
      at: a.updatedAt || a.createdAt,
      title: `${a.service} · ${a.status}`,
      content: `计划 ${date(a.startAt)} · ${a.partySize}位${resourceLabel(a) ? ` · ${resourceLabel(a)}` : ""}${a.changeReason ? `\n变更原因：${a.changeReason}` : ""}`,
      actor: a.updatedByName || a.createdByName || "已记录",
      source: "appointment",
      sourceId: a.id,
    });
  for (const b of data.balances.filter((x) => x.memberId === id))
    entries.push({
      id: `balance-${b.id}`,
      type: "余额",
      at: b.createdAt,
      title: "人工余额核对",
      content: `核对时间 ${date(b.checkedAt)} · 来源 ${b.source}\n${b.note}`,
      actor: b.actorName,
      amountCents: b.amountCents,
      source: "balance",
      sourceId: b.id,
    });
  for (const n of data.notes.filter((x) => x.memberId === id))
    entries.push({
      id: `note-${n.id}`,
      type: "服务",
      at: n.createdAt,
      title: "服务记录",
      content: n.content + (n.nextAt ? `\n下次跟进：${date(n.nextAt)}` : ""),
      actor: n.actorName,
    });
  for (const v of (data.visits || []).filter((x) => x.memberId === id))
    entries.push({
      id: `visit-${v.id}`,
      type: "接待",
      at: v.updatedAt || v.createdAt,
      title: `到店服务 · ${v.status}`,
      content: `${v.partySize}位${v.feedback ? `\n反馈：${v.feedback}` : ""}${v.pending ? `\n未结事项：${v.pending}` : ""}`,
      actor: v.createdByName,
      source: "visit",
      sourceId: v.id,
    });
  for (const t of (data.tasks || []).filter((x) => x.memberId === id))
    entries.push({
      id: `task-${t.id}`,
      type: t.kind,
      at: t.updatedAt || t.createdAt,
      title: `${t.category} · ${t.status}`,
      content:
        t.content +
        (t.result ? `\n结果：${t.result}` : "") +
        (t.nextAction ? `\n下一步：${t.nextAction}` : ""),
      actor: t.createdByName,
      source: "task",
      sourceId: t.id,
    });
  for (const r of (data.receipts || []).filter(
    (x) => x.memberId === id || x.payments.some((p) => p.memberId === id),
  ))
    entries.push({
      id: `receipt-${r.id}`,
      type: "凭证",
      at: r.updatedAt || r.createdAt,
      title: `${r.kind} · ${r.status}`,
      content: `${r.store || "门店待核"} · ${r.number || "单号待核"} · 发生时间 ${r.occurredAt ? date(r.occurredAt) : "待核"}${r.note ? `\n${r.note}` : ""}`,
      actor: r.confirmedByName || r.createdByName,
      amountCents: r.amountCents,
      source: "receipt",
      sourceId: r.id,
    });
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}
