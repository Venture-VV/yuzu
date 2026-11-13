import { useEffect, useState } from "react";
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, RefreshCw, Search, Users, X } from "lucide-react";
import { Dialog } from "../../components/Overlay";
import { api } from "../../lib/api";
import { useCan } from "../../lib/session";
import type { NativeMemberSummary } from "./types";
import type { InsightMember, MemberInsights, InsightDormancyBucket } from "@shared/concierge/insights-types";
import "./member-insights.css";

const money = (v: number) => (v / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const visitTime = (value: string | null, timezone = "Asia/Shanghai") => value
  ? new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value))
  : "暂无到访记录";
const BUCKETS: Array<{ id: Exclude<InsightDormancyBucket, "recent" | "never">; title: string; detail: string }> = [
  { id: "oneToThree", title: "1—3个月未到访", detail: "满1个月 · 不足3个月" },
  { id: "threeToSix", title: "3—6个月未到访", detail: "满3个月 · 不足6个月" },
  { id: "sixToTwelve", title: "6—12个月未到访", detail: "满6个月 · 不足12个月" },
  { id: "twelvePlus", title: "12个月及以上", detail: "至少12个月未到访" },
];
const storeMonth = (data: MemberInsights) => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: data.timezone, year: "numeric", month: "2-digit" }).formatToParts(new Date(data.serverTime));
  return parts.find((p) => p.type === "year")!.value + "-" + parts.find((p) => p.type === "month")!.value;
};
const monthLabel = (month: string) => month.slice(0, 4) + "年" + Number(month.slice(5)) + "月";

function useInsights(params: string) {
  const [state, setState] = useState<{ params: string; data: MemberInsights | null; error: string }>({ params: "", data: null, error: "" });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true, inFlight = false;
    setState({ params, data: null, error: "" });
    const run = async () => {
      if (!live || inFlight || document.hidden) return;
      if (navigator.onLine === false) { setState((s) => ({ ...s, error: "当前离线，恢复联网后将自动同步" })); return; }
      inFlight = true;
      try {
        const next = await api.get<MemberInsights>("/api/concierge/member-insights?" + params);
        if (live) setState({ params, data: next, error: "" });
      } catch (e) {
        if (live) setState((s) => ({ ...s, error: e instanceof Error ? e.message : "会员情况暂时无法获取" }));
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
  return { data: state.params === params ? state.data : null, error: state.params === params ? state.error : "", refresh: () => setRefresh((v) => v + 1) };
}

function Overview({ data, onAction }: { data: MemberInsights | null; onAction: (kind: "tiers" | "recent" | "growth" | "dormant") => void }) {
  const s = data?.stats;
  const delta = s ? (s.newDelta > 0 ? "+" : "") + s.newDelta : "—";
  const cards = [
    { kind: "tiers" as const, name: "总会员人数", value: s?.totalMembers ?? "—", note: "会员系统主账号去重", action: "查看全部会员档阶", link: "进入会员中心" },
    { kind: "recent" as const, name: "近1个月到店会员", value: s?.visitedLastMonth ?? "—", note: "按实际入场记录去重", action: "查看近1个月到店会员", link: "查看到店会员" },
    { kind: "growth" as const, name: "本月新增较上月", value: delta, note: s ? "本月新增 " + s.newThisMonth + " · 上月新增 " + s.newLastMonth : "比较自然月新增会员人数", action: "查看新增会员趋势", link: "查看月份趋势与名单" },
    { kind: "dormant" as const, name: "沉睡会员人数", value: s?.dormantThreeMonths ?? "—", note: "满3个月未到访", action: "查看沉睡会员名单", link: "查看沉睡会员" },
  ];
  return <section className="member-overview" aria-label="会员经营概览">
    {cards.map((c) => <button type="button" className="member-overview-card" key={c.name} disabled={!data} aria-label={c.action} onClick={() => onAction(c.kind)}>
      <span>{c.name}</span><strong>{c.value}<small>人</small></strong><p>{c.note}</p><span className="overview-link">{c.link}<ArrowRight size={14} /></span>
    </button>)}
  </section>;
}

function MemberRows({ data, onOpen, created = false }: { data: MemberInsights; onOpen: (member: InsightMember) => void; created?: boolean }) {
  return <div className="table-scroll"><table className="data-table"><thead><tr>
    <th>会员</th><th>会员档阶</th><th>系统余额</th>{created ? <th>会员建立时间</th> : <><th>未到访时间</th><th>上一次到访</th></>}<th>详情</th>
  </tr></thead><tbody>{data.members.map((m) => <tr key={m.id}>
    <td><button type="button" className="member-cell" onClick={() => onOpen(m)}>
      <span className="avatar">{m.name.slice(0, 1)}</span><span><strong>{m.name}</strong><small>{m.memberNo} · {m.phone || "未留手机"}</small></span>
    </button></td>
    <td><span className={"tier-tag grade-" + m.grade}>{m.gradeLabel}</span>{m.status !== "active" && <small className="cell-sub">已停用</small>}</td>
    <td><strong className={m.totalCents < 3000000 ? "orange-text" : ""}>¥{money(m.totalCents)}</strong>
      <small className="cell-sub">本金 ¥{money(m.principalCents)} ＋ 赠金 ¥{money(m.bonusCents)}</small></td>
    {created ? <td>{visitTime(m.createdAt, data.timezone)}</td> : <>
      <td>{m.daysSinceLastVisit == null ? "暂无到访记录" : m.daysSinceLastVisit === 0 ? "今日到访" : m.daysSinceLastVisit + "天未到访"}
        {["threeToSix", "sixToTwelve", "twelvePlus"].includes(m.dormancyBucket) && <small className="cell-sub orange-text">沉睡会员</small>}</td>
      <td>{visitTime(m.lastVisitAt, data.timezone)}</td>
    </>}
    <td><button type="button" className="text-btn" onClick={() => onOpen(m)}>查看档案<ArrowRight size={14} /></button></td>
  </tr>)}</tbody></table></div>;
}

function Pagination({ data, offset, onChange }: { data: MemberInsights; offset: number; onChange: (offset: number) => void }) {
  return <div className="insights-pagination">
    <span>共{data.filteredTotal}位 · 第{Math.floor(offset / data.limit) + 1}页</span>
    <button type="button" className="btn btn-secondary small-btn" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - data.limit))}><ChevronLeft size={14} />上一页</button>
    <button type="button" className="btn btn-secondary small-btn" disabled={!data.hasMore} onClick={() => onChange(offset + data.limit)}>下一页<ChevronRight size={14} /></button>
  </div>;
}

function useValidPage(data: MemberInsights | null, offset: number, setOffset: (offset: number) => void) {
  const total = data?.filteredTotal, limit = data?.limit;
  useEffect(() => {
    if (total !== undefined && limit && offset > 0 && offset >= total)
      setOffset(Math.max(0, Math.floor((total - 1) / limit) * limit));
  }, [total, limit, offset, setOffset]);
}

function ReadStatus({ data, error, refresh }: ReturnType<typeof useInsights>) {
  return <>{error && <div className="insights-error" role="alert">{error}{data ? "；当前内容可能尚未更新。" : ""}<button type="button" className="text-btn" onClick={refresh}>重试</button></div>}
    {!data && !error && <p className="insights-empty" role="status">正在读取会员系统…</p>}</>;
}

function GrowthChart({ growth, selected, onMonth }: { growth: MemberInsights["growth"]; selected: string; onMonth: (month: string) => void }) {
  const max = Math.max(2, Math.ceil(Math.max(0, ...growth.months.map((m) => m.count)) / 2) * 2);
  const y = (count: number) => 150 - count / max * 120;
  const points = growth.months.map((m, i) => ({ ...m, x: 35 + i * 60, y: y(m.count) }));
  const available = points.filter((m) => m.available);
  return <div className="growth-chart-scroll"><div className="growth-chart" aria-label={`${growth.year}年每月新增会员趋势`}>
    <svg viewBox="0 0 730 178" preserveAspectRatio="none" role="img" aria-label="新增人数折线图，具体月份与人数见下方可点击按钮">
      {[0, 0.5, 1].map((ratio) => <g key={ratio}><line x1="25" x2="720" y1={y(max * ratio)} y2={y(max * ratio)} className="growth-grid" /><text x="2" y={y(max * ratio) - 5}>{Math.round(max * ratio)}</text></g>)}
      {available.length > 0 && <polyline points={available.map((p) => `${p.x},${p.y}`).join(" ")} className="growth-line" />}
      {points.filter((p) => p.available).map((p) => <g key={p.month}><circle cx={p.x} cy={p.y} r={selected === p.month ? 7 : 4} className={selected === p.month ? "growth-dot selected" : "growth-dot"} /><text x={p.x} y={Math.max(14, p.y - 13)} textAnchor="middle" className="growth-count">{p.count}</text></g>)}
    </svg>
    <div className="growth-months">{growth.months.map((m) => <button type="button" key={m.month} disabled={!m.available} aria-pressed={selected === m.month} aria-label={`${monthLabel(m.month)}，新增${m.count}人`} className={selected === m.month ? "selected" : ""} onClick={() => onMonth(m.month)}>{Number(m.month.slice(5))}月<small>{m.available ? m.count + "人" : "未到"}</small></button>)}</div>
  </div></div>;
}

function MemberDrilldown({ kind, initialMonth, onClose, onOpen }: { kind: "recent" | "growth"; initialMonth: string; onClose: () => void; onOpen: (member: InsightMember) => void }) {
  const [month, setMonth] = useState(initialMonth);
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ offset: String(offset) });
  if (kind === "recent") params.set("bucket", "recent");
  else { params.set("createdMonth", month); params.set("trendYear", month.slice(0, 4)); }
  const read = useInsights(params.toString());
  const { data } = read;
  useValidPage(data, offset, setOffset);
  const chooseMonth = (value: string) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= "1900-01" && value <= initialMonth) { setMonth(value); setOffset(0); } };
  const chooseYear = (delta: number) => {
    const year = Number(month.slice(0, 4)) + delta;
    chooseMonth(year === Number(initialMonth.slice(0, 4)) ? initialMonth : String(year) + month.slice(4));
  };
  const open = (member: InsightMember) => { onClose(); onOpen(member); };
  return <Dialog open onClose={onClose} title={kind === "growth" ? "新增会员趋势" : "近1个月到店会员"}
    description={kind === "growth" ? "点击月份查看新增人数与对应会员。按会员系统实际建立时间统计，合并主账号去重。" : "最近1个日历月内实际到店的会员，按前台有效入场记录去重。"} width={kind === "growth" ? "max-w-6xl" : "max-w-4xl"}>
    <div className="concierge-workspace member-insights-dialog">
      {kind === "growth" && <section className="growth-section">
        <div className="growth-toolbar"><div><span>会员增长</span><h3>{month.slice(0, 4)}年 · 每月新增人数</h3></div><div className="growth-year-controls">
          <button type="button" aria-label="上一年" className="btn btn-secondary small-btn" disabled={Number(month.slice(0, 4)) <= 1900} onClick={() => chooseYear(-1)}><ChevronLeft size={16} /></button>
          <label><span className="sr-only">选择新增月份</span><input type="month" aria-label="选择新增月份" min="1900-01" max={initialMonth} value={month} onChange={(e) => chooseMonth(e.target.value)} /></label>
          <button type="button" aria-label="下一年" className="btn btn-secondary small-btn" disabled={Number(month.slice(0, 4)) >= Number(initialMonth.slice(0, 4))} onClick={() => chooseYear(1)}><ChevronRight size={16} /></button>
        </div></div>
        {data && <GrowthChart growth={data.growth} selected={month} onMonth={chooseMonth} />}
        <p className="insights-rule">单位：人 · 当前月份统计截至现在；可左右滑动查看全部月份。</p>
      </section>}
      <ReadStatus {...read} />
      {data && <section className="panel insights-list" aria-label={kind === "growth" ? "新增会员名单" : "近1个月到店名单"}>
        <div className="panel-header"><div><h3>{kind === "growth" ? monthLabel(month) + "新增会员" : "近1个月到店会员"}</h3><span className="count-tag">{data.filteredTotal}人</span></div><button type="button" className="text-btn" onClick={read.refresh}><RefreshCw size={14} />刷新</button></div>
        <MemberRows data={data} onOpen={open} created={kind === "growth"} />
        {!data.members.length && <p className="insights-empty">{kind === "growth" ? "这个月暂时没有新增会员。" : "近1个月暂无实际到店会员。"}</p>}
        <Pagination data={data} offset={offset} onChange={setOffset} />
      </section>}
    </div>
  </Dialog>;
}

export function MemberInsightsView({ mode, onOpen, onNavigate, initialBucket = "" }: {
  mode: "directory" | "situation" | "tiers";
  onOpen: (member: InsightMember) => void;
  onNavigate?: (target: "tiers" | "dormant") => void;
  initialBucket?: "" | "dormant";
}) {
  const [query, setQuery] = useState("");
  const [grade, setGrade] = useState("");
  const [bucket, setBucket] = useState<string>(initialBucket);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<{ kind: "recent" | "growth"; month: string } | null>(null);
  const params = new URLSearchParams({ q: query, offset: String(offset) });
  if (grade !== "") params.set("grade", grade);
  if (bucket !== "") params.set("bucket", bucket);
  const read = useInsights(params.toString());
  const { data } = read;
  useValidPage(data, offset, setOffset);
  const chooseGrade = (value: string) => { setGrade(value); setOffset(0); };
  const chooseBucket = (value: string) => { setBucket(value); setOffset(0); };
  const action = (kind: "tiers" | "recent" | "growth" | "dormant") => {
    if (kind === "tiers" || kind === "dormant") onNavigate?.(kind);
    else if (data) setDetail({ kind, month: storeMonth(data) });
  };
  return <div className="member-insights">
    {mode === "directory" && <Overview data={data} onAction={action} />}
    {mode === "situation" && <>
      <section className="dormancy-cards" aria-label="会员未到访分类">
        {BUCKETS.map((b) => <button type="button" key={b.id} className={"dormancy-card" + (bucket === b.id ? " selected" : "")}
          aria-pressed={bucket === b.id} onClick={() => chooseBucket(bucket === b.id ? "" : b.id)}>
          <CalendarDays size={19} /><span>{b.title}</span><strong>{data?.dormancyGroups[b.id] ?? "—"}<small>人</small></strong><p>{b.detail}</p>
        </button>)}
      </section>
      <p className="insights-rule">按前台有效实际入场统计，四个时间段互不重叠。沉睡人数为有到访记录且满3个月未到访。预约、充值、消费和管家接待登记均不代替入场。</p>
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
        <div><h2>{mode === "situation" ? bucket === "dormant" ? "沉睡会员名单" : "会员到访情况" : mode === "tiers" ? "档阶会员名单" : "全部系统会员"}</h2>
          <span className="count-tag">{data ? data.filteredTotal + "位会员" : "正在获取"}</span></div>
        <button type="button" className="text-btn" onClick={read.refresh}><RefreshCw size={14} />刷新</button>
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
          <option value="">全部到访情况</option><option value="recent">近1个月到访</option><option value="dormant">沉睡会员（满3个月）</option>
          {BUCKETS.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>}
      </div>
      <ReadStatus {...read} />
      {data && <><MemberRows data={data} onOpen={onOpen} />
        {!data.members.length && <p className="insights-empty">当前条件下没有会员，试试其他档阶或时间段。</p>}
        <Pagination data={data} offset={offset} onChange={setOffset} />
      </>}
    </section>
    {detail && <MemberDrilldown kind={detail.kind} initialMonth={detail.month} onClose={() => setDetail(null)} onOpen={onOpen} />}
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
        <dl className="native-preview-facts"><div><dt>上一次到访</dt><dd>{visitTime(member.lastVisitAt)}</dd></div><div><dt>未到访时间</dt><dd>{member.daysSinceLastVisit == null ? "暂无到访记录" : member.daysSinceLastVisit + "天"}</dd></div><div><dt>会员建立时间</dt><dd>{visitTime(member.createdAt)}</dd></div><div><dt>会员状态</dt><dd>{member.status === "active" ? "在用" : "已停用"}</dd></div></dl>
        <section><h3>管家服务档案</h3>{member.profiles.length ? member.profiles.map((p) => <button type="button" key={p.id} className="native-profile-link" onClick={() => onOpenService(p.id)}>{p.code} · {p.name}<ArrowRight size={16} /></button>) : <>
          <p className="insights-rule">这位会员尚未建立管家服务档案。系统资料、余额与到访情况可直接查看，建立服务档案后可继续记录预约、消费凭证和服务事项。</p>
          {can("concierge.operate") && <button type="button" className="btn btn-primary" disabled={member.status !== "active"} onClick={() => onCreate(member)}><Users size={16} />建立服务档案</button>}
        </>}</section>
      </div>}
    </aside>
  </div>;
}
