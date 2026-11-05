// 审批规则（v0.7.30，A1、A2、A3）：单据类型 × 金额区间（含下限、不含上限）× 部门 → 一到三级审批链；
// 店主（维护审批规则）新建、修改、停用（不删，带版本号）；改规则只影响之后提交的单据。
// 新建走「结果待确认」（与 ERP 单据一套，Codex 自动审查 2cfd28b）：发出前把操作编号与原请求存在本机，没收到结果时刷新、关掉对话框后
// 也能在页面上方查回、按原内容重新提交（同一编号，不会多建一条）或确认作废；修改、停用带版本号，没收到结果再保存会被拒绝，不会改两次。

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  APPROVAL_DOC_TYPE_LABELS,
  APPROVAL_DOC_TYPES,
  APPROVAL_GROUP_HINTS,
  APPROVAL_GROUP_LABELS,
  APPROVAL_GROUPS,
  APPROVAL_MAX_LEVELS,
  APPROVAL_MAX_STAFF,
  type ApprovalDocType,
  type ApprovalGroup,
  type ApprovalRuleView,
  type ApprovalStep,
} from '@shared/approvals';
import { formatAmount } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn } from '../../lib/utils';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, MoneyInput, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { useDepartments } from '../inventory/queries';
import { useApprovalRules, useApprovers, useRefreshAfterApproval } from './queries';

const yuanText = (cents: number) => `¥${formatAmount(cents)}`;
export const rangeText = (r: Pick<ApprovalRuleView, 'minCents' | 'maxCents'>) =>
  r.maxCents === null ? (r.minCents === 0 ? '任何金额' : `${yuanText(r.minCents)} 起`) : `${yuanText(r.minCents)} 到 ${yuanText(r.maxCents)}（不含）`;

const RULE_PENDING = ['approval_rule'] as const;

export function RulesPanel() {
  const can = useCan();
  const manage = can('approval.rules');
  const rules = useApprovalRules();
  const refresh = useRefreshAfterApproval();
  // 新建的结果待确认时先处理那一笔（查回、重提或作废），免得同一条规则建两条
  const pendingNew = useErpPending(RULE_PENDING).length > 0;
  const toast = useToast();
  const [editing, setEditing] = useState<ApprovalRuleView | 'new' | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const toggle = async (r: ApprovalRuleView) => {
    setBusy(r.id);
    try {
      await api.post(`/api/approvals/rules/${r.id}/active`, { version: r.version, active: !r.active });
      toast({ tone: 'success', title: r.active ? '规则已停用' : '规则已启用' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  return (
    <section className="space-y-3" data-testid="approval-rules">
      <Notice tone="info" title="没有规则命中时按现在的「负责人确认」开关与免确认门槛（默认规则：一级负责人）">
        命中时取最具体的一条：指定了部门的优先，其次金额下限高的，再其次后建的。改规则只影响之后提交的单据，已在审批中的照提交时的审批链走完。店主在每一级都能审。
      </Notice>
      <ErpPendingPanel types={RULE_PENDING} className="space-y-2" onFound={() => void refresh()} />
      {manage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} disabled={pendingNew} data-testid="approval-rule-new">
            新建规则
          </Button>
          {pendingNew && <span className="text-[12.5px] text-ink-3">先处理上面「结果待确认」那一笔</span>}
        </div>
      )}
      {rules.error ? (
        <Notice tone="error" title={errorMessage(rules.error)} />
      ) : !rules.data ? (
        <Skeleton className="h-32" />
      ) : rules.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong bg-card px-4 py-6 text-center text-[13px] text-ink-3">还没有审批规则，全部按默认规则。</p>
      ) : (
        <ul className="space-y-2">
          {rules.data.map((r) => (
            <li key={r.id} className={cn('rounded-lg border border-line bg-card px-4 py-3', !r.active && 'opacity-60')} data-testid={`approval-rule-${r.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="lake">{APPROVAL_DOC_TYPE_LABELS[r.docType]}</Badge>
                <span className="text-[13.5px] font-semibold">{rangeText(r)}</span>
                <span className="text-[12.5px] text-ink-3">{r.departmentName ?? '全部部门'}</span>
                {!r.active && <Badge>已停用</Badge>}
                <span className="num ml-auto text-[12px] text-ink-4">第 {r.version} 版</span>
              </div>
              <p className="mt-1 text-[13.5px]">
                {r.stepLabels.map((l, i) => (
                  <span key={i}>
                    {i > 0 && <span className="mx-1.5 text-ink-4">→</span>}
                    <span className="font-semibold">{l}</span>
                  </span>
                ))}
              </p>
              <p className="mt-0.5 text-[12.5px] text-ink-3">
                {r.allowSelf ? '提交人可以审自己的单' : '提交人不能审自己的单'}
                {r.note && ` · ${r.note}`} · {r.updatedByName ?? r.createdByName} 改
              </p>
              {manage && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(r)} disabled={!r.active}>
                    修改
                  </Button>
                  <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => void toggle(r)}>
                    {r.active ? '停用' : '启用'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <RuleDialog rule={editing === 'new' ? null : editing} open={editing !== null} onClose={() => setEditing(null)} />
    </section>
  );
}

type StepDraft = { kind: 'group'; group: ApprovalGroup } | { kind: 'staff'; staffIds: number[]; mode: 'any' | 'all' };

const toDraft = (s: ApprovalStep): StepDraft => ('group' in s ? { kind: 'group', group: s.group } : { kind: 'staff', staffIds: s.staffIds, mode: s.mode });
const fromDraft = (s: StepDraft): ApprovalStep => (s.kind === 'group' ? { group: s.group, mode: 'any' } : { staffIds: s.staffIds, mode: s.mode });
const yuanInput = (cents: number | null) => (cents === null ? '' : String(cents / 100));
const centsOf = (text: string): number | null => {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
};

function RuleDialog({ rule, open, onClose }: { rule: ApprovalRuleView | null; open: boolean; onClose: () => void }) {
  const departments = useDepartments(false, open);
  const approvers = useApprovers(open);
  const refresh = useRefreshAfterApproval();
  const toast = useToast();
  const session = useSession();
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID());
  const [docType, setDocType] = useState<ApprovalDocType>('purchase_order');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [steps, setSteps] = useState<StepDraft[]>([{ kind: 'group', group: 'manager' }]);
  const [allowSelf, setAllowSelf] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setClientKey(crypto.randomUUID());
    setDocType(rule?.docType ?? 'purchase_order');
    setMin(rule ? yuanInput(rule.minCents) : '');
    setMax(rule ? yuanInput(rule.maxCents) : '');
    setDepartmentId(rule?.departmentId ? String(rule.departmentId) : '');
    setSteps(rule ? rule.steps.map(toDraft) : [{ kind: 'group', group: 'manager' }]);
    setAllowSelf(rule?.allowSelf ?? false);
    setNote(rule?.note ?? '');
    setError(null);
  });
  const update = (i: number, s: StepDraft) => setSteps((all) => all.map((x, j) => (j === i ? s : x)));
  const save = async () => {
    const minCents = centsOf(min) ?? 0;
    const maxCents = centsOf(max);
    if (Number.isNaN(minCents) || Number.isNaN(maxCents)) return setError('金额格式不对');
    if (maxCents !== null && maxCents <= minCents) return setError('金额上限要大于下限（上限不含）');
    if (steps.some((s) => s.kind === 'staff' && s.staffIds.length === 0)) return setError('指定的人至少选一位');
    const body = { docType, minCents, maxCents, departmentId: departmentId ? Number(departmentId) : null, steps: steps.map(fromDraft), allowSelf, note: note.trim() };
    setBusy(true);
    setError(null);
    try {
      if (rule) await api.put(`/api/approvals/rules/${rule.id}`, { ...body, version: rule.version });
      else
        await sendErpOp({
          key: clientKey,
          type: 'approval_rule',
          url: '/api/approvals/rules',
          body: { ...body, clientKey },
          summary: `${APPROVAL_DOC_TYPE_LABELS[docType]} · ${rangeText({ minCents, maxCents })}${note.trim() ? ` · ${note.trim()}` : ''}`,
          staffName: session.staff.displayName,
        });
      toast({ tone: 'success', title: rule ? '规则已修改' : '规则已建好', body: '之后提交的单据按新规则走' });
      await refresh();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError && !rule) {
        // 新建没收到结果：记录留在本机，到页面上方处理
        toast({ tone: 'info', title: '新建审批规则：没收到结果', body: '可能已经建好。记录留在本机，到页面上方查回、按原内容重新提交（不会多建一条）或确认作废' });
        void refresh();
        onClose();
      } else {
        // 修改没收到结果：再保存时版本号对不上会被拒绝（不会改两次），关掉后看列表里的版本核对
        setError(e instanceof UncertainError ? `${e.message}，不确定有没有改上：关掉后看列表里的版本核对，再改` : errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-xl"
      title={rule ? '修改审批规则' : '新建审批规则'}
      description="单据类型 × 金额区间 × 部门 → 一到三级审批链"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()} data-testid="approval-rule-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        {error && <Notice tone="error" title={error} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="单据类型" htmlFor="rule-doc-type">
            <Select id="rule-doc-type" value={docType} onChange={(e) => setDocType(e.target.value as ApprovalDocType)} data-testid="approval-rule-doctype">
              {APPROVAL_DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {APPROVAL_DOC_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="部门" htmlFor="rule-dept" hint="空 = 全部部门">
            <Select id="rule-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">全部部门</option>
              {(departments.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="金额下限（含）" htmlFor="rule-min">
            <MoneyInput id="rule-min" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" data-testid="approval-rule-min" />
          </Field>
          <Field label="金额上限（不含）" htmlFor="rule-max" hint="空 = 不封顶">
            <MoneyInput id="rule-max" value={max} onChange={(e) => setMax(e.target.value)} placeholder="不封顶" />
          </Field>
        </div>
        <div className="space-y-2">
          <p className="text-[13px] font-semibold text-ink-2">审批链（一到 {APPROVAL_MAX_LEVELS} 级）</p>
          {steps.map((s, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-line bg-paper-2/40 px-3 py-2.5" data-testid={`approval-rule-step-${i + 1}`}>
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-bold">第 {i + 1} 级</span>
                <Segmented
                  size="sm"
                  value={s.kind}
                  onChange={(k) => update(i, k === 'group' ? { kind: 'group', group: 'manager' } : { kind: 'staff', staffIds: [], mode: 'any' })}
                  options={[
                    { value: 'group', label: '岗位组' },
                    { value: 'staff', label: '指定的人' },
                  ]}
                />
                {steps.length > 1 && (
                  <button type="button" className="ml-auto text-ink-3 hover:text-clay" aria-label={`删掉第 ${i + 1} 级`} onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
              {s.kind === 'group' ? (
                <Select value={s.group} onChange={(e) => update(i, { kind: 'group', group: e.target.value as ApprovalGroup })} aria-label={`第 ${i + 1} 级的岗位组`}>
                  {APPROVAL_GROUPS.map((g) => (
                    <option key={g} value={g}>
                      {APPROVAL_GROUP_LABELS[g]}（{APPROVAL_GROUP_HINTS[g]}）
                    </option>
                  ))}
                </Select>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {(approvers.data ?? []).map((a) => {
                      const on = s.staffIds.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          disabled={!on && s.staffIds.length >= APPROVAL_MAX_STAFF}
                          onClick={() => update(i, { ...s, staffIds: on ? s.staffIds.filter((x) => x !== a.id) : [...s.staffIds, a.id] })}
                          className={cn(
                            'h-8 rounded-full border px-3 text-[12.5px] font-semibold disabled:opacity-40',
                            on ? 'border-pine bg-pine text-paper' : 'border-line-strong bg-card text-ink-2',
                          )}
                        >
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                  <Segmented
                    size="sm"
                    value={s.mode}
                    onChange={(m) => update(i, { ...s, mode: m })}
                    options={[
                      { value: 'any', label: '或签（一人同意就过）' },
                      { value: 'all', label: '会签（都要同意）' },
                    ]}
                  />
                </>
              )}
            </div>
          ))}
          {steps.length < APPROVAL_MAX_LEVELS && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setSteps((all) => [...all, { kind: 'group', group: 'owner' }])} data-testid="approval-rule-add-step">
              加一级
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={allowSelf} onChange={(e) => setAllowSelf(e.target.checked)} />
          提交人可以审自己的单（默认不可以）
        </label>
        <Field label="说明（选填）" htmlFor="rule-note">
          <Input id="rule-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} placeholder="例如：五千以上加店主" />
        </Field>
      </div>
    </Dialog>
  );
}
