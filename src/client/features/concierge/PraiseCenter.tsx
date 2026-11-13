import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowRight,
  Award,
  ChevronLeft,
  ChevronRight,
  Crown,
  Heart,
  ImagePlus,
  Images,
  Medal,
  Plus,
  RefreshCw,
  Sparkles,
  Trophy,
  X,
} from "lucide-react";
import { Dialog } from "../../components/Overlay";
import { Button, Field, Input, Select, Textarea } from "../../components/ui";
import { api } from "../../lib/api";
import { uuid } from "../../lib/utils";
import type {
  PraiseCenterData,
  PraisePage,
  PraiseRanking,
  PraiseRecord,
  PraiseStaff,
} from "@shared/concierge/praise-types";
import type { Member, Upload, WorkspaceData } from "./types";
import { conciergeFetch } from "./api";
import { EvidenceImages, prepareEvidence } from "./ReceiptExperience";
import "./praise-center.css";

type Mutate = (
  action: string,
  payload: Record<string, unknown>,
  operationKey: string,
) => Promise<boolean>;
type Props = {
  data: WorkspaceData;
  busy: boolean;
  saveError: string;
  onMutate: Mutate;
};

const pictureUrl = (id: string) =>
  `/api/concierge/uploads/${encodeURIComponent(id)}`;
const monthLabel = (month: string) => {
  const [year, value] = month.split("-");
  return value ? `${year}年${Number(value)}月` : month;
};
const dateLabel = (date: string) => date.replaceAll("-", "/");
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "网络暂时不可用，请重试";

/** 轮询只更新服务器读模型；表单草稿与操作编号始终留在各自组件中。 */
function usePraiseRead<T>(url: string | null, refresh: number) {
  const [state, setState] = useState<{
    url: string | null;
    data: T | null;
    error: string;
    loading: boolean;
  }>({ url: null, data: null, error: "", loading: false });
  useEffect(() => {
    if (!url) return;
    let live = true;
    let inFlight = false;
    setState({ url, data: null, error: "", loading: true });
    const run = async () => {
      if (!live || inFlight || document.hidden) return;
      if (!navigator.onLine) {
        setState((old) => ({ ...old, error: "设备当前离线，联网后会自动继续同步", loading: false }));
        return;
      }
      inFlight = true;
      try {
        const result = await api.get<T>(url);
        if (live)
          setState((old) => ({
            url,
            data:
              old.url === url && JSON.stringify(old.data) === JSON.stringify(result)
                ? old.data
                : result,
            error: "",
            loading: false,
          }));
      } catch (error) {
        if (live)
          setState((old) => ({
            ...old,
            url,
            error: errorText(error),
            loading: false,
          }));
      } finally {
        inFlight = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 3000);
    const wake = () => void run();
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [url, refresh]);
  return state.url === url
    ? state
    : { url, data: null, error: "", loading: Boolean(url) };
}

function ReadState({
  loading,
  error,
  hasData,
  onRetry,
}: {
  loading: boolean;
  error: string;
  hasData: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      {loading && !hasData && (
        <p className="praise-loading" role="status">正在读取好评记录…</p>
      )}
      {error && (
        <div className="praise-error" role="alert">
          <span>同步失败：{error}{hasData ? "。当前内容可能尚未更新。" : ""}</span>
          <button type="button" className="praise-action praise-link" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
    </>
  );
}

function PraisePhoto({ id, alt }: { id?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  return id && !failed ? (
    <img src={pictureUrl(id)} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span className="praise-photo-fallback"><Images size={28} /><span>点击查看原始凭证</span></span>
  );
}

function RankMedal({ rank }: { rank: number | null }) {
  return (
    <span className={`praise-medal praise-medal-${rank && rank <= 3 ? rank : "other"}`}>
      {rank === 1 ? <Crown size={21} /> : <Medal size={21} />}
      <span>{rank ? `第${rank}名` : "待上榜"}</span>
    </span>
  );
}

function RankingBoard({
  month,
  ranking,
  onStaff,
}: {
  month: string;
  ranking: PraiseRanking[];
  onStaff: (staff: PraiseStaff) => void;
}) {
  const ranked = ranking.filter((staff) => staff.rank !== null && staff.count > 0);
  const leaders = ranked.filter((staff) => staff.rank! <= 3);
  return (
    <section className="praise-ranking" aria-label="上月好评榜">
      <div className="praise-section-title">
        <div><span className="praise-eyebrow">服务被看见 · 荣誉有记录</span><h3><Trophy size={20} />上月好评榜</h3></div>
        <span className="praise-period">{monthLabel(month)}</span>
      </div>
      {leaders.length ? (
        <div className="praise-podium">
          {leaders.map((staff) => (
            <button type="button" className={`praise-honoree praise-rank-${staff.rank}`} key={staff.id} onClick={() => onStaff(staff)}>
              <RankMedal rank={staff.rank} />
              <span className="praise-avatar">{staff.name.slice(0, 1)}</span>
              <strong>{staff.name}</strong>
              {!staff.active && <small>历史管家</small>}
              <span className="praise-honoree-count"><b>{staff.count}</b> 条有效好评</span>
              <span className="praise-honoree-link">查看个人荣誉 <ArrowRight size={13} /></span>
            </button>
          ))}
        </div>
      ) : (
        <div className="praise-empty praise-ranking-empty"><Award size={34} /><strong>等待第一份服务荣誉</strong><p>上月还没有有效好评记录，新记录会按好评日期归入对应月份。</p></div>
      )}
      {ranked.length > leaders.length && (
        <details className="praise-all-ranking">
          <summary>查看完整榜单（{ranked.length}位）</summary>
          {ranked.filter((staff) => !leaders.some((top) => top.id === staff.id)).map((staff) => (
            <button type="button" className="praise-ranking-row" key={staff.id} onClick={() => onStaff(staff)}>
              <span>第{staff.rank}名</span><strong>{staff.name}{!staff.active ? " · 历史管家" : ""}</strong><span>{staff.count} 条<ChevronRight size={15} /></span>
            </button>
          ))}
        </details>
      )}
      <p className="praise-caption">按当月有效好评记录数排名；同数同名次，一条好评附多张图片仍计一条。</p>
    </section>
  );
}

function PraiseCards({
  records,
  onRecord,
}: {
  records: PraiseRecord[];
  onRecord: (id: string) => void;
}) {
  return (
    <div className="praise-photo-wall">
      {records.map((record) => (
        <button type="button" key={record.id} className={`praise-proof-card ${record.status === "voided" ? "is-voided" : ""}`} onClick={() => onRecord(record.id)}>
          <span className="praise-proof-image">
            <PraisePhoto id={record.uploadIds[0]} alt={`${record.guestName}的好评凭证`} />
            <span className="praise-image-count"><Images size={13} />{record.uploadIds.length} 张凭证</span>
            {record.status === "voided" && <span className="praise-voided-tag">已撤销</span>}
          </span>
          <span className="praise-proof-body">
            <span className="praise-proof-source">{record.source} · {dateLabel(record.occurredOn)}</span>
            <strong>{record.guestName}的好评</strong>
            <span className="praise-proof-content">{record.content}</span>
            <span className="praise-proof-footer"><span><Heart size={14} />{record.staffName}</span><span>查看详情 <ArrowRight size={13} /></span></span>
          </span>
        </button>
      ))}
    </div>
  );
}

function PraiseFeed({
  month,
  staffId,
  status = "active",
  refresh,
  onRecord,
}: {
  month?: string;
  staffId?: string;
  status?: string;
  refresh: number;
  onRecord: (id: string) => void;
}) {
  const [cursors, setCursors] = useState([""]);
  const [retry, setRetry] = useState(0);
  const filterKey = `${month || ""}/${staffId || ""}/${status}`;
  const previousFilter = useRef(filterKey);
  // 参数变化时立即使用第一页，避免先发一次旧游标的新筛选请求。
  const pageCursors = previousFilter.current === filterKey ? cursors : [""];
  useEffect(() => {
    previousFilter.current = filterKey;
    setCursors([""]);
  }, [filterKey]);
  const params = new URLSearchParams({ status, limit: "12" });
  if (month) params.set("month", month);
  if (staffId) params.set("staffId", staffId);
  const cursor = pageCursors.at(-1);
  if (cursor) params.set("cursor", cursor);
  const result = usePraiseRead<PraisePage>(`/api/concierge/praise?${params}`, refresh + retry);
  return (
    <div className="praise-feed">
      <ReadState loading={result.loading} error={result.error} hasData={Boolean(result.data)} onRetry={() => setRetry((n) => n + 1)} />
      {result.data && !result.data.records.length && !result.error && (
        <div className="praise-empty"><Heart size={30} /><strong>{pageCursors.length > 1 ? "这一页暂无记录" : "还没有符合条件的好评"}</strong><p>录入客人的真实好评并附上图片，服务的点滴会在这里留下记录。</p></div>
      )}
      {result.data && <PraiseCards records={result.data.records} onRecord={onRecord} />}
      {(pageCursors.length > 1 || result.data?.nextCursor) && (
        <div className="praise-pagination">
          <button type="button" className="praise-action praise-outline" disabled={pageCursors.length === 1 || result.loading} onClick={() => setCursors((old) => old.slice(0, -1))}><ChevronLeft size={16} />上一页</button>
          <span>第 {pageCursors.length} 页</span>
          <button type="button" className="praise-action praise-outline" disabled={!result.data?.nextCursor || result.loading} onClick={() => { const next = result.data?.nextCursor; if (next) setCursors([...pageCursors, next]); }}>下一页<ChevronRight size={16} /></button>
        </div>
      )}
    </div>
  );
}

export function PraiseCenter({ data, busy, saveError, onMutate }: Props) {
  const [refresh, setRefresh] = useState(0);
  const center = usePraiseRead<PraiseCenterData>("/api/concierge/praise/center", refresh);
  const [month, setMonth] = useState<string | null>(null);
  const [staffFilter, setStaffFilter] = useState("");
  const [status, setStatus] = useState("active");
  const [entryOpen, setEntryOpen] = useState(false);
  const [historyStaff, setHistoryStaff] = useState<PraiseStaff | null>(null);
  const [recordId, setRecordId] = useState("");
  const changed = () => setRefresh((n) => n + 1);
  const currentMonth = month === null ? center.data?.month : month;
  const staffCards = useMemo(() => {
    if (!center.data) return [];
    const known = new Map(center.data.staff.map((staff) => [staff.id, staff]));
    for (const staff of center.data.currentMonthRanking)
      if (staff.count > 0 && !known.has(staff.id)) known.set(staff.id, staff);
    return [...known.values()].map((staff) => ({
      ...staff,
      count: center.data!.currentMonthRanking.find((item) => item.id === staff.id)?.count || 0,
    }));
  }, [center.data]);
  return (
    <section className="praise-center" aria-label="好评中心">
      <header className="praise-hero">
        <div className="praise-hero-copy">
          <span className="praise-eyebrow"><Sparkles size={15} />管家部 · 服务荣誉</span>
          <h2>把每一份认可，<br />留在荣誉墙上。</h2>
          <p>记录客人的真实好评，看见每一位管家的用心。</p>
          <div className="praise-hero-actions">
            {center.data?.canOperate && <button type="button" className="praise-action praise-primary" onClick={() => setEntryOpen(true)}><Plus size={17} />录入好评</button>}
            <button type="button" className="praise-action praise-link" onClick={changed}><RefreshCw size={15} />刷新</button>
          </div>
        </div>
        <div className="praise-month-award">
          <span className="praise-award-icon"><Trophy size={29} /></span>
          <span>{center.data ? monthLabel(center.data.month) : "本月"} · 有效好评</span>
          <strong>{center.data ? center.data.monthCount : "—"}<small>条</small></strong>
          <span className="praise-award-note">每一条，都有客人的原始凭证</span>
        </div>
      </header>
      <ReadState loading={center.loading} error={center.error} hasData={Boolean(center.data)} onRetry={changed} />
      {center.data && (
        <>
          <RankingBoard month={center.data.previousMonth} ranking={center.data.previousMonthRanking} onStaff={setHistoryStaff} />
          <section className="praise-team" aria-label="管家荣誉档案">
            <div className="praise-section-title"><div><span className="praise-eyebrow">每一份用心，都值得被看见</span><h3><Award size={20} />管家荣誉档案</h3></div><span className="praise-period">本月好评 · 点击查看全部历史</span></div>
            {staffCards.length ? <div className="praise-staff-grid">{staffCards.map((staff) => (
              <button type="button" className="praise-staff-card" key={staff.id} onClick={() => setHistoryStaff(staff)}>
                <span className="praise-staff-avatar">{staff.name.slice(0, 1)}</span>
                <span className="praise-staff-name"><strong>{staff.name}</strong><small>{staff.active ? "服务荣誉档案" : "历史管家 · 档案保留"}</small></span>
                <span className="praise-staff-count"><b>{staff.count}</b><small>本月好评</small></span><ChevronRight size={16} />
              </button>
            ))}</div> : <div className="praise-empty"><p>暂无可录入好评的在岗管家，请经理在系统员工职责中配置管家岗位。</p></div>}
          </section>
          <section className="praise-wall-section" aria-label="客人好评凭证墙">
            <div className="praise-section-title"><div><span className="praise-eyebrow">客人的声音 · 服务的见证</span><h3><Images size={20} />客人好评凭证墙</h3></div><span className="praise-period">累计 {center.data.totalCount} 条有效好评</span></div>
            <div className="praise-filters">
              <label>好评月份<input type="month" aria-label="好评月份" value={currentMonth || ""} max={center.data.month} onChange={(event) => setMonth(event.target.value)} /></label>
              <label>管家<select aria-label="筛选管家" value={staffFilter} onChange={(event) => setStaffFilter(event.target.value)}><option value="">全部管家</option>{staffCards.map((staff) => <option key={staff.id} value={staff.id}>{staff.name}{staff.active ? "" : "（历史）"}</option>)}{staffFilter && !staffCards.some((staff) => staff.id === staffFilter) && <option value={staffFilter}>已选管家（历史档案）</option>}</select></label>
              {center.data.canManage && <label>记录状态<select aria-label="好评记录状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">有效好评</option><option value="voided">已撤销</option><option value="all">全部记录</option></select></label>}
              <button type="button" className="praise-action praise-link" onClick={() => { setMonth(""); setStaffFilter(""); }}>查看全部历史<ArrowRight size={14} /></button>
            </div>
            <PraiseFeed month={currentMonth || undefined} staffId={staffFilter || undefined} status={center.data.canManage ? status : "active"} refresh={refresh} onRecord={setRecordId} />
          </section>
        </>
      )}
      <PraiseEntry open={entryOpen} onClose={() => setEntryOpen(false)} center={center.data} members={data.members} busy={busy} saveError={saveError} onMutate={onMutate} onSaved={() => { setEntryOpen(false); changed(); }} />
      <Dialog open={Boolean(historyStaff)} onClose={() => setHistoryStaff(null)} title={`${historyStaff?.name || "管家"}的服务荣誉`} description="全部历史好评；点击记录可查看内容与原始图片。" width="max-w-4xl">
        {historyStaff && <div className="praise-center praise-history"><PraiseFeed key={historyStaff.id} staffId={historyStaff.id} refresh={refresh} onRecord={setRecordId} /></div>}
      </Dialog>
      {recordId && <PraiseDetail key={recordId} id={recordId} timezone={center.data?.timezone || "Asia/Shanghai"} canManage={Boolean(center.data?.canManage)} busy={busy} saveError={saveError} onMutate={onMutate} onClose={() => setRecordId("")} onStaff={(staff) => { setRecordId(""); setHistoryStaff(staff); }} onChanged={changed} />}
    </section>
  );
}

function MemberLookup({ members, value, onChange, disabled }: { members: Member[]; value: string; onChange: (member: Member | null) => void; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const selected = members.find((member) => member.id === value);
  const matches = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    if (!text) return [];
    return members.filter((member) => [member.name, member.serviceAlias, member.code, member.phone, member.cardNo, member.nativeMember?.memberNo].some((field) => field?.toLocaleLowerCase().includes(text))).slice(0, 8);
  }, [members, query]);
  return <div className="praise-member-lookup">
    {value ? <div className="praise-selected-member"><span>{selected ? `${selected.name} · ${selected.code}` : "已关联会员"}</span><button type="button" disabled={disabled} aria-label="取消关联会员" onClick={() => { onChange(null); setQuery(""); }}><X size={16} /></button></div> : <>
      <Input aria-label="查找关联会员" placeholder="搜姓名、手机号或会员编号（可不选）" value={query} disabled={disabled} onChange={(event) => setQuery(event.target.value)} />
      {query.trim() && <div className="praise-member-results" role="group" aria-label="会员搜索结果">{matches.length ? matches.map((member) => <button type="button" disabled={disabled} key={member.id} onClick={() => { onChange(member); setQuery(""); }}><strong>{member.name}</strong><span>{member.code} · {member.phone}</span></button>) : <p>未找到匹配的管家会员档案，可直接填写客人称呼。</p>}</div>}
    </>}
  </div>;
}

function PraiseEntry({ open, onClose, center, members, busy, saveError, onMutate, onSaved }: {
  open: boolean; onClose: () => void; center: PraiseCenterData | null; members: Member[]; busy: boolean; saveError: string; onMutate: Mutate; onSaved: () => void;
}) {
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const operationKey = useRef(uuid());
  const [staffId, setStaffId] = useState("");
  const [occurredOn, setOccurredOn] = useState("");
  const [source, setSource] = useState("");
  const [guestName, setGuestName] = useState("");
  const [memberId, setMemberId] = useState("");
  const [content, setContent] = useState("");
  const [uploadIds, setUploadIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const working = busy || uploading;
  const date = occurredOn || center?.today || "";
  const eligible = Boolean(center?.staff.some((staff) => staff.id === staffId));
  const upload = async (files: File[]) => {
    if (!files.length || working) return;
    setError("");
    if (files.length > 4) { setError("每次最多上传4张图片，可分批追加，合计最多12张。"); return; }
    if (uploadIds.length + files.length > 12) { setError("一条好评最多附12张图片，请减少本次选择的数量。"); return; }
    setUploading(true);
    try {
      const prepared = await prepareEvidence(files);
      const form = new FormData();
      prepared.forEach((file) => form.append("files", file));
      const response = await conciergeFetch("/api/concierge/uploads", { method: "POST", body: form });
      const result = (await response.json()) as { uploads?: Upload[]; error?: string };
      if (!response.ok || !result.uploads?.length) throw new Error(result.error || "图片上传未完成，请重试");
      setUploadIds((old) => [...new Set([...old, ...result.uploads!.map((image) => image.id)])]);
    } catch (failure) { setError(errorText(failure)); }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = ""; }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (working) return;
    setError("");
    if (!center?.canOperate) { setError("当前账号没有录入好评的权限。"); return; }
    if (!eligible) { setError("请选择一位在岗管家；员工职责变化后请重新选择。"); return; }
    if (!date || date > center.today) { setError("请填写正确的好评日期，不能晚于今天。"); return; }
    if (!source.trim() || !guestName.trim() || !content.trim()) { setError("请填写好评来源、客人称呼和好评内容，不能只填空格。"); return; }
    if (!uploadIds.length) { setError("请至少上传一张客人的原始好评图片作为依据。"); return; }
    setSubmitted(true);
    const saved = await onMutate("savePraise", { staffId, occurredOn: date, source: source.trim(), guestName: guestName.trim(), memberId, content: content.trim(), uploadIds }, operationKey.current);
    if (saved) {
      setStaffId(""); setOccurredOn(""); setSource(""); setGuestName(""); setMemberId(""); setContent(""); setUploadIds([]); setSubmitted(false); operationKey.current = uuid(); onSaved();
    }
  };
  return <Dialog open={open} onClose={onClose} dismissible={!working} title="录入客人好评" description="一条好评对应一次客人认可，可附多张原始图片。按好评日期计入月榜。" width="max-w-2xl" footer={<><Button variant="secondary" disabled={working} onClick={onClose}>关闭（保留本页草稿）</Button><Button form={formId} type="submit" disabled={working || !center?.canOperate}>{busy ? "正在保存…" : "保存好评"}</Button></>}>
    <form id={formId} onSubmit={(event) => void submit(event)} className="praise-form">
      <div className="praise-form-grid">
        <Field label="获好评管家 *" htmlFor={`${formId}-staff`}><Select id={`${formId}-staff`} value={staffId} required disabled={working} onChange={(event) => setStaffId(event.target.value)}><option value="">请选择在岗管家</option>{center?.staff.map((staff) => <option key={staff.id} value={staff.id}>{staff.name}</option>)}{staffId && !eligible && <option value={staffId} disabled>该管家已不可选，请重新选择</option>}</Select></Field>
        <Field label="好评日期 *" htmlFor={`${formId}-date`} hint="按门店日期归入对应月份"><Input id={`${formId}-date`} type="date" value={date} max={center?.today} required disabled={working} onChange={(event) => setOccurredOn(event.target.value)} /></Field>
        <Field label="好评来源 *" htmlFor={`${formId}-source`}><Input id={`${formId}-source`} value={source} maxLength={80} required list={`${formId}-sources`} placeholder="如：大众点评、微信、客人打卡" disabled={working} onChange={(event) => setSource(event.target.value)} /><datalist id={`${formId}-sources`}><option value="大众点评" /><option value="美团" /><option value="微信" /><option value="客人打卡" /><option value="现场留言" /></datalist></Field>
        <Field label="客人称呼 *" htmlFor={`${formId}-guest`} hint="可填写客人的昵称或匿名称呼"><Input id={`${formId}-guest`} value={guestName} maxLength={80} required placeholder="如：王女士、微信昵称、匿名客人" disabled={working} onChange={(event) => setGuestName(event.target.value)} /></Field>
      </div>
      <Field label="关联会员（选填）" hint="仅关联现有管家会员档案，不会新建会员。"><MemberLookup members={members} value={memberId} disabled={working} onChange={(member) => { setMemberId(member?.id || ""); if (member && !guestName.trim()) setGuestName(member.name); }} /></Field>
      <Field label="好评内容 *" htmlFor={`${formId}-content`}><Textarea id={`${formId}-content`} value={content} maxLength={4000} required rows={4} placeholder="记录客人认可的具体服务，原始好评图片附在下方。" disabled={working} onChange={(event) => setContent(event.target.value)} /></Field>
      <div className="praise-upload-block">
        <div className="praise-upload-heading"><strong>原始好评图片 * <small>{uploadIds.length} / 12</small></strong><span>支持拍照或从相册选择</span></div>
        {uploadIds.length > 0 && <div className="praise-upload-grid">{uploadIds.map((id, index) => <div key={id}><img src={pictureUrl(id)} alt={`已上传好评凭证${index + 1}`} /><button type="button" disabled={working} aria-label={`移除第${index + 1}张好评凭证`} onClick={() => setUploadIds((old) => old.filter((item) => item !== id))}><X size={15} /></button><a href={pictureUrl(id)} target="_blank" rel="noreferrer">查看原图</a></div>)}</div>}
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden aria-label="选择好评图片" onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; void upload(files); }} />
        <button type="button" className="praise-upload-button" disabled={working || uploadIds.length >= 12} onClick={() => inputRef.current?.click()}><ImagePlus size={21} /><span>{uploading ? "图片上传中，请稍候…" : "拍照 / 添加好评图片"}</span></button>
        <p className="praise-caption">每次最多4张，可分批追加；支持JPG、PNG、WebP。图片保存后随好评保留，授权账号可查看。</p>
      </div>
      {(error || (submitted && saveError)) && <p className="praise-error" role="alert">{error || saveError}</p>}
      {submitted && !busy && !saveError && !error && <p className="praise-error" role="alert">尚未确认保存成功。请查看工作台的操作结果提示，再用原草稿重试。</p>}
      <p className="praise-caption">关闭时保留本次页面草稿；刷新或离开页面前请完成保存。</p>
    </form>
  </Dialog>;
}

function PraiseDetail({ id, timezone, canManage, busy, saveError, onMutate, onClose, onStaff, onChanged }: {
  id: string; timezone: string; canManage: boolean; busy: boolean; saveError: string; onMutate: Mutate; onClose: () => void; onStaff: (staff: PraiseStaff) => void; onChanged: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const record = usePraiseRead<PraiseRecord>(`/api/concierge/praise/${encodeURIComponent(id)}`, refresh);
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const operationKey = useRef(uuid());
  const formId = useId();
  const info = record.data;
  const timestamp = (value: string) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: timezone, hour12: false }) : "—";
  const submitVoid = async (event: FormEvent) => {
    event.preventDefault();
    if (!info || busy || !reason.trim()) return;
    setAttempted(true);
    const saved = await onMutate("voidPraise", { id: info.id, version: info.version, reason: reason.trim() }, operationKey.current);
    if (saved) { setVoidOpen(false); setReason(""); setAttempted(false); operationKey.current = uuid(); setRefresh((n) => n + 1); onChanged(); }
  };
  return <>
    <Dialog open onClose={onClose} title="好评详情与原始凭证" width="max-w-4xl" footer={<><Button variant="secondary" onClick={() => setRefresh((n) => n + 1)}>刷新记录</Button>{canManage && info?.status === "active" && <Button variant="danger" disabled={busy} onClick={() => setVoidOpen(true)}>撤销这条好评</Button>}</>}>
      <div className="praise-center praise-detail">
        <ReadState loading={record.loading} error={record.error} hasData={Boolean(info)} onRetry={() => setRefresh((n) => n + 1)} />
        {info && <>
          <div className="praise-detail-heading"><span className="praise-detail-icon"><Heart size={23} /></span><div><span className="praise-eyebrow">{info.source} · {dateLabel(info.occurredOn)}</span><h3>{info.guestName}给予{info.staffName}的好评</h3></div><span className={`praise-status ${info.status === "voided" ? "is-voided" : ""}`}>{info.status === "voided" ? "已撤销" : "有效好评"}</span></div>
          <p className="praise-detail-content">{info.content}</p>
          <dl className="praise-detail-meta"><div><dt>获好评管家</dt><dd><button type="button" className="praise-action praise-link" onClick={() => onStaff({ id: info.staffId, name: info.staffName, active: info.staffActive })}>{info.staffName}{info.staffActive ? "" : "（历史管家）"}<ArrowRight size={13} /></button></dd></div><div><dt>关联会员</dt><dd>{info.memberId ? `${info.memberName} · ${info.memberCode}` : "未关联会员"}</dd></div><div><dt>录入人</dt><dd>{info.createdByName}</dd></div><div><dt>录入时间</dt><dd>{timestamp(info.createdAt)}</dd></div></dl>
          {info.status === "voided" && <div className="praise-void-notice"><strong>撤销原因：{info.voidReason}</strong><span>{info.voidedByName} · {timestamp(info.voidedAt)}</span><p>原始内容和图片保留，本条不计入有效好评与月榜。</p></div>}
          <div className="concierge-workspace praise-evidence"><EvidenceImages key={info.id} ids={info.uploadIds} title="客人原始好评凭证" /></div>
        </>}
      </div>
    </Dialog>
    <Dialog open={voidOpen} onClose={() => setVoidOpen(false)} dismissible={!busy} title="撤销好评" description="撤销后保留原始内容、图片和经办记录，不再计入有效好评与月榜。" footer={<><Button variant="secondary" disabled={busy} onClick={() => setVoidOpen(false)}>取消</Button><Button variant="danger" type="submit" form={formId} disabled={busy || info?.status !== "active"}>{busy ? "正在撤销…" : "确认撤销"}</Button></>}>
      <form id={formId} onSubmit={(event) => void submitVoid(event)} className="praise-form"><Field label="撤销原因 *" htmlFor={`${formId}-reason`}><Textarea id={`${formId}-reason`} value={reason} required maxLength={1000} disabled={busy} placeholder="说明误录、重复录入或其他撤销依据" onChange={(event) => setReason(event.target.value)} /></Field>{attempted && saveError && <p className="praise-error" role="alert">{saveError}</p>}{info?.status === "voided" && <p className="praise-void-notice">这条好评已撤销，可关闭窗口查看完整记录。</p>}</form>
    </Dialog>
  </>;
}
