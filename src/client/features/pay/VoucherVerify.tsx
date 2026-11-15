// 平台验券（8.0.21，docs/INTEGRATIONS_V8021.md 第 3 节，CW-H）：美团、抖音验券即核销。
//   · VerifyButton / VerifyDialog：结账的团购券那一行选了美团 / 抖音、填（或扫）券码后点「验券」→ 先问平台（项目、面值、几份）
//     → 确认核销 → 这一行锁定（项目、金额 = 面值）；也可以挑一张「已验券没结账」的同平台的直接用。结果不确定的按编号查回或确认作废。
//   · UnusedVerificationsBanner：前台顶上「N 张券验过没结账」→ 撤销核销；平台不让撤的转补录（值班经理以上）。
//   · VoucherReconTab：平台核销补录页「验券对账」：每天的对账结果与差异，标已处理、重新对账。
// 平台不通、没配置时照旧手输（不验券），补录照旧。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck } from 'lucide-react';
import { COUPON_PLATFORM_LABELS } from '@shared/checkout';
import { RECON_ISSUE_LABELS, VERIFICATION_STATUS_LABELS, VOUCHER_PLATFORMS, type PayTerminalStatus, type PlatformReconIssue, type PlatformReconRun, type VerificationView, type VoucherPlatform, type VoucherPreview } from '@shared/integrations';
import { formatYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, Select, Skeleton } from '../../components/ui';

const vKeys = { status: ['voucher', 'status'] as const, open: ['voucher', 'open'] as const, recon: (f: string, t: string) => ['voucher', 'recon', f, t] as const };

export function useVoucherStatus() {
  const can = useCan();
  return useQuery({
    queryKey: vKeys.status,
    queryFn: () => api.get<PayTerminalStatus>('/api/platform/verify/status'),
    enabled: can('frontdesk.checkout') || can('platform.redeem') || can('platform.settle'),
    staleTime: 60_000,
  });
}
const useOpenVerifications = (enabled: boolean) =>
  useQuery({ queryKey: vKeys.open, queryFn: () => api.get<VerificationView[]>('/api/platform/verifications/open'), enabled, refetchInterval: 30_000 });

const isVoucherPlatform = (p: string): p is VoucherPlatform => (VOUCHER_PLATFORMS as readonly string[]).includes(p);

export function VerifyButton({ platform, code, disabled, onVerified }: { platform: string; code: string; disabled?: boolean; onVerified: (v: VerificationView) => void }) {
  const status = useVoucherStatus();
  const [open, setOpen] = useState(false);
  if (!isVoucherPlatform(platform) || !status.data || status.data.mode !== 'mock' || !status.data.enabled) return null;
  return (
    <>
      <Button size="sm" variant="secondary" icon={<BadgeCheck className="size-3.5" />} disabled={disabled} onClick={() => setOpen(true)} data-testid="voucher-verify">
        验券
      </Button>
      <VerifyDialog
        open={open}
        onClose={() => setOpen(false)}
        platform={platform}
        code={code}
        onVerified={(v) => {
          setOpen(false);
          onVerified(v);
        }}
      />
    </>
  );
}

function VerifyDialog({ open, onClose, platform, code, onVerified }: { open: boolean; onClose: () => void; platform: VoucherPlatform; code: string; onVerified: (v: VerificationView) => void }) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<VoucherPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(uuid);
  const [uncertain, setUncertain] = useState(false);
  const openList = useOpenVerifications(open);
  const reusable = (openList.data ?? []).filter((v) => v.status === 'verified' && !v.checkout && v.platform === platform);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    setUncertain(false);
    setKey(uuid());
    if (!code.trim()) return;
    setBusy(true);
    api
      .post<VoucherPreview>('/api/platform/verify/prepare', { platform, code })
      .then(setPreview)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  }, [open, platform, code]);

  const done = (v: VerificationView) => {
    void qc.invalidateQueries({ queryKey: vKeys.open });
    if (v.status === 'verified') onVerified(v);
    else setError(`${VERIFICATION_STATUS_LABELS[v.status]}：${v.failReason ?? ''}`);
  };
  const verify = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      done(await api.post<VerificationView>('/api/platform/verify', { clientKey: key, platform, code: preview.code, expectedFaceCents: preview.faceCents }, { timeoutMs: 30_000 }));
    } catch (e) {
      if (e instanceof UncertainError) setUncertain(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const lookup = async () => {
    setBusy(true);
    try {
      const v = await api.get<VerificationView>(`/api/platform/verifications/by-key/${key}`);
      setUncertain(false);
      done(v);
    } catch (e) {
      setError(`${errorMessage(e)}。不能断定没核销：可以再查一次，或确认作废这一次（作废以后它就算晚到也不会核销）`);
    } finally {
      setBusy(false);
    }
  };
  const abandon = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ abandoned: boolean; verification: VerificationView | null }>(`/api/platform/verifications/by-key/${key}/abandon`, {});
      setUncertain(false);
      if (r.verification) done(r.verification);
      else {
        setKey(uuid());
        setError('已确认作废：这一次没有核销，可以重新验券');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`${COUPON_PLATFORM_LABELS[platform]}验券`}
      description="先问平台这张券是什么、多少钱；确认以后在平台上核销，这一行自动填好。核销了没结账的可以撤销。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          {!uncertain && (
            <Button variant="primary" loading={busy} disabled={!preview} onClick={() => void verify()} data-testid="voucher-verify-confirm">
              确认核销
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-[13.5px]">
        {!code.trim() && <Notice tone="info" title="先在团购券那一行填（或扫）券码" />}
        {busy && !preview && !error && <Skeleton className="h-16" />}
        {preview && (
          <dl className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-paper-2/60 p-3" data-testid="voucher-preview">
            <dt className="text-ink-3">券码</dt>
            <dd className="num font-semibold">{preview.code}</dd>
            <dt className="text-ink-3">项目</dt>
            <dd className="font-semibold">{preview.dealName}</dd>
            <dt className="text-ink-3">面值（抵扣）</dt>
            <dd className="num font-semibold">
              {formatYuan(preview.faceCents)}
              {preview.quantity > 1 ? `（${preview.quantity} 份）` : ''}
            </dd>
            <dt className="text-ink-3">平台应结</dt>
            <dd className="num">{formatYuan(preview.settleCents)}</dd>
          </dl>
        )}
        {uncertain && (
          <Notice tone="warning" title="核销没收到结果">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void lookup()}>
                查一下
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void abandon()}>
                确认作废这一次
              </Button>
            </div>
          </Notice>
        )}
        {error && <Notice tone="error" title={error} />}
        {reusable.length > 0 && (
          <div className="rounded-lg border border-line p-2" data-testid="voucher-reusable">
            <p className="mb-1 font-semibold text-ink-2">验过还没结账的，可以直接用：</p>
            {reusable.map((v) => (
              <div key={v.id} className="flex items-center gap-2 text-[13px]">
                <span className="num">{v.code}</span>
                <span>
                  {v.dealName} · {formatYuan(v.faceCents)}
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="secondary" onClick={() => onVerified(v)}>
                  用这一张
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** 前台顶上：验过券没结账的 */
export function UnusedVerificationsBanner() {
  const can = useCan();
  const status = useVoucherStatus();
  const on = !!status.data && status.data.mode !== 'off';
  const list = useOpenVerifications(on);
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState<VerificationView | null>(null);
  const rows = list.data ?? [];
  if (!on || !rows.length) return null;
  const refresh = () => qc.invalidateQueries({ queryKey: vKeys.open });
  const record = async (v: VerificationView) => {
    try {
      const r = await api.post<VerificationView>(`/api/platform/verifications/${v.id}/record`, {});
      toast({ tone: 'success', title: `已转补录 ${r.redemptionNo ?? ''}` });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      await refresh();
    }
  };
  return (
    <>
      <Notice
        tone="warning"
        title={`${rows.length} 张团购券验过还没结账`}
        action={
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="unused-vouchers-open">
            去处理
          </Button>
        }
        data-testid="unused-vouchers-banner"
      >
        结账时在团购券那一行点「验券」可以直接挂上；客人不用了的撤销核销。
      </Notice>
      <Dialog open={open && !cancelling} onClose={() => setOpen(false)} title="验过券没结账" width="max-w-2xl">
        <ul className="divide-y divide-line/70 rounded-lg border border-line text-[13px]" data-testid="unused-vouchers-list">
          {rows.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <Badge tone={v.status === 'verified' ? 'pine' : 'yuzu'}>{VERIFICATION_STATUS_LABELS[v.status]}</Badge>
              <span className="font-semibold">
                {COUPON_PLATFORM_LABELS[v.platform]} {v.code}
              </span>
              <span>
                {v.dealName} · {formatYuan(v.faceCents)}
              </span>
              <span className="text-ink-3">
                {v.staffName} · {formatDateTime(v.verifiedAt ?? v.createdAt)}
              </span>
              <span className="flex-1" />
              {can('platform.void') && v.status === 'verified' && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(v)} data-testid={`voucher-cancel-${v.id}`}>
                    撤销核销
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void record(v)}>
                    转补录
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </Dialog>
      <ReasonDialog
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        title={cancelling ? `撤销核销 ${cancelling.code}` : ''}
        description="去平台撤销这次核销；过了平台允许的时间撤不了的，点「转补录」记一条平台核销补录。"
        confirmLabel="撤销核销"
        testId="voucher-cancel"
        onConfirm={(reason) => {
          const v = cancelling!;
          void api
            .post(`/api/platform/verifications/${v.id}/cancel`, { reason })
            .then(() => toast({ tone: 'success', title: '已撤销核销' }))
            .catch((e) => toast({ tone: 'error', title: errorMessage(e) }))
            .finally(() => {
              setCancelling(null);
              void refresh();
            });
        }}
      />
    </>
  );
}

/** 平台核销补录页「验券对账」 */
export function VoucherReconTab({ from, to }: { from: string; to: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useVoucherStatus();
  const data = useQuery({ queryKey: vKeys.recon(from, to), queryFn: () => api.get<{ runs: PlatformReconRun[]; issues: PlatformReconIssue[] }>(`/api/platform/recon?from=${from}&to=${to}`) });
  const [resolving, setResolving] = useState<PlatformReconIssue | null>(null);
  const [runPlatform, setRunPlatform] = useState<VoucherPlatform>('meituan');
  const [runDate, setRunDate] = useState(to);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['voucher', 'recon'] });
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<PlatformReconRun>('/api/platform/recon/run', { platform: runPlatform, date: runDate });
      toast({ tone: r.ok ? 'success' : 'error', title: r.ok ? `对完了：${r.issues} 处差异` : `对账失败：${r.error ?? ''}` });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  if (status.data?.mode === 'off') return <Notice tone="info" title="没有配置平台验券：自动对账不可用。手输的团购券照旧按打款对账。" />;
  const open = (data.data?.issues ?? []).filter((i) => !i.resolvedAt);
  return (
    <div className="space-y-3" data-testid="voucher-recon">
      <Card className="flex flex-wrap items-center gap-2 p-3 text-[13px]">
        <span className="text-ink-3">每天设定的时间自动对前一个营业日；也可以手动对</span>
        <span className="flex-1" />
        <Select fullWidth={false} value={runPlatform} onChange={(e) => setRunPlatform(e.target.value as VoucherPlatform)} className="h-9 w-28" aria-label="平台">
          {VOUCHER_PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {COUPON_PLATFORM_LABELS[p]}
            </option>
          ))}
        </Select>
        <Input type="date" fullWidth={false} value={runDate} onChange={(e) => setRunDate(e.target.value)} className="h-9 w-40" aria-label="对哪一天" />
        <Button size="sm" variant="secondary" loading={busy} disabled={!runDate} onClick={() => void run()} data-testid="voucher-recon-run">
          对这一天的账
        </Button>
      </Card>
      {!data.data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <ul className="space-y-1 text-[12.5px] text-ink-3">
            {data.data.runs.slice(0, 10).map((r) => (
              <li key={r.id}>
                {r.businessDate} · {COUPON_PLATFORM_LABELS[r.platform]} · {r.ok ? `平台 ${r.platformLines} 张、系统 ${r.systemLines} 张、差异 ${r.issues} 处` : `失败：${r.error}`} · {r.staffName ?? '自动'} {formatDateTime(r.createdAt)}
              </li>
            ))}
          </ul>
          {open.length === 0 ? (
            <Notice tone="success" title="没有没处理的差异" />
          ) : (
            <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card text-[13px]" data-testid="voucher-recon-issues">
              {open.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <Badge tone="clay">{RECON_ISSUE_LABELS[i.kind]}</Badge>
                  <span>
                    {i.businessDate} · {COUPON_PLATFORM_LABELS[i.platform]} · <span className="num">{i.code}</span> {i.dealName}
                  </span>
                  <span className="text-ink-3">
                    平台 {i.platformCents === null ? '—' : formatYuan(i.platformCents)} / 系统 {i.systemCents === null ? '—' : formatYuan(i.systemCents)}
                    {i.systemRef ? `（${i.systemRef}）` : ''}
                  </span>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setResolving(i)}>
                    标已处理
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <ReasonDialog
        open={!!resolving}
        onClose={() => setResolving(null)}
        title="标已处理"
        description="写明怎么处理的（例如平台那边退款了、补登记了）。"
        label="处理说明"
        confirmLabel="标已处理"
        onConfirm={(note) => {
          const i = resolving!;
          void api
            .post(`/api/platform/recon/issues/${i.id}/resolve`, { note })
            .catch((e) => toast({ tone: 'error', title: errorMessage(e) }))
            .finally(() => {
              setResolving(null);
              void refresh();
            });
        }}
      />
    </div>
  );
}
