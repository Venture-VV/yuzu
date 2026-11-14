import { useState } from "react";
import type { CustomerOverview } from "@shared/customer";
import { Card, Notice, SectionTitle, Segmented } from "../../components/ui";
import { Amount, Metric } from "./ui";
import type { CustomerTab, RecordKind, VisitScope } from "./types";
export function Overview({ data, onNavigate }: { data: CustomerOverview; onNavigate: (tab: CustomerTab, hour?: number, kind?: RecordKind, visitScope?: VisitScope) => void }) {
  const [chart, setChart] = useState<"recharge" | "consumption" | "visits">("recharge");
  const m = data.metrics;
  const progress = m.targetProgress == null ? "—" : `${(m.targetProgress * 100).toFixed(1)}%`;
  const value = (h: CustomerOverview["hourly"][number]) => chart === "visits" ? h.visitCount : chart === "consumption" ? h.settlementNetCents : h.rechargePaidCents;
  const max = Math.max(1, ...data.hourly.map(value));
  return <div className="customer-stack">
    <div className="customer-metrics">
      <Metric label="今日已结消费" note={`含独立扣卡 · 前台结账${m.settlementCount}笔 · 明细按原单权限`} onClick={() => onNavigate("daily", undefined, "settlement")}><Amount value={m.settlementNetCents} /></Metric>
      <Metric label="今日充值实收" note="充值到账与业绩核定分列" onClick={() => onNavigate("daily", undefined, "recharge")}><Amount value={m.rechargePaidCents} /></Metric>
      <Metric label="当前在店手牌" note="与前台一致 · 含跨日未离店" onClick={() => onNavigate("visits")}>{m.inStoreCount}<small> 个</small></Metric>
      <Metric label="本月目标完成" note={<>已核 <Amount value={m.monthVerifiedCreditCents} /> / 目标 <Amount value={m.monthTargetCents} /></>} onClick={() => onNavigate("targets")}>{progress}</Metric>
    </div>
    <Card className="customer-section">
      <div className="customer-section-head"><SectionTitle>分时经营 · 点击查看原单</SectionTitle><Segmented ariaLabel="分时经营指标" size="sm" value={chart} onChange={setChart} options={[{ value: "recharge", label: "充值实收" }, { value: "consumption", label: "已结消费" }, { value: "visits", label: "入场人数" }]} /></div>
      <div className="customer-chart-scroll"><div className="customer-hourly" role="group" aria-label="每小时时段明细">
        {data.hourly.map((h) => <button type="button" key={h.hour} className="customer-hour" aria-label={`${h.label}，充值${(h.rechargePaidCents / 100).toFixed(2)}元，消费${(h.settlementNetCents / 100).toFixed(2)}元，入场${h.visitCount}人，查看明细`} title={`充值 ${(h.rechargePaidCents / 100).toFixed(2)}元 · 已结消费 ${(h.settlementNetCents / 100).toFixed(2)}元 · 入场 ${h.visitCount}人`} onClick={() => onNavigate(chart === "visits" ? "visits" : "daily", h.hour, chart === "consumption" ? "settlement" : "recharge", chart === "visits" ? "arrivals" : undefined)}>
          <span className="customer-hour-number">{chart === "visits" ? value(h) : (value(h) / 100).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}</span><span className="customer-hour-track"><span style={{ height: `${Math.max(value(h) ? 3 : 1, value(h) / max * 100)}%` }} /></span><small>{h.label}</small>
        </button>)}
      </div></div>
      <p className="customer-caption">按门店营业日及本地小时查看；入场人数按入场营业日追溯，不含已撤销入场；消费按前台结账单与单独扣卡汇总，充值与消费不相加。消费是全店合计，下钻原单按账号权限与经办范围展示。</p>
    </Card>
    <div className="customer-two-columns">
      <Card className="customer-section"><SectionTitle>实收与核定分开看</SectionTitle><div className="customer-mini-facts"><span>本日充值实收 <b><Amount value={m.rechargePaidCents} /></b></span><span>充值赠额 <b><Amount value={m.rechargeBonusCents} /></b></span><span>客户部已核业绩 <b><Amount value={m.verifiedCreditCents} /></b></span><button type="button" onClick={() => onNavigate("daily", undefined, "consumption")}><span>其中会员工作台独立扣卡</span><b><Amount value={m.standaloneWalletNetCents} /></b></button>{data.capabilities.manage && <span>归属待核实收 <b><Amount value={m.pendingPaidCents} /></b></span>}</div><p className="customer-caption">待核表示责任归属尚未确认，已到账充值仍计实收。独立扣卡列入已结消费，结账关联扣卡不重复累计；赠金不计实收业绩，不自动计算提成。</p></Card>
      <Card className="customer-section"><SectionTitle>支付构成 · 按原单追溯</SectionTitle><div className="customer-mini-facts">{data.payments.map((payment) => <button type="button" key={payment.method} onClick={() => onNavigate("daily", undefined, "settlement")}><span>{payment.label}</span><b><Amount value={payment.settlementCents} /></b></button>)}</div><p className="customer-caption">会员卡支付、非会员卡支付属于消费；充值渠道另列，不据支付方式推断客源。</p></Card>
    </div>
    {data.capabilities.manage && m.unmappedRefundCents != null && m.unmappedRefundCents > 0 && <Notice tone="warning" title="有退储值待匹配原充值"><Amount value={m.unmappedRefundCents} /> 尚未匹配到可核验的原充值责任，请先复核，不自动分摊给客户经理。</Notice>}
  </div>;
}
