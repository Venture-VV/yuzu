import { useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { ChartNoAxesCombined, HandCoins, LayoutDashboard, RefreshCw, Target, UsersRound, Wallet } from "lucide-react";
import type { CustomerMeta, CustomerOverview, CustomerStaff } from "@shared/customer";
import { PageHeader } from "../../components/AppShell";
import { DateNav } from "../../components/DateNav";
import { ErpPendingPanel } from "../../components/ErpPendingPanel";
import { SubNav, type SubTab } from "../../components/SubNav";
import { Button, Notice } from "../../components/ui";
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
import type { CustomerForm, CustomerTab, Filters, RecordKind, VisitScope } from "./types";
import "./customer.css";
const TABS = [
  { id: "overview", title: "经营总览", icon: LayoutDashboard },
  { id: "visits", title: "手牌跟进", icon: HandCoins },
  { id: "daily", title: "当日经营", icon: ChartNoAxesCombined },
  { id: "targets", title: "部门目标", icon: Target },
  { id: "lowBalances", title: "低余额关注", icon: Wallet },
  { id: "members", title: "会员绑定", icon: UsersRound },
] as const;
type FilterTab = CustomerTab | "settlements";
export function CustomerPage() {
  const can = useCan();
  return can("customer.read") ? <CustomerWorkspace /> : <Navigate to="/" replace />;
}
function CustomerWorkspace() {
  const today = useBusinessToday();
  const [params, setParams] = useSearchParams();
  const tab: CustomerTab = TABS.some((item) => item.id === params.get("tab")) ? params.get("tab") as CustomerTab : "overview";
  const day = params.get("day") || today;
  // Keep the original ?tab links. SubNav supports explicit addresses, including these query links.
  const dailyMode = params.get("daily") === "settlement" ? "settlement" : "recharge";
  const memberMode = params.get("member") === "bindings" ? "bindings" : "members";
  const visitScope: VisitScope = params.get("visitScope") === "arrivals" ? "arrivals" : "workbench";
  const visitHour = /^(?:[0-9]|1[0-9]|2[0-3])$/.test(params.get("hour") || "") ? params.get("hour")! : "";
  const [revision, setRevision] = useState(0);
  // A recharge status/page must never be carried into the settlement read model (or vice versa).
  const [filters, setFilters] = useState<Record<FilterTab, Filters>>({ overview: { ...emptyFilters }, visits: { ...emptyFilters }, daily: { ...emptyFilters }, settlements: { ...emptyFilters }, targets: { ...emptyFilters }, members: { ...emptyFilters }, lowBalances: { ...emptyFilters } });
  const overview = useCustomerRead<CustomerOverview>(customerUrl("overview", { day }), revision);
  const [records, setRecords] = useState<DetailEntry[]>([]);
  const [form, setForm] = useState<{ key: string; value: CustomerForm; meta: CustomerMeta; managers: CustomerStaff[] } | null>(null);
  const refresh = () => setRevision((value) => value + 1);
  const tabAddress = (next: CustomerTab, extra: Record<string, string> = {}) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set("tab", next);
    // The main hand-tag entry always opens normal cross-day service follow-up.
    if (next === "visits") { nextParams.delete("visitScope"); nextParams.delete("hour"); }
    for (const [key, value] of Object.entries(extra)) nextParams.set(key, value);
    return `/customer?${nextParams}`;
  };
  const tabs: SubTab[] = TABS.map((item) => ({ key: item.id, label: <><item.icon size={17} />{item.title}</>, to: tabAddress(item.id), testId: `customer-tab-${item.id}` }));
  const dailyTabs: SubTab[] = [
    { key: "recharge", label: "充值原单与归属", to: tabAddress("daily", { daily: "recharge" }) },
    { key: "settlement", label: "整单消费与独立扣卡", to: tabAddress("daily", { daily: "settlement" }) },
  ];
  const memberTabs: SubTab[] = [
    { key: "members", label: "会员名单", to: tabAddress("members", { member: "members" }) },
    { key: "bindings", label: "绑定审核", to: tabAddress("members", { member: "bindings" }) },
  ];
  const selectDay = (value: string, nextTab?: CustomerTab) => {
    const next = new URLSearchParams(params); next.set("day", value); if (nextTab) next.set("tab", nextTab); setParams(next);
    setFilters((old) => Object.fromEntries(Object.entries(old).map(([key, filter]) => [key, { ...filter, offset: 0 }])) as Record<FilterTab, Filters>);
  };
  const openRecord = (kind: RecordKind, id: number) => setRecords((old) => old.at(-1)?.kind === kind && old.at(-1)?.id === id ? old : [...old, { kind, id, key: uuid() }]);
  const openForm = (value: CustomerForm) => {
    const data = overview.data;
    if (!data) return;
    const managerAction = value.kind === "target" || value.kind === "bindingReview" || value.kind === "creditReview";
    if (managerAction ? !data.capabilities.manage : !data.capabilities.operate) return;
    setForm({ key: uuid(), value, meta: data, managers: data.managers.map((row) => row.manager) });
  };
  const onDrilldown = (next: CustomerTab, hour?: number, kind?: RecordKind, scope: VisitScope = "workbench") => {
    const mode = kind === "settlement" || kind === "consumption" ? "settlement" : "recharge";
    const filterTab = next === "daily" && mode === "settlement" ? "settlements" : next;
    setFilters((old) => ({ ...old, [filterTab]: { ...emptyFilters, hour: hour == null ? "" : String(hour) } }));
    const nextParams = new URLSearchParams(params);
    nextParams.set("tab", next);
    if (next === "daily") nextParams.set("daily", mode);
    if (next === "visits") {
      nextParams.delete("visitScope"); nextParams.delete("hour");
      if (scope === "arrivals") {
        nextParams.set("visitScope", "arrivals"); nextParams.set("day", day);
        if (hour != null) nextParams.set("hour", String(hour));
      }
    }
    setParams(nextParams);
  };
  const data = overview.data;
  const filterTab = tab === "daily" && dailyMode === "settlement" ? "settlements" : tab;
  const activeFilters = tab === "visits" ? { ...filters.visits, visitScope, hour: visitScope === "arrivals" ? visitHour : "" } : filters[filterTab];
  const onFilters = (value: Filters) => {
    setFilters((old) => ({ ...old, [filterTab]: value }));
    if (tab === "visits" && (value.visitScope !== visitScope || value.hour !== activeFilters.hour)) {
      const next = new URLSearchParams(params);
      next.delete("visitScope"); next.delete("hour");
      if (value.visitScope === "arrivals") {
        next.set("visitScope", "arrivals");
        if (value.hour !== "") next.set("hour", value.hour);
      }
      setParams(next);
    }
  };
  const listProps = data ? { day, filters: activeFilters, onFilters, managers: data.managers.map((row) => row.manager), meta: data, revision, onRecord: openRecord, onForm: openForm, onRefresh: refresh } : null;
  return <div className="customer-page" data-testid="customer-workbench">
    <PageHeader title="客户部经营工作台" subtitle="前台业务实时同步，服务与成交责任分别记录。" actions={<Button variant="secondary" size="sm" onClick={refresh}><RefreshCw size={14} />刷新</Button>} />
    <div className="customer-tabs"><SubNav tabs={tabs} base="/customer" active={tab} label="客户部模块" /></div>
    <main className="customer-content">
      <div className="customer-section-head"><DateNav value={day} today={today} onChange={(value) => selectDay(value)} /><p className="customer-caption">{data?.capabilities.scope === "self" ? "共享经营总量 · 个人充值与目标仅本人" : "部门经营与原生业务记录"}</p></div>
      <ErpPendingPanel types={CUSTOMER_OP_TYPES} onFound={refresh} />
      <ReadStatus {...overview} hasData={Boolean(data)} onRetry={refresh} />
      {data && tab === "overview" && <Overview data={data} onNavigate={onDrilldown} />}
      {listProps && tab === "visits" && <VisitList {...listProps} />}
      {listProps && tab === "daily" && <div className="customer-stack"><Notice tone="info" title="数据来自前台原单">到账实收、客户部已核业绩及待归属分别展示。尚待核定或退款冲减会形成差额，不表示同步失败。客户部不能在此修改原金额、办理收款或退款。</Notice><SubNav tabs={dailyTabs} base="/customer" active={dailyMode} label="当日经营明细类别" />{dailyMode === "recharge" ? <RechargeList {...listProps} /> : <SettlementList {...listProps} />}</div>}
      {data && tab === "targets" && <Targets day={day} revision={revision} onRefresh={refresh} onForm={openForm} onRecord={openRecord} />}
      {listProps && tab === "lowBalances" && <LowBalances {...listProps} />}
      {listProps && tab === "members" && <div className="customer-stack">{data?.capabilities.manage && <SubNav tabs={memberTabs} base="/customer" active={memberMode} label="会员绑定工作区" />}{data?.capabilities.manage && memberMode === "bindings" ? <BindingQueue revision={revision} onRefresh={refresh} onRecord={openRecord} onForm={openForm} /> : <MemberList {...listProps} />}</div>}
      <p className="customer-caption">会员钱包与消费读取原生系统，服务与成交归属各自留痕；赠金不计实收业绩，不自动计算提成。</p>
    </main>
    {records.map((entry, index) => <CustomerDetailDialog key={entry.key} entry={entry} open={index === records.length - 1} hasBack={index > 0} revision={revision} onClose={() => setRecords((old) => old.slice(0, -1))} onRecord={openRecord} onForm={openForm} onRefresh={refresh} />)}
    {form && <CustomerFormDialog key={form.key} form={form.value} meta={form.meta} managers={form.managers} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />}
  </div>;
}
