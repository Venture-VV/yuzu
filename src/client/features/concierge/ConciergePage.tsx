import { useEffect, useState } from "react";
import { shortStamp } from "./format";
import { Navigate } from "react-router";
import { api } from "../../lib/api";
import { useCan, useSession } from "../../lib/session";
import Workspace from "./Workspace";
import type { WorkspaceData, Receipt, Member } from "./types";
import {
  conciergeFetch,
  setConciergeActor,
  forgetPending,
  unresolvedPending,
  checkPending,
  retryPending,
  abandonPending,
  type Pending,
  loadReceipt,
} from "./api";
import { Button } from "../../components/ui";
import "./concierge.css";
/** 待确认的那一笔是什么：操作、对象、什么时候发的（整改：原来只显示一串编号，分不清是哪一笔） */
const ACTION_LABELS: Record<string, string> = {
  createMember: "新建会员",
  updateMember: "修改会员",
  saveBalance: "核对余额",
  attachBalanceEvidence: "追加余额依据",
  saveNote: "服务记录",
  saveCatalogItem: "核准项目名称",
  createAppointment: "登记协调预约",
  updateAppointment: "调整协调预约",
  saveVisit: "到店接待",
  saveTask: "回访 / 交班",
  saveReceipt: "消费凭证",
};
function describePending(op: Pending): string {
  const p = op.payload as Record<string, unknown>;
  const pick = (k: string) => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
  const what = pick("name") || pick("number") || pick("content").slice(0, 20) || pick("service") || (pick("amount") ? `¥${pick("amount")}` : "");
  const time = shortStamp(op.createdAt);
  return [ACTION_LABELS[op.action] ?? op.action, what, time && `${time} 提交`].filter(Boolean).join(" · ");
}
export function ConciergePage() {
  const session = useSession(),
    can = useCan();
  setConciergeActor(session.staff.id);
  const [data, setData] = useState<WorkspaceData>(),
    [error, setError] = useState(""),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    let live = true;
    if (can("concierge.read"))
      void conciergeFetch("/api/concierge/workspace")
        .then((r) => r.json())
        .then((d) => {
          if (live) setData(d);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [generation, session.staff.id]);
  if (!can("concierge.read")) return <Navigate to="/" replace />;
  return (
    <>
      <PendingPanel
        onResolved={() => {
          window.dispatchEvent(new Event("concierge-data-changed"));
          setGeneration((g) => g + 1);
        }}
      />
      {error && (
        <div role="alert" className="p-4 text-red-800">
          {error}
          <button
            onClick={() => {
              setError("");
              setGeneration((g) => g + 1);
            }}
          >
            重试
          </button>
        </div>
      )}
      {data ? (
        <Workspace key={session.staff.id} initialData={data} />
      ) : (
        <p className="p-5">正在加载管家工作台…</p>
      )}
    </>
  );
}
function PendingPanel({ onResolved }: { onResolved: () => void }) {
  const [items, setItems] = useState<Pending[]>(unresolvedPending()),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const update = () => setItems(unresolvedPending());
    window.addEventListener("concierge-pending-changed", update);
    return () =>
      window.removeEventListener("concierge-pending-changed", update);
  }, []);
  const act = async (op: Pending, mode: "check" | "retry" | "abandon") => {
    if (
      mode === "abandon" &&
      !window.confirm(
        `确认不再执行这一笔？\n${describePending(op)}\n\n门店系统会登记这个编号作废：它如果其实已经成功，记录还在、不会被撤销；如果还没成功，以后也不会再生效。`,
      )
    )
      return;
    setBusy(true);
    try {
      const result =
        mode === "check"
          ? await checkPending(op.requestId)
          : mode === "retry"
            ? await retryPending(op)
            : await abandonPending(op.requestId);
      if (mode === "check") {
        if ((result as any).found) {
          forgetPending(op.requestId);
          setMessage(
            (result as any).abandoned
              ? "该编号已停止执行。"
              : "已查到成功记录，请刷新后核对。",
          );
          onResolved();
        } else
          setMessage("尚未查到成功结果；可按原内容重试，或确认这笔不再执行。");
      } else {
        setMessage(
          mode === "retry"
            ? "已按原编号提交，请核对记录。"
            : (result as any).response
              ? "查到该笔已成功，没有撤销业务，请查看记录。"
              : "该编号已标记不再执行。",
        );
        onResolved();
      }
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {items.length > 0 && (
        <section
          className="border-b border-amber-300 bg-amber-50 p-3"
          aria-label="管家操作结果待确认"
          data-testid="concierge-pending"
        >
          <strong>结果待确认 · {items.length}笔</strong>
          <p className="text-[13px]">
            这几笔发出去以后没有收到明确的结果。处理完之前不能继续录入：先查回；查不到的按原内容重试，或确认不再执行。
          </p>
          {items.map((op) => (
            <div
              key={op.requestId}
              className="my-2 flex flex-wrap items-center gap-2"
              data-testid="concierge-pending-item"
            >
              <span className="min-w-0 flex-1 basis-56 text-[14px]">
                <b>{describePending(op)}</b>
                <code className="block truncate text-[11px] opacity-70">
                  操作编号 {op.requestId}
                </code>
              </span>
              <Button size="sm" disabled={busy} onClick={() => void act(op, "check")}>
                查回结果
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void act(op, "retry")}>
                原样重试
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void act(op, "abandon")}>
                确认不再执行
              </Button>
            </div>
          ))}
        </section>
      )}
      {message && (
        <p role="status" className="bg-amber-50 p-2">
          {message}
        </p>
      )}
    </>
  );
}
