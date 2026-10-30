// 后台「技师」里的钟房与轮钟规则、技师提成（v0.7.1）。两类规则都只有店主能改；提成每次保存是一个新版本，
// 按结账时刻取当时的版本，改规则不影响已经结了的钟。

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { PRICE_TIER_LABELS, PRICE_TIERS, type PriceTier } from '@shared/catalog';
import {
  AFTER_DESIGNATED_LABELS,
  AFTER_ROTATION_LABELS,
  DEFAULT_CLOCKROOM_RULES,
  describeCommissionBase,
  lineCommission,
  type ClockroomRules,
  type CommissionBase,
  type CommissionRules,
  type CommissionSettings,
} from '@shared/clockroom';
import { parseYuan } from '@shared/money';
import type { TechnicianAdmin } from '@shared/technicians';
import { api, errorMessage } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';

const adminKey = ['admin', 'technicians'] as const;

export function ClockroomRulesCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const admin = useQuery({ queryKey: adminKey, queryFn: () => api.get<TechnicianAdmin>('/api/admin/technicians') });
  const [draft, setDraft] = useState<ClockroomRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (admin.data && !draft) setDraft(admin.data.clockroomRules);
  if (!draft || !admin.data) return <Skeleton className="h-56" />;
  const editable = can('settings.manage');
  const dirty = JSON.stringify(draft) !== JSON.stringify(admin.data.clockroomRules);
  const set = (patch: Partial<ClockroomRules>) => editable && setDraft({ ...draft, ...patch });
  const onOff = (v: boolean) => (v ? 'on' : 'off');
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Number.parseInt(v || '0', 10) || 0));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<TechnicianAdmin>('/api/admin/technicians/clockroom-rules', draft);
      qc.setQueryData(adminKey, next);
      setDraft(next.clockroomRules);
      await qc.invalidateQueries({ queryKey: ['clockroom'] });
      toast({ tone: 'success', title: '钟房与轮钟规则已保存', body: '之后的派钟、下钟、退钟按新规则排位。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-[200px] flex-1">
        <p className="flex items-center gap-2 text-[14px] font-bold">
          {label} <PendingBadge title="按汤泉、足浴行业常见做法先定的默认，待店主确认" />
        </p>
        <p className="text-[12.5px] text-ink-3">{hint}</p>
      </div>
      {control}
    </div>
  );

  return (
    <Card className="p-5" data-testid="clockroom-rules-card">
      <SectionTitle aside={!editable && <Badge>只有店主能改</Badge>}>钟房与轮钟规则</SectionTitle>
      <div className="mt-1 divide-y divide-line/70">
        {row(
          '轮钟排到队尾',
          '技师按上牌先后排队，轮钟派给排在第一位、空闲的技师。',
          <Segmented ariaLabel="轮钟排到队尾" value={draft.afterRotation} onChange={(v) => set({ afterRotation: v })} options={(['dispatch', 'finish'] as const).map((v) => ({ value: v, label: AFTER_ROTATION_LABELS[v], disabled: !editable }))} className="flex-wrap" />,
        )}
        {row(
          '点钟后的排位',
          '客人点名的钟会不会占技师的轮次。',
          <Segmented ariaLabel="点钟后的排位" value={draft.afterDesignated} onChange={(v) => set({ afterDesignated: v })} options={(['keep', 'passed', 'end'] as const).map((v) => ({ value: v, label: AFTER_DESIGNATED_LABELS[v], disabled: !editable }))} className="flex-wrap" />,
        )}
        {row(
          '被退钟、取消派钟',
          '客人不满意换技师（退钟）或还没上钟就取消时，技师回到派钟前的位置；连续被退钟到次数排到队尾（0 为不排）。',
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              ariaLabel="被退钟回原位"
              value={onOff(draft.rejectKeepsPlace)}
              onChange={(v) => set({ rejectKeepsPlace: v === 'on' })}
              options={[
                { value: 'on', label: '回到原位', disabled: !editable },
                { value: 'off', label: '不回原位', disabled: !editable },
              ]}
            />
            <span className="text-[13px] text-ink-3">连续</span>
            <Input value={String(draft.rejectEndAfter)} inputMode="numeric" disabled={!editable} onChange={(e) => set({ rejectEndAfter: num(e.target.value, 0, 20) })} fullWidth={false} className="num h-9 w-14" aria-label="连续被退钟次数" />
            <span className="text-[13px] text-ink-3">次排到队尾</span>
          </div>,
        )}
        {row(
          '休息回牌',
          '休息、离岗后回来上牌的位置。',
          <Segmented
            ariaLabel="休息回牌"
            value={onOff(draft.backToEnd)}
            onChange={(v) => set({ backToEnd: v === 'on' })}
            options={[
              { value: 'on', label: '排到队尾', disabled: !editable },
              { value: 'off', label: '回到原位', disabled: !editable },
            ]}
          />,
        )}
        {row(
          '轮钟跳过排第一的技师',
          '客人要女技师、技师不会做等原因改派时，被跳过的技师不动牌；原因记进钟房日志，排钟是否公平可以查。',
          <Segmented
            ariaLabel="轮钟跳过要写原因"
            value={onOff(draft.skipNeedsReason)}
            onChange={(v) => set({ skipNeedsReason: v === 'on' })}
            options={[
              { value: 'on', label: '必须写原因', disabled: !editable },
              { value: 'off', label: '不用写', disabled: !editable },
            ]}
          />,
        )}
        {row(
          '加钟',
          '原技师继续做；记为点钟时按点钟算提成（客人选了继续让这位技师做）。',
          <Segmented
            ariaLabel="加钟记为点钟"
            value={onOff(draft.extensionAsDesignated)}
            onChange={(v) => set({ extensionAsDesignated: v === 'on' })}
            options={[
              { value: 'on', label: '记为点钟', disabled: !editable },
              { value: 'off', label: '按原上钟方式', disabled: !editable },
            ]}
          />,
        )}
        {row(
          '上钟计时',
          '项目里没写时长时一钟按多少分钟；快到钟提前几分钟在钟房提醒。',
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
            一钟
            <Input value={String(draft.defaultMinutes)} inputMode="numeric" disabled={!editable} onChange={(e) => set({ defaultMinutes: num(e.target.value, 10, 240) })} fullWidth={false} className="num h-9 w-16" aria-label="一钟分钟数" />
            分钟，提前
            <Input value={String(draft.remindMinutes)} inputMode="numeric" disabled={!editable} onChange={(e) => set({ remindMinutes: num(e.target.value, 0, 60) })} fullWidth={false} className="num h-9 w-14" aria-label="提前提醒分钟数" />
            分钟提醒
          </div>,
        )}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-[12px] text-ink-4">
          {admin.data.clockroomUpdatedAt ? `最近由${admin.data.clockroomUpdatedBy ?? '系统'}于 ${formatDateTime(admin.data.clockroomUpdatedAt)} 修改` : '一直按默认'}
        </span>
        {editable && JSON.stringify(draft) !== JSON.stringify(DEFAULT_CLOCKROOM_RULES) && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(DEFAULT_CLOCKROOM_RULES)}>
            恢复默认
          </Button>
        )}
        {editable && (
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={save} data-testid="clockroom-rules-save">
            保存钟房与轮钟规则
          </Button>
        )}
      </div>
    </Card>
  );
}

type BaseDraft = { kind: 'percent'; rate: string } | { kind: 'fixed'; perClock: Record<PriceTier, string> };
const toDraft = (b: CommissionBase): BaseDraft =>
  b.kind === 'percent'
    ? { kind: 'percent', rate: String(b.rateBp / 100) }
    : { kind: 'fixed', perClock: Object.fromEntries(PRICE_TIERS.map((t) => [t, b.perClock[t] !== undefined ? String(b.perClock[t]! / 100) : ''])) as Record<PriceTier, string> };
const fromDraft = (d: BaseDraft): CommissionBase | string => {
  if (d.kind === 'percent') {
    const n = Number(d.rate);
    if (!/^\d+(\.\d{1,2})?$/.test(d.rate.trim()) || n > 100) return '比例请填 0–100，最多两位小数';
    return { kind: 'percent', rateBp: Math.round(n * 100) };
  }
  const perClock: Partial<Record<PriceTier, number>> = {};
  for (const t of PRICE_TIERS) {
    if (!d.perClock[t].trim()) continue;
    const c = parseYuan(d.perClock[t]);
    if (c === null) return `${PRICE_TIER_LABELS[t]}档金额不正确`;
    perClock[t] = c;
  }
  if (!Object.keys(perClock).length) return '每钟固定金额请至少填一档';
  return { kind: 'fixed', perClock };
};

function BaseEditor({ value, onChange, disabled, label }: { value: BaseDraft; onChange: (v: BaseDraft) => void; disabled: boolean; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        size="sm"
        ariaLabel={`${label}提成方式`}
        value={value.kind}
        onChange={(k) => onChange(k === 'percent' ? { kind: 'percent', rate: '40' } : { kind: 'fixed', perClock: { standard: '', professional: '', premium: '' } })}
        options={[
          { value: 'percent', label: '按售价比例', disabled },
          { value: 'fixed', label: '每钟固定金额', disabled },
        ]}
      />
      {value.kind === 'percent' ? (
        <span className="flex items-center gap-1 text-[13px] text-ink-3">
          <Input value={value.rate} inputMode="decimal" disabled={disabled} onChange={(e) => onChange({ kind: 'percent', rate: e.target.value })} fullWidth={false} className="num h-9 w-20" aria-label={`${label}提成比例`} />%
        </span>
      ) : (
        PRICE_TIERS.map((t) => (
          <span key={t} className="flex items-center gap-1 text-[13px] text-ink-3">
            {PRICE_TIER_LABELS[t]} ¥
            <Input
              value={value.perClock[t]}
              inputMode="decimal"
              disabled={disabled}
              onChange={(e) => onChange({ kind: 'fixed', perClock: { ...value.perClock, [t]: e.target.value } })}
              fullWidth={false}
              className="num h-9 w-20"
              aria-label={`${label}${PRICE_TIER_LABELS[t]}档每钟提成`}
            />
          </span>
        ))
      )}
    </div>
  );
}

export function CommissionCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useCatalog(true);
  const q = useQuery({ queryKey: ['admin', 'commission'], queryFn: () => api.get<CommissionSettings>('/api/admin/technicians/commission') });
  const [base, setBase] = useState<BaseDraft | null>(null);
  const [bonus, setBonus] = useState('');
  const [items, setItems] = useState<{ itemId: number; base: BaseDraft }[]>([]);
  const [note, setNote] = useState('');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const r = q.data.current.rules;
    setBase(toDraft(r.base));
    setBonus(String(r.designatedBonus / 100));
    setItems(Object.entries(r.items).map(([id, b]) => ({ itemId: Number(id), base: toDraft(b) })));
    setNote('');
  }, [q.data]);
  const techItems = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.technicianRequired), [catalog.data]);
  if (!q.data || !base) return <Skeleton className="h-56" />;
  const editable = can('settings.manage');

  const built = (() => {
    const b = fromDraft(base);
    if (typeof b === 'string') return b;
    const bonusCents = bonus.trim() ? parseYuan(bonus) : 0;
    if (bonusCents === null) return '点钟奖励金额不正确';
    const map: Record<string, CommissionBase> = {};
    for (const it of items) {
      const x = fromDraft(it.base);
      if (typeof x === 'string') return `${techItems.find((i) => i.id === it.itemId)?.name ?? '项目'}：${x}`;
      map[String(it.itemId)] = x;
    }
    return { base: b, designatedBonus: bonusCents, items: map } satisfies CommissionRules;
  })();
  const problem = typeof built === 'string' ? built : null;
  const rules = typeof built === 'string' ? null : built;
  const dirty = rules ? JSON.stringify(rules) !== JSON.stringify(q.data.current.rules) : true;
  // 试算：每个需要技师的项目、每档价格的一钟，轮钟 / 点钟各多少
  const sample = rules
    ? techItems.slice(0, 6).flatMap((i) =>
        i.prices.map((p) => ({
          key: `${i.id}:${p.tier}`,
          name: i.prices.length > 1 ? `${i.name}（${PRICE_TIER_LABELS[p.tier]}）` : i.name,
          price: p.price,
          rotation: lineCommission(rules, { itemId: i.id, tier: p.tier, quantity: 1, amount: p.price, callType: 'rotation' }),
          designated: lineCommission(rules, { itemId: i.id, tier: p.tier, quantity: 1, amount: p.price, callType: 'designated' }),
        })),
      )
    : [];

  const save = async () => {
    if (!rules) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<CommissionSettings>('/api/admin/technicians/commission', { rules, note: note.trim() });
      qc.setQueryData(['admin', 'commission'], next);
      toast({ tone: 'success', title: '提成规则已保存', body: '之后结账的钟按新规则；已经结了的钟照旧。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="commission-card">
      <SectionTitle aside={!editable && <Badge>只有店主能改</Badge>}>
        <span className="inline-flex items-center gap-2">
          技师提成 <PendingBadge title="默认按售价 40%、点钟每钟另加 ¥10，待店主确认" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        提成按结账算：结账那一刻账单上的技师明细，反结账冲回；优惠 / 免单照常提成（店里承担），退钟作废的不提。每次保存是一个新版本，按结账时刻取当时的版本，改规则不影响已经结了的钟。
      </p>
      <div className="mt-4 space-y-4">
        <Field label="默认（没有单独设置的项目）">
          <BaseEditor value={base} onChange={(v) => editable && setBase(v)} disabled={!editable} label="默认" />
        </Field>
        <Field label="点钟每钟另加（元）" hint="加钟记为点钟时同样另加">
          <Input value={bonus} inputMode="decimal" disabled={!editable} onChange={(e) => setBonus(e.target.value)} fullWidth={false} className="num h-9 w-28" aria-label="点钟奖励" data-testid="commission-bonus" />
        </Field>
        <Field label="单独设置的项目">
          <div className="space-y-2">
            {items.length === 0 && <p className="text-[12.5px] text-ink-3">都按默认</p>}
            {items.map((it, i) => (
              <div key={it.itemId} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
                <span className="min-w-[120px] text-[13.5px] font-semibold">{techItems.find((x) => x.id === it.itemId)?.name ?? `项目 ${it.itemId}`}</span>
                <BaseEditor value={it.base} onChange={(v) => editable && setItems(items.map((x, j) => (j === i ? { ...x, base: v } : x)))} disabled={!editable} label={techItems.find((x) => x.id === it.itemId)?.name ?? ''} />
                {editable && (
                  <button type="button" aria-label="移除" className="ml-auto flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-clay-soft hover:text-clay" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            ))}
            {editable && (
              <div className="flex flex-wrap items-center gap-2">
                <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-9 rounded-md border border-line-strong bg-card px-2 text-[13px]" aria-label="选择项目">
                  <option value="">选择需要技师的项目…</option>
                  {techItems.filter((i) => !items.some((x) => x.itemId === i.id)).map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={!pick} onClick={() => { setItems([...items, { itemId: Number(pick), base: { kind: 'fixed', perClock: { standard: '', professional: '', premium: '' } } }]); setPick(''); }}>
                  单独设置
                </Button>
              </div>
            )}
          </div>
        </Field>
        {sample.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[440px] text-[12.5px]" data-testid="commission-sample">
              <thead className="bg-paper-2/70 font-bold text-ink-3">
                <tr>
                  <th className="px-3 py-1.5 text-left">试算：一钟</th>
                  <th className="px-3 py-1.5 text-right">售价</th>
                  <th className="px-3 py-1.5 text-right">轮钟提成</th>
                  <th className="px-3 py-1.5 text-right">点钟提成</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {sample.map((r) => (
                  <tr key={r.key}>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Money cents={r.price} />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Money cents={r.rotation.base + r.rotation.bonus} />
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold">
                      <Money cents={r.designated.base + r.designated.bonus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && (
          <Field label="这次修改的说明（选填）" htmlFor="commission-note">
            <Input id="commission-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} placeholder="例如：11 月起足疗按每钟定额" />
          </Field>
        )}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-[12px] text-ink-4">
          现在：{describeCommissionBase(q.data.current.rules.base)}
          {q.data.current.effectiveAt ? ` · ${formatDateTime(q.data.current.effectiveAt)} 起，${q.data.current.createdByName ?? ''}` : ' · 默认规则'}
        </span>
        {problem && <span className="text-[13px] text-clay">{problem}</span>}
        {editable && (
          <Button variant="primary" loading={busy} disabled={!!problem || !dirty} onClick={save} data-testid="commission-save">
            保存为新版本
          </Button>
        )}
      </div>
      {q.data.history.length > 0 && (
        <details className="mt-3 text-[12.5px] text-ink-3">
          <summary className="cursor-pointer font-semibold">历史版本 {q.data.history.length} 个</summary>
          <ul className="mt-2 space-y-1">
            {q.data.history.map((v) => (
              <li key={v.id}>
                第 {v.id} 版 · {v.effectiveAt && formatDateTime(v.effectiveAt)} · {v.createdByName} · {describeCommissionBase(v.rules.base)}，点钟另加 ¥{(v.rules.designatedBonus / 100).toFixed(2)}
                {Object.keys(v.rules.items).length ? `，${Object.keys(v.rules.items).length} 个项目单独设置` : ''}
                {v.note && ` · ${v.note}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
