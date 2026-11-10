// 饭点提醒（店主 2026-11-10，docs/CANTEEN.md 第 19 节，K22–K24）：到点柚子给打开了提醒的员工手机发一条通知，桌面上的柚子图标出现小红点。
// 这里设哪几顿提醒、几点、柚子说什么、点通知打开哪一页（整份保存，带改了几次 rev）；看今天每顿发了没有、谁开着提醒、没送到的原因；
// 给某位员工的手机发一条试试。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RotateCcw, Send, Smartphone, X } from 'lucide-react';
import { MEAL_EMOJI, MEAL_LABELS, type Meal, type MealWindow } from '@shared/canteen';
import {
  defaultReminder,
  fillReminderLine,
  MENU_TAG,
  NAME_TAG,
  pickReminderLine,
  REMINDER_LIMITS,
  REMINDER_OPEN_LABELS,
  REMINDER_OPEN_PAGES,
  reminderProblem,
  reminderTime,
  type MealReminder,
  type PushTestResult,
  type ReminderOpenPage,
  type ReminderOverview,
  type ReminderRunView,
  type ReminderSettings,
} from '@shared/canteen-reminders';
import { api, ApiError, errorMessage } from '../../lib/api';
import { cn, relativeTime } from '../../lib/utils';
import { Badge, Button, Card, ConfirmCheck, Field, Input, Notice, SectionTitle, Select, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { Mascot } from '../../../canteen-app/Mascot';

export const useReminders = () =>
  useQuery({ queryKey: ['canteen', 'reminders'], queryFn: () => api.get<ReminderOverview>('/api/erp/canteen/reminders'), refetchInterval: 60_000 });

/** 预览里的员工与菜（真的发的时候换成每个人的名字、这一顿发布了的菜） */
const SAMPLE_NAME = '小林';
const SAMPLE_MENU = '红烧肉、番茄炒蛋、清炒时蔬等 5 道菜';
const PLATFORM_LABELS: Record<string, string> = { ios: 'iPhone', android: '安卓', other: '其他' };

export function RemindersTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useReminders();
  const [form, setForm] = useState<ReminderSettings | null>(null);
  // 表单是从哪一份设置改起的：没改过时，别人刚存的新设置（每分钟刷新一次）直接换上
  const [base, setBase] = useState<ReminderSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const adopt = (next: ReminderSettings) => {
    setForm(next);
    setBase(next);
  };
  useEffect(() => {
    if (!q.data) return;
    if (!form || (base && JSON.stringify(form) === JSON.stringify(base))) adopt(q.data.settings);
    // 只跟着门店系统的数据变（form、base 是这里自己改的）
  }, [q.data]);
  if (q.isError) return <Notice tone="error" title="取不到饭点提醒的情况">{errorMessage(q.error)}</Notice>;
  if (!q.data || !form) return <Skeleton className="h-96" />;
  const o = q.data;

  const setMeal = (meal: Meal, next: MealReminder) => setForm({ ...form, reminders: form.reminders.map((r) => (r.meal === meal ? next : r)) });
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const save = async () => {
    setBusy(true);
    setError('');
    setStale(false);
    try {
      const next = await api.put<ReminderOverview>('/api/erp/canteen/reminders', form);
      adopt(next.settings);
      qc.setQueryData(['canteen', 'reminders'], next);
      toast({ tone: 'success', title: '饭点提醒存好了', body: '下一次到点就按新的发' });
    } catch (e) {
      setError(errorMessage(e));
      setStale(e instanceof ApiError && e.code === 'REMINDERS_CHANGED');
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    const fresh = await q.refetch();
    if (fresh.data) adopt(fresh.data.settings);
    setError('');
    setStale(false);
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]" data-testid="canteen-reminders">
      <div className="space-y-4">
        <Card className="flex items-center gap-4 p-5">
          <Mascot mood="wink" className="h-20 w-auto shrink-0" still />
          <div className="text-[13.5px] leading-relaxed text-ink-2">
            <p className="text-[15px] font-bold text-ink">到了饭点，柚子在员工手机上喊大家吃饭</p>
            <p className="mt-1">
              员工在柚子饭堂「我的 → 饭点提醒」里打开以后，到点会收到一条通知（锁屏上也看得到），桌面上的柚子图标冒出小红点。已经打过这一顿卡的人不再提醒；员工自己可以关掉某一顿。
            </p>
          </div>
        </Card>

        {form.reminders.map((r) => (
          <MealReminderEditor key={r.meal} value={r} window={o.meals.find((w) => w.meal === r.meal)} today={o.today} onChange={(next) => setMeal(r.meal, next)} />
        ))}

        {error && (
          <Notice
            tone="error"
            title={error}
            action={
              stale ? (
                <Button size="sm" onClick={() => void reload()}>
                  刷新，看看别人改成了什么
                </Button>
              ) : undefined
            }
          />
        )}
        {/* 改了没保存时贴在屏幕下边（四顿的卡片很长，改完上面的不用滚到最底下去保存） */}
        <div className={cn('flex flex-wrap items-center gap-3', dirty && 'sticky bottom-3 z-10 rounded-lg border border-line-strong bg-card/95 p-3 shadow-lg backdrop-blur')}>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!dirty} data-testid="reminders-save">
            保存饭点提醒
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => base && setForm(base)} disabled={busy}>
              不改了
            </Button>
          )}
          {dirty ? <span className="text-[13px] text-ink-2">改了还没保存</span> : <span className="text-[13px] text-ink-3">没有要保存的修改</span>}
        </div>
      </div>

      <div className="space-y-4">
        <TodayCard runs={o.runs} today={o.today} />
        <PeopleCard o={o} />
        <TestCard o={o} />
        <HowCard />
      </div>
    </div>
  );
}

function MealReminderEditor({ value: r, window, today, onChange }: { value: MealReminder; window: MealWindow | undefined; today: string; onChange: (r: MealReminder) => void }) {
  const [focus, setFocus] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const open = !!window?.enabled;
  const label = MEAL_LABELS[r.meal];
  const problem = reminderProblem({ ...r, title: r.title.trim(), lines: r.lines.map((l) => l.trim()).filter(Boolean) });
  const set = (patch: Partial<MealReminder>) => onChange({ ...r, ...patch });
  const setLine = (i: number, text: string) => set({ lines: r.lines.map((l, j) => (j === i ? text : l)) });
  const insert = (tag: string) => {
    if (!r.lines.length) return set({ lines: [tag] });
    const i = Math.min(focus, r.lines.length - 1);
    setLine(i, `${r.lines[i]}${tag}`);
  };
  const lines = r.lines.map((l) => l.trim()).filter(Boolean);
  // 预览：默认今天轮到的那一句（当作这一顿发布了菜单），可以点「换一句」看别的
  const todays = pickReminderLine(lines, today, true);
  const shown = preview !== null && lines.length ? lines[preview % lines.length]! : todays;
  const time = reminderTime(r, window);

  return (
    <Card className="space-y-4 p-5" data-testid={`reminder-${r.meal}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[220px] flex-1">
          <ConfirmCheck checked={r.enabled} onChange={(v) => set({ enabled: v })}>
            {MEAL_EMOJI[r.meal]} {label}提醒
            {r.enabled && open && time && <span className="ml-2 text-ink-3">· {time} 发</span>}
          </ConfirmCheck>
        </div>
        {r.enabled && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => onChange({ ...defaultReminder(r.meal), enabled: true, time: r.time, open: r.open })}>
            恢复默认话术
          </Button>
        )}
      </div>
      {r.enabled && !open && <Notice tone="warning" title={`${label}没开饭：在「设置 → 开饭时间」里打开${label}，才会提醒`} />}

      {r.enabled && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Field label="几点提醒" hint={r.time === null ? '跟着「设置 → 开饭时间」走' : undefined} className="w-56">
              <Select value={r.time === null ? 'start' : 'custom'} onChange={(e) => set({ time: e.target.value === 'start' ? null : (window?.start ?? '11:30') })} aria-label={`${label}几点提醒`}>
                <option value="start">开饭时（{window?.start ?? '—'}）</option>
                <option value="custom">自己定一个时间</option>
              </Select>
            </Field>
            {r.time !== null && (
              <Field label="时间" className="w-36">
                <Input type="time" value={r.time} onChange={(e) => set({ time: e.target.value || null })} aria-label={`${label}提醒时间`} />
              </Field>
            )}
            <Field label="点通知打开" className="w-36">
              <Select value={r.open} onChange={(e) => set({ open: e.target.value as ReminderOpenPage })} aria-label={`${label}点通知打开`}>
                {REMINDER_OPEN_PAGES.map((p) => (
                  <option key={p} value={p}>
                    {REMINDER_OPEN_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="通知的标题" hint={`${[...r.title].length} / ${REMINDER_LIMITS.title} 个字`}>
            <Input value={r.title} maxLength={REMINDER_LIMITS.title * 2} onChange={(e) => set({ title: e.target.value })} aria-label={`${label}通知的标题`} />
          </Field>
          <div className="space-y-2">
            <SectionTitle
              aside={
                <span className="flex gap-1.5">
                  <Button size="sm" variant="quiet" onClick={() => insert(NAME_TAG)} title="插入员工的名字">
                    + {NAME_TAG}
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => insert(MENU_TAG)} title="插入这一顿发布了的菜">
                    + {MENU_TAG}
                  </Button>
                </span>
              }
            >
              柚子说的话（每天轮着说一句）
            </SectionTitle>
            {r.lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-right text-[12px] font-semibold text-ink-3">{i + 1}</span>
                <Input
                  value={line}
                  maxLength={REMINDER_LIMITS.line * 2}
                  onFocus={() => setFocus(i)}
                  onChange={(e) => setLine(i, e.target.value)}
                  aria-label={`${label}第 ${i + 1} 句`}
                  invalid={[...line.trim()].length > REMINDER_LIMITS.line}
                />
                <button
                  type="button"
                  className="rounded-md p-2 text-ink-3 hover:bg-paper-2 hover:text-clay"
                  onClick={() => set({ lines: r.lines.filter((_, j) => j !== i) })}
                  aria-label={`删掉${label}第 ${i + 1} 句`}
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
            {r.lines.length < REMINDER_LIMITS.lines && (
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set({ lines: [...r.lines, ''] })}>
                加一句
              </Button>
            )}
            <p className="text-[12.5px] leading-relaxed text-ink-3">
              {NAME_TAG} 换成员工的名字，{MENU_TAG} 换成这一顿发布了的菜（例如「{SAMPLE_MENU}」）；没发布菜单的那天不用带 {MENU_TAG} 的句子。每句最多 {REMINDER_LIMITS.line} 个字，最多{' '}
              {REMINDER_LIMITS.lines} 句。
            </p>
          </div>
          {problem && <Notice tone="error" title={problem} />}

          <div className="max-w-[380px]">
            <SectionTitle
              aside={
                lines.length > 1 ? (
                  <button type="button" className="text-[12.5px] font-semibold text-pine hover:underline" onClick={() => setPreview((p) => (p === null ? lines.indexOf(todays ?? '') + 1 : p + 1))}>
                    换一句看看
                  </button>
                ) : undefined
              }
            >
              员工手机上的样子
            </SectionTitle>
            <div className="mt-2 rounded-[22px] bg-gradient-to-b from-[#3b4a5c] to-[#26313d] p-3" data-testid={`reminder-preview-${r.meal}`}>
              <div className="rounded-2xl bg-white/90 p-3 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
                  <span className="flex size-5 items-center justify-center rounded-[5px] bg-[#EBDECA] text-[11px]" aria-hidden>
                    🍊
                  </span>
                  <span className="font-semibold tracking-wide">柚子饭堂</span>
                  <span className="ml-auto">{time ?? '—'}</span>
                </div>
                <p className="mt-1.5 text-[14px] font-bold text-ink">{r.title.trim() || '（还没写标题）'}</p>
                <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{shown ? fillReminderLine(shown, SAMPLE_NAME, SAMPLE_MENU) : '（还没写柚子说的话）'}</p>
              </div>
              <p className="mt-2 text-center text-[11.5px] text-white/70">点开打开：{REMINDER_OPEN_LABELS[r.open]}</p>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

const STATE_BADGE: Record<ReminderRunView['state'], { tone: 'pine' | 'yuzu' | 'lake' | 'clay' | 'neutral'; label: string }> = {
  done: { tone: 'pine', label: '发了' },
  sending: { tone: 'lake', label: '正在发' },
  waiting: { tone: 'yuzu', label: '还没到点' },
  missed: { tone: 'neutral', label: '今天没发' },
  off: { tone: 'neutral', label: '不提醒' },
};

function TodayCard({ runs, today }: { runs: ReminderRunView[]; today: string }) {
  return (
    <Card className="p-5" data-testid="reminders-today">
      <SectionTitle aside={<span className="text-[12px] text-ink-3">{today}</span>}>今天的饭点提醒</SectionTitle>
      <ul className="mt-3 divide-y divide-line">
        {runs.map((r) => {
          const b = STATE_BADGE[r.state];
          return (
            <li key={r.meal} className="py-2.5" data-testid={`reminders-today-${r.meal}`}>
              <div className="flex items-center gap-2">
                <span className="text-[18px]">{MEAL_EMOJI[r.meal]}</span>
                <span className="font-semibold">{MEAL_LABELS[r.meal]}</span>
                {r.time && <span className="text-[13px] text-ink-3 tabular-nums">{r.time}</span>}
                <span className="ml-auto">
                  <Badge tone={b.tone}>{b.label}</Badge>
                </span>
              </div>
              {(r.state === 'done' || r.state === 'sending') && (
                <p className="mt-1 pl-7 text-[12.5px] text-ink-2">
                  送到 {r.sent} 台手机{r.failed ? `、${r.failed} 台没送到` : ''}
                  {r.skippedCheckedIn ? `；${r.skippedCheckedIn} 人已经打过卡、没再提醒` : ''}
                  {r.line && <span className="mt-0.5 block text-ink-3">「{r.line}」</span>}
                </p>
              )}
              {r.state === 'missed' && <p className="mt-1 pl-7 text-[12.5px] text-ink-3">到点后 30 分钟里应用没在跑（或者那之后才打开这一顿的提醒），不补发。</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function PeopleCard({ o }: { o: ReminderOverview }) {
  return (
    <Card className="p-5" data-testid="reminders-people">
      <SectionTitle>谁开着提醒</SectionTitle>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <p>
          <span className="text-[26px] font-bold tabular-nums">{o.people}</span> <span className="text-[13px] text-ink-2">人</span>
        </p>
        <p className="text-[13px] text-ink-2">
          {o.devices.total} 台手机：iPhone {o.devices.ios} · 安卓 {o.devices.android} · 其他 {o.devices.other}
        </p>
      </div>
      {o.recipients.length > 0 ? (
        <ul className="mt-3 max-h-64 divide-y divide-line overflow-y-auto">
          {o.recipients.map((p) => (
            <li key={p.id} className="flex items-center gap-2 py-2 text-[13.5px]">
              <span className="text-[18px]">{p.avatar}</span>
              <span className="font-semibold">{p.name}</span>
              <span className="text-ink-3">{p.empNo}</span>
              <span className="ml-auto flex items-center gap-1.5 text-[12.5px] text-ink-2">
                <Smartphone className="size-3.5" /> {p.devices} 台 · {p.platforms.map((x) => PLATFORM_LABELS[x] ?? x).join('、')}
                {p.muted.length > 0 && <Badge tone="neutral">不要{p.muted.map((m) => MEAL_LABELS[m]).join('、')}</Badge>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[13px] text-ink-3">还没有人打开提醒：员工在柚子饭堂「我的 → 饭点提醒」里打开，首页也会问一句。</p>
      )}
      {o.failures.length > 0 && (
        <div className="mt-4">
          <SectionTitle>最近没送到的</SectionTitle>
          <ul className="mt-2 space-y-1.5 text-[12.5px]" data-testid="reminders-failures">
            {o.failures.map((f, i) => (
              <li key={i} className="rounded-md bg-paper-2 px-3 py-2">
                <span className="font-semibold">{f.name}</span> <span className="text-ink-3">{f.empNo} · {PLATFORM_LABELS[f.platform] ?? f.platform} · {relativeTime(f.at)}</span>
                <span className="block text-ink-2">{f.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function TestCard({ o }: { o: ReminderOverview }) {
  const [employeeId, setEmployeeId] = useState<number | ''>('');
  const [meal, setMeal] = useState<Meal | ''>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const meals = o.settings.reminders.filter((r) => r.enabled).map((r) => r.meal);
  const send = async () => {
    if (employeeId === '') return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.post<PushTestResult>('/api/erp/canteen/reminders/test', { employeeId, meal: meal || null });
      setResult(
        r.sent === r.devices
          ? { ok: true, text: `送到了 ${r.sent} 台手机，请对方看看手机上的通知` }
          : { ok: r.sent > 0, text: `${r.devices} 台手机送到 ${r.sent} 台：${r.errors.join('；')}` },
      );
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-5" data-testid="reminders-test">
      <SectionTitle>发一条试试</SectionTitle>
      <p className="text-[12.5px] text-ink-3">给某位员工开着提醒的手机马上发一条（不算今天的提醒，同一个人十几秒内只能发一条）。</p>
      <div className="flex flex-wrap gap-2">
        <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value ? Number(e.target.value) : '')} aria-label="发给谁" className="min-w-[160px] flex-1">
          <option value="">{o.recipients.length ? '选一位员工' : '还没有人开着提醒'}</option>
          {o.recipients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.empNo}）
            </option>
          ))}
        </Select>
        <Select value={meal} onChange={(e) => setMeal(e.target.value as Meal | '')} aria-label="发哪一条" className="min-w-[140px] flex-1">
          <option value="">柚子的问候</option>
          {meals.map((m) => (
            <option key={m} value={m}>
              今天的{MEAL_LABELS[m]}提醒
            </option>
          ))}
        </Select>
        <Button variant="secondary" icon={<Send className="size-4" />} onClick={() => void send()} loading={busy} disabled={employeeId === ''} data-testid="reminders-test-send">
          发给 TA
        </Button>
      </div>
      {result && <Notice tone={result.ok ? 'success' : 'error'} title={result.text} />}
    </Card>
  );
}

function HowCard() {
  return (
    <Card className="space-y-3 p-5 text-[13px] leading-relaxed text-ink-2">
      <p className="font-bold text-ink">哪些手机收得到</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <b className="text-ink">iPhone</b>：iOS 16.4 及以上，先用 Safari 把柚子饭堂「添加到主屏幕」，再点桌面上的柚子打开、打开提醒。桌面图标的小红点也只有这样才有。
        </li>
        <li>
          <b className="text-ink">安卓</b>：用 Chrome 或 Edge 打开。提醒要经过谷歌的推送服务，<b className="text-ink">手机上没有谷歌服务的（大多数国产安卓手机）收不到</b>
          ；打开柚子饭堂时首页照样写着「开饭中」。
        </li>
        <li>微信里打开的、店里局域网 http 打开的都收不到。</li>
      </ul>
      <p className="font-bold text-ink">手机桌面的快捷入口</p>
      <p>
        安卓手机把柚子饭堂装到桌面以后，长按桌面上的柚子会出现「亮饭卡码」「扫码」「跟柚子说」三个入口（「扫码」是负责人用的，员工点了打开饭卡码）。iPhone 不支持长按入口。
      </p>
    </Card>
  );
}
