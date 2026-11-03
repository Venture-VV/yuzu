// 后台「券与会员权益」（v0.7.20，飞书 RQ-006 后半，见 docs/COUPONS.md 第 1、2、5、6 节）：
//   · 券模板：代金券、折扣券、兑换券；门槛、适用范围（整单 / 指定部门 / 指定项目）、有效期（发券后 N 天 / 固定日期，按营业日）、
//     限定发放档级（会员体系 v2 的 L0–L6）。发过券的模板只能改名称、备注、停用（带版本号；服务端 TEMPLATE_LOCKED / TEMPLATE_STALE 兜底），要改条件另建；
//   · 发券规则：开卡礼、升级礼（按档级）、生日礼（按档级）、充值赠券（按充值套餐）。规则不能改，只能停用后另加；
//   · 无记名券：按模板生成一批券码（带操作编号，没收到结果时按原内容再提交不会多生成）、导出券码交印刷、按批次作废没用的；
//   · 统计：按模板列发券、用券（张数、抵扣金额）、过期、作废。
// 默认店主、店总（「维护券模板、发券规则与无记名券」）；按批次作废还要「作废券」。会员的券在会员详情里看、发、作废。

import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, CopyPlus, Download, Plus, Search } from 'lucide-react';
import { ISO_DATE } from '@shared/business-date';
import {
  COUPON_KIND_LABELS,
  COUPON_KINDS,
  COUPON_RULE_KIND_LABELS,
  COUPON_RULE_KINDS,
  COUPON_SCOPE_LABELS,
  COUPON_SCOPES,
  COUPON_STATE_LABELS,
  MAX_BATCH_COUPONS,
  MAX_MANUAL_COUPONS,
  type CouponBatch,
  type CouponKind,
  type CouponMeta,
  type CouponRule,
  type CouponRuleKind,
  type CouponScope,
  type CouponTemplate,
  type CouponValidity,
} from '@shared/coupons';
import { shiftDate } from '@shared/labels';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import {
  COUPON_KIND_TONES,
  COUPON_STATE_ORDER,
  COUPON_STATE_TONES,
  couponKeys,
  couponRangeText,
  templateExpired,
  templateValidityText,
  useCouponBatches,
  useCouponMeta,
  useCouponRules,
  useCouponStats,
  useCouponTemplates,
  useInvalidateCoupons,
} from '../coupons/queries';
import { AdminPage } from './AdminShell';

type Tab = 'templates' | 'rules' | 'batches' | 'stats';
const TABS: { value: Tab; label: string }[] = [
  { value: 'templates', label: '券模板' },
  { value: 'rules', label: '发券规则' },
  { value: 'batches', label: '无记名券' },
  { value: 'stats', label: '统计' },
];

/** 后台页面上方列出的「结果待确认」：后台的三种，另加发券给会员（店主在这里也能处理） */
const COUPON_PENDING_TYPES = ['coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue'] as const;

/** 没收到结果时的提示：记录留在本机，到页面上方处理 */
const pendingToast = (label: string) => ({
  tone: 'info' as const,
  title: `${label}：没收到结果`,
  body: '可能已经办好，也可能没有。这笔记在页面上方「结果待确认」里（刷新、重新登录也在）：先查回；查不到就按原内容重新提交（同一操作编号，不会多出一条）或确认作废后再重新填写。',
});

export function CouponsSection() {
  const [tab, setTab] = useState<Tab>('templates');
  const invalidateCoupons = useInvalidateCoupons();
  return (
    <AdminPage
      section="coupons"
      description="券模板（代金券、折扣券、兑换券）、自动发券的规则（开卡礼、升级礼、生日礼、充值赠券）、无记名纸质券与统计。会员的券在会员详情里看、发、作废；结账时在收款里用券。"
    >
      <div className="space-y-4" data-testid="coupon-admin">
        {/* 新建模板、加规则、生成无记名券、发券时断网：关掉对话框、刷新、重新登录后在这里查回、按原内容重新提交或作废（Codex 复审 6c3765c） */}
        <ErpPendingPanel types={COUPON_PENDING_TYPES} className="space-y-2" onFound={() => void invalidateCoupons()} />
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          ariaLabel="券与会员权益"
          // 手机上一行放不下就换行，不横向滚动
          className="max-w-full flex-wrap"
          options={TABS.map((t) => ({ value: t.value, label: <span data-testid={`coupon-tab-${t.value}`}>{t.label}</span> }))}
        />
        {tab === 'templates' ? <TemplatesCard /> : tab === 'rules' ? <RulesCard /> : tab === 'batches' ? <BatchesCard /> : <StatsCard />}
      </div>
    </AdminPage>
  );
}

// ───────────────────────── 共用 ─────────────────────────

/** 「L3 观澜」：会员体系 v2 的档级（v0.7.23；名称按会员规则） */
function levelLabel(levels: CouponMeta['levels'] | undefined, level: number) {
  return levels?.find((l) => l.level === level)?.name ?? `L${level}`;
}
const levelsText = (levels: CouponMeta['levels'] | undefined, picked: number[]) =>
  picked.length ? `限 ${picked.map((l) => levelLabel(levels, l)).join('、')}` : '不限档级';

/** 张数输入：只留数字 */
const digits = (v: string) => v.replace(/[^0-9]/g, '');

const EMPTY_BOX = 'mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3';

function CheckChip({ checked, onChange, children, testId }: { checked: boolean; onChange: (on: boolean) => void; children: ReactNode; testId?: string }) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] transition-colors has-[:disabled]:cursor-default has-[:disabled]:opacity-70',
        checked ? 'border-pine/60 bg-pine-tint font-semibold text-pine' : 'border-line text-ink-2 hover:border-line-strong',
      )}
    >
      <input type="checkbox" className="size-4 accent-pine" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {children}
    </label>
  );
}

// ───────────────────────── 券模板 ─────────────────────────

type TemplateTarget = { mode: 'new' } | { mode: 'edit'; template: CouponTemplate } | { mode: 'copy'; template: CouponTemplate } | null;

function TemplatesCard() {
  const session = useSession();
  const templates = useCouponTemplates();
  const meta = useCouponMeta();
  // 新建的结果待确认时先处理那一笔（查回、重提或作废），免得同一个模板建两个
  const pendingNew = useErpPending(['coupon_template']).length > 0;
  const [target, setTarget] = useState<TemplateTarget>(null);
  const [showInactive, setShowInactive] = useState(false);
  const failed = templates.error ?? meta.error;
  if (failed) return <Notice tone="error" title={errorMessage(failed)} />;
  if (!templates.data || !meta.data) return <Skeleton className="h-64" />;
  const list = templates.data;
  const inactive = list.filter((t) => !t.active).length;
  const shown = showInactive ? list : list.filter((t) => t.active);
  return (
    <Card className="p-5" data-testid="coupon-templates">
      <SectionTitle
        aside={
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-4" />}
            disabled={pendingNew}
            title={pendingNew ? '上一次新建的结果待确认：先在页面上方查回、重提或作废' : undefined}
            onClick={() => setTarget({ mode: 'new' })}
            data-testid="coupon-template-new"
          >
            新建券模板
          </Button>
        }
      >
        <span className="inline-flex items-center gap-2">
          券模板 <PendingBadge title="券的种类、门槛、范围与有效期按洗浴、餐饮、酒店常见的会员营销做法定，待店主确认" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        代金券：面额，满多少可用，不找零；折扣券：几折，可设最多减多少；兑换券：抵账单上指定项目（或票种）的一份。有效期按营业日。发过券的模板只能改名称、备注、停用（已发的券按发券时的条件算），要改条件请另建模板；停用后不能再发（自动规则也跳过），已发的照常可用。
      </p>
      {list.length === 0 ? (
        <p className={EMPTY_BOX}>还没有券模板。点「新建券模板」，例如「洗浴代金券」面额 ¥30、满 ¥100 可用，发券后 30 天有效。</p>
      ) : shown.length === 0 ? (
        <p className={EMPTY_BOX}>没有启用的券模板。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {shown.map((t) => (
            <TemplateRow key={t.id} t={t} levels={meta.data.levels} today={session.today} onEdit={() => setTarget({ mode: 'edit', template: t })} />
          ))}
        </ul>
      )}
      {inactive > 0 && (
        <button type="button" className="mt-2 text-[12.5px] font-semibold text-pine hover:underline" onClick={() => setShowInactive(!showInactive)} data-testid="coupon-template-show-inactive">
          {showInactive ? '收起已停用的模板' : `显示已停用的 ${inactive} 个模板`}
        </button>
      )}
      <TemplateDialog target={target} meta={meta.data} templates={list} onClose={() => setTarget(null)} onCopy={(t) => setTarget({ mode: 'copy', template: t })} />
    </Card>
  );
}

function TemplateRow({ t, levels, today, onEdit }: { t: CouponTemplate; levels: CouponMeta['levels']; today: string; onEdit: () => void }) {
  return (
    <li className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-3', !t.active && 'bg-paper-2/50')} data-testid={`coupon-template-${t.id}`}>
      <div className="min-w-0 flex-1 basis-[260px]">
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="text-[14.5px] font-bold break-all text-ink">{t.name}</span>
          <Badge tone={COUPON_KIND_TONES[t.kind]}>{COUPON_KIND_LABELS[t.kind]}</Badge>
          {t.active ? <Badge tone="pine">启用</Badge> : <Badge tone="clay">已停用</Badge>}
          {templateExpired(t, today) && <Badge tone="ember">有效期已过</Badge>}
        </p>
        <p className="mt-0.5 text-[13px] text-ink-2">{t.summary}</p>
        <p className="mt-0.5 text-[12px] text-ink-3">
          {templateValidityText(t)} · {levelsText(levels, t.levels)}
          {t.note ? ` · ${t.note}` : ''}
        </p>
      </div>
      <span className="text-[12.5px] whitespace-nowrap text-ink-3" data-testid={`coupon-template-issued-${t.id}`}>
        已发 <b className="num text-ink-2">{t.issued}</b> 张
      </span>
      <Button size="sm" variant="ghost" onClick={onEdit} data-testid={`coupon-template-edit-${t.id}`}>
        编辑
      </Button>
    </li>
  );
}

/** 对话框里的填写内容（金额按元、折扣按「几折」填） */
interface Draft {
  name: string;
  kind: CouponKind;
  faceValue: string;
  rate: string;
  maxOff: string;
  threshold: string;
  scope: CouponScope;
  scopeCategories: string[];
  scopeItems: number[];
  exchangeTarget: 'item' | 'ticket';
  exchangeItemId: number | null;
  exchangeTicketTypeId: number | null;
  validity: CouponValidity;
  validFrom: string;
  validTo: string;
  validDays: string;
  levels: number[];
  note: string;
  active: boolean;
}

/** 提交的模板内容（与服务端的字段一致） */
type TemplateBody = Pick<
  CouponTemplate,
  | 'name'
  | 'kind'
  | 'faceValue'
  | 'ratePercent'
  | 'maxOff'
  | 'threshold'
  | 'scope'
  | 'scopeCategories'
  | 'scopeItems'
  | 'exchangeItemId'
  | 'exchangeTicketTypeId'
  | 'validity'
  | 'validFrom'
  | 'validTo'
  | 'validDays'
  | 'levels'
  | 'note'
  | 'active'
>;

const MAX_NAME = 24;
/** 面额、最多减 / 最多抵：最多 1 万元；门槛最多 100 万元（与服务端一致） */
const MAX_OFF_CENTS = 1_000_000;
const MAX_THRESHOLD_CENTS = 100_000_000;

/** 88 → 「8.8」，90 → 「9」 */
const rateInput = (ratePercent: number) => String(Number((ratePercent / 10).toFixed(1)));
/** 「8.8」→ 88，「9」→ 90：1 折到 9.9 折、最多一位小数；不对返回 null */
function parseRate(text: string): number | null {
  const m = /^([1-9])(?:\.(\d))?$/.exec(text.trim());
  return m ? Number(m[1]) * 10 + Number(m[2] ?? 0) : null;
}

function draftOf(t: CouponTemplate | null, today: string, copy = false): Draft {
  if (!t) {
    return {
      name: '',
      kind: 'cash',
      faceValue: '',
      rate: '',
      maxOff: '',
      threshold: '',
      scope: 'all',
      scopeCategories: [],
      scopeItems: [],
      exchangeTarget: 'item',
      exchangeItemId: null,
      exchangeTicketTypeId: null,
      validity: 'days',
      validFrom: today,
      validTo: shiftDate(today, 29),
      validDays: '30',
      levels: [],
      note: '',
      active: true,
    };
  }
  return {
    name: copy ? `${t.name}（新）`.slice(0, MAX_NAME) : t.name,
    kind: t.kind,
    faceValue: t.faceValue !== null ? centsToInput(t.faceValue) : '',
    rate: t.ratePercent !== null ? rateInput(t.ratePercent) : '',
    maxOff: t.maxOff !== null ? centsToInput(t.maxOff) : '',
    threshold: t.threshold ? centsToInput(t.threshold) : '',
    scope: t.scope,
    scopeCategories: [...t.scopeCategories],
    scopeItems: [...t.scopeItems],
    exchangeTarget: t.exchangeTicketTypeId !== null ? 'ticket' : 'item',
    exchangeItemId: t.exchangeItemId,
    exchangeTicketTypeId: t.exchangeTicketTypeId,
    validity: t.validity,
    validFrom: t.validFrom ?? today,
    validTo: t.validTo ?? shiftDate(today, 29),
    validDays: t.validDays !== null ? String(t.validDays) : '30',
    levels: [...t.levels],
    note: t.note,
    active: copy ? true : t.active,
  };
}

/** 填写内容 → 提交的模板与第一个问题（null = 可以保存）；只留这个种类用得到的条件 */
function buildBody(d: Draft): { body: TemplateBody; problem: string | null } {
  const exchange = d.kind === 'exchange';
  const offLabel = exchange ? '最多抵' : '最多减';
  const faceValue = d.kind === 'cash' ? parseYuan(d.faceValue) : null;
  const ratePercent = d.kind === 'discount' ? parseRate(d.rate) : null;
  const maxOff = d.kind !== 'cash' && d.maxOff.trim() ? parseYuan(d.maxOff) : null;
  const threshold = exchange || !d.threshold.trim() ? 0 : parseYuan(d.threshold);
  const days = Number(d.validDays);
  const body: TemplateBody = {
    name: d.name.trim(),
    kind: d.kind,
    faceValue,
    ratePercent,
    maxOff,
    threshold: threshold ?? 0,
    scope: exchange ? 'all' : d.scope,
    scopeCategories: !exchange && d.scope === 'categories' ? d.scopeCategories : [],
    scopeItems: !exchange && d.scope === 'items' ? d.scopeItems : [],
    exchangeItemId: exchange && d.exchangeTarget === 'item' ? d.exchangeItemId : null,
    exchangeTicketTypeId: exchange && d.exchangeTarget === 'ticket' ? d.exchangeTicketTypeId : null,
    validity: d.validity,
    validFrom: d.validity === 'fixed' ? d.validFrom : null,
    validTo: d.validity === 'fixed' ? d.validTo : null,
    validDays: d.validity === 'days' ? days : null,
    levels: d.levels,
    note: d.note.trim(),
    active: d.active,
  };
  const problem = !body.name
    ? '请填写券的名称'
    : d.kind === 'cash' && (faceValue === null || faceValue <= 0)
      ? '请填写面额（最多两位小数）'
      : d.kind === 'cash' && faceValue! > MAX_OFF_CENTS
        ? '面额最多 10,000 元'
        : d.kind === 'discount' && ratePercent === null
          ? '几折请填 1 到 9.9（最多一位小数），例如 8.8'
          : d.kind !== 'cash' && d.maxOff.trim() && (maxOff === null || maxOff <= 0)
            ? `「${offLabel}」的金额不正确`
            : maxOff !== null && maxOff > MAX_OFF_CENTS
              ? `「${offLabel}」最多 10,000 元`
              : threshold === null
                ? '门槛金额不正确（最多两位小数）'
                : threshold > MAX_THRESHOLD_CENTS
                  ? '门槛过大'
                  : exchange && d.exchangeTarget === 'item' && d.exchangeItemId === null
                    ? '请选择兑换的项目'
                    : exchange && d.exchangeTarget === 'ticket' && d.exchangeTicketTypeId === null
                      ? '请选择兑换的票种'
                      : !exchange && d.scope === 'categories' && d.scopeCategories.length === 0
                        ? '请选择适用的部门'
                        : !exchange && d.scope === 'categories' && d.scopeCategories.length > 30
                          ? '指定部门最多选 30 个'
                          : !exchange && d.scope === 'items' && d.scopeItems.length === 0
                            ? '请选择适用的项目'
                            : !exchange && d.scope === 'items' && d.scopeItems.length > 100
                              ? '指定项目最多选 100 个'
                              : d.validity === 'fixed' && (!ISO_DATE.test(d.validFrom) || !ISO_DATE.test(d.validTo))
                                ? '请填写有效期的起止日期'
                                : d.validity === 'fixed' && d.validFrom > d.validTo
                                  ? '结束日期不能早于开始日期'
                                  : d.validity === 'days' && (!Number.isInteger(days) || days < 1 || days > 3650)
                                    ? '有效天数请填 1 到 3650'
                                    : null;
  return { body, problem };
}

/** 发过券的模板：条件原样带回（服务端比对，一项不同就拒绝），只改名称、备注、停用 */
const lockedBody = (t: CouponTemplate, d: Draft): TemplateBody => ({
  name: d.name.trim(),
  kind: t.kind,
  faceValue: t.faceValue,
  ratePercent: t.ratePercent,
  maxOff: t.maxOff,
  threshold: t.threshold,
  scope: t.scope,
  scopeCategories: t.scopeCategories,
  scopeItems: t.scopeItems,
  exchangeItemId: t.exchangeItemId,
  exchangeTicketTypeId: t.exchangeTicketTypeId,
  validity: t.validity,
  validFrom: t.validFrom,
  validTo: t.validTo,
  validDays: t.validDays,
  levels: t.levels,
  note: d.note.trim(),
  active: d.active,
});

function TemplateDialog({
  target,
  meta,
  templates,
  onClose,
  onCopy,
}: {
  target: TemplateTarget;
  meta: CouponMeta;
  templates: CouponTemplate[];
  onClose: () => void;
  onCopy: (t: CouponTemplate) => void;
}) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateCoupons();
  const [opened, setOpened] = useState<TemplateTarget>(null);
  /** 编辑时载入的那一版（提交时带它的版本号） */
  const [base, setBase] = useState<CouponTemplate | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(null, session.today));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (target !== opened) {
    setOpened(target);
    setBase(target?.mode === 'edit' ? target.template : null);
    setDraft(draftOf(target && target.mode !== 'new' ? target.template : null, session.today, target?.mode === 'copy'));
    setError(null);
  }
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const editing = target?.mode === 'edit' && base !== null;
  const locked = editing && base.issued > 0;
  // 列表里的最新一版：别人改过（版本号变了），或刚发出了券（条件锁定了），要先载入最新内容
  const fresh = editing ? templates.find((x) => x.id === base.id) : undefined;
  const nowLocked = editing && !!fresh && base.issued === 0 && fresh.issued > 0;
  const outdated = editing && !!fresh && (fresh.version !== base.version || nowLocked);
  const { body, problem } = locked ? { body: lockedBody(base, draft), problem: draft.name.trim() ? null : '请填写券的名称' } : buildBody(draft);
  const fixedPassed = !locked && draft.validity === 'fixed' && ISO_DATE.test(draft.validTo) && draft.validTo < session.today;

  const save = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      // 新建：发出前把操作编号与原请求存在本机并读回核对（存不了就不发），没收到结果时记录留着，刷新后也能查回、重提或作废；
      // 改模板带版本号，没收到结果再保存会因版本号对不上被拒绝，不会改两次
      const key = uuid();
      const saved =
        editing && base
          ? await api.put<CouponTemplate>(`/api/coupons/templates/${base.id}`, { ...body, expectedVersion: base.version })
          : await sendErpOp<CouponTemplate>({
              key,
              type: 'coupon_template',
              url: '/api/coupons/templates',
              body: { ...body, clientKey: key },
              summary: `券模板「${draft.name.trim()}」`,
              staffName: session.staff.displayName,
            });
      qc.setQueryData<CouponTemplate[]>(couponKeys.templates, (list) => list && (editing ? list.map((x) => (x.id === saved.id ? saved : x)) : [saved, ...list.filter((x) => x.id !== saved.id)]));
      void invalidate();
      toast({ tone: 'success', title: editing ? `已保存「${saved.name}」` : `已新建券模板「${saved.name}」`, body: saved.summary });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError && !editing) {
        // 新建没收到结果：记录在本机，到页面上方处理
        toast(pendingToast('新建券模板'));
        onClose();
      } else {
        // 改模板没收到结果：再保存时版本号对不上会被拒绝（不会改两次），载入最新内容核对即可
        setError(e instanceof UncertainError ? `${e.message}，不确定有没有保存上：载入最新内容核对后再改` : errorMessage(e));
      }
      void qc.invalidateQueries({ queryKey: couponKeys.templates });
    } finally {
      setBusy(false);
    }
  };

  const title = !target ? '' : target.mode === 'edit' ? '编辑券模板' : target.mode === 'copy' ? `按「${target.template.name}」另建券模板` : '新建券模板';
  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : onClose}
      width="max-w-2xl"
      title={title}
      description={editing && base ? `已发 ${base.issued} 张 · ${base.createdByName} ${formatDateTime(base.createdAt)} 建` : '金额按元填；有效期按营业日算'}
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[12.5px] text-ink-3" data-testid="coupon-template-problem">{problem}</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem || outdated} onClick={save} data-testid="coupon-template-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-5" data-testid="coupon-template-dialog">
        {outdated && fresh && (
          <Notice
            tone="warning"
            title={nowLocked ? '这个模板刚刚发出了券，条件不能再改' : '这个模板刚刚被别人改过'}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setBase(fresh);
                  setDraft(draftOf(fresh, session.today));
                  setError(null);
                }}
                data-testid="coupon-template-reload"
              >
                载入最新内容
              </Button>
            }
          >
            载入最新内容后再改；这里还没保存的修改会丢掉。
          </Notice>
        )}
        {locked && base && (
          <Notice
            tone="info"
            title={`已经发过 ${base.issued} 张券：只能改名称、备注、停用`}
            action={
              <Button size="sm" variant="secondary" icon={<CopyPlus className="size-4" />} onClick={() => onCopy(base)} data-testid="coupon-template-copy">
                按这个模板另建一个
              </Button>
            }
          >
            面额、折扣、门槛、范围、有效期、限定档级都不能改：已发的券始终按发券时的条件算。要改条件请另建模板，再把这个停用。
          </Notice>
        )}
        <Field label="名称" htmlFor="coupon-name" hint={`最多 ${MAX_NAME} 字，会员详情和结账时都显示，例如「洗浴代金券」「生日八八折」`}>
          <Input id="coupon-name" value={draft.name} maxLength={MAX_NAME} onChange={(e) => set({ name: e.target.value })} disabled={busy} data-autofocus data-testid="coupon-template-name" />
        </Field>
        {/* 发过券的模板：条件整块禁用（fieldset 默认最小宽度是内容宽度，手机上会撑出横向滚动，所以 min-w-0） */}
        <fieldset disabled={locked || busy} className="min-w-0 space-y-5">
          <TermsFields draft={draft} set={set} meta={meta} />
          <Field label="有效期" hint="按营业日算，过了最后一天自动失效">
            <Segmented<CouponValidity>
              ariaLabel="有效期"
              value={draft.validity}
              onChange={(v) => set({ validity: v })}
              options={[
                { value: 'days', label: <span data-testid="coupon-template-validity-days">发券后 N 天</span> },
                { value: 'fixed', label: <span data-testid="coupon-template-validity-fixed">固定日期</span> },
              ]}
            />
          </Field>
          {draft.validity === 'days' ? (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
              发券后
              <Input
                fullWidth={false}
                type="number"
                inputMode="numeric"
                min={1}
                max={3650}
                value={draft.validDays}
                onChange={(e) => set({ validDays: digits(e.target.value) })}
                className="num w-24"
                aria-label="有效天数"
                data-testid="coupon-template-days"
              />
              天内有效（发券当天算第 1 天）
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                <Input fullWidth={false} type="date" value={draft.validFrom} max={draft.validTo || undefined} onChange={(e) => set({ validFrom: e.target.value })} className="w-[160px]" aria-label="开始日期" data-testid="coupon-template-from" />
                至
                <Input fullWidth={false} type="date" value={draft.validTo} min={draft.validFrom || undefined} onChange={(e) => set({ validTo: e.target.value })} className="w-[160px]" aria-label="结束日期" data-testid="coupon-template-to" />
              </div>
              {fixedPassed && <p className="text-[12.5px] font-semibold text-ember">结束日期已经过了：这个模板发不出券（自动规则也会跳过）</p>}
            </div>
          )}
          <Field label="限定发放档级" hint="不选 = 不限。限定后只发给这些档级的会员（发出去以后档级变了照样能用）；无记名券不能用限定了档级的模板">
            <div className="flex flex-wrap gap-2">
              {[...new Set([...meta.levels.map((l) => l.level), ...draft.levels])]
                .sort((a, b) => a - b)
                .map((level) => (
                  <CheckChip
                    key={level}
                    checked={draft.levels.includes(level)}
                    onChange={(on) => set({ levels: on ? [...draft.levels, level].sort((a, b) => a - b) : draft.levels.filter((x) => x !== level) })}
                    testId={`coupon-template-level-${level}`}
                  >
                    {levelLabel(meta.levels, level)}
                  </CheckChip>
                ))}
            </div>
          </Field>
        </fieldset>
        <Field label="备注" htmlFor="coupon-note" hint="选填，只在后台显示，最多 200 字">
          <Textarea id="coupon-note" value={draft.note} maxLength={200} onChange={(e) => set({ note: e.target.value })} disabled={busy} data-testid="coupon-template-note" />
        </Field>
        {editing && (
          <Field label="状态" hint="停用后不能再发（自动规则也跳过）；已发的照常可用">
            <Segmented
              ariaLabel="模板状态"
              value={draft.active ? 'on' : 'off'}
              onChange={(v) => set({ active: v === 'on' })}
              options={[
                { value: 'on', label: <span data-testid="coupon-template-active-on">启用</span>, disabled: busy },
                { value: 'off', label: <span data-testid="coupon-template-active-off">停用</span>, disabled: busy },
              ]}
            />
          </Field>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 种类与条件：面额 / 几折 / 兑换什么，门槛，最多减（抵），适用范围 */
function TermsFields({ draft, set, meta }: { draft: Draft; set: (patch: Partial<Draft>) => void; meta: CouponMeta }) {
  const itemGroups = useMemo(() => {
    const map = new Map<string, CouponMeta['items']>();
    for (const i of meta.items) map.set(i.category, [...(map.get(i.category) ?? []), i]);
    return [...map];
  }, [meta.items]);
  const threshold = (
    <Field label="门槛" htmlFor="coupon-threshold" hint="适用的项目满多少可用；不填为不限">
      <MoneyInput id="coupon-threshold" value={draft.threshold} onChange={(e) => set({ threshold: e.target.value })} placeholder="不限" data-testid="coupon-template-threshold" />
    </Field>
  );
  const maxOff = (
    <Field
      label={draft.kind === 'exchange' ? '最多抵' : '最多减'}
      htmlFor="coupon-maxoff"
      hint={draft.kind === 'exchange' ? '不填为不限；例如门票只抵 12 小时档，就填那一档的价格' : '不填为不限'}
    >
      <MoneyInput id="coupon-maxoff" value={draft.maxOff} onChange={(e) => set({ maxOff: e.target.value })} placeholder="不限" data-testid="coupon-template-maxoff" />
    </Field>
  );
  return (
    <>
      <Field label="种类">
        <Segmented<CouponKind>
          ariaLabel="券的种类"
          value={draft.kind}
          onChange={(k) => set({ kind: k })}
          options={COUPON_KINDS.map((k) => ({ value: k, label: <span data-testid={`coupon-template-kind-${k}`}>{COUPON_KIND_LABELS[k]}</span> }))}
        />
      </Field>
      {draft.kind === 'cash' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="面额" htmlFor="coupon-face" hint="抵扣 = 面额与适用金额取小的，不找零">
            <MoneyInput id="coupon-face" value={draft.faceValue} onChange={(e) => set({ faceValue: e.target.value })} placeholder="0.00" data-testid="coupon-template-face" />
          </Field>
          {threshold}
        </div>
      )}
      {draft.kind === 'discount' && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="几折" htmlFor="coupon-rate" hint="1 到 9.9，例如 8.8">
            <div className="relative">
              <Input id="coupon-rate" inputMode="decimal" autoComplete="off" value={draft.rate} onChange={(e) => set({ rate: e.target.value })} placeholder="8.8" className="num pr-10 font-semibold" data-testid="coupon-template-rate" />
              <span className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-[14px] font-semibold text-ink-3">折</span>
            </div>
          </Field>
          {maxOff}
          {threshold}
        </div>
      )}
      {draft.kind === 'exchange' && (
        <>
          <Field label="兑换什么" hint="抵账单上这个项目（票种）单价最高的那一份；门票抵一位客人的门票金额（含跳档）">
            <Segmented
              ariaLabel="兑换价目项目还是门票"
              value={draft.exchangeTarget}
              onChange={(v) => set({ exchangeTarget: v })}
              options={[
                { value: 'item', label: <span data-testid="coupon-template-exchange-item-mode">价目项目</span> },
                { value: 'ticket', label: <span data-testid="coupon-template-exchange-ticket-mode">门票票种</span> },
              ]}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {draft.exchangeTarget === 'item' ? (
              <Field label="项目" htmlFor="coupon-exchange-item">
                <Select
                  id="coupon-exchange-item"
                  value={draft.exchangeItemId ?? ''}
                  onChange={(e) => set({ exchangeItemId: e.target.value ? Number(e.target.value) : null })}
                  className="h-11"
                  data-testid="coupon-template-exchange-item"
                >
                  <option value="">选择项目</option>
                  {itemGroups.map(([category, items]) => (
                    <optgroup key={category} label={category}>
                      {items.map((i) => (
                        <option key={i.id} value={i.id} disabled={!i.active && i.id !== draft.exchangeItemId}>
                          {i.name}
                          {i.active ? '' : '（已停用）'}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="票种" htmlFor="coupon-exchange-ticket">
                <Select
                  id="coupon-exchange-ticket"
                  value={draft.exchangeTicketTypeId ?? ''}
                  onChange={(e) => set({ exchangeTicketTypeId: e.target.value ? Number(e.target.value) : null })}
                  className="h-11"
                  data-testid="coupon-template-exchange-ticket"
                >
                  <option value="">选择票种</option>
                  {meta.ticketTypes.map((t) => (
                    <option key={t.id} value={t.id} disabled={!t.active && t.id !== draft.exchangeTicketTypeId}>
                      {t.name}
                      {t.active ? '' : '（已停用）'}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {maxOff}
          </div>
        </>
      )}
      {draft.kind !== 'exchange' && (
        <>
          <Field label="适用范围" hint="门槛与抵扣都只按适用的明细算；储值充值、押金不是账单明细，用不了券">
            <Segmented<CouponScope>
              ariaLabel="适用范围"
              value={draft.scope}
              onChange={(s) => set({ scope: s })}
              options={COUPON_SCOPES.map((s) => ({ value: s, label: <span data-testid={`coupon-template-scope-${s}`}>{COUPON_SCOPE_LABELS[s]}</span> }))}
            />
          </Field>
          {draft.scope === 'categories' && (
            <div className="flex flex-wrap gap-2" data-testid="coupon-template-categories">
              {[...new Set([...meta.categories, ...draft.scopeCategories])].map((c) => (
                <CheckChip
                  key={c}
                  checked={draft.scopeCategories.includes(c)}
                  onChange={(on) => set({ scopeCategories: on ? [...draft.scopeCategories, c] : draft.scopeCategories.filter((x) => x !== c) })}
                  testId={`coupon-template-category-${c}`}
                >
                  {c}
                </CheckChip>
              ))}
            </div>
          )}
          {draft.scope === 'items' && <ItemPicker items={meta.items} value={draft.scopeItems} onChange={(v) => set({ scopeItems: v })} />}
        </>
      )}
    </>
  );
}

/** 指定项目：按分类列出，可以搜；停用的项目只在已选时列出 */
function ItemPicker({ items, value, onChange }: { items: CouponMeta['items']; value: number[]; onChange: (v: number[]) => void }) {
  const [q, setQ] = useState('');
  const selected = new Set(value);
  const term = q.trim().toLowerCase();
  const byCategory = new Map<string, CouponMeta['items']>();
  for (const i of items) {
    if (!i.active && !selected.has(i.id)) continue;
    if (term && !i.name.toLowerCase().includes(term) && !i.category.toLowerCase().includes(term)) continue;
    byCategory.set(i.category, [...(byCategory.get(i.category) ?? []), i]);
  }
  const groups = [...byCategory];
  return (
    <div className="overflow-hidden rounded-lg border border-line" data-testid="coupon-template-items">
      <div className="flex flex-wrap items-center gap-2 border-b border-line/70 bg-paper-2/50 px-3 py-2">
        <div className="relative min-w-0 flex-1 basis-40">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜项目或分类" className="pl-9 text-[13px]" aria-label="搜索项目" data-testid="coupon-template-item-search" />
        </div>
        <span className="text-[12.5px] text-ink-3">已选 {value.length} 个</span>
        {value.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onChange([])}>
            清空
          </Button>
        )}
      </div>
      <div className="scroll-thin max-h-64 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="px-3 py-4 text-center text-[13px] text-ink-3">{items.length === 0 ? '价目表里还没有项目' : '没有找到项目'}</p>
        ) : (
          groups.map(([category, list]) => (
            <div key={category}>
              <p className="sticky top-0 z-[1] bg-paper-2 px-3 py-1 text-[12px] font-bold text-ink-3">{category}</p>
              <ul>
                {list.map((i) => (
                  <li key={i.id}>
                    <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-paper-2/60">
                      <input
                        type="checkbox"
                        className="size-4 accent-pine"
                        checked={selected.has(i.id)}
                        onChange={(e) => onChange(e.target.checked ? [...value, i.id] : value.filter((x) => x !== i.id))}
                        data-testid={`coupon-template-item-${i.id}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13.5px]">{i.name}</span>
                      {!i.active && <Badge>已停用</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ───────────────────────── 发券规则 ─────────────────────────

const RULE_HINTS: Record<CouponRuleKind, string> = {
  open_card: '会员建档时发（期初导入的会员不发）',
  level_up: '某次充值让会员升到这一档时发（连跳几档的每一档都发）；每位会员每条规则只发一次（降档后再升不再发），上线定档、期初导入不发',
  birthday: '会员生日当月发，每年每条规则一次，按发券时的档级；没填生日的不发',
  recharge: '用这个套餐充值时在同一笔里发，与赠金并存、互不替代；充值页选套餐时显示「另赠」',
};
const needsLevel = (kind: CouponRuleKind) => kind === 'level_up' || kind === 'birthday';

function RulesCard() {
  const rules = useCouponRules();
  const meta = useCouponMeta();
  const templates = useCouponTemplates();
  // 上一次加规则的结果待确认时先处理那一笔：再加一条可能多出一条规则、重复发券
  const pendingAdd = useErpPending(['coupon_rule']).length > 0;
  const [adding, setAdding] = useState(false);
  const [stopping, setStopping] = useState<CouponRule | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const failed = rules.error ?? meta.error ?? templates.error;
  if (failed) return <Notice tone="error" title={errorMessage(failed)} />;
  if (!rules.data || !meta.data || !templates.data) return <Skeleton className="h-64" />;
  const levels = meta.data.levels;
  const all = rules.data;
  const inactiveCount = all.filter((r) => !r.active).length;
  const targetText = (r: CouponRule) => (needsLevel(r.kind) ? levelLabel(levels, r.level ?? 0) : r.kind === 'recharge' ? (r.planName ?? '充值套餐') : null);
  // 同一种类里：升级礼、生日礼按档级，充值赠券按套餐排在一起；启用的在前
  const order = (a: CouponRule, b: CouponRule) =>
    (a.level ?? 0) - (b.level ?? 0) || (a.planId ?? 0) - (b.planId ?? 0) || Number(b.active) - Number(a.active) || a.id - b.id;
  return (
    <Card className="space-y-4 p-5" data-testid="coupon-rules">
      <div>
        <SectionTitle
          aside={
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="size-4" />}
              disabled={pendingAdd}
              title={pendingAdd ? '上一次加规则的结果待确认：先在页面上方查回、重提或作废' : undefined}
              onClick={() => setAdding(true)}
              data-testid="coupon-rule-new"
            >
              加一条规则
            </Button>
          }
        >
          <span className="inline-flex items-center gap-2">
            发券规则 <PendingBadge title="开卡礼、升级礼、生日礼的时点与充值赠券按常见的会员营销做法定，待店主确认" />
          </span>
        </SectionTitle>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
          一条规则 = 种类 + 档级（或充值套餐）+ 券 + 张数，同一档级可以配几条。<b className="font-semibold text-ink-2">规则不能改</b>
          ：要换券或张数，先停用这条，再加一条新的（以发券时的规则为准）。模板停用或固定有效期已过时自动跳过；限定了档级的模板只发给对应档级的会员。
        </p>
      </div>
      {COUPON_RULE_KINDS.map((kind) => {
        const list = all.filter((r) => r.kind === kind && (showInactive || r.active)).sort(order);
        return (
          <section key={kind} className="overflow-hidden rounded-lg border border-line" data-testid={`coupon-rule-group-${kind}`}>
            <header className="border-b border-line/70 bg-paper-2/60 px-3 py-2">
              <p className="text-[13.5px] font-bold text-ink">{COUPON_RULE_KIND_LABELS[kind]}</p>
              <p className="text-[12px] text-ink-3">{RULE_HINTS[kind]}</p>
            </header>
            {list.length === 0 ? (
              <p className="px-3 py-3 text-[13px] text-ink-3">还没有{COUPON_RULE_KIND_LABELS[kind]}规则</p>
            ) : (
              <ul className="divide-y divide-line/70">
                {list.map((r) => (
                  <RuleRow key={r.id} r={r} target={targetText(r)} onStop={() => setStopping(r)} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {inactiveCount > 0 && (
        <button type="button" className="text-[12.5px] font-semibold text-pine hover:underline" onClick={() => setShowInactive(!showInactive)} data-testid="coupon-rule-show-inactive">
          {showInactive ? '收起已停用的规则' : `显示已停用的 ${inactiveCount} 条规则`}
        </button>
      )}
      <RuleDialog open={adding} meta={meta.data} templates={templates.data} rules={all} onClose={() => setAdding(false)} />
      <StopRuleDialog rule={stopping} target={stopping ? targetText(stopping) : null} onClose={() => setStopping(null)} />
    </Card>
  );
}

function RuleRow({ r, target, onStop }: { r: CouponRule; target: string | null; onStop: () => void }) {
  return (
    <li className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', !r.active && 'bg-paper-2/50 text-ink-3')} data-testid={`coupon-rule-${r.id}`}>
      {target && <span className="min-w-[96px] text-[13px] font-semibold text-ink-2">{target}</span>}
      <span className="min-w-0 flex-1 basis-[160px] text-[13.5px]">
        <b className={cn('font-semibold', r.active ? 'text-ink' : 'text-ink-3')}>{r.templateName}</b> × {r.quantity} 张
        {r.active && !r.templateActive && (
          <Badge tone="ember" className="ml-1.5">
            模板已停用，暂不发
          </Badge>
        )}
      </span>
      <span className="text-[12px] whitespace-nowrap text-ink-3">已发 {r.issuedTimes} 次</span>
      {r.active ? (
        <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} onClick={onStop} data-testid={`coupon-rule-stop-${r.id}`}>
          停用
        </Button>
      ) : (
        <span className="text-[12px] text-ink-3">
          已停用{r.deactivatedAt ? ` · ${r.deactivatedByName ?? ''} ${formatDateTime(r.deactivatedAt)}` : ''}
        </span>
      )}
    </li>
  );
}

function RuleDialog({ open, meta, templates, rules, onClose }: { open: boolean; meta: CouponMeta; templates: CouponTemplate[]; rules: CouponRule[]; onClose: () => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateCoupons();
  const [kind, setKind] = useState<CouponRuleKind>('open_card');
  const [level, setLevel] = useState<number | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setKind('open_card');
    setLevel(null);
    setPlanId(null);
    setTemplateId(null);
    setQuantity('1');
    setError(null);
  });
  const leveled = needsLevel(kind);
  /** 这张模板为什么不能配：限定的档级里没有选的这一档、固定有效期已过 */
  const blocked = (t: CouponTemplate) =>
    leveled && level !== null && t.levels.length > 0 && !t.levels.includes(level)
      ? `只发给 ${t.levels.map((l) => `L${l}`).join('、')}`
      : templateExpired(t, session.today)
        ? '有效期已过'
        : null;
  const choices = templates.filter((t) => t.active);
  const template = choices.find((t) => t.id === templateId) ?? null;
  const n = Number(quantity);
  const same = rules.filter((r) => r.active && r.kind === kind && (leveled ? r.level === level : kind === 'recharge' ? r.planId === planId : true));
  const problem =
    leveled && level === null
      ? '请选择会员档级'
      : kind === 'recharge' && planId === null
        ? '请选择充值套餐'
        : !template
          ? '请选择券'
          : blocked(template)
            ? `「${template.name}」${blocked(template)}，不能配在这里`
            : !Number.isInteger(n) || n < 1 || n > MAX_MANUAL_COUPONS
              ? `张数请填 1 到 ${MAX_MANUAL_COUPONS}`
              : null;

  const save = async () => {
    if (problem || !template) return;
    setBusy(true);
    setError(null);
    // 发出前把操作编号与原请求存在本机并读回核对（存不了就不发）：没收到结果时关掉对话框、刷新、重新登录后，
    // 在页面上方查回、按原内容重新提交（同一编号，不会多出一条规则、重复发券）或确认作废（Codex 复审 6c3765c）
    const key = uuid();
    const target = leveled ? levelLabel(meta.levels, level ?? 0) : kind === 'recharge' ? (meta.plans.find((p) => p.id === planId)?.name ?? '充值套餐') : '';
    try {
      const next = await sendErpOp<{ ruleId: number; rules: CouponRule[] }>({
        key,
        type: 'coupon_rule',
        url: '/api/coupons/rules',
        body: { clientKey: key, kind, level: leveled ? level : null, planId: kind === 'recharge' ? planId : null, templateId: template.id, quantity: n },
        summary: `${COUPON_RULE_KIND_LABELS[kind]}${target ? ` · ${target}` : ''}：${template.name} × ${n}`,
        staffName: session.staff.displayName,
      });
      qc.setQueryData(couponKeys.rules, next.rules);
      void invalidate();
      toast({ tone: 'success', title: `已加上${COUPON_RULE_KIND_LABELS[kind]}：${template.name} × ${n}` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast(pendingToast('加发券规则'));
        onClose();
      } else {
        setError(errorMessage(e));
      }
      void qc.invalidateQueries({ queryKey: couponKeys.rules });
      if (e instanceof ApiError && ['TEMPLATE_INACTIVE', 'COUPON_LEVEL'].includes(e.code)) void qc.invalidateQueries({ queryKey: couponKeys.templates });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="加一条发券规则"
      description="规则加上以后不能改，只能停用后另加"
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[12.5px] text-ink-3">{problem}</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={save} data-testid="coupon-rule-save">
            加上
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="coupon-rule-dialog">
        <Field label="种类" hint={RULE_HINTS[kind]}>
          <Segmented<CouponRuleKind>
            ariaLabel="规则的种类"
            value={kind}
            onChange={(k) => {
              setKind(k);
              setTemplateId(null);
            }}
            className="max-w-full flex-wrap"
            options={COUPON_RULE_KINDS.map((k) => ({ value: k, label: <span data-testid={`coupon-rule-kind-${k}`}>{COUPON_RULE_KIND_LABELS[k]}</span>, disabled: busy }))}
          />
        </Field>
        {leveled && (
          <Field label="会员档级" htmlFor="coupon-rule-level" hint={kind === 'level_up' ? '充值升到这一档时发（连跳几档的每一档都发）' : '生日当月按会员当时的档级发'}>
            <Select id="coupon-rule-level" value={level ?? ''} onChange={(e) => setLevel(e.target.value ? Number(e.target.value) : null)} disabled={busy} className="h-11" data-testid="coupon-rule-level">
              <option value="">选择档级</option>
              {meta.levels.filter((l) => kind !== 'level_up' || l.level > 0).map((l) => (
                <option key={l.level} value={l.level}>
                  {levelLabel(meta.levels, l.level)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === 'recharge' && (
          <Field label="充值套餐" htmlFor="coupon-rule-plan" hint="自定义金额的充值不发；套餐在「价目与套餐」里维护">
            <Select id="coupon-rule-plan" value={planId ?? ''} onChange={(e) => setPlanId(e.target.value ? Number(e.target.value) : null)} disabled={busy} className="h-11" data-testid="coupon-rule-plan">
              <option value="">选择充值套餐</option>
              {meta.plans.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.active}>
                  {p.name} · 实收 {formatYuan(p.payAmount)}
                  {p.bonusAmount ? ` 送 ${formatYuan(p.bonusAmount)}` : ''}
                  {p.active ? '' : '（已停用）'}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="发哪张券" htmlFor="coupon-rule-template" hint={choices.length === 0 ? '还没有启用的券模板，先在「券模板」里建一个' : undefined}>
          <Select id="coupon-rule-template" value={templateId ?? ''} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)} disabled={busy} className="h-11" data-testid="coupon-rule-template">
            <option value="">选择券模板</option>
            {choices.map((t) => {
              const why = blocked(t);
              return (
                <option key={t.id} value={t.id} disabled={!!why}>
                  {t.name} · {t.summary}
                  {why ? `（${why}）` : ''}
                </option>
              );
            })}
          </Select>
        </Field>
        {template && (
          <p className="rounded-md bg-paper-2 px-3 py-2 text-[12.5px] text-ink-2">
            {template.summary} · {templateValidityText(template)} · {levelsText(meta.levels, template.levels)}
          </p>
        )}
        <Field label="张数" htmlFor="coupon-rule-quantity" hint={`每次发几张，1–${MAX_MANUAL_COUPONS}`}>
          <Input
            id="coupon-rule-quantity"
            fullWidth={false}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_MANUAL_COUPONS}
            value={quantity}
            onChange={(e) => setQuantity(digits(e.target.value))}
            disabled={busy}
            className="num w-28"
            data-testid="coupon-rule-quantity"
          />
        </Field>
        {same.length > 0 && (
          <p className="text-[12.5px] text-ink-3" data-testid="coupon-rule-existing">
            这里已有：{same.map((r) => `${r.templateName} × ${r.quantity}`).join('、')}（加上后一起发）
          </p>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function StopRuleDialog({ rule, target, onClose }: { rule: CouponRule | null; target: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateCoupons();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(!!rule, () => setError(null));
  const stop = async () => {
    if (!rule) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<CouponRule[]>(`/api/coupons/rules/${rule.id}/deactivate`, {});
      qc.setQueryData(couponKeys.rules, next);
      void invalidate();
      toast({ tone: 'success', title: '发券规则已停用', body: '已经发出的券照常可用' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: couponKeys.rules });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!rule}
      onClose={busy ? () => {} : onClose}
      title="停用这条发券规则？"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" loading={busy} onClick={stop} data-testid="coupon-rule-stop-confirm">
            停用
          </Button>
        </>
      }
    >
      {rule && (
        <div className="space-y-3 text-[13.5px]">
          <p className="rounded-md bg-paper-2 px-3 py-2">
            <b>{COUPON_RULE_KIND_LABELS[rule.kind]}</b>
            {target ? ` · ${target}` : ''} · {rule.templateName} × {rule.quantity} 张
          </p>
          <p className="text-ink-2">停用后不再自动发；已经发出的券照常可用。规则停用后不能再启用，要恢复请另加一条。</p>
          {error && <Notice tone="error" title={error} />}
        </div>
      )}
    </Dialog>
  );
}

// ───────────────────────── 无记名券 ─────────────────────────

/** 「导出券码」是普通的下载链接，样子与小号的次要按钮一致 */
const LINK_BUTTON =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border border-line-strong bg-card px-3 text-[13px] font-semibold whitespace-nowrap text-ink transition-colors hover:border-ink-3 hover:bg-paper';

/** 还没用的（含未生效、已过期）：按批次作废的就是这些 */
const unusedOf = (b: CouponBatch) => b.counts.available + b.counts.pending + b.counts.expired;

function BatchesCard() {
  const can = useCan();
  const batches = useCouponBatches();
  const templates = useCouponTemplates();
  // 上一次生成的结果待确认时先处理那一笔，免得多生成一批
  const pendingNew = useErpPending(['coupon_batch']).length > 0;
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<CouponBatch | null>(null);
  const failed = batches.error ?? templates.error;
  if (failed) return <Notice tone="error" title={errorMessage(failed)} />;
  if (!batches.data || !templates.data) return <Skeleton className="h-64" />;
  const canVoid = can('coupon.void');
  return (
    <Card className="p-5" data-testid="coupon-batches">
      <SectionTitle
        aside={
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-4" />}
            disabled={pendingNew}
            title={pendingNew ? '上一次生成的结果待确认：先在页面上方查回、重提或作废' : undefined}
            onClick={() => setCreating(true)}
            data-testid="coupon-batch-new"
          >
            生成一批
          </Button>
        }
      >
        <span className="inline-flex items-center gap-2">
          无记名券 <PendingBadge title="无记名纸质券的做法（一批张数、券码、按批作废）是默认做法，待店主确认" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
        按模板生成一批纸质券的券码（一批 1–{MAX_BATCH_COUPONS} 张；券码 12 位，去掉易混的 0、O、1、I），导出清单交印刷。结账时在收款里输入券码使用，一码一次；没用的可以按批次作废
        {canVoid ? '' : '（要「作废券」权限）'}。限定了会员档级的模板不能用。
      </p>
      {batches.data.length === 0 ? (
        <p className={EMPTY_BOX}>还没有生成过无记名券。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {batches.data.map((b) => (
            <BatchRow key={b.id} b={b} canVoid={canVoid} onVoid={() => setVoiding(b)} />
          ))}
        </ul>
      )}
      {batches.data.length >= 100 && <p className="mt-2 text-[12px] text-ink-3">只列最近 100 批</p>}
      <BatchDialog open={creating} templates={templates.data} onClose={() => setCreating(false)} />
      <VoidBatchDialog batch={voiding} onClose={() => setVoiding(null)} />
    </Card>
  );
}

function BatchRow({ b, canVoid, onVoid }: { b: CouponBatch; canVoid: boolean; onVoid: () => void }) {
  const unused = unusedOf(b);
  return (
    <li className="space-y-1.5 px-3 py-3" data-testid={`coupon-batch-${b.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="num text-[14px] font-bold text-ink">{b.issueNo}</span>
        <span className="text-[14px] font-semibold break-all text-ink">{b.templateName}</span>
        <span className="min-w-0 text-[12.5px] text-ink-3">{b.summary}</span>
      </div>
      <p className="text-[12.5px] text-ink-2">
        共 {b.quantity} 张 · 有效期 {couponRangeText(b.validFrom, b.validTo)} · {formatDateTime(b.issuedAt)} {b.issuedByName ?? ''} 生成
        {b.note && <span className="break-all text-ink-3"> · {b.note}</span>}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {COUPON_STATE_ORDER.filter((s) => b.counts[s] > 0).map((s) => (
          <Badge key={s} tone={COUPON_STATE_TONES[s]}>
            {COUPON_STATE_LABELS[s]} {b.counts[s]}
          </Badge>
        ))}
        <span className="flex-1" />
        <a href={`/api/coupons/batches/${b.id}/codes.csv`} download className={LINK_BUTTON} data-testid={`coupon-batch-export-${b.id}`}>
          <Download className="size-4" />
          导出券码
        </a>
        {canVoid && (
          <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} disabled={unused === 0} onClick={onVoid} data-testid={`coupon-batch-void-${b.id}`}>
            作废没用的
          </Button>
        )}
      </div>
    </li>
  );
}

function BatchDialog({ open, templates, onClose }: { open: boolean; templates: CouponTemplate[]; onClose: () => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateCoupons();
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setTemplateId(null);
    setQuantity('');
    setNote('');
    setError(null);
  });
  const blocked = (t: CouponTemplate) => (t.levels.length ? '限定了会员档级' : templateExpired(t, session.today) ? '有效期已过' : null);
  const choices = templates.filter((t) => t.active);
  const template = choices.find((t) => t.id === templateId) ?? null;
  const n = Number(quantity);
  const problem = !template
    ? '请选择券'
    : blocked(template)
      ? `「${template.name}」${blocked(template)}，不能生成无记名券`
      : !quantity || !Number.isInteger(n) || n < 1 || n > MAX_BATCH_COUPONS
        ? `张数请填 1 到 ${MAX_BATCH_COUPONS}`
        : null;

  const submit = async () => {
    if (problem || !template) return;
    setBusy(true);
    setError(null);
    // 发出前把操作编号与原请求存在本机并读回核对（存不了就不发）：没收到结果时到页面上方查回、按原内容重新提交（不会多生成一批）或作废
    const key = uuid();
    try {
      const batch = await sendErpOp<CouponBatch>({
        key,
        type: 'coupon_batch',
        url: '/api/coupons/batches',
        body: { clientKey: key, templateId: template.id, quantity: n, note: note.trim() },
        summary: `${template.name} × ${n} 张`,
        staffName: session.staff.displayName,
      });
      qc.setQueryData<CouponBatch[]>(couponKeys.batches, (list) => list && [batch, ...list.filter((b) => b.id !== batch.id)]);
      void invalidate();
      toast({ tone: 'success', title: `已生成 ${batch.quantity} 张「${batch.templateName}」`, body: `批次 ${batch.issueNo}：点「导出券码」交印刷` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast(pendingToast('生成无记名券'));
        onClose();
      } else {
        setError(errorMessage(e));
        if (e instanceof ApiError && ['TEMPLATE_INACTIVE', 'TEMPLATE_EXPIRED', 'COUPON_LEVEL'].includes(e.code)) void qc.invalidateQueries({ queryKey: couponKeys.templates });
      }
      void qc.invalidateQueries({ queryKey: couponKeys.batches });
    } finally {
      setBusy(false);
    }
  };

  const days = template?.validity === 'days' ? (template.validDays ?? 1) : null;
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="生成一批无记名券"
      description="生成后在列表里导出券码交印刷；结账时输入券码使用，一码一次"
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[12.5px] text-ink-3">{problem}</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={submit} data-testid="coupon-batch-submit">
            {n >= 1 && n <= MAX_BATCH_COUPONS ? `生成 ${n} 张` : '生成'}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="coupon-batch-dialog">
        <Field label="券" htmlFor="coupon-batch-template" hint={choices.length === 0 ? '还没有启用的券模板，先在「券模板」里建一个' : '限定了会员档级的模板不能做无记名券'}>
          <Select id="coupon-batch-template" value={templateId ?? ''} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)} disabled={busy} className="h-11" data-testid="coupon-batch-template">
            <option value="">选择券模板</option>
            {choices.map((t) => {
              const why = blocked(t);
              return (
                <option key={t.id} value={t.id} disabled={!!why}>
                  {t.name} · {t.summary}
                  {why ? `（${why}）` : ''}
                </option>
              );
            })}
          </Select>
        </Field>
        {template && (
          <p className="rounded-md bg-paper-2 px-3 py-2 text-[12.5px] text-ink-2">
            {template.summary} ·{' '}
            {days !== null ? `今天生成：有效期 ${couponRangeText(session.today, shiftDate(session.today, days - 1))}` : templateValidityText(template)}
          </p>
        )}
        <Field label="张数" htmlFor="coupon-batch-quantity" hint={`一批 1–${MAX_BATCH_COUPONS} 张`}>
          <Input
            id="coupon-batch-quantity"
            fullWidth={false}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_BATCH_COUPONS}
            value={quantity}
            onChange={(e) => setQuantity(digits(e.target.value))}
            disabled={busy}
            className="num w-32"
            data-testid="coupon-batch-quantity"
          />
        </Field>
        <Field label="备注" htmlFor="coupon-batch-note" hint="选填，例如用途、印刷批次，最多 200 字">
          <Textarea id="coupon-batch-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} disabled={busy} data-testid="coupon-batch-note" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function VoidBatchDialog({ batch, onClose }: { batch: CouponBatch | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateCoupons();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(!!batch, () => setError(null));
  const unused = batch ? unusedOf(batch) : 0;
  const confirm = async (reason: string) => {
    if (!batch) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<CouponBatch>(`/api/coupons/batches/${batch.id}/void`, { reason });
      qc.setQueryData<CouponBatch[]>(couponKeys.batches, (list) => list?.map((b) => (b.id === next.id ? next : b)));
      void invalidate();
      const voided = next.counts.voided - batch.counts.voided;
      toast({ tone: 'success', title: voided > 0 ? `已作废 ${voided} 张没用的券` : '已作废没用的券', body: `批次 ${next.issueNo}；已用的不受影响` });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: couponKeys.batches });
    } finally {
      setBusy(false);
    }
  };
  return (
    <ReasonDialog
      open={!!batch}
      title={batch ? `作废批次 ${batch.issueNo} 里没用的券` : ''}
      description={batch ? `「${batch.templateName}」还没用的 ${unused} 张（含已过期的）作废后，结账时不能再用；已用的不受影响。` : undefined}
      label="作废原因"
      confirmLabel={`作废 ${unused} 张`}
      danger
      busy={busy}
      testId="coupon-batch-void"
      extra={error && <Notice tone="error" title={error} className="mt-3" />}
      onClose={busy ? () => {} : onClose}
      onConfirm={(reason) => void confirm(reason)}
    />
  );
}

// ───────────────────────── 统计 ─────────────────────────

function StatsCard() {
  const session = useSession();
  const [range, setRange] = useState({ from: session.today, to: session.today });
  const valid = ISO_DATE.test(range.from) && ISO_DATE.test(range.to) && range.from <= range.to;
  const stats = useCouponStats(range.from, range.to, valid);
  const monthStart = `${session.today.slice(0, 8)}01`;
  const d = stats.data;
  const quick = (from: string, label: string, testId: string) => {
    const on = range.from === from && range.to === session.today;
    return (
      <Button size="sm" variant={on ? 'quiet' : 'ghost'} onClick={() => setRange({ from, to: session.today })} aria-pressed={on} data-testid={testId}>
        {label}
      </Button>
    );
  };
  return (
    <Card className="space-y-4 p-5" data-testid="coupon-stats">
      <SectionTitle>统计</SectionTitle>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
          从
          <Input type="date" fullWidth={false} value={range.from} max={range.to || session.today} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="w-40" data-testid="coupon-stats-from" />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
          到
          <Input type="date" fullWidth={false} value={range.to} min={range.from || undefined} max={session.today} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="w-40" data-testid="coupon-stats-to" />
        </label>
        <div className="flex gap-1.5">
          {quick(session.today, '今天', 'coupon-stats-today')}
          {quick(monthStart, '本月', 'coupon-stats-month')}
        </div>
      </div>
      {!valid ? (
        <Notice tone="error" title="请填写正确的日期，开始日期不能晚于结束日期" />
      ) : stats.error ? (
        <Notice tone="error" title={errorMessage(stats.error)} />
      ) : !d ? (
        <Skeleton className="h-40" />
      ) : d.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3" data-testid="coupon-stats-empty">
          {d.from === d.to ? d.from : `${d.from} 至 ${d.to}`} 没有发券、用券、过期或作废
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[600px] text-[13px]" data-testid="coupon-stats-table">
            <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left">券</th>
                <th className="px-3 py-2 text-right">发券（张）</th>
                <th className="px-3 py-2 text-right">用券（张）</th>
                <th className="px-3 py-2 text-right">抵扣金额</th>
                <th className="px-3 py-2 text-right">过期（张）</th>
                <th className="px-3 py-2 text-right">作废（张）</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {d.rows.map((r) => (
                <tr key={r.templateId} data-testid={`coupon-stats-row-${r.templateId}`}>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-ink">{r.name}</span> <span className="text-[12px] text-ink-3">{COUPON_KIND_LABELS[r.kind]}</span>
                  </td>
                  <td className="num px-3 py-2 text-right">{r.issued}</td>
                  <td className="num px-3 py-2 text-right">{r.used}</td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={r.usedAmount} />
                  </td>
                  <td className="num px-3 py-2 text-right">{r.expired}</td>
                  <td className="num px-3 py-2 text-right">{r.voided}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-line bg-paper-2/40 font-bold" data-testid="coupon-stats-totals">
              <tr>
                <td className="px-3 py-2">合计</td>
                <td className="num px-3 py-2 text-right">{d.totals.issued}</td>
                <td className="num px-3 py-2 text-right">{d.totals.used}</td>
                <td className="px-3 py-2 text-right">
                  <Money cents={d.totals.usedAmount} />
                </td>
                <td className="num px-3 py-2 text-right">{d.totals.expired}</td>
                <td className="num px-3 py-2 text-right">{d.totals.voided}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-[12px] leading-relaxed text-ink-3">
        按营业日：发券按发券的那一天；用券按结账的那一天，反结账退回的冲减（张数与金额）；过期是有效期最后一天在这段时间里、到今天还没用的；作废按作废的那一天。
      </p>
    </Card>
  );
}
