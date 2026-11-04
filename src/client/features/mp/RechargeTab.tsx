// 后台「微信小程序」→「线上充值」（小程序线第二期 2a，docs/MP_RECHARGE.md；权限 mp.recharge：店主、店总）：
//   · 微信支付配没配好（凭据只在门店 yuzu 的 .env）；
//   · 设置：开关（默认关）、线上可充的套餐、自定义金额的开关（默认开）、线上单笔上限、每人每天笔数（带版本号保存，结果待确认照其他开关）；
//   · 已付款待处理的单：重新入账、按金额入账（不发套餐券）、已另行处理，都要写原因（带操作编号，结果待确认时查回或按原内容重新提交）；
//   · 最近的单子与验过签、门店系统里找不到单子的到账通知；
//   · 原路退回（2d）：开关在设置里；没退成的重试、已另行处理（RefundsCard.tsx）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatYuan, parseYuan } from '@shared/money';
import type { MpAdminData, MpRechargeAdminData, MpRechargeOrderAdmin, MpRechargeRecon, MpRechargeResolution, MpRechargeStatus, MpReconIssueKind } from '@shared/mp';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, MoneyInput, Notice, Segmented, Skeleton, Textarea } from '../../components/ui';
import { mpAdminKey, PendingUpdates, saveError, updateFailed } from './mpAdminShared';
import { lookupResolveOp, removeMpPending, sendMpOp, sendResolve, sendUpdate, useMpPending, type MpPendingOp } from './mpPending';
import { RefundsCard } from './RefundsCard';

const rechargeKey = ['mp', 'recharge'] as const;

const STATUS: Record<MpRechargeStatus, { label: string; tone: 'neutral' | 'pine' | 'moss' | 'ember' | 'clay' | 'lake' }> = {
  pending: { label: '待支付', tone: 'lake' },
  paid: { label: '已入账', tone: 'pine' },
  closed: { label: '已关闭', tone: 'neutral' },
  held: { label: '已付款待处理', tone: 'ember' },
  handled: { label: '已另行处理', tone: 'clay' },
};
const FLAG_LABELS: Record<string, string> = { frozen: '到账时会员已停用', merged: '记到了合并进去的会员', after_close: '关单之后才付的' };
const CLOSE_LABELS: Record<string, string> = { expired: '到期没付', cancelled: '顾客取消', wx_closed: '微信那边关了', wx_failed: '微信下单失败' };
const RESOLUTIONS: { value: MpRechargeResolution; label: string; hint: string }[] = [
  { value: 'rebook', label: '重新入账', hint: '照原来的套餐入账（规则调回来以后用）' },
  { value: 'rebook_amount', label: '按金额入账', hint: '不按套餐、不发套餐券，赠金照档自动算' },
  { value: 'handled', label: '已另行处理', hint: '例如在商户平台原路退回了、前台另记了；门店系统不入账' },
];
/** 到账与单子对不上、付了又退了、同一个交易单号入过别的账：只能记已另行处理 */
const NO_REBOOK = new Set(['MISMATCH', 'WX_REFUND', 'ONLINE_REF_CONFLICT']);

export function RechargeTab({ data }: { data: MpAdminData }) {
  const q = useQuery({ queryKey: rechargeKey, queryFn: () => api.get<MpRechargeAdminData>('/api/admin/mp/recharge') });
  const pendingRules = useMpPending('recharge_rules_update');
  const pendingResolves = useMpPending('recharge_resolve');
  if (!q.data) return <Skeleton className="h-48" />;
  const d = q.data;
  return (
    <div className="space-y-4">
      {pendingRules.length > 0 && <PendingUpdates ops={pendingRules} data={data} />}
      {pendingResolves.length > 0 && <PendingResolves ops={pendingResolves} />}
      <PayStatus d={d} />
      <RulesForm key={data.rechargeRules.version} d={d} rules={data.rechargeRules} pending={pendingRules.length > 0} />
      <HeldOrders orders={d.held} pending={pendingResolves} />
      <RefundsCard refunds={d.refunds} refundAuto={data.rechargeRules.refundAuto} />
      <RecentOrders orders={d.recent} />
      <Recons recons={d.recons} canRun={d.payMode !== null} />
      {d.orphans.length > 0 && (
        <Notice tone="error" title={`${d.orphans.length} 笔到账找不到单子`}>
          <p>微信支付验过签的真付款，门店系统里却没有这张单（例如门店系统从备份恢复过）。钱在商户号里，请在商户平台按交易单号核对后原路退回，或在前台另记。</p>
          <ul className="mt-2 space-y-1 text-[13px]">
            {d.orphans.map((o) => (
              <li key={o.id} className="num">
                {formatDateTime(o.createdAt)} · 商户单号 {o.outTradeNo} · 交易单号 {o.transactionId ?? '—'} · {o.amount === null ? '—' : formatYuan(o.amount)}
              </li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}

function PayStatus({ d }: { d: MpRechargeAdminData }) {
  if (d.payMode === 'real') return <Notice tone="info">门店系统的微信支付已配好。顾客付款、到账通知、退款凭据都只在门店系统里，网关不经手。</Notice>;
  if (d.payMode === 'mock')
    return (
      <Notice tone="warning" title="模拟微信支付">
        这是演示库：小程序里点「模拟支付」就算付了，不走真钱。正式、演练的门店系统不能开模拟。
      </Notice>
    );
  return (
    <Notice tone={d.payProblem ? 'error' : 'warning'} title={d.payProblem ? '微信支付的配置不对，线上充值没开' : '门店系统还没配微信支付'}>
      {d.payProblem ?? '商户号与凭据配在门店系统的 .env 里（见 docs/MP_RECHARGE.md 第 4 节）；没配好之前，开关打开了顾客也充不了，会提示到前台充值。'}
    </Notice>
  );
}

function RulesForm({ d, rules, pending }: { d: MpRechargeAdminData; rules: MpAdminData['rechargeRules']; pending: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [enabled, setEnabled] = useState(rules.enabled);
  const [planIds, setPlanIds] = useState<number[]>(rules.planIds);
  const [customEnabled, setCustomEnabled] = useState(rules.customEnabled);
  const [refundAuto, setRefundAuto] = useState(rules.refundAuto);
  const [max, setMax] = useState(String(rules.maxCents / 100));
  const [daily, setDaily] = useState(String(rules.dailyLimit));
  const [saving, setSaving] = useState(false);
  const maxCents = parseYuan(max);
  const dailyLimit = Number(daily);
  const invalid =
    maxCents === null || maxCents % 100 !== 0 || maxCents < 100
      ? '线上单笔上限请填整元'
      : !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 50
        ? '每天笔数填 1–50'
        : null;
  const save = async () => {
    if (invalid) return;
    setSaving(true);
    try {
      await sendUpdate({
        type: 'recharge_rules_update',
        url: '/api/admin/mp/recharge/rules',
        target: 'recharge_rules',
        body: { enabled, planIds, customEnabled, maxCents: maxCents!, dailyLimit, refundAuto, version: rules.version },
        summary: '线上充值的设置',
        staffName: session.staff.displayName,
      });
      await Promise.all([qc.invalidateQueries({ queryKey: mpAdminKey }), qc.invalidateQueries({ queryKey: rechargeKey })]);
      toast({ tone: 'success', title: '线上充值的设置已保存' });
    } catch (error) {
      updateFailed(toast, error);
      void qc.invalidateQueries({ queryKey: mpAdminKey });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-ink">线上充值</p>
          <p className="text-[13px] text-ink-3">
            与前台充值同一条入账：赠金按到账时的档自动算，首充 / 续充最低照会员规则；不进任何收银员的班次，日结与看板单列「线上（小程序）」。
          </p>
          {pending && <p className="text-[12.5px] text-ember">设置的修改结果待确认，先在上方处理</p>}
        </div>
        <Segmented
          value={enabled ? 'on' : 'off'}
          ariaLabel="线上充值开关"
          onChange={(v) => setEnabled(v === 'on')}
          options={[
            { value: 'off', label: '关闭', disabled: pending },
            { value: 'on', label: '开通', disabled: pending },
          ]}
        />
      </div>
      <Field label="线上可充的套餐" hint="只列启用的套餐；套餐上挂的券照发。一个都不勾也行（只用自定义金额）">
        <div className="grid gap-2 sm:grid-cols-2">
          {d.plans.map((p) => (
            <ConfirmCheck
              key={p.id}
              checked={planIds.includes(p.id)}
              onChange={(on) => setPlanIds((ids) => (on ? [...ids, p.id] : ids.filter((x) => x !== p.id)))}
            >
              {p.name} <span className="num text-ink-3">{formatYuan(p.payAmount)}</span>
            </ConfirmCheck>
          ))}
          {d.plans.length === 0 && <p className="text-[13px] text-ink-3">还没有启用的充值套餐（在「价目与套餐」里建）</p>}
        </div>
      </Field>
      <ConfirmCheck checked={customEnabled} onChange={setCustomEnabled}>
        允许顾客自己填金额（整元，最少是 1 元与首充 / 续充最低里大的，最多是线上单笔上限）
      </ConfirmCheck>
      <ConfirmCheck checked={refundAuto} onChange={setRefundAuto}>
        原路退回：退储值时，线上充值的那一行可以选「门店系统原路退回」，门店系统自己退回到顾客付款的微信，店里不用再去商户平台（关掉只影响以后的退储值）
      </ConfirmCheck>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="线上单笔上限" hint={`不超过前台的单笔上限 ${formatYuan(d.counterMaxCents)}；超过的请顾客到前台`} htmlFor="mp-recharge-max">
          <MoneyInput id="mp-recharge-max" value={max} onChange={(e) => setMax(e.target.value)} invalid={maxCents === null || maxCents % 100 !== 0} />
        </Field>
        <Field label="每人每天最多几笔" hint="按下单的营业日；没付关掉的不算" htmlFor="mp-recharge-daily">
          <Input
            id="mp-recharge-daily"
            inputMode="numeric"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
            invalid={!Number.isInteger(dailyLimit) || dailyLimit < 1}
          />
        </Field>
      </div>
      {invalid && <p className="text-[12.5px] text-ember">{invalid}</p>}
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} disabled={pending || !!invalid} onClick={save}>
          保存线上充值的设置
        </Button>
      </div>
    </Card>
  );
}

function HeldOrders({ orders, pending }: { orders: MpRechargeOrderAdmin[]; pending: MpPendingOp[] }) {
  const [resolving, setResolving] = useState<MpRechargeOrderAdmin | null>(null);
  if (orders.length === 0) return null;
  return (
    <Card className="p-0">
      <div className="border-b border-line px-4 py-3">
        <p className="text-[15px] font-semibold text-ember">已付款待处理（{orders.length}）</p>
        <p className="text-[13px] text-ink-3">顾客的钱已经付了，门店系统没能自动入账。顾客那边看到「已付款，门店正在核对」和门店电话。</p>
      </div>
      <div className="divide-y divide-line">
        {orders.map((o) => {
          const busy = pending.some((p) => p.target === String(o.id));
          return (
            <div key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="mp-recharge-held">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">
                  {o.memberName} <span className="num text-[12.5px] font-normal text-ink-3">{o.memberNo}</span> ·{' '}
                  <span className="num">{formatYuan(o.amount)}</span>
                  {o.planName ? `（${o.planName}）` : '（自定义金额）'}
                </p>
                <p className="text-[12.5px] text-ink-3">
                  {o.holdMessage} · 付款 {o.paidAt ? formatDateTime(o.paidAt) : '—'} · 交易单号 <span className="num">{o.transactionId}</span>
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                title={busy ? '这张单的处理结果待确认，先在上方处理' : undefined}
                onClick={() => setResolving(o)}
              >
                处理
              </Button>
            </div>
          );
        })}
      </div>
      {resolving && <ResolveDialog order={resolving} onClose={() => setResolving(null)} />}
    </Card>
  );
}

function ResolveDialog({ order, onClose }: { order: MpRechargeOrderAdmin; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const onlyHandled = !!order.holdCode && NO_REBOOK.has(order.holdCode);
  const choices = RESOLUTIONS.filter((r) => !onlyHandled || r.value === 'handled').filter((r) => r.value !== 'rebook' || order.planId !== null);
  const [action, setAction] = useState<MpRechargeResolution>(choices[0]!.value);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const done = await sendResolve({
        key: uuid(),
        orderId: order.id,
        action,
        note: note.trim(),
        summary: `${order.memberName} ${formatYuan(order.amount)} 的线上充值单：${RESOLUTIONS.find((r) => r.value === action)!.label}`,
        staffName: session.staff.displayName,
      });
      await qc.invalidateQueries({ queryKey: rechargeKey });
      toast({
        tone: 'success',
        title: done.status === 'paid' ? '已入账' : '已记「已另行处理」',
        body: done.rechargeDocNo ? `充值单 ${done.rechargeDocNo}` : undefined,
      });
      onClose();
    } catch (error) {
      if (error instanceof UncertainError) {
        toast({
          tone: 'info',
          title: '处理结果待确认',
          body: '没收到结果，不知道处理了没有。已记在本机：请在这一页上方查回或按原内容重新提交，不要另处理一次。',
        });
        onClose();
      } else {
        toast({ tone: 'error', title: '没有处理', body: errorMessage(error) });
        void qc.invalidateQueries({ queryKey: rechargeKey });
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="处理已付款待处理的线上充值单"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} disabled={!note.trim()} onClick={save}>
            确认
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13.5px]">
        <p>
          {order.memberName}（{order.memberNo}）付了 <span className="num font-semibold">{formatYuan(order.amount)}</span>
          {order.planName ? `，选的套餐「${order.planName}」` : '，自定义金额'}。没能入账的原因：{order.holdMessage}
        </p>
        {onlyHandled && <Notice tone="warning">到账与单子对不上（或已经退款、入过别的账），不能直接入账：请在商户平台核对后记「已另行处理」。</Notice>}
        <Segmented value={action} onChange={setAction} ariaLabel="怎么处理" options={choices.map((c) => ({ value: c.value, label: c.label }))} />
        <p className="text-[12.5px] text-ink-3">{choices.find((c) => c.value === action)?.hint}</p>
        <Field label="原因 / 怎么处理的" htmlFor="mp-recharge-note" hint="必填，最多 200 字；记在单子上，审计里也有">
          <Textarea id="mp-recharge-note" value={note} maxLength={200} rows={3} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function PendingResolves({ ops }: { ops: MpPendingOp[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const checked = useRef(new Set<string>());
  const settle = (op: MpPendingOp, title: string) => {
    removeMpPending(op.key);
    void qc.invalidateQueries({ queryKey: rechargeKey });
    toast({ tone: 'success', title, body: op.summary });
  };
  // 有新的待确认时查回一次：那张单已经不是「已付款待处理」就有结论
  const opKeys = useMemo(() => ops.map((op) => op.key).join('\n'), [ops]);
  useEffect(() => {
    for (const op of ops) {
      if (checked.current.has(op.key)) continue;
      checked.current.add(op.key);
      void lookupResolveOp(op)
        .then((r) => r.done && settle(op, '已查回：这张单已经处理过了'))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opKeys]);
  const resubmit = async (op: MpPendingOp) => {
    setBusy(op.key);
    try {
      await sendMpOp(op);
      settle(op, '已处理');
    } catch (error) {
      const r = await lookupResolveOp(op).catch(() => null);
      if (r?.done) settle(op, '已查回：这张单已经处理过了');
      else toast({ tone: 'error', title: '还没确认', body: saveError(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Notice tone="warning" title={`${ops.length} 张线上充值单的处理结果待确认`}>
      <p>上次处理时网络断了或没收到结果，不知道处理了没有。按原内容重新提交不会处理两次（同一个编号只处理一次）。</p>
      <ul className="mt-2 space-y-2">
        {ops.map((op) => (
          <li key={op.key} className="flex flex-wrap items-center gap-2" data-testid="mp-recharge-resolve-pending">
            <span className="font-semibold text-ink">{op.summary}</span>
            <span className="text-[12.5px] text-ink-3">
              {op.staffName} · {formatDateTime(op.createdAt)}
            </span>
            <Button size="sm" variant="secondary" loading={busy === op.key} disabled={busy !== null && busy !== op.key} onClick={() => void resubmit(op)}>
              按原内容重新提交
            </Button>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

const ISSUE_LABELS: Record<MpReconIssueKind, string> = {
  NOT_BOOKED: '微信已收款、门店没入账',
  UNKNOWN_ORDER: '微信已收款、门店没有这张单',
  NOT_IN_BILL: '门店入了账、微信账单里没有',
  AMOUNT_MISMATCH: '金额对不上',
  TX_MISMATCH: '交易单号对不上',
  REFUND_UNKNOWN: '微信退了、门店没有这张原路退回单',
  REFUND_NOT_RECORDED: '微信已退、门店还没记已退到',
  REFUND_NOT_IN_BILL: '门店记了已退到、微信账单里没有',
  REFUND_AMOUNT_MISMATCH: '退款金额对不上',
};

/** 2b 对账：每天自动对前一天的微信支付交易账单；没对上的标红，可以按天重新核对（只追加一条结论） */
function Recons({ recons, canRun }: { recons: MpRechargeRecon[]; canRun: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const yesterday = new Date(Date.now() - 16 * 3_600_000).toISOString().slice(0, 10);
  const [date, setDate] = useState(yesterday);
  const [busy, setBusy] = useState(false);
  const bad = recons.filter((r) => !r.ok);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<MpRechargeRecon>('/api/admin/mp/recharge/recon', { date });
      await qc.invalidateQueries({ queryKey: rechargeKey });
      toast({ tone: r.ok ? 'success' : 'error', title: r.ok ? `${r.billDate} 都对上了` : `${r.billDate} 有 ${r.issues.length} 笔没对上` });
    } catch (error) {
      toast({ tone: 'error', title: '没有核对', body: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <p className={bad.length ? 'text-[15px] font-semibold text-ember' : 'text-[15px] font-semibold text-ink'}>
            对账{bad.length ? `（${bad.length} 天有没对上的）` : ''}
          </p>
          <p className="text-[13px] text-ink-3">每天上午 10 点半以后自动下前一天的微信支付交易账单，与线上充值单逐笔核对；只看、只记，不改单子。</p>
        </div>
        {canRun && (
          <div className="flex items-end gap-2">
            <Field label="账单日" htmlFor="mp-recon-date">
              <Input id="mp-recon-date" type="date" value={date} max={yesterday} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Button size="sm" variant="secondary" loading={busy} disabled={!date} onClick={() => void run()}>
              重新核对
            </Button>
          </div>
        )}
      </div>
      <div className="divide-y divide-line">
        {recons.map((r) => (
          <div key={r.id} className="px-4 py-2.5 text-[13px]" data-testid="mp-recharge-recon">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="num font-semibold text-ink">{r.billDate}</span>
              <Badge tone={r.ok ? 'pine' : 'ember'}>{r.ok ? '对上了' : `${r.issues.length} 笔没对上`}</Badge>
              <span className="text-ink-3">
                微信 {r.wxCount} 笔 <span className="num">{formatYuan(r.wxAmount)}</span> · 门店 {r.storeCount} 笔 <span className="num">{formatYuan(r.storeAmount)}</span>
              </span>
              {r.refunds.length > 0 && <span className="text-ink-3">退款 {r.refunds.length} 笔</span>}
              <span className="ml-auto text-[12px] text-ink-4">
                {r.source === 'manual' ? `${r.staffName ?? ''}重新核对` : '自动'} · {formatDateTime(r.createdAt)}
              </span>
            </div>
            {r.issues.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-[12.5px] text-ember">
                {r.issues.map((i, k) => (
                  <li key={k} className="num">
                    {ISSUE_LABELS[i.kind]} · {i.outTradeNo ?? '—'} · 交易单号 {i.transactionId ?? '—'} · 微信 {i.wxAmount === null ? '—' : formatYuan(i.wxAmount)} / 门店{' '}
                    {i.storeAmount === null ? '—' : formatYuan(i.storeAmount)} · {i.note}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {recons.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-ink-3">还没有对过账（配好微信支付以后，每天上午 10 点半以后自动对前一天的）</p>}
      </div>
    </Card>
  );
}

function RecentOrders({ orders }: { orders: MpRechargeOrderAdmin[] }) {
  return (
    <Card className="p-0">
      <div className="border-b border-line px-4 py-3">
        <p className="text-[15px] font-semibold text-ink">最近的线上充值单</p>
        <p className="text-[13px] text-ink-3">最近 50 张。入账的充值单在会员详情与日结里照常能看到（渠道「小程序」）。</p>
      </div>
      <div className="divide-y divide-line">
        {orders.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]" data-testid="mp-recharge-order">
            <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
            {o.mock && <Badge>模拟</Badge>}
            <span className="font-semibold text-ink">{o.memberName}</span>
            <span className="num">{formatYuan(o.amount)}</span>
            <span className="text-ink-3">{o.planName ?? '自定义金额'}</span>
            {o.status === 'paid' && o.bookedBonus !== null && (
              <span className="text-ink-3">
                赠 <span className="num">{formatYuan(o.bookedBonus)}</span>
                {o.bookedBonus !== o.estBonus && <>（预估 {formatYuan(o.estBonus)}）</>}
              </span>
            )}
            {o.flags.map((f) => (
              <Badge key={f} tone="ember">
                {FLAG_LABELS[f] ?? f}
              </Badge>
            ))}
            {o.closeReason && o.status === 'closed' && <span className="text-ink-3">{CLOSE_LABELS[o.closeReason] ?? o.closeReason}</span>}
            {o.resolution && (
              <span className="text-ink-3">
                店主处理：{RESOLUTIONS.find((r) => r.value === o.resolution)?.label}（{o.resolutionNote}）
              </span>
            )}
            <span className="ml-auto text-[12px] text-ink-4">
              {o.orderNo} · {formatDateTime(o.createdAt)}
            </span>
          </div>
        ))}
        {orders.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-ink-3">还没有线上充值单</p>}
      </div>
    </Card>
  );
}
