// 扫码收款（8.0.21，docs/INTEGRATIONS_V8021.md 第 2 节，CW-G）：B 扫 C。
//   · ScanPayButton / ScanPayDialog：结账、充值的「微信 / 支付宝」那一笔点「扫码收款」→ 扫客人的付款码（扫码枪像键盘一样输入、回车）
//     → 到账以后这一笔锁定（金额、方式、参考号 = 支付方单号），照常点结账 / 充值；要输密码的每 3 秒查一次，最多 60 秒；
//     结果不确定（断网、超时）的按操作编号查回，查不到可以确认作废（之后原请求即使到达也不生效）。
//     也可以挑一笔「收了钱没入账」的（同方式、同金额）用在这一次。
//   · UnsettledPayBanner：前台顶上「有 N 笔扫码收款还没入账」，可以原路退回；原路退款失败的重试或改「线下已退」。
// 编号先存在本机再发（存不了就不发），刷新以后还能查回。不存付款码。

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QrCode, ScanLine } from 'lucide-react';
import { AUTH_CODE_PATTERN, PAY_REFUND_STATUS_LABELS, PAY_TX_STATUS_LABELS, type PayProvider, type PayPurpose, type PayTerminalStatus, type PayTxView } from '@shared/integrations';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Input, Notice, Spinner } from '../../components/ui';

export const payKeys = { status: ['pay', 'status'] as const, open: ['pay', 'open'] as const };

export function usePayTerminalStatus(enabled = true) {
  const can = useCan();
  return useQuery({
    queryKey: payKeys.status,
    queryFn: () => api.get<PayTerminalStatus>('/api/pay/terminal/status'),
    enabled: enabled && (can('frontdesk.checkout') || can('recharge.create')),
    staleTime: 60_000,
  });
}

export const useOpenPayTxs = (enabled = true) => useQuery({ queryKey: payKeys.open, queryFn: () => api.get<PayTxView[]>('/api/pay/terminal/open'), enabled, refetchInterval: 30_000 });

const PENDING_KEY = 'yuzu.payTerminal.pending';
interface PendingScan {
  key: string;
  provider: PayProvider;
  purpose: PayPurpose;
  amountCents: number;
  at: string;
}
function savePending(p: PendingScan | null): boolean {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
    return p ? localStorage.getItem(PENDING_KEY) === JSON.stringify(p) : true;
  } catch {
    return false;
  }
}
function loadPending(): PendingScan | null {
  try {
    const v = localStorage.getItem(PENDING_KEY);
    return v ? (JSON.parse(v) as PendingScan) : null;
  } catch {
    return null;
  }
}

/** 结账、充值那一笔旁边的按钮：配置了扫码收款、门店开着才显示 */
export function ScanPayButton({
  provider,
  amountCents,
  purpose,
  disabled,
  onPaid,
}: {
  provider: PayProvider;
  amountCents: number | null;
  purpose: PayPurpose;
  disabled?: boolean;
  onPaid: (tx: PayTxView) => void;
}) {
  const status = usePayTerminalStatus();
  const [open, setOpen] = useState(false);
  if (!status.data || status.data.mode === 'off' || status.data.mode === 'live' || !status.data.enabled) return null;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon={<ScanLine className="size-3.5" />}
        disabled={disabled || !amountCents || amountCents <= 0}
        onClick={() => setOpen(true)}
        data-testid={`scan-pay-${provider}`}
      >
        扫码收款
      </Button>
      <ScanPayDialog
        open={open}
        onClose={() => setOpen(false)}
        provider={provider}
        amountCents={amountCents ?? 0}
        purpose={purpose}
        onPaid={(tx) => {
          setOpen(false);
          onPaid(tx);
        }}
      />
    </>
  );
}

export function ScanPayDialog({
  open,
  onClose,
  provider,
  amountCents,
  purpose,
  onPaid,
}: {
  open: boolean;
  onClose: () => void;
  provider: PayProvider;
  amountCents: number;
  purpose: PayPurpose;
  onPaid: (tx: PayTxView) => void;
}) {
  const qc = useQueryClient();
  const [authCode, setAuthCode] = useState('');
  const [tx, setTx] = useState<PayTxView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<PendingScan | null>(null);
  const [pollUntil, setPollUntil] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const openTxs = useOpenPayTxs(open);
  const reusable = (openTxs.data ?? []).filter((t) => t.status === 'paid' && !t.consumed && t.refundCents === 0 && t.provider === provider && t.amountCents === amountCents);

  useEffect(() => {
    if (!open) return;
    setAuthCode('');
    setTx(null);
    setError(null);
    setUncertain(loadPending());
    setTimeout(() => input.current?.focus(), 50);
  }, [open]);

  // 支付中：每 3 秒查一次，最多 60 秒
  useEffect(() => {
    if (!tx || tx.status !== 'paying' || Date.now() > pollUntil) return;
    const t = setTimeout(async () => {
      try {
        const next = await api.get<PayTxView>(`/api/pay/terminal/${tx.id}`);
        setTx(next);
        if (next.status === 'paid') finish(next);
      } catch {
        setTx({ ...tx });
      }
    }, 3_000);
    return () => clearTimeout(t);
  }, [tx, pollUntil]);

  const finish = (t: PayTxView) => {
    savePending(null);
    void qc.invalidateQueries({ queryKey: payKeys.open });
    if (t.status === 'paid') onPaid(t);
  };

  const submit = async () => {
    if (!AUTH_CODE_PATTERN.test(authCode.trim())) return setError('付款码不对（16–24 位数字），请重新扫');
    const pending: PendingScan = { key: uuid(), provider, purpose, amountCents, at: new Date().toISOString() };
    if (!savePending(pending)) return setError('本机存不了操作编号（浏览器存储被关了），这笔不能扫码收款；请手选微信 / 支付宝并核实到账');
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<PayTxView>('/api/pay/terminal', { clientKey: pending.key, provider, purpose, amountCents, authCode: authCode.trim() }, { timeoutMs: 30_000 });
      setTx(r);
      setAuthCode('');
      if (r.status === 'paying') setPollUntil(Date.now() + 60_000);
      else {
        if (r.status !== 'paid') savePending(null);
        finish(r);
      }
    } catch (e) {
      if (e instanceof UncertainError) setUncertain(pending);
      else {
        savePending(null);
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  /** 结果待确认：按编号查回；查不到可以确认作废 */
  const lookup = async () => {
    if (!uncertain) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<PayTxView>(`/api/pay/terminal/by-key/${uncertain.key}`);
      setUncertain(null);
      setTx(r);
      if (r.status === 'paying') setPollUntil(Date.now() + 60_000);
      else finish(r);
    } catch (e) {
      setError(`${errorMessage(e)}。不能断定没扣客人的钱：可以再查一次，或确认作废这一笔（作废以后它就算晚到也不会生效）`);
    } finally {
      setBusy(false);
    }
  };
  const abandon = async () => {
    if (!uncertain) return;
    setBusy(true);
    try {
      const r = await api.post<{ abandoned: boolean; tx: PayTxView | null }>(`/api/pay/terminal/by-key/${uncertain.key}/abandon`, {});
      setUncertain(null);
      savePending(null);
      if (r.tx) {
        setTx(r.tx);
        finish(r.tx);
      } else setError('已确认作废：这一笔没有收款，可以重新扫码');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const label = PAYMENT_METHOD_LABELS[provider];
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`${label}扫码收款 · ${formatYuan(amountCents)}`}
      description={`请客人打开${label}的付款码，用扫码枪扫一下（或手动输入码下面的数字后回车）。到账以后这一笔自动填好，照常${purpose === 'checkout' ? '结账' : '充值'}。`}
      footer={
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          关闭
        </Button>
      }
    >
      <div className="space-y-3">
        {uncertain ? (
          <Notice tone="warning" title={`上一次扫码（${formatYuan(uncertain.amountCents)}）没收到结果`}>
            <p className="mb-2">先查一下：查到了就按查到的为准；查不到的不能断定没扣钱。</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void lookup()} data-testid="scan-pay-lookup">
                查一下
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void abandon()} data-testid="scan-pay-abandon">
                确认作废这一笔
              </Button>
            </div>
          </Notice>
        ) : tx ? (
          <TxState tx={tx} polling={tx.status === 'paying' && Date.now() <= pollUntil} />
        ) : null}
        {(!tx || tx.status === 'failed' || tx.status === 'closed') && !uncertain && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Input
              ref={input}
              value={authCode}
              inputMode="numeric"
              autoComplete="off"
              placeholder="扫付款码"
              onChange={(e) => setAuthCode(e.target.value.replace(/\D/g, ''))}
              className="num h-11 text-[16px] tracking-wider"
              aria-label="付款码"
              data-testid="scan-pay-code"
            />
            <Button type="submit" variant="primary" icon={<QrCode className="size-4" />} loading={busy} disabled={!authCode} data-testid="scan-pay-submit">
              收款
            </Button>
          </form>
        )}
        {error && <Notice tone="error" title={error} />}
        {openTxs.isError && !openTxs.data && !tx && (
          <LoadFailed
            title="收了钱没入账的扫码收款查不到（有的话直接用，不用再扫一次），请检查网络"
            onRetry={() => void openTxs.refetch()}
            retrying={openTxs.isFetching}
            testId="scan-pay-reusable-error"
          />
        )}
        {reusable.length > 0 && !tx && (
          <div className="rounded-lg border border-line p-2 text-[13px]" data-testid="scan-pay-reusable">
            <p className="mb-1 font-semibold text-ink-2">收了钱还没入账的（同方式、同金额），可以直接用：</p>
            {reusable.map((t) => (
              <div key={t.id} className="flex items-center gap-2">
                <span className="num">{t.providerTradeNo}</span>
                <span className="text-ink-3">
                  {t.staffName} · {formatDateTime(t.paidAt ?? t.createdAt)}
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="secondary" onClick={() => onPaid(t)}>
                  用这一笔
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function TxState({ tx, polling }: { tx: PayTxView; polling: boolean }) {
  if (tx.status === 'paid')
    return (
      <Notice tone="success" title={`已到账 ${formatYuan(tx.amountCents)}`}>
        支付方单号 {tx.providerTradeNo}
      </Notice>
    );
  if (tx.status === 'paying')
    return (
      <Notice tone="info" title="等客人在手机上输密码……" icon={polling ? <Spinner /> : undefined} data-testid="scan-pay-paying">
        {polling ? '每 3 秒查一次。' : '一分钟还没结果：先别重扫，系统会继续去支付方查，5 分钟没结果自动撤单；可以先关掉，之后在前台顶上的提示里看结果。'}
      </Notice>
    );
  return (
    <Notice tone="error" title={`${PAY_TX_STATUS_LABELS[tx.status]}：${tx.failReason ?? ''}`}>
      可以请客人换一个付款码重扫。
    </Notice>
  );
}

/** 前台顶上：收了钱没入账、还在支付中、原路退款失败的 */
export function UnsettledPayBanner() {
  const can = useCan();
  const status = usePayTerminalStatus();
  const on = !!status.data && status.data.mode !== 'off';
  const list = useOpenPayTxs(on);
  const [open, setOpen] = useState(false);
  const rows = list.data ?? [];
  // 取不回来（也没有上一次的）：写明查不到、可以重试，不当成「没有没入账的」把整条提示藏起来（Codex 审查 0edd8df 后补）
  if (status.isError && !status.data) return <LoadFailed title="扫码收款的状态取不回来，请检查网络" onRetry={() => void status.refetch()} retrying={status.isFetching} testId="unsettled-pay-error" />;
  if (on && list.isError && !list.data)
    return (
      <LoadFailed title="收了钱没入账的扫码收款查不到，请检查网络" onRetry={() => void list.refetch()} retrying={list.isFetching} testId="unsettled-pay-error">
        交班前要处理完没入账的；重试取回来以后再看。
      </LoadFailed>
    );
  if (!on || !rows.length) return null;
  const unconsumed = rows.filter((t) => t.status === 'paid' && !t.consumed && t.refundCents === 0).length;
  const paying = rows.filter((t) => t.status === 'paying').length;
  const failedRefunds = rows.flatMap((t) => t.refunds.filter((r) => r.status === 'failed' || r.status === 'pending')).length;
  return (
    <>
      <Notice
        tone="warning"
        title={[unconsumed ? `${unconsumed} 笔扫码收款收了钱没入账` : '', paying ? `${paying} 笔还在支付中` : '', failedRefunds ? `${failedRefunds} 笔原路退款没完成` : ''].filter(Boolean).join('，')}
        action={
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="unsettled-pay-open">
            去处理
          </Button>
        }
        data-testid="unsettled-pay-banner"
      >
        没入账的可以在结账、充值的「扫码收款」里挑来用，或原路退回；交班前要处理完。
      </Notice>
      <UnsettledPayDialog open={open} onClose={() => setOpen(false)} rows={rows} canRefund={can('frontdesk.refund')} />
    </>
  );
}

function UnsettledPayDialog({ open, onClose, rows, canRefund }: { open: boolean; onClose: () => void; rows: PayTxView[]; canRefund: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [refunding, setRefunding] = useState<PayTxView | null>(null);
  const [offline, setOffline] = useState<number | null>(null);
  const [key, setKey] = useState(uuid);
  const refresh = () => qc.invalidateQueries({ queryKey: payKeys.open });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ tone: 'success', title: ok });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      await refresh();
    }
  };
  return (
    <>
      <Dialog open={open && !refunding && offline === null} onClose={onClose} title="扫码收款待处理" width="max-w-2xl">
        <ul className="divide-y divide-line/70 rounded-lg border border-line text-[13px]" data-testid="unsettled-pay-list">
          {rows.map((t) => (
            <li key={t.id} className="space-y-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={t.status === 'paid' ? 'pine' : t.status === 'paying' ? 'yuzu' : 'neutral'}>{PAY_TX_STATUS_LABELS[t.status]}</Badge>
                <span className="font-semibold">
                  {PAYMENT_METHOD_LABELS[t.provider]} {formatYuan(t.amountCents)}
                </span>
                <span className="num text-ink-3">{t.providerTradeNo ?? t.outTradeNo}</span>
                <span className="text-ink-3">
                  {t.staffName} · {formatDateTime(t.createdAt)}
                </span>
                <span className="flex-1" />
                {t.status === 'paying' && (
                  <Button size="sm" variant="ghost" onClick={() => void act(() => api.get(`/api/pay/terminal/${t.id}`), '已去支付方查过')}>
                    查结果
                  </Button>
                )}
                {canRefund && t.status === 'paid' && !t.consumed && t.refundCents === 0 && (
                  <Button size="sm" variant="secondary" onClick={() => setRefunding(t)} data-testid={`pay-refund-${t.id}`}>
                    原路退回
                  </Button>
                )}
              </div>
              {t.refunds
                .filter((r) => r.status === 'failed' || r.status === 'pending')
                .map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 pl-2 text-[12.5px]">
                    <Badge tone="clay">{PAY_REFUND_STATUS_LABELS[r.status]}</Badge>
                    <span>
                      退 {formatYuan(r.amountCents)}
                      {r.refundNo ? `（退款单 ${r.refundNo}）` : ''}：{r.failReason ?? r.reason}
                    </span>
                    {/* 退款中的（记下以后没去成支付方，系统每分钟也会自己再退一次）也能手动再退：同一个退款编号，支付方只退一次 */}
                    {canRefund && (r.status === 'failed' || r.status === 'pending') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void act(() => api.post(`/api/pay/refunds/${r.id}/resolve`, { action: 'retry' }), '已重新去支付方退')}
                        data-testid={`pay-refund-retry-${r.id}`}
                      >
                        {r.status === 'pending' ? '再去退一次' : '重试'}
                      </Button>
                    )}
                    {canRefund && r.status === 'failed' && (
                      <Button size="sm" variant="ghost" onClick={() => setOffline(r.id)}>
                        线下已退
                      </Button>
                    )}
                  </div>
                ))}
            </li>
          ))}
        </ul>
      </Dialog>
      <ReasonDialog
        open={!!refunding}
        onClose={() => setRefunding(null)}
        title={refunding ? `原路退回 ${formatYuan(refunding.amountCents)}` : ''}
        description="钱退回客人的微信 / 支付宝；退了以后这一笔不能再入账。"
        confirmLabel="原路退回"
        testId="pay-refund"
        onConfirm={(reason) => {
          const t = refunding!;
          void act(() => api.post(`/api/pay/terminal/${t.id}/refund`, { clientKey: key, reason }), '已提交原路退回').then(() => {
            setKey(uuid());
            setRefunding(null);
          });
        }}
      />
      <ReasonDialog
        open={offline !== null}
        onClose={() => setOffline(null)}
        title="改成线下已退"
        description="写明怎么退给客人的（例如商户后台手工退、退了现金）。"
        confirmLabel="确认"
        label="怎么退的"
        onConfirm={(note) => {
          void act(() => api.post(`/api/pay/refunds/${offline}/resolve`, { action: 'offline', note }), '已记为线下已退').then(() => setOffline(null));
        }}
      />
    </>
  );
}
