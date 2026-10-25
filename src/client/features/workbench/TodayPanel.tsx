import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { describeDate } from '@shared/labels';
import { useLedger, useSettlement } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { formatTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Kbd, Skeleton } from '../../components/ui';
import { ENTRY_META } from './ActivityList';

/** 工作台右栏：未进行操作时显示今日概览与快捷键 */
export function TodayPanel() {
  const session = useSession();
  const s = useSettlement(session.today);
  const ledger = useLedger({});
  const d = describeDate(session.today);
  const recent = (ledger.data ?? []).slice(0, 6);

  return (
    // 子项不允许被压缩：屏幕较矮时整栏滚动，而不是把汇总卡压扁
    <div className="scroll-thin flex h-full flex-col gap-4 overflow-y-auto p-5 [&>*]:shrink-0">
      <div>
        <p className="text-[12px] font-bold tracking-[0.18em] text-ink-3">TODAY</p>
        <p className="mt-0.5 flex items-baseline gap-2">
          <span className="font-display text-[34px] leading-none text-ink italic">{session.today.slice(5).replace('-', '.')}</span>
          <span className="text-[14px] font-semibold text-ink-3">{d.weekday}</span>
        </p>
      </div>

      {s.isPending ? (
        <Skeleton className="h-[164px] rounded-lg" />
      ) : s.data ? (
        <div className="overflow-hidden rounded-lg border border-line bg-card shadow-card">
          <div className="bg-pine px-4 py-3.5 text-paper">
            <p className="text-[12px] font-semibold text-paper/70">充值实收</p>
            <Money cents={s.data.recharge.paid} className="mt-0.5 text-[26px] leading-tight font-bold" />
            <p className="text-[12px] text-paper/60">
              {s.data.recharge.count} 笔 · 另赠金 <Money cents={s.data.recharge.bonus} />
            </p>
          </div>
          <div className="grid grid-cols-2 divide-x divide-line">
            <div className="px-4 py-3">
              <p className="text-[12px] font-semibold text-ink-3">储值消费</p>
              <Money cents={s.data.consume.total} className="text-[17px] font-bold" />
              <p className="text-[12px] text-ink-3">{s.data.consume.count} 笔</p>
            </div>
            <div className="px-4 py-3">
              <p className="text-[12px] font-semibold text-ink-3">撤销</p>
              <Money cents={s.data.reversal.principal + s.data.reversal.bonus} className="text-[17px] font-bold text-clay" />
              <p className="text-[12px] text-ink-3">{s.data.reversal.count} 笔</p>
            </div>
          </div>
          <Link
            to="/settlement"
            className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[13px] font-semibold text-pine hover:bg-pine-tint"
          >
            {s.data.checks.every((c) => c.ok) ? '余额核对一致 · 查看日结' : '核对发现差异 · 查看日结'}
            <ArrowRight className="size-4" />
          </Link>
        </div>
      ) : null}

      <div className="rounded-lg border border-line bg-card shadow-card">
        <p className="px-4 pt-3 pb-1 text-[13px] font-bold text-ink-2">刚刚发生</p>
        {ledger.isPending ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : recent.length === 0 ? (
          <EmptyState art="calm" title="今天还没有业务" className="py-6" />
        ) : (
          <ul className="px-2 pb-2">
            {recent.map((r) => {
              const meta = ENTRY_META[r.entryType];
              const Icon = meta.icon;
              return (
                <li key={r.id} className="flex items-center gap-2.5 rounded-md px-2 py-2">
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-full ${meta.tone}`}>
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">
                      {r.memberName} · {meta.label}
                    </span>
                    <span className="num block text-[11.5px] text-ink-3">
                      {formatTime(r.createdAt)} · {r.operatorName}
                    </span>
                  </span>
                  <Money
                    cents={r.entryType === 'recharge' ? (r.paidAmount ?? 0) : r.principalDelta + r.bonusDelta}
                    signed={r.entryType !== 'recharge'}
                    className={`text-[13px] font-bold ${r.entryType === 'recharge' ? 'text-lake' : r.entryType === 'reversal' ? 'text-moss' : 'text-ink'}`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-auto rounded-lg border border-dashed border-line-strong px-4 py-3 text-[12.5px] text-ink-2">
        <p className="mb-2 font-bold text-ink-3">键盘快捷键</p>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <li className="flex items-center gap-2"><Kbd>/</Kbd> 搜索会员</li>
          <li className="flex items-center gap-2"><Kbd>↵</Kbd> 选中第一位</li>
          <li className="flex items-center gap-2"><Kbd>R</Kbd> 充值</li>
          <li className="flex items-center gap-2"><Kbd>X</Kbd> 消费</li>
          <li className="flex items-center gap-2"><Kbd>N</Kbd> 新建会员</li>
          <li className="flex items-center gap-2"><Kbd>Esc</Kbd> 关闭面板</li>
        </ul>
      </div>
    </div>
  );
}
