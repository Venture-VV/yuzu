// 签赠台账（8.1.9，docs/GIFTS_V819.md 第 2.4 节）：管家部、客户部的「签赠台账」与后台「签赠 → 台账」同一份。
//   · 筛选：发放日期、渠道、券种、授权人、状态；
//   · 数：发出、已使用、未使用、已作废、已过期、抵扣合计；
//   · 按授权人（发了、用了、没用、作废、过期）、按个人（会员名下用了几张、抵了多少）、占比（人员、板块、券种、渠道）；
//   · 明细：每一张签赠券，含核销的结账单与作废原因（宽屏表格，窄屏卡片）。
// 手机号按「查找与查看会员」打码（服务端做）。

import { useRef, useState } from 'react';
import { Ban, Download, Signature } from 'lucide-react';
import { formatStoreCouponCode } from '@shared/coupons';
import { GIFT_STATUS_LABELS, type GiftLedger as Ledger, type GiftLedgerRow, type GiftShare, type GiftStatus } from '@shared/gifts';
import { shiftDate } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useErpRecorded } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Select, Skeleton } from '../../components/ui';
import { GiftIssueDialog } from './GiftIssueDialog';
import { useGiftLedger, useGiftRules, useGiftTypes, useInvalidateGifts } from './queries';

type Tone = Parameters<typeof Badge>[0]['tone'];
const STATUS_TONE: Record<GiftStatus, Tone> = { available: 'yuzu', used: 'pine', voided: 'neutral', expired: 'ember' };
const qs = (params: Record<string, string>) => new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();

export function GiftLedger({ channel, testId = 'gift-ledger' }: { channel?: string; testId?: string }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateGifts();
  const today = session.today;
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [filters, setFilters] = useState({ channel: '', templateId: '', authorizerId: '', status: '' });
  const query = qs({ from, to, ...filters });
  const ledger = useGiftLedger(query, from <= to);
  const rules = useGiftRules();
  const types = useGiftTypes();
  const [issuing, setIssuing] = useState(false);
  const [voiding, setVoiding] = useState<GiftLedgerRow | null>(null);
  const [busy, setBusy] = useState(false);
  const l = ledger.data;
  // 筛选里的授权人：看到过的都留着（筛了一位以后统计里只剩这一位）
  const seen = useRef(new Map<number, string>());
  for (const a of l?.byAuthorizer ?? []) seen.current.set(a.authorizer.id, a.authorizer.name);
  const authorizerOptions = [...seen.current.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh'));
  const canIssue = can('gift.issue');
  // 上一次签赠发放还在路上、或结果待确认：先在上面查回、重提或作废，处理完才能再发——
  // 发放弹窗每次打开用新的操作编号，不挡的话关掉弹窗再发一次，会员会多拿一批券（Codex 审查 785ca18）
  const unresolved = useErpRecorded(['gift_issue']).length > 0;
  const canVoid = can('gift.manage') || can('coupon.void');
  const canExport = can('gift.manage') || can('concierge.export') || can('customer.manage');
  const setFilter = (k: keyof typeof filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const range = (days: number | 'month') => {
    setTo(today);
    setFrom(days === 'month' ? `${today.slice(0, 8)}01` : shiftDate(today, -(days - 1)));
  };

  const doVoid = async (reason: string) => {
    if (!voiding) return;
    setBusy(true);
    try {
      await api.post(`/api/gifts/coupons/${voiding.couponId}/void`, { reason });
      toast({ tone: 'success', title: `已作废 ${formatStoreCouponCode(voiding.code)}`, body: voiding.type.name });
      setVoiding(null);
      await invalidate();
    } catch (e) {
      toast({ tone: 'error', title: '没有作废', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0 space-y-4" data-testid={testId}>
      {canIssue && <ErpPendingPanel types={['gift_issue']} onFound={() => void invalidate()} />}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-ink-3">
            发放日期
            {/* 手机上两个日期各占一行 */}
            <span className="flex flex-wrap items-center gap-1">
              <Input type="date" fullWidth={false} className="h-9 w-[8.75rem]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="从" data-testid="gift-from" />
              <span className="text-ink-3">至</span>
              <Input type="date" fullWidth={false} className="h-9 w-[8.75rem]" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} aria-label="到" data-testid="gift-to" />
            </span>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => range(1)}>
              今天
            </Button>
            <Button size="sm" variant="ghost" onClick={() => range(7)}>
              近 7 天
            </Button>
            <Button size="sm" variant="ghost" onClick={() => range('month')}>
              本月
            </Button>
          </div>
          <span className="flex-1" />
          {canExport && (
            <a href={`/api/gifts/ledger/export?${query}`} download>
              <Button size="sm" variant="secondary" icon={<Download className="size-4" />} data-testid="gift-export">
                导出
              </Button>
            </a>
          )}
          {canIssue && (
            <Button
              size="sm"
              variant="primary"
              icon={<Signature className="size-4" />}
              disabled={rules.data?.enabled === false || unresolved}
              title={unresolved ? '上一次签赠发放的结果待确认：先在上面查回、按原内容重提或确认作废' : undefined}
              onClick={() => setIssuing(true)}
              data-testid="gift-issue"
            >
              签赠发放
            </Button>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select aria-label="渠道" value={filters.channel} onChange={(e) => setFilter('channel', e.target.value)} data-testid="gift-filter-channel">
            <option value="">全部渠道</option>
            {(rules.data?.channels ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Select aria-label="券种" value={filters.templateId} onChange={(e) => setFilter('templateId', e.target.value)} data-testid="gift-filter-type">
            <option value="">全部券种</option>
            {(types.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <Select aria-label="授权人" value={filters.authorizerId} onChange={(e) => setFilter('authorizerId', e.target.value)} data-testid="gift-filter-authorizer">
            <option value="">全部授权人</option>
            {authorizerOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
          <Select aria-label="状态" value={filters.status} onChange={(e) => setFilter('status', e.target.value)} data-testid="gift-filter-status">
            <option value="">全部状态</option>
            {(Object.keys(GIFT_STATUS_LABELS) as GiftStatus[]).map((s) => (
              <option key={s} value={s}>
                {GIFT_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        {rules.data?.enabled === false && <p className="mt-2 text-[12.5px] text-ember">签赠已在后台「签赠 → 配置」里关掉：不能再发，已发的照常能用。</p>}
      </Card>

      {from > to ? (
        <p className="text-[13px] text-clay">开始日期不能晚于结束日期</p>
      ) : ledger.isPending ? (
        <Skeleton className="h-64" />
      ) : ledger.isError && !l ? (
        <LoadFailed title="签赠台账没取回来" onRetry={() => void ledger.refetch()} retrying={ledger.isFetching} testId="gift-ledger-failed">
          {errorMessage(ledger.error)}
        </LoadFailed>
      ) : l ? (
        <>
          <Totals l={l} />
          {l.totals.issued === 0 ? (
            <EmptyState art="leaf" title="这段时间没有签赠" description={canIssue ? '点右上角「签赠发放」：找会员、选券种与授权人、写事由。' : undefined} className="py-8" />
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-2">
                <ByAuthorizer l={l} />
                <Shares l={l} />
              </div>
              <ByPerson l={l} />
              <Detail l={l} canVoid={canVoid} onVoid={setVoiding} />
            </>
          )}
        </>
      ) : null}

      {issuing && <GiftIssueDialog defaultChannel={channel} onClose={() => setIssuing(false)} onDone={() => invalidate()} />}
      <ReasonDialog
        open={!!voiding}
        title={voiding ? `作废签赠券 ${formatStoreCouponCode(voiding.code)}` : ''}
        description={voiding ? `「${voiding.type.name}」，会员 ${voiding.member?.name ?? ''}，授权人 ${voiding.authorizer.name}。作废后结账时不能再用，不能恢复。` : undefined}
        confirmLabel="作废"
        danger
        busy={busy}
        testId="gift-void"
        onClose={() => setVoiding(null)}
        onConfirm={(reason) => void doVoid(reason)}
      />
    </div>
  );
}

function Totals({ l }: { l: Ledger }) {
  const t = l.totals;
  const items: { label: string; value: string; testId: string; tone?: string }[] = [
    { label: '发出', value: `${t.issued} 张`, testId: 'gift-total-issued' },
    { label: '已使用', value: `${t.used} 张`, testId: 'gift-total-used', tone: 'text-pine' },
    { label: '未使用', value: `${t.available} 张`, testId: 'gift-total-available', tone: 'text-yuzu-deep' },
    { label: '已作废', value: `${t.voided} 张`, testId: 'gift-total-voided', tone: 'text-ink-3' },
    { label: '已过期', value: `${t.expired} 张`, testId: 'gift-total-expired', tone: 'text-ember' },
    { label: '抵扣合计', value: formatYuan(t.usedCents), testId: 'gift-total-cents' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="gift-totals">
      {items.map((i) => (
        <div key={i.label} className="min-w-0 rounded-lg bg-card px-3 py-2.5 shadow-[0_1px_2px_rgb(28_35_31/0.06)]" data-testid={i.testId}>
          <p className="text-[12px] font-semibold text-ink-3">{i.label}</p>
          <p className={cn('num truncate text-[19px] font-bold', i.tone ?? 'text-ink')}>{i.value}</p>
        </div>
      ))}
    </div>
  );
}

function ByAuthorizer({ l }: { l: Ledger }) {
  return (
    <Card className="min-w-0 p-4" data-testid="gift-by-authorizer">
      <p className="mb-2 text-[14.5px] font-bold">按授权人</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-ink-3">
              <th className="py-1.5 font-semibold">授权人</th>
              <th className="text-right font-semibold">发出</th>
              <th className="text-right font-semibold">已使用</th>
              <th className="text-right font-semibold">未使用</th>
              <th className="text-right font-semibold">已作废</th>
              <th className="text-right font-semibold">已过期</th>
            </tr>
          </thead>
          <tbody>
            {l.byAuthorizer.map((a) => (
              <tr key={a.authorizer.id} className="border-t border-line/70" data-testid={`gift-authorizer-${a.authorizer.id}`}>
                <td className="py-1.5 font-semibold">{a.authorizer.name}</td>
                <td className="num text-right">{a.issued}</td>
                <td className="num text-right text-pine">{a.used}</td>
                <td className="num text-right">{a.available}</td>
                <td className="num text-right text-ink-3">{a.voided}</td>
                <td className="num text-right text-ember">{a.expired}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ShareList({ title, list, unit, testId }: { title: string; list: GiftShare[]; unit: string; testId: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="mb-1 text-[12.5px] font-semibold text-ink-3">{title}</p>
      {list.length === 0 ? (
        <p className="text-[12.5px] text-ink-4">还没有</p>
      ) : (
        <ul className="space-y-1">
          {list.map((s) => (
            <li key={s.label} className="text-[12.5px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate">{s.label}</span>
                <span className="num shrink-0 text-ink-3">
                  {s.count} {unit} · {s.pct}%
                </span>
              </div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-paper-2">
                <div className="h-full rounded-full bg-pine/70" style={{ width: `${s.pct}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Shares({ l }: { l: Ledger }) {
  return (
    <Card className="min-w-0 p-4" data-testid="gift-shares">
      <p className="mb-2 text-[14.5px] font-bold">占比</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <ShareList title="已使用 · 按人员（授权人）" list={l.shares.authorizer} unit="张" testId="gift-share-authorizer" />
        <ShareList title="已使用 · 按板块" list={l.shares.segment} unit="张" testId="gift-share-segment" />
        <ShareList title="已使用 · 按券种" list={l.shares.type} unit="张" testId="gift-share-type" />
        <ShareList title="发出 · 按渠道" list={l.shares.channel} unit="张" testId="gift-share-channel" />
      </div>
    </Card>
  );
}

function ByPerson({ l }: { l: Ledger }) {
  return (
    <Card className="min-w-0 p-4" data-testid="gift-by-person">
      <p className="mb-2 text-[14.5px] font-bold">
        按个人<span className="ml-2 text-[12px] font-normal text-ink-3">会员名下累计（用了的从多到少，前 50 位）</span>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[400px] text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-ink-3">
              <th className="py-1.5 font-semibold">会员</th>
              <th className="text-right font-semibold">发了</th>
              <th className="text-right font-semibold">用了</th>
              <th className="text-right font-semibold">抵扣</th>
            </tr>
          </thead>
          <tbody>
            {l.byPerson.map((p) => (
              <tr key={p.member.id} className="border-t border-line/70" data-testid={`gift-person-${p.member.id}`}>
                <td className="py-1.5">
                  <span className="font-semibold">{p.member.name}</span>
                  <span className="num ml-2 text-[12px] text-ink-3">{p.member.phone}</span>
                </td>
                <td className="num text-right">{p.issued}</td>
                <td className="num text-right text-pine">{p.used}</td>
                <td className="num text-right">{formatYuan(p.usedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function StatusCell({ r }: { r: GiftLedgerRow }) {
  return (
    <div className="space-y-0.5">
      <Badge tone={STATUS_TONE[r.status]} className="whitespace-nowrap">
        {GIFT_STATUS_LABELS[r.status]}
      </Badge>
      {r.status === 'used' && (
        <p className="text-[12px] leading-snug text-ink-2">
          结账单 <span className="num font-semibold">{r.checkoutNo}</span>
          {r.usedCents !== null && <> · 抵 {formatYuan(r.usedCents)}</>}
          <br />
          <span className="text-ink-3">
            {r.usedAt ? formatDateTime(r.usedAt) : ''} · {r.usedByName ?? ''}
          </span>
        </p>
      )}
      {r.status === 'voided' && (
        <p className="text-[12px] leading-snug text-ink-3">
          {r.voidReason} · {r.voidedByName ?? ''}
        </p>
      )}
      {r.status === 'expired' && <p className="text-[12px] text-ink-3">有效期到 {r.validTo}</p>}
    </div>
  );
}

function Detail({ l, canVoid, onVoid }: { l: Ledger; canVoid: boolean; onVoid: (r: GiftLedgerRow) => void }) {
  const voidable = (r: GiftLedgerRow) => canVoid && (r.status === 'available' || r.status === 'expired');
  const voidButton = (r: GiftLedgerRow) =>
    voidable(r) ? (
      <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} onClick={() => onVoid(r)} data-testid={`gift-void-${r.couponId}`}>
        作废
      </Button>
    ) : null;
  return (
    <Card className="min-w-0 p-4" data-testid="gift-detail">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-[14.5px] font-bold">明细</p>
        {l.truncated && <Badge tone="ember">只显示最近 1000 张，统计与导出是全部</Badge>}
      </div>
      {/* 宽屏：表格 */}
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[960px] text-[13px]" data-testid="gift-table">
          <thead>
            <tr className="text-left text-[12px] text-ink-3">
              <th className="py-1.5 font-semibold">券码 · 券种</th>
              <th className="font-semibold">会员</th>
              <th className="font-semibold">授权人 · 渠道</th>
              <th className="font-semibold">事由 · 经办</th>
              <th className="font-semibold">发放</th>
              <th className="font-semibold">状态 · 核销记录</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {l.rows.map((r) => (
              <tr key={r.couponId} className={cn('border-t border-line/70 align-top', r.status === 'voided' && 'text-ink-3')} data-testid={`gift-row-${r.couponId}`}>
                <td className="py-2">
                  <p className="num font-semibold">{formatStoreCouponCode(r.code)}</p>
                  <p className="text-[12.5px]">
                    {r.type.name} <span className="text-ink-3">· {r.segment}</span>
                  </p>
                </td>
                <td className="py-2">
                  <p className="font-semibold">{r.member?.name ?? '—'}</p>
                  <p className="num text-[12px] text-ink-3">{r.member?.phone ?? ''}</p>
                </td>
                <td className="py-2">
                  <p className="font-semibold">{r.authorizer.name}</p>
                  <p className="text-[12px] text-ink-3">{r.channel}</p>
                </td>
                <td className="max-w-[220px] py-2">
                  <p className="line-clamp-2">{r.reason}</p>
                  <p className="text-[12px] text-ink-3">{r.issuedByName ?? ''}</p>
                </td>
                <td className="py-2 whitespace-nowrap">
                  <p className="num">{formatDateTime(r.issuedAt)}</p>
                  <p className="num text-[12px] text-ink-3">{r.issueNo}</p>
                </td>
                <td className="py-2">
                  <StatusCell r={r} />
                </td>
                <td className="py-2 text-right">{voidButton(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* 窄屏（商米 V3、平板竖屏）：卡片 */}
      <ul className="space-y-2 lg:hidden" data-testid="gift-cards">
        {l.rows.map((r) => (
          <li key={r.couponId} className="rounded-lg border border-line/80 px-3 py-2.5" data-testid={`gift-card-${r.couponId}`}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-bold">{r.type.name}</span>
              <span className="num text-[12px] text-ink-3">{formatStoreCouponCode(r.code)}</span>
              <span className="flex-1" />
              <Badge tone={STATUS_TONE[r.status]}>{GIFT_STATUS_LABELS[r.status]}</Badge>
            </div>
            <p className="mt-1 text-[12.5px] text-ink-2">
              {r.member?.name ?? '—'} <span className="num text-ink-3">{r.member?.phone ?? ''}</span>
            </p>
            <p className="text-[12.5px] text-ink-2">
              授权 {r.authorizer.name} · {r.channel} · {r.segment}
            </p>
            <p className="line-clamp-2 text-[12.5px] text-ink-3">
              {r.reason} · {r.issuedByName ?? ''} · {formatDateTime(r.issuedAt)}
            </p>
            {r.status === 'used' && (
              <p className="text-[12.5px] text-pine">
                结账单 {r.checkoutNo}
                {r.usedCents !== null && <> · 抵 {formatYuan(r.usedCents)}</>}
              </p>
            )}
            {r.status === 'voided' && <p className="text-[12.5px] text-ink-3">作废：{r.voidReason}</p>}
            {voidable(r) && <div className="mt-1 flex justify-end">{voidButton(r)}</div>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
