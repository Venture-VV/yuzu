// 工作台 · 巡场记录（8.0.9，docs/PATROL_V809.md 第 3.3 节）：后台指定的人（店总、安保主管）在手机上按天看巡场清单：
// 每个场所这一天谁几点巡过、一共几次，没人巡的标出来；按人筛。只能看，不能改（XC2）。

import { useEffect, useState } from 'react';
import type { CanteenMe } from '@shared/canteen';
import { PATROL_MAX_DAYS, type PatrolPortalDay } from '@shared/patrol';
import { IconShield } from '../doodles';
import { addDays, call, dayLabel, monthDay, timeText } from '../lib';
import { Button, Card, Pill, cn } from '../ui';

export function PatrolLogPage({ me, go }: { me: CanteenMe; go: (route: string) => void }) {
  const [date, setDate] = useState<string | null>(null);
  const [day, setDay] = useState<PatrolPortalDay | null>(null);
  /** 门店的今天（营业日）：取到过一次就记着，换日期、没取到时也知道今天是哪天 */
  const [today, setToday] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [person, setPerson] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  /** 再取一次（点「再试一次」、没取到以后联网了）：第一次就没取到时连今天是哪天都不知道，换日期的按钮用不了（Codex 审查 7ae94b1） */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    call<PatrolPortalDay>('GET', `/api/canteen/patrol/day${date ? `?date=${date}` : ''}`)
      .then((d) => {
        if (!alive) return;
        setDay(d);
        setToday(d.today);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : '这一天的巡场没取到'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [date, attempt]);
  // 没取到的：联网了自动再取一次
  useEffect(() => {
    if (!error) return;
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [error]);
  // 页面回到前台、开着每 5 分钟：重新取一次，过了营业日切换时间「今天」跟着门店系统变（Codex 审查 b0a8bf6）
  useEffect(() => {
    const again = () => document.visibilityState === 'visible' && setAttempt((n) => n + 1);
    document.addEventListener('visibilitychange', again);
    const timer = setInterval(again, 5 * 60_000);
    return () => {
      document.removeEventListener('visibilitychange', again);
      clearInterval(timer);
    };
  }, []);

  const shownDate = date ?? today;
  // 只显示选的这一天的：换了日期还没取到、或者没取到时，不把前一天的数字显示在新日期下面（Codex 审查 41a2fbb）
  const shown = day && day.date === shownDate ? day : null;
  const oldest = today ? addDays(today, -PATROL_MAX_DAYS) : null;
  const points = (shown?.points ?? [])
    .map((p) => ({ ...p, scans: person === null ? p.scans : p.scans.filter((s) => s.employeeId === person) }))
    .sort((a, b) => Number(a.count > 0) - Number(b.count > 0));

  return (
    <div className="space-y-4" data-testid="patrol-log">
      <div className="flex items-end justify-between gap-2">
        <h1 className="flex items-center gap-1.5 text-[24px] font-black tracking-tight">
          <IconShield size={28} fill="var(--color-yuzu)" /> 巡场记录
        </h1>
        {me.apps?.includes('patrol') && (
          <button type="button" onClick={() => go('patrol')} className="text-[14px] font-bold text-wood-deep underline">
            去扫码
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button tone="leaf" className="h-10 px-3 text-[14px]" disabled={!shownDate || !oldest || shownDate <= oldest || loading} onClick={() => setDate(addDays(shownDate!, -1))} data-testid="patrol-log-prev">
          ‹ 前一天
        </Button>
        <p className="text-center text-[16px] font-black" data-testid="patrol-log-date">
          {shownDate && today ? `${monthDay(shownDate)} · ${dayLabel(shownDate, today)}` : '…'}
        </p>
        <Button tone="leaf" className="h-10 px-3 text-[14px]" disabled={!shownDate || !today || shownDate >= today || loading} onClick={() => setDate(addDays(shownDate!, 1))} data-testid="patrol-log-next">
          后一天 ›
        </Button>
      </div>
      {error && (
        <div className="flex items-center gap-2 rounded-2xl bg-peach-soft px-4 py-2.5" data-testid="patrol-log-error">
          <p className="min-w-0 flex-1 text-[14px] font-bold text-berry">{error}</p>
          <Button tone="leaf" className="h-9 shrink-0 px-3 text-[14px]" disabled={loading} onClick={() => setAttempt((n) => n + 1)} data-testid="patrol-log-retry">
            再试一次
          </Button>
        </div>
      )}
      {!shown && !error && loading && <p className="py-6 text-center text-[14px] text-ink-3">正在取这一天的巡场…</p>}

      {shown && (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Card className="px-2 py-2">
              <p className="text-[12px] font-bold text-ink-3">巡了</p>
              <p className="num text-[22px] font-black" data-testid="patrol-log-total">
                {shown.total}
              </p>
            </Card>
            <Card className="px-2 py-2">
              <p className="text-[12px] font-bold text-ink-3">还没人巡</p>
              <p className={cn('num text-[22px] font-black', shown.missing > 0 && 'text-berry')} data-testid="patrol-log-missing">
                {shown.missing}
              </p>
            </Card>
            <Card className="px-2 py-2">
              <p className="text-[12px] font-bold text-ink-3">巡场的人</p>
              <p className="num text-[22px] font-black">{shown.people.length}</p>
            </Card>
          </div>

          {shown.people.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setPerson(null)}>
                <Pill tone={person === null ? 'yuzu' : 'ink'}>全部</Pill>
              </button>
              {shown.people.map((p) => (
                <button key={p.employeeId} type="button" onClick={() => setPerson(p.employeeId)}>
                  <Pill tone={person === p.employeeId ? 'yuzu' : 'ink'}>
                    {p.name} · {p.count} 次
                  </Pill>
                </button>
              ))}
            </div>
          )}

          <Card className="px-4 py-2">
            {points.length === 0 && <p className="py-3 text-[14px] text-ink-3">还没有场所</p>}
            <ul className="divide-y divide-line">
              {points.map((p) => (
                <li key={p.id} className="flex items-start gap-3 py-2.5" data-testid={`patrol-log-point-${p.name}`}>
                  <span className={cn('mt-0.5 text-[18px]', p.count > 0 ? 'text-leaf-deep' : 'text-berry')}>{p.count > 0 ? '✓' : '○'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-black">
                      {p.name}
                      {!p.active && <span className="ml-1 text-[12px] font-bold text-ink-3">（已停用）</span>}
                    </span>
                    {p.count > 0 ? (
                      p.scans.length > 0 ? (
                        <span className="mt-0.5 block text-[13px] text-ink-2">{p.scans.map((s) => `${timeText(s.at)} ${s.name}${s.late ? '（补交）' : ''}`).join('、')}</span>
                      ) : (
                        <span className="mt-0.5 block text-[13px] text-ink-3">这个人没巡这里</span>
                      )
                    ) : (
                      <span className="mt-0.5 block text-[13px] font-bold text-berry">{shownDate === today ? '今天还没人巡' : '这一天没人巡'}</span>
                    )}
                  </span>
                  {p.count > 0 && <span className="num shrink-0 text-[15px] font-black">{p.count} 次</span>}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
