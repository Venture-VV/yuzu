// 管家部工作区的小部件与格式化（8.1.3 从 Workspace.tsx 拆出来，内容没改）
import { clock, dayStamp, shortStamp } from "./format";
import { downloadBlob, uuid } from "../../lib/utils";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  FileText,
  Plus,
  X,
} from "lucide-react";

export const uid = (): string => uuid();
export function dayKey(value: string | Date = new Date()) {
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
}
export function localTime(value?: string) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function iso(value: string) {
  if (!value) return "";
  return new Date(
    `${value}${value.length === 16 ? ":00" : ""}+08:00`,
  ).toISOString();
}
// 显示用的金额、时间都走 ./format（全店同一套，8.0.18）
export function date(value?: string, time = true) {
  if (!value) return "尚未记录";
  return time ? shortStamp(value, "时间待核") : dayStamp(value, "时间待核");
}
export function time(value?: string) {
  return clock(value);
}
export function amount(n: number | null | undefined) {
  return n == null ? "" : (n / 100).toFixed(2);
}
export function initial(s: string) {
  return s.trim().slice(0, 1) || "会";
}
export function download(
  content: string,
  name: string,
  type = "text/csv;charset=utf-8;",
) {
  downloadBlob(new Blob([content], { type }), name);
}
export function csv(rows: unknown[][]) {
  const safe = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return "\uFEFF" + rows.map((r) => r.map(safe).join(",")).join("\r\n");
}
export function Field({
  label,
  children,
  wide = false,
  hint,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  hint?: string;
}) {
  return (
    <label className={`field ${wide ? "field-wide" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Status({ value }: { value: string }) {
  const tone = ["已确认", "已到店", "已接收", "已完成"].includes(value)
    ? "green"
    : [
          "待确认",
          "待核对",
          "待补全",
          "待复核",
          "待接收",
          "接待中",
          "处理中",
        ].includes(value)
      ? "orange"
      : "gray";
  return (
    <span className={`status status-${tone}`}>
      <i />
      {value}
    </span>
  );
}
export function Empty({
  title = "暂无记录",
  text = "相关记录会显示在这里。",
  icon: Icon = FileText,
  action,
  onAction,
}: {
  title?: string;
  text?: string;
  icon?: typeof FileText;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={27} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && (
        <button className="btn btn-primary" onClick={onAction}>
          <Plus size={15} />
          {action}
        </button>
      )}
    </div>
  );
}
export function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(
      "input:not([type=hidden]),select,textarea,button",
    );
    first?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const list = [
          ...(el?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
          ) || []),
        ];
        const f = list[0],
          l = list.at(-1);
        if (e.shiftKey && document.activeElement === f) {
          e.preventDefault();
          l?.focus();
        } else if (!e.shiftKey && document.activeElement === l) {
          e.preventDefault();
          f?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = before;
      document.removeEventListener("keydown", handler);
    };
  }, []);
  return (
    <div className="modal-layer">
      <div className="modal-scrim" onClick={onClose} />
      <section
        ref={ref}
        className={`modal-box ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="form-subtitle">{subtitle}</p>}
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={21} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
