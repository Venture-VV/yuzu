// 我的：换头像、这个月吃了几顿、我的记录、饭点提醒（第 19 节）、跟柚子说、再看一遍开场与新手教程、改密码、添加到桌面、退出。

import { useEffect, useState, type FormEvent } from 'react';
import { AVATARS, CANTEEN_ROLE_LABELS, MEAL_EMOJI, MEAL_LABELS, PASSWORD_MIN, type CanteenCheckinRow, type CanteenMe } from '@shared/canteen';
import { call, dayLabel, messageOf, monthDay, storeNow, timeText } from '../lib';
import { Button, Card, cn, Field, inputClass, Pill, Sheet, toast } from '../ui';
import { InstallGuide } from '../install';
import { IconArrow, IconBell, IconInstall, IconKey, IconLetter, IconPlay, IconSparkle } from '../doodles';
import { Mascot } from '../Mascot';
import { pushEnabledHere } from '../push';
import { ReminderPanel } from '../reminders';

/** onMe：门店系统刚给的「我」（重算时间差）；onPatch：本机改了一点（保留原来的时间差） */
export function MePage({
  me,
  offsetMs,
  online,
  onMe,
  onPatch,
  onLogout,
  onIntro,
  onTour,
  go,
}: {
  me: CanteenMe;
  offsetMs: number;
  online: boolean;
  onMe: (me: CanteenMe) => void;
  onPatch: (me: CanteenMe) => void;
  onLogout: () => void;
  /** 再看一遍开场动画 */
  onIntro: () => void;
  /** 再走一遍新手教程 */
  onTour: () => void;
  go: (route: string) => void;
}) {
  const today = storeNow(offsetMs).date;
  const [rows, setRows] = useState<CanteenCheckinRow[] | null>(null);
  const [sheet, setSheet] = useState<'avatar' | 'password' | 'install' | 'reminder' | null>(null);
  // 这台手机开着饭点提醒没有（面板关上时再看一遍）
  const [reminderOn, setReminderOn] = useState(false);
  useEffect(() => {
    if (sheet === null) void pushEnabledHere().then(setReminderOn).catch(() => setReminderOn(false));
  }, [sheet]);
  useEffect(() => {
    if (!online) return;
    call<CanteenCheckinRow[]>('GET', `/api/canteen/me/meals?month=${today.slice(0, 7)}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [today, online]);

  const pickAvatar = async (avatar: string) => {
    try {
      await call('PUT', '/api/canteen/me/avatar', { avatar });
      onPatch({ ...me, employee: { ...me.employee, avatar } });
      setSheet(null);
      toast('换好啦 ✨', 'ok');
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  };
  const count = me.mealsThisMonth;

  return (
    <div className="space-y-4">
      <Card sketch className="flex items-center gap-4">
        <button type="button" onClick={() => setSheet('avatar')} className="relative flex size-20 shrink-0 items-center justify-center rounded-full bg-wood-6 text-[44px] ring-4 ring-wood-4 active:scale-95" aria-label="换头像">
          {me.employee.avatar}
          <span className="absolute -right-1 -bottom-1 rounded-full bg-wood-deep px-1.5 py-0.5 text-[10px] font-bold text-white">换</span>
        </button>
        <div className="min-w-0">
          <p className="eyebrow">My page</p>
          <h1 className="truncate text-[22px] font-black">{me.employee.name}</h1>
          <p className="num text-[14px] font-semibold text-ink-2">
            {me.employee.username && me.employee.username !== me.employee.name && `用户名 ${me.employee.username} · `}工号 {me.employee.empNo}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {me.employee.department && <Pill tone="ink">{me.employee.department}</Pill>}
            <Pill tone={me.employee.role === 'staff' ? 'yuzu' : 'leaf'}>{CANTEEN_ROLE_LABELS[me.employee.role]}</Pill>
          </div>
        </div>
      </Card>

      <Card className="bg-yuzu-soft ring-yuzu/40">
        <p className="text-[14px] font-bold text-yuzu-deep">这个月在饭堂吃了</p>
        <p className="num mt-0.5 text-[44px] leading-none font-black" style={{ fontFamily: 'var(--font-en)' }}>
          {count} <span className="text-[18px]">顿</span>
        </p>
        <p className="mt-2 text-[22px] leading-tight tracking-[0.1em]" aria-hidden>
          {'🍚'.repeat(Math.min(count, 12))}
          {count > 12 && <span className="text-[14px] font-bold text-ink-2"> +{count - 12}</span>}
        </p>
        <p className="mt-1 text-[13px] text-ink-2">{count === 0 ? '还没开张，今天来尝尝？' : count < 10 ? '好好吃饭，身体棒棒 💪' : '饭堂常客就是你 🏅'}</p>
      </Card>

      <section>
        <h2 className="mb-2 px-1 text-[15px] font-extrabold text-ink-2">这个月的记录</h2>
        <Card className="py-2">
          {!online && <p className="py-3 text-center text-[14px] text-ink-3">联网后才看得到记录</p>}
          {online && rows === null && <p className="py-3 text-center text-[14px] text-ink-3">正在取…</p>}
          {rows?.length === 0 && <p className="py-3 text-center text-[14px] text-ink-3">这个月还没有记录</p>}
          <ul className="divide-y divide-line/70">
            {rows?.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2.5">
                <span className="text-[22px]" aria-hidden>
                  {MEAL_EMOJI[r.meal]}
                </span>
                <span className="flex-1 text-[15px] font-bold">
                  {dayLabel(r.date, today)} · {MEAL_LABELS[r.meal]}
                </span>
                <span className="num text-[13px] text-ink-2">
                  {monthDay(r.date)} {timeText(r.scannedAt)}
                </span>
                {r.method === 'manual' && <Pill tone="ink">手动</Pill>}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <Card className="divide-y divide-line/80 p-0">
        <Row
          icon={<IconBell size={24} />}
          label="饭点提醒"
          hint={reminderOn ? '开着：到了饭点柚子喊你吃饭' : '到了饭点柚子在手机上喊你吃饭'}
          onClick={() => setSheet('reminder')}
          testId="open-reminders"
        />
        <Row icon={<IconLetter size={24} />} label="跟柚子说" hint="心愿、碎碎念，柚子都听着" onClick={() => go('talk')} />
        <Row icon={<IconPlay size={24} />} label="再看一遍开场" hint="柚子的自我介绍" onClick={onIntro} testId="replay-intro" />
        <Row icon={<IconSparkle size={24} />} label="再走一遍新手教程" hint="饭卡码、点赞、跟柚子说怎么用" onClick={onTour} testId="replay-tour" />
        <Row icon={<IconInstall size={24} />} label="添加到桌面" hint="开饭时一点就亮码" onClick={() => setSheet('install')} />
        <Row icon={<IconKey size={24} />} label="改密码" hint="改好后别的手机上的登录会退出" onClick={() => setSheet('password')} />
      </Card>
      <div className="flex items-center justify-center gap-2 pt-2 text-[12.5px] text-ink-3">
        <Mascot mood="wink" className="size-10" still />
        柚子饭堂 · 汤崎的员工食堂
      </div>
      <Button tone="ghost" className="w-full text-berry" onClick={onLogout}>
        退出登录
      </Button>

      <Sheet open={sheet === 'avatar'} onClose={() => setSheet(null)} title="选个头像">
        <div className="grid grid-cols-6 gap-2 pb-4">
          {AVATARS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => void pickAvatar(a)}
              className={cn('flex aspect-square items-center justify-center rounded-2xl text-[30px] active:scale-90', a === me.employee.avatar ? 'bg-yuzu ring-2 ring-yuzu-deep' : 'bg-card ring-1 ring-line')}
              aria-label={`头像 ${a}`}
            >
              {a}
            </button>
          ))}
        </div>
      </Sheet>
      <Sheet open={sheet === 'password'} onClose={() => setSheet(null)} title="改密码">
        <PasswordForm
          onDone={(next) => {
            onMe(next);
            setSheet(null);
            toast('密码改好了，别的手机上的登录已经退出', 'ok');
          }}
        />
      </Sheet>
      <Sheet open={sheet === 'install'} onClose={() => setSheet(null)} title="添加到桌面">
        <InstallGuide />
      </Sheet>
      <Sheet open={sheet === 'reminder'} onClose={() => setSheet(null)} title="饭点提醒">
        <ReminderPanel online={online} />
      </Sheet>
    </div>
  );
}

function PasswordForm({ onDone }: { onDone: (me: CanteenMe) => void }) {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await call<CanteenMe>('PUT', '/api/canteen/me/password', { oldPassword, newPassword }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4 pb-4">
      <Field label="原来的密码">
        <input className={inputClass} type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" aria-label="原来的密码" />
      </Field>
      <Field label="新密码" hint={`至少 ${PASSWORD_MIN} 位；改好后别的手机上的登录会退出`}>
        <input className={inputClass} type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" aria-label="新密码" />
      </Field>
      {error && <p className="text-[14px] font-bold text-berry">{error}</p>}
      <Button type="submit" big className="w-full" disabled={busy || !oldPassword || !newPassword}>
        {busy ? '正在改…' : '改好了'}
      </Button>
    </form>
  );
}

function Row({ icon, label, hint, onClick, testId }: { icon: React.ReactNode; label: string; hint: string; onClick: () => void; testId?: string }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-cream" data-testid={testId}>
      <span className="text-wood">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold">{label}</span>
        <span className="block truncate text-[12.5px] text-ink-3">{hint}</span>
      </span>
      <span className="text-ink-4">
        <IconArrow size={18} />
      </span>
    </button>
  );
}
