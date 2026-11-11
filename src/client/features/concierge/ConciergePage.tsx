import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { api } from "../../lib/api";
import { useCan, useSession } from "../../lib/session";
import Workspace from "./Workspace";
import type { WorkspaceData, Receipt, Member } from "./types";
import {
  conciergeFetch,
  setConciergeActor,
  forgetPending,
  pendingRequests,
  checkPending,
  retryPending,
  abandonPending,
  type Pending,
  loadReceipt,
} from "./api";
import "./concierge.css";
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
  const [items, setItems] = useState<Pending[]>(pendingRequests()),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const update = () => setItems(pendingRequests());
    window.addEventListener("concierge-pending-changed", update);
    return () =>
      window.removeEventListener("concierge-pending-changed", update);
  }, []);
  const act = async (op: Pending, mode: "check" | "retry" | "abandon") => {
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
        >
          <strong>结果待确认 · {items.length}笔</strong>
          <p>不要另建同一笔；查回或按原编号重试。</p>
          {items.map((op) => (
            <div key={op.requestId} className="my-2 flex flex-wrap gap-2">
              <code>{op.requestId}</code>
              <button disabled={busy} onClick={() => void act(op, "check")}>
                查回结果
              </button>
              <button disabled={busy} onClick={() => void act(op, "retry")}>
                原样重试
              </button>
              <button disabled={busy} onClick={() => void act(op, "abandon")}>
                确认不再执行此编号
              </button>
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
