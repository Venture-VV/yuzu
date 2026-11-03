// 后台「会员权益」（会员体系 v2 第二期，v0.7.24；docs/BENEFITS.md）：本店权益清单按类别分组，每项一行——
// 编号、名称、配置起点、数量与周期、发哪张券、状态、本月发了多少；一键导入清单；逐项编辑（带版本号）、发布、暂缓。
// 券类发布后每月（每年）自动发、月中升档当场补发；事件礼按事件自动发；服务类列在会员详情「本月可享」、登记使用数次数。
// 折扣类（v0.7.25）：设打哪些明细、起点与各档阶的折扣（付几成）、每周几 / 每月几号，发布后手牌结账时自动算。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, PauseCircle, PencilLine, Plus, Search, Send, Trash2, TriangleAlert } from 'lucide-react';
import {
  BENEFIT_CATEGORIES,
  BENEFIT_CATEGORY_HINTS,
  BENEFIT_CATEGORY_LABELS,
  BENEFIT_EVENT_LABELS,
  BENEFIT_EVENTS,
  BENEFIT_PERIOD_LABELS,
  BENEFIT_STATUS_LABELS,
  DISCOUNT_TARGET_LABELS,
  DISCOUNT_TARGETS,
  discountDaysText,
  MAX_BENEFIT_COUPONS,
  MAX_BENEFIT_LIMIT,
  MAX_DISCOUNT_RATE,
  MIN_DISCOUNT_RATE,
  quantityText,
  rateText,
  WEEKDAY_LABELS,
  startLabel,
  stateRank,
  type Benefit,
  type BenefitCatalog,
  type BenefitCategory,
  type BenefitEvent,
  type BenefitPeriod,
  type BenefitStatus,
  type DiscountTarget,
  type TierQuantity,
} from '@shared/benefits';
import { GRADE_STATES, type Grade, type Tier } from '@shared/membership';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { benefitKeys } from './queries';

export function BenefitsSection() {
  return (
    <AdminPage
      section="benefits"
      wide
      description="本店权益清单（会员文档附录三 A 与补充项）：逐项设好配置起点、数量与券，发布后券类每月自动发、事件礼按事件自动发，服务类列在会员详情「本月可享」。改了只影响以后，已经发出的券、登记的使用不变。"
    >
      <BenefitsEditor />
    </AdminPage>
  );
}

const STATUS_TONE: Record<BenefitStatus, 'pine' | 'neutral' | 'ember'> = { published: 'pine', draft: 'neutral', paused: 'ember' };

/** 19 个状态的选项值：「0」= L0，「2-1」= L2·享 */
const stateValue = (grade: number, tier: number | null) => (grade === 0 ? '0' : `${grade}-${tier ?? 0}`);
const parseState = (v: string): { grade: Grade; tier: Tier | null } => {
  if (v === '0') return { grade: 0, tier: null };
  const [g, t] = v.split('-').map(Number);
  return { grade: g as Grade, tier: t as Tier };
};
const STATE_OPTIONS = GRADE_STATES.map((s) => ({ value: stateValue(s.grade, s.tier), label: startLabel(s.grade, s.tier) }));

function BenefitsEditor() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: benefitKeys.catalog, queryFn: () => api.get<BenefitCatalog>('/api/benefits') });
  const [status, setStatus] = useState<'all' | BenefitStatus>('all');
  const [keyword, setKeyword] = useState('');
  const [editing, setEditing] = useState<Benefit | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const d = q.data;
  const shown = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return (d?.items ?? []).filter((b) => (status === 'all' || b.status === status) && (!k || b.code.toLowerCase().includes(k) || b.name.toLowerCase().includes(k)));
  }, [d, status, keyword]);
  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.error || !d) return <Notice tone="error" title={q.error?.message ?? '权益清单没有加载出来'} />;

  // 清单、看板汇总，连同已经打开过的会员「本月可享」（挂在 ['member', id, 'benefits']）
  const refresh = () => qc.invalidateQueries({ predicate: ({ queryKey: k }) => k[0] === 'benefits' || (k[0] === 'member' && k[2] === 'benefits') });
  const importAll = async () => {
    setBusy('import');
    try {
      const r = await api.post<{ created: number; skipped: number }>('/api/benefits/import');
      toast({ tone: 'success', title: `已导入 ${r.created} 项`, body: r.skipped ? `编号已有、跳过 ${r.skipped} 项。导入后全部是草稿，逐项改好再发布。` : '导入后全部是草稿，逐项改好再发布。' });
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: '导入没有成功', body: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const changeStatus = async (b: Benefit, next: 'published' | 'paused') => {
    setBusy(`${b.id}`);
    try {
      await api.post(`/api/benefits/${b.id}/status`, { expectedVersion: b.version, status: next });
      toast({ tone: 'success', title: next === 'published' ? `已发布「${b.name}」` : `已暂缓「${b.name}」`, body: next === 'published' ? publishHint(b) : '以后不再发、不能登记；已经发出的券照常可用。' });
    } catch (e) {
      toast({ tone: 'error', title: next === 'published' ? '还不能发布' : '没有暂缓', body: errorMessage(e) });
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  const published = d.items.filter((b) => b.status === 'published').length;
  const month = d.items.reduce((s, b) => ({ coupons: s.coupons + b.month.coupons, uses: s.uses + b.month.uses }), { coupons: 0, uses: 0 });
  return (
    <div className="space-y-5" data-testid="benefits-admin">
      {d.warnings.map((w) => (
        <Notice key={w} tone="warning" icon={<TriangleAlert className="size-5" />} title={w} />
      ))}
      {d.importable > 0 && (
        <Notice
          tone="info"
          title={d.items.length ? `本店权益清单里还有 ${d.importable} 项没导入` : '还没有导入本店权益清单'}
          action={
            <Button size="sm" variant="primary" icon={<Download className="size-4" />} loading={busy === 'import'} onClick={() => void importAll()} data-testid="benefits-import">
              导入 {d.importable} 项
            </Button>
          }
        >
          会员文档附录三 A「汤崎洗浴与会员服务」57 项与补充 2 项，按编号、名称、配置起点、内容与使用条件原样导入；导入后全部是草稿（文档写明暂缓的 4 项为暂缓），编号已有的跳过。
        </Notice>
      )}
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-2" data-testid="benefits-overview">
          <span>
            已发布 <b className="num text-ink">{published}</b> / {d.items.length} 项
          </span>
          <span>
            本月（{d.month.from} 起）发券 <b className="num text-ink">{month.coupons}</b> 张 · 登记使用 <b className="num text-ink">{month.uses}</b> 次
          </span>
          <span className="text-ink-3">
            {d.job ? `自动发放：营业日 ${d.job.businessDate}，${d.job.error ? `出错（${d.job.error}）` : d.job.finishedAt ? `${formatTime(d.job.finishedAt)} 跑完` : '进行中'}` : '自动发放还没有运行记录'}
          </span>
          <PendingBadge title="归类、默认数量与发放时机按 PENDING_DECISIONS M27–M35（待店主确认）" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Segmented
            ariaLabel="状态"
            size="sm"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: '全部' },
              { value: 'published', label: '已发布' },
              { value: 'draft', label: '草稿' },
              { value: 'paused', label: '暂缓' },
            ]}
          />
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
            <Input fullWidth={false} className="h-9 w-56 pl-9" placeholder="编号或名称" value={keyword} onChange={(e) => setKeyword(e.target.value)} aria-label="搜索权益" />
          </div>
        </div>
      </Card>

      {BENEFIT_CATEGORIES.map((cat) => {
        const rows = shown.filter((b) => b.category === cat);
        if (!rows.length) return null;
        return (
          <Card key={cat} className="p-5" data-testid={`benefits-${cat}`}>
            <SectionTitle aside={<span className="text-[12px] text-ink-3">{rows.length} 项</span>}>{BENEFIT_CATEGORY_LABELS[cat]}</SectionTitle>
            <p className="mt-1 text-[12.5px] text-ink-3">{BENEFIT_CATEGORY_HINTS[cat]}</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[860px] text-[13px]">
                <thead className="text-left text-[12px] text-ink-3">
                  <tr>
                    <th className="py-1.5 pr-3">编号</th>
                    <th className="py-1.5 pr-3">名称</th>
                    <th className="py-1.5 pr-3">起点</th>
                    <th className="py-1.5 pr-3">数量</th>
                    <th className="py-1.5 pr-3">{cat === 'event' ? '什么时候发 · 券' : cat === 'coupon' ? '券' : '内容'}</th>
                    <th className="py-1.5 pr-3">本月</th>
                    <th className="py-1.5 pr-3">状态</th>
                    <th className="py-1.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {rows.map((b) => (
                    <tr key={b.id} data-testid={`benefit-row-${b.code}`} className="align-top">
                      <td className="num py-2 pr-3 whitespace-nowrap text-ink-3">{b.code}</td>
                      <td className="py-2 pr-3 font-semibold text-ink">{b.name}</td>
                      <td className={cn('py-2 pr-3 whitespace-nowrap', b.startGrade === null && 'text-clay')}>{b.startLabel}</td>
                      <td className="py-2 pr-3">
                        <span className="whitespace-nowrap">{quantityText(b.category, b.period, b.quantity)}</span>
                        {b.tierQuantities.length > 0 && (
                          <span className="block text-[12px] text-ink-3">
                            {b.tierQuantities.map((t) => `${startLabel(t.grade, t.tier)} 起 ${cat === 'discount' ? rateText(t.quantity) : t.quantity}`).join('；')}
                          </span>
                        )}
                      </td>
                      <td className="max-w-[300px] py-2 pr-3 text-ink-2">
                        {cat === 'event' && <span className="block">{b.events.map((e) => BENEFIT_EVENT_LABELS[e]).join('、') || '—'}</span>}
                        {cat === 'coupon' || cat === 'event' ? (
                          b.templateName ? (
                            <span className={cn('block text-[12.5px]', b.templateActive === false && 'text-clay')} title={b.templateSummary ?? undefined}>
                              {b.templateName}
                              {b.templateActive === false && '（已停用）'}
                            </span>
                          ) : (
                            <span className="text-[12.5px] text-ink-4">还没选券</span>
                          )
                        ) : (
                          <span className="line-clamp-2 text-[12.5px]">{b.content}</span>
                        )}
                        {b.festivalDates.length > 0 && <span className="block text-[12px] text-ink-3">节日 {b.festivalDates.join('、')}</span>}
                        {cat === 'discount' && (
                          <span className="block text-[12px] text-ink-3" data-testid={`benefit-discount-${b.code}`}>
                            {b.discountTarget ? `${DISCOUNT_TARGET_LABELS[b.discountTarget]} · ${discountDaysText(b.weekdays, b.monthDays)}` : '还没选打哪些明细'}
                          </span>
                        )}
                      </td>
                      <td className="num py-2 pr-3 whitespace-nowrap text-ink-2">
                        {cat === 'service' ? `${b.month.uses} 次` : cat === 'coupon' || cat === 'event' ? `${b.month.coupons} 张 · ${b.month.members} 位` : '—'}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={STATUS_TONE[b.status]}>{BENEFIT_STATUS_LABELS[b.status]}</Badge>
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <span className="inline-flex gap-1.5">
                          <Button size="sm" variant="ghost" icon={<PencilLine className="size-3.5" />} onClick={() => setEditing(b)} data-testid={`benefit-edit-${b.code}`}>
                            编辑
                          </Button>
                          {b.status === 'published' ? (
                            <Button size="sm" variant="ghost" icon={<PauseCircle className="size-3.5" />} loading={busy === `${b.id}`} onClick={() => void changeStatus(b, 'paused')} data-testid={`benefit-pause-${b.code}`}>
                              暂缓
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<Send className="size-3.5" />}
                              loading={busy === `${b.id}`}
                              onClick={() => void changeStatus(b, 'published')}
                              data-testid={`benefit-publish-${b.code}`}
                            >
                              发布
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
      {shown.length === 0 && d.items.length > 0 && <p className="text-center text-[13px] text-ink-3">没有符合条件的权益。</p>}
      <EditDialog benefit={editing} catalog={d} onClose={() => setEditing(null)} onSaved={() => void refresh()} />
    </div>
  );
}

const publishHint = (b: Benefit) =>
  b.category === 'coupon'
    ? '够格的会员当天就发本期的券（之后每期第一天发），月中升档当场补发。'
    : b.category === 'event'
      ? '之后有这些事件时自动发券。'
      : '会员详情「本月可享」会列出这一项。';

interface Draft {
  name: string;
  category: BenefitCategory;
  start: string;
  period: BenefitPeriod;
  quantity: string;
  tiers: { state: string; quantity: string }[];
  templateId: string;
  events: BenefitEvent[];
  festivals: string;
  /** 折扣类（v0.7.25）：打哪些明细、每周几、每月几号（顿号隔开） */
  discountTarget: DiscountTarget | '';
  weekdays: number[];
  monthDays: string;
  content: string;
  conditions: string;
}

const toDraft = (b: Benefit): Draft => ({
  name: b.name,
  category: b.category,
  start: b.startGrade === null ? '' : stateValue(b.startGrade, b.startTier),
  period: b.period,
  quantity: b.quantity === null ? '' : String(b.quantity),
  tiers: b.tierQuantities.map((t) => ({ state: stateValue(t.grade, t.tier), quantity: String(t.quantity) })),
  templateId: b.templateId === null ? '' : String(b.templateId),
  events: b.events,
  festivals: b.festivalDates.join('、'),
  discountTarget: b.discountTarget ?? '',
  weekdays: b.weekdays,
  monthDays: b.monthDays.join('、'),
  content: b.content,
  conditions: b.conditions,
});

const intOf = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

function EditDialog({ benefit, catalog, onClose, onSaved }: { benefit: Benefit | null; catalog: BenefitCatalog; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(!!benefit, () => {
    setDraft(benefit ? toDraft(benefit) : null);
    setError(null);
  }, [benefit?.id]);
  if (!benefit || !draft) return null;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const couponLike = draft.category === 'coupon' || draft.category === 'event';
  const isDiscount = draft.category === 'discount';
  // 折扣类的「数量」是付几成（v0.7.25）：起点的折扣与各档阶的折扣
  const counted = couponLike || isDiscount || (draft.category === 'service' && draft.period !== 'none');
  const minQty = isDiscount ? MIN_DISCOUNT_RATE : 1;
  const maxQty = couponLike ? MAX_BENEFIT_COUPONS : isDiscount ? MAX_DISCOUNT_RATE : MAX_BENEFIT_LIMIT;
  // 选得到的券：启用的、没过期的，加上现在用的那张（停用了也列出来，方便看清）
  const templates = [...catalog.templates];
  if (benefit.templateId !== null && !templates.some((t) => t.id === benefit.templateId)) {
    templates.push({ id: benefit.templateId, name: `${benefit.templateName ?? ''}（已停用或过期）`, summary: benefit.templateSummary ?? '', validity: '' });
  }
  const periodOptions: BenefitPeriod[] = draft.category === 'coupon' ? ['month', 'year'] : draft.category === 'service' ? ['none', 'day', 'month', 'year'] : ['none'];

  const save = async () => {
    setError(null);
    const start = draft.start ? parseState(draft.start) : null;
    const quantity = counted ? (draft.quantity.trim() ? intOf(draft.quantity) : null) : null;
    if (quantity !== null && (Number.isNaN(quantity) || quantity < minQty || quantity > maxQty)) {
      return setError(isDiscount ? `折扣填「付几成」：${minQty}–${maxQty} 的整数（75 = 7.5 折）` : `数量要是 1–${maxQty} 的整数`);
    }
    const tierQuantities: TierQuantity[] = [];
    for (const t of counted ? draft.tiers : []) {
      const n = intOf(t.quantity);
      if (!t.state || Number.isNaN(n) || n < minQty || n > maxQty) {
        return setError(isDiscount ? `各档阶的折扣：请选档阶，折扣是 ${minQty}–${maxQty} 的整数（75 = 7.5 折）` : `各档阶数量：请选档阶，数量是 1–${maxQty} 的整数`);
      }
      tierQuantities.push({ ...parseState(t.state), quantity: n });
    }
    const festivalDates = draft.events.includes('festival')
      ? draft.festivals
          .split(/[\s,，、;；]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (festivalDates.some((f) => !/^\d{4}-\d{2}-\d{2}$/.test(f))) return setError('节日日期按 YYYY-MM-DD 填，几个日期用顿号隔开');
    const monthDays = isDiscount
      ? draft.monthDays
          .split(/[\s,，、;；]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map(intOf)
      : [];
    if (monthDays.some((d) => Number.isNaN(d) || d < 1 || d > 31)) return setError('每月几号填 1–31，几个日期用顿号隔开');
    setBusy(true);
    try {
      await api.put(`/api/benefits/${benefit.id}`, {
        expectedVersion: benefit.version,
        name: draft.name.trim(),
        category: draft.category,
        startGrade: start?.grade ?? null,
        startTier: start?.tier ?? null,
        period: periodOptions.includes(draft.period) ? draft.period : periodOptions[0],
        quantity,
        tierQuantities,
        templateId: couponLike && draft.templateId ? Number(draft.templateId) : null,
        events: draft.category === 'event' ? draft.events : [],
        festivalDates,
        discountTarget: isDiscount && draft.discountTarget ? draft.discountTarget : null,
        weekdays: isDiscount ? draft.weekdays : [],
        monthDays,
        content: draft.content.trim(),
        conditions: draft.conditions.trim(),
      });
      toast({ tone: 'success', title: `已保存「${draft.name.trim()}」` });
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === 'BENEFIT_CHANGED') onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title={`编辑 ${benefit.code}`}
      description={`现在是「${BENEFIT_STATUS_LABELS[benefit.status]}」。${benefit.status === 'published' ? '已发布的改完要还能发布；' : ''}改了只影响以后，已经发出的券、登记的使用不变。`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!draft.name.trim()} data-testid="benefit-save">
            保存
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称" htmlFor="benefit-name" className="sm:col-span-2">
          <Input id="benefit-name" value={draft.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="类别" htmlFor="benefit-category" hint={BENEFIT_CATEGORY_HINTS[draft.category]} className="sm:col-span-2">
          <Select
            id="benefit-category"
            value={draft.category}
            onChange={(e) => {
              const category = e.target.value as BenefitCategory;
              set({ category, period: category === 'coupon' ? 'month' : category === 'service' ? draft.period : 'none' });
            }}
            data-testid="benefit-category"
          >
            {BENEFIT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {BENEFIT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="配置起点" htmlFor="benefit-start" hint="会员现在的档阶不低于起点就能用；「L0·会员」是所有会员">
          <Select id="benefit-start" value={draft.start} onChange={(e) => set({ start: e.target.value })} data-testid="benefit-start">
            <option value="">未配置（不能发布）</option>
            {STATE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {periodOptions.length > 1 && (
          <Field label={draft.category === 'coupon' ? '多久发一次' : '次数按'} htmlFor="benefit-period">
            <Select id="benefit-period" value={draft.period} onChange={(e) => set({ period: e.target.value as BenefitPeriod })} data-testid="benefit-period">
              {periodOptions.map((p) => (
                <option key={p} value={p}>
                  {draft.category === 'service' && p === 'none' ? '不计次（只列出来）' : BENEFIT_PERIOD_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {counted && (
          <Field
            label={draft.category === 'coupon' ? '每期几张' : draft.category === 'event' ? '每次几张' : isDiscount ? '起点的折扣（付几成）' : '每期几次'}
            htmlFor="benefit-quantity"
            hint={draft.category === 'service' ? '到上限后不能再登记' : isDiscount ? `${MIN_DISCOUNT_RATE}–${MAX_DISCOUNT_RATE}：75 = 7.5 折，50 = 5 折` : `最多 ${MAX_BENEFIT_COUPONS} 张`}
          >
            <Input id="benefit-quantity" inputMode="numeric" value={draft.quantity} onChange={(e) => set({ quantity: e.target.value })} data-testid="benefit-quantity" />
          </Field>
        )}
        {counted && (
          <div className="sm:col-span-2">
            <p className="text-[13px] font-semibold text-ink-2">{isDiscount ? '各档阶的折扣（可选）' : '各档阶数量（可选）'}</p>
            <p className="text-[12.5px] text-ink-3">
              {isDiscount ? '高档阶折扣更低：从这个档阶起按这一行（付几成），按会员现在的档阶取一行。' : '高档阶多给：从这个档阶起按这一行，按会员现在的档阶取一行、不相加。'}
            </p>
            <div className="mt-2 space-y-2">
              {draft.tiers.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select
                    aria-label="从哪个档阶起"
                    className="w-40"
                    value={t.state}
                    onChange={(e) => set({ tiers: draft.tiers.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)) })}
                  >
                    <option value="">选档阶</option>
                    {STATE_OPTIONS.filter((o) => !draft.start || stateRank(parseState(o.value).grade, parseState(o.value).tier) > stateRank(parseState(draft.start).grade, parseState(draft.start).tier)).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label} 起
                      </option>
                    ))}
                  </Select>
                  <Input
                    fullWidth={false}
                    className="w-24"
                    aria-label="数量"
                    inputMode="numeric"
                    value={t.quantity}
                    onChange={(e) => set({ tiers: draft.tiers.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })}
                  />
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => set({ tiers: draft.tiers.filter((_, j) => j !== i) })}>
                    删掉
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set({ tiers: [...draft.tiers, { state: '', quantity: '' }] })}>
                加一行
              </Button>
            </div>
          </div>
        )}
        {couponLike && (
          <Field label="发哪张券" htmlFor="benefit-template" hint={draft.category === 'coupon' ? '券的有效期到本期最后一天（不看模板的有效天数）' : '按券模板的有效期'} className="sm:col-span-2">
            <Select id="benefit-template" value={draft.templateId} onChange={(e) => set({ templateId: e.target.value })} data-testid="benefit-template">
              <option value="">选券模板（在「券与会员权益」里建）</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.summary ? ` · ${t.summary}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {draft.category === 'event' && (
          <Field label="什么时候发" className="sm:col-span-2" hint="每项去重：首充一次；每次升档、升阶、保级各一次；生日月每年一次；每个节日一次">
            <div className="flex flex-wrap gap-2">
              {BENEFIT_EVENTS.map((e) => {
                const on = draft.events.includes(e);
                return (
                  <button
                    key={e}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set({ events: on ? draft.events.filter((x) => x !== e) : [...draft.events, e] })}
                    className={cn('h-8 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-pine bg-pine-soft text-pine' : 'border-line-strong text-ink-3 hover:text-ink')}
                  >
                    {BENEFIT_EVENT_LABELS[e]}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        {isDiscount && (
          <>
            <Field label="打哪些明细" htmlFor="benefit-discount-target" hint="只打会员本人手牌账单上的这些明细；一张结账单只享一种会员折扣、不与券同用" className="sm:col-span-2">
              <Select
                id="benefit-discount-target"
                value={draft.discountTarget}
                onChange={(e) => set({ discountTarget: e.target.value as DiscountTarget | '' })}
                data-testid="benefit-discount-target"
              >
                <option value="">请选择（不能发布）</option>
                {DISCOUNT_TARGETS.map((t) => (
                  <option key={t} value={t}>
                    {DISCOUNT_TARGET_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="每周几（不选 = 每天）" className="sm:col-span-2">
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_LABELS.map((label, i) => {
                  const d = i + 1;
                  const on = draft.weekdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set({ weekdays: on ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d].sort((a, b) => a - b) })}
                      className={cn('h-8 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-pine bg-pine-soft text-pine' : 'border-line-strong text-ink-3 hover:text-ink')}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="每月几号（不填 = 每天）" htmlFor="benefit-month-days" hint="例如会员日每月 8 日；几个日期用顿号隔开；每周几也选了时两样都要满足" className="sm:col-span-2">
              <Input id="benefit-month-days" value={draft.monthDays} placeholder="8" onChange={(e) => set({ monthDays: e.target.value })} data-testid="benefit-month-days" />
            </Field>
          </>
        )}
        {draft.category === 'event' && draft.events.includes('festival') && (
          <Field label="节日日期" htmlFor="benefit-festivals" hint="YYYY-MM-DD，几个日期用顿号隔开；农历节日每年填当年的日期；当天起 7 天内发" className="sm:col-span-2">
            <Input id="benefit-festivals" value={draft.festivals} placeholder="2027-01-01、2027-02-06、2027-09-15" onChange={(e) => set({ festivals: e.target.value })} data-testid="benefit-festivals" />
          </Field>
        )}
        <Field label="内容" htmlFor="benefit-content" className="sm:col-span-2">
          <Textarea id="benefit-content" value={draft.content} maxLength={500} rows={2} onChange={(e) => set({ content: e.target.value })} />
        </Field>
        <Field label="使用条件" htmlFor="benefit-conditions" className="sm:col-span-2">
          <Textarea id="benefit-conditions" value={draft.conditions} maxLength={500} rows={2} onChange={(e) => set({ conditions: e.target.value })} />
        </Field>
        {error && <Notice tone="error" title={error} className="sm:col-span-2" />}
      </div>
    </Dialog>
  );
}
