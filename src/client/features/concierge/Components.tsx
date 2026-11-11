import { useState } from "react";
import { api } from "../../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { useCan } from "../../lib/session";
import { loadReceipt } from "./api";
import type { Receipt } from "./types";
export function NativeMemberField({ selected }: { selected?: number | null }) {
  const can = useCan();
  const [q, setQ] = useState(""),
    [items, setItems] = useState<
      Array<{ id: number; name: string; phone: string; memberNo: string }>
    >([]),
    [id, setId] = useState(selected ? String(selected) : ""),
    [error, setError] = useState("");
  async function search() {
    try {
      const r = await api.get<{ members: typeof items }>(
        `/api/concierge/native-members?q=${encodeURIComponent(q)}`,
      );
      setItems(r.members);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!can("member.read")) return null;
  return (
    <div className="field field-wide">
      <span>关联企业会员（可选，不会自动纳入或开卡）</span>
      <div className="inline-form">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入至少2个字或手机号搜索"
        />
        <button type="button" onClick={() => void search()}>
          查找
        </button>
      </div>
      <select
        name="nativeMemberId"
        value={id}
        onChange={(e) => setId(e.target.value)}
      >
        <option value="">暂不关联</option>
        {selected && !items.some((m) => m.id === selected) && (
          <option value={selected}>已关联企业会员 #{selected}</option>
        )}
        {items.map((m) => (
          <option key={m.id} value={m.id}>
            {m.memberNo} · {m.name} · {m.phone}
          </option>
        ))}
      </select>
      {error && <small role="alert">{error}</small>}
      <small>
        这是管家服务档案的关联；不会更改企业手机号、等级、储值或赠金。
      </small>
    </div>
  );
}
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

export function EnterpriseAccount() {
  const qc = useQueryClient(),
    navigate = useNavigate();
  const [error, setError] = useState("");
  return (
    <span className="enterprise-account">
      <Link to="/password">修改密码</Link> ·{" "}
      <button
        type="button"
        onClick={() =>
          void api
            .post("/api/auth/logout")
            .then(() => {
              qc.clear();
              navigate("/login", { replace: true });
            })
            .catch((e) => setError(e.message))
        }
      >
        退出企业账号
      </button>
      {error && <small role="alert">{error}</small>}
    </span>
  );
}
