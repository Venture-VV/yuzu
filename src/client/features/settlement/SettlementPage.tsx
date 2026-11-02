import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  BadgeCheck,
  BadgePercent,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Copy,
  Download,
  FilePenLine,
  Hourglass,
  Lock,
  Ticket,
  Undo2,
  WalletMinimal,
} from 'lucide-react';
import { businessBreakdown, CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS } from '@shared/checkout';
import { describeDate, PAYMENT_METHOD_LABELS } from '@shared/labels';
import type { SettlementAnomaly, SettlementSummary } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettlement } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { cn, downloadUrl, formatDateTime, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { DateNav } from '../../components/DateNav';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Notice, PendingBadge, SectionTitle, Skeleton, Textarea } from '../../components/ui';
import { PrintButton } from '../print/PrintButton';
import { ANOMALY_LABELS, receivedByMethod } from './summary';

export function SettlementPage() {
  const session = useSession();
  const can = useCan();
  const navigate = useNavigate();
  const params = useParams();
  const historyAllowed = can('ledger.readHistory');
  const date = historyAllowed ? (params.date ?? session.today) : session.today;
  const s = useSettlement(date);
  const [closing, setClosing] = useState(false);
  const d = describeDate(date);

  return (
    <>
      <PageHeader
        title="日结"
        subtitle="先看清当天，再定位明细与异常"
        actions={
          <div className="flex gap-2">
            {s.data && (
              <PrintButton path={`/print/settlement/${date}`} size="sm" paper="a4" testId="settlement-print">
                打印
              </PrintButton>
            )}
            {can('ledger.export') && (
              <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/settlements/${date}/export`)}>
                导出
              </Button>
            )}
            {can('settlement.close') && s.data && !s.data.isFuture && (
              <Button size="sm" variant="primary" icon={<BadgeCheck className="size-4" />} onClick={() => setClosing(true)}>
                {s.data.closed ? '重新确认日结' : '确认日结'}
              </Button>
            )}
          </div>
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3 md:px-7">
        <DateNav value={date} today={session.today} locked={!historyAllowed} onChange={(v) => navigate(v === session.today ? '/settlement' : `/settlement/${v}`)} />
        {s.data && <CloseStatus s={s.data} />}
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
          营业日每天 {String(session.rules.businessDayStartHour).padStart(2, '0')}:00 切换 <PendingBadge />
        </span>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-5 py-6 md:px-7">
          {s.error ? (
            <Notice tone="error" title={errorMessage(s.error)} />
          ) : s.isPending || !s.data ? (
            <div className="grid gap-4 lg:grid-cols-3">
              <Skeleton className="h-24 lg:col-span-3" />
              <Skeleton className="h-48" />
              <Skeleton className="h-48" />
              <Skeleton className="h-48" />
            </div>
          ) : (
            <Summary s={s.data} dayLabel={`${d.md} ${d.weekday}`} />
          )}
        </div>
      </div>

      {s.data && <CloseDialog open={closing} onClose={() => setClosing(false)} s={s.data} />}
    </>
  );
}

function CloseStatus({ s }: { s: SettlementSummary }) {
  if (s.closed) {
    return s.closed.changedSinceClose ? (
      <Badge tone="ember" icon={<CircleAlert className="size-3.5" />}>
        日结后有变动
      </Badge>
    ) : (
      <Badge tone="pine" icon={<Lock className="size-3" />}>
        已日结 · {s.closed.closedByName} {formatTime(s.closed.closedAt)}
      </Badge>
    );
  }
  return s.isToday ? (
    <Badge tone="yuzu" icon={<Hourglass className="size-3" />}>
      营业中
    </Badge>
  ) : (
    <Badge tone="neutral">未确认日结</Badge>
  );
}

function Summary({ s, dayLabel }: { s: SettlementSummary; dayLabel: string }) {
  const allOk = s.checks.every((c) => c.ok);
  const empty =
    s.recharge.count + s.consume.count + s.reversal.count + s.expiry.count + s.opening.count + s.opening.voidCount + s.business.checkouts.count + s.business.voids.count === 0;

  return (
    <div className="space-y-5">
      {/* 核对结论 */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-4 rounded-xl border px-5 py-4',
          allOk ? 'border-pine/15 bg-pine text-paper' : 'border-clay/30 bg-clay-soft text-clay',
        )}
      >
        <span className={cn('flex size-11 items-center justify-center rounded-full', allOk ? 'bg-white/12' : 'bg-clay text-paper')}>
          {allOk ? <CircleCheck className="size-6" /> : <CircleX className="size-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-bold">{allOk ? `${dayLabel} · 余额与流水核对一致` : `${dayLabel} · 核对发现差异`}</p>
          <p className={cn('text-[13px]', allOk ? 'text-paper/70' : 'text-ink-2')}>
            {allOk
              ? `${s.checks.length} 项核对全部通过：单据、流水、期初期末与会员余额相互吻合。`
              : '请先查看下方核对项与异常记录，必要时联系维护人员。'}
          </p>
        </div>
        {s.closed?.note && (
          <p className={cn('max-w-xs text-[12.5px]', allOk ? 'text-paper/80' : 'text-ink-2')}>日结备注：{s.closed.note}</p>
        )}
      </div>

      {s.closed?.changedSinceClose && (
        <Notice tone="warning" title="日结确认后又有新的业务">
          {s.closed.closedByName} 于 {formatDateTime(s.closed.closedAt)} 确认过日结（第 {s.closed.revision} 次）。之后数据有变化，建议核对后重新确认。
        </Notice>
      )}

      {empty && (
        <Card>
          <EmptyState art="calm" title="这个营业日没有充值、消费或撤销" description="余额核对仍会照常进行。" />
        </Card>
      )}

      {/* 三类金额分开展示：实收现金、储值消费、赠金 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden">
          <div className="border-b border-line px-5 pt-4 pb-3">
            <p className="flex items-center gap-2 text-[13px] font-bold text-ink-2">
              <span className="size-2 rounded-full bg-lake" />
              充值实收
            </p>
            <Money cents={s.recharge.paid} className="mt-1.5 text-[32px] leading-none font-bold text-lake" />
            <p className="mt-1.5 text-[12.5px] text-ink-3">{s.recharge.count} 笔充值 · 实际收到的钱</p>
          </div>
          <div className="space-y-2.5 px-5 py-4">
            {s.recharge.byMethod.length === 0 ? (
              <p className="text-[13px] text-ink-4">无收款</p>
            ) : (
              s.recharge.byMethod.map((m) => (
                <div key={m.method}>
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="font-semibold text-ink-2">
                      {PAYMENT_METHOD_LABELS[m.method]} <span className="font-normal text-ink-3">· {m.count} 笔</span>
                    </span>
                    <Money cents={m.amount} className="font-bold" />
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper-2">
                    <div className="h-full rounded-full bg-lake/70" style={{ width: `${s.recharge.paid ? (m.amount / s.recharge.paid) * 100 : 0}%` }} />
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-line px-5 pt-4 pb-3">
            <p className="flex items-center gap-2 text-[13px] font-bold text-ink-2">
              <WalletMinimal className="size-4 text-ink-3" />
              储值消费
            </p>
            <Money cents={s.consume.total} className="mt-1.5 text-[32px] leading-none font-bold text-ink" />
            <p className="mt-1.5 text-[12.5px] text-ink-3">
              {s.consume.count} 笔 · 其中 {s.consume.reversedCount} 笔已撤销
            </p>
          </div>
          <div className="px-5 py-4">
            <SplitBar principal={s.consume.principal} bonus={s.consume.bonus} />
            <div className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
              <div>
                <p className="text-ink-3">扣本金</p>
                <Money cents={s.consume.principal} className="font-bold text-pine" />
              </div>
              <div>
                <p className="text-ink-3">扣赠金</p>
                <Money cents={s.consume.bonus} className="font-bold text-yuzu-deep" />
              </div>
            </div>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-line px-5 pt-4 pb-3">
            <p className="flex items-center gap-2 text-[13px] font-bold text-ink-2">
              <Undo2 className="size-4 text-clay" />
              撤销与赠金
            </p>
            <Money cents={s.reversal.principal + s.reversal.bonus} className="mt-1.5 text-[32px] leading-none font-bold text-clay" />
            <p className="mt-1.5 text-[12.5px] text-ink-3">
              {s.reversal.count} 笔撤销恢复{s.reversal.crossDayCount ? ` · ${s.reversal.crossDayCount} 笔跨日` : ''}
            </p>
          </div>
          <div className="space-y-2 px-5 py-4 text-[13px]">
            <Row label="恢复本金" cents={s.reversal.principal} className="text-pine" />
            <Row label="恢复赠金" cents={s.reversal.bonus} className="text-yuzu-deep" />
            <div className="my-1 border-t border-dashed border-line" />
            <Row label="本日发放赠金" cents={s.recharge.bonus} className="text-yuzu-deep" />
            <Row label="本日使用赠金" cents={s.consume.bonus} className="text-ink-2" />
            <Row label={`赠金过期作废${s.expiry.count ? `（${s.expiry.count} 笔）` : ''}`} cents={s.expiry.bonus} className="text-ink-3" />
            {(s.opening.count > 0 || s.opening.voidCount > 0) && (
              <div data-testid="settlement-opening">
                <div className="my-1 border-t border-dashed border-line" />
                <p className="mb-1.5 text-[12px] text-ink-3">
                  旧系统期初余额迁入 {s.opening.count} 位{s.opening.voidCount ? ` · 作废 ${s.opening.voidCount} 位` : ''}（不是收款，不计入充值实收）
                </p>
                <Row label="期初本金（净额）" cents={s.opening.principal} className="text-pine" />
                <Row label="期初赠金（净额）" cents={s.opening.bonus} className="text-yuzu-deep" />
              </div>
            )}
          </div>
        </Card>
      </div>

      <BusinessCard s={s} />
      <DepositsCard s={s} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* 余额核对（手机上表格放不下时在框内横向滑动） */}
        <Card className="p-5">
          <SectionTitle>余额核对</SectionTitle>
          <div className="mt-3 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-max text-[13px]">
              <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left">会员储值</th>
                  <th className="px-3 py-2 text-right">期初</th>
                  <th className="px-3 py-2 text-right">本日变动</th>
                  <th className="px-3 py-2 text-right">期末</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(['principal', 'bonus'] as const).map((k) => (
                  <tr key={k}>
                    <td className="px-3 py-2.5 font-semibold">
                      <span className={cn('mr-2 inline-block size-2 rounded-full', k === 'principal' ? 'bg-pine' : 'bg-yuzu')} />
                      {k === 'principal' ? '本金' : '赠金'}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Money cents={s.balances.opening[k]} className="text-ink-2" />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Money cents={s.net[k]} signed className={cn('font-semibold', s.net[k] < 0 ? 'text-clay' : s.net[k] > 0 ? 'text-moss' : 'text-ink-4')} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Money cents={s.balances.closing[k]} className="font-bold" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-4 space-y-2.5">
            {s.checks.map((c) => (
              <li key={c.key} className="flex gap-2.5">
                {c.ok ? <CircleCheck className="mt-0.5 size-[18px] shrink-0 text-pine" /> : <CircleX className="mt-0.5 size-[18px] shrink-0 text-clay" />}
                <div className="min-w-0">
                  <p className={cn('text-[13.5px] font-bold', c.ok ? 'text-ink' : 'text-clay')}>{c.label}</p>
                  <p className="text-[12.5px] break-all text-ink-3">{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-4">
          {/* 异常与提醒 */}
          <Card className="p-5">
            <SectionTitle aside={<span className="text-[12px] text-ink-3">{s.anomalies.length} 条</span>}>异常与提醒</SectionTitle>
            {s.anomalies.length === 0 ? (
              <EmptyState art="leaf" title="没有异常记录" description="没有撤销、重复提交或核对差异。" className="py-6" />
            ) : (
              <ul className="mt-3 space-y-2">
                {s.anomalies.map((a, i) => (
                  <AnomalyItem key={i} a={a} />
                ))}
              </ul>
            )}
          </Card>

          {/* 按员工 */}
          <Card className="p-5">
            <SectionTitle>按员工</SectionTitle>
            {s.byStaff.length === 0 ? (
              <p className="mt-3 text-[13px] text-ink-4">无业务</p>
            ) : (
              <table className="mt-2 w-full text-[13px]">
                <thead className="text-[12px] text-ink-3">
                  <tr>
                    <th className="py-1.5 text-left font-semibold">员工</th>
                    <th className="py-1.5 text-right font-semibold">充值实收</th>
                    <th className="py-1.5 text-right font-semibold">消费</th>
                    <th className="py-1.5 text-right font-semibold">撤销</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {s.byStaff.map((st) => (
                    <tr key={st.staffId}>
                      <td className="py-2 font-semibold">{st.name}</td>
                      <td className="py-2 text-right">
                        <Money cents={st.rechargePaid} className="text-lake" />
                        <span className="ml-1 text-[11.5px] text-ink-3">/{st.rechargeCount}</span>
                      </td>
                      <td className="py-2 text-right">
                        <Money cents={st.consumeTotal} />
                        <span className="ml-1 text-[11.5px] text-ink-3">/{st.consumeCount}</span>
                      </td>
                      <td className="num py-2 text-right">{st.reversalCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>

      <Link
        to={`/ledger${s.isToday ? '' : `?date=${s.businessDate}`}`}
        className="flex items-center justify-between rounded-lg border border-line bg-card px-5 py-4 text-[14px] font-bold text-pine shadow-card transition-colors hover:bg-pine-tint"
      >
        查看本营业日全部流水明细
        <ArrowRight className="size-5" />
      </Link>
    </div>
  );
}

function Row({ label, cents, className }: { label: string; cents: number; className?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-3">{label}</span>
      <Money cents={cents} className={cn('font-bold', className)} />
    </div>
  );
}

function SplitBar({ principal, bonus }: { principal: number; bonus: number }) {
  const total = principal + bonus;
  const p = total ? (principal / total) * 100 : 0;
  return (
    <div className="flex h-2.5 overflow-hidden rounded-full bg-paper-2" aria-label={`本金占 ${p.toFixed(0)}%`}>
      <div className="h-full bg-pine" style={{ width: `${p}%` }} />
      <div className="h-full bg-yuzu" style={{ width: `${total ? 100 - p : 0}%` }} />
    </div>
  );
}

const ANOMALY_META: Record<
  SettlementAnomaly['kind'],
  { label: string; tone: 'clay' | 'ember' | 'lake' | 'yuzu'; icon: typeof Undo2; iconClass: string }
> = {
  reversal: { label: ANOMALY_LABELS.reversal, tone: 'clay', icon: Undo2, iconClass: 'bg-clay-soft text-clay' },
  cross_day_reversal: { label: ANOMALY_LABELS.cross_day_reversal, tone: 'ember', icon: Undo2, iconClass: 'bg-ember-soft text-ember' },
  duplicate_blocked: { label: ANOMALY_LABELS.duplicate_blocked, tone: 'lake', icon: Copy, iconClass: 'bg-lake-soft text-lake' },
  rejected: { label: ANOMALY_LABELS.rejected, tone: 'yuzu', icon: WalletMinimal, iconClass: 'bg-yuzu-soft text-yuzu-deep' },
  abandoned: { label: ANOMALY_LABELS.abandoned, tone: 'ember', icon: CircleSlash, iconClass: 'bg-ember-soft text-ember' },
  balance_mismatch: { label: ANOMALY_LABELS.balance_mismatch, tone: 'clay', icon: CircleX, iconClass: 'bg-clay-soft text-clay' },
  chain_break: { label: ANOMALY_LABELS.chain_break, tone: 'clay', icon: CircleX, iconClass: 'bg-clay-soft text-clay' },
  checkout_void: { label: ANOMALY_LABELS.checkout_void, tone: 'ember', icon: Undo2, iconClass: 'bg-ember-soft text-ember' },
  discount: { label: ANOMALY_LABELS.discount, tone: 'yuzu', icon: BadgePercent, iconClass: 'bg-yuzu-soft text-yuzu-deep' },
  ticket_override: { label: ANOMALY_LABELS.ticket_override, tone: 'yuzu', icon: Ticket, iconClass: 'bg-yuzu-soft text-yuzu-deep' },
  visit_cancel: { label: ANOMALY_LABELS.visit_cancel, tone: 'lake', icon: CircleSlash, iconClass: 'bg-lake-soft text-lake' },
  line_void: { label: ANOMALY_LABELS.line_void, tone: 'lake', icon: CircleSlash, iconClass: 'bg-lake-soft text-lake' },
  backfill: { label: ANOMALY_LABELS.backfill, tone: 'lake', icon: FilePenLine, iconClass: 'bg-lake-soft text-lake' },
  refund: { label: ANOMALY_LABELS.refund, tone: 'ember', icon: Undo2, iconClass: 'bg-ember-soft text-ember' },
  refund_void: { label: ANOMALY_LABELS.refund_void, tone: 'clay', icon: CircleSlash, iconClass: 'bg-clay-soft text-clay' },
};

function AnomalyItem({ a }: { a: SettlementAnomaly }) {
  const meta = ANOMALY_META[a.kind];
  const Icon = meta.icon;
  return (
    <li className="flex gap-3 rounded-lg bg-paper/70 px-3 py-2.5 ring-1 ring-line/70">
      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', meta.iconClass)}>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {a.memberName && <span className="text-[13px] font-bold">{a.memberName}</span>}
          {a.docNo && <span className="num text-[12px] text-ink-3">{a.docNo}</span>}
          {a.at && <span className="num text-[12px] text-ink-3">{formatTime(a.at)}</span>}
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{a.description}</p>
      </div>
      {a.amount != null && <Money cents={a.amount} className="shrink-0 text-[13px] font-bold" />}
    </li>
  );
}

function CloseDialog({ open, onClose, s }: { open: boolean; onClose: () => void; s: SettlementSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allOk = s.checks.every((c) => c.ok);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.post<SettlementSummary>(`/api/settlements/${s.businessDate}/close`, { note });
      qc.setQueryData(qk.settlement(s.businessDate), result);
      toast({ tone: 'success', title: '日结已确认', body: `${s.businessDate} · 第 ${result.closed?.revision ?? 1} 次确认` });
      onClose();
      setNote('');
      setChecked(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={s.closed ? '重新确认日结' : '确认日结'}
      description={`营业日 ${s.businessDate}。确认会保存当前汇总快照，之后如有变动会提示。`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} disabled={!checked} onClick={submit}>
            确认日结
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {s.isToday && (
          <Notice tone="warning" title="营业日还没结束">
            现在确认后，如果今天还有新业务，日结会显示「有变动」，届时需要重新确认。
          </Notice>
        )}
        {!allOk && <Notice tone="error" title="核对存在差异，请先排查后再确认" />}
        <div className="grid grid-cols-3 gap-2.5 rounded-lg bg-paper-2/70 p-3 text-[12.5px]">
          <div>
            <p className="text-ink-3">充值实收</p>
            <Money cents={s.recharge.paid} className="text-[15px] font-bold text-lake" />
          </div>
          <div>
            <p className="text-ink-3">储值消费</p>
            <Money cents={s.consume.total} className="text-[15px] font-bold" />
          </div>
          <div>
            <p className="text-ink-3">撤销恢复</p>
            <Money cents={s.reversal.principal + s.reversal.bonus} className="text-[15px] font-bold text-clay" />
          </div>
        </div>
        <Field label="日结备注" htmlFor="close-note" hint="选填，如现金盘点结果">
          <Textarea id="close-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ConfirmCheck checked={checked} onChange={setChecked}>
          我已核对实际收款（微信、支付宝、现金等）与「充值实收」一致
        </ConfirmCheck>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/**
 * 客房押金（S7，v0.7.4）：押金是负债，不算营业额。收、退按收款方式（现金进出钱箱，交班按此核对）；
 * 房费挂在住客的手牌账单上、随手牌结账。没有押金往来、也没有在住押金时不显示。
 */
function DepositsCard({ s }: { s: SettlementSummary }) {
  const d = s.deposits;
  if (!d || (d.received.length === 0 && d.refunded.length === 0 && d.held === 0)) return null;
  const sum = (list: typeof d.received) => list.reduce((t, m) => t + m.amount, 0);
  const line = (list: typeof d.received) => (list.length ? list.map((m) => `${PAYMENT_METHOD_LABELS[m.method]} ${m.count} 笔 ¥${(m.amount / 100).toFixed(2)}`).join('、') : '无');
  return (
    <Card className="overflow-hidden" data-testid="settlement-deposits">
      <div className="border-b border-line px-5 pt-4 pb-3">
        <p className="flex items-center gap-2 text-[13px] font-bold text-ink-2">
          <span className="size-2 rounded-full bg-lake" />
          客房押金 · 负债，不算营业额
        </p>
        <p className="mt-1.5 text-[12.5px] text-ink-3">
          当天结束时在住押金 <Money cents={d.held} className="font-bold text-ink" />
        </p>
      </div>
      <div className="space-y-2 px-5 py-4 text-[13px]">
        <Row label="收押金" cents={sum(d.received)} className="text-ink" />
        <p className="pl-3 text-[12px] text-ink-3">{line(d.received)}</p>
        <Row label="退押金（原路退回）" cents={-sum(d.refunded)} className="text-clay" />
        <p className="pl-3 text-[12px] text-ink-3">{line(d.refunded)}</p>
        <p className="text-[12px] text-ink-4">现金押金进出钱箱，交班按此核对应有现金；扫码、银行卡收的押金退房时在商户后台原路退。</p>
      </div>
    </Card>
  );
}

/**
 * 营业口径（Batch 3）：前台结账的营业额与收款；会员储值支付同时是会员口径的储值消费。
 * R1.2（店主 2026-10-29 签认）分列应收、优惠、净营业额、实收：应收 = 结账 − 反结账，净营业额 = 应收 − 优惠。
 */
function BusinessCard({ s }: { s: SettlementSummary }) {
  const b = s.business;
  const biz = businessBreakdown(b);
  if (b.checkouts.count === 0 && b.voids.count === 0 && s.recharge.count === 0) return null;
  const { rows: cashMethods, total: cashTotal } = receivedByMethod(s);
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="settlement-business">
      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 pt-4 pb-3">
          <p className="flex items-center gap-2 text-[13px] font-bold text-ink-2">
            <span className="size-2 rounded-full bg-pine" />
            营业口径 · 前台结账 · 净营业额
          </p>
          <Money cents={biz.netRevenue} className="mt-1.5 text-[32px] leading-none font-bold text-pine" />
          <p className="mt-1.5 text-[12.5px] text-ink-3">
            结账 {b.checkouts.count} 张 <Money cents={b.checkouts.total} />
            {b.voids.count > 0 && (
              <>
                {' '}
                · 反结账 {b.voids.count} 张 −<Money cents={b.voids.total} />
              </>
            )}
            {biz.discount !== 0 && (
              <>
                {' '}
                · 优惠 <Money cents={-biz.discount} signed />
              </>
            )}
          </p>
        </div>
        <div className="space-y-2 px-5 py-4 text-[13px]" data-testid="settlement-breakdown">
          <Row label="门票" cents={b.ticket} className="text-ink" />
          <Row label="项目与其他" cents={b.items} className="text-ink" />
          <Row label="应收（结账 − 反结账）" cents={biz.receivable} className="font-bold text-ink" />
          <Row label="优惠 / 免单（当场授权）" cents={-biz.discount} className="text-yuzu-deep" />
          <Row label="净营业额（应收 − 优惠）" cents={biz.netRevenue} className="font-bold text-pine" />
          <Row label="实收（现金、扫码、银行卡、其他）" cents={biz.received} className="text-lake" />
          <div className="my-1 border-t border-dashed border-line" />
          {b.byMethod.map((m) => (
            <div key={m.method} className="flex items-center justify-between">
              <span className="text-ink-3">
                {CHECKOUT_METHOD_LABELS[m.method]}
                <span className="ml-1 text-[12px]">· {m.count} 笔{m.voidCount ? `，反结账 ${m.voidCount}` : ''}</span>
                {m.method === 'wallet' && <span className="ml-1 text-[11.5px] text-ink-4">（会员余额抵扣，同时计入储值消费）</span>}
                {m.method === 'coupon' && <span className="ml-1 text-[11.5px] text-ink-4">（平台团购核销）</span>}
                {m.method === 'discount' && <span className="ml-1 text-[11.5px] text-ink-4">（不是收款）</span>}
              </span>
              <Money cents={m.amount} className="font-bold" />
            </div>
          ))}
          {b.coupons.map((c) => (
            <p key={c.platform} className="pl-3 text-[12px] text-ink-3">
              {COUPON_PLATFORM_LABELS[c.platform]} {c.count} 张 <Money cents={c.amount} />
              {c.voidCount ? `（作废 ${c.voidCount} 张）` : ''}
            </p>
          ))}
        </div>
      </Card>
      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 pt-4 pb-3">
          <p className="flex items-center gap-2 text-[13px] font-bold text-ink-2">
            <span className="size-2 rounded-full bg-lake" />
            实收合计 · 充值 + 结账
          </p>
          <Money cents={cashTotal} className="mt-1.5 text-[32px] leading-none font-bold text-lake" />
          <p className="mt-1.5 text-[12.5px] text-ink-3">按收款方式核对抽屉现金与各收款账户；会员储值、团购券、优惠 / 免单不计入</p>
        </div>
        <div className="px-5 py-4">
          <table className="w-full text-[13px]">
            <thead className="text-[12px] text-ink-3">
              <tr>
                <th className="pb-1.5 text-left font-semibold">方式</th>
                <th className="pb-1.5 text-right font-semibold">充值</th>
                <th className="pb-1.5 text-right font-semibold">结账</th>
                <th className="pb-1.5 text-right font-semibold">合计</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {cashMethods.map((r) => (
                <tr key={r.method}>
                  <td className="py-1.5 font-semibold text-ink-2">{PAYMENT_METHOD_LABELS[r.method]}</td>
                  <td className="py-1.5 text-right">
                    <Money cents={r.recharge} className="text-ink-3" />
                  </td>
                  <td className="py-1.5 text-right">
                    <Money cents={r.checkout} className="text-ink-3" />
                  </td>
                  <td className="py-1.5 text-right">
                    <Money cents={r.total} className="font-bold" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
