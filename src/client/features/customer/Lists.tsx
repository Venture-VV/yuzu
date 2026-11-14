import { useEffect } from "react";
import type { CustomerMeta, CustomerPage, CustomerMember, CustomerRechargePage, CustomerStaff, CustomerVisitPage } from "@shared/customer";
import { ArrowRight } from "lucide-react";
import { Badge, Button, Card, Input, SectionTitle, Select } from "../../components/ui";
import { customerUrl, useCustomerRead } from "./api";
import { Amount, Empty, localTime, PageControls, ReadStatus } from "./ui";
import { creditStatus, kindLabel, staffName } from "./types";
import type { Filters, OpenForm, OpenRecord } from "./types";
export type ListProps = { day: string; filters: Filters; onFilters: (filters: Filters) => void; managers: CustomerStaff[]; meta: CustomerMeta; revision: number; onRecord: OpenRecord; onForm: OpenForm; onRefresh: () => void };
export function ListFilters({ filters, onFilters, managers, managerVisible, statusOptions = [], searchLabel = "查找记录" }: { filters: Filters; onFilters: (filters: Filters) => void; managers: CustomerStaff[]; managerVisible?: boolean; statusOptions?: Array<[string, string]>; searchLabel?: string }) {
  const patch = (value: Partial<Filters>) => onFilters({ ...filters, ...value, offset: 0 });
  return <div className="customer-filters">
    <label className="customer-search">{searchLabel}<Input aria-label={searchLabel} placeholder="姓名、手机号、会员号或单号" maxLength={60} value={filters.query} onChange={(event) => patch({ query: event.target.value })} /></label>
    {managerVisible && <label>客户经理<Select aria-label="客户经理筛选" value={filters.managerId} onChange={(event) => patch({ managerId: event.target.value })}><option value="">全部客户经理</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</Select></label>}
    {statusOptions.length > 0 && <label>记录状态<Select aria-label="客户部记录状态" value={filters.status} onChange={(event) => patch({ status: event.target.value })}>{statusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>}
    {filters.hour !== "" && <button type="button" className="customer-filter-chip" onClick={() => patch({ hour: "" })}>{filters.hour.padStart(2, "0")}:00时段 · 清除 ×</button>}
  </div>;
}
export function useCorrectPage(data: CustomerPage<unknown> | null, props: ListProps) {
  useEffect(() => {
    if (data && props.filters.offset > 0 && props.filters.offset >= data.filteredTotal) props.onFilters({ ...props.filters, offset: Math.floor(Math.max(0, data.filteredTotal - 1) / data.limit) * data.limit });
  }, [data?.filteredTotal, data?.limit, props.filters.offset]);
}
export function RechargeList(props: ListProps) {
  const f = props.filters;
  const read = useCustomerRead<CustomerRechargePage>(customerUrl("recharges", { day: props.day, q: f.query, managerId: props.meta.capabilities.manage ? f.managerId : undefined, status: f.status || "all", hour: f.hour, offset: f.offset }), props.revision);
  useCorrectPage(read.data, props);
  const d = read.data;
  return <div className="customer-stack">
    <ListFilters {...props} managerVisible={props.meta.capabilities.manage} searchLabel="搜索充值原单" statusOptions={[["", "全部归属状态"], ...(props.meta.capabilities.manage ? [["unclaimed", "未申报归属"] as [string, string]] : []), ["pending", "归属待核"], ["verified", "已核定"], ["rejected", "已驳回"], ["voided", "已撤销"]]} />
    <ReadStatus {...read} hasData={Boolean(d)} onRetry={props.onRefresh} />
    {d && <>
      <div className="customer-metrics"><div className="customer-metric"><span>充值实收</span><strong><Amount value={d.totals.paidCents} /></strong><small>赠额 <Amount value={d.totals.bonusCents} /></small></div><div className="customer-metric"><span>退储值</span><strong><Amount value={d.totals.refundedCents} /></strong><small>净实收 <Amount value={d.totals.netPaidCents} /></small></div><div className="customer-metric"><span>客户部已核业绩</span><strong><Amount value={d.totals.verifiedCreditCents} /></strong><small>仅已核且归客户部的原生本金</small></div>{d.capabilities.manage && <div className="customer-metric"><span>归属待核实收</span><strong><Amount value={d.totals.pendingPaidCents} /></strong><small>待核不表示没有到账</small></div>}</div>
      <Card className="customer-section"><SectionTitle>充值原单与客户部归属</SectionTitle>{!d.rows.length ? <Empty /> : <div className="customer-table-scroll"><table className="customer-table"><thead><tr><th>原充值单 / 会员</th><th>实收 / 赠额</th><th>当次成交 / 当前维护</th><th>首续 / 归属</th><th>收银经办</th><th>操作</th></tr></thead><tbody>{d.rows.map((row) => <tr key={row.id}><td><button type="button" className="customer-text-button" onClick={() => props.onRecord("recharge", row.id)}>{row.docNo}</button><small><button type="button" className="customer-text-button" onClick={() => props.onRecord("member", row.member.id)}>{row.member.name} · {row.member.memberNo}</button></small><small>{localTime(row.occurredAt, d.timezone)}</small></td><td><Amount value={row.paidCents} /><small>赠额 <Amount value={row.bonusCents} /></small>{row.refundedCents > 0 && <small>退回 <Amount value={row.refundedCents} /></small>}</td><td>{staffName(row.credit.verifiedSeller || row.credit.claimedSeller)}<small>当前维护：{staffName(row.maintainer)}</small><small>发生时维护：{staffName(row.credit.ownerAtTrade)}</small></td><td><Badge tone={row.credit.status === "verified" ? "pine" : "yuzu"}>{creditStatus[row.credit.status]}</Badge><small>{kindLabel[row.credit.rechargeKind]}</small></td><td>{row.operator.name}</td><td><Button size="sm" variant="ghost" onClick={() => props.onRecord("recharge", row.id)}>原单详情<ArrowRight size={13} /></Button>{d.capabilities.operate && ["unclaimed", "rejected", "voided"].includes(row.credit.status) && <Button size="sm" variant="secondary" onClick={() => props.onForm({ kind: "credit", recharge: row })}>补充归属</Button>}</td></tr>)}</tbody></table></div>}<PageControls {...d} total={d.filteredTotal} onOffset={(offset) => props.onFilters({ ...f, offset })} /></Card>
    </>}
  </div>;
}
export function VisitList(props: ListProps) {
  const f = props.filters;
  const read = useCustomerRead<CustomerVisitPage>(customerUrl("visits", { day: props.day, q: f.query, status: f.status || "all", amountBand: f.amountBand || "all", hour: f.hour, offset: f.offset }), props.revision);
  useCorrectPage(read.data, props);
  const d = read.data;
  return <div className="customer-stack">
    <div className="customer-section-head customer-visit-filters">
      <ListFilters {...props} searchLabel="搜索手牌 / 在店会员" statusOptions={[["", "全部状态"], ["open", "在店"], ["left", "已离店 / 已撤销"]]} />
      <label className="customer-filter-field">手牌消费区间<Select aria-label="手牌消费区间" value={f.amountBand} onChange={(event) => props.onFilters({ ...f, amountBand: event.target.value, offset: 0 })}>
        <option value="">全部金额</option><option value="lt1k">1,000元以下</option><option value="1k-3k">1,000元至不足3,000元</option><option value="3k-5k">3,000元至不足5,000元</option><option value="5k-10k">5,000元至不足10,000元</option><option value="gte10k">10,000元及以上</option>
      </Select></label>
    </div>
    <ReadStatus {...read} hasData={Boolean(d)} onRetry={props.onRefresh} />
    {d && <>
      <div className="customer-metrics customer-metrics-single"><div className="customer-metric"><span>当前在店手牌</span><strong>{d.totals.inStoreCount}<small> 个</small></strong><small>与前台一致，包含跨日未离店手牌</small></div></div>
      <Card className="customer-section"><SectionTitle>手牌消费与服务跟进</SectionTitle><p className="customer-caption">当前在店包含全部跨日未离店手牌；离店记录按所选营业日。消费项目及入离场状态来自前台，客户部只能查看原单并记录服务跟进。</p>
        {!d.rows.length ? <Empty /> : <div className="customer-table-scroll"><table className="customer-table customer-visit-table"><thead><tr><th>手牌 / 客人</th><th>入场时间</th><th>实时消费</th><th>长期维护人</th><th>在场 / 跟进</th><th>操作</th></tr></thead><tbody>{d.rows.map((row) => <tr key={row.id}>
          <td data-label="手牌 / 客人"><button type="button" className="customer-text-button" onClick={() => props.onRecord("visit", row.id)}>{row.tagCode} · {row.guestLabel}</button><small>{row.visitNo}</small>{row.member && <small><button type="button" className="customer-text-button" onClick={() => props.onRecord("member", row.member!.id)}>{row.member.name} · {row.member.memberNo}</button><span className="customer-member-tier">{row.member.gradeLabel}</span></small>}</td>
          <td data-label="入场时间">{localTime(row.checkedInAt, d.timezone)}</td><td data-label="实时消费"><Amount value={row.amountCents} /><small>{row.lineCount}项前台明细</small></td><td data-label="长期维护人">{staffName(row.maintainer)}</td>
          <td data-label="在场 / 跟进">{row.status === "open" ? "在店" : row.status === "settled" ? "已离店" : "已撤销"}<small>{row.lastServiceAt ? `最近跟进 ${localTime(row.lastServiceAt, d.timezone)}` : "暂无跟进记录"}</small></td>
          <td data-label="操作"><div className="customer-actions"><Button size="sm" variant="ghost" onClick={() => props.onRecord("visit", row.id)}>明细 / 跟进</Button>{d.capabilities.operate && <Button size="sm" variant="secondary" onClick={() => props.onForm({ kind: "note", memberId: row.member?.id, visitId: row.id, noteKind: "reception", label: `手牌${row.tagCode}` })}>记录服务</Button>}</div></td>
        </tr>)}</tbody></table></div>}
        <PageControls {...d} total={d.filteredTotal} onOffset={(offset) => props.onFilters({ ...f, offset })} />
      </Card>
    </>}
  </div>;
}
export function MemberList(props: ListProps) {
  const f = props.filters;
  const read = useCustomerRead<CustomerPage<CustomerMember>>(customerUrl("members", { q: f.query, managerId: f.managerId, unbound: f.status === "unbound" ? "1" : undefined, offset: f.offset }), props.revision);
  useCorrectPage(read.data, props);
  const d = read.data;
  return <div className="customer-stack"><ListFilters {...props} managerVisible searchLabel="搜索会员姓名 / 手机 / 会员号" statusOptions={[["", "全部维护关系"], ["unbound", "尚未绑定维护人"]]} /><ReadStatus {...read} hasData={Boolean(d)} onRetry={props.onRefresh} />{d && <Card className="customer-section"><SectionTitle>会员档案与维护关系</SectionTitle><p className="customer-caption">全店原生会员共享查看，当前维护绑定不改变历史成交归属；余额与档阶读取会员系统。</p>{!d.rows.length ? <Empty /> : <div className="customer-table-scroll"><table className="customer-table"><thead><tr><th>会员</th><th>实时档阶</th><th>系统余额</th><th>长期维护人</th><th>操作</th></tr></thead><tbody>{d.rows.map((row) => <tr key={row.id}><td><button type="button" className="customer-text-button" onClick={() => props.onRecord("member", row.id)}>{row.name}</button><small>{row.memberNo} · {row.phone}</small></td><td>{row.gradeLabel}{row.status !== "active" && <small>已停用</small>}</td><td><Amount value={row.totalCents} /><small>本金 <Amount value={row.principalCents} /> ＋ 赠金 <Amount value={row.bonusCents} /></small></td><td>{staffName(row.binding.maintainer)}<small>{row.binding.updatedAt ? localTime(row.binding.updatedAt, d.timezone) : "未绑定"}</small></td><td><Button size="sm" variant="ghost" onClick={() => props.onRecord("member", row.id)}>查看档案<ArrowRight size={13} /></Button>{d.capabilities.operate && row.status === "active" && <Button size="sm" variant="secondary" onClick={() => props.onForm({ kind: "binding", member: row })}>申请绑定</Button>}</td></tr>)}</tbody></table></div>}<PageControls {...d} total={d.filteredTotal} onOffset={(offset) => props.onFilters({ ...f, offset })} /></Card>}</div>;
}
