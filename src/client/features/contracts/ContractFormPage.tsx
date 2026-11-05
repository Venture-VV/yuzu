// 起草、修改合同与变更单（v0.7.31，docs/CONTRACTS.md 第 2、6 节）：基本信息（类型、相对方、部门、经办），
// 合同内容（标题、起止日、总价、税率、运费卸货），四要素（付款节点四段、质保、验收），单价表（物料档案里的物料或写品名）。
// 保存只核对格式；「保存并提交审查」再由服务端核对必填的（起始日、付款节点加起来 100%、采购合同至少一行物料单价）。
// 新建合同、新建变更单带操作编号，没收到结果时记在本机（ERP「结果待确认」），页面上查回、按原内容重提或作废。

import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Calculator, CloudOff, Plus, Send, Trash2 } from 'lucide-react';
import {
  BEARERS,
  BEARER_LABELS,
  CHANGE_KINDS,
  CHANGE_KIND_LABELS,
  CONTRACT_CATEGORIES,
  CONTRACT_CATEGORY_LABELS,
  CONTRACT_MAX_LINES,
  PAYMENT_STAGE_LABELS,
  WARRANTY_BASES,
  WARRANTY_BASIS_LABELS,
  blankContent,
  bpToInput,
  formatPercentBp,
  parsePercentBp,
  type Bearer,
  type ChangeKind,
  type ChangeView,
  type ContractCategory,
  type ContractContent,
  type ContractDetail,
  type ContractMeta,
  type PaymentStage,
  type WarrantyBasis,
} from '@shared/contracts';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useContract, useContractMeta, useInvalidateContracts } from './queries';

export type ContractFormMode = 'new' | 'edit' | 'change' | 'change-edit';

interface LineForm {
  key: string;
  materialId: number | null;
  itemName: string;
  spec: string;
  unit: string;
  price: string;
  taxRate: string;
  qty: string;
}

interface ContentForm {
  title: string;
  startDate: string;
  endDate: string;
  total: string;
  taxRate: string;
  freightBearer: Bearer;
  unloadingBearer: Bearer;
  terms: { stage: PaymentStage; percent: string; condition: string }[];
  warrantyBasis: WarrantyBasis;
  warrantyMonths: string;
  acceptance: { method: string; signer: string; penalty: string };
  note: string;
  lines: LineForm[];
}

interface HeaderForm {
  category: ContractCategory;
  supplierId: number | null;
  counterparty: string;
  departmentId: number | null;
  handlerId: number;
}

const qtyInput = (milli: number | null) => (milli === null ? '' : formatQty(milli).replace(/,/g, ''));

function toForm(c: ContractContent): ContentForm {
  return {
    title: c.title,
    startDate: c.startDate ?? '',
    endDate: c.endDate ?? '',
    total: c.totalCents ? centsToInput(c.totalCents) : '',
    taxRate: bpToInput(c.taxRateBp),
    freightBearer: c.freightBearer,
    unloadingBearer: c.unloadingBearer,
    terms: c.paymentTerms.map((t) => ({ stage: t.stage, percent: bpToInput(t.percentBp), condition: t.condition })),
    warrantyBasis: c.warranty.basis,
    warrantyMonths: String(c.warranty.months),
    acceptance: { ...c.acceptance },
    note: c.note,
    lines: c.lines.map((l) => ({
      key: uuid(),
      materialId: l.materialId,
      itemName: l.itemName,
      spec: l.spec,
      unit: l.unit,
      price: centsToInput(l.priceCents),
      taxRate: bpToInput(l.taxRateBp),
      qty: qtyInput(l.qtyMilli),
    })),
  };
}

const blankLine = (taxRate: string): LineForm => ({ key: uuid(), materialId: null, itemName: '', spec: '', unit: '', price: '', taxRate, qty: '' });

/** 表单 → 接口要的内容；格式不对时给出第一处错误 */
function build(f: ContentForm): { content: ContractContent; termsBp: number } | { error: string } {
  if (!f.title.trim()) return { error: '请填写合同标题' };
  if (f.startDate && f.endDate && f.endDate < f.startDate) return { error: '结束日期不能早于开始日期' };
  const totalCents = parseYuan(f.total);
  if (totalCents === null) return { error: '请填写合同总价' };
  const taxRateBp = parsePercentBp(f.taxRate);
  if (taxRateBp === null) return { error: '税率格式不正确（例如 13 或 6）' };
  const paymentTerms = [];
  for (const t of f.terms) {
    const percentBp = parsePercentBp(t.percent || '0');
    if (percentBp === null) return { error: `「${PAYMENT_STAGE_LABELS[t.stage]}」的比例格式不正确` };
    paymentTerms.push({ stage: t.stage, percentBp, condition: t.condition.trim() });
  }
  const months = Number(f.warrantyMonths || '0');
  if (!Number.isInteger(months) || months < 0 || months > 120) return { error: '质保期限按整月填（0–120）' };
  const lines = [];
  for (const [i, l] of f.lines.entries()) {
    const n = `单价表第 ${i + 1} 行`;
    if (l.materialId === null && !l.itemName.trim()) return { error: `${n}请选物料或写品名` };
    const priceCents = parseYuan(l.price);
    if (priceCents === null) return { error: `${n}请填写含税单价` };
    const lineTax = parsePercentBp(l.taxRate || bpToInput(taxRateBp));
    if (lineTax === null) return { error: `${n}的税率格式不正确` };
    const qtyMilli = l.qty.trim() ? parseQty(l.qty, 3) : null;
    if (l.qty.trim() && (qtyMilli === null || qtyMilli <= 0)) return { error: `${n}的数量格式不正确（不限量就空着）` };
    lines.push({ materialId: l.materialId, itemName: l.itemName.trim(), spec: l.spec.trim(), unit: l.unit.trim(), priceCents, taxRateBp: lineTax, qtyMilli });
  }
  return {
    content: {
      title: f.title.trim(),
      startDate: f.startDate || null,
      endDate: f.endDate || null,
      totalCents,
      taxRateBp,
      freightBearer: f.freightBearer,
      unloadingBearer: f.unloadingBearer,
      paymentTerms,
      warranty: { basis: f.warrantyBasis, months },
      acceptance: { method: f.acceptance.method.trim(), signer: f.acceptance.signer.trim(), penalty: f.acceptance.penalty.trim() },
      note: f.note.trim(),
      lines,
    },
    termsBp: paymentTerms.reduce((t, x) => t + x.percentBp, 0),
  };
}

/** 续签：照原合同预填（相对方、部门、经办、四要素、单价表），起始日接在原合同结束日的第二天 */
function renewalContent(old: ContractDetail): ContractContent {
  const next = old.endDate ? new Date(Date.parse(`${old.endDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
  return { ...old.content, startDate: next, endDate: null };
}

export function ContractFormPage({ mode }: { mode: ContractFormMode }) {
  const can = useCan();
  const params = useParams();
  const [search] = useSearchParams();
  const renewId = mode === 'new' ? Number(search.get('renew')) || null : null;
  const contractId = mode === 'new' ? renewId : Number(params.id) || null;
  const meta = useContractMeta();
  const contract = useContract(contractId);
  if (!can('contract.manage')) return <Navigate to="/erp/contracts" replace />;
  const title = mode === 'new' ? (renewId ? '续签合同' : '新建合同') : mode === 'edit' ? '修改合同' : mode === 'change' ? '新建变更单' : '修改变更单';
  const loading = meta.isPending || (contractId !== null && contract.isPending);
  const error = meta.error ?? (contractId !== null ? contract.error : null);
  const change = mode === 'change-edit' ? (contract.data?.changes.find((x) => x.id === Number(params.changeId)) ?? null) : null;
  return (
    <ErpPage
      title={title}
      description={
        mode === 'change' || mode === 'change-edit'
          ? '在当前生效的版本上改：改价、改量、延期……写清原因；变更单走与合同相同的审查（法务按审查清单逐条审），同意后合同升一版。'
          : '基本信息、四要素（单价、付款节点、质保、验收）与单价表；保存后可以继续改，提交审查后走审批中心。'
      }
      actions={
        <Link to={contractId ? `/erp/contracts/${contractId}` : '/erp/contracts'} className="flex items-center gap-1 text-[13px] font-semibold text-ink-3 hover:text-ink">
          <ArrowLeft className="size-4" />
          {contractId && mode !== 'new' ? '回到合同' : '回到台账'}
        </Link>
      }
    >
      {loading ? (
        <Skeleton className="h-96" />
      ) : error ? (
        <Notice tone="error" title={errorMessage(error)} />
      ) : mode === 'change-edit' && !change ? (
        <Notice tone="error" title="变更单不存在" />
      ) : (
        <ContractForm key={`${mode}-${contractId ?? 0}-${change?.id ?? 0}`} mode={mode} meta={meta.data!} contract={contract.data ?? null} change={change} renew={mode === 'new' && !!renewId} />
      )}
    </ErpPage>
  );
}

function ContractForm({ mode, meta, contract, change, renew }: { mode: ContractFormMode; meta: ContractMeta; contract: ContractDetail | null; change: ChangeView | null; renew: boolean }) {
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateContracts();
  const isChange = mode === 'change' || mode === 'change-edit';
  const pendingCreate = useErpPending(['contract_create']);
  const pendingChange = useErpPending(['contract_change']);
  const changeUrl = contract ? `/api/erp/contracts/${contract.id}/changes` : '';
  const pending = mode === 'new' ? pendingCreate : mode === 'change' ? pendingChange.filter((p) => p.url === changeUrl) : [];

  const [header, setHeader] = useState<HeaderForm>(() =>
    contract && mode !== 'new'
      ? { category: contract.category, supplierId: contract.supplierId, counterparty: contract.counterparty, departmentId: contract.departmentId, handlerId: contract.handlerId }
      : contract && renew
        ? { category: contract.category, supplierId: contract.supplierId, counterparty: contract.counterparty, departmentId: contract.departmentId, handlerId: contract.handlerId }
        : { category: 'purchase', supplierId: null, counterparty: '', departmentId: null, handlerId: session.staff.id },
  );
  const [form, setForm] = useState<ContentForm>(() =>
    toForm(mode === 'change-edit' && change ? change.draft : contract && renew ? renewalContent(contract) : contract ? contract.content : blankContent()),
  );
  const [kinds, setKinds] = useState<ChangeKind[]>(change?.kinds ?? []);
  const [reason, setReason] = useState(change?.reason ?? '');
  const [busy, setBusy] = useState<null | 'save' | 'submit'>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertainEdit, setUncertainEdit] = useState(false);

  const materials = useMemo(() => new Map(meta.materials.map((m) => [m.id, m])), [meta.materials]);
  const built = build(form);
  const termsBp = 'content' in built ? built.termsBp : form.terms.reduce((t, x) => t + (parsePercentBp(x.percent || '0') ?? 0), 0);
  const warrantyBp = parsePercentBp(form.terms.find((t) => t.stage === 'warranty')?.percent || '0') ?? 0;
  const blocking =
    pending.length > 0
      ? `上一${isChange ? '张变更单' : '份合同'}结果待确认，请先在上方查回、重新提交或作废`
      : !isChange && header.category === 'purchase' && !header.supplierId
        ? '采购合同请从供应商档案里选相对方'
        : !isChange && !header.supplierId && !header.counterparty.trim()
          ? '请填写相对方'
          : isChange && kinds.length === 0
            ? '请选择变更类型'
            : isChange && reason.trim().length < 2
              ? '请写变更原因（至少 2 个字）'
              : 'error' in built
                ? built.error
                : null;
  // 提交审查时服务端还要核对的（这里先提示）
  const submitHint =
    termsBp !== 10000
      ? `付款节点加起来是 ${formatPercentBp(termsBp)}，提交审查前要等于 100%`
      : !form.startDate
        ? '提交审查前请填开始日期'
        : warrantyBp > 0 && Number(form.warrantyMonths || '0') === 0
          ? '有质保金比例时请填质保期限'
          : header.category === 'purchase' && form.lines.length === 0
            ? '采购合同提交审查前请填写单价表'
            : header.category === 'purchase' && form.lines.some((l) => l.materialId === null)
              ? '采购合同的单价表每一行都要选物料（采购单按它核对）'
              : null;

  const setLine = (key: string, patch: Partial<LineForm>) => setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const lineTotal = () => {
    let t = 0;
    for (const l of form.lines) {
      const p = parseYuan(l.price);
      const q = l.qty.trim() ? parseQty(l.qty, 3) : null;
      if (p === null || q === null) return null;
      t += Math.round((p * q) / 1000);
    }
    return form.lines.length ? t : null;
  };
  const computed = lineTotal();

  const headerBody = () => ({
    category: header.category,
    supplierId: header.supplierId,
    counterparty: header.counterparty.trim(),
    departmentId: header.departmentId,
    handlerId: header.handlerId,
  });

  const save = async (andSubmit: boolean) => {
    if (blocking || !('content' in built)) return;
    const content = built.content;
    setBusy(andSubmit ? 'submit' : 'save');
    setError(null);
    let detail: ContractDetail;
    let saved: ChangeView | null = null;
    try {
      if (mode === 'new') {
        const body = { clientKey: uuid(), ...headerBody(), renewalOf: renew && contract ? contract.id : null, content };
        const party = header.supplierId ? (meta.suppliers.find((s) => s.id === header.supplierId)?.name ?? '') : header.counterparty.trim();
        const r = await sendErpOp<{ contract: ContractDetail }>({
          key: body.clientKey,
          type: 'contract_create',
          url: '/api/erp/contracts',
          body,
          summary: `${party} · ${content.title} · ¥${formatAmount(content.totalCents)}`,
          staffName: session.staff.displayName,
        });
        detail = r.contract;
      } else if (mode === 'edit') {
        detail = await api.put<ContractDetail>(`/api/erp/contracts/${contract!.id}`, { version: contract!.version, ...headerBody(), renewalOf: contract!.renewalOf?.id ?? null, content });
      } else if (mode === 'change') {
        const body = { clientKey: uuid(), kinds, reason: reason.trim(), content };
        const r = await sendErpOp<{ change: ChangeView; contract: ContractDetail }>({
          key: body.clientKey,
          type: 'contract_change',
          url: changeUrl,
          body,
          summary: `${contract!.contractNo} · ${kinds.map((k) => CHANGE_KIND_LABELS[k]).join('、')} · ${reason.trim().slice(0, 20)}`,
          staffName: session.staff.displayName,
        });
        detail = r.contract;
        saved = r.change;
      } else {
        detail = await api.put<ContractDetail>(`/api/erp/contracts/changes/${change!.id}`, { version: change!.version, kinds, reason: reason.trim(), content });
        saved = detail.changes.find((x) => x.id === change!.id) ?? null;
      }
    } catch (e) {
      if (e instanceof UncertainError) {
        // 新建的记在本机「结果待确认」里（页面上方）；修改带版本号，重复保存不会覆盖别人的改动
        if (mode === 'edit' || mode === 'change-edit') setUncertainEdit(true);
      } else setError(errorMessage(e));
      setBusy(null);
      return;
    }
    if (andSubmit) {
      try {
        if (saved) await api.post(`/api/erp/contracts/changes/${saved.id}/submit`, { version: saved.version });
        else await api.post(`/api/erp/contracts/${detail.id}/submit`, { version: detail.version });
        toast({ tone: 'success', title: isChange ? '变更单已提交审查' : '合同已提交审查', body: `${detail.contractNo}：在审批中心走审批，法务按审查清单逐条审` });
      } catch (e) {
        toast({
          tone: 'error',
          title: e instanceof UncertainError ? '已保存；提交审查没收到结果' : `已保存，但没能提交审查：${errorMessage(e)}`,
          body: e instanceof UncertainError ? '在合同详情里刷新看状态；再点一次「提交审查」不会多走一轮' : detail.contractNo,
        });
      }
    } else toast({ tone: 'success', title: isChange ? '变更单已保存' : '合同已保存', body: detail.contractNo });
    await invalidate();
    setBusy(null);
    navigate(`/erp/contracts/${detail.id}`);
  };

  const fieldsDisabled = !!busy;
  const supplierName = (id: number | null) => (id ? (meta.suppliers.find((s) => s.id === id)?.name ?? `#${id}`) : '');

  return (
    <div className="space-y-4" data-testid="contract-form">
      {mode === 'new' && <ErpPendingPanel types={['contract_create']} onFound={(_, ref) => navigate(`/erp/contracts/${ref.refId}`)} />}
      {mode === 'change' && contract && (
        <ErpPendingPanel types={['contract_change']} filter={(op) => op.url === changeUrl} onFound={() => navigate(`/erp/contracts/${contract.id}`)} />
      )}
      {mode === 'edit' && contract?.status === 'returned' && <Notice tone="warning" title="审批退回了：看合同详情里的审批意见与法务审查清单，改好后再提交审查" />}
      {change?.status === 'returned' && <Notice tone="warning" title="变更单被退回了：看合同详情里的审批意见，改好后再提交" />}
      {uncertainEdit && (
        <Notice tone="warning" icon={<CloudOff className="size-5" />} title="保存结果待确认：网络断了或超时">
          修改带了版本号，重复保存不会覆盖别人的改动。回到合同详情看看改动在不在，不在就重新改。
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={() => void invalidate().then(() => navigate(`/erp/contracts/${contract!.id}`))}>
              回到合同详情
            </Button>
          </div>
        </Notice>
      )}

      {/* 基本信息 */}
      <Card className="p-5">
        <h2 className="mb-3 text-[14px] font-bold">基本信息</h2>
        {isChange ? (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-2">
              <span className="num font-bold text-ink">{contract!.contractNo}</span> · {contract!.title} · {contract!.counterparty} · 在第 {change?.baseVersion ?? contract!.currentVersion}{' '}
              版上变更
            </p>
            <Field label="变更类型">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="变更类型">
                {CHANGE_KINDS.map((k) => {
                  const on = kinds.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      disabled={fieldsDisabled}
                      onClick={() => setKinds((ks) => (on ? ks.filter((x) => x !== k) : [...ks, k]))}
                      className={cn('h-8 rounded-full px-3 text-[13px] font-semibold', on ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:bg-paper-3')}
                      data-testid={`change-kind-${k}`}
                    >
                      {CHANGE_KIND_LABELS[k]}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="变更原因" htmlFor="cc-reason">
              <Textarea id="cc-reason" rows={2} maxLength={200} value={reason} disabled={fieldsDisabled} onChange={(e) => setReason(e.target.value)} placeholder="例如：原材料涨价，单价从 50 元调到 55 元" data-testid="change-reason" />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="合同类型" htmlFor="ct-category">
              <Select
                id="ct-category"
                value={header.category}
                disabled={fieldsDisabled}
                onChange={(e) => setHeader((h) => ({ ...h, category: e.target.value as ContractCategory }))}
                data-testid="contract-category"
              >
                {CONTRACT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CONTRACT_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="供应商" htmlFor="ct-supplier" hint={header.category === 'purchase' ? '采购合同从供应商档案里选' : '不是供应商的写在「相对方」'}>
              <Select
                id="ct-supplier"
                value={header.supplierId ?? ''}
                disabled={fieldsDisabled}
                onChange={(e) => setHeader((h) => ({ ...h, supplierId: Number(e.target.value) || null }))}
                data-testid="contract-supplier"
              >
                <option value="">{header.category === 'purchase' ? '选择供应商' : '不是供应商'}</option>
                {meta.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="相对方" htmlFor="ct-party" hint={header.supplierId ? `空着就用「${supplierName(header.supplierId)}」` : '合同另一方的全称'}>
              <Input
                id="ct-party"
                value={header.counterparty}
                maxLength={60}
                disabled={fieldsDisabled}
                onChange={(e) => setHeader((h) => ({ ...h, counterparty: e.target.value }))}
                className="h-10"
                data-testid="contract-counterparty"
              />
            </Field>
            <Field label="部门" htmlFor="ct-dept" hint="选填：哪个部门用">
              <Select id="ct-dept" value={header.departmentId ?? ''} disabled={fieldsDisabled} onChange={(e) => setHeader((h) => ({ ...h, departmentId: Number(e.target.value) || null }))}>
                <option value="">不分部门</option>
                {meta.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="经办人" htmlFor="ct-handler">
              <Select id="ct-handler" value={header.handlerId} disabled={fieldsDisabled} onChange={(e) => setHeader((h) => ({ ...h, handlerId: Number(e.target.value) }))}>
                {meta.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            {renew && contract && (
              <Field label="续签自">
                <p className="flex h-10 items-center text-[14px] font-semibold">
                  {contract.contractNo}（{contract.endDate ?? '不定期'} 到期）
                </p>
              </Field>
            )}
          </div>
        )}
      </Card>

      {/* 合同内容 */}
      <Card className="p-5">
        <h2 className="mb-3 text-[14px] font-bold">合同内容</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="合同标题" htmlFor="ct-title" className="sm:col-span-2">
            <Input
              id="ct-title"
              value={form.title}
              maxLength={60}
              disabled={fieldsDisabled}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="例如：2027 年客用毛巾采购合同"
              className="h-10"
              data-testid="contract-title"
            />
          </Field>
          <Field label="开始日期" htmlFor="ct-start">
            <Input id="ct-start" type="date" value={form.startDate} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} className="h-10" data-testid="contract-start" />
          </Field>
          <Field label="结束日期" htmlFor="ct-end" hint="空着 = 不定期">
            <Input id="ct-end" type="date" value={form.endDate} min={form.startDate || undefined} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} className="h-10" data-testid="contract-end" />
          </Field>
          <Field
            label="合同总价（含税）"
            htmlFor="ct-total"
            aside={
              computed !== null && computed !== parseYuan(form.total) ? (
                <button type="button" className="flex items-center gap-1 text-[12px] font-semibold text-lake hover:underline" onClick={() => setForm((f) => ({ ...f, total: centsToInput(computed) }))}>
                  <Calculator className="size-3.5" />按单价表 ¥{formatAmount(computed)}
                </button>
              ) : undefined
            }
          >
            <MoneyInput id="ct-total" value={form.total} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, total: e.target.value }))} className="h-10" data-testid="contract-total" />
          </Field>
          <Field label="主要税率（%）" htmlFor="ct-tax">
            <Input id="ct-tax" inputMode="decimal" value={form.taxRate} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, taxRate: e.target.value }))} className="h-10 text-right" />
          </Field>
          <Field label="运费" htmlFor="ct-freight">
            <Select id="ct-freight" value={form.freightBearer} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, freightBearer: e.target.value as Bearer }))}>
              {BEARERS.map((b) => (
                <option key={b} value={b}>
                  {BEARER_LABELS[b]}承担
                </option>
              ))}
            </Select>
          </Field>
          <Field label="卸货" htmlFor="ct-unload">
            <Select id="ct-unload" value={form.unloadingBearer} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, unloadingBearer: e.target.value as Bearer }))}>
              {BEARERS.map((b) => (
                <option key={b} value={b}>
                  {BEARER_LABELS[b]}承担
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      {/* 四要素 */}
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 className="text-[14px] font-bold">付款节点</h2>
          <span className={cn('num text-[12.5px] font-semibold', termsBp === 10000 ? 'text-pine' : 'text-clay')} data-testid="contract-terms-sum">
            合计 {formatPercentBp(termsBp)}
          </span>
          <span className="text-[12.5px] text-ink-3">四段按顺序：预付 → 到货 → 验收 → 质保；「质保」那一段就是质保金比例，不付的填 0</span>
        </div>
        <div className="space-y-2">
          {form.terms.map((t, i) => (
            <div key={t.stage} className="grid grid-cols-[56px_96px_minmax(0,1fr)] items-center gap-2">
              <span className="text-[13px] font-semibold">{PAYMENT_STAGE_LABELS[t.stage]}</span>
              <label className="flex items-center gap-1 text-[13px] text-ink-3">
                <Input
                  aria-label={`${PAYMENT_STAGE_LABELS[t.stage]}比例`}
                  inputMode="decimal"
                  value={t.percent}
                  disabled={fieldsDisabled}
                  onChange={(e) => setForm((f) => ({ ...f, terms: f.terms.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)) }))}
                  className="h-9 text-right"
                  data-testid={`contract-term-${t.stage}`}
                />
                %
              </label>
              <Input
                aria-label={`${PAYMENT_STAGE_LABELS[t.stage]}条件`}
                value={t.condition}
                maxLength={60}
                disabled={fieldsDisabled}
                onChange={(e) => setForm((f) => ({ ...f, terms: f.terms.map((x, j) => (j === i ? { ...x, condition: e.target.value } : x)) }))}
                placeholder="触发条件"
                className="h-9"
              />
            </div>
          ))}
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="质保起算" htmlFor="ct-wbasis">
            <Select id="ct-wbasis" value={form.warrantyBasis} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, warrantyBasis: e.target.value as WarrantyBasis }))}>
              {WARRANTY_BASES.map((b) => (
                <option key={b} value={b}>
                  从{WARRANTY_BASIS_LABELS[b]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="质保期限（月）" htmlFor="ct-wmonths" hint={`质保金 ${formatPercentBp(warrantyBp)}`}>
            <Input id="ct-wmonths" inputMode="numeric" value={form.warrantyMonths} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, warrantyMonths: e.target.value }))} className="h-10 text-right" />
          </Field>
          <Field label="验收签字" htmlFor="ct-signer" className="lg:col-span-2">
            <Input
              id="ct-signer"
              value={form.acceptance.signer}
              maxLength={60}
              disabled={fieldsDisabled}
              onChange={(e) => setForm((f) => ({ ...f, acceptance: { ...f.acceptance, signer: e.target.value } }))}
              placeholder="例如：仓管与使用部门负责人"
              className="h-10"
            />
          </Field>
          <Field label="验收方法" htmlFor="ct-method" className="sm:col-span-2">
            <Textarea
              id="ct-method"
              rows={2}
              maxLength={200}
              value={form.acceptance.method}
              disabled={fieldsDisabled}
              onChange={(e) => setForm((f) => ({ ...f, acceptance: { ...f.acceptance, method: e.target.value } }))}
              placeholder="例如：到货按规格抽检 10%，洗涤 3 次不褪色、不起球"
            />
          </Field>
          <Field label="不合格怎么处理" htmlFor="ct-penalty" className="sm:col-span-2">
            <Textarea
              id="ct-penalty"
              rows={2}
              maxLength={200}
              value={form.acceptance.penalty}
              disabled={fieldsDisabled}
              onChange={(e) => setForm((f) => ({ ...f, acceptance: { ...f.acceptance, penalty: e.target.value } }))}
              placeholder="例如：不合格的退换，逾期按日万分之五扣违约金"
            />
          </Field>
        </div>
      </Card>

      {/* 单价表 */}
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-bold">单价表</h2>
          <span className="text-[12.5px] text-ink-3">采购单挂这份合同时按这里的含税单价、数量核对；数量空着 = 不限量</span>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            icon={<Plus className="size-4" />}
            disabled={fieldsDisabled || form.lines.length >= CONTRACT_MAX_LINES}
            onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, blankLine(f.taxRate)] }))}
            data-testid="contract-line-add"
          >
            加一行
          </Button>
        </div>
        {form.lines.length === 0 ? (
          <p className="text-[13px] text-ink-3">{header.category === 'purchase' ? '采购合同要有单价表、每一行都选物料（提交审查时核对）。' : '服务、租赁类可以不填单价表。'}</p>
        ) : (
          <ul className="space-y-2.5">
            {form.lines.map((l, i) => {
              const m = l.materialId !== null ? materials.get(l.materialId) : undefined;
              return (
                <li key={l.key} className="rounded-lg border border-line p-3" data-testid={`contract-line-${i}`}>
                  <div className="grid gap-2 sm:grid-cols-6 lg:grid-cols-12">
                    <Field label={`第 ${i + 1} 行 · 物料`} className="sm:col-span-3 lg:col-span-4">
                      <Select
                        aria-label={`第 ${i + 1} 行物料`}
                        value={l.materialId ?? ''}
                        disabled={fieldsDisabled}
                        onChange={(e) => {
                          const next = materials.get(Number(e.target.value));
                          setLine(l.key, { materialId: next?.id ?? null, unit: next && !l.unit.trim() ? next.purchaseUnit.slice(0, 8) : l.unit, spec: next && !l.spec.trim() ? next.specification.slice(0, 80) : l.spec });
                        }}
                        data-testid={`contract-line-material-${i}`}
                      >
                        <option value="">不选物料（写品名）</option>
                        {meta.materials.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.code} · {x.name}
                            {x.specification ? ` · ${x.specification}` : ''}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="品名" className="sm:col-span-3 lg:col-span-3">
                      <Input
                        aria-label={`第 ${i + 1} 行品名`}
                        value={l.itemName}
                        maxLength={40}
                        disabled={fieldsDisabled}
                        onChange={(e) => setLine(l.key, { itemName: e.target.value })}
                        placeholder={m ? m.name : '服务、设备等'}
                        className="h-10"
                      />
                    </Field>
                    <Field label="规格" className="sm:col-span-3 lg:col-span-3">
                      <Input aria-label={`第 ${i + 1} 行规格`} value={l.spec} maxLength={80} disabled={fieldsDisabled} onChange={(e) => setLine(l.key, { spec: e.target.value })} className="h-10" />
                    </Field>
                    <Field label="单位" className="sm:col-span-1 lg:col-span-2">
                      <Input
                        aria-label={`第 ${i + 1} 行单位`}
                        value={l.unit}
                        maxLength={8}
                        disabled={fieldsDisabled}
                        onChange={(e) => setLine(l.key, { unit: e.target.value })}
                        placeholder={m?.purchaseUnit}
                        className="h-10"
                      />
                    </Field>
                    <Field label="含税单价" className="sm:col-span-2 lg:col-span-3">
                      <MoneyInput aria-label={`第 ${i + 1} 行含税单价`} value={l.price} disabled={fieldsDisabled} onChange={(e) => setLine(l.key, { price: e.target.value })} className="h-10 text-right" data-testid={`contract-line-price-${i}`} />
                    </Field>
                    <Field label="税率（%）" className="sm:col-span-1 lg:col-span-2">
                      <Input aria-label={`第 ${i + 1} 行税率`} inputMode="decimal" value={l.taxRate} disabled={fieldsDisabled} onChange={(e) => setLine(l.key, { taxRate: e.target.value })} className="h-10 text-right" />
                    </Field>
                    <Field label="合同数量" hint="空着 = 不限量" className="sm:col-span-2 lg:col-span-3">
                      <Input aria-label={`第 ${i + 1} 行数量`} inputMode="decimal" value={l.qty} disabled={fieldsDisabled} onChange={(e) => setLine(l.key, { qty: e.target.value })} className="h-10 text-right" data-testid={`contract-line-qty-${i}`} />
                    </Field>
                    <div className="flex items-end justify-end sm:col-span-6 lg:col-span-4">
                      <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} disabled={fieldsDisabled} onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((x) => x.key !== l.key) }))}>
                        删除这一行
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Field label="备注" htmlFor="ct-note" className="mt-4">
          <Textarea id="ct-note" rows={2} maxLength={200} value={form.note} disabled={fieldsDisabled} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="选填" />
        </Field>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2 pb-6">
        {blocking ? (
          <p className="mr-auto text-[12.5px] font-semibold text-clay" data-testid="contract-form-blocking">
            {blocking}
          </p>
        ) : (
          submitHint && (
            <p className="mr-auto text-[12.5px] font-semibold text-ember" data-testid="contract-form-hint">
              {submitHint}（可以先保存草稿）
            </p>
          )
        )}
        {error && <Notice tone="error" title={error} className="w-full" />}
        {renew && <Badge tone="lake">续签</Badge>}
        <Button variant="secondary" loading={busy === 'save'} disabled={!!blocking || !!busy || uncertainEdit} onClick={() => void save(false)} data-testid="contract-save">
          {isChange ? '保存变更单' : '保存草稿'}
        </Button>
        <Button
          variant="primary"
          icon={<Send className="size-4" />}
          loading={busy === 'submit'}
          disabled={!!blocking || !!submitHint || !!busy || uncertainEdit}
          onClick={() => void save(true)}
          data-testid="contract-save-submit"
        >
          保存并提交审查
        </Button>
      </div>
    </div>
  );
}
