import { useState } from "react";
import { api } from "../../lib/api";
import { loadReceipt } from "./api";
import type { Receipt } from "./types";
export function ReceiptArchive({
  onSelect,
}: {
  onSelect: (r: Receipt) => void;
}) {
  const [open, setOpen] = useState(false),
    [q, setQ] = useState(""),
    [offset, setOffset] = useState(0),
    [rows, setRows] = useState<Receipt[]>([]),
    [more, setMore] = useState(false),
    [error, setError] = useState("");
  async function search(next = 0) {
    try {
      const r = await api.get<{ receipts: Receipt[]; hasMore: boolean }>(
        `/api/concierge/receipts?q=${encodeURIComponent(q)}&offset=${next}`,
      );
      setRows(r.receipts);
      setMore(r.hasMore);
      setOffset(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="receipt-archive">
      <button
        className="btn btn-secondary"
        onClick={() => {
          setOpen(!open);
          if (!open) void search();
        }}
      >
        检索全部历史消费凭证
      </button>
      {open && (
        <div className="panel">
          <div className="filter-bar">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="单号、门店、会员姓名或手机号"
            />
            <button className="btn btn-primary" onClick={() => void search()}>
              查询
            </button>
          </div>
          <p>工作台显示最近500单；这里按每页50单检索全部历史。</p>
          {error && <p role="alert">{error}</p>}
          {rows.map((r) => (
            <button
              className="archive-row"
              key={r.id}
              onClick={() =>
                void loadReceipt(r.id)
                  .then(onSelect)
                  .catch((e) => setError(e.message))
              }
            >
              {r.number || "待补单号"} · {r.status} · ¥
              {r.amountCents == null
                ? "待核"
                : (r.amountCents / 100).toFixed(2)}
            </button>
          ))}
          <button
            disabled={offset === 0}
            onClick={() => void search(Math.max(0, offset - 50))}
          >
            上一页
          </button>
          <button disabled={!more} onClick={() => void search(offset + 50)}>
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
