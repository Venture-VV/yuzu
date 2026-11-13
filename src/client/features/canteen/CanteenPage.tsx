// ERP「员工食堂」（docs/CANTEEN.md）：今天的概况、员工名单与开通卡片、菜单（只看）、用餐记录、柚子信箱、饭点提醒（第 19 节）、设置（含注册二维码）。
// 员工、厨师、食堂负责人用的是手机上的「柚子饭堂」（员工端口）；这里给管理员管名单、看记录、回员工的话。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle } from 'lucide-react';
import { MEAL_EMOJI, MEAL_LABELS, MEALS, type CanteenOverview, type Meal } from '@shared/canteen';
import { api } from '../../lib/api';
import { relativeTime } from '../../lib/utils';
import { Badge, Card, Notice, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { Mascot } from '../../../canteen-app/Mascot';
import { AdminModuleGate, AdminPage } from '../admin/AdminShell';
import { FeedbackTab } from './FeedbackTab';
import { MenusTab } from './MenusTab';
import { RecordsTab } from './RecordsTab';
import { RemindersTab } from './RemindersTab';
import { RosterTab } from './RosterTab';
import { SettingsTab } from './SettingsTab';

type Tab = 'today' | 'roster' | 'menus' | 'records' | 'mailbox' | 'reminders' | 'settings';

export const useOverview = () => useQuery({ queryKey: ['canteen', 'overview'], queryFn: () => api.get<CanteenOverview>('/api/erp/canteen/overview'), refetchInterval: 60_000 });

export function CanteenPage() {
  return (
    <AdminPage section="canteen" description="员工手机上的「柚子饭堂」：扫码自己登记、看菜单、点赞、亮饭卡码、跟柚子说；食堂负责人扫码打卡、厨师发布菜单。这里管注册二维码与名单、看用餐记录、回员工的话。">
      {/* 模块关着时不画里面的内容（里面一进来就取数，接口会被拒绝） */}
      <AdminModuleGate section="canteen">
        <CanteenBody />
      </AdminModuleGate>
    </AdminPage>
  );
}

function CanteenBody() {
  const [tab, setTab] = useState<Tab>('today');
  const overview = useOverview();
  const unread = overview.data?.feedbackUnread ?? 0;
  return (
      <div className="space-y-5" data-testid="canteen-page">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          ariaLabel="员工食堂"
          options={[
            { value: 'today', label: '今天' },
            { value: 'roster', label: '员工名单' },
            { value: 'menus', label: '菜单' },
            { value: 'records', label: '用餐记录' },
            { value: 'mailbox', label: unread ? `柚子信箱 · ${unread}` : '柚子信箱' },
            { value: 'reminders', label: '饭点提醒' },
            { value: 'settings', label: '设置' },
          ]}
        />
        {tab === 'today' && <TodayTab go={setTab} />}
        {tab === 'roster' && <RosterTab />}
        {tab === 'menus' && <MenusTab />}
        {tab === 'records' && <RecordsTab />}
        {tab === 'mailbox' && <FeedbackTab />}
        {tab === 'reminders' && <RemindersTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
  );
}

function TodayTab({ go }: { go: (t: Tab) => void }) {
  const q = useOverview();
  const o = q.data;
  if (!o) return q.isError ? <Notice tone="error" title="取不到员工食堂的概况" /> : <Skeleton className="h-64" />;
  const meals = o.settings.meals.filter((m) => m.enabled).map((m) => m.meal);
  const reg = o.registration;
  const steps = [
    { done: o.settings.departmentId !== null, label: '选好食堂部门', detail: o.departmentName ?? '还没选', tab: 'settings' as Tab },
    { done: !!o.settings.portalUrl, label: '填员工入口地址（注册二维码、开通卡片都用它）', detail: o.settings.portalUrl || '还没填', tab: 'settings' as Tab },
    {
      done: reg.enabled,
      label: '打开自己登记，把注册二维码发到员工群或贴在饭堂（大家扫码自己登记）',
      detail: !reg.enabled ? '自己登记关着' : `已经有 ${reg.selfRegistered} 位自己登记`,
      tab: 'settings' as Tab,
    },
    { done: o.people.managers > 0, label: '在名单里安排食堂负责人和厨师', detail: `在用 ${o.people.active} 位 · 负责人 ${o.people.managers} · 厨师 ${o.people.cooks}`, tab: 'roster' as Tab },
  ];
  const ready = steps.every((s) => s.done);
  const maxDay = Math.max(1, ...o.days.map((d) => MEALS.reduce((n, m) => n + d.counts[m], 0)));
  return (
    <div className="space-y-5">
      {!o.portOpen && (
        <Notice tone="warning" title="这台 yuzu 还没开员工端口" data-testid="canteen-port-closed">
          员工的手机要经员工端口打开「柚子饭堂」：部署时设 <code>CANTEEN_PORT</code> 与 <code>CANTEEN_CODE_SECRET</code>，再经网关服务器的 HTTPS 转发（docs/CANTEEN.md 第 9 节）。名单、开通卡片可以先在这里准备好。
        </Notice>
      )}
      {!ready && (
        <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center" data-testid="canteen-setup">
          <Mascot mood="wink" pose="point" className="h-28 w-auto shrink-0 self-center" />
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-bold">开张前还差几步</p>
            <ol className="mt-2 space-y-1.5">
              {steps.map((s) => (
                <li key={s.label} className="flex items-center gap-2 text-[13.5px]">
                  {s.done ? <CheckCircle2 className="size-4 shrink-0 text-pine" /> : <Circle className="size-4 shrink-0 text-ink-4" />}
                  <button type="button" onClick={() => go(s.tab)} className={s.done ? 'text-ink-3' : 'font-semibold text-ink hover:underline'}>
                    {s.label}
                  </button>
                  <span className="truncate text-[12.5px] text-ink-3">{s.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {meals.map((m) => (
          <Card key={m} className={`p-4 ${o.today.current?.meal === m ? 'ring-2 ring-yuzu' : ''}`} data-testid={`canteen-count-${m}`}>
            <p className="text-[13px] font-semibold text-ink-3">
              {MEAL_EMOJI[m]} 今天{MEAL_LABELS[m]}
              {o.today.current?.meal === m && <Badge tone="yuzu" className="ml-1.5">开饭中</Badge>}
            </p>
            <p className="num mt-1 text-[30px] leading-none font-bold">{o.today.counts[m]}</p>
            <p className="mt-1 text-[12px] text-ink-3">人</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-5">
          <SectionTitle>最近 14 天每天多少人吃饭</SectionTitle>
          <div className="mt-4 flex h-40 items-end gap-1.5" data-testid="canteen-days">
            {o.days.map((d) => {
              const total = MEALS.reduce((n, m) => n + d.counts[m], 0);
              return (
                <div key={d.date} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${d.date}：${meals.map((m) => `${MEAL_LABELS[m]} ${d.counts[m]}`).join('，')}`}>
                  <span className="num text-[10.5px] text-ink-3">{total || ''}</span>
                  <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-md" style={{ height: `${(total / maxDay) * 120}px` }}>
                    {meals.map((m) => (
                      <div key={m} className={MEAL_BAR[m]} style={{ height: `${total ? (d.counts[m] / total) * 100 : 0}%` }} />
                    ))}
                  </div>
                  <span className="num text-[10.5px] text-ink-3">{Number(d.date.slice(8))}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-[12px] text-ink-3">
            {meals.map((m) => (
              <span key={m} className="flex items-center gap-1">
                <span className={`size-2.5 rounded-sm ${MEAL_BAR[m]}`} />
                {MEAL_LABELS[m]}
              </span>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <SectionTitle>这周最受欢迎的菜</SectionTitle>
          {o.topDishes.length === 0 ? (
            <p className="mt-4 text-[13px] text-ink-3">还没有人点赞。员工在柚子饭堂里给喜欢的菜点 ❤️，这里就会排出来。</p>
          ) : (
            <ol className="mt-3 space-y-2">
              {o.topDishes.map((d, i) => (
                <li key={`${d.date}-${d.meal}-${d.name}`} className="flex items-center gap-3">
                  <span className="num w-5 text-[13px] font-bold text-ink-3">{i + 1}</span>
                  <span className="text-[20px]">{d.emoji}</span>
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{d.name}</span>
                  <span className="text-[12px] text-ink-3">
                    {d.date.slice(5)} {MEAL_LABELS[d.meal]}
                  </span>
                  <Badge tone="clay">❤️ {d.likes}</Badge>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      {o.feedbackUnread > 0 && (
        <Card className="flex items-center gap-4 p-4" data-testid="canteen-mailbox-summary">
          <Mascot mood="love" className="h-20 w-auto shrink-0" still />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-bold">柚子信箱里有 {o.feedbackUnread} 条还没看</p>
            <p className="text-[13px] text-ink-3">员工在「跟柚子说」里写的心愿和碎碎念，回一句话他们就看得到。</p>
          </div>
          <button type="button" onClick={() => go('mailbox')} className="text-[13.5px] font-semibold text-pine hover:underline">
            去看看
          </button>
        </Card>
      )}

      <Card className="p-5">
        <SectionTitle aside={<span className="text-[12.5px] text-ink-3">名单：在用 {o.people.active} 位，已开通 {o.people.activated} 位</span>}>今天刚打卡的</SectionTitle>
        {o.today.recent.length === 0 ? (
          <p className="mt-4 text-[13px] text-ink-3">今天还没有人打卡</p>
        ) : (
          <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {o.today.recent.slice(0, 12).map((r) => (
              <li key={r.id} className={`flex items-center gap-2.5 text-[13.5px] ${r.voidedAt ? 'opacity-50' : ''}`}>
                <span className="text-[20px]">{r.avatar}</span>
                <span className={`font-semibold ${r.voidedAt ? 'line-through' : ''}`}>{r.name}</span>
                <span className="num text-ink-3">{r.empNo}</span>
                <span className="ml-auto text-ink-3">
                  {MEAL_LABELS[r.meal as Meal]} · {relativeTime(r.scannedAt)}
                  {r.method === 'manual' && ' · 手动'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const MEAL_BAR: Record<Meal, string> = { breakfast: 'bg-yuzu', lunch: 'bg-pine', dinner: 'bg-ember', supper: 'bg-lake' };
