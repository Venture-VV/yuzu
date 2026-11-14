import { useState } from "react";
import type { CustomerTargets } from "@shared/customer";
import { Badge, Button, Card, SectionTitle } from "../../components/ui";
import { customerUrl, useCustomerRead } from "./api";
import { Amount, Empty, localTime, Metric, monthName, ReadStatus } from "./ui";
import type { OpenForm, OpenRecord } from "./types";
import { PerformanceDialog } from "./Performance";
import type { PerformanceSelection } from "./Performance";

const wan = (value: number | null) => value == null ? "—" : (value / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const progress = (value: number | null) => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const gradeLabel = (value: string) => ["S", "A", "B"].includes(value) ? `达${value}线` : value;

export function Targets({ day, revision, onRefresh, onForm, onRecord }: { day: string; revision: number; onRefresh: () => void; onForm: OpenForm; onRecord: OpenRecord }) {
  const month = day.slice(0, 7);
  const read = useCustomerRead<CustomerTargets>(customerUrl("targets", { month, day }), revision);
  const [selection, setSelection] = useState<PerformanceSelection | null>(null);
  const d = read.data;
  const open = (period: PerformanceSelection["period"], scope: PerformanceSelection["scope"], subject: string, groupName?: "A组" | "B组", managerId?: number) => setSelection({ day, month, period, scope, subject, groupName, managerId });
  return <div className="customer-stack">
    <ReadStatus {...read} hasData={Boolean(d)} onRetry={onRefresh} />
    {d && <>
      <div className="customer-section-head"><div><SectionTitle>{monthName(d.month)}部门目标</SectionTitle><p className="customer-caption">本月累计截止 {d.asOfDay}；修改顶部营业日可复盘对应日期。</p></div>{d.capabilities.manage && <Button size="sm" onClick={() => onForm({ kind: "target", month: d.month, staffId: null, label: "整个客户部", amountCents: d.departmentTargetCents, version: d.departmentVersion })}>维护部门目标</Button>}</div>
      <div className="customer-metrics customer-target-metrics">
        <Metric label="本月已核 / 部门目标" note={<>完成率 {progress(d.departmentTargetCents != null && d.departmentTargetCents > 0 ? d.departmentVerifiedCreditCents / d.departmentTargetCents : null)} · 金额资格 {gradeLabel(d.departmentAmountGrade)}</>} onClick={() => open("month", "department", "部门")}><Amount value={d.departmentVerifiedCreditCents} /><small> / <Amount value={d.departmentTargetCents} /></small></Metric>
        <Metric label="今日已核业绩" note={d.asOfDay} onClick={() => open("today", "department", "部门")}><Amount value={d.departmentTodayCreditCents} /></Metric>
        {d.groups.map((group) => <Metric key={group.groupName} label={`${group.groupName}业绩`} note={<>本月 <Amount value={group.verifiedCreditCents} /> · 目标 <Amount value={group.targetCents} /><br />达成率 {progress(group.targetCents != null && group.targetCents > 0 ? group.verifiedCreditCents / group.targetCents : null)}</>} onClick={() => open("today", "group", group.groupName, group.groupName)}>今日 <Amount value={group.todayCreditCents} /></Metric>)}
        <Metric label="上月同期已核" note="上月月初至同一日数，包含退款冲减" onClick={() => open("lastMonthSame", "department", "部门")}><Amount value={d.departmentLastMonthSameDayCents} /></Metric>
      </div>
      <p className="customer-caption customer-group-reconciliation">部门业绩＝A组＋B组＋待分组。待分组今日 <Amount value={d.ungroupedTodayCreditCents} />，本月 <Amount value={d.ungroupedVerifiedCreditCents} />；旧分组标签或尚未配置的员工保留在待分组，维护本月个人目标时可分配A/B组。</p>
      <Card className="customer-section">
        <div className="customer-section-head"><SectionTitle>员工已核业绩排名</SectionTitle><span className="customer-caption">按分排序，万元展示保留2位；点击累计查看精确原单</span></div>
        <p className="customer-caption">— 表示尚未配置；0目标不计算完成率。个人目标合计 {wan(d.assignedTargetCents)} 万元，部门未分配 {wan(d.allocationDifferenceCents)} 万元。分组按本月目标配置保存。</p>
        {!d.rows.length ? <Empty>暂无客户经理，请先配置真实员工岗位。</Empty> : <div className="customer-table-scroll"><table className="customer-table customer-ranking-table"><thead><tr><th>名次</th><th>姓名</th><th>组别</th><th>目标（万）</th><th>累计（万）</th><th>金额资格</th><th>完成率</th>{d.capabilities.manage && <th>维护</th>}</tr></thead><tbody>{d.rows.map((row) => <tr key={row.manager.id}>
          <td><span className={`customer-rank ${row.rank <= 3 ? "customer-rank-leading" : ""}`}>{row.rank}</span></td>
          <td><button type="button" className="customer-text-button" onClick={() => open("month", "staff", row.manager.name, undefined, row.manager.id)}>{row.manager.name}</button>{!row.manager.active && <small>已停用</small>}</td>
          <td>{row.groupName || "待分组"}</td><td>{wan(row.targetCents)}</td>
          <td><button type="button" className="customer-text-button" onClick={() => open("month", "staff", row.manager.name, undefined, row.manager.id)}>{wan(row.verifiedCreditCents)}</button></td>
          <td><Badge tone={row.amountGrade === "S" || row.amountGrade === "A" ? "pine" : "neutral"}>{gradeLabel(row.amountGrade)}</Badge><small>综合评分待履职</small></td><td>{progress(row.progress)}</td>
          {d.capabilities.manage && <td><Button variant="ghost" size="sm" onClick={() => onForm({ kind: "target", month: d.month, staffId: row.manager.id, label: row.manager.name, amountCents: row.targetCents, version: row.version, groupName: row.groupName })}>目标 / 分组</Button></td>}
        </tr>)}</tbody></table></div>}
        <details className="customer-rating-rules"><summary>金额资格与考评规则说明</summary><p>{d.ratings.source}</p><p>个人 B / A / S 金额线：{wan(d.ratings.individual.B)} / {wan(d.ratings.individual.A)} / {wan(d.ratings.individual.S)} 万元；部门：{wan(d.ratings.department.B)} / {wan(d.ratings.department.A)} / {wan(d.ratings.department.S)} 万元。</p><p>{d.ratings.scoringNote}</p><p>{d.ratings.awardNote}</p><p>{d.ratings.basisNote}</p><p>{d.ratings.groupNote}</p></details>
      </Card>
      {d.capabilities.manage && <Card className="customer-section"><SectionTitle>目标版本历史</SectionTitle>{!d.history.length ? <Empty>尚未维护过目标。</Empty> : <div className="customer-record-list">{d.history.map((history) => <article key={history.id} className="customer-record"><div className="customer-record-head"><strong>{history.month} · {history.scope === "department" ? "部门" : d.rows.find((row) => row.manager.id === history.managerId)?.manager.name || `个人#${history.managerId}`}</strong><Amount value={history.targetCents} /></div><small>版本{history.version} · {localTime(history.createdAt, d.timezone)}</small></article>)}</div>}</Card>}
    </>}
    {selection && d && <PerformanceDialog key={JSON.stringify(selection)} selection={selection} meta={d} revision={revision} onRefresh={onRefresh} onClose={() => setSelection(null)} onRecord={onRecord} />}
  </div>;
}
