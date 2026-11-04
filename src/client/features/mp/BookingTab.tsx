// 后台「微信小程序」→「预约」（小程序线第三期 3d，docs/MP_PHASE3.md 第 4 节；权限 mp.booking：店主、店总）：
//   · 开关与小程序可约的技师项目、房间，带版本号一起保存，结果待确认照其他开关；
//   · 主线「预约」的规则摆出来看一眼（几点到几点、最远几天、每人同时几个、确认与取消的提前分钟；在后台「预约」里改）；
//   · 小程序来的、还待门店确认的有几张（在门店导航「预约」里确认）；最近 50 次小程序的预约、取消。
// 时段、确认、到店、爽约都在主线的「预约」里；到店提醒的订阅消息模板在「到期提醒」里填。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MpAdminData, MpBookingAdminData, MpBookingStatus } from '@shared/mp';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Notice, Segmented, Skeleton } from '../../components/ui';
import { mpAdminKey, PendingUpdates, updateFailed } from './mpAdminShared';
import { sendUpdate, useMpPending } from './mpPending';

const bookingKey = ['mp', 'bookings'] as const;

const STATUS: Record<MpBookingStatus, { label: string; tone: 'neutral' | 'moss' | 'yuzu' | 'ember' | 'lake' }> = {
  pending: { label: '待确认', tone: 'yuzu' },
  confirmed: { label: '已预约', tone: 'lake' },
  arrived: { label: '已到店', tone: 'moss' },
  cancelled: { label: '已取消', tone: 'neutral' },
  no_show: { label: '爽约', tone: 'ember' },
};

const hours = (m: number) => (m % 60 === 0 ? `${m / 60} 小时` : `${m} 分钟`);

export function BookingTab({ data }: { data: MpAdminData }) {
  const q = useQuery({ queryKey: bookingKey, queryFn: () => api.get<MpBookingAdminData>('/api/admin/mp/bookings') });
  const pending = useMpPending('booking_rules_update');
  if (!q.data) return <Skeleton className="h-48" />;
  const d = q.data;
  return (
    <div className="space-y-4">
      {pending.length > 0 && <PendingUpdates ops={pending} data={data} />}
      {d.pending > 0 && (
        <Notice tone="warning" title={`小程序来的预约还有 ${d.pending} 张待确认`}>
          在门店导航「预约」里确认；开始前 {d.bookingRules.confirmLeadMinutes} 分钟还没确认的会自动取消，顾客那边写「已取消」。
        </Notice>
      )}
      <RulesForm key={data.bookingRules.version} d={d} rules={data.bookingRules} pending={pending.length > 0} />
      <Recent d={d} />
    </div>
  );
}

function RulesForm({ d, rules, pending }: { d: MpBookingAdminData; rules: MpAdminData['bookingRules']; pending: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [enabled, setEnabled] = useState(rules.enabled);
  const [itemIds, setItemIds] = useState<number[]>(rules.itemIds);
  const [spaceIds, setSpaceIds] = useState<number[]>(rules.spaceIds);
  const [saving, setSaving] = useState(false);
  const r = d.bookingRules;
  const save = async () => {
    setSaving(true);
    try {
      await sendUpdate({
        type: 'booking_rules_update',
        url: '/api/admin/mp/bookings/rules',
        target: 'booking_rules',
        body: { enabled, itemIds, spaceIds, version: rules.version },
        summary: '小程序预约的设置',
        staffName: session.staff.displayName,
      });
      await Promise.all([qc.invalidateQueries({ queryKey: mpAdminKey }), qc.invalidateQueries({ queryKey: bookingKey })]);
      toast({ tone: 'success', title: '小程序预约的设置已保存' });
    } catch (error) {
      updateFailed(toast, error);
      void qc.invalidateQueries({ queryKey: mpAdminKey });
    } finally {
      setSaving(false);
    }
  };
  const toggle = (set: (f: (ids: number[]) => number[]) => void, id: number, on: boolean) => set((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-ink">小程序预约</p>
          <p className="text-[13px] text-ink-3">
            绑定了会员的顾客在小程序「我的 → 预约」选项目与技师（或不指定）、派对房等与时长，再选时段；提交后是「待确认」，前台在「预约」里确认。
            不收订金。可约的时段、每人同时几个、爽约限制照后台「预约」的规则。
          </p>
          <p className="num text-[12.5px] text-ink-3">
            现在的规则：{r.openTime}–{r.closeTime}，每 {r.slotMinutes} 分钟一格，最远 {r.maxDaysAhead} 天后；每人同时最多 {r.mpMaxOpen} 个没到店的；
            开始前 {r.confirmLeadMinutes} 分钟还没确认的自动取消；开始前 {hours(r.mpCancelLeadMinutes)}以前顾客可以自己取消。
          </p>
          {pending && <p className="text-[12.5px] text-ember">设置的修改结果待确认，先在上方处理</p>}
        </div>
        <Segmented
          value={enabled ? 'on' : 'off'}
          ariaLabel="小程序预约开关"
          onChange={(v) => setEnabled(v === 'on')}
          options={[
            { value: 'off', label: '关闭', disabled: pending },
            { value: 'on', label: '开通', disabled: pending },
          ]}
        />
      </div>
      <Field label="可约的技师项目" hint="只列启用的、需要技师的项目；时长照项目的服务时长">
        {d.items.length === 0 ? (
          <p className="text-[13px] text-ink-3">还没有需要技师的项目（在「价目与套餐」里把项目设成需要技师）</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {d.items.map((x) => (
              <ConfirmCheck key={x.id} checked={itemIds.includes(x.id)} onChange={(on) => toggle(setItemIds, x.id, on)}>
                {x.name} <span className="num text-ink-3">{x.minutes} 分钟</span>
              </ConfirmCheck>
            ))}
          </div>
        )}
      </Field>
      <Field label="可约的房间" hint="只列启用、可售、开单即占用的房间（派对房、宠物轰趴房、娱乐室……）；时长只能选后台「预约」里的几档">
        {d.spaces.length === 0 ? (
          <p className="text-[13px] text-ink-3">还没有开单即占用的房间（在「空间台账」里设业态、在后台「使用单」里选业态）</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {d.spaces.map((x) => (
              <ConfirmCheck key={x.id} checked={spaceIds.includes(x.id)} onChange={(on) => toggle(setSpaceIds, x.id, on)}>
                {x.name} <span className="num text-ink-3">{x.code}</span>
              </ConfirmCheck>
            ))}
          </div>
        )}
      </Field>
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} disabled={pending} onClick={save}>
          保存小程序预约的设置
        </Button>
      </div>
    </Card>
  );
}

function Recent({ d }: { d: MpBookingAdminData }) {
  return (
    <Card className="p-0">
      <div className="border-b border-line px-4 py-3">
        <p className="text-[15px] font-semibold text-ink">最近的小程序预约</p>
        <p className="text-[13px] text-ink-3">顾客在小程序预约、自己取消的记录；确认、到店、爽约在门店导航「预约」里办</p>
      </div>
      {d.recent.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-3">还没有小程序的预约</p>
      ) : (
        <div className="divide-y divide-line">
          {d.recent.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13.5px]" data-testid="mp-booking-op">
              <span className="num text-ink-3">{formatDateTime(r.createdAt)}</span>
              <span className="font-semibold text-ink">{r.memberName}</span>
              <span className="text-ink-3">{r.action === 'create' ? '预约' : '取消'}</span>
              <span>{r.title}</span>
              <span className="num text-ink-3">
                {r.bookingNo} · {formatDateTime(r.startsAt)}
              </span>
              <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
