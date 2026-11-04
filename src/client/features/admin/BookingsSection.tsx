// 后台「预约」（v0.7.28 ③，N4，docs/SCHEDULE_FINISH.md 第 4 节）：能约的时段、一格多长、最远约几天后，
// 小程序预约的限制（每人同时几个、多久没确认自动取消、多久以前可以自己取消），爽约规则，派对房等能约的时长、
// 技师项目默认时长、客房电话预订保留多久。都是待确认的默认值，店主改了只影响之后的预约。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_BOOKING_RULES, type BookingRules } from '@shared/bookings';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { AdminPage } from './AdminShell';

const key = ['admin', 'booking-rules'] as const;

type NumberKey = Exclude<keyof BookingRules, 'openTime' | 'closeTime' | 'slotMinutes' | 'spaceDurations'>;
type Draft = { openTime: string; closeTime: string; slotMinutes: '15' | '30' | '60'; spaceDurations: string } & Record<NumberKey, string>;

const NUMBER_FIELDS: { key: NumberKey; label: string; unit: string; hint?: string }[][] = [
  [{ key: 'maxDaysAhead', label: '最远能约', unit: '天后', hint: '0 为只能约当天' }],
  [
    { key: 'mpMaxOpen', label: '小程序每人同时最多', unit: '个', hint: '没到店、没取消的预约' },
    { key: 'confirmLeadMinutes', label: '开始前多少分钟还没确认自动取消', unit: '分钟', hint: '小程序的预约要前台确认' },
    { key: 'mpCancelLeadMinutes', label: '开始前多少分钟以前客人可以自己取消', unit: '分钟' },
  ],
  [
    { key: 'noShowMinutes', label: '过了开始时间多久没到店记爽约', unit: '分钟' },
    { key: 'noShowWindowDays', label: '爽约统计最近', unit: '天' },
    { key: 'noShowLimit', label: '爽约达到', unit: '次' },
    { key: 'noShowBanDays', label: '之后不能在小程序预约', unit: '天', hint: '0 为不限制；前台、电话照常能约' },
  ],
  [
    { key: 'defaultServiceMinutes', label: '技师项目没写时长时按', unit: '分钟' },
    { key: 'roomHoldMinutes', label: '客房电话预订保留到预计到店后', unit: '分钟', hint: '过了自动释放、记爽约' },
  ],
];

const toDraft = (r: BookingRules): Draft => ({
  openTime: r.openTime,
  closeTime: r.closeTime,
  slotMinutes: String(r.slotMinutes) as Draft['slotMinutes'],
  spaceDurations: r.spaceDurations.join('、'),
  ...(Object.fromEntries(NUMBER_FIELDS.flat().map((f) => [f.key, String(r[f.key])])) as Record<NumberKey, string>),
});

/** 把草稿换成要提交的规则；数字不对时留给服务端报中文原因 */
const fromDraft = (d: Draft): Record<string, unknown> => ({
  openTime: d.openTime.trim(),
  closeTime: d.closeTime.trim(),
  slotMinutes: Number(d.slotMinutes),
  spaceDurations: d.spaceDurations
    .split(/[、,，\s]+/)
    .filter(Boolean)
    .map((x) => Number(x)),
  ...Object.fromEntries(NUMBER_FIELDS.flat().map((f) => [f.key, d[f.key].trim() === '' ? null : Number(d[f.key])])),
});

export function BookingsSection() {
  return (
    <AdminPage section="bookings" description="预约技师、派对房等、客房电话预订：能约的时段，小程序预约的限制与自动取消，爽约规则。修改只影响之后的预约。">
      <BookingRulesCard />
    </AdminPage>
  );
}

function BookingRulesCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: key, queryFn: () => api.get<BookingRules>('/api/admin/booking-rules') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!rules.data) return <Skeleton className="h-72" />;
  const current = draft ?? toDraft(rules.data);
  const editable = can('settings.manage');
  const set = (patch: Partial<Draft>) => setDraft({ ...current, ...patch });
  const isDefault = JSON.stringify(toDraft(rules.data)) === JSON.stringify(toDraft(DEFAULT_BOOKING_RULES));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<BookingRules>('/api/admin/booking-rules', fromDraft(current));
      qc.setQueryData(key, next);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['bookings'] });
      toast({ tone: 'success', title: '预约规则已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-4 p-5" data-testid="booking-rules">
      <div className="flex items-center gap-2">
        <SectionTitle>预约规则</SectionTitle>
        {isDefault && <PendingBadge />}
      </div>
      <p className="text-[13px] leading-relaxed text-ink-2">
        前台、电话的预约直接「已预约」；小程序的先「待确认」，前台确认。不收订金、不动钱。同一位技师、同一间房的时段不能重叠，客房按房型的间数算。
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="能约的时段从" htmlFor="booking-open">
          <Input id="booking-open" value={current.openTime} disabled={!editable || busy} onChange={(e) => set({ openTime: e.target.value })} placeholder="11:00" data-testid="booking-rule-open" />
        </Field>
        <Field label="到" htmlFor="booking-close" hint="不晚于开始时间表示到次日">
          <Input id="booking-close" value={current.closeTime} disabled={!editable || busy} onChange={(e) => set({ closeTime: e.target.value })} placeholder="02:00" data-testid="booking-rule-close" />
        </Field>
        <Field label="一格">
          <Segmented
            value={current.slotMinutes}
            onChange={(v) => editable && !busy && set({ slotMinutes: v })}
            options={[
              { value: '15', label: '15 分钟', disabled: !editable || busy },
              { value: '30', label: '30 分钟', disabled: !editable || busy },
              { value: '60', label: '60 分钟', disabled: !editable || busy },
            ]}
            ariaLabel="一格多少分钟"
          />
        </Field>
      </div>
      {NUMBER_FIELDS.map((group, i) => (
        <div key={i} className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
          {group.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`booking-${f.key}`} hint={f.hint}>
              <div className="flex items-center gap-2">
                <Input
                  id={`booking-${f.key}`}
                  type="number"
                  inputMode="numeric"
                  value={current[f.key]}
                  disabled={!editable || busy}
                  onChange={(e) => set({ [f.key]: e.target.value } as Partial<Draft>)}
                  fullWidth={false}
                  className="w-24"
                  data-testid={`booking-rule-${f.key}`}
                />
                <span className="text-[13px] text-ink-3">{f.unit}</span>
              </div>
            </Field>
          ))}
        </div>
      ))}
      <div className="border-t border-line pt-4">
        <Field label="派对房等能约的时长（分钟，用顿号隔开）" htmlFor="booking-durations" hint="例如 120、180、240；最多 8 个">
          <Input
            id="booking-durations"
            value={current.spaceDurations}
            disabled={!editable || busy}
            onChange={(e) => set({ spaceDurations: e.target.value })}
            data-testid="booking-rule-durations"
          />
        </Field>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {editable ? (
        <div className="flex gap-2">
          <Button variant="primary" onClick={save} disabled={busy || draft === null} data-testid="booking-rules-save">
            {busy ? '保存中…' : '保存'}
          </Button>
          {draft !== null && (
            <Button variant="ghost" disabled={busy} onClick={() => (setDraft(null), setError(null))}>
              撤销修改
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-3">只有能改经营规则的岗位可以修改。</p>
      )}
    </Card>
  );
}
