import { useEffect } from "react";
import type { CustomerSettlementPage } from "@shared/customer";
import { Card, Notice, SectionTitle } from "../../components/ui";
import { CHECKOUT_METHOD_LABELS } from "@shared/checkout";
import { customerUrl, useCustomerRead } from "./api";
import { ListFilters } from "./Lists";
import type { ListProps } from "./Lists";
import { Amount, Empty, localTime, PageControls, ReadStatus } from "./ui";
export const paymentLabel = (method: string) => (CHECKOUT_METHOD_LABELS as Record<string, string>)[method] || method;
export function SettlementList(props: ListProps) {
  const f = props.filters;
  const capabilities = props.meta.capabilities;
  const allowed = capabilities.financialReadToday && (props.day === props.meta.businessDate || capabilities.financialReadHistory);
  const read = useCustomerRead<CustomerSettlementPage>(allowed ? customerUrl("settlements", { day: props.day, q: f.query, hour: f.hour, offset: f.offset }) : null, props.revision);
  const d = read.data;
  useEffect(() => { if (d && f.offset > 0 && f.offset >= d.filteredTotal) props.onFilters({ ...f, offset: Math.floor(Math.max(0, d.filteredTotal - 1) / d.limit) * d.limit }); }, [d?.filteredTotal, d?.limit, f.offset]);
  if (!allowed) return <Notice tone="info" title="消费原单按账号权限查看">{capabilities.financialReadToday ? "当前账号仅可查看本营业日的消费原单，请切换到当前营业日。" : "这个账号没有查看流水的权限，看不了消费原单。"}全店经营汇总、手牌跟进及会员服务摘要仍可查看。</Notice>;
  return <div className="customer-stack"><Notice tone="info" title="消费原单查看范围">{capabilities.financialScope === "self" ? "仅列本人经办且已获授权的消费原单；下列合计不代表全店消费。" : "下列为账号获授权的消费原单及其合计。"}{!capabilities.financialReadHistory && "仅限本营业日原单，历史原单的当日退款或冲回不列入本页。"}经营总览是全店合计，这里的明细范围可能不一样。</Notice><ListFilters {...props} searchLabel="搜索结账单 / 扣卡单 / 会员" /><ReadStatus {...read} hasData={Boolean(d)} onRetry={props.onRefresh} />{d && <>
    <div className="customer-metrics"><div className="customer-metric"><span>原单应收</span><strong><Amount value={d.totals.amountCents} /></strong></div><div className="customer-metric"><span>优惠及抵扣</span><strong><Amount value={d.totals.discountedCents} /></strong></div><div className="customer-metric"><span>退款 / 冲回</span><strong><Amount value={d.totals.refundedCents} /></strong></div><div className="customer-metric"><span>净已结消费</span><strong><Amount value={d.totals.netCents} /></strong><small>含独立扣卡，关联结账扣卡不重计</small></div></div>
    <Card className="customer-section"><SectionTitle>消费原单 · 结账与独立扣卡</SectionTitle><p className="customer-caption">整单结账与其会员钱包扣费只计一次；会员工作台独立扣卡单另列，不伪造手牌、人数或前台结账单。</p>{!d.rows.length ? <Empty /> : <div className="customer-table-scroll"><table className="customer-table"><thead><tr><th>消费原单 / 来源</th><th>所付手牌 / 客人</th><th>原单 / 退款</th><th>净消费</th><th>支付方式 / 经办</th></tr></thead><tbody>{d.rows.map((row) => <tr key={`${row.sourceKind}:${row.id}`}><td><button type="button" className="customer-text-button" onClick={() => props.onRecord(row.sourceKind === "consumption" ? "consumption" : "settlement", row.id)}>{row.docNo}</button><small>{row.sourceKind === "consumption" ? "会员工作台扣卡" : "前台结账整单"} · {row.status === "completed" ? "已完成" : "已撤销"}</small><small>{localTime(row.occurredAt, d.timezone)}</small></td><td>{row.tagCodes.length ? row.tagCodes.join("、") : "无手牌关联"}<small>{row.guestNames.join("、") || "客人称呼未登记"}</small></td><td><Amount value={row.amountCents} /><small>退款/冲回 <Amount value={row.refundedCents} /></small></td><td><Amount value={row.netCents} /></td><td>{row.methods.map(paymentLabel).join("、")}<small>经办：{row.operator.name}</small></td></tr>)}</tbody></table></div>}<PageControls {...d} total={d.filteredTotal} onOffset={(offset) => props.onFilters({ ...f, offset })} /></Card>
  </>}</div>;
}
