import { useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { ChartNoAxesCombined, HandCoins, LayoutDashboard, RefreshCw, Target, UsersRound, Wallet } from "lucide-react";
import type { CustomerMeta, CustomerOverview, CustomerStaff } from "@shared/customer";
import { PageHeader } from "../../components/AppShell";
import { DateNav } from "../../components/DateNav";
import { ErpPendingPanel } from "../../components/ErpPendingPanel";
import { Button, Notice, Segmented } from "../../components/ui";
import { useBusinessToday } from "../../lib/revenue";
import { useCan } from "../../lib/session";
import { uuid } from "../../lib/utils";
import { customerUrl, useCustomerRead } from "./api";
import { CustomerDetailDialog } from "./Details";
import type { DetailEntry } from "./Details";
import { CustomerFormDialog, CUSTOMER_OP_TYPES } from "./Forms";
import { MemberList, RechargeList, VisitList } from "./Lists";
import { BindingQueue } from "./Bindings";
import { Overview } from "./Overview";
import { SettlementList } from "./Settlements";
import { Targets } from "./Targets";
import { LowBalances } from "./LowBalances";
import { ReadStatus } from "./ui";
import { emptyFilters } from "./types";
import type { CustomerForm, CustomerTab, Filters, RecordKind } from "./types";
import "./customer.css";
const TABS = [
  { id: "overview", title: "经营总览", icon: LayoutDashboard },
  { id: "visits", title: "手牌跟进", icon: HandCoins },
  { id: "daily", title: "当日经营", icon: ChartNoAxesCombined },
  { id: "targets", title: "部门目标", icon: Target },
  { id: "lowBalances", title: "低余额关注", icon: Wallet },
  { id: "members", title: "会员绑定", icon: UsersRound },
] as const;
export function CustomerPage() {
  const can = useCan();
  return can("customer.read") ? <CustomerWorkspace /> : <Navigate to="/" replace />;
}
function CustomerWorkspace() {
  const today = useBusinessToday();
  const [params, setParams] = useSearchParams();
  const tab: CustomerTab = TABS.some((item) => item.id === params.get("tab")) ? params.get("tab") as CustomerTab : "overview";
  const day = params.get("day") || today;
  const [revision, setRevision] = useState(0);
  const [dailyMode, setDailyMode] = useState<"recharge" | "settlement">("recharge");
  const [memberMode, setMemberMode] = useState<"members" | "bindings">("members");
  const [filters, setFilters] = useState<Record<CustomerTab, Filters>>({ overview: { ...emptyFilters }, visits: { ...emptyFilters }, daily: { ...emptyFilters }, targets: { ...emptyFilters }, members: { ...emptyFilters }, lowBalances: { ...emptyFilters } });
  const overview = useCustomerRead<CustomerOverview>(customerUrl("overview", { day }), revision);
  const [records, setRecords] = useState<DetailEntry[]>([]);
  const [form, setForm] = useState<{ key: string; value: CustomerForm; meta: CustomerMeta; managers: CustomerStaff[] } | null>(null);
  const refresh = () => setRevision((value) => value + 1);
  const selectTab = (next: CustomerTab) => { const nextParams = new URLSearchParams(params); nextParams.set("tab", next); setParams(nextParams); };
  const selectDay = (value: string, nextTab?: CustomerTab) => {
    const next = new URLSearchParams(params); next.set("day", value); if (nextTab) next.set("tab", nextTab); setParams(next);
    setFilters((old) => Object.fromEntries(Object.entries(old).map(([key, filter]) => [key, { ...filter, offset: 0 }])) as Record<CustomerTab, Filters>);
  };
  const openRecord = (kind: RecordKind, id: number) => setRecords((old) => old.at(-1)?.kind === kind && old.at(-1)?.id === id ? old : [...old, { kind, id, key: uuid() }]);
  const openForm = (value: CustomerForm) => {
    const data = overview.data;
    if (!data) return;
    const managerAction = value.kind === "target" || value.kind === "bindingReview" || value.kind === "creditReview";
    if (managerAction ? !data.capabilities.manage : !data.capabilities.operate) return;
    setForm({ key: uuid(), value, meta: data, managers: data.managers.map((row) => row.manager) });
  };
  const onDrilldown = (next: CustomerTab, hour?: number, kind?: RecordKind) => {
    if (next === "daily") setDailyMode(kind === "settlement" || kind === "consumption" ? "settlement" : "recharge");
    setFilters((old) => ({ ...old, [next]: { ...emptyFilters, hour: hour == null ? "" : String(hour) } }));
    selectTab(next);
  };
  const data = overview.data;
  const listProps = data ? { day, filters: filters[tab], onFilters: (value: Filters) => setFilters((old) => ({ ...old, [tab]: value })), managers: data.managers.map((row) => row.manager), meta: data, revision, onRecord: openRecord, onForm: openForm, onRefresh: refresh } : null;
  return <div className="customer-page" data-testid="customer-workbench">
    <PageHeader title="客户部经营工作台" subtitle="前台业务实时同步，服务与成交责任分别记录。" actions={<Button variant="secondary" size="sm" onClick={refresh}><RefreshCw size={14} />刷新</Button>} />
    <nav className="customer-tabs" aria-label="客户部模块">{TABS.map((item) => <button type="button" key={item.id} aria-current={tab === item.id ? "page" : undefined} onClick={() => selectTab(item.id)} data-testid={`customer-tab-${item.id}`}><item.icon size={17} />{item.title}</button>)}</nav>
    <main className="customer-content">
      <div className="customer-section-head"><DateNav value={day} today={today} onChange={(value) => selectDay(value)} /><p className="customer-caption">{data?.capabilities.scope === "self" ? "共享经营总量 · 个人充值与目标仅本人" : "部门经营与原生业务记录"}</p></div>
      <ErpPendingPanel types={CUSTOMER_OP_TYPES} onFound={refresh} />
      <ReadStatus {...overview} hasData={Boolean(data)} onRetry={refresh} />
      {data && tab === "overview" && <Overview data={data} onNavigate={onDrilldown} />}
      {listProps && tab === "visits" && <VisitList {...listProps} />}
      {listProps && tab === "daily" && <div className="customer-stack"><Notice tone="info" title="数据来自前台原单">到账实收、客户部已核业绩及待归属分别展示。尚待核定或退款冲减会形成差额，不表示同步失败。客户部不能在此修改原金额、办理收款或退款。</Notice><Segmented ariaLabel="当日经营明细类别" value={dailyMode} onChange={(mode) => { setDailyMode(mode); setFilters((old) => ({ ...old, daily: { ...old.daily, status: "", offset: 0 } })); }} options={[{ value: "recharge", label: "充值原单与归属" }, { value: "settlement", label: "整单消费与独立扣卡" }]} />{dailyMode === "recharge" ? <RechargeList {...listProps} /> : <SettlementList {...listProps} />}</div>}
      {data && tab === "targets" && <Targets day={day} revision={revision} onRefresh={refresh} onForm={openForm} onRecord={openRecord} />}
      {listProps && tab === "lowBalances" && <LowBalances {...listProps} />}
      {listProps && tab === "members" && <div className="customer-stack">{data?.capabilities.manage && <Segmented ariaLabel="会员绑定工作区" value={memberMode} onChange={setMemberMode} options={[{ value: "members", label: "会员名单" }, { value: "bindings", label: "绑定审核" }]} />}{data?.capabilities.manage && memberMode === "bindings" ? <BindingQueue revision={revision} onRefresh={refresh} onRecord={openRecord} onForm={openForm} /> : <MemberList {...listProps} />}</div>}
      <p className="customer-caption">会员钱包与消费读取原生系统，服务与成交归属各自留痕；赠金不计实收业绩，不自动计算提成。</p>
    </main>
    {records.map((entry, index) => <CustomerDetailDialog key={entry.key} entry={entry} open={index === records.length - 1} hasBack={index > 0} revision={revision} onClose={() => setRecords((old) => old.slice(0, -1))} onRecord={openRecord} onForm={openForm} onRefresh={refresh} />)}
    {form && <CustomerFormDialog key={form.key} form={form.value} meta={form.meta} managers={form.managers} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />}
  </div>;
}
