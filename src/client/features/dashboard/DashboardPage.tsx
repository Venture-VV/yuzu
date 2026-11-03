import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, NavLink, useParams } from 'react-router';
import { Banknote, BedDouble, ClipboardCheck, Clock3, Star, Ticket, TrendingUp, UsersRound } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS, type DashboardData } from '@shared/checkout';
import type { Permission } from '@shared/permissions';
import type { DutyExtras } from '@shared/reports';
import { api } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { Money } from '../../components/Money';
import { Card, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { Columns, HBars, yuan } from './charts';
import { MembersTab } from './MembersTab';
import { MembershipTab } from '../membership/MembershipTab';
import { OverviewTab } from './OverviewTab';
import { RoomsTab } from './RoomsTab';
import { TechniciansTab } from './TechniciansTab';

// 看板按岗位分页（v0.6.0）：今日（值班经理、收银）、经营总览（总经理）、会员总览（客户经理）；各页按权限显示
// v0.7.0 加「技师业绩」（店主、店总、值班经理）；技师功能关闭时不显示（店主 2026-10-30 定，数据保留，重新开启后照常显示）
// v0.7.4 加「客房」（经营总览的岗位看）；客房功能关闭时同样不显示
const TABS = [
  { key: 'today', label: '今日', perm: 'ledger.readToday' },
  { key: 'overview', label: '经营总览', perm: 'report.executive' },
  { key: 'members', label: '会员总览', perm: 'report.members' },
  // 会员体系 v2（v0.7.23）：各档阶人数、到期提醒名单、补充期、今天的状态变化与每天的自动任务（客户经理、店总、店主）
  { key: 'membership', label: '会员体系', perm: 'member.retention' },
  { key: 'technicians', label: '技师业绩', perm: 'report.technicians' },
  { key: 'rooms', label: '客房', perm: 'report.executive' },
] as const satisfies readonly { key: string; label: string; perm: Permission }[];
type TabKey = (typeof TABS)[number]['key'];

/** 每人自己选的默认页（只存在这台设备的浏览器里） */
const PREF_KEY = 'yuzu.dashboard.default';
const readPref = (): string | null => {
  try {
    return localStorage.getItem(PREF_KEY);
  } catch {
    return null;
  }
};
const writePref = (key: TabKey) => {
  try {
    localStorage.setItem(PREF_KEY, key);
  } catch {
    // 无痕模式等存不了时只是不记住，不影响使用
  }
};

export function DashboardPage() {
  const session = useSession();
  const can = useCan();
  const { tab } = useParams();
  const [pref, setPref] = useState(readPref);
  const tabs = TABS.filter((t) => can(t.perm) && (t.key !== 'technicians' || session.technicians) && (t.key !== 'rooms' || session.rooms));
  const current = tabs.find((t) => t.key === tab) ?? (tab ? undefined : (tabs.find((t) => t.key === pref) ?? tabs[0]));
  if (!current) return <Navigate to={tabs.length ? '/dashboard' : '/'} replace />;
  return (
    <>
      <PageHeader title="经营看板" subtitle={current.key === 'today' ? `营业日 ${session.today} · 每分钟刷新` : '口径与日结一致：按营业日，反结账冲回'} />
      {tabs.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-5 md:px-7" role="tablist" aria-label="看板">
          {tabs.map((t) => (
            <NavLink
              key={t.key}
              to={`/dashboard/${t.key}`}
              role="tab"
              aria-selected={t.key === current.key}
              className={cn('relative flex h-11 items-center px-3.5 text-[14px] font-semibold whitespace-nowrap', t.key === current.key ? 'text-ink' : 'text-ink-3 hover:text-ink')}
              data-testid={`dashboard-tab-${t.key}`}
            >
              {t.label}
              {t.key === current.key && <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-full bg-pine" />}
            </NavLink>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            className={cn('flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-semibold', pref === current.key ? 'text-yuzu-deep' : 'text-ink-3 hover:text-ink')}
            onClick={() => {
              writePref(current.key);
              setPref(current.key);
            }}
            title="打开看板时先显示这一页（只记在这台设备上）"
          >
            <Star className={cn('size-4', pref === current.key && 'fill-yuzu')} />
            {pref === current.key ? '我的默认页' : '设为默认页'}
          </button>
        </div>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1080px] space-y-5 px-5 py-6 md:px-7" data-testid="dashboard">
          {current.key === 'overview' ? (
            <OverviewTab />
          ) : current.key === 'members' ? (
            <MembersTab />
          ) : current.key === 'membership' ? (
            <MembershipTab />
          ) : current.key === 'technicians' ? (
            <TechniciansTab />
          ) : current.key === 'rooms' ? (
            <RoomsTab />
          ) : (
            <TodayTab />
          )}
        </div>
      </div>
    </>
  );
}

/** 今日：在店、营业额与收款、近 7 个营业日、分时、部门、在店最久、当班中（口径与日结一致） */
function TodayTab() {
  const session = useSession();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/api/dashboard'), refetchInterval: 60_000 });
  const duty = useQuery({ queryKey: ['dashboard', 'duty'], queryFn: () => api.get<DutyExtras>('/api/reports/duty'), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <>
          {q.isPending ? (
            <Skeleton className="h-64" />
          ) : q.error ? (
            <Notice tone="error" title={q.error.message} />
          ) : (
            d && (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Kpi icon={<TrendingUp className="size-4" />} label="今日净营业额（应收 − 优惠 − 券抵扣 − 退款）" tone="pine">
                    <Money cents={d.todayStats.net - d.todayStats.discount - (d.todayStats.coupon ?? 0) - (d.todayStats.refund ?? 0)} />
                    {(d.todayStats.discount !== 0 || !!d.todayStats.coupon || !!d.todayStats.refund) && (
                      <span className="block text-[12px] font-semibold text-ink-3" data-testid="dashboard-discount">
                        应收 <Money cents={d.todayStats.net} />
                        {d.todayStats.discount !== 0 && (
                          <>
                            {' '}
                            · 优惠 <Money cents={-d.todayStats.discount} signed />
                          </>
                        )}
                        {!!d.todayStats.coupon && (
                          <>
                            {' '}
                            · 券抵扣 <Money cents={-d.todayStats.coupon} signed />
                          </>
                        )}
                        {!!d.todayStats.refund && (
                          <>
                            {' '}
                            · 退款 <Money cents={-d.todayStats.refund} signed />
                          </>
                        )}
                      </span>
                    )}
                  </Kpi>
                  <Kpi icon={<UsersRound className="size-4" />} label="已结账客人">
                    {d.todayStats.guests} 位 · {d.todayStats.checkouts} 张
                  </Kpi>
                  {d.inStore ? (
                    <Kpi icon={<BedDouble className="size-4" />} label="在店（未结）">
                      {d.inStore.count} 位 · <Money cents={d.inStore.unsettled + d.inStore.ticketEstimate} />
                      {d.inStore.count > 0 && (
                        <span className="block text-[12px] font-semibold text-ink-3" data-testid="dashboard-instore-estimate">
                          已挂 <Money cents={d.inStore.unsettled} /> + 门票估算 <Money cents={d.inStore.ticketEstimate} />
                          {d.inStore.noTicket > 0 && `（${d.inStore.noTicket} 位未选票种，未计入）`}
                        </span>
                      )}
                    </Kpi>
                  ) : (
                    <Kpi icon={<BedDouble className="size-4" />} label="在店（未结）">
                      <span className="text-[14px] font-semibold text-ink-3">前台岗位可见</span>
                    </Kpi>
                  )}
                  <Kpi icon={<Banknote className="size-4" />} label="会员充值实收" tone="lake">
                    <Money cents={d.todayStats.rechargePaid} /> <span className="text-[13px] font-semibold text-ink-3">· {d.todayStats.rechargeCount} 笔</span>
                  </Kpi>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                  <Card className="p-5">
                    <SectionTitle>近 {d.days.length} 个营业日营业额</SectionTitle>
                    <Bars days={d.days} />
                  </Card>
                  <Card className="p-5">
                    <SectionTitle>今日收款构成</SectionTitle>
                    <ul className="mt-3 space-y-2 text-[13px]">
                      {d.todayStats.byMethod.length === 0 && <li className="text-ink-4">今天还没有结账</li>}
                      {d.todayStats.byMethod.map((m) => (
                        <li key={m.method} className="flex justify-between">
                          <span className="text-ink-2">{CHECKOUT_METHOD_LABELS[m.method]}</span>
                          <Money cents={m.amount} className="font-bold" />
                        </li>
                      ))}
                    </ul>
                    <SectionTitle className="mt-5">今日门票</SectionTitle>
                    <ul className="mt-3 space-y-2 text-[13px]">
                      {d.tickets.length === 0 && <li className="text-ink-4">今天还没有结账</li>}
                      {d.tickets.map((t) => (
                        <li key={t.name} className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-ink-2">
                            <Ticket className="size-3.5 text-pine" />
                            {t.name} <span className="text-ink-3">· {t.count} 位</span>
                          </span>
                          <Money cents={t.amount} className="font-bold" />
                        </li>
                      ))}
                    </ul>
                  </Card>
                </div>

                {duty.data && <DutyCards duty={duty.data} startHour={session.rules.businessDayStartHour} />}

                <Card className="p-5">
                  <SectionTitle>
                    <span className="flex items-center gap-2">
                      <ClipboardCheck className="size-4 text-pine" /> 当班中
                    </span>
                  </SectionTitle>
                  {d.openShifts.length === 0 ? (
                    <p className="mt-2 text-[13px] text-ink-3">没有未交班的班次</p>
                  ) : (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {d.openShifts.map((s) => (
                        <li key={s.shiftNo} className="rounded-full bg-pine-tint px-3 py-1 text-[13px] font-semibold text-pine">
                          {s.staffName} · {formatTime(s.startedAt)} 开班
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </>
            )
          )}
    </>
  );
}

/** 值班数据：分时到店与结账、今日部门构成、在店最久的客人 */
function DutyCards({ duty, startHour }: { duty: DutyExtras; startHour: number }) {
  const hh = (h: number) => String(h).padStart(2, '0');
  const now = Date.now();
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-5" data-testid="dashboard-hourly">
          <SectionTitle aside={<span className="text-[12px] text-ink-3">从 {hh(startHour)}:00 营业日切换起</span>}>今日分时</SectionTitle>
          <p className="mt-2 text-[12.5px] font-semibold text-ink-3">到店（人）</p>
          <Columns
            label="今日各小时到店人数"
            height="h-20"
            format={String}
            items={duty.hourly.map((h) => ({ key: `a${h.hour}`, label: hh(h.hour), value: h.arrivals, title: `${hh(h.hour)}:00 起到店 ${h.arrivals} 位` }))}
          />
          <p className="mt-3 text-[12.5px] font-semibold text-ink-3">结账（张）</p>
          <Columns
            label="今日各小时结账张数"
            height="h-20"
            format={String}
            items={duty.hourly.map((h) => ({ key: `c${h.hour}`, label: hh(h.hour), value: h.checkouts, title: `${hh(h.hour)}:00 起结账 ${h.checkouts} 张` }))}
          />
        </Card>
        <Card className="p-5">
          <SectionTitle aside={<span className="text-[12px] text-ink-3">结账明细，反结账冲回</span>}>今日部门构成</SectionTitle>
          <HBars testId="dashboard-departments" format={yuan} empty="今天还没有结账" rows={duty.departments.map((x) => ({ key: x.category, label: x.category, value: x.amount, note: `${x.quantity} 项${x.discount ? ` · 优惠 ${yuan(x.discount)}` : ''}${x.refund ? ` · 退款 ${yuan(x.refund)}` : ''}` }))} />
        </Card>
      </div>
      {duty.longStays && duty.longStays.length > 0 && (
        <Card className="p-5" data-testid="dashboard-long-stays">
          <SectionTitle>
            <span className="flex items-center gap-2">
              <Clock3 className="size-4 text-pine" /> 在店最久
            </span>
          </SectionTitle>
          <ul className="mt-2 grid grid-cols-1 gap-x-6 text-[13px] sm:grid-cols-2">
            {duty.longStays.map((v) => {
              const minutes = Math.max(0, Math.round((now - new Date(v.checkedInAt).getTime()) / 60_000));
              return (
                <li key={v.visitId} className="flex items-center gap-2 border-b border-line/60 py-1.5">
                  <span className="num w-14 font-bold text-ink">{v.tagCode}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">{v.guest}</span>
                  <span className={cn('num text-[12px]', minutes >= 12 * 60 ? 'font-bold text-clay' : 'text-ink-3')}>
                    {formatTime(v.checkedInAt)} 入场 · {Math.floor(minutes / 60)} 时 {minutes % 60} 分
                  </span>
                  <Money cents={v.amountCents} className="w-20 text-right font-semibold" />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}

function Kpi({ icon, label, children, tone }: { icon: React.ReactNode; label: string; children: React.ReactNode; tone?: 'pine' | 'lake' }) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
        {icon}
        {label}
      </p>
      <p className={cn('mt-1.5 text-[22px] leading-tight font-bold', tone === 'pine' ? 'text-pine' : tone === 'lake' ? 'text-lake' : 'text-ink')}>{children}</p>
    </Card>
  );
}

function Bars({ days }: { days: DashboardData['days'] }) {
  const max = Math.max(1, ...days.map((d) => d.net));
  return (
    <div className="mt-4 flex h-44 items-end gap-2" role="img" aria-label="近几个营业日营业额">
      {days.map((d) => (
        <div key={d.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className="num text-[11px] text-ink-3">{d.net ? `¥${Math.round(d.net / 100)}` : ''}</span>
          <div className="flex w-full flex-1 items-end">
            <div className="w-full rounded-t-md bg-pine/80" style={{ height: `${Math.max(2, (Math.max(0, d.net) / max) * 100)}%` }} title={`${d.date} 营业额 ¥${(d.net / 100).toFixed(2)}，结账 ${d.checkouts} 张`} />
          </div>
          <span className="num text-[11px] text-ink-3">{d.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
