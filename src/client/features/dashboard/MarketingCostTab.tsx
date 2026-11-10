// 数据看板「营销成本」（8.0.4 需求表 10、11，docs/MEMBERSHIP_V804.md 第 10 节，HY14、HY15）：券、赠金、会员折扣、服务类权益的实核成本，
// 买一赠一的赠品出库状态（失败的在这里重试），服务类权益的测算单价。只给「营销成本测算」的人看（有财务职责的账号没有），
// 测算的数只在这一页现算，不进日结、对账与财务的任何账。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgePercent, Calculator, Download, Gift, Ticket, Wallet } from 'lucide-react';
import { USAGE_GROUP_LABELS, USAGE_GROUPS, type UsageGroup } from '@shared/coupon-usage';
import { GIFT_OUT_NEEDS_ACTION, GIFT_OUT_STATUS_LABELS, GIFT_OUT_STATUSES, type CostParam, type GiftOutStatus, type MarketingCost } from '@shared/marketing-cost';
import { centsToInput, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { downloadUrl } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, MoneyInput, Notice, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { Kpi, PeriodPicker, presetRange, type Period } from './charts';

const costKeys = {
  all: ['marketing-cost'] as const,
  report: (from: string, to: string) => ['marketing-cost', 'report', from, to] as const,
  params: ['marketing-cost', 'params'] as const,
};

const GIFT_TONES: Record<GiftOutStatus, 'pine' | 'lake' | 'ember' | 'clay' | 'neutral'> = {
  pending: 'lake',
  done: 'pine',
  failed: 'ember',
  cancelled: 'neutral',
  void_pending: 'lake',
  voided: 'neutral',
  void_failed: 'ember',
};

const qtyText = (milli: number, unit: string) => `${Number((milli / 1000).toFixed(3))} ${unit}`;

export function MarketingCostTab() {
  const session = useSession();
  const [period, setPeriod] = useState<Period>(() => ({ preset: 'month', ...presetRange('month', session.today) }));
  const [group, setGroup] = useState<UsageGroup>('template');
  const q = useQuery({
    queryKey: costKeys.report(period.from, period.to),
    queryFn: () => api.get<MarketingCost>(`/api/marketing-cost?from=${period.from}&to=${period.to}`),
    enabled: period.from <= period.to,
  });
  const d = q.data;
  return (
    <div className="space-y-5" data-testid="dashboard-marketing-cost">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} today={session.today} />
        <Button
          size="sm"
          variant="ghost"
          icon={<Download className="size-4" />}
          disabled={!d}
          onClick={() => downloadUrl(`/api/marketing-cost.csv?from=${period.from}&to=${period.to}`)}
          data-testid="marketing-cost-export"
        >
          导出
        </Button>
      </div>
      <Notice tone="info" title="经营测算，与财务隔离">
        按实际核销算（实核），不按发放面值：券按结账的抵扣、赠金按储值消费用掉的、会员折扣按结账记的，反结账、撤销的冲回；服务类权益按登记次数 × 测算单价。
        这些数只在这一页现算，不进日结、交班、对账包、营业数据与财务凭证；有财务职责（对账付款、成本核算）的账号看不到这一页。
      </Notice>
      {q.isPending ? (
        <Skeleton className="h-72" />
      ) : q.error ? (
        <Notice tone="error" title={errorMessage(q.error)} />
      ) : (
        d && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Kpi icon={<Calculator className="size-4" />} label="营销成本合计" tone="pine" testId="marketing-cost-total">
                <Money cents={d.total} />
              </Kpi>
              <Kpi icon={<Ticket className="size-4" />} label={`券（用了 ${d.coupons.used} 张）`} testId="marketing-cost-coupons">
                <Money cents={d.coupons.amount} />
              </Kpi>
              <Kpi icon={<Wallet className="size-4" />} label="用掉的赠金" testId="marketing-cost-bonus">
                <Money cents={d.bonus.consumed} />
              </Kpi>
              <Kpi icon={<BadgePercent className="size-4" />} label={`会员折扣（${d.discounts.checkouts} 单）`} testId="marketing-cost-discounts">
                <Money cents={d.discounts.amount} />
              </Kpi>
              <Kpi icon={<Gift className="size-4" />} label={`服务类权益（${d.services.uses} 次）`} testId="marketing-cost-services">
                <Money cents={d.services.amount} />
              </Kpi>
            </div>

            <Card className="space-y-3 p-5" data-testid="marketing-cost-coupon-card">
              <SectionTitle aside={<span className="text-[12px] text-ink-3">参考：这段时间发出 {d.coupons.issued} 张，代金券面值 <Money cents={d.coupons.issuedFace} /></span>}>券（含买一赠一）</SectionTitle>
              <Segmented<UsageGroup>
                size="sm"
                ariaLabel="券成本怎么分"
                className="max-w-full flex-wrap"
                value={group}
                onChange={setGroup}
                options={USAGE_GROUPS.map((g) => ({ value: g, label: <span data-testid={`marketing-cost-group-${g}`}>{USAGE_GROUP_LABELS[g]}</span> }))}
              />
              {d.coupons.groups[group].length === 0 ? (
                <p className="py-6 text-center text-[13px] text-ink-3">{group === 'benefit' && d.coupons.used > 0 ? '这段时间用的券都不是会员权益发的' : '这段时间没有用券'}</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full min-w-[480px] text-[13px]" data-testid="marketing-cost-coupon-table">
                    <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                      <tr>
                        <th className="px-3 py-2 text-left">{USAGE_GROUP_LABELS[group].slice(1)}</th>
                        <th className="px-3 py-2 text-right">用了（张）</th>
                        <th className="px-3 py-2 text-right">成本（抵扣）</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/70">
                      {d.coupons.groups[group].map((r) => (
                        <tr key={r.key} data-testid={`marketing-cost-row-${r.key.replace(':', '-')}`}>
                          <td className="px-3 py-2">
                            <span className="font-semibold text-ink">{r.label}</span>
                            {r.note && <span className="ml-1.5 text-[12px] text-ink-3">{r.note}</span>}
                          </td>
                          <td className="num px-3 py-2 text-right">{r.used}</td>
                          <td className="px-3 py-2 text-right">
                            <Money cents={r.amount} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="space-y-2 p-5" data-testid="marketing-cost-bonus-card">
                <SectionTitle>赠金</SectionTitle>
                <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-[13.5px]">
                  <dt className="text-ink-2">储值消费用掉的赠金（成本，撤销的冲减）</dt>
                  <dd className="text-right font-bold text-ink">
                    <Money cents={d.bonus.consumed} />
                  </dd>
                  <dt className="text-ink-3">参考：充值送出的赠金</dt>
                  <dd className="text-right text-ink-2">
                    <Money cents={d.bonus.issued} />
                  </dd>
                  <dt className="text-ink-3">参考：到期作废的赠金</dt>
                  <dd className="text-right text-ink-2">
                    <Money cents={d.bonus.expired} />
                  </dd>
                </dl>
              </Card>
              <Card className="space-y-2 p-5" data-testid="marketing-cost-discount-card">
                <SectionTitle>会员折扣</SectionTitle>
                {d.discounts.rows.length === 0 ? (
                  <p className="py-4 text-center text-[13px] text-ink-3">这段时间没有会员折扣</p>
                ) : (
                  <table className="w-full text-[13px]">
                    <thead className="text-[12px] font-bold text-ink-3">
                      <tr>
                        <th className="py-1.5 text-left">权益</th>
                        <th className="py-1.5 text-right">结账单</th>
                        <th className="py-1.5 text-right">折扣</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/70">
                      {d.discounts.rows.map((r) => (
                        <tr key={r.benefitId} data-testid={`marketing-cost-discount-${r.code}`}>
                          <td className="py-1.5">
                            <span className="font-semibold text-ink">{r.name}</span> <span className="text-[12px] text-ink-3">{r.code}</span>
                          </td>
                          <td className="num py-1.5 text-right">{r.checkouts}</td>
                          <td className="py-1.5 text-right">
                            <Money cents={r.amount} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>

            <ServiceCostCard report={d} />
            <GiftOutsCard report={d} />
          </>
        )
      )}
    </div>
  );
}

/** 服务类权益：登记次数 × 测算单价；单价在这里改（覆盖写入，重复保存结果一样） */
function ServiceCostCard({ report }: { report: MarketingCost }) {
  const qc = useQueryClient();
  const toast = useToast();
  const params = useQuery({ queryKey: costKeys.params, queryFn: () => api.get<CostParam[]>('/api/marketing-cost/params') });
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const usesOf = new Map(report.services.rows.map((r) => [r.benefitId, r]));
  const save = async (p: CostParam) => {
    if (!editing) return;
    const text = editing.text.trim();
    const cents = text ? parseYuan(text) : null;
    if (text && (cents === null || cents < 0)) {
      toast({ tone: 'error', title: '测算单价请填金额（最多两位小数），不测算就留空' });
      return;
    }
    setBusy(true);
    try {
      await api.put<CostParam>(`/api/marketing-cost/params/${p.benefitId}`, { unitCost: cents });
      setEditing(null);
      await qc.invalidateQueries({ queryKey: costKeys.all });
      toast({ tone: 'success', title: `${p.name}：测算单价已保存` });
    } catch (error) {
      toast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-5" data-testid="marketing-cost-service-card">
      <SectionTitle aside={<span className="text-[12px] text-ink-3">没填单价的只列次数，不算钱</span>}>服务类权益</SectionTitle>
      {params.error ? (
        <Notice tone="error" title={errorMessage(params.error)} />
      ) : !params.data ? (
        <Skeleton className="h-24" />
      ) : params.data.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-ink-3">没有服务类权益（在「会员权益」里导入清单）</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left">权益</th>
                <th className="px-3 py-2 text-right">登记次数</th>
                <th className="px-3 py-2 text-right">会员人数</th>
                <th className="px-3 py-2 text-right">测算单价（每次）</th>
                <th className="px-3 py-2 text-right">测算成本</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {params.data.map((p) => {
                const used = usesOf.get(p.benefitId);
                const open = editing?.id === p.benefitId;
                return (
                  <tr key={p.benefitId} data-testid={`marketing-cost-service-${p.code}`}>
                    <td className="px-3 py-2">
                      <span className="font-semibold text-ink">{p.name}</span> <span className="text-[12px] text-ink-3">{p.code}</span>
                      {p.status !== 'published' && <span className="ml-1.5 text-[12px] text-ink-3">（{p.status === 'draft' ? '草稿' : '暂缓'}）</span>}
                    </td>
                    <td className="num px-3 py-2 text-right">{used?.uses ?? 0}</td>
                    <td className="num px-3 py-2 text-right">{used?.members ?? 0}</td>
                    <td className="px-3 py-2 text-right">
                      {open ? (
                        <span className="inline-flex items-center gap-1.5">
                          <MoneyInput
                            value={editing.text}
                            onChange={(e) => setEditing({ id: p.benefitId, text: e.target.value })}
                            placeholder="不测算"
                            className="h-8 w-28"
                            aria-label={`${p.name}的测算单价`}
                            data-testid={`marketing-cost-param-input-${p.code}`}
                          />
                          <Button size="sm" variant="primary" loading={busy} onClick={() => void save(p)} data-testid={`marketing-cost-param-save-${p.code}`}>
                            保存
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                            取消
                          </Button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="font-semibold text-pine hover:underline"
                          onClick={() => setEditing({ id: p.benefitId, text: p.unitCost === null ? '' : centsToInput(p.unitCost) })}
                          data-testid={`marketing-cost-param-edit-${p.code}`}
                        >
                          {p.unitCost === null ? '填单价' : <Money cents={p.unitCost} />}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{used?.amount != null ? <Money cents={used.amount} /> : <span className="text-ink-3">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** 买一赠一的赠品出库：真实的库存出库（成本在库存账），这里看状态；出库失败、冲销失败的点重试（补完库存后） */
function GiftOutsCard({ report }: { report: MarketingCost }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const retry = async (id: number) => {
    setBusy(id);
    try {
      const r = await api.post<{ status: GiftOutStatus | null }>(`/api/gift-outs/${id}/retry`, {});
      toast(
        r.status && GIFT_OUT_NEEDS_ACTION.includes(r.status)
          ? { tone: 'error', title: `还是没成功：${GIFT_OUT_STATUS_LABELS[r.status]}`, body: '看看库存够不够、物料与仓有没有停用，处理后再重试' }
          : { tone: 'success', title: r.status ? GIFT_OUT_STATUS_LABELS[r.status] : '已处理' },
      );
    } catch (error) {
      toast({ tone: 'error', title: errorMessage(error) });
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: costKeys.all });
    }
  };
  const counts = GIFT_OUT_STATUSES.filter((s) => report.giftOuts.counts[s]);
  return (
    <Card className="space-y-3 p-5" data-testid="marketing-cost-gift-card">
      <SectionTitle
        aside={
          <span className="flex flex-wrap gap-1.5">
            {counts.length === 0 ? (
              <span className="text-[12px] text-ink-3">这段时间没有</span>
            ) : (
              counts.map((s) => (
                <Badge key={s} tone={GIFT_TONES[s]}>
                  {GIFT_OUT_STATUS_LABELS[s]} {report.giftOuts.counts[s]}
                </Badge>
              ))
            )}
          </span>
        }
      >
        买一赠一的赠品出库
      </SectionTitle>
      {report.giftOuts.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left">营业日</th>
                <th className="px-3 py-2 text-left">结账单 / 券码</th>
                <th className="px-3 py-2 text-left">赠品</th>
                <th className="px-3 py-2 text-left">状态</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {report.giftOuts.items.map((g) => (
                <tr key={g.id} data-testid={`marketing-cost-gift-${g.id}`}>
                  <td className="num px-3 py-2">{g.businessDate}</td>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-ink">{g.checkoutNo}</span>
                    <span className="block text-[12px] text-ink-3">
                      {g.templateName} · {g.couponCode}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {g.materialName} {qtyText(g.qtyMilli, g.unit)}
                    <span className="block text-[12px] text-ink-3">
                      {g.warehouseName}
                      {g.invDocNo ? ` · ${g.invDocNo}` : ''}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={GIFT_TONES[g.status]}>{GIFT_OUT_STATUS_LABELS[g.status]}</Badge>
                    {g.lastError && GIFT_OUT_NEEDS_ACTION.includes(g.status) && <span className="mt-0.5 block text-[12px] text-ember">{g.lastError}</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {GIFT_OUT_NEEDS_ACTION.includes(g.status) && (
                      <Button size="sm" variant="secondary" loading={busy === g.id} disabled={busy !== null} onClick={() => void retry(g.id)} data-testid={`marketing-cost-gift-retry-${g.id}`}>
                        重试
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
