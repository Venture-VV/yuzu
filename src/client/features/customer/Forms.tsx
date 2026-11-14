import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CustomerMeta, CustomerStaff } from "@shared/customer";
import type { ErpOpType } from "@shared/erp";
import { businessDayStart } from "@shared/business-date";
import { centsToInput, parseYuan } from "@shared/money";
import { Dialog } from "../../components/Overlay";
import { Button, Field, Input, MoneyInput, Notice, Select, Textarea } from "../../components/ui";
import { sendErpOp, useErpRecorded } from "../../lib/erpPending";
import { useSession } from "../../lib/session";
import { uuid } from "../../lib/utils";
import type { CustomerForm } from "./types";
import { Amount, Facts } from "./ui";
export const CUSTOMER_OP_TYPES: readonly ErpOpType[] = ["customer_note", "customer_binding_request", "customer_binding_review", "customer_credit_claim", "customer_credit_review", "customer_target"];
const stamp = (timezone: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).replace(" ", "T");
function eventIso(value: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error("请填写正确的发生时间。");
  return new Date(businessDayStart(value.slice(0, 10), timezone, 0).getTime() + (Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16))) * 60_000).toISOString();
}
function settings(form: CustomerForm): { type: ErpOpType; url: string; title: string } {
  switch (form.kind) {
    case "note": return { type: "customer_note", url: "/api/customer/notes", title: form.noteKind === "maintenance" ? "记录会员维护" : "记录本次服务跟进" };
    case "binding": return { type: "customer_binding_request", url: "/api/customer/bindings/requests", title: "申请维护绑定 / 换绑" };
    case "bindingReview": return { type: "customer_binding_review", url: `/api/customer/bindings/requests/${form.request.id}/review`, title: "审核维护绑定申请" };
    case "credit": return { type: "customer_credit_claim", url: "/api/customer/credits/claim", title: "补充充值成交与归属" };
    case "creditReview": return { type: "customer_credit_review", url: `/api/customer/credits/${form.recharge.credit.id}/review`, title: "核验充值业绩归属" };
    case "target": return { type: "customer_target", url: "/api/customer/targets", title: "维护月度经营目标" };
  }
}
export function CustomerFormDialog({ form, meta, managers, onClose, onSaved }: { form: CustomerForm; meta: CustomerMeta; managers: CustomerStaff[]; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const config = settings(form);
  const requestKey = useRef(uuid());
  const formId = useRef(`customer-form-${uuid()}`);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sending = useRef(false);
  const [managerId, setManagerId] = useState(() => {
    if (form.kind === "credit") return String(form.recharge.credit.claimedSeller?.id || (meta.capabilities.manage ? "" : meta.capabilities.actorId));
    if (form.kind === "binding" && meta.capabilities.manage && !managers.some((manager) => manager.active && manager.id === meta.capabilities.actorId)) return String(managers.find((manager) => manager.active)?.id || "");
    return String(meta.capabilities.actorId);
  });
  const [occurredAt, setOccurredAt] = useState(() => stamp(meta.timezone));
  const [outcome, setOutcome] = useState(""), [content, setContent] = useState(""), [feedback, setFeedback] = useState(""), [nextOn, setNextOn] = useState("");
  const [reason, setReason] = useState(""), [decision, setDecision] = useState("");
  const [firstKind, setFirstKind] = useState(form.kind === "credit" ? form.recharge.credit.rechargeKind : "unknown");
  const [department, setDepartment] = useState(form.kind === "credit" ? form.recharge.credit.ownerDepartment : "unknown");
  const [amount, setAmount] = useState(form.kind === "target" && form.amountCents != null ? centsToInput(form.amountCents) : "");
  const [groupName, setGroupName] = useState(form.kind === "target" ? form.groupName || "" : "");
  const pending = useErpRecorded(CUSTOMER_OP_TYPES);
  const payload = (): Record<string, unknown> => {
    switch (form.kind) {
      case "note": return { memberId: form.memberId, visitId: form.visitId, staffId: Number(managerId), kind: form.noteKind, occurredAt: eventIso(occurredAt, meta.timezone), outcome: outcome.trim(), content: content.trim(), feedback: feedback.trim(), ...(nextOn ? { nextContactOn: nextOn } : {}) };
      case "binding": return { memberId: form.member.id, toStaffId: Number(managerId), expectedVersion: form.member.binding.version, reason: reason.trim() };
      case "bindingReview": return { expectedVersion: form.request.version, decision, reason: reason.trim() };
      case "credit": return { rechargeId: form.recharge.id, sellerId: managerId ? Number(managerId) : null, firstKind, ownerDepartment: department, expectedVersion: form.recharge.credit.version, reason: reason.trim() };
      case "creditReview": return { expectedVersion: form.recharge.credit.version, decision, reason: reason.trim() };
      case "target": {
        const cents = parseYuan(amount);
        if (cents == null) throw Error("请填写非负金额，最多保留两位小数。");
        return { month: form.month, staffId: form.staffId, amountCents: cents, ...(form.staffId != null ? { groupName } : {}), expectedVersion: form.version, reason: reason.trim() };
      }
    }
  };
  const samePending = pending.find((op) => {
    if (op.type !== config.type || op.url !== config.url) return false;
    const body = op.body as Record<string, unknown>;
    if (form.kind === "binding") return body.memberId === form.member.id;
    if (form.kind === "credit") return body.rechargeId === form.recharge.id;
    if (form.kind === "target") return body.month === form.month && body.staffId === form.staffId;
    if (form.kind === "note") return body.memberId === form.memberId && body.visitId === form.visitId && body.kind === form.noteKind;
    return true;
  });
  const locked = busy || Boolean(samePending);
  const isReview = form.kind === "bindingReview" || form.kind === "creditReview";
  const canManage = meta.capabilities.manage;
  const canSubmit = form.kind === "target" || isReview ? canManage : meta.capabilities.operate;
  const eligibleManagers = managers.filter((manager) => manager.active && (canManage || manager.id === meta.capabilities.actorId));
  const snapshot = form.kind === "credit" || form.kind === "creditReview" ? form.recharge : null;
  const canVerify = snapshot && snapshot.credit.rechargeKind !== "unknown" && snapshot.credit.ownerDepartment !== "unknown" && (snapshot.credit.ownerDepartment !== "customer" || snapshot.credit.claimedSeller != null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending.current || samePending || !canSubmit) return;
    setError("");
    try {
      const body = payload();
      if (form.kind === "note" && (!outcome.trim() || !content.trim())) throw Error("请填写实际结果与记录，不能只填空格。");
      if (form.kind !== "note" && !reason.trim()) throw Error("请填写原因或核验依据。");
      sending.current = true; setBusy(true);
      const objectLabel = form.kind === "note" ? form.label : form.kind === "target" ? `${form.month} ${form.label}` : form.kind === "credit" || form.kind === "creditReview" ? form.recharge.docNo : form.kind === "binding" ? form.member.name : `申请${form.request.id}`;
      await sendErpOp({ key: requestKey.current, type: config.type, url: config.url, body: { ...body, requestKey: requestKey.current }, summary: `${config.title} · ${objectLabel}`, staffName: session.staff.displayName });
      onSaved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败，请重试。"); }
    finally { sending.current = false; setBusy(false); }
  };
  const targetChanged = form.kind === "target" && (amount !== (form.amountCents == null ? "" : centsToInput(form.amountCents)) || groupName !== (form.groupName || ""));
  const close = () => { if (!busy && (locked || (!content && !reason && !outcome && !targetChanged) || window.confirm("还有未保存的内容，确定关闭吗？"))) onClose(); };
  return <Dialog open onClose={close} dismissible={!busy} title={config.title} description="只补充客户服务与经营责任记录；不新建收款、不修改会员钱包。" width="max-w-2xl" footer={<><Button variant="secondary" disabled={busy} onClick={close}>关闭</Button><Button variant="primary" form={formId.current} type="submit" disabled={locked || !canSubmit}>{busy ? "正在保存…" : "确认保存"}</Button></>}>
    <form id={formId.current} className="customer-form" onSubmit={(event) => void submit(event)}>
      {snapshot && <Facts values={[["原充值单", snapshot.docNo], ["会员", `${snapshot.member.name} · ${snapshot.member.memberNo}`], ["实收本金（只读）", <Amount value={snapshot.paidCents} />], ["收银经办", snapshot.operator.name]]} />}
      {form.kind === "creditReview" && <Facts values={[["申报成交人", form.recharge.credit.claimedSeller?.name || "未明确"], ["首续依据", form.recharge.credit.rechargeKind === "first" ? "首办" : form.recharge.credit.rechargeKind === "renewal" ? "续充" : "待核"], ["拟归属部门", form.recharge.credit.ownerDepartment === "customer" ? "客户部" : form.recharge.credit.ownerDepartment === "frontdesk" ? "前厅" : "待核"], ["申报依据", form.recharge.credit.reason || "未登记"]]} />}
      {form.kind === "binding" && <Notice tone="info">{form.member.name} · 当前维护人：{form.member.binding.maintainer?.name || "未绑定"}。审批通过前原关系不变，历史成交归属保留。</Notice>}
      {form.kind === "bindingReview" && <Facts values={[["会员", `会员 #${form.request.memberId}`], ["原维护人", form.request.from?.name || "未绑定"], ["拟绑定维护人", form.request.manager?.name || "未登记"], ["申请人", form.request.requester.name], ["申请原因", form.request.reason]]} />}
      {form.kind === "target" && <Facts values={[["目标月份", form.month], ["目标范围", form.label], ["当前目标", <Amount value={form.amountCents} />]]} />}
      {(form.kind === "note" || form.kind === "binding" || form.kind === "credit") && <Field label={form.kind === "binding" ? "拟绑定维护人 *" : form.kind === "credit" ? "实际成交人 *" : "实际服务人员 *"} htmlFor={`${formId.current}-staff`} hint={!canManage ? "按当前登录员工登记，不能代记他人。" : undefined}><Select id={`${formId.current}-staff`} value={managerId} required={form.kind !== "credit"} disabled={locked || !canManage} onChange={(event) => setManagerId(event.target.value)}>{form.kind === "credit" && canManage && <option value="">未明确成交人</option>}{!eligibleManagers.some((manager) => String(manager.id) === managerId) && managerId && <option value={managerId}>{Number(managerId) === session.staff.id ? session.staff.displayName : "原记录员工"}</option>}{eligibleManagers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</Select></Field>}
      {form.kind === "note" && <>
        <div className="customer-form-grid"><Field label="发生时间 *" htmlFor={`${formId.current}-at`} hint="按门店当地时间填"><Input id={`${formId.current}-at`} type="datetime-local" required value={occurredAt} max={stamp(meta.timezone)} disabled={locked} onChange={(event) => setOccurredAt(event.target.value)} /></Field><Field label="实际结果 *" htmlFor={`${formId.current}-outcome`}><Input id={`${formId.current}-outcome`} required maxLength={100} placeholder="如：已核对消费、客人暂不办理" value={outcome} disabled={locked} onChange={(event) => setOutcome(event.target.value)} /></Field></div>
        <Field label="服务 / 维护记录 *" htmlFor={`${formId.current}-content`}><Textarea id={`${formId.current}-content`} required maxLength={4000} rows={4} value={content} disabled={locked} onChange={(event) => setContent(event.target.value)} /></Field>
        <Field label="客人反馈（选填）" htmlFor={`${formId.current}-feedback`}><Textarea id={`${formId.current}-feedback`} maxLength={2000} value={feedback} disabled={locked} onChange={(event) => setFeedback(event.target.value)} /></Field>
        <Field label="下次联系日期（选填）" htmlFor={`${formId.current}-next`}><Input id={`${formId.current}-next`} type="date" value={nextOn} min={occurredAt.slice(0, 10)} disabled={locked} onChange={(event) => setNextOn(event.target.value)} /></Field>
      </>}
      {form.kind === "credit" && <div className="customer-form-grid"><Field label="首办 / 续充依据 *" htmlFor={`${formId.current}-first`}><Select id={`${formId.current}-first`} value={firstKind} disabled={locked} onChange={(event) => setFirstKind(event.target.value as typeof firstKind)}><option value="unknown">尚待核验</option><option value="first">首办</option><option value="renewal">续充</option></Select></Field><Field label="拟归属部门 *" htmlFor={`${formId.current}-department`}><Select id={`${formId.current}-department`} value={department} disabled={locked} onChange={(event) => setDepartment(event.target.value as typeof department)}><option value="unknown">尚待核验</option><option value="customer">客户部</option><option value="frontdesk">前厅</option></Select></Field></div>}
      {isReview && <Field label="审核结论 *" htmlFor={`${formId.current}-decision`}><Select id={`${formId.current}-decision`} required value={decision} disabled={locked} onChange={(event) => setDecision(event.target.value)}><option value="">请选择结论</option>{form.kind === "bindingReview" ? <><option value="approve">通过申请</option><option value="reject">驳回申请</option></> : <>{form.recharge.credit.status === "pending" && <><option value="verify" disabled={!canVerify}>核定归属</option><option value="reject">驳回补充</option></>}{form.recharge.credit.status === "verified" && <option value="void">撤销已核归属</option>}</>}</Select>{form.kind === "creditReview" && !canVerify && <p className="customer-caption">首续、部门或客户部成交人尚不明确。请先驳回，补报依据完整后再核定。</p>}</Field>}
      {form.kind === "target" && <Field label="月目标（元）*" htmlFor={`${formId.current}-amount`} hint="0元表示本期目标为0；无配置与0元分别展示。"><MoneyInput id={`${formId.current}-amount`} value={amount} required disabled={locked} onChange={(event) => setAmount(event.target.value)} /></Field>}
      {form.kind === "target" && form.staffId != null && <Field label="本月组别" htmlFor={`${formId.current}-group`} hint="组别与个人目标一并按版本保存，空白保留待分组。"><Select id={`${formId.current}-group`} value={groupName} disabled={locked} onChange={(event) => setGroupName(event.target.value)}><option value="">待分组</option><option value="A组">A组</option><option value="B组">B组</option></Select></Field>}
      {form.kind !== "note" && <Field label={isReview ? "审核原因 / 依据 *" : "原因 / 依据 *"} htmlFor={`${formId.current}-reason`}><Textarea id={`${formId.current}-reason`} value={reason} required rows={4} maxLength={1000} disabled={locked} onChange={(event) => setReason(event.target.value)} placeholder="填写真实依据，未知信息保留待核，不推断或补造。" /></Field>}
      {error && <Notice tone="error" title={error} />}
      {samePending && <Notice tone="warning" title="上次操作结果待确认">此对象已有提交记录。请关闭窗口，通过页面“结果待确认”查回、按原内容重提或确认作废后再填写。</Notice>}
    </form>
  </Dialog>;
}
