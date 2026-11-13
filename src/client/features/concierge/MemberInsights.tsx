import { useEffect, useState } from "react";
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, RefreshCw, Search, Users, X } from "lucide-react";
import { api } from "../../lib/api";
import { useCan } from "../../lib/session";
import type { NativeMemberSummary } from "./types";
import type { InsightMember, MemberInsights, InsightDormancyBucket } from "@shared/concierge/insights-types";
import "./member-insights.css";

const money = (v: number) => (v / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const visitTime = (value: string | null, timezone = "Asia/Shanghai") => value
  ? new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value))
  : "从未到访";
const BUCKETS: Array<{ id: Exclude<InsightDormancyBucket, "recent">; title: string; detail: string }> = [
  { id: "oneToThree", title: "1—3个月未到访", detail: "满1个月 · 不足3个月" },
  { id: "threeToSix", title: "3—6个月未到访", detail: "满3个月 · 不足6个月" },
  { id: "sixToTwelve", title: "6—12个月未到访", detail: "满6个月 · 不足12个月" },
  { id: "twelvePlus", title: "12个月及以上", detail: "至少12个月未到访" },
  { id: "never", title: "从未到访", detail: "尚无前台实际入场记录" },
];

function useInsights(params: string) {
  const [data, setData] = useState<MemberInsights | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true, inFlight = false;
    setData(null);
    setError("");
    const run = async () => {
      if (!live || inFlight || document.hidden) return;
      if (navigator.onLine === false) { setError("当前离线，恢复联网后将自动同步"); return; }
      inFlight = true;
      try {
        const next = await api.get<MemberInsights>("/api/concierge/member-insights?" + params);
        if (live) { setData(next); setError(""); }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "会员情况暂时无法获取");
      } finally { inFlight = false; }
    };
    const debounce = window.setTimeout(() => void run(), 220);
    const timer = window.setInterval(() => void run(), 3000);
    const wake = () => void run();
    for (const name of ["focus", "online", "offline", "concierge-data-changed"]) window.addEventListener(name, wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false;
      clearTimeout(debounce); clearInterval(timer);
      for (const name of ["focus", "online", "offline", "concierge-data-changed"]) window.removeEventListener(name, wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [params, refresh]);
  return { data, error, refresh: () => setRefresh((v) => v + 1) };
}

function Overview({ data }: { data: MemberInsights | null }) {
  const s = data?.stats;
  const delta = s ? (s.newDelta > 0 ? "+" : "") + s.newDelta : "—";
  const cards = [
    { name: "总会员人数", value: s?.totalMembers ?? "—", note: "会员系统主账号去重" },
    { name: "近1个月到店会员", value: s?.visitedLastMonth ?? "—", note: "按实际入场记录去重" },
    { name: "本月新增较上月", value: delta, note: s ? "本月新增 " + s.newThisMonth + " · 上月新增 " + s.newLastMonth : "比较自然月新增会员人数" },
    { name: "沉睡会员人数", value: s?.dormantThreeMonths ?? "—", note: "满3个月未到访 · 从未到访另列" },
  ];
  return <section className="member-overview" aria-label="会员经营概览">
    {cards.map((c) => <article className="member-overview-card" key={c.name}>
      <span>{c.name}</span><strong>{c.value}<small>人</small></strong><p>{c.note}</p>
    </article>)}
  </section>;
}

export function MemberInsightsView({ mode, onOpen }: {
  mode: "directory" | "situation" | "tiers";
  onOpen: (member: InsightMember) => void;
}) {
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("");
  const [bucket, setBucket] = useState("");
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ q: query, offset: String(offset) });
  if (grade !== "") params.set("grade", grade);
  if (bucket !== "") params.set("bucket", bucket);
  const { data, error, refresh } = useInsights(params.toString());
  const chooseGrade = (value: string) => { setGrade(value); setOffset(0); };
  const chooseBucket = (value: string) => { setBucket(value); setOffset(0); };
  return <div className="member-insights">
    {mode === "directory" && <Overview data={data} />}
    {mode === "situation" && <>
      <section className="dormancy-cards" aria-label="会员未到访分类">
        {BUCKETS.map((b) => <button type="button" key={b.id} className={"dormancy-card" + (bucket === b.id ? " selected" : "")}
          aria-pressed={bucket === b.id} onClick={() => chooseBucket(bucket === b.id ? "" : b.id)}>
          <CalendarDays size={19} /><span>{b.title}</span><strong>{data?.dormancyGroups[b.id] ?? "—"}<small>人</small></strong><p>{b.detail}</p>
        </button>)}
      </section>
      <p className="insights-rule">按前台有效实际入场统计，四个时间段互不重叠。沉睡人数为满3个月未到访；从未到访单列。预约、充值、消费和管家接待登记均不代替入场。</p>
    </>}
    {mode === "tiers" && <>
      <section className="member-grade-cards" aria-label="会员档阶分层">
        {(data?.tiers ?? Array.from({ length: 7 }, (_, i) => ({ grade: i, label: "L" + i, count: null }))).map((t) =>
          <button type="button" key={t.grade} className={"member-grade-card grade-" + t.grade + (grade === String(t.grade) ? " selected" : "")}
            aria-pressed={grade === String(t.grade)} onClick={() => chooseGrade(grade === String(t.grade) ? "" : String(t.grade))}>
            <span className="grade-number">L{t.grade}</span><strong>{t.label.replace(/^L\d\s*/, "")}</strong>
            <span className="grade-count">{t.count ?? "—"}<small>人</small></span>
            <span className="grade-card-link">查看会员 <ArrowRight size={14} /></span>
          </button>)}
      </section>
      <p className="insights-rule">档级名称与初／享／尊阶读取会员系统，随前台更新。低余额继续作为独立服务关注提醒。</p>
    </>}
    <section className="panel insights-list">
      <div className="panel-header">
        <div><h2>{mode === "situation" ? "会员到访情况" : mode === "tiers" ? "档阶会员名单" : "全部系统会员"}</h2>
          <span className="count-tag">{data ? data.stats.totalMembers + "位系统会员" : "正在获取"}</span></div>
        <button type="button" className="text-btn" onClick={refresh}><RefreshCw size={14} />刷新</button>
      </div>
      <div className="insights-filters">
        <label className="insights-search"><Search size={16} /><input aria-label="搜索系统会员" placeholder="姓名、手机号、会员号" value={query}
          onChange={(e) => { setQuery(e.target.value); setOffset(0); }} /></label>
        <select aria-label="会员档阶筛选" value={grade} onChange={(e) => chooseGrade(e.target.value)}>
          <option value="">全部会员档阶</option>
          {(data?.tiers ?? Array.from({ length: 7 }, (_, i) => ({ grade: i, label: "L" + i }))).map((t) =>
            <option key={t.grade} value={t.grade}>{t.label}</option>)}
        </select>
        {mode === "situation" && <select aria-label="未到访时间筛选" value={bucket} onChange={(e) => chooseBucket(e.target.value)}>
          <option value="">全部到访情况</option><option value="recent">近1个月到访</option>
          {BUCKETS.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>}
      </div>
      {error && <div className="insights-error" role="alert">{error} <button type="button" className="text-btn" onClick={refresh}>重试</button></div>}
      {!data && !error && <p className="insights-empty" role="status">正在读取会员系统…</p>}
      {data && <><div className="table-scroll">
        <table className="data-table"><thead><tr>
          <th>会员</th><th>会员档阶</th><th>系统余额</th><th>未到访时间</th><th>上一次到访</th><th>详情</th>
        </tr></thead><tbody>{data.members.map((m) => <tr key={m.id}>
          <td><button type="button" className="member-cell" onClick={() => onOpen(m)}>
            <span className="avatar">{m.name.slice(0, 1)}</span><span><strong>{m.name}</strong><small>{m.memberNo} · {m.phone || "未留手机"}</small></span>
          </button></td>
          <td><span className={"tier-tag grade-" + m.grade}>{m.gradeLabel}</span>{m.status !== "active" && <small className="cell-sub">已停用</small>}</td>
          <td><strong className={m.totalCents < 3000000 ? "orange-text" : ""}>¥{money(m.totalCents)}</strong>
            <small className="cell-sub">本金 ¥{money(m.principalCents)} ＋ 赠金 ¥{money(m.bonusCents)}</small></td>
          <td>{m.daysSinceLastVisit == null ? "从未到访" : m.daysSinceLastVisit === 0 ? "今日到访" : m.daysSinceLastVisit + "天未到访"}
            {["threeToSix", "sixToTwelve", "twelvePlus"].includes(m.dormancyBucket) && <small className="cell-sub orange-text">沉睡会员</small>}</td>
          <td>{visitTime(m.lastVisitAt, data.timezone)}</td>
          <td><button type="button" className="text-btn" onClick={() => onOpen(m)}>查看档案<ArrowRight size={14} /></button></td>
        </tr>)}</tbody></table>
      </div>
      {!data.members.length && <p className="insights-empty">当前条件下没有会员，试试其他档阶或时间段。</p>}
      <div className="insights-pagination">
        <span>第{Math.floor(offset / data.limit) + 1}页 · 每页最多{data.limit}位</span>
        <button type="button" className="btn btn-secondary small-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.limit))}><ChevronLeft size={14} />上一页</button>
        <button type="button" className="btn btn-secondary small-btn" disabled={!data.hasMore} onClick={() => setOffset(offset + data.limit)}>下一页<ChevronRight size={14} /></button>
      </div></>}
    </section>
  </div>;
}

export function NativeMemberPreview({ id, onClose, onCreate, onOpenService }: {
  id: number; onClose: () => void;
  onCreate: (member: NativeMemberSummary) => void;
  onOpenService: (id: string) => void;
}) {
  const can = useCan();
  const [member, setMember] = useState<InsightMember | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true, inFlight = false;
    setMember(null); setError("");
    const load = async () => {
      if (!live || inFlight || document.hidden) return;
      if (navigator.onLine === false) { setError("当前离线，恢复联网后将自动同步"); return; }
      inFlight = true;
      try {
        const r = await api.get<{ member: InsightMember }>("/api/concierge/member-insights/" + id);
        if (live) { setMember(r.member); setError(""); }
      } catch (e) { if (live) setError(e instanceof Error ? e.message : "会员详情暂不可用"); }
      finally { inFlight = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    const wake = () => void load();
    for (const name of ["focus", "online", "offline"]) window.addEventListener(name, wake);
    document.addEventListener("visibilitychange", wake);
    const before = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => {
      live = false; clearInterval(timer);
      for (const name of ["focus", "online", "offline"]) window.removeEventListener(name, wake);
      document.removeEventListener("visibilitychange", wake);
      document.body.style.overflow = before;
    };
  }, [id, retry]);
  return <div className="drawer-layer">
    <div className="drawer-scrim" onClick={onClose} />
    <aside className="member-drawer native-insight-preview" role="dialog" aria-modal="true" aria-label="系统会员个人档案">
      <div className="drawer-heading"><span>系统会员个人档案</span><button type="button" className="icon-btn" aria-label="关闭系统会员详情" onClick={onClose}><X size={21} /></button></div>
      {error && <p role="alert" className="insights-error">{error}<button type="button" className="text-btn" onClick={() => setRetry((v) => v + 1)}>重试</button></p>}
      {!member && !error && <p className="insights-empty">正在读取会员详情…</p>}
      {member && <div className="native-preview-content">
        <div className="native-preview-identity"><span className="avatar big-avatar">{member.name.slice(0, 1)}</span><div><h2>{member.name}</h2><p>{member.memberNo} · {member.phone || "未留手机"}</p><span className="tier-tag">{member.gradeLabel}</span></div></div>
        <div className="native-preview-balance"><span>系统实时余额</span><strong>¥{money(member.totalCents)}</strong><p>本金 ¥{money(member.principalCents)} ＋ 可用赠金 ¥{money(member.bonusCents)}</p></div>
        <dl className="native-preview-facts"><div><dt>上一次到访</dt><dd>{visitTime(member.lastVisitAt)}</dd></div><div><dt>未到访时间</dt><dd>{member.daysSinceLastVisit == null ? "从未到访" : member.daysSinceLastVisit + "天"}</dd></div><div><dt>会员建立时间</dt><dd>{visitTime(member.createdAt)}</dd></div><div><dt>会员状态</dt><dd>{member.status === "active" ? "在用" : "已停用"}</dd></div></dl>
        <section><h3>管家服务档案</h3>{member.profiles.length ? member.profiles.map((p) => <button type="button" key={p.id} className="native-profile-link" onClick={() => onOpenService(p.id)}>{p.code} · {p.name}<ArrowRight size={16} /></button>) : <>
          <p className="insights-rule">这位会员尚未建立管家服务档案。系统资料、余额与到访情况可直接查看，建立服务档案后可继续记录预约、消费凭证和服务事项。</p>
          {can("concierge.operate") && <button type="button" className="btn btn-primary" disabled={member.status !== "active"} onClick={() => onCreate(member)}><Users size={16} />建立服务档案</button>}
        </>}</section>
      </div>}
    </aside>
  </div>;
}
