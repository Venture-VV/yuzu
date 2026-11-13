import { ReceiptArchive } from "./Components";
import { clock, dayStamp, money, shortStamp } from "./format";
import { NativeSpendingList } from "./NativeSpending";
import { MemberInsightsView, NativeMemberPreview } from "./MemberInsights";
import type { InsightMember } from "@shared/concierge/insights-types";
import { PraiseCenter } from "./PraiseCenter";
import "./profile-layout.css";
import { MemberIdentityFields, ResourceFields, currentBalance, balanceGroupOf, memberGrade, uniqueMembers, resourceLabel } from "./NativeIntegration";
import { loadReceipt, loadWorkspace, pendingRequests } from "./api";
import { announceRevision } from "./live";
import { api } from "../../lib/api";
import { uuid } from "../../lib/utils";
import { useCan } from "../../lib/session";
import { conciergeFetch as fetch } from "./api";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  HeartHandshake,
  LayoutDashboard,
  Layers3,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  X,
  Camera,
  ClipboardList,
  Activity,
  ImagePlus,
  Eye,
  Pencil,
  LogOut,
  KeyRound,
  UploadCloud,
  ArrowUpRight,
} from "lucide-react";
import type {
  WorkspaceData,
  TeamUser,
  Member,
  Appointment,
  Balance,
  Visit,
  Task,
  Receipt,
  Audit,
  Upload,
  CatalogItem,
  NativeMemberSummary,
} from "./types";
import { runReceiptOcr } from "./receipt-ocr";
import {
  ReceiptEditor,
  ReceiptDetail,
  BalanceDetail,
  applyDraftCatalog,
} from "./ReceiptExperience";
import { CatalogManager } from "./CatalogManager";
import type { ReceiptDraft } from "./ReceiptExperience";

type View =
  | "dashboard"
  | "members"
  | "appointments"
  | "followup"
  | "balances"
  | "segments"
  | "receipts"
  | "receiptArchive"
  | "tasks"
  | "manager";
type Modal = {
  kind:
    | "member"
    | "appointment"
    | "visit"
    | "task"
    | "staff"
    | "password";
  key: string;
  member?: Member;
  initialNative?: NativeMemberSummary;
  appointment?: Appointment;
  visit?: Visit;
  task?: Task;
  staff?: TeamUser;
  taskKind?: "回访" | "交班";
};
const NAV = [
  { id: "dashboard", label: "今日工作台", icon: LayoutDashboard },
  { id: "members", label: "会员档案", icon: Users },
  { id: "appointments", label: "预约与接待", icon: CalendarDays },
  { id: "receipts", label: "管家好评中心", icon: Sparkles },
  { id: "followup", label: "重点跟进", icon: HeartHandshake },
  { id: "balances", label: "会员情况", icon: Users },
  { id: "tasks", label: "待办与交班", icon: ClipboardList },
  { id: "segments", label: "会员中心", icon: Layers3 },
] as const;
const TITLES: Record<View, [string, string]> = {
  dashboard: ["今日工作台", "把接待、拍单与后续安排，接续在同一份会员档案中。"],
  members: ["会员档案", "查看全体系统会员，接续同一份管家服务档案。"],
  appointments: [
    "预约与接待",
    "管家协调预约；正式房间、技师占用请以前台预约为准。",
  ],
  receipts: ["管家好评中心", "记录被客人认可的服务，让每一份好评都有依据。"],
  receiptArchive: ["消费凭证历史", "查看历史小票、识别草稿与原始图片。"],
  followup: ["重点跟进", "关注低余额与后续需求，记录实际结果。"],
  balances: ["会员情况", "从真实到访记录识别沉睡会员，安排有针对性的服务跟进。"],
  segments: ["会员中心", "按会员系统的档阶查看分布与会员名单。"],
  tasks: ["待办与交班", "让待回复、待处理和待接收的事项都有下一负责人。"],
  manager: ["经理监管", "从工作汇总追到明细、操作账号与原始凭证。"],
};
const APPT_STATUS = [
  "待确认",
  "已确认",
  "已到店",
  "已完成",
  "已取消",
  "未到店",
];
const TASK_STATUS = ["待处理", "处理中", "待接收", "已接收", "已完成"];
// 操作编号：内网用 http://IP 打开时没有 crypto.randomUUID（只在 HTTPS / localhost 下有），统一用带降级的 uuid()（8.0.15）
const uid = (): string => uuid();
function dayKey(value: string | Date = new Date()) {
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
function localTime(value?: string) {
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
function iso(value: string) {
  if (!value) return "";
  return new Date(
    `${value}${value.length === 16 ? ":00" : ""}+08:00`,
  ).toISOString();
}
// 显示用的金额、时间都走 ./format（全店同一套，8.0.18）
function date(value?: string, time = true) {
  if (!value) return "尚未记录";
  return time ? shortStamp(value, "时间待核") : dayStamp(value, "时间待核");
}
function time(value?: string) {
  return clock(value);
}
function amount(n: number | null | undefined) {
  return n == null ? "" : (n / 100).toFixed(2);
}
function initial(s: string) {
  return s.trim().slice(0, 1) || "会";
}
function download(
  content: string,
  name: string,
  type = "text/csv;charset=utf-8;",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csv(rows: unknown[][]) {
  const safe = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return "\uFEFF" + rows.map((r) => r.map(safe).join(",")).join("\r\n");
}
function Field({
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
function Status({ value }: { value: string }) {
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
function Empty({
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
function Dialog({
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

export default function Workspace({
  initialData,
}: {
  initialData: WorkspaceData;
}) {
  const canNative = useCan();
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<View>("dashboard");
  const [insightBucket, setInsightBucket] = useState<"" | "dormant">("");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [owner, setOwner] = useState("");
  const [day, setDay] = useState(dayKey());
  const [mobile, setMobile] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [dirty, setDirty] = useState(false);
  const [nativePreviewId, setNativePreviewId] = useState<number | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState("timeline");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [lastSync, setLastSync] = useState(initialData.sync?.serverTime || "");
  const [syncError, setSyncError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [capture, setCapture] = useState<{ memberId: string } | null>(null);
  const [receiptDetailId, setReceiptDetailIdState] = useState<string | null>(
    null,
  );
  const [balanceDetailId, setBalanceDetailId] = useState<string | null>(null);
  const [receiptEditor, setReceiptEditor] = useState<{
    receipt?: Receipt;
    draft?: ReceiptDraft;
    key: string;
  } | null>(null);
  const [taskScope, setTaskScope] = useState("mine");
  const [taskFilter, setTaskFilter] = useState("open");
  const [receiptFilter, setReceiptFilter] = useState("all");
  const [apptTab, setApptTab] = useState("appointments");
  const [adminTab, setAdminTab] = useState("overview");
  const [auditActor, setAuditActor] = useState("");
  const [auditType, setAuditType] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [auditSearch, setAuditSearch] = useState("");
  const [auditDetail, setAuditDetailState] = useState<Audit | null>(null);
  const [timelineType, setTimelineType] = useState("all");
  const [timelineMonth, setTimelineMonth] = useState("");
  const [timelineLimit, setTimelineLimit] = useState(20);
  const [backupBusy, setBackupBusy] = useState(false);
  async function setReceiptDetailId(id: string | null) {
    if (!id) {
      setReceiptDetailIdState(null);
      return;
    }
    try {
      const r = await loadReceipt(id);
      setData((d) => ({
        ...d,
        receipts: [r, ...d.receipts.filter((x) => x.id !== id)],
      }));
      setReceiptDetailIdState(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function setAuditDetail(a: Audit | null) {
    if (!a) {
      setAuditDetailState(null);
      return;
    }
    try {
      const detail = await api.get<Audit>(
        `/api/concierge/audits/${encodeURIComponent(a.id)}`,
      );
      setAuditDetailState(detail);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const mutationKeys = useRef(
    new Map<string, { fingerprint: string; requestId: string }>(),
  );
  const currentData = useRef(initialData);
  const request = useRef(0);
  const mounted = useRef(true);
  const saving = useRef(false);
  const modalRequest = useRef("");
  const noteRequest = useRef("");
  const manager = data.user.role === "manager";
  const today = dayKey();
  const team = data.team.filter((t) => t.active);
  const visits = data.visits || [];
  const tasks = data.tasks || [];
  const receipts = data.receipts || [];
  const audits = data.audits || [];
  const memberMap = useMemo(
    () => new Map(data.members.map((m) => [m.id, m])),
    [data.members],
  );
  const member = drawerId ? memberMap.get(drawerId) : undefined;
  const balances = useMemo(() => {
    const m = new Map<string, Balance>();
    for (const b of data.balances) if (!m.has(b.memberId)) m.set(b.memberId, b);
    return m;
  }, [data.balances]);
  const staff = (id: string) =>
    data.team.find((t) => t.id === id)?.name || "待分配";
  const memberName = (id: string) => memberMap.get(id)?.name || "待匹配会员";
  const balanceGroup = (m: Member) => balanceGroupOf(m,balances.get(m.id));
  const servedMembers=uniqueMembers(data.members);
  const lowMembers = servedMembers.filter((m) => balanceGroup(m) === "low");
  const checkedTotal = servedMembers.reduce((n,m)=>n+(m.nativeMember?.totalCents || 0),0);
  const todayAppointments = data.appointments
    .filter((a) => dayKey(a.startAt) === today && a.status !== "已取消")
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const openTasks = tasks.filter((t) => t.status !== "已完成");
  const mine = openTasks.filter((t) => t.assigneeId === data.user.id);
  const overdue = openTasks.filter(
    (t) => t.dueAt && new Date(t.dueAt).getTime() < Date.now(),
  );
  // 自动同步（整改）：上一次还没回来不再发下一次；连不上时逐步放慢（最多隔 30 秒），连上就恢复；
  // 同步版本号没变就不换数据——原来每 3 秒不管变没变都整个换一遍，整页重新渲染、开着的编辑器跟着重算。
  const polling = useRef(false);
  const pollSkip = useRef(0);
  const pollFailures = useRef(0);
  const refresh = useCallback(async (quiet = false, force = false) => {
    if (saving.current && !force) return;
    if (quiet && !force) {
      if (polling.current) return;
      if (pollSkip.current > 0) {
        pollSkip.current -= 1;
        return;
      }
    }
    if (!quiet) setRefreshing(true);
    const id = ++request.current;
    polling.current = true;
    try {
      const { data: loaded, changed } = await loadWorkspace(force);
      pollFailures.current = 0;
      pollSkip.current = 0;
      if (mounted.current && id === request.current) {
        // 版本号或原生指纹变了：告诉页面里各自取数的部件（会员名单、扣费明细、好评……）跟着取一次
        if (changed) announceRevision();
        if (changed || currentData.current !== loaded) {
          // 换一个新的对象引用，页面才会重新渲染
          const next = { ...loaded };
          currentData.current = loaded;
          setData(next);
        }
        setLastSync(loaded.sync?.serverTime || new Date().toISOString());
        setSyncError("");
      }
    } catch (e) {
      pollFailures.current = Math.min(pollFailures.current + 1, 4);
      // 3 秒一拍：失败 1、2、3、4 次以后分别隔 1、3、5、9 拍再试
      pollSkip.current = [0, 1, 3, 5, 9][pollFailures.current]!;
      if (mounted.current)
        setSyncError(e instanceof Error ? e.message : "网络连接失败");
    } finally {
      polling.current = false;
      if (mounted.current && !quiet) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const sync = () => {
      if (document.visibilityState === "visible" && navigator.onLine !== false)
        void refresh(true);
    };
    // 回到页面、数据有变、重新联网：马上同步一次，不等放慢的那几拍
    const now = () => {
      pollSkip.current = 0;
      sync();
    };
    const timer = setInterval(sync, 3000);
    window.addEventListener("concierge-data-changed", now);
    window.addEventListener("focus", now);
    window.addEventListener("online", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("concierge-data-changed", now);
      window.removeEventListener("focus", now);
      window.removeEventListener("online", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [refresh]);
  // 凭证详情开着的时候同事保存了这一张：同步回来的是新版本的摘要（没有明细），重新取完整的，
  // 不让详情悄悄变成空的
  const detailReload = useRef("");
  useEffect(() => {
    if (!receiptDetailId) return;
    const shown = data.receipts.find((r) => r.id === receiptDetailId);
    if (!shown || (shown as { items?: unknown }).items !== undefined) return;
    const mark = `${shown.id}:${shown.version}`;
    if (detailReload.current === mark) return;
    detailReload.current = mark;
    void setReceiptDetailId(receiptDetailId);
  }, [data.receipts, receiptDetailId]);
  useEffect(() => {
    if (!drawerId) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, [drawerId]);
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(""), 4500);
    return () => clearTimeout(t);
  }, [success]);
  async function mutate(
    action: string,
    payload: Record<string, unknown>,
    operationKey = uid(),
  ) {
    if (saving.current) return false;
    const fingerprint = JSON.stringify({ action, payload });
    const previous = mutationKeys.current.get(operationKey);
    if (
      previous &&
      previous.fingerprint !== fingerprint &&
      pendingRequests().some((p) => p.requestId === previous.requestId)
    ) {
      setError(
        "上一次操作结果待确认，请先查回或确认不再执行，不能改内容另建同一笔。",
      );
      return false;
    }
    const requestId =
      previous?.fingerprint === fingerprint
        ? previous.requestId
        : previous
          ? uid()
          : operationKey;
    mutationKeys.current.set(operationKey, { fingerprint, requestId });
    if (mutationKeys.current.size > 100)
      mutationKeys.current.delete(mutationKeys.current.keys().next().value!);
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/concierge/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload, requestId }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error || "保存失败，请稍后重试。");
      await refresh(true, true);
      setSuccess("记录已保存");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请检查网络后重试。");
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function saveCatalogItem(
    payload: Record<string, unknown>,
    operationKey: string,
  ): Promise<CatalogItem[] | null> {
    if (!(await mutate("saveCatalogItem", payload, operationKey))) return null;
    const list = currentData.current.catalog || [];
    const saved = payload.id
      ? list.find(
          (i) =>
            i.id === payload.id && i.version > Number(payload.version || 0),
        )
      : list.find(
          (i) =>
            i.name === String(payload.name || "").trim() &&
            i.spec === String(payload.spec || "").trim(),
        );
    if (!saved) {
      setError("名称已提交，目录暂未同步。当前小票与输入保留，请稍后重试。");
      return null;
    }
    return list;
  }
  function navigate(v: View) {
    setView(v);
    setInsightBucket("");
    setSearch("");
    setOwner("");
    setGroup("all");
    setMobile(false);
  }
  function openModal(value: Omit<Modal, "key">) {
    const key = uid();
    modalRequest.current = key;
    setModal({ ...value, key });
    setDirty(false);
    setError("");
  }
  function closeModal() {
    if (busy) return;
    if (dirty && !confirm("还有未保存的内容，确定关闭吗？")) return;
    setModal(null);
    setDirty(false);
    setError("");
  }
  function openMember(id: string) {
    noteRequest.current = uid();
    setDrawerId(id);
    setDrawerTab("timeline");
    setTimelineType("all");
    setTimelineMonth("");
    setTimelineLimit(20);
  }
  function openSystemMember(native: InsightMember) {
    const profile = native.profiles.find((p) => memberMap.has(p.id));
    if (profile) openMember(profile.id);
    else setNativePreviewId(native.id);
  }
  function viewReceipt(r: Receipt) {
    setReceiptDetailId(r.id);
    setError("");
  }
  // 编辑前一定先取完整的这一张（整改）：列表里的是摘要，没有逐项明细与识别原文。
  // 原来直接拿列表里的去编辑——同事刚保存过、列表换成新摘要以后点「编辑」再保存，明细与原文就被清空了。
  async function editReceipt(r: Receipt) {
    setError("");
    try {
      const full = await loadReceipt(r.id);
      setData((d) => ({
        ...d,
        receipts: [full, ...d.receipts.filter((x) => x.id !== full.id)],
      }));
      setReceiptEditor({ receipt: full, key: uid() });
    } catch (e) {
      setError(
        `这张凭证的明细没有取到，请联网后再点编辑：${e instanceof Error ? e.message : ""}`,
      );
    }
  }
  const matches = (m: Member) => {
    const q = search.trim().toLowerCase();
    return (
      (!q ||
        `${m.code} ${m.name} ${m.phone} ${m.cardNo} ${memberGrade(m)} ${m.nativeMember?.memberNo || ""} ${m.serviceAlias || ""}`
          .toLowerCase()
          .includes(q)) &&
      (!owner || m.ownerId === owner) &&
      (group === "all" || (m.nativeMember && String(m.nativeMember.grade) === group))
    );
  };
  const filteredMembers = data.members.filter(matches);
  const selectedAppointments = data.appointments
    .filter(
      (a) =>
        dayKey(a.startAt) === day &&
        (!owner || a.hostId === owner) &&
        (!search ||
          `${memberName(a.memberId)} ${a.service} ${resourceLabel(a)}`.includes(
            search,
          )),
    )
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const selectedReceipts = receipts.filter(
    (r) =>
      (receiptFilter === "all" || receiptFilter === "unconfirmed"
        ? !["已确认", "已作废"].includes(r.status) || receiptFilter === "all"
        : r.status === receiptFilter) &&
      (!owner || r.createdByName === staff(owner)) &&
      (!search ||
        `${r.number} ${r.store} ${memberName(r.memberId)} ${r.createdByName}`.includes(
          search,
        )),
  );
  const selectedTasks = tasks.filter(
    (t) =>
      (taskScope === "all" || t.assigneeId === data.user.id) &&
      (taskFilter === "all" || taskFilter === "open"
        ? taskFilter === "all" || t.status !== "已完成"
        : taskFilter === "overdue"
          ? t.status !== "已完成" &&
            !!t.dueAt &&
            new Date(t.dueAt).getTime() < Date.now()
          : taskFilter === "handoff"
            ? t.kind === "交班"
            : t.status === taskFilter) &&
      (!search ||
        `${t.content} ${t.result} ${memberName(t.memberId)}`.includes(search)),
  );
  const selectedAudits = audits.filter(
    (a) =>
      (!auditActor || a.actorId === auditActor) &&
      (!auditType || a.objectType === auditType) &&
      (!auditFrom || dayKey(a.createdAt) >= auditFrom) &&
      (!auditTo || dayKey(a.createdAt) <= auditTo) &&
      (!auditSearch ||
        `${a.actorName} ${a.action} ${a.objectId} ${a.reason} ${memberName(a.memberId)}`.includes(
          auditSearch,
        )),
  );
  async function backup() {
    setBackupBusy(true);
    setError("");
    try {
      const res = await fetch("/api/concierge/backup", { cache: "no-store" });
      if (!res.ok) {
        const b = (await res.json()) as { error?: string };
        throw new Error(b.error || "备份导出失败");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `汤崎管家_完整备份_${today}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setSuccess("备份文件已生成，请妥善保存");
      void refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "备份导出失败");
    } finally {
      setBackupBusy(false);
    }
  }
  function exportMembers() {
    download(
      csv([
        [
          "服务档案编码",
          "系统姓名",
          "手机",
          "收银卡号",
          "系统档阶",
          "负责管家",
          "建档日期",
          "系统实时余额",
          "系统本金",
          "系统可用赠金",
          "导出时间",
          "历史人工核对余额",
          "历史核对时间",
          "历史核对人",
          "建档人",
          "最后修改人",
        ],
        ...filteredMembers.map((m) => {
          const b = balances.get(m.id);
          return [
            m.code,
            m.name,
            m.phone,
            m.cardNo,
            memberGrade(m),
            staff(m.ownerId),
            m.joinedAt,
            m.nativeMember ? amount(m.nativeMember.totalCents) : "待关联系统会员",
            m.nativeMember ? amount(m.nativeMember.principalCents) : "",
            m.nativeMember ? amount(m.nativeMember.bonusCents) : "",
            new Date().toISOString(),
            b ? amount(b.amountCents) : "",
            b?.checkedAt,
            b?.actorName,
            m.createdByName,
            m.updatedByName,
          ];
        }),
      ]),
      `会员档案_${today}.csv`,
    );
  }
  async function exportAudits() {
    setError("");
    try {
      const params = new URLSearchParams({
        actor: auditActor,
        type: auditType,
        from: auditFrom,
        to: auditTo,
        q: auditSearch,
      });
      const response = await window.fetch(
        `/api/concierge/audits/export?${params}`,
        { credentials: "same-origin" },
      );
      if (!response.ok)
        throw new Error("完整审计导出失败，请核对权限和网络后重试");
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `管家操作日志_当前筛选_${today}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submitModal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!modal || busy) return;
    const fd = new FormData(e.currentTarget);
    const s = (k: string) => String(fd.get(k) || "").trim();
    let action = "",
      p: Record<string, unknown> = {};
    try {
      if (modal.kind === "member") {
        if (!modal.member && !s("nativeMemberId")) {
          setError("请先选择前台已办理的系统会员，再建立服务档案。");return;
        }
        if (!s("phone") && !s("cardNo")) {
          setError("手机号和收银卡号至少填写一项。");
          return;
        }
        p = {
          ...(fd.has("nativeMemberId")
            ? { nativeMemberId: s("nativeMemberId") }
            : {}),
          name: s("name"),
          phone: s("phone"),
          cardNo: s("cardNo"),
          ownerId: s("ownerId"),
          cardTier: s("cardTier"),
          serviceAlias: s("serviceAlias"),
          preferences: s("preferences"),
          source: s("source"),
          joinedAt: s("joinedAt"),
        };
        if (modal.member) {
          action = "updateMember";
          p = {
            ...p,
            id: modal.member.id,
            version: modal.member.version,
            changeReason: s("changeReason"),
          };
        } else {
          action = "createMember";

        }
      }
      if (modal.kind === "appointment") {
        action = modal.appointment ? "updateAppointment" : "createAppointment";
        p = {
          ...(fd.has("nativeBookingId")
            ? { nativeBookingId: s("nativeBookingId") }
            : {}),
          memberId: s("memberId"),
          startAt: iso(s("startAt")),
          endAt: iso(s("endAt")),
          partySize: Number(s("partySize")),
          service: s("service"),
          resource: s("resource"),
          resourceKey: s("resourceKey"),
          resourceCategory: s("resourceCategory"),
          resourceGroup: s("resourceGroup"),
          status: s("status"),
          hostId: s("hostId"),
          note: s("note"),
        };
        if (s("endAt") && String(p.endAt) <= String(p.startAt)) {
          setError("结束时间需晚于开始时间。");
          return;
        }
        if (modal.appointment)
          p = {
            ...p,
            id: modal.appointment.id,
            version: modal.appointment.version,
            changeReason: s("changeReason"),
          };
      }
      if (modal.kind === "visit") {
        action = "saveVisit";
        p = {
          ...(modal.visit
            ? { id: modal.visit.id, version: modal.visit.version }
            : {}),
          memberId: s("memberId"),
          appointmentId: s("appointmentId"),
          hostId: s("hostId"),
          partySize: Number(s("partySize")),
          status: s("status"),
          feedback: s("feedback"),
          pending: s("pending"),
          reason: s("reason"),
        };
      }
      if (modal.kind === "task") {
        action = "saveTask";
        p = {
          ...(modal.task
            ? { id: modal.task.id, version: modal.task.version }
            : {}),
          memberId: s("memberId"),
          kind: s("kind"),
          category: s("category"),
          content: s("content"),
          assigneeId: s("assigneeId"),
          dueAt: iso(s("dueAt")),
          status: s("status"),
          result: s("result"),
          nextAction: s("nextAction"),
          reason: s("reason"),
        };
      }
      if (modal.kind === "staff") {
        action = modal.staff ? "updateStaff" : "createStaff";
        p = modal.staff
          ? {
              id: modal.staff.id,
              name: s("name"),
              role: s("role"),
              active: fd.get("active") === "on",
            }
          : {
              name: s("name"),
              login: s("login"),
              password: s("password"),
              role: s("role"),
            };
      }
      if (modal.kind === "password") {
        action = "setStaffPassword";
        p = { id: modal.staff!.id, login: s("login"), password: s("password") };
      }
      if (await mutate(action, p, modalRequest.current)) {
        setModal(null);
        setDirty(false);
      }
    } catch {
      setError("请检查日期和字段内容。");
    }
  }
  async function submitNote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!member) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    if (
      await mutate(
        "saveNote",
        {
          memberId: member.id,
          content: String(f.get("content") || "").trim(),
          nextAt: iso(String(f.get("nextAt") || "")),
        },
        noteRequest.current || uid(),
      )
    ) {
      form.reset();
      noteRequest.current = uid();
    }
  }
  const BalanceValue = ({ m }: { m: Member }) => {
    const amount = currentBalance(m,balances.get(m.id));
    return amount != null ? (
      <span
        className={`balance-amount ${amount < 3000000 ? "orange-text" : ""}`}
      >
        ¥ {money(amount)}
      </span>
    ) : (
      <span className="muted">{m.nativeMemberId ? "系统余额暂不可用" : "待关联系统会员"}</span>
    );
  };
  const memberSelect = (selected = "", name = "memberId", required = true) => (
    <select name={name} defaultValue={selected} required={required}>
      <option value="">选择会员</option>
      {data.members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.code} · {m.name}
          {m.phone ? ` · ${m.phone}` : ""}
        </option>
      ))}
    </select>
  );
  const staffSelect = (selected = "", name = "hostId", required = false) => (
    <select name={name} defaultValue={selected} required={required}>
      <option value="">待分配</option>
      {data.team
        .filter((t) => t.active || t.id === selected)
        .map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {!t.active ? "（已停用）" : ""}
          </option>
        ))}
    </select>
  );
  function MemberTable({
    items,
    kind = "member",
  }: {
    items: Member[];
    kind?: "member" | "followup";
  }) {
    return items.length ? (
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>系统会员 / 服务档案</th>
              <th>系统档阶 / 会员号</th>
              <th>当前余额</th>
              <th>{kind === "followup" ? "最近跟进" : "负责管家"}</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m, i) => {
              const b = balances.get(m.id);
              const n = data.notes.find((n) => n.memberId === m.id);
              return (
                <tr key={m.id}>
                  <td>
                    <button
                      className="member-cell"
                      onClick={() => openMember(m.id)}
                    >
                      <span className={`avatar avatar-${i % 3}`}>
                        {initial(m.name)}
                      </span>
                      <span>
                        <strong>
                          {m.name}
                          <em className="member-code">{m.code}</em>
                        </strong>
                        <small>{m.phone || "未填写手机号"}</small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="tier-tag">
                      {memberGrade(m)}
                    </span>
                    <small className="cell-sub">
                      {m.nativeMember?.memberNo || "待关联系统会员"}
                    </small>
                  </td>
                  <td>
                    <button
                      className="balance-open-button"
                      onClick={() =>
                        m.nativeMember
                          ? (openMember(m.id),setDrawerTab("receipts"))
                          : b
                          ? setBalanceDetailId(b.id)
                          : openMember(m.id)
                      }
                    >
                      <BalanceValue m={m} />
                      <small>{m.nativeMember ? "系统实时" : "待关联"}</small>
                      {b && <Eye size={13} />}
                    </button>
                    {balanceGroup(m)==="low" && (
                      <small className="cell-sub orange-text">低余额关注</small>
                    )}
                  </td>
                  <td>
                    {kind === "followup" ? (
                      <>
                        <span className="truncate note-preview">
                          {n?.content || "暂无服务记录"}
                        </span>
                        <small className="cell-sub">
                          {n?.nextAt
                            ? `下次跟进 ${date(n.nextAt)}`
                            : staff(m.ownerId)}
                        </small>
                      </>
                    ) : (
                      staff(m.ownerId)
                    )}
                  </td>
                  <td>
                    <div className="table-actions">
                      <button
                        className="text-btn"
                        onClick={() => openMember(m.id)}
                      >
                        查看档案
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty
        icon={Users}
        title={
          search || owner || group !== "all"
            ? "没有符合条件的会员"
            : kind === "followup"
              ? "暂无低余额会员"
              : "还没有会员档案"
        }
        text={
          kind === "followup"
            ? "系统余额低于3万元的会员会显示在这里。"
            : "选择前台已办理会员，为其建立管家服务记录。"
        }
        action={!data.members.length ? "建立服务档案" : undefined}
        onAction={() => openModal({ kind: "member" })}
      />
    );
  }
  function FilterBar({ segments = true }: { segments?: boolean }) {
    return (
      <div className="filter-bar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="搜索会员"
            placeholder="姓名、编码、手机、收银卡号"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button aria-label="清空搜索" onClick={() => setSearch("")}>
              <X size={14} />
            </button>
          )}
        </label>
        <div className="filter-selects">
          {segments && (
            <select
              aria-label="会员档阶"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            >
              <option value="all">全部会员档阶</option>
              {Array.from({ length: 7 }, (_, grade) => <option key={grade} value={grade}>{"L" + grade}</option>)}
            </select>
          )}
          <select
            aria-label="负责管家"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            <option value="">全部管家</option>
            {data.team.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }
  function AppointmentList({
    items,
    compact = false,
  }: {
    items: Appointment[];
    compact?: boolean;
  }) {
    return items.length ? (
      <div className={`appointment-list ${compact ? "compact" : ""}`}>
        {items.map((a) => (
          <article className="appointment-row" key={a.id}>
            <div className="appointment-time">
              <strong>{time(a.startAt)}</strong>
              <small>{a.endAt ? time(a.endAt) : "到店"}</small>
            </div>
            <div className="appointment-line" />
            <div className="appointment-info">
              <button
                className="name-button"
                onClick={() => openMember(a.memberId)}
              >
                {memberName(a.memberId)}
                <span className="muted">{a.partySize}位</span>
              </button>
              <p>
                {dayKey(a.startAt) !== today && `${date(a.startAt, false)} · `}
                {a.service}
                {resourceLabel(a) && ` · ${resourceLabel(a)}`}
              </p>
              <small>
                <Users size={12} />
                {staff(a.hostId)}
                <span className="record-actor">
                  录入：{a.createdByName || "已记录"}
                </span>
              </small>
            </div>
            <div className="appointment-tail">
              <Status value={a.status} />
              <div className="row-mini-actions">
                {["待确认", "已确认"].includes(a.status) && (
                  <button
                    className="text-btn"
                    onClick={() => {
                      const existing = visits.find(
                        (v) => v.appointmentId === a.id,
                      );
                      openModal(
                        existing
                          ? { kind: "visit", visit: existing }
                          : {
                              kind: "visit",
                              member: memberMap.get(a.memberId),
                              appointment: a,
                            },
                      );
                    }}
                  >
                    {visits.some((v) => v.appointmentId === a.id)
                      ? "更新接待"
                      : "到店接待"}
                  </button>
                )}
                <button
                  className="icon-btn"
                  aria-label="编辑预约"
                  onClick={() =>
                    openModal({ kind: "appointment", appointment: a })
                  }
                >
                  <Pencil size={15} />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    ) : (
      <Empty
        icon={CalendarDays}
        title="暂无预约安排"
        text="由管家代录预约，核实资源后再确认。"
        action="新增预约"
        onAction={() => openModal({ kind: "appointment" })}
      />
    );
  }
  function VisitList({ items }: { items: Visit[] }) {
    return items.length ? (
      <div className="record-list">
        {items.map((v) => (
          <article className="record-card" key={v.id}>
            <div className="record-heading">
              <button
                className="name-button"
                onClick={() => openMember(v.memberId)}
              >
                {memberName(v.memberId)}
                <span className="muted">{v.partySize}位</span>
              </button>
              <Status value={v.status} />
            </div>
            <p>
              {date(v.createdAt)} · 本次管家：{staff(v.hostId)}
            </p>
            {v.feedback && (
              <div className="record-copy">反馈：{v.feedback}</div>
            )}
            {v.pending && (
              <div className="record-copy orange-text">未结：{v.pending}</div>
            )}
            <div className="record-footer">
              <small>登记：{v.createdByName}</small>
              <button
                className="text-btn"
                onClick={() =>
                  openModal({
                    kind: "task",
                    member: memberMap.get(v.memberId),
                    taskKind: "交班",
                  })
                }
              >
                创建交班
              </button>
              <button
                className="text-btn"
                onClick={() => openModal({ kind: "visit", visit: v })}
              >
                {v.status === "接待中" ? "更新 / 完成" : "查看 / 调整"}
                <ArrowRight size={13} />
              </button>
            </div>
          </article>
        ))}
      </div>
    ) : (
      <Empty
        icon={HeartHandshake}
        title="暂无接待记录"
        text="会员到店后，一键开始本次服务。"
        action="开始接待"
        onAction={() => openModal({ kind: "visit" })}
      />
    );
  }
  function TaskList({ items }: { items: Task[] }) {
    return items.length ? (
      <div className="record-list">
        {items.map((t) => {
          const late =
            t.status !== "已完成" &&
            !!t.dueAt &&
            new Date(t.dueAt).getTime() < Date.now();
          return (
            <article
              className={`record-card task-card ${late ? "overdue" : ""}`}
              key={t.id}
            >
              <div className="record-heading">
                <div className="task-title">
                  <span className="tier-tag">{t.kind}</span>
                  <button
                    className="name-button"
                    onClick={() => openMember(t.memberId)}
                  >
                    {memberName(t.memberId)}
                  </button>
                </div>
                <Status value={t.status} />
              </div>
              <div className="record-copy task-content">{t.content}</div>
              <p>
                {t.category} · {staff(t.assigneeId)}
                <span className={late ? "orange-text" : ""}>
                  {" "}
                  ·{" "}
                  {t.dueAt
                    ? `${date(t.dueAt)}${late ? " 已逾期" : "前处理"}`
                    : "未设置时限"}
                </span>
              </p>
              {t.result && <div className="record-copy">结果：{t.result}</div>}
              {t.nextAction && (
                <div className="record-copy">下一步：{t.nextAction}</div>
              )}
              <div className="record-footer">
                <small>创建：{t.createdByName}</small>
                {t.status === "待接收" &&
                  (t.assigneeId === data.user.id || manager) && (
                    <button
                      className="btn btn-secondary small-btn"
                      disabled={busy}
                      onClick={() =>
                        void mutate("saveTask", {
                          ...t,
                          version: t.version,
                          status: "已接收",
                          reason: "接收交班",
                        })
                      }
                    >
                      <Check size={13} />
                      接收交班
                    </button>
                  )}
                <button
                  className="text-btn"
                  onClick={() => openModal({ kind: "task", task: t })}
                >
                  {t.status === "已完成" ? "查看记录" : "更新 / 完成"}
                  <ArrowRight size={13} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    ) : (
      <Empty
        icon={ClipboardList}
        title="暂无符合条件的待办"
        text="后续联系或交班事项，可从会员档案一键创建。"
        action="新增待办"
        onAction={() => openModal({ kind: "task" })}
      />
    );
  }
  function ReceiptList({ items }: { items: Receipt[] }) {
    return items.length ? (
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>消费凭证 / 会员</th>
              <th>发生时间</th>
              <th>结算金额</th>
              <th>状态</th>
              <th>上传 / 确认</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>
                  <button
                    className="name-button"
                    onClick={() => viewReceipt(r)}
                  >
                    {r.number || "单号待核"}
                  </button>
                  <small className="cell-sub">
                    {memberName(r.memberId)} · {r.kind} · {r.uploadIds.length}
                    张图
                  </small>
                </td>
                <td>
                  {r.occurredAt ? date(r.occurredAt) : "时间待核"}
                  <small className="cell-sub">{r.store || "门店待核"}</small>
                </td>
                <td className="balance-amount">
                  {r.amountCents == null
                    ? "金额待核"
                    : `¥ ${money(r.amountCents)}`}
                </td>
                <td>
                  <Status value={r.status} />
                </td>
                <td>
                  {r.createdByName}
                  <small className="cell-sub">
                    {r.confirmedByName
                      ? `${r.confirmedByName} 已确认`
                      : "尚未确认"}
                  </small>
                </td>
                <td>
                  <div className="table-actions">
                    <button className="text-btn" onClick={() => viewReceipt(r)}>
                      查看消费明细
                      <ArrowRight size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty
        icon={Camera}
        title="还没有消费凭证"
        text="拍摄真实小票，识别后核对关键字段。消费记录不会自动扣减余额。"
        action="拍摄消费单"
        onAction={() => setCapture({ memberId: "" })}
      />
    );
  }
  return (
    <div className="concierge-workspace">
      <div className="workspace-shell">
        <div className="workspace-main">
          <header className="concierge-toolbar">
            <nav aria-label="管家业务模块">
              {NAV.map((n) => (
                <button
                  key={n.id}
                  className={view === n.id ? "selected" : ""}
                  onClick={() => navigate(n.id)}
                >
                  <n.icon size={15} />
                  {n.label}
                </button>
              ))}
              {manager && (
                <button
                  className={view === "manager" ? "selected" : ""}
                  onClick={() => navigate("manager")}
                >
                  <Settings2 size={15} />
                  经理监管
                </button>
              )}
            </nav>
            <button
              className="btn btn-secondary small-btn"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <RefreshCw size={15} />
              同步
            </button>
          </header>
          <div className="integration-note">
            会员资料、档阶与余额实时同步前台会员系统。
          </div>
          <main className="page-content">
            {success && (
              <div className="toast" role="status">
                <CheckCircle2 size={18} />
                {success}
              </div>
            )}
            {syncError && (
              <div className="alert alert-error" role="alert">
                <CircleHelp size={16} />
                <span>
                  同步暂时中断：{syncError}
                  。表单内容仍保留，保存请以成功提示为准。
                </span>
                <button onClick={() => void refresh()} className="text-btn">
                  重试
                </button>
              </div>
            )}
            {error && !modal && !receiptEditor && (
              <div className="alert alert-error" role="alert">
                <span>{error}</span>
                <button aria-label="关闭错误" onClick={() => setError("")}>
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="page-heading">
              <div>
                <h1>
                  {TITLES[view][0]}
                  {view === "dashboard" && (
                    <span className="heading-date">
                      {new Intl.DateTimeFormat("zh-CN", {
                        timeZone: "Asia/Shanghai",
                        month: "long",
                        day: "numeric",
                        weekday: "long",
                      }).format(new Date())}
                    </span>
                  )}
                </h1>
                <p>{TITLES[view][1]}</p>
              </div>
              <div className="heading-actions">
                {view === "receiptArchive" ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => setCapture({ memberId: "" })}
                  >
                    <Camera size={17} />
                    拍摄消费单
                  </button>
                ) : view === "receipts" ? null : view === "tasks" ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => openModal({ kind: "task" })}
                  >
                    <Plus size={17} />
                    新增待办
                  </button>
                ) : view === "manager" ? (
                  <button
                    className="btn btn-secondary"
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={15} />
                    刷新监管
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      openModal({
                        kind:
                          view === "appointments" ? "appointment" : "member",
                      })
                    }
                  >
                    <Plus size={17} />
                    {view === "appointments" ? "新增预约" : "建立服务档案"}
                  </button>
                )}
              </div>
            </div>
            {view === "dashboard" && (
              <>
                <div className="quick-actions">
                  {[
                    {
                      title: "建立服务档案",
                      sub: "选择前台会员，补充服务信息",
                      icon: Users,
                      fn: () => openModal({ kind: "member" }),
                    },
                    {
                      title: "代录预约",
                      sub: "确认需求，核实安排",
                      icon: CalendarDays,
                      fn: () => openModal({ kind: "appointment" }),
                    },
                    {
                      title: "拍消费单",
                      sub: "拍照识别，核对保存",
                      icon: Camera,
                      fn: () => setCapture({ memberId: "" }),
                    },
                    {
                      title: "处理待办",
                      sub: `${mine.length}项等待接续`,
                      icon: ClipboardList,
                      fn: () => navigate("tasks"),
                    },
                  ].map((a) => (
                    <button
                      className="quick-action"
                      key={a.title}
                      onClick={a.fn}
                    >
                      <span>
                        <a.icon size={20} />
                      </span>
                      <div>
                        <strong>{a.title}</strong>
                        <small>{a.sub}</small>
                      </div>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                </div>
                <section className="stats-grid">
                  {[
                    {
                      label: "服务会员",
                      value: servedMembers.length,
                      unit: "位",
                      icon: Users,
                      caption: "全员共享会员档案",
                      tone: "green",
                      fn: () => navigate("members"),
                    },
                    {
                      label: "今日预约",
                      value: todayAppointments.length,
                      unit: "组",
                      icon: CalendarDays,
                      caption: `${todayAppointments.filter((a) => a.status === "待确认").length}组待确认`,
                      tone: "blue",
                      fn: () => navigate("appointments"),
                    },
                    {
                      label: "低余额关注",
                      value: lowMembers.length,
                      unit: "位",
                      icon: Bell,
                      caption: "当前余额低于30,000元",
                      tone: "orange",
                      fn: () => navigate("followup"),
                    },
                    {
                      label: "待核消费凭证",
                      value: receipts.filter(
                        (r) => !["已确认", "已作废"].includes(r.status),
                      ).length,
                      unit: "单",
                      icon: FileText,
                      caption: "识别完成后仍需人工核对",
                      tone: "purple",
                      fn: () => {
                        navigate("receiptArchive");
                        setReceiptFilter("unconfirmed");
                      },
                    },
                  ].map((s) => (
                    <button
                      key={s.label}
                      className={`stat-card stat-${s.tone} clickable-stat`}
                      onClick={s.fn}
                    >
                      <div className="stat-top">
                        <span>{s.label}</span>
                        <span className="stat-icon">
                          <s.icon size={18} />
                        </span>
                      </div>
                      <div className="stat-value">
                        {s.value}
                        <small>{s.unit}</small>
                      </div>
                      <p>
                        {s.caption}
                        <ArrowRight size={12} />
                      </p>
                    </button>
                  ))}
                </section>
                <div className="dashboard-grid">
                  <section className="panel">
                    <div className="panel-header">
                      <div>
                        <span className="section-dot" />
                        <h2>今日预约</h2>
                        <span className="count-tag">
                          {todayAppointments.length}
                        </span>
                      </div>
                      <button
                        className="text-btn"
                        onClick={() => navigate("appointments")}
                      >
                        全部预约
                        <ArrowRight size={14} />
                      </button>
                    </div>
                    {AppointmentList({
                      items: todayAppointments.slice(0, 4),
                      compact: true,
                    })}
                  </section>
                  <section className="panel followup-panel">
                    <div className="panel-header">
                      <div>
                        <span className="section-dot orange" />
                        <h2>我的待办与交班</h2>
                        <span className="count-tag">{mine.length}</span>
                      </div>
                      <button
                        className="text-btn"
                        onClick={() => navigate("tasks")}
                      >
                        查看全部
                        <ArrowRight size={14} />
                      </button>
                    </div>
                    {mine.length ? (
                      <div className="compact-task-list">
                        {mine.slice(0, 4).map((t) => (
                          <button
                            key={t.id}
                            className="compact-task"
                            onClick={() => openModal({ kind: "task", task: t })}
                          >
                            <span className="task-dot" />
                            <span>
                              <strong>{t.content}</strong>
                              <small>
                                {memberName(t.memberId)} ·{" "}
                                {t.dueAt ? date(t.dueAt) : "待安排时间"}
                              </small>
                            </span>
                            <Status value={t.status} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        icon={ClipboardList}
                        title="当前没有待办"
                        text="待回复、需回访或需要交班的事项会集中显示。"
                      />
                    )}
                    <div className="panel-footer">
                      <ShieldCheck size={14} />
                      {overdue.length}项团队逾期事项 · 接收交班后继续跟进
                    </div>
                  </section>
                </div>
                <section className="panel recent-panel">
                  <div className="panel-header">
                    <div>
                      <span className="section-dot" />
                      <h2>最近建档会员</h2>
                    </div>
                    <button
                      className="text-btn"
                      onClick={() => navigate("members")}
                    >
                      全部档案
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  {MemberTable({ items: data.members.slice(0, 4) })}
                </section>
              </>
            )}
            {view === "members" && (<>
              <MemberInsightsView mode="directory" onOpen={openSystemMember} onNavigate={(target) => {
                navigate(target === "tiers" ? "segments" : "balances");
                if (target === "dormant") setInsightBucket("dormant");
              }} />
              {data.members.some((m) => !m.nativeMemberId) && <section className="panel legacy-service-panel">
                <details><summary>未关联系统会员的历史服务档案（{data.members.filter((m) => !m.nativeMemberId).length}份）</summary>
                  <p className="insights-rule">历史记录保留；关联前不将人工余额当作当前系统余额。</p>
                  {MemberTable({ items: data.members.filter((m) => !m.nativeMemberId) })}
                </details>
              </section>}
            </>)}
            {view === "appointments" && (
              <>
                <div className="info-strip">
                  <CalendarDays size={16} />
                  <span>
                    普通到店可不填结束时间；资源需实际核实后确认。本工具不替代各区域资源库存。
                  </span>
                </div>
                <section className="panel">
                  <div className="sectiontabs">
                    <button
                      className={apptTab === "appointments" ? "selected" : ""}
                      onClick={() => setApptTab("appointments")}
                    >
                      预约安排
                    </button>
                    <button
                      className={apptTab === "visits" ? "selected" : ""}
                      onClick={() => setApptTab("visits")}
                    >
                      到店服务
                      <span>
                        {visits.filter((v) => v.status === "接待中").length}
                      </span>
                    </button>
                  </div>
                  <div className="panel-header appointment-header">
                    <div>
                      <h2>
                        {apptTab === "appointments" ? "接待日程" : "服务记录"}
                      </h2>
                      {apptTab === "visits" && (
                        <button
                          className="text-btn"
                          onClick={() => openModal({ kind: "visit" })}
                        >
                          无预约开始接待
                          <Plus size={13} />
                        </button>
                      )}
                    </div>
                    <div className="date-controls">
                      <button
                        className="icon-btn"
                        aria-label="前一天"
                        onClick={() =>
                          setDay(
                            dayKey(
                              new Date(
                                new Date(`${day}T12:00:00+08:00`).getTime() -
                                  86400000,
                              ),
                            ),
                          )
                        }
                      >
                        <ChevronLeft size={18} />
                      </button>
                      <input
                        aria-label="预约日期"
                        type="date"
                        value={day}
                        onChange={(e) => setDay(e.target.value || today)}
                      />
                      <button
                        className="icon-btn"
                        aria-label="后一天"
                        onClick={() =>
                          setDay(
                            dayKey(
                              new Date(
                                new Date(`${day}T12:00:00+08:00`).getTime() +
                                  86400000,
                              ),
                            ),
                          )
                        }
                      >
                        <ChevronRight size={18} />
                      </button>
                      <button
                        className="text-btn"
                        onClick={() => setDay(today)}
                      >
                        今天
                      </button>
                    </div>
                  </div>
                  {apptTab === "appointments"
                    ? AppointmentList({ items: selectedAppointments })
                    : VisitList({
                        items: visits.filter(
                          (v) => dayKey(v.createdAt) === day,
                        ),
                      })}
                </section>
              </>
            )}
            {view === "receipts" && <PraiseCenter data={data} busy={busy} saveError={error} onMutate={mutate} />}
            {view === "receiptArchive" && (
              <>
                <div className="info-strip">
                  <ShieldCheck size={16} />
                  <span>
                    图片先保存，再在浏览器中识别。识别结果是草稿，消费确认不自动扣余额；未核记录不计入已确认消费。
                  </span>
                </div>
                <section className="panel">
                  <div className="panel-header">
                    <div>
                      <h2>消费凭证中心</h2>
                      <span className="count-tag">{receipts.length}单</span>
                    </div>
                    <span className="muted small">仅本系统已登记凭证</span>
                  </div>
                  <div className="filter-bar">
                    <label className="search-field">
                      <Search size={16} />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="单号、会员、门店、上传人"
                        aria-label="搜索消费凭证"
                      />
                    </label>
                    <div className="filter-selects">
                      <select
                        value={receiptFilter}
                        onChange={(e) => setReceiptFilter(e.target.value)}
                        aria-label="凭证状态"
                      >
                        <option value="all">全部状态</option>
                        <option value="unconfirmed">全部未确认</option>
                        {["待核对", "待补全", "待复核", "已确认", "已作废"].map(
                          (s) => (
                            <option key={s}>{s}</option>
                          ),
                        )}
                      </select>
                      <button
                        className="btn btn-secondary"
                        onClick={() =>
                          setReceiptEditor({ draft: {}, key: uid() })
                        }
                      >
                        <Pencil size={14} />
                        手工登记
                      </button>
                    </div>
                  </div>
                  {ReceiptList({ items: selectedReceipts })}
                  <div className="table-footer">
                    当前筛选 {selectedReceipts.length} 单
                    <span>
                      确认消费 ¥
                      {money(
                        selectedReceipts
                          .filter(
                            (r) => r.status === "已确认" && r.kind === "结算单",
                          )
                          .reduce((n, r) => n + (r.amountCents || 0), 0),
                      )}
                    </span>
                  </div>
                </section>
              </>
            )}
            {view === "followup" && (
              <>
                <div className="info-strip warm">
                  <Bell size={16} />
                  <span>
                    系统当前余额严格低于30,000元的会员列入重点；未关联档案不按人工金额计入。低余额不取消管家服务。
                  </span>
                </div>
                <section className="panel">
                  <div className="panel-header">
                    <div>
                      <h2>低余额关注名单</h2>
                      <span className="count-tag orange-count">
                        {lowMembers.length}位
                      </span>
                    </div>
                  </div>
                  {FilterBar({ segments: false })}
                  {MemberTable({
                    items: uniqueMembers(filteredMembers)
                      .filter((m) => balanceGroup(m) === "low")
                      .sort(
                        (a, b) =>
                          (currentBalance(a,balances.get(a.id)) ?? Number.MAX_SAFE_INTEGER) -
                          (currentBalance(b,balances.get(b.id)) ?? Number.MAX_SAFE_INTEGER),
                      ),
                    kind: "followup",
                  })}
                  <div className="panel-footer">
                    <HeartHandshake size={14} />
                    从会员详情创建回访任务，记录实际联系结果，不自动高频催访。
                  </div>
                </section>
              </>
            )}
            {view === "balances" && <MemberInsightsView key={"situation-" + insightBucket} mode="situation" initialBucket={insightBucket} onOpen={openSystemMember} />}
            {view === "segments" && <MemberInsightsView mode="tiers" onOpen={openSystemMember} />}
            {view === "tasks" && (
              <section className="panel">
                <div className="panel-header">
                  <div>
                    <h2>待办与交班</h2>
                    <span className="count-tag">
                      {openTasks.length}项未完成
                    </span>
                  </div>
                  <button
                    className="text-btn"
                    onClick={() =>
                      openModal({ kind: "task", taskKind: "交班" })
                    }
                  >
                    发起交班
                    <ArrowRight size={14} />
                  </button>
                </div>
                <div className="task-toolbar">
                  <div className="segmented">
                    <button
                      className={taskScope === "mine" ? "active" : ""}
                      onClick={() => setTaskScope("mine")}
                    >
                      我的事项
                    </button>
                    <button
                      className={taskScope === "all" ? "active" : ""}
                      onClick={() => setTaskScope("all")}
                    >
                      团队全部
                    </button>
                  </div>
                  <select
                    aria-label="任务状态筛选"
                    value={taskFilter}
                    onChange={(e) => setTaskFilter(e.target.value)}
                  >
                    <option value="open">全部未完成</option>
                    <option value="all">全部记录</option>
                    <option value="overdue">逾期事项</option>
                    <option value="handoff">交班记录</option>
                    {TASK_STATUS.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <label className="search-field">
                    <Search size={15} />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="搜索会员、事项或结果"
                      aria-label="搜索待办"
                    />
                  </label>
                </div>
                {TaskList({ items: selectedTasks })}
              </section>
            )}
            {view === "manager" && manager && (
              <>
                <div className="sectiontabs admin-tabs">
                  {[
                    ["overview", "监管总览"],
                    ["staffStats", "员工明细"],
                    ["catalog", "常用项目"],
                    ["audits", "操作日志"],
                    ["team", "团队账号"],
                    ["backup", "备份导出"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={adminTab === id ? "selected" : ""}
                      onClick={() => setAdminTab(id!)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {adminTab === "overview" && (
                  <>
                    <div className="stats-grid">
                      {[
                        {
                          label: "待复核票据",
                          count: receipts.filter((r) => r.status === "待复核")
                            .length,
                          fn: () => {
                            navigate("receiptArchive");
                            setReceiptFilter("待复核");
                          },
                        },
                        {
                          label: "待确认预约",
                          count: data.appointments.filter(
                            (a) => a.status === "待确认",
                          ).length,
                          fn: () => navigate("appointments"),
                        },
                        {
                          label: "团队逾期事项",
                          count: overdue.length,
                          fn: () => {
                            navigate("tasks");
                            setTaskScope("all");
                            setTaskFilter("overdue");
                          },
                        },
                        {
                          label: "待接收交班",
                          count: tasks.filter(
                            (t) => t.kind === "交班" && t.status === "待接收",
                          ).length,
                          fn: () => {
                            navigate("tasks");
                            setTaskScope("all");
                            setTaskFilter("待接收");
                          },
                        },
                      ].map((s) => (
                        <button
                          className="stat-card clickable-stat"
                          key={s.label}
                          onClick={s.fn}
                        >
                          <div className="stat-top">
                            {s.label}
                            <ArrowUpRight size={16} />
                          </div>
                          <div className="stat-value">
                            {s.count}
                            <small>项</small>
                          </div>
                          <p>点击查看对应明细</p>
                        </button>
                      ))}
                    </div>
                    <section className="panel">
                      <div className="panel-header">
                        <div>
                          <h2>最近操作</h2>
                          <span className="count-tag">实际登录账号留痕</span>
                        </div>
                        <button
                          className="text-btn"
                          onClick={() => setAdminTab("audits")}
                        >
                          全部日志
                          <ArrowRight size={14} />
                        </button>
                      </div>
                      {audits.length ? (
                        <div className="audit-stream">
                          {audits.slice(0, 8).map((a) => (
                            <button
                              className="audit-stream-row"
                              key={a.id}
                              onClick={() => setAuditDetail(a)}
                            >
                              <span className="avatar">
                                {initial(a.actorName)}
                              </span>
                              <span>
                                <strong>
                                  {a.actorName}
                                  <em>{a.action}</em>
                                </strong>
                                <small>
                                  {a.objectType} · {a.objectId}
                                  {a.reason ? ` · ${a.reason}` : ""}
                                </small>
                              </span>
                              <time>{date(a.createdAt)}</time>
                              <ChevronRight size={14} />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <Empty
                          icon={Activity}
                          title="还没有操作日志"
                          text="新增、修改、核对、交接等操作会由系统记录账号及前后值。"
                        />
                      )}
                    </section>
                  </>
                )}
                {adminTab === "catalog" && (
                  <CatalogManager
                    catalog={data.catalog || []}
                    onSave={saveCatalogItem}
                    busy={busy}
                  />
                )}
                {adminTab === "staffStats" && (
                  <section className="panel">
                    <div className="panel-header">
                      <div>
                        <h2>员工工作明细</h2>
                      </div>
                      <span className="muted small">
                        录入操作与接待责任分列，不自动折算绩效
                      </span>
                    </div>
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>员工</th>
                            <th>操作记录</th>
                            <th>会员建档</th>
                            <th>代录预约</th>
                            <th>上传图片</th>
                            <th>核对票据</th>
                            <th>当前负责接待</th>
                            <th>当前未完成任务</th>
                            <th>查询</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.team.map((t) => {
                            const own = audits.filter(
                              (a) => a.actorId === t.id,
                            );
                            return (
                              <tr key={t.id}>
                                <td>
                                  <strong>{t.name}</strong>
                                  <small className="cell-sub">
                                    {t.role === "manager" ? "经理" : "管家"}
                                    {!t.active ? " · 已停用" : ""}
                                  </small>
                                </td>
                                <td>{own.length}</td>
                                <td>
                                  {
                                    new Set(
                                      own
                                        .filter((a) => a.action === "新建会员")
                                        .map((a) => a.objectId),
                                    ).size
                                  }
                                </td>
                                <td>
                                  {
                                    new Set(
                                      own
                                        .filter(
                                          (a) => a.action === "登记协调预约",
                                        )
                                        .map((a) => a.objectId),
                                    ).size
                                  }
                                </td>
                                <td>
                                  {
                                    own.filter(
                                      (a) => a.action === "上传管家凭证",
                                    ).length
                                  }
                                </td>
                                <td>
                                  {
                                    new Set(
                                      own
                                        .filter(
                                          (a) =>
                                            a.action === "消费凭证" &&
                                            /"status"\s*:\s*"已确认"/.test(
                                              a.after,
                                            ),
                                        )
                                        .map((a) => a.objectId),
                                    ).size
                                  }
                                </td>
                                <td>
                                  {
                                    visits.filter((v) => v.hostId === t.id)
                                      .length
                                  }
                                </td>
                                <td>
                                  {
                                    openTasks.filter(
                                      (x) => x.assigneeId === t.id,
                                    ).length
                                  }
                                </td>
                                <td>
                                  <button
                                    className="text-btn"
                                    onClick={() => {
                                      setAdminTab("audits");
                                      setAuditActor(t.id);
                                      setAuditType("");
                                      setAuditSearch("");
                                    }}
                                  >
                                    查操作明细
                                    <ArrowRight size={13} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="panel-footer">
                      <CircleHelp size={14} />
                      以上操作统计限最近2000条，完整历史可在操作日志按条件导出。帮同事录入不等于负责接待，人员改派保留在操作日志。
                    </div>
                  </section>
                )}
                {adminTab === "audits" && (
                  <section className="panel">
                    <div className="panel-header">
                      <div>
                        <h2>操作日志（最近2000条）</h2>
                        <span className="count-tag">
                          {selectedAudits.length}条
                        </span>
                      </div>
                      <button className="text-btn" onClick={exportAudits}>
                        <ArrowDownToLine size={14} />
                        导出筛选日志
                      </button>
                    </div>
                    <div className="audit-filters">
                      <select
                        value={auditActor}
                        onChange={(e) => setAuditActor(e.target.value)}
                        aria-label="日志操作人"
                      >
                        <option value="">全部操作人</option>
                        {data.team.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={auditType}
                        onChange={(e) => setAuditType(e.target.value)}
                        aria-label="日志对象"
                      >
                        <option value="">全部对象</option>
                        {[...new Set(audits.map((a) => a.objectType))].map(
                          (t) => (
                            <option key={t}>{t}</option>
                          ),
                        )}
                      </select>
                      <input
                        type="date"
                        value={auditFrom}
                        onChange={(e) => setAuditFrom(e.target.value)}
                        aria-label="日志开始日期"
                      />
                      <span>至</span>
                      <input
                        type="date"
                        value={auditTo}
                        onChange={(e) => setAuditTo(e.target.value)}
                        aria-label="日志结束日期"
                      />
                      <label className="search-field">
                        <Search size={15} />
                        <input
                          value={auditSearch}
                          onChange={(e) => setAuditSearch(e.target.value)}
                          placeholder="动作、编号、会员、原因"
                          aria-label="搜索日志"
                        />
                      </label>
                      <button
                        className="text-btn"
                        onClick={() => {
                          setAuditActor("");
                          setAuditType("");
                          setAuditFrom("");
                          setAuditTo("");
                          setAuditSearch("");
                        }}
                      >
                        清除
                      </button>
                    </div>
                    {selectedAudits.length ? (
                      <div className="table-scroll">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>操作时间</th>
                              <th>实际操作人</th>
                              <th>动作 / 对象</th>
                              <th>关联会员</th>
                              <th>原因</th>
                              <th className="text-right">明细</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedAudits.map((a) => (
                              <tr key={a.id}>
                                <td>{date(a.createdAt)}</td>
                                <td>
                                  {a.actorName}
                                  <small className="cell-sub">
                                    账号 {a.actorId.slice(0, 8)}
                                  </small>
                                </td>
                                <td>
                                  {a.action}
                                  <small className="cell-sub">
                                    {a.objectType} · {a.objectId.slice(0, 16)}
                                  </small>
                                </td>
                                <td>
                                  {a.memberId ? (
                                    <button
                                      className="text-btn"
                                      onClick={() => openMember(a.memberId)}
                                    >
                                      {memberName(a.memberId)}
                                    </button>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td>
                                  <span className="truncate note-preview">
                                    {a.reason || "—"}
                                  </span>
                                </td>
                                <td>
                                  <div className="table-actions">
                                    <button
                                      className="text-btn"
                                      onClick={() => setAuditDetail(a)}
                                    >
                                      前后值
                                      <ArrowRight size={13} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty
                        icon={Activity}
                        title="没有符合条件的操作"
                        text="调整人员、日期、对象或搜索词后重试。"
                      />
                    )}
                  </section>
                )}
                {adminTab === "team" && (
                  <section className="panel">
                    <div className="panel-header">
                      <h2>企业管家团队</h2>
                    </div>
                    <div className="info-strip">
                      账号、密码、停用与职责统一在企业「员工账号」管理。管家经理只管理业务，不能在此修改企业权限。
                    </div>
                    <div className="record-list">
                      {data.team.map((t) => (
                        <article className="record-card" key={t.id}>
                          <strong>{t.name}</strong>
                          <span>
                            {t.login} ·{" "}
                            {t.role === "manager" ? "管家经理" : "管家员工"} ·{" "}
                            {t.active ? "启用" : "停用"}
                          </span>
                        </article>
                      ))}
                    </div>
                  </section>
                )}
                {adminTab === "backup" && (
                  <section className="panel">
                    <div className="panel-header">
                      <div>
                        <h2>备份与导出</h2>
                        <span className="count-tag">管理员</span>
                      </div>
                    </div>
                    <div className="backup-content">
                      <div className="backup-symbol">
                        <ShieldCheck size={35} />
                      </div>
                      <h3>保存一份完整业务备份</h3>
                      <p>
                        导出会员、预约、接待、消费凭证、支付、余额、任务、账号资料、操作日志及关联原图。导出只含管家业务与原图，不含企业密码或会话。
                      </p>
                      <div className="backup-facts">
                        <span>
                          <CheckCircle2 size={16} />
                          结构化业务数据
                        </span>
                        <span>
                          <CheckCircle2 size={16} />
                          关联原图
                        </span>
                        <span>
                          <CheckCircle2 size={16} />
                          历史操作记录
                        </span>
                      </div>
                      <button
                        className="btn btn-primary"
                        onClick={() => void backup()}
                        disabled={backupBusy}
                      >
                        {backupBusy ? (
                          <RefreshCw size={17} className="spin" />
                        ) : (
                          <ArrowDownToLine size={17} />
                        )}{" "}
                        {backupBusy ? "正在整理备份…" : "下载完整JSON备份"}
                      </button>
                      <small>
                        模块导出原图合计上限20MB；超限会明确拒绝。企业数据库备份已覆盖全部管家业务与图片，恢复沿用企业备份流程。
                      </small>
                      <div className="backup-secondary">
                        <button
                          className="btn btn-secondary"
                          onClick={exportMembers}
                        >
                          导出管家服务档案
                          <ArrowRight size={14} />
                        </button>
                        <button
                          className="btn btn-secondary"
                          onClick={() => setAdminTab("audits")}
                        >
                          操作日志筛选与导出
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    </div>
                  </section>
                )}
              </>
            )}
            {view === "receiptArchive" && (
              <ReceiptArchive
                onSelect={(r) => {
                  setData((d) => ({
                    ...d,
                    receipts: [r, ...d.receipts.filter((x) => x.id !== r.id)],
                  }));
                  setReceiptDetailIdState(r.id);
                }}
              />
            )}
            <footer className="workspace-footer">
              <span>
                <span className="footer-dot" />
                汤崎福田 · 管家会员系统
              </span>
              <span>
                {lastSync
                  ? `${time(lastSync)} 已同步 · 3秒轮询`
                  : "正在同步团队数据"}
              </span>
            </footer>
          </main>
        </div>
        <nav className="mobile-bottom-nav" aria-label="手机常用入口">
          {[
            { id: "dashboard", label: "今日", icon: LayoutDashboard },
            { id: "members", label: "会员", icon: Users },
            { id: "receipts", label: "好评", icon: Sparkles },
            { id: "tasks", label: "待办", icon: ClipboardList },
          ].map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "active" : ""}
              onClick={() => navigate(n.id as View)}
            >
              <n.icon size={20} />
              <span>{n.label}</span>
              {n.id === "tasks" && mine.length > 0 && <i />}
            </button>
          ))}
        </nav>
        {nativePreviewId != null && <NativeMemberPreview id={nativePreviewId}
          onClose={() => setNativePreviewId(null)}
          onCreate={(native) => { setNativePreviewId(null); openModal({ kind: "member", initialNative: native }); }}
          onOpenService={(id) => { setNativePreviewId(null); openMember(id); }} />}
        {member && (
          <div className="drawer-layer">
            <div className="drawer-scrim" onClick={() => setDrawerId(null)} />
            <aside
              key={member.id}
              className="member-drawer service-member-drawer"
              aria-label={`${member.name}的会员档案`}
            >
              <div className="drawer-heading">
                <span>
                  会员档案 · <b className="code-label">{member.code}</b>
                </span>
                <button
                  className="icon-btn"
                  aria-label="关闭会员详情"
                  onClick={() => setDrawerId(null)}
                >
                  <X size={21} />
                </button>
              </div>
              <div className="drawer-profile">
                <span className="avatar big-avatar">
                  {initial(member.name)}
                </span>
                <div>
                  <h2>{member.name}</h2>
                  <p>{member.phone || "手机号未填写"}</p>
                  <span className="tier-tag">
                    {memberGrade(member)}
                  </span>
                </div>
                <button
                  className="btn btn-secondary small-btn"
                  onClick={() => openModal({ kind: "member", member })}
                >
                  <Pencil size={13} />
                  编辑
                </button>
              </div>
              <div className="drawer-balance">
                <div>
                  <small>{member.nativeMember ? "系统实时余额" : "系统余额待关联"}</small>
                  <strong>
                    <BalanceValue m={member} />
                  </strong>
                  <p>
                    {member.nativeMember
                      ? `本金 ¥${money(member.nativeMember.principalCents)} ＋ 赠金 ¥${money(member.nativeMember.bonusCents)} · 与前台同步`
: "请关联前台会员，历史人工记录可在历史核对页查看"}
                  </p>
                </div>
              </div>
              <div className="member-quick-actions">
                <button
                  onClick={() => openModal({ kind: "appointment", member })}
                >
                  <CalendarDays size={16} />
                  录预约
                </button>
                <button onClick={() => setCapture({ memberId: member.id })}>
                  <Camera size={16} />
                  拍消费单
                </button>
                <button onClick={() => openModal({ kind: "visit", member })}>
                  <HeartHandshake size={16} />
                  开始接待
                </button>
                <button onClick={() => openModal({ kind: "task", member })}>
                  <ClipboardList size={16} />
                  新建待办
                </button>
              </div>
              <div className="drawer-tabs">
                {[
                  ["timeline", "全程记录"],
                  ["overview", "基本档案"],
                  ["balances", "历史核对"],
                  ["receipts", "消费记录"],
                  ["notes", "服务记录"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    className={drawerTab === id ? "selected" : ""}
                    onClick={() => setDrawerTab(id!)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="drawer-body">
                {drawerTab === "overview" && (
                  <>
                    <h3 className="detail-section-title">基本信息</h3>
                    {member.nativeMemberId && canNative("member.read") && (
                      <a
                        className="native-link"
                        href={`/?m=${member.nativeMember?.id || member.nativeMemberId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看关联企业会员 #{member.nativeMemberId}
                      </a>
                    )}
                    <dl className="detail-grid">
                      {[
                        ["会员编码", member.code],
                        ["收银卡号", member.cardNo || "未填写"],
                        ["负责管家", staff(member.ownerId)],
                        [
                          "系统建档日期",
                          member.joinedAt || date(member.createdAt, false),
                        ],
                        ["会员来源", member.source || "未填写"],
                        ["系统档阶", memberGrade(member)],
                        ["建档人", member.createdByName || "已记录"],
                        [
                          "最后修改人",
                          member.updatedByName ||
                            member.createdByName ||
                            "已记录",
                        ],
                      ].map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                    </dl>
                    <h3 className="detail-section-title">服务偏好</h3>
                    <div className="preferences-box">
                      {member.preferences ||
                        "暂无记录。可逐步补充客户主动表达的服务偏好。"}
                    </div>
                    <div className="detail-notice">
                      <ShieldCheck size={15} />
                      会员身份、档阶和余额实时同步；服务档案编号只用于管家记录。
                    </div>
                    <h3 className="detail-section-title">当前未结事项</h3>
                    {TaskList({
                      items: tasks.filter(
                        (t) =>
                          t.memberId === member.id && t.status !== "已完成",
                      ),
                    })}
                  </>
                )}
                {drawerTab === "timeline" &&
                  (() => {
                    const events = timelineFor(data, member.id);
                    const shown = events.filter(
                      (e) =>
                        (timelineType === "all" || e.type === timelineType) &&
                        (!timelineMonth || e.at.startsWith(timelineMonth)),
                    );
                    return (
                      <>
                        <div className="timeline-controls">
                          <select
                            value={timelineType}
                            onChange={(e) => {
                              setTimelineType(e.target.value);
                              setTimelineLimit(20);
                            }}
                            aria-label="记录类型"
                          >
                            <option value="all">全部记录</option>
                            {[...new Set(events.map((e) => e.type))].map(
                              (t) => (
                                <option key={t}>{t}</option>
                              ),
                            )}
                          </select>
                          <input
                            type="month"
                            value={timelineMonth}
                            onChange={(e) => {
                              setTimelineMonth(e.target.value);
                              setTimelineLimit(20);
                            }}
                            aria-label="记录月份"
                          />
                          <span>{shown.length}条记录</span>
                        </div>
                        <div className="history-list">
                          {shown.slice(0, timelineLimit).map((e) => (
                            <article className="history-item" key={e.id}>
                              <span className="timeline-dot" />
                              <div className="history-top">
                                <strong>
                                  <span className="tier-tag">{e.type}</span>{" "}
                                  {e.title}
                                </strong>
                                <small>{date(e.at)}</small>
                              </div>
                              <div className="history-note">{e.content}</div>
                              <p>实际记录：{e.actor}</p>
                              {e.amountCents != null && (
                                <div className="timeline-money">
                                  ¥ {money(e.amountCents)}
                                </div>
                              )}
                              {e.source === "receipt" && (
                                <button
                                  className="text-btn"
                                  onClick={() => {
                                    const r = receipts.find(
                                      (x) => x.id === e.sourceId,
                                    );
                                    if (r) viewReceipt(r);
                                  }}
                                >
                                  查看原图与核对记录
                                  <ArrowRight size={13} />
                                </button>
                              )}
                              {e.source === "balance" && (
                                <button
                                  className="text-btn"
                                  onClick={() =>
                                    setBalanceDetailId(e.sourceId || null)
                                  }
                                >
                                  查看余额依据与原图
                                  <ArrowRight size={13} />
                                </button>
                              )}
                              {e.source === "appointment" && (
                                <button
                                  className="text-btn"
                                  onClick={() => {
                                    const a = data.appointments.find(
                                      (x) => x.id === e.sourceId,
                                    );
                                    if (a)
                                      openModal({
                                        kind: "appointment",
                                        appointment: a,
                                      });
                                  }}
                                >
                                  预约详情
                                  <ArrowRight size={13} />
                                </button>
                              )}
                              {e.source === "task" && (
                                <button
                                  className="text-btn"
                                  onClick={() => {
                                    const t = tasks.find(
                                      (x) => x.id === e.sourceId,
                                    );
                                    if (t) openModal({ kind: "task", task: t });
                                  }}
                                >
                                  事项详情
                                  <ArrowRight size={13} />
                                </button>
                              )}
                              {e.source === "visit" && (
                                <button
                                  className="text-btn"
                                  onClick={() => {
                                    const v = visits.find(
                                      (x) => x.id === e.sourceId,
                                    );
                                    if (v)
                                      openModal({ kind: "visit", visit: v });
                                  }}
                                >
                                  服务详情
                                  <ArrowRight size={13} />
                                </button>
                              )}
                            </article>
                          ))}
                        </div>
                        {!shown.length && (
                          <Empty
                            title="当前条件下没有记录"
                            text="试试其他类型或月份。"
                          />
                        )}
                        {shown.length > timelineLimit && (
                          <button
                            className="btn btn-secondary full-width"
                            onClick={() => setTimelineLimit((n) => n + 20)}
                          >
                            再看20条记录
                          </button>
                        )}
                      </>
                    );
                  })()}
                {drawerTab === "balances" && (
                  <>
                    <div className="detail-notice">
                      <ShieldCheck size={15} />
                      人工核对保留作历史依据；当前系统余额由前台同步，凭证不会改写钱包。
                    </div>
                    {data.balances.some((b) => b.memberId === member.id) ? (
                      <div className="history-list">
                        {data.balances
                          .filter((b) => b.memberId === member.id)
                          .map((b, i) => (
                            <article className="history-item" key={b.id}>
                              <span className="timeline-dot" />
                              <div className="history-top">
                                <button
                                  className="history-balance-amount"
                                  onClick={() => setBalanceDetailId(b.id)}
                                >
                                  <strong>¥ {money(b.amountCents)}</strong>
                                  <Eye size={13} />
                                </button>
                                {i === 0 && (
                                  <span className="tier-tag">最新记录</span>
                                )}
                              </div>
                              <p>
                                {date(b.checkedAt)} · 核对：{b.actorName}
                              </p>
                              <small>来源：{b.source || "未填写"}</small>
                              <div className="history-note">{b.note}</div>
                              <button
                                className="balance-history-open"
                                onClick={() => setBalanceDetailId(b.id)}
                              >
                                <span>
                                  <Camera size={14} />
                                  {b.uploadIds?.length || 0}张依据照片 ·{" "}
                                  {b.receiptIds?.length || 0}条人工关联消费单
                                </span>
                                <span>
                                  查看核对依据
                                  <ArrowRight size={14} />
                                </span>
                              </button>
                            </article>
                          ))}
                      </div>
                    ) : (
                      <Empty
                        icon={Wallet}
                        title="没有历史人工核对记录"
                        text="当前余额以会员系统为准。"
                      />
                    )}
                  </>
                )}
                {drawerTab === "receipts" && (
                  <>
                    <NativeSpendingList key={member.id} member={member}/>
                    <h3 className="native-service-heading">小票与消费凭证</h3>
                    <div className="detail-notice">
                      <FileText size={15} />
                      只显示明确关联的消费凭证，点开可查看每项明细和原始照片；待核与已确认分开。
                    </div>
                    {ReceiptList({
                      items: receipts.filter(
                        (r) =>
                          r.memberId === member.id ||
                          r.payments.some((p) => p.memberId === member.id),
                      ),
                    })}
                  </>
                )}
                {drawerTab === "notes" && (
                  <>
                    <form className="note-form" onSubmit={submitNote}>
                      <label htmlFor="service-note">新增服务记录</label>
                      <textarea
                        id="service-note"
                        name="content"
                        required
                        maxLength={2000}
                        rows={4}
                        placeholder="记录实际服务、客户反馈或待跟进事项…"
                      />
                      <Field label="下次跟进时间（中国时间，选填）">
                        <input name="nextAt" type="datetime-local" />
                      </Field>
                      <div className="note-form-actions">
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() => openModal({ kind: "task", member })}
                        >
                          需要负责人接续？创建待办
                        </button>
                        <button className="btn btn-primary" disabled={busy}>
                          <Check size={15} />
                          保存记录
                        </button>
                      </div>
                    </form>
                    {data.notes.filter((n) => n.memberId === member.id)
                      .length ? (
                      <div className="history-list">
                        {data.notes
                          .filter((n) => n.memberId === member.id)
                          .map((n) => (
                            <article className="history-item" key={n.id}>
                              <span className="timeline-dot" />
                              <div className="history-top">
                                <strong>{n.actorName}</strong>
                                <small>{date(n.createdAt)}</small>
                              </div>
                              <div className="history-note">{n.content}</div>
                              {n.nextAt && (
                                <p className="orange-text">
                                  下次跟进：{date(n.nextAt)}
                                </p>
                              )}
                            </article>
                          ))}
                      </div>
                    ) : (
                      <Empty
                        title="暂无服务记录"
                        text="从本次接待开始，留下可以接续的信息。"
                      />
                    )}
                  </>
                )}
              </div>
            </aside>
          </div>
        )}
        {modal && (
          <Dialog
            key={modal.key}
            title={
              modal.kind === "member"
                ? modal.member
                  ? "编辑服务档案"
                  : "建立管家服务档案"
                : modal.kind === "appointment"
                    ? modal.appointment
                      ? "查看 / 调整预约"
                      : "登记新预约"
                    : modal.kind === "visit"
                      ? modal.visit
                        ? "更新本次接待"
                        : "开始到店接待"
                      : modal.kind === "task"
                        ? modal.task
                          ? "处理待办 / 交班"
                          : "新建待办 / 交班"
                        : modal.kind === "password"
                          ? "设置员工登录密码"
                          : modal.staff
                            ? "编辑团队成员"
                            : "新增独立员工账号"
            }
            onClose={closeModal}
          >
            <form onSubmit={submitModal} onChange={() => setDirty(true)}>
              <div className="modal-content">
                {error && (
                  <div className="alert alert-error" role="alert">
                    {error}
                  </div>
                )}
                {modal.kind === "member" && (
                  <>
                    <p className="form-intro">
                      选择前台已办理的系统会员，补充管家服务信息。服务档案从000001编号，不另建会员身份。
                    </p>
                    {modal.member && (
                      <div className="form-member-summary">
                        <span className="avatar">
                          {initial(modal.member.name)}
                        </span>
                        <div>
                          <strong>{modal.member.name}</strong>
                          <small>服务档案编码 {modal.member.code}</small>
                        </div>
                      </div>
                    )}
                    <div className="form-grid">
                      <MemberIdentityFields key={modal.key} member={modal.member} initialNative={modal.initialNative}/>
                      <Field label="当前负责管家">
                        {staffSelect(modal.member?.ownerId || "", "ownerId")}
                      </Field>
                      <Field label="系统建档日期 *">
                        <input
                          name="joinedAt"
                          type="date"
                          required
                          defaultValue={modal.member?.joinedAt || today}
                        />
                      </Field>
                      <Field label="会员来源">
                        <input
                          name="source"
                          maxLength={100}
                          defaultValue={modal.member?.source}
                          placeholder="现场接待、同事介绍等"
                        />
                      </Field>
                      <Field label="备注（客户主动表达的偏好）" wide>
                        <textarea
                          name="preferences"
                          rows={3}
                          maxLength={1000}
                          defaultValue={modal.member?.preferences}
                          placeholder="服务、时段、房型等偏好，选填"
                        />
                      </Field>
                      {modal.member && (
                        <Field label="本次修改原因 *" wide>
                          <input
                            name="changeReason"
                            required
                            maxLength={500}
                            placeholder="说明需要补充或调整的内容"
                          />
                        </Field>
                      )}
                    </div>

                  </>
                )}
                {modal.kind === "appointment" && (
                  <>
                    <div className="form-grid">
                      {canNative("booking.manage") && (
                        <Field
                          label="关联前台正式预约编号（可选）"
                          hint="仅关联同一企业会员的正式预约；本页的协调状态不会修改前台资源占用。"
                        >
                          <input
                            name="nativeBookingId"
                            type="number"
                            min="1"
                            defaultValue={
                              modal.appointment?.nativeBookingId || ""
                            }
                          />
                        </Field>
                      )}
                      <Field label="预约会员 *" wide>
                        {memberSelect(
                          modal.appointment?.memberId || modal.member?.id,
                        )}
                      </Field>
                      <Field label="到店时间（中国时间） *">
                        <input
                          name="startAt"
                          type="datetime-local"
                          required
                          defaultValue={localTime(modal.appointment?.startAt)}
                        />
                      </Field>
                      <Field label="结束时间（普通到店可留空）">
                        <input
                          name="endAt"
                          type="datetime-local"
                          defaultValue={
                            modal.appointment?.endAt
                              ? localTime(modal.appointment.endAt)
                              : ""
                          }
                        />
                      </Field>
                      <ResourceFields key={modal.key} options={data.resourceOptions || []} appointment={modal.appointment}/>
                      <Field label="接待人数 *">
                        <input
                          name="partySize"
                          type="number"
                          min={1}
                          max={1000}
                          required
                          defaultValue={modal.appointment?.partySize || 1}
                        />
                      </Field>
                      <Field label="当前状态 *">
                        <select
                          name="status"
                          defaultValue={modal.appointment?.status || "待确认"}
                        >
                          {APPT_STATUS.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="本次负责管家">
                        {staffSelect(
                          modal.appointment?.hostId ||
                            modal.member?.ownerId ||
                            data.user.id,
                        )}
                      </Field>
                      <Field label="特殊要求与说明" wide>
                        <textarea
                          name="note"
                          rows={3}
                          maxLength={1000}
                          defaultValue={modal.appointment?.note}
                          placeholder="未落实的需求注明待核实"
                        />
                      </Field>
                      {modal.appointment && (
                        <Field label="本次变更 / 取消原因 *" wide>
                          <input
                            name="changeReason"
                            required
                            maxLength={500}
                            placeholder="填写实际变更或取消依据"
                          />
                        </Field>
                      )}
                    </div>
                    <div className="detail-notice">
                      <CalendarDays size={15} />
                      已确认或已到店的同一资源时段不能重叠；待确认不锁资源。同会员不同项目不会一概阻止。
                    </div>
                    {modal.appointment && (
                      <p className="form-history">
                        原录入人：{modal.appointment.createdByName} · 最后修改：
                        {modal.appointment.updatedByName ||
                          modal.appointment.createdByName}
                        {modal.appointment.changeReason &&
                          ` · ${modal.appointment.changeReason}`}
                      </p>
                    )}
                  </>
                )}
                {modal.kind === "visit" && (
                  <>
                    <input
                      type="hidden"
                      name="appointmentId"
                      value={
                        modal.visit?.appointmentId ||
                        modal.appointment?.id ||
                        ""
                      }
                    />
                    <div className="form-grid">
                      <Field label="接待会员 *" wide>
                        {memberSelect(
                          modal.visit?.memberId ||
                            modal.member?.id ||
                            modal.appointment?.memberId,
                        )}
                      </Field>
                      <Field label="本次负责管家 *">
                        {staffSelect(
                          modal.visit?.hostId ||
                            modal.appointment?.hostId ||
                            data.user.id,
                          "hostId",
                          true,
                        )}
                      </Field>
                      <Field label="实际接待人数 *">
                        <input
                          name="partySize"
                          type="number"
                          min={1}
                          max={1000}
                          required
                          defaultValue={
                            modal.visit?.partySize ||
                            modal.appointment?.partySize ||
                            1
                          }
                        />
                      </Field>
                      <Field label="当前服务状态 *">
                        <select
                          name="status"
                          defaultValue={modal.visit?.status || "接待中"}
                        >
                          <option>接待中</option>
                          <option>已完成</option>
                        </select>
                      </Field>
                      <Field label="客户反馈与服务说明" wide>
                        <textarea
                          name="feedback"
                          rows={3}
                          maxLength={2000}
                          defaultValue={modal.visit?.feedback}
                          placeholder="没有特殊情况可留空，不要求抄录消费项目"
                        />
                      </Field>
                      <Field label="未结事项" wide>
                        <textarea
                          name="pending"
                          rows={2}
                          maxLength={1000}
                          defaultValue={modal.visit?.pending}
                          placeholder="还有哪些需求或安排需要后续处理"
                        />
                      </Field>
                      {modal.visit && (
                        <Field label="本次调整说明" wide>
                          <input
                            name="reason"
                            maxLength={500}
                            placeholder="服务更新或更正原因"
                          />
                        </Field>
                      )}
                    </div>
                    <div className="detail-notice">
                      <HeartHandshake size={15} />
                      操作人和时间自动记录。有未结事项时，请另建待办或交班，指定下一负责人。
                    </div>
                  </>
                )}
                {modal.kind === "task" && (
                  <>
                    <div className="form-grid">
                      <Field label="关联会员 *" wide>
                        {memberSelect(modal.task?.memberId || modal.member?.id)}
                      </Field>
                      <Field label="事项类型 *">
                        <select
                          name="kind"
                          defaultValue={
                            modal.task?.kind || modal.taskKind || "回访"
                          }
                        >
                          <option>回访</option>
                          <option>交班</option>
                        </select>
                      </Field>
                      <Field label="任务类别 *">
                        <select
                          name="category"
                          defaultValue={modal.task?.category || "服务跟进"}
                        >
                          {[
                            "服务跟进",
                            "预约回告",
                            "体验回访",
                            "余额提醒",
                            "返充协作",
                            "问题处理",
                            "跨班接续",
                          ].map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="下一负责人 / 接收人 *">
                        {staffSelect(
                          modal.task?.assigneeId || data.user.id,
                          "assigneeId",
                          true,
                        )}
                      </Field>
                      <Field label="处理期限（中国时间） *">
                        <input
                          name="dueAt"
                          type="datetime-local"
                          required
                          defaultValue={localTime(
                            modal.task?.dueAt ||
                              new Date(Date.now() + 86400000).toISOString(),
                          )}
                        />
                      </Field>
                      <Field label="需要做什么 *" wide>
                        <textarea
                          name="content"
                          required
                          rows={3}
                          maxLength={1500}
                          defaultValue={modal.task?.content}
                          placeholder="写清需求、已确认安排和下一动作"
                        />
                      </Field>
                      <Field label="当前状态 *">
                        <select
                          name="status"
                          defaultValue={
                            modal.task?.status ||
                            (modal.taskKind === "交班" ? "待接收" : "待处理")
                          }
                        >
                          {TASK_STATUS.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label="实际处理结果"
                        wide
                        hint="完成任务时需写明结果；未联系上也应如实记录。"
                      >
                        <textarea
                          name="result"
                          rows={2}
                          maxLength={1000}
                          defaultValue={modal.task?.result}
                          placeholder="已处理、已联系待继续、未联系上等实际结果"
                        />
                      </Field>
                      <Field label="后续安排" wide>
                        <input
                          name="nextAction"
                          maxLength={1000}
                          defaultValue={modal.task?.nextAction}
                          placeholder="需继续跟进时明确下一步"
                        />
                      </Field>
                      {modal.task && (
                        <Field label="本次调整 / 改派原因" wide>
                          <input
                            name="reason"
                            maxLength={500}
                            placeholder="改派、延期或修正时说明原因"
                          />
                        </Field>
                      )}
                    </div>
                    <div className="detail-notice">
                      <ClipboardList size={15} />
                      交班建议选择“待接收”，由接收人点击接收；保存完成结果不等于发出了客户消息。
                    </div>
                  </>
                )}
                {modal.kind === "staff" && (
                  <>
                    <div className="form-grid">
                      <Field label="员工姓名 *">
                        <input
                          name="name"
                          required
                          maxLength={60}
                          defaultValue={modal.staff?.name}
                        />
                      </Field>
                      <Field label="角色 *">
                        <select
                          name="role"
                          defaultValue={modal.staff?.role || "butler"}
                        >
                          <option value="butler">管家员工</option>
                          <option value="manager">管理员 / 管家经理</option>
                        </select>
                      </Field>
                      {!modal.staff && (
                        <>
                          <Field label="员工登录标识 *">
                            <input
                              name="login"
                              required
                              minLength={3}
                              maxLength={80}
                              autoComplete="off"
                              placeholder="手机号或员工账号"
                            />
                          </Field>
                          <Field
                            label="初始密码 *"
                            hint="建议至少12位，使用字母与数字。"
                          >
                            <input
                              name="password"
                              type="password"
                              required
                              minLength={12}
                              maxLength={128}
                              autoComplete="new-password"
                            />
                          </Field>
                        </>
                      )}
                      {modal.staff && (
                        <Field label="账户状态">
                          <label className="checkbox-label">
                            <input
                              name="active"
                              type="checkbox"
                              defaultChecked={modal.staff.active}
                            />
                            启用此成员
                          </label>
                        </Field>
                      )}
                    </div>
                    <div className="detail-notice">
                      <ShieldCheck size={15} />
                      全部管家共享会员资料。管理员另可管理账号、监管日志及导出备份；实际录入人自动取登录账号。
                    </div>
                  </>
                )}
                {modal.kind === "password" && (
                  <>
                    <div className="form-member-summary">
                      <span className="avatar">
                        {initial(modal.staff!.name)}
                      </span>
                      <div>
                        <strong>{modal.staff!.name}</strong>
                        <small>设置或重置后请通过安全渠道告知本人</small>
                      </div>
                    </div>
                    <div className="form-grid">
                      <Field label="员工登录标识 *">
                        <input
                          name="login"
                          required
                          minLength={3}
                          maxLength={80}
                          defaultValue={modal.staff?.login || ""}
                          autoComplete="off"
                        />
                      </Field>
                      <Field
                        label="新密码 *"
                        hint="至少12位，后台不会回显原密码。"
                      >
                        <input
                          name="password"
                          type="password"
                          required
                          minLength={12}
                          maxLength={128}
                          autoComplete="new-password"
                        />
                      </Field>
                    </div>
                    <div className="detail-notice">
                      <KeyRound size={15} />
                      当前站点的外部访问范围另行控制，配置密码不会自动开放私有站点。
                    </div>
                  </>
                )}
              </div>
              <div className="modal-footer">
                <span className="muted small">
                  {dirty ? "还有未保存的修改" : "实际操作账号由系统记录"}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeModal}
                  disabled={busy}
                >
                  取消
                </button>
                <button
                  className="btn btn-primary"
                  disabled={
                    busy ||
                    (["appointment", "visit", "task"].includes(modal.kind) &&
                      !data.members.length)
                  }
                >
                  {busy ? (
                    <RefreshCw size={15} className="spin" />
                  ) : (
                    <Check size={15} />
                  )}{" "}
                  {busy ? "正在保存…" : "保存"}
                </button>
              </div>
            </form>
          </Dialog>
        )}
        {capture && (
          <CaptureReceipt
            catalog={data.catalog || []}
            members={data.members}
            memberId={capture.memberId}
            onClose={() => setCapture(null)}
            onDone={(draft) => {
              setCapture(null);
              setReceiptEditor({ draft, key: uid() });
            }}
          />
        )}
        {receiptEditor && (
          <ReceiptEditor
            key={receiptEditor.key}
            receipt={receiptEditor.receipt}
            seed={receiptEditor.draft}
            data={data}
            busy={busy}
            error={error}
            onSaveCatalog={saveCatalogItem}
            onClose={() => {
              if (!busy) {
                setReceiptEditor(null);
                setError("");
              }
            }}
            onSave={async (p) => {
              if (await mutate("saveReceipt", p, receiptEditor.key)) {
                setReceiptEditor(null);
                return true;
              }
              return false;
            }}
          />
        )}
        {receiptDetailId && receipts.find((r) => r.id === receiptDetailId) && (
          <ReceiptDetail
            receipt={receipts.find((r) => r.id === receiptDetailId)!}
            data={data}
            onClose={() => setReceiptDetailId(null)}
            onEdit={() => {
              const r = receipts.find((x) => x.id === receiptDetailId);
              setReceiptDetailId(null);
              if (r) void editReceipt(r);
            }}
          />
        )}
        {balanceDetailId &&
          data.balances.find((b) => b.id === balanceDetailId) && (
            <BalanceDetail
              key={balanceDetailId}
              balance={data.balances.find((b) => b.id === balanceDetailId)!}
              member={memberMap.get(
                data.balances.find((b) => b.id === balanceDetailId)!.memberId,
              )}
              receipts={receipts}
              readOnly
              busy={busy}
              error={error}
              onClose={() => {
                setBalanceDetailId(null);
                setError("");
              }}
              onReceipt={(r) => {
                setBalanceDetailId(null);
                viewReceipt(r);
              }}
              onAttach={(payload, id) =>
                mutate("attachBalanceEvidence", payload, id)
              }
            />
          )}
        {auditDetail && (
          <Dialog
            title="操作记录详情"
            subtitle={`${auditDetail.actorName} · ${date(auditDetail.createdAt)}`}
            onClose={() => setAuditDetail(null)}
            wide
          >
            <div className="modal-content">
              <dl className="detail-grid">
                <div>
                  <dt>实际操作账号</dt>
                  <dd>{auditDetail.actorId}</dd>
                </div>
                <div>
                  <dt>业务动作</dt>
                  <dd>{auditDetail.action}</dd>
                </div>
                <div>
                  <dt>对象 / 记录</dt>
                  <dd>
                    {auditDetail.objectType} · {auditDetail.objectId}
                  </dd>
                </div>
                <div>
                  <dt>原因</dt>
                  <dd>{auditDetail.reason || "未填写"}</dd>
                </div>
              </dl>
              <div className="audit-diff">
                <section>
                  <h3>变更前</h3>
                  <pre>{pretty(auditDetail.before)}</pre>
                </section>
                <section>
                  <h3>变更后</h3>
                  <pre>{pretty(auditDetail.after)}</pre>
                </section>
              </div>
            </div>
            <div className="modal-footer">
              <span className="muted small">日志不提供修改或删除操作</span>
              <button
                className="btn btn-secondary"
                onClick={() => setAuditDetail(null)}
              >
                关闭
              </button>
            </div>
          </Dialog>
        )}
      </div>
    </div>
  );
}

function pretty(value: unknown) {
  if (!value) return "无";
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
type TimelineEntry = {
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
function timelineFor(data: WorkspaceData, id: string): TimelineEntry[] {
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

async function prepareImages(files: File[]): Promise<File[]> {
  const result: File[] = [];
  for (const file of files) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error(
        "目前支持JPEG、PNG、WebP图片。HEIC请先转换为JPEG后选择。",
      );
    if (file.size <= 4 * 1024 * 1024) {
      result.push(file);
      continue;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 2400 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器无法处理图片，请改用JPEG截图。");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob || blob.size > 4 * 1024 * 1024)
        throw new Error("图片超过4MB，请分段拍摄或压缩后重试。");
      result.push(
        new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, {
          type: "image/jpeg",
        }),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (result.reduce((n, f) => n + f.size, 0) > 12 * 1024 * 1024)
    throw new Error("本次图片总量超过12MB，请减少页数或压缩后重试。");
  return result;
}

function CaptureReceipt({
  catalog,
  members,
  memberId,
  onClose,
  onDone,
}: {
  catalog: CatalogItem[];
  members: Member[];
  memberId: string;
  onClose: () => void;
  onDone: (draft: ReceiptDraft) => void;
}) {
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [files, setFiles] = useState<File[]>([]);
  const [selected, setSelected] = useState(memberId);
  const [working, setWorking] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [uploaded, setUploaded] = useState<Upload[]>([]);
  const [raw, setRaw] = useState<ReceiptDraft | null>(null);
  const prepared = useRef<File[]>([]);
  const requestId = useRef("");
  const draftRef = useRef<Receipt | null>(null);
  const resultRef = useRef<ReceiptDraft | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  function close() {
    if (working) return;
    if (
      (files.length || uploaded.length) &&
      !confirm(
        "确定关闭拍单？已上传图片仍保存在服务器，未确认内容不会计入消费。",
      )
    )
      return;
    onClose();
  }
  function choose(list: FileList | null) {
    if (!list) return;
    const next = [...files, ...Array.from(list)];
    if (next.length > 4) {
      setError("每次最多4张，可将同一张长单分段拍摄。");
      return;
    }
    setFiles(next);
    setUploaded([]);
    setRaw(null);
    resultRef.current = null;
    setError("");
  }
  async function recognize() {
    if (working || !files.length) return;
    setWorking(true);
    setError("");
    try {
      let pages = prepared.current;
      let savedUploads = uploaded;
      if (!savedUploads.length) {
        setStage("正在准备与保存图片");
        setProgress(0);
        pages = await prepareImages(files);
        prepared.current = pages;
        const fd = new FormData();
        for (const f of pages) fd.append("files", f);
        fd.append("memberId", selected);
        const res = await fetch("/api/concierge/uploads", {
          method: "POST",
          body: fd,
        });
        const body = (await res.json()) as {
          uploads?: Upload[];
          error?: string;
        };
        if (!res.ok || !body.uploads?.length)
          throw new Error(body.error || "图片保存失败，请重试。");
        savedUploads = body.uploads;
        setUploaded(savedUploads);
      }
      const uploadIds = savedUploads.map((u) => u.id);
      requestId.current ||= uid();
      if (!draftRef.current) {
        setStage("正在保存可恢复草稿");
        const response = await fetch("/api/concierge/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "saveReceipt",
            requestId: requestId.current,
            payload: {
              memberId: selected,
              number: "",
              store: "",
              occurredAt: "",
              kind: "结算单",
              status: "待补全",
              amount: "",
              payments: [],
              itemsText: "",
              rawText: "",
              note: "照片已保存，等待识别与核对",
              uploadIds,
              originalReceiptId: "",
            },
          }),
        });
        const body = (await response.json()) as { id?: string; error?: string };
        if (!response.ok || !body.id)
          throw new Error(body.error || "草稿保存失败，图片已保留，请重试。");
        const saved = await loadReceipt(body.id);
        if (!saved) throw new Error("草稿已保存，但暂时未同步，请重试。");
        draftRef.current = saved;
      }
      setStage("图片与草稿已保存，正在加载本地识别");
      const result = await runReceiptOcr(
        pages,
        (p: number, message?: string) => {
          setProgress(p);
          setStage(message || "正在识别票面文字");
        },
      );
      const occurredAt =
        result.occurredAt &&
        !Number.isNaN(new Date(result.occurredAt).getTime())
          ? new Date(result.occurredAt).toISOString()
          : "";
      let draft: ReceiptDraft = {
        ...result,
        items: applyDraftCatalog(result.items || [], catalogRef.current),
        review: {
          mode: "exceptions",
          checkedIssueKeys: [],
          summaryConfirmed: false,
        },
        occurredAt,
        memberId: selected,
        uploadIds,
        receiptId: draftRef.current.id,
        version: draftRef.current.version,
      };
      resultRef.current = draft;
      const update = await fetch("/api/concierge/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "saveReceipt",
          requestId: uid(),
          payload: {
            id: draftRef.current.id,
            version: draftRef.current.version,
            memberId: selected,
            number: result.number || "",
            store: result.store || "",
            occurredAt,
            kind: "结算单",
            status: "待核对",
            amount: result.amount || "",
            payments: result.payments || [],
            items: draft.items || [],
            review: {
              mode: "exceptions",
              checkedIssueKeys: [],
              summaryConfirmed: false,
            },
            totals: result.totals || {},
            details: result.details || {},
            warnings: result.warnings || [],
            itemsReviewed: false,
            itemsText: result.itemsText || "",
            rawText: result.rawText || "",
            note: "本地识别草稿，待人工核对",
            uploadIds,
            originalReceiptId: "",
          },
        }),
      });
      const updated = (await update.json()) as { error?: string };
      if (!update.ok)
        throw new Error(
          updated.error || "识别草稿保存失败，原图与初始草稿已保留。",
        );
      const saved = await loadReceipt(draftRef.current!.id);
      if (saved) {
        draftRef.current = saved;
        draft = {
          ...draft,
          version: saved.version,
          payments: saved.payments.map((p) => ({
            method: p.method,
            amount: amount(p.amountCents),
            memberId: p.memberId,
            originalMethod: p.originalMethod || p.method,
          })),
          items: saved.items?.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unitPrice: amount(i.unitPriceCents),
            amount: amount(i.amountCents),
            rawText: i.rawText,
            ocrName: i.ocrName ?? i.name,
            catalogItemId: i.catalogItemId,
            packageIncluded: i.packageIncluded,
          })),
          review: saved.review || draft.review,
          totals: saved.totals
            ? {
                subtotal: amount(saved.totals.subtotalCents),
                due: amount(saved.totals.dueCents),
                rounding: amount(saved.totals.roundingCents),
                paid: amount(saved.totals.paidCents),
              }
            : draft.totals,
          details: saved.details || draft.details,
          warnings: saved.warnings || draft.warnings,
          itemsReviewed: saved.itemsReviewed,
        };
      }
      resultRef.current = draft;
      setRaw(draft);
      setProgress(1);
      setStage("识别草稿已保存，请核对关键字段");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "识别失败，可重试或直接核对图片。",
      );
    } finally {
      setWorking(false);
    }
  }
  useEffect(() => {
    if (raw && uploaded.length) {
      onDone({ ...raw, uploadIds: uploaded.map((u) => u.id) });
    }
  }, [raw, uploaded, onDone]);
  return (
    <Dialog
      title="拍摄消费单"
      subtitle="先保存照片，再识别为草稿；核对后才确认消费。"
      onClose={close}
    >
      <div className="modal-content capture-content">
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <Field label="关联会员（不确定可稍后选择）">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={working || !!uploaded.length}
          >
            <option value="">待核实会员</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} · {m.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="capture-upload">
          <Camera size={36} />
          <h3>拍清票头、项目明细和结算区</h3>
          <p>
            拍到每项名称、数量和金额；长单可分段并保留少量重叠。最多4张，JPEG /
            PNG / WebP。
          </p>
          <div className="capture-buttons">
            <label className={`btn btn-primary ${working ? "disabled" : ""}`}>
              <Camera size={17} />
              拍照
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                disabled={working || !!uploaded.length}
                onChange={(e) => {
                  choose(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <label className="btn btn-secondary">
              <ImagePlus size={17} />
              选照片
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                disabled={working || !!uploaded.length}
                onChange={(e) => {
                  choose(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
        {files.length > 0 && (
          <div className="capture-previews">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`}>
                <img src={previews[i]} alt={`消费凭证第${i + 1}页`} />
                <span>第{i + 1}页</span>
                {!working && !uploaded.length && (
                  <button
                    aria-label={`移除第${i + 1}页`}
                    onClick={() => {
                      setFiles(files.filter((_, n) => n !== i));
                      prepared.current = [];
                    }}
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {(working || uploaded.length > 0) && (
          <div className="ocr-progress">
            <div>
              <span>{stage || "图片已保存，可继续核对"}</span>
              <strong>{Math.round(progress * 100)}%</strong>
            </div>
            <progress value={progress} max={1} />
            <small>
              识别在当前浏览器进行；耗时取决于设备、页数和图片清晰程度。
            </small>
          </div>
        )}
        <div className="detail-notice">
          <ShieldCheck size={15} />
          识别不发起扣款，也不修改会员余额。无法识别的内容保留待核，不补成零。
        </div>
      </div>
      <div className="modal-footer">
        <button
          className="btn btn-secondary"
          onClick={close}
          disabled={working}
        >
          取消
        </button>
        {uploaded.length > 0 && !working && (
          <button
            className="btn btn-secondary"
            onClick={() =>
              onDone({
                ...resultRef.current,
                memberId: selected,
                uploadIds: uploaded.map((u) => u.id),
                rawText: resultRef.current?.rawText || raw?.rawText || "",
                receiptId: draftRef.current?.id,
                version: draftRef.current?.version,
              })
            }
          >
            直接核对图片
          </button>
        )}
        <button
          className="btn btn-primary"
          onClick={() => void recognize()}
          disabled={working || !files.length}
        >
          {working ? (
            <RefreshCw size={16} className="spin" />
          ) : (
            <Sparkles size={16} />
          )}{" "}
          {working
            ? "正在处理…"
            : uploaded.length
              ? "重试识别"
              : "保存图片并识别"}
        </button>
      </div>
    </Dialog>
  );
}
