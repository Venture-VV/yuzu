// 「网络与同步」（8.1.3，docs/RESILIENCE_V813.md 第 3.6 节，WL12）：头像菜单、断网提示条进。
// 本机：连没连上、最近一次连上服务器、往返多久；这一页与服务器的版本；这台电脑上的「结果待确认」；本机存储能不能用；最近的问题。
// 按钮：立即检查连接、重新查回待确认、清掉页面缓存并刷新（只清页面数据缓存，不清待确认记录）。
// 店主、店长另看全店最近的页面报错（服务器内存里最近 200 条，重启清空）。
// 不用登录也能打开（断网时、登录页出问题时也要看得到）；全店的报错要登录、要「查看操作审计」。

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, Trash2, Wifi, WifiOff } from 'lucide-react';
import { ERP_OP_TYPES } from '@shared/erp';
import type { ClientErrorRecord } from '@shared/resilience';
import { api } from '../../lib/api';
import { PAGE_ENTRY, useProblems, type ProblemKind } from '../../lib/clientLog';
import { lastContactAt, probe, requestRecheck, useConnection } from '../../lib/connection';
import { useErpPending } from '../../lib/erpPending';
import { usePendingOps } from '../../lib/pendingOps';
import { useSessionQuery } from '../../lib/queries';
import { useFrontdeskPending } from '../frontdesk/pending';
import { Badge, Button, Card, Notice } from '../../components/ui';
import { cn } from '../../lib/utils';

const time = (at: number | null) => (at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '—');

const KIND_TEXT: Record<ProblemKind, string> = { offline: '断开', online: '恢复', retry: '自动重发', error: '页面报错', update: '系统更新' };
const KIND_TONE: Record<ProblemKind, string> = { offline: 'text-clay', online: 'text-pine', retry: 'text-yuzu-deep', error: 'text-clay', update: 'text-lake' };

function storageWorks(): boolean {
  try {
    const k = 'yuzu.storage-check';
    localStorage.setItem(k, '1');
    const ok = localStorage.getItem(k) === '1';
    localStorage.removeItem(k);
    return ok;
  } catch {
    return false;
  }
}

export function NetworkPage() {
  const conn = useConnection();
  const problems = useProblems();
  const qc = useQueryClient();
  const session = useSessionQuery();
  const memberOps = usePendingOps();
  const erpOps = useErpPending(ERP_OP_TYPES);
  const frontdeskOps = useFrontdeskPending();
  const storageOk = useMemo(storageWorks, []);
  const [checking, setChecking] = useState(false);
  const canSeeStore = Boolean(session.data?.permissions.includes('audit.read'));
  const storeErrors = useQuery({
    queryKey: ['client-errors'],
    queryFn: () => api.get<ClientErrorRecord[]>('/api/client-errors'),
    enabled: canSeeStore,
    refetchInterval: 30_000,
  });

  const check = async () => {
    setChecking(true);
    await probe();
    setChecking(false);
  };
  const versionMismatch = conn.updated;
  const pendingTotal = memberOps.length + erpOps.length + frontdeskOps.length;

  return (
    <div className="min-h-dvh bg-paper px-4 py-6 md:px-8" data-testid="network-page">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-paper-2" aria-label="回首页">
            <ArrowLeft className="size-5" />
          </Link>
          <h1 className="text-[20px] font-bold">网络与同步</h1>
        </div>

        <Card className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            {conn.state === 'offline' ? <WifiOff className="size-6 text-clay" /> : <Wifi className="size-6 text-pine" />}
            <p className="text-[16px] font-bold" data-testid="network-state">
              {conn.state === 'offline' ? '连不上服务器' : conn.state === 'checking' ? '正在确认连接…' : '连接正常'}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void check()} loading={checking} icon={<RefreshCw className="size-4" />} data-testid="network-check">
              立即检查连接
            </Button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13.5px]">
            <dt className="text-ink-3">最近一次连上服务器</dt>
            <dd>{time(lastContactAt() ?? conn.lastOkAt)}</dd>
            {conn.state === 'offline' && (
              <>
                <dt className="text-ink-3">从几点开始连不上</dt>
                <dd>
                  {time(conn.downSince)}（已经重新问了 {conn.attempts} 次）
                </dd>
              </>
            )}
            <dt className="text-ink-3">往返时间</dt>
            <dd>{conn.rttMs === null ? '—' : `${conn.rttMs} 毫秒`}</dd>
            <dt className="text-ink-3">服务器版本</dt>
            <dd>{conn.server ? `${conn.server.version}${conn.server.commit ? ` · ${conn.server.commit.slice(0, 7)}` : ''}` : '—'}</dd>
            <dt className="text-ink-3">这一页</dt>
            <dd className={cn(versionMismatch && 'font-bold text-clay')}>
              {versionMismatch ? '更新前打开的旧页面' : '和服务器一致'}
              {PAGE_ENTRY ? <span className="ml-2 text-[12px] text-ink-4">{PAGE_ENTRY.replace('/assets/', '')}</span> : null}
            </dd>
            <dt className="text-ink-3">本机存储</dt>
            <dd className={cn(!storageOk && 'font-bold text-clay')}>{storageOk ? '能用（「结果待确认」存得下）' : '不能用：记账类操作会拦着不让提交，请联系店主清理浏览器数据'}</dd>
          </dl>
          {versionMismatch && (
            <Notice
              tone="warning"
              action={
                <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
                  刷新
                </Button>
              }
            >
              系统已经更新，这一页还是更新前打开的；方便时刷新（没提交的内容先提交）。
            </Notice>
          )}
        </Card>

        <Card className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-[15px] font-bold">这台电脑上的「结果待确认」</h2>
            <span data-testid="network-pending-total">
              <Badge tone={pendingTotal ? 'yuzu' : 'neutral'}>{pendingTotal} 笔</Badge>
            </span>
            <Button size="sm" variant="secondary" onClick={requestRecheck} disabled={!pendingTotal} data-testid="network-recheck">
              重新查回
            </Button>
          </div>
          <p className="text-[13px] text-ink-3">提交时网络断了、超时，结果不知道的记录存在这台电脑的浏览器里，刷新、重新登录都不会丢；查回、按原内容重提或确认作废都用原来的编号，不会重复入账。</p>
          <ul className="space-y-1 text-[13.5px]">
            <li>
              会员记账（充值、消费、撤销）：{memberOps.length} 笔
              {memberOps.length ? (
                <Link to="/" className="ml-2 text-pine underline">
                  去会员工作台处理
                </Link>
              ) : null}
            </li>
            <li>
              前台（手牌、结账、客房、预约等）：{frontdeskOps.length} 笔
              {frontdeskOps.length ? (
                <Link to="/frontdesk" className="ml-2 text-pine underline">
                  去前台处理
                </Link>
              ) : null}
            </li>
            <li>
              ERP 单据：{erpOps.length} 笔{erpOps.length ? <span className="ml-2 text-ink-3">（在登记它的那一页上方处理）</span> : null}
            </li>
          </ul>
        </Card>

        <Card className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-[15px] font-bold">最近的问题（这一页打开以后）</h2>
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="size-4" />}
              onClick={() => {
                qc.clear();
                window.location.reload();
              }}
              data-testid="network-clear-cache"
            >
              清掉页面缓存并刷新
            </Button>
          </div>
          {problems.length === 0 ? (
            <p className="text-[13px] text-ink-3">没有。</p>
          ) : (
            <ul className="space-y-1 text-[13px]" data-testid="network-problems">
              {problems.map((p, i) => (
                <li key={`${p.at}-${i}`} className="flex gap-3">
                  <span className="w-[70px] shrink-0 text-ink-3 tabular-nums">{time(p.at)}</span>
                  <span className={cn('w-[64px] shrink-0 font-semibold', KIND_TONE[p.kind])}>{KIND_TEXT[p.kind]}</span>
                  <span className="min-w-0 break-words text-ink-2">{p.text}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-ink-4">「清掉页面缓存」只清这一页暂存的数据，不清「结果待确认」的记录。</p>
        </Card>

        {canSeeStore && (
          <Card className="space-y-3 p-5" data-testid="network-store-errors">
            <h2 className="text-[15px] font-bold">全店最近的页面报错</h2>
            <p className="text-[12.5px] text-ink-3">各台电脑、平板报上来的，服务器只记最近 200 条，重启清空；只有错误本身与地址，不带填的内容。</p>
            {storeErrors.data?.length ? (
              <ul className="divide-y divide-line text-[13px]">
                {storeErrors.data.slice(0, 50).map((e) => (
                  <li key={e.id} className="py-2">
                    <div className="flex flex-wrap gap-x-3 text-ink-3">
                      <span className="tabular-nums">{new Date(e.at).toLocaleString('zh-CN', { hour12: false })}</span>
                      <span>{e.path}</span>
                      <span>{e.staff?.name ?? '没登录'}</span>
                      <span>{e.ip}</span>
                    </div>
                    <p className="mt-0.5 break-words font-medium text-ink">{e.message}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-3">
                {storeErrors.fetchStatus === 'paused' ? '连上服务器以后再取。' : storeErrors.isPending ? '正在取…' : storeErrors.isError ? '没取回来，稍后会自己再取。' : '没有。'}
              </p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
