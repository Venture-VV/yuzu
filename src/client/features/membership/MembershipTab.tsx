// 数据看板 →「会员体系」（会员体系 v2，v0.7.23；docs/MEMBERSHIP.md 第 4 节）：客户经理、店总、店主看。
//   · 19 个状态各多少人；本月升档、升阶、保级、补充期、降档人次；
//   · 到期提醒名单（未来 7 / 30 / 60 / 90 天）与补充期名单，可导出给客户经理逐个联系；
//   · 今天自动处理了谁、为什么；每天的自动任务有没有跑、有没有出错。

import { useState } from 'react';
import { Link } from 'react-router';
import { CalendarClock, Download, ListChecks, TriangleAlert } from 'lucide-react';
import { GRADE_EVENT_LABELS, gradeLabel, TIER_LABELS, type GradeEventKind, type MembershipRules } from '@shared/membership';
import { formatPhone } from '@shared/labels';
import { useSession } from '../../lib/session';
import { cn, formatTime, relativeTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge, Card, Notice, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { useGradeEvents, useMembershipOverview, useMembershipRules, useRetention } from './queries';

export function MembershipTab() {
  const session = useSession();
  const rules = useMembershipRules().data;
  const q = useMembershipOverview();
  const d = q.data;
  if (q.isPending || !rules) return <Skeleton className="h-96" />;
  if (q.error || !d) return <Notice tone="error" title={q.error?.message ?? '看板没有加载出来'} />;
  const monthKinds: [string, GradeEventKind[]][] = [
    ['充值升档', ['recharge_up']],
    ['消费升阶', ['spend_up']],
    ['到期保级', ['retain', 'grace_retain']],
    ['进入补充期', ['grace_start']],
    ['降档', ['downgrade']],
    ['手动调整', ['manual']],
  ];
  return (
    <div className="space-y-5" data-testid="dashboard-membership">
      {d.overdue > 0 && (
        <Notice tone="warning" icon={<TriangleAlert className="size-5" />} title={`${d.overdue} 位会员过了到期日还没处理`}>
          营业日开始后应用每分钟自动处理一次；一直不减少时请联系管理员看自动任务。
        </Notice>
      )}
      {d.jobToday?.error && <Notice tone="error" title="今天的到期处理有出错的会员" >{d.jobToday.error}</Notice>}
      <p className="text-[12.5px] text-ink-3">
        营业日 {d.today}
        {d.live ? ` · 会员体系 v2 自 ${d.live.businessDate} 启用（上线时按累计充值定档 ${d.live.graded} 位）` : ''}
        {d.jobToday ? ` · 今天的到期处理 ${formatTime(d.jobToday.finishedAt ?? d.jobToday.startedAt)} 跑完` : ' · 今天的到期处理还没有记录'}
      </p>

      <StatesCard rules={rules} states={d.states} />

      <Card className="p-5">
        <SectionTitle>本月（{d.month.from} 起）状态变化</SectionTitle>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="membership-month">
          {monthKinds.map(([label, kinds]) => (
            <div key={label} className="rounded-lg border border-line bg-card px-3 py-2">
              <p className="text-[12px] font-semibold text-ink-3">{label}</p>
              <p className="num text-[20px] font-bold text-ink">{kinds.reduce((n, k) => n + (d.month.counts[k] ?? 0), 0)}</p>
            </div>
          ))}
        </div>
      </Card>

      <RetentionCard rules={rules} expiring={d.expiring} grace={d.grace} />
      <TodayEvents rules={rules} today={session.today} />

      <Card className="p-5">
        <SectionTitle>
          <span className="flex items-center gap-2">
            <ListChecks className="size-4 text-pine" /> 每天的到期处理（最近 14 天）
          </span>
        </SectionTitle>
        {d.jobs.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-3">还没有运行记录。</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]" data-testid="membership-jobs">
              <thead className="text-left text-[12px] text-ink-3">
                <tr>
                  <th className="py-1.5 pr-3">营业日</th>
                  <th className="py-1.5 pr-3">处理</th>
                  <th className="py-1.5 pr-3">保级</th>
                  <th className="py-1.5 pr-3">进补充期</th>
                  <th className="py-1.5 pr-3">降档</th>
                  <th className="py-1.5">结果</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {d.jobs.map((j) => (
                  <tr key={j.businessDate}>
                    <td className="num py-1.5 pr-3">{j.businessDate}</td>
                    <td className="num py-1.5 pr-3">{j.processed}</td>
                    <td className="num py-1.5 pr-3">{j.retained}</td>
                    <td className="num py-1.5 pr-3">{j.grace}</td>
                    <td className="num py-1.5 pr-3">{j.downgraded}</td>
                    <td className={cn('py-1.5', j.error ? 'text-clay' : 'text-ink-3')}>{j.error ?? (j.finishedAt ? '正常' : '进行中')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** 19 个状态：L0 一格，L1–L6 各分初、享、尊 */
function StatesCard({ rules, states }: { rules: MembershipRules; states: { grade: number; tier: number | null; count: number; balance: number }[] }) {
  const total = states.reduce((n, s) => n + s.count, 0);
  return (
    <Card className="p-5">
      <SectionTitle aside={<span className="text-[12.5px] text-ink-3">共 {total} 位</span>}>各档阶人数</SectionTitle>
      <div className="mt-3 overflow-x-auto pb-1">
        <div className="grid min-w-[640px] grid-cols-7 gap-2" data-testid="membership-states">
          {rules.grades.map((g, i) => {
            const rows = states.filter((s) => s.grade === i);
            const sum = rows.reduce((n, s) => n + s.count, 0);
            return (
              <div key={i} className="rounded-lg border border-line bg-card px-2 py-2">
                <p className="text-[12.5px] font-bold text-ink-2">
                  L{i} {g.name}
                </p>
                <p className="num text-[20px] leading-tight font-bold text-ink">{sum}</p>
                {i > 0 && (
                  <div className="mt-1 grid grid-cols-3 gap-0.5 text-center">
                    {TIER_LABELS.map((t, k) => (
                      <span key={t} className="rounded bg-paper-2 px-0.5 py-0.5 text-[11px] text-ink-3">
                        {t} <b className="num text-ink-2">{rows.find((r) => r.tier === k)?.count ?? 0}</b>
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-[11px] text-ink-3">
                  余额 <Money cents={rows.reduce((n, s) => n + s.balance, 0)} />
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

/** 到期提醒名单与补充期名单：客户经理按名单联系客人（M10：系统里的名单，不自动发消息） */
function RetentionCard({ rules, expiring, grace }: { rules: MembershipRules; expiring: { within: number; count: number }[]; grace: number }) {
  const [kind, setKind] = useState<'expiring' | 'grace'>('expiring');
  const windows = expiring.map((e) => e.within);
  const [within, setWithin] = useState(windows.includes(30) ? 30 : (windows[0] ?? 30));
  const list = useRetention(kind, within);
  const rows = list.data ?? [];
  return (
    <Card className="p-5">
      <SectionTitle
        aside={
          <a
            href={`/api/membership/retention.csv?kind=${kind}&within=${within}`}
            className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-pine hover:underline"
            data-testid="membership-retention-export"
          >
            <Download className="size-3.5" /> 导出名单
          </a>
        }
      >
        <span className="flex items-center gap-2">
          <CalendarClock className="size-4 text-ember" /> 到期提醒
        </span>
      </SectionTitle>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          ariaLabel="名单"
          value={kind === 'grace' ? 'grace' : String(within)}
          onChange={(v) => {
            if (v === 'grace') setKind('grace');
            else {
              setKind('expiring');
              setWithin(Number(v));
            }
          }}
          options={[
            ...expiring.map((e) => ({ value: String(e.within), label: `${e.within} 天内 ${e.count}` })),
            { value: 'grace', label: `补充期 ${grace}` },
          ]}
        />
      </div>
      {list.isPending ? (
        <Skeleton className="mt-3 h-24" />
      ) : rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">{kind === 'grace' ? '没有在补充期的会员。' : `${within} 天内没有到期的会员。`}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px]" data-testid="membership-retention">
            <thead className="text-left text-[12px] text-ink-3">
              <tr>
                <th className="py-1.5 pr-3">会员</th>
                <th className="py-1.5 pr-3">档阶</th>
                <th className="py-1.5 pr-3">{kind === 'grace' ? '补充期到' : '会籍到期'}</th>
                <th className="py-1.5 pr-3">周期储值消费 / 保级</th>
                <th className="py-1.5 pr-3">还差</th>
                <th className="py-1.5 pr-3">余额</th>
                <th className="py-1.5">最近</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {rows.map((r) => (
                <tr key={r.memberId}>
                  <td className="py-1.5 pr-3">
                    <Link to={`/?m=${r.memberId}`} className="font-semibold text-ink hover:text-pine hover:underline">
                      {r.name}
                    </Link>
                    <span className="num block text-[12px] text-ink-3">{formatPhone(r.phone)}</span>
                  </td>
                  <td className="py-1.5 pr-3">{gradeLabel(rules, r.grade, r.tier)}</td>
                  <td className="num py-1.5 pr-3">
                    {r.graceUntil ?? r.cycleEnd}
                    <Badge tone={r.daysLeft <= 7 ? 'clay' : r.daysLeft <= 30 ? 'ember' : 'neutral'} className="ml-1.5">
                      {r.daysLeft} 天
                    </Badge>
                  </td>
                  <td className="py-1.5 pr-3">
                    <Money cents={r.spendCents} /> / <Money cents={r.honorCents} />
                  </td>
                  <td className="py-1.5 pr-3">{r.needCents ? <Money cents={r.needCents} className="font-semibold text-clay" /> : <span className="text-pine">已够保级</span>}</td>
                  <td className="py-1.5 pr-3">
                    <Money cents={r.balance} />
                  </td>
                  <td className="py-1.5 text-ink-3">{relativeTime(r.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** 今天的状态变化：自动处理了谁、为什么 */
function TodayEvents({ rules, today }: { rules: MembershipRules; today: string }) {
  const q = useGradeEvents(today, null);
  const rows = q.data ?? [];
  return (
    <Card className="p-5">
      <SectionTitle aside={<span className="text-[12.5px] text-ink-3">{rows.length} 条</span>}>今天的状态变化</SectionTitle>
      {q.isPending ? (
        <Skeleton className="mt-3 h-16" />
      ) : rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-3">今天还没有档阶变化。</p>
      ) : (
        <ul className="mt-2 divide-y divide-line/70 text-[13px]" data-testid="membership-today-events">
          {rows.slice(0, 50).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
              <Link to={`/?m=${e.memberId}`} className="font-semibold text-ink hover:text-pine hover:underline">
                {e.memberName}
              </Link>
              <span className="font-semibold text-ink-2">{GRADE_EVENT_LABELS[e.kind]}</span>
              <span className="text-ink-3">
                {gradeLabel(rules, e.fromGrade, e.fromTier)} → {gradeLabel(rules, e.toGrade, e.toTier)}
              </span>
              <span className="text-[12px] text-ink-4">{e.staffName ?? '系统自动'}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
