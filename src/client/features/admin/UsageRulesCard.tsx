// 后台「客房 → 派对房等（开单即占用）」（D37 / D39，v0.7.19）：哪些业态的房间按「有开着的使用单」算使用中（默认派对房、宠物轰趴房、娱乐室，待确认）。
// 这些房间不派技师，在「客房 → 平面图」点房间开单、结束、撤单；客房、技师服务类的业态不能选（它们按入住单、钟单算占用）。
// 计费（v0.7.28，N2）：按业态选价目表里的「房费项目」（价格是每小时多少，分类就是部门）、起步时长、计费单位、开台费项目；
// 设了的，结束使用时按时长把房费挂到使用人的手牌账单上，结账前要先结束。没设的照旧不收费。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_USAGE_BUSINESS_TYPES,
  DEFAULT_USAGE_MIN_MINUTES,
  DEFAULT_USAGE_STEP_MINUTES,
  MAX_USAGE_MIN_MINUTES,
  pricingText,
  USAGE_STEP_OPTIONS,
  type UsagePricing,
  type UsageRules,
} from '@shared/usages';
import { formatYuan } from '@shared/money';
import { useCatalog } from '../../lib/queries';
import { isTechnicianBusinessType, ROOM_BUSINESS_TYPE, SPACE_BUSINESS_TYPES } from '@shared/spaces';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../components/Toast';
import { Button, Card, Input, Notice, PendingBadge, SectionTitle, Select, Skeleton } from '../../components/ui';

const key = ['admin', 'usage-rules'] as const;
/** 可以选的业态：台账里的业态里，客房与技师服务类以外的 */
const CANDIDATES = SPACE_BUSINESS_TYPES.filter((t) => t !== ROOM_BUSINESS_TYPE && !isTechnicianBusinessType(t));

export function UsageRulesCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: key, queryFn: () => api.get<UsageRules>('/api/admin/usage-rules') });
  const [draft, setDraft] = useState<string[] | null>(null);
  const [pricingDraft, setPricingDraft] = useState<Record<string, UsagePricing> | null>(null);
  const catalog = useCatalog(true);
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!rules.data) return <Skeleton className="h-28" />;
  const current = draft ?? rules.data.businessTypes;
  const pricing = pricingDraft ?? rules.data.pricing ?? {};
  const dirty = draft !== null || pricingDraft !== null;
  const items = (catalog.data?.items ?? []).filter((i) => !i.technicianRequired);
  const setPricing = (type: string, p: UsagePricing | null) => {
    const next = { ...pricing };
    if (p) next[type] = p;
    else delete next[type];
    setPricingDraft(next);
  };
  const options = [...new Set([...CANDIDATES, ...rules.data.businessTypes, ...current])];
  const editable = can('settings.manage');
  const isDefault = current.length === DEFAULT_USAGE_BUSINESS_TYPES.length && DEFAULT_USAGE_BUSINESS_TYPES.every((t) => current.includes(t));
  const toggle = (t: string) => setDraft(current.includes(t) ? current.filter((x) => x !== t) : [...current, t]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<UsageRules>('/api/admin/usage-rules', {
        businessTypes: current,
        pricing: Object.fromEntries(Object.entries(pricing).filter(([t]) => current.includes(t))),
      });
      qc.setQueryData(key, next);
      setDraft(null);
      setPricingDraft(null);
      await qc.invalidateQueries({ queryKey: ['rooms'] });
      toast({ tone: 'success', title: '开单即占用的业态与计费已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-5" data-testid="usage-rules">
      <div className="flex items-center gap-2">
        <SectionTitle>派对房等：开单即占用</SectionTitle>
        {isDefault && <PendingBadge />}
      </div>
      <p className="text-[13px] leading-relaxed text-ink-2">
        这些业态的房间不派技师，在「客房 → 平面图」点房间「开单」（选在店客人的手牌）即显示使用中；结束使用、使用人结账或撤单后空闲。
        设了计费的，结束使用时按时长把房费挂到使用人的手牌账单上（结账前要先结束）；没设的场次费到前台另挂。
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((t) => (
          <label key={t} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[13px]">
            <input type="checkbox" checked={current.includes(t)} disabled={!editable || busy} onChange={() => toggle(t)} className="size-4 accent-pine" data-testid={`usage-type-${t}`} />
            {t}
          </label>
        ))}
      </div>
      <div className="space-y-2" data-testid="usage-pricing">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          计费 <PendingBadge />
        </p>
        {current.map((t) => {
          const p = pricing[t];
          const item = p ? items.find((i) => i.id === p.feeItemId) : undefined;
          const open = p?.openFeeItemId ? items.find((i) => i.id === p.openFeeItemId) : undefined;
          return (
            <div key={t} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]" data-testid={`usage-pricing-${t}`}>
              <span className="w-24 font-semibold">{t}</span>
              <Select
                value={p ? String(p.feeItemId) : ''}
                disabled={!editable || busy}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setPricing(t, id ? { feeItemId: id, minMinutes: p?.minMinutes ?? DEFAULT_USAGE_MIN_MINUTES, stepMinutes: p?.stepMinutes ?? DEFAULT_USAGE_STEP_MINUTES, openFeeItemId: p?.openFeeItemId ?? null } : null);
                }}
                aria-label={`${t} 房费项目`}
                data-testid={`usage-pricing-item-${t}`}
                className="w-52"
              >
                <option value="">不计费</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}（{formatYuan(i.price)}/小时 · {i.category || '未分类'}）
                  </option>
                ))}
              </Select>
              {p && (
                <>
                  <label className="flex items-center gap-1">
                    起步
                    <Input
                      type="number"
                      min={0}
                      max={MAX_USAGE_MIN_MINUTES}
                      value={p.minMinutes}
                      disabled={!editable || busy}
                      onChange={(e) => setPricing(t, { ...p, minMinutes: Math.max(0, Math.min(MAX_USAGE_MIN_MINUTES, Math.round(Number(e.target.value) || 0))) })}
                      className="w-20"
                      aria-label={`${t} 起步分钟`}
                    />
                    分钟
                  </label>
                  <label className="flex items-center gap-1">
                    每
                    <Select value={String(p.stepMinutes)} disabled={!editable || busy} onChange={(e) => setPricing(t, { ...p, stepMinutes: Number(e.target.value) })} aria-label={`${t} 计费单位`} className="w-20">
                      {USAGE_STEP_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                    分钟计一次
                  </label>
                  <Select
                    value={p.openFeeItemId ? String(p.openFeeItemId) : ''}
                    disabled={!editable || busy}
                    onChange={(e) => setPricing(t, { ...p, openFeeItemId: Number(e.target.value) || null })}
                    aria-label={`${t} 开台费项目`}
                    className="w-44"
                  >
                    <option value="">不收开台费</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        开台费：{i.name}（{formatYuan(i.price)}）
                      </option>
                    ))}
                  </Select>
                  {item && (
                    <span className="w-full text-[12px] text-ink-3">
                      {pricingText({ hourPrice: item.price, minMinutes: p.minMinutes, stepMinutes: p.stepMinutes, openFee: open?.price ?? 0 }, formatYuan)}
                    </span>
                  )}
                </>
              )}
            </div>
          );
        })}
        <p className="text-[12px] text-ink-3">房费项目在后台「价目表」里建：价格填每小时多少，分类就是部门营业额里的部门（例如「派对房」）。</p>
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={extra} maxLength={8} onChange={(e) => setExtra(e.target.value)} placeholder="台账里的其他业态名" className="w-44" aria-label="其他业态" />
          <Button
            size="sm"
            variant="ghost"
            disabled={!extra.trim() || current.includes(extra.trim())}
            onClick={() => {
              setDraft([...current, extra.trim()]);
              setExtra('');
            }}
          >
            加上
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="primary" loading={busy} disabled={!dirty} onClick={save} data-testid="usage-rules-save">
            保存
          </Button>
        </div>
      )}
      {!editable && <p className="text-[12.5px] text-ink-3">只有店主能改</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}
