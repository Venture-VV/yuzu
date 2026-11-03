import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { ISO_DATE } from '@shared/business-date';
import { businessBreakdown, CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS } from '@shared/checkout';
import { describeDate, PAYMENT_METHOD_LABELS } from '@shared/labels';
import type { SettlementSummary } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { ANOMALY_LABELS, receivedByMethod } from '../settlement/summary';
import { PrintedAt, PrintFrame, Row, SignLine, SlipHeader, stamp, yuan } from './PrintFrame';

// A4 日结单（R1.3）：营业口径（应收、优惠 / 免单、净营业额、实收）、实收合计、会员储值、余额核对、核对结论、异常与提醒、
// 按员工与签字栏。数字与「日结」页同一个接口；营业日还没结束时，打出来的是截至此刻的数。

export function SettlementPrintPage() {
  const date = useParams().date ?? '';
  const valid = ISO_DATE.test(date);
  const q = useQuery({
    queryKey: ['print', 'settlement', date],
    queryFn: () => api.get<SettlementSummary>(`/api/settlements/${date}`),
    enabled: valid,
    refetchOnWindowFocus: false,
  });
  return (
    <PrintFrame
      paper="a4"
      title={`日结单 ${date}`}
      ready={!!q.data}
      error={!valid ? '营业日格式不正确' : q.error ? errorMessage(q.error) : null}
    >
      {q.data && <SettlementSheet s={q.data} />}
    </PrintFrame>
  );
}

function Section({ title, children, wide, testId }: { title: string; children: ReactNode; wide?: boolean; testId?: string }) {
  return (
    <section className={wide ? 'col-span-2 break-inside-avoid' : 'break-inside-avoid'} data-testid={testId}>
      <h2 className="mb-1 border-b border-black pb-0.5 text-[13px] font-bold">{title}</h2>
      {children}
    </section>
  );
}

// 单元格左右留出间距，金额列与文字列不挤在一起
const th = 'border-b border-black px-1 py-0.5 text-left font-bold first:pl-0 last:pr-0';
const thNum = 'border-b border-black px-1 py-0.5 text-right font-bold first:pl-0 last:pr-0';
const td = 'px-1 py-0.5 align-top first:pl-0 last:pr-0';
const tdNum = 'num px-1 py-0.5 text-right align-top first:pl-0 last:pr-0';

function SettlementSheet({ s }: { s: SettlementSummary }) {
  const session = useSession();
  const tz = session.timezone;
  const b = s.business;
  const biz = businessBreakdown(b);
  const received = receivedByMethod(s);
  const failed = s.checks.filter((c) => !c.ok);
  const d = describeDate(s.businessDate);
  const status = s.closed
    ? s.closed.changedSinceClose
      ? `已确认日结（第 ${s.closed.revision} 次，${s.closed.closedByName} ${stamp(s.closed.closedAt, tz)}）· 确认后又有新的业务，需重新确认`
      : `已确认日结 · ${s.closed.closedByName} ${stamp(s.closed.closedAt, tz)}（第 ${s.closed.revision} 次）`
    : s.isToday
      ? '未确认日结 · 营业日尚未结束，是截至此刻的数'
      : '未确认日结';

  return (
    <div data-testid="print-settlement">
      <SlipHeader title="日结单" />
      <p className="text-center">
        营业日 {s.businessDate}（{d.weekday}）· 每天 {String(session.rules.businessDayStartHour).padStart(2, '0')}:00 切换
      </p>
      <p className="mt-1 text-center font-bold" data-testid="print-settlement-status">
        {status}
      </p>
      {s.closed?.note && <p className="text-center">日结备注：{s.closed.note}</p>}
      <p className="mt-1 mb-3 text-center font-bold" data-testid="print-settlement-checks">
        {failed.length ? `✗ ${failed.length} 项核对不一致，见下方「核对」` : `✓ ${s.checks.length} 项核对全部一致`}
      </p>

      <div className="grid grid-cols-2 gap-x-[8mm] gap-y-4">
        <Section title="营业口径 · 前台结账" testId="print-settlement-business">
          <Row left={`结账 ${b.checkouts.count} 张`} right={yuan(b.checkouts.total)} />
          {b.voids.count > 0 && <Row left={`反结账 ${b.voids.count} 张`} right={yuan(-b.voids.total)} />}
          <Row left="应收（结账 − 反结账）" right={yuan(biz.receivable)} strong />
          <Row left="优惠 / 免单（当场授权，不是收款）" right={yuan(-biz.discount)} />
          {biz.coupon !== 0 && <Row left="券抵扣（不是收款）" right={yuan(-biz.coupon)} />}
          {biz.refund !== 0 && <Row left={`退款（退款单 ${b.refunds?.count ?? 0} 张）`} right={yuan(-biz.refund)} />}
          <Row left="净营业额（应收 − 优惠 − 券抵扣 − 退款）" right={yuan(biz.netRevenue)} strong />
          <Row left="实收（现金、扫码、银行卡、其他，减去退款）" right={yuan(biz.received)} />
          <Row left="其中门票" right={yuan(b.ticket)} />
          <Row left="其中项目与其他" right={yuan(b.items)} />
          <p className="mt-1.5 font-bold">收款方式</p>
          {b.byMethod.length === 0 && <p>无</p>}
          {b.byMethod.map((m) => (
            <Row
              key={m.method}
              left={`${CHECKOUT_METHOD_LABELS[m.method] ?? m.method} · ${m.count} 笔${m.voidCount ? `，反结账 ${m.voidCount}` : ''}`}
              right={yuan(m.amount)}
            />
          ))}
          {b.coupons.map((c) => (
            <p key={c.platform} className="pl-3 text-[11px]">
              团购 {COUPON_PLATFORM_LABELS[c.platform]} {c.count} 张 {yuan(c.amount)}
              {c.voidCount ? `（作废 ${c.voidCount} 张）` : ''}
            </p>
          ))}
        </Section>

        <Section title="实收合计 · 充值 + 结账" testId="print-settlement-received">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>方式</th>
                <th className={thNum}>充值</th>
                <th className={thNum}>结账</th>
                <th className={thNum}>退款</th>
                <th className={thNum}>合计</th>
              </tr>
            </thead>
            <tbody>
              {received.rows.map((r) => (
                <tr key={r.method}>
                  <td className={td}>{PAYMENT_METHOD_LABELS[r.method]}</td>
                  <td className={tdNum}>{yuan(r.recharge)}</td>
                  <td className={tdNum}>{yuan(r.checkout)}</td>
                  <td className={tdNum}>{r.refund ? yuan(-r.refund) : ''}</td>
                  <td className={tdNum}>{yuan(r.total)}</td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className={`${td} border-t border-black`}>合计</td>
                <td className={`${tdNum} border-t border-black`} />
                <td className={`${tdNum} border-t border-black`} />
                <td className={`${tdNum} border-t border-black`} />
                <td className={`${tdNum} border-t border-black`}>{yuan(received.total)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1 text-[11px]">按收款方式核对抽屉现金与各收款账户（已减去当天的退款单）；会员储值、团购券、优惠 / 免单、券抵扣不计入。</p>
        </Section>

        {s.deposits && (s.deposits.received.length > 0 || s.deposits.refunded.length > 0 || s.deposits.held !== 0) && (
          <Section title="客房押金 · 负债，不算营业额" testId="print-settlement-deposits">
            {s.deposits.received.map((m) => (
              <Row key={`r-${m.method}`} left={`收 ${PAYMENT_METHOD_LABELS[m.method]} · ${m.count} 笔`} right={yuan(m.amount)} />
            ))}
            {s.deposits.refunded.map((m) => (
              <Row key={`f-${m.method}`} left={`退 ${PAYMENT_METHOD_LABELS[m.method]} · ${m.count} 笔`} right={yuan(-m.amount)} />
            ))}
            <Row left="当天结束时在住押金" right={yuan(s.deposits.held)} strong />
          </Section>
        )}

        <Section title="会员储值">
          <Row left={`充值实收 · ${s.recharge.count} 笔`} right={yuan(s.recharge.paid)} strong />
          {s.recharge.byMethod.map((m) => (
            <Row key={m.method} left={<span className="pl-3">{`${PAYMENT_METHOD_LABELS[m.method]} · ${m.count} 笔`}</span>} right={yuan(m.amount)} />
          ))}
          <Row left="赠送赠金（不是收款）" right={yuan(s.recharge.bonus)} />
          <Row left={`储值消费 · ${s.consume.count} 笔${s.consume.reversedCount ? `（已撤销 ${s.consume.reversedCount}）` : ''}`} right={yuan(s.consume.total)} strong />
          <Row left={<span className="pl-3">扣本金 / 扣赠金</span>} right={`${yuan(s.consume.principal)} / ${yuan(s.consume.bonus)}`} />
          <Row left={`撤销恢复 · ${s.reversal.count} 笔${s.reversal.crossDayCount ? `（跨日 ${s.reversal.crossDayCount}）` : ''}`} right={`${yuan(s.reversal.principal)} / ${yuan(s.reversal.bonus)}`} />
          <Row left={`赠金过期作废${s.expiry.count ? ` · ${s.expiry.count} 笔` : ''}`} right={yuan(s.expiry.bonus)} />
          {(s.opening.count > 0 || s.opening.voidCount > 0) && (
            <Row
              left={`旧系统期初迁入 ${s.opening.count} 位${s.opening.voidCount ? `，作废 ${s.opening.voidCount} 位` : ''}（本金 / 赠金）`}
              right={`${yuan(s.opening.principal)} / ${yuan(s.opening.bonus)}`}
            />
          )}
        </Section>

        <Section title="余额核对">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>会员储值</th>
                <th className={thNum}>期初</th>
                <th className={thNum}>本日变动</th>
                <th className={thNum}>期末</th>
              </tr>
            </thead>
            <tbody>
              {(['principal', 'bonus'] as const).map((k) => (
                <tr key={k}>
                  <td className={td}>{k === 'principal' ? '本金' : '赠金'}</td>
                  <td className={tdNum}>{yuan(s.balances.opening[k])}</td>
                  <td className={tdNum}>{yuan(s.net[k])}</td>
                  <td className={tdNum}>{yuan(s.balances.closing[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="核对" wide>
          <ul className="space-y-0.5">
            {s.checks.map((c) => (
              <li key={c.key} className="break-all">
                <span className="font-bold">
                  {c.ok ? '✓' : '✗'} {c.label}
                </span>
                ：{c.detail}
              </li>
            ))}
          </ul>
        </Section>

        <Section title={`异常与提醒 · ${s.anomalies.length} 条`} wide testId="print-settlement-anomalies">
          {s.anomalies.length === 0 ? (
            <p>没有异常记录</p>
          ) : (
            <table className="w-full table-fixed">
              <thead>
                <tr>
                  <th className={`${th} w-[13mm]`}>时间</th>
                  <th className={`${th} w-[24mm]`}>类别</th>
                  <th className={`${th} w-[34mm]`}>单号</th>
                  <th className={`${thNum} w-[24mm] pr-3`}>金额</th>
                  <th className={th}>说明</th>
                </tr>
              </thead>
              <tbody>
                {s.anomalies.map((a, i) => (
                  <tr key={i}>
                    <td className={`${td} num`}>{a.at ? stamp(a.at, tz).slice(11) : ''}</td>
                    <td className={td}>{ANOMALY_LABELS[a.kind] ?? a.kind}</td>
                    <td className={`${td} num break-all`}>{a.docNo ?? ''}</td>
                    <td className={`${tdNum} pr-3`}>{a.amount == null ? '' : yuan(a.amount)}</td>
                    <td className={`${td} break-all`}>
                      {a.memberName ? `${a.memberName} · ` : ''}
                      {a.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="按员工（会员储值）" wide>
          {s.byStaff.length === 0 ? (
            <p>无业务</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>员工</th>
                  <th className={thNum}>充值笔数</th>
                  <th className={thNum}>充值实收</th>
                  <th className={thNum}>消费笔数</th>
                  <th className={thNum}>消费</th>
                  <th className={thNum}>撤销</th>
                </tr>
              </thead>
              <tbody>
                {s.byStaff.map((st) => (
                  <tr key={st.staffId}>
                    <td className={td}>{st.name}</td>
                    <td className={tdNum}>{st.rechargeCount}</td>
                    <td className={tdNum}>{yuan(st.rechargePaid)}</td>
                    <td className={tdNum}>{st.consumeCount}</td>
                    <td className={tdNum}>{yuan(st.consumeTotal)}</td>
                    <td className={tdNum}>{st.reversalCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-x-[8mm] break-inside-avoid">
        <SignLine label="日结人" name={s.closed?.closedByName} />
        <SignLine label="值班经理" />
        <SignLine label="店主" />
      </div>
      <PrintedAt />
    </div>
  );
}
