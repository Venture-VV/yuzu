// 后台「会员权益」（会员体系 v2 第二期，v0.7.24；docs/BENEFITS.md）：本店权益清单按类别分组，每项一行——
// 编号、名称、配置起点、数量与周期、发哪张券、状态、本月发了多少；一键导入清单；逐项编辑（带版本号）、发布、暂缓。
// 券类发布后每月（每年）自动发、月中升档当场补发；事件礼按事件自动发；服务类列在会员详情「本月可享」、登记使用数次数。
// 折扣类（v0.7.25）：设打哪些明细、起点与各档阶的折扣（付几成）、每周几 / 每月几号，发布后手牌结账时自动算。

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
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
  companionText,
  isCompanionTarget,
  MAX_COMPANIONS,
  discountDaysText,
  MAX_BENEFIT_COUPONS,
  MAX_BENEFIT_LIMIT,
  MAX_DISCOUNT_RATE,
  MAX_EXTENSION_MINUTES,
  minutesText,
  MIN_DISCOUNT_RATE,
  MIN_EXTENSION_MINUTES,
  MAX_PARKING_HOURS,
  MAX_VISIT_TARGET,
  MIN_VISIT_TARGET,
  parkingText,
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
  type ParkingUseRow,
  type DiscountTarget,
  type TierQuantity,
} from '@shared/benefits';
import { GRADE_STATES, type Grade, type Tier } from '@shared/membership';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, downloadUrl, formatDateTime, formatTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { benefitKeys } from './queries';
import { BenefitTiersView } from './BenefitTiersView';
import { VipLockersCard } from './VipLockersCard';

/** 三个视图（8.0.4）：按档阶（默认，需求表 01）、按类别（原来的清单）、VIP 柜（需求表 02，从会员规则、手牌与前台移过来） */
type BenefitView = 'tiers' | 'list' | 'vip';
const VIEWS: BenefitView[] = ['tiers', 'list', 'vip'];

export function BenefitsSection() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: BenefitView = VIEWS.includes(raw as BenefitView) ? (raw as BenefitView) : 'tiers';
  return (
    <AdminPage
      section="benefits"
      wide
      description="本店权益清单（会员文档附录三 A 与补充项）：逐项设好配置起点、数量与券，发布后券类每月自动发、事件礼按事件自动发，服务类列在会员详情「本月可享」。改了只影响以后，已经发出的券、登记的使用不变。"
      actions={
        <Link to="/admin/coupons/usage" className="text-[13px] font-semibold text-pine hover:underline" data-testid="benefits-usage-link">
          看使用率
        </Link>
      }
    >
      <Segmented
        ariaLabel="看法"
        className="mb-4"
        value={view}
        onChange={(v) => setParams(v === 'tiers' ? {} : { view: v }, { replace: true })}
        options={[
          { value: 'tiers', label: '按档阶' },
          { value: 'list', label: '按类别' },
          { value: 'vip', label: 'VIP 柜' },
        ]}
      />
      {view === 'vip' ? (
        <VipLockersCard />
      ) : (
        <>
          <BenefitsEditor view={view} />
          {/* 停车登记（8.0.19，IA4）：是前台每天要对的账，挪到门店会员工作台右上角的「停车登记」；这里留一条指路 */}
          <Notice tone="info" title="停车登记在门店里看" className="mt-4" data-testid="benefit-parking-moved">
            前台登记的停车优惠（车牌、免费几小时）与导出给停车场的清单，8.0.19 起在门店{' '}
            <Link to="/parking-log" className="font-bold text-lake hover:underline">
              会员工作台 → 停车登记
            </Link>
            。停车优惠这项权益本身（每次免几小时）仍在上面的清单里改。
          </Notice>
        </>
      )}
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

function BenefitsEditor({ view }: { view: 'tiers' | 'list' }) {
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
        {view === 'list' && <div className="mt-4 flex flex-wrap items-center gap-3">
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
        </div>}
      </Card>

      {view === 'tiers' && <BenefitTiersView onEdit={(id) => setEditing(d.items.find((b) => b.id === id) ?? null)} />}
      {view === 'list' && BENEFIT_CATEGORIES.map((cat) => {
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
                        <span className="whitespace-nowrap">{b.parking ? parkingText(b) : quantityText(b.category, b.period, b.quantity)}</span>
                        {b.tierQuantities.length > 0 && (
                          <span className="block text-[12px] text-ink-3">
                            {b.tierQuantities
                              .map((t) => `${startLabel(t.grade, t.tier)} 起 ${cat === 'discount' ? rateText(t.quantity) : cat === 'extension' ? minutesText(t.quantity) : t.quantity}`)
                              .join('；')}
                          </span>
                        )}
                      </td>
                      <td className="max-w-[300px] py-2 pr-3 text-ink-2">
                        {cat === 'event' && (
                          <span className="block">
                            {b.events.map((e) => (e === 'monthly_visits' ? `每月到店满 ${b.visitTarget ?? '?'} 次` : BENEFIT_EVENT_LABELS[e])).join('、') || '—'}
                          </span>
                        )}
                        {b.parking && <span className="block text-[12px] font-semibold text-pine">停车优惠 · 前台登记车牌</span>}
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
                            {b.discountTarget
                              ? `${DISCOUNT_TARGET_LABELS[b.discountTarget]}${isCompanionTarget(b.discountTarget) ? `（${companionText(b)}）` : ''} · ${discountDaysText(b.weekdays, b.monthDays)}`
                              : '还没选打哪些明细'}
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
      {view === 'list' && shown.length === 0 && d.items.length > 0 && <p className="text-center text-[13px] text-ink-3">没有符合条件的权益。</p>}
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
  /** 同行优惠（v0.7.26）：起点能带几位、各档阶表 */
  companionCount: string;
  companionTiers: { state: string; quantity: string }[];
  weekdays: number[];
  monthDays: string;
  /** 会员挑战（v0.7.28）：每月到店满几次 */
  visitTarget: string;
  /** 停车优惠（v0.7.28）：服务类里标为停车优惠；起点每次免费几小时与各档阶表 */
  parking: boolean;
  parkingHours: string;
  parkingTiers: { state: string; quantity: string }[];
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
  companionCount: b.companionCount === null ? '' : String(b.companionCount),
  companionTiers: b.companionCounts.map((t) => ({ state: stateValue(t.grade, t.tier), quantity: String(t.quantity) })),
  weekdays: b.weekdays,
  monthDays: b.monthDays.join('、'),
  visitTarget: b.visitTarget === null ? '' : String(b.visitTarget),
  parking: b.parking,
  parkingHours: b.parkingHours === null ? '' : String(b.parkingHours),
  parkingTiers: b.parkingHoursByTier.map((t) => ({ state: stateValue(t.grade, t.tier), quantity: String(t.quantity) })),
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
  // 浴票延迟（v0.7.25 续）的「数量」是多给的分钟数：起点的与各档阶的
  const isExtension = draft.category === 'extension';
  // 折扣类的「数量」是付几成（v0.7.25）：起点的折扣与各档阶的折扣
  // 停车优惠（v0.7.28）：服务类、每天一次，数量固定 1；免费几小时另填
  const isParking = draft.category === 'service' && draft.parking;
  const counted = !isParking && (couponLike || isDiscount || isExtension || (draft.category === 'service' && draft.period !== 'none'));
  const minQty = isDiscount ? MIN_DISCOUNT_RATE : isExtension ? MIN_EXTENSION_MINUTES : 1;
  const maxQty = couponLike ? MAX_BENEFIT_COUPONS : isDiscount ? MAX_DISCOUNT_RATE : isExtension ? MAX_EXTENSION_MINUTES : MAX_BENEFIT_LIMIT;
  // 选得到的券：启用的、没过期的，加上现在用的那张（停用了也列出来，方便看清）
  const templates = [...catalog.templates];
  if (benefit.templateId !== null && !templates.some((t) => t.id === benefit.templateId)) {
    templates.push({ id: benefit.templateId, name: `${benefit.templateName ?? ''}（已停用或过期）`, summary: benefit.templateSummary ?? '', validity: '' });
  }
  const periodOptions: BenefitPeriod[] = isParking ? ['day'] : draft.category === 'coupon' ? ['month', 'year'] : draft.category === 'service' ? ['none', 'day', 'month', 'year'] : ['none'];

  const save = async () => {
    setError(null);
    const start = draft.start ? parseState(draft.start) : null;
    const quantity = counted ? (draft.quantity.trim() ? intOf(draft.quantity) : null) : null;
    if (quantity !== null && (Number.isNaN(quantity) || quantity < minQty || quantity > maxQty)) {
      return setError(
        isDiscount ? `折扣填「付几成」：${minQty}–${maxQty} 的整数（75 = 7.5 折）` : isExtension ? `浴票延迟填分钟数：${minQty}–${maxQty} 的整数` : `数量要是 1–${maxQty} 的整数`,
      );
    }
    const tierQuantities: TierQuantity[] = [];
    for (const t of counted ? draft.tiers : []) {
      const n = intOf(t.quantity);
      if (!t.state || Number.isNaN(n) || n < minQty || n > maxQty) {
        return setError(
          isDiscount
            ? `各档阶的折扣：请选档阶，折扣是 ${minQty}–${maxQty} 的整数（75 = 7.5 折）`
            : isExtension
              ? `各档阶的浴票延迟：请选档阶，分钟数是 ${minQty}–${maxQty} 的整数`
              : `各档阶数量：请选档阶，数量是 1–${maxQty} 的整数`,
        );
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
    // 同行优惠（v0.7.26）：起点能带几位与各档阶表（1–9 位）
    const companion = isDiscount && draft.discountTarget !== '' && isCompanionTarget(draft.discountTarget);
    const companionCount = companion && draft.companionCount.trim() ? intOf(draft.companionCount) : null;
    if (companionCount !== null && (Number.isNaN(companionCount) || companionCount < 1 || companionCount > MAX_COMPANIONS)) {
      return setError(`同行几位填 1–${MAX_COMPANIONS} 的整数`);
    }
    const companionCounts: TierQuantity[] = [];
    for (const c of companion ? draft.companionTiers : []) {
      const n = intOf(c.quantity);
      if (!c.state || Number.isNaN(n) || n < 1 || n > MAX_COMPANIONS) return setError(`各档阶同行几位：请选档阶，人数是 1–${MAX_COMPANIONS} 的整数`);
      companionCounts.push({ ...parseState(c.state), quantity: n });
    }
    // 会员挑战（v0.7.28）：每月到店满几次
    const challenge = draft.category === 'event' && draft.events.includes('monthly_visits');
    const visitTarget = challenge && draft.visitTarget.trim() ? intOf(draft.visitTarget) : null;
    if (visitTarget !== null && (Number.isNaN(visitTarget) || visitTarget < MIN_VISIT_TARGET || visitTarget > MAX_VISIT_TARGET)) {
      return setError(`每月到店满几次填 ${MIN_VISIT_TARGET}–${MAX_VISIT_TARGET} 的整数`);
    }
    // 停车优惠（v0.7.28）：起点每次免费几小时与各档阶表（1–24）
    const parkingHours = isParking && draft.parkingHours.trim() ? intOf(draft.parkingHours) : null;
    if (parkingHours !== null && (Number.isNaN(parkingHours) || parkingHours < 1 || parkingHours > MAX_PARKING_HOURS)) {
      return setError(`免费几小时填 1–${MAX_PARKING_HOURS} 的整数`);
    }
    const parkingHoursByTier: TierQuantity[] = [];
    for (const c of isParking ? draft.parkingTiers : []) {
      const n = intOf(c.quantity);
      if (!c.state || Number.isNaN(n) || n < 1 || n > MAX_PARKING_HOURS) return setError(`各档阶免费几小时：请选档阶，小时数是 1–${MAX_PARKING_HOURS} 的整数`);
      parkingHoursByTier.push({ ...parseState(c.state), quantity: n });
    }
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
        companionCount,
        companionCounts,
        weekdays: isDiscount ? draft.weekdays : [],
        monthDays,
        visitTarget,
        parking: isParking,
        parkingHours,
        parkingHoursByTier,
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
        {draft.category === 'service' && (
          <label className="flex items-start gap-2 text-[13px] sm:col-span-2" data-testid="benefit-parking-toggle">
            <input type="checkbox" className="mt-0.5" checked={draft.parking} onChange={(e) => set({ parking: e.target.checked, period: e.target.checked ? 'day' : draft.period })} />
            <span>
              <span className="font-semibold">停车优惠</span>
              <span className="block text-[12.5px] text-ink-3">每位会员每个营业日一次，按档阶每次免费几小时；前台登记车牌和几小时，系统不收停车费，只登记、给停车场对账</span>
            </span>
          </label>
        )}
        {isParking && (
          <div className="grid gap-2 sm:col-span-2" data-testid="benefit-parking">
            <Field label="起点每次免费几小时" htmlFor="benefit-parking-hours" hint={`1–${MAX_PARKING_HOURS} 小时`}>
              <Input id="benefit-parking-hours" inputMode="numeric" value={draft.parkingHours} onChange={(e) => set({ parkingHours: e.target.value })} data-testid="benefit-parking-hours" />
            </Field>
            <p className="text-[12.5px] text-ink-3">各档阶免费几小时（可选）：从这个档阶起按这一行，按会员现在的档阶取一行、不相加。</p>
            {draft.parkingTiers.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  aria-label="从哪个档阶起"
                  className="w-40"
                  value={c.state}
                  onChange={(e) => set({ parkingTiers: draft.parkingTiers.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)) })}
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
                  aria-label="几小时"
                  inputMode="numeric"
                  value={c.quantity}
                  onChange={(e) => set({ parkingTiers: draft.parkingTiers.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })}
                />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => set({ parkingTiers: draft.parkingTiers.filter((_, j) => j !== i) })}>
                  删掉
                </Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set({ parkingTiers: [...draft.parkingTiers, { state: '', quantity: '' }] })}>
              加一行
            </Button>
          </div>
        )}
        {counted && (
          <Field
            label={
              draft.category === 'coupon' ? '每期几张' : draft.category === 'event' ? '每次几张' : isDiscount ? '起点的折扣（付几成）' : isExtension ? '起点多给几分钟（不跳档）' : '每期几次'
            }
            htmlFor="benefit-quantity"
            hint={
              draft.category === 'service'
                ? '到上限后不能再登记'
                : isDiscount
                  ? `${MIN_DISCOUNT_RATE}–${MAX_DISCOUNT_RATE}：75 = 7.5 折，50 = 5 折`
                  : isExtension
                    ? `${MIN_EXTENSION_MINUTES}–${MAX_EXTENSION_MINUTES} 分钟，在「门票跳档宽限」之上多给；每个 12 小时的分界点都多给`
                    : `最多 ${MAX_BENEFIT_COUPONS} 张`
            }
          >
            <Input id="benefit-quantity" inputMode="numeric" value={draft.quantity} onChange={(e) => set({ quantity: e.target.value })} data-testid="benefit-quantity" />
          </Field>
        )}
        {counted && (
          <div className="sm:col-span-2">
            <p className="text-[13px] font-semibold text-ink-2">{isDiscount ? '各档阶的折扣（可选）' : isExtension ? '各档阶多给几分钟（可选）' : '各档阶数量（可选）'}</p>
            <p className="text-[12.5px] text-ink-3">
              {isDiscount
                ? '高档阶折扣更低：从这个档阶起按这一行（付几成），按会员现在的档阶取一行。'
                : isExtension
                  ? '从这个档阶起按这一行的分钟数，按会员现在的档阶（含体验中的临时身份）取一行、不相加。'
                  : '高档阶多给：从这个档阶起按这一行，按会员现在的档阶取一行、不相加。'}
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
              <option value="">选券模板（在「券」里建）</option>
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
        {draft.category === 'event' && draft.events.includes('monthly_visits') && (
          <Field
            label="每月到店满几次送"
            htmlFor="benefit-visit-target"
            hint={`${MIN_VISIT_TARGET}–${MAX_VISIT_TARGET} 次；到店按有结账的营业日算，一天算一次；满了每月每人送一次（反结账不收回）`}
            className="sm:col-span-2"
          >
            <Input id="benefit-visit-target" inputMode="numeric" value={draft.visitTarget} onChange={(e) => set({ visitTarget: e.target.value })} data-testid="benefit-visit-target" />
          </Field>
        )}
        {isDiscount && (
          <>
            <Field
              label="打哪些明细"
              htmlFor="benefit-discount-target"
              hint="客房房费、门票、整张账单打会员本人手牌账单上的；「同行的」打合并结账里不是会员的同行客人的。一张结账单只享一种会员折扣、不与券同用"
              className="sm:col-span-2"
            >
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
            {draft.discountTarget !== '' && isCompanionTarget(draft.discountTarget) && (
              <div className="grid gap-2 sm:col-span-2" data-testid="benefit-companions">
                <Field label="起点能带同行几位" htmlFor="benefit-companion-count" hint={`1–${MAX_COMPANIONS} 位；同行里适用明细多的先算，相同时按手牌号`}>
                  <Input
                    id="benefit-companion-count"
                    inputMode="numeric"
                    value={draft.companionCount}
                    onChange={(e) => set({ companionCount: e.target.value })}
                    data-testid="benefit-companion-count"
                  />
                </Field>
                <p className="text-[12.5px] text-ink-3">各档阶能带几位（可选）：从这个档阶起按这一行，按会员现在的档阶取一行、不相加。</p>
                {draft.companionTiers.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Select
                      aria-label="从哪个档阶起"
                      className="w-40"
                      value={c.state}
                      onChange={(e) => set({ companionTiers: draft.companionTiers.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)) })}
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
                      aria-label="几位"
                      inputMode="numeric"
                      value={c.quantity}
                      onChange={(e) => set({ companionTiers: draft.companionTiers.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })}
                    />
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => set({ companionTiers: draft.companionTiers.filter((_, j) => j !== i) })}>
                      删掉
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set({ companionTiers: [...draft.companionTiers, { state: '', quantity: '' }] })}>
                  加一行
                </Button>
              </div>
            )}
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
