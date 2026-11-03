// 设备（飞书需求 RQ-001，v0.7.21，docs/HARDWARE.md 第 5 节）：门店主导航一屏看全部设备。
// 按区域分组，在线 / 离线 / 故障 / 未知一眼看到，2 秒刷新；打印机可测试打印（结果待确认同 ERP 一套）；
// 右侧「本机终端」：选这台终端是哪台、桥连没连上、最近的读卡与扫码（也收模拟键盘输入）。

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, CircleDashed, CircleOff, Printer, RefreshCw, ScanLine } from 'lucide-react';
import {
  createWedgeRecognizer,
  DEVICE_CONNECTION_LABELS,
  DEVICE_ERROR_LABELS,
  DEVICE_KIND_LABELS,
  DEVICE_STATUS_LABELS,
  NETWORK_CONNECTIONS,
  type Device,
  type DeviceJob,
  type DeviceKind,
  type DeviceOverview,
  type DeviceStatus,
} from '@shared/devices';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, isTypingTarget, relativeTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { DEFAULT_BRIDGE_URL, terminalActions, useTerminalBridge, useTerminalState } from './terminal';

export const deviceKeys = { overview: ['devices', 'overview'] as const, all: ['devices'] as const };

export function useDeviceOverview(refetch = true) {
  return useQuery({ queryKey: deviceKeys.overview, queryFn: () => api.get<DeviceOverview>('/api/devices/overview'), refetchInterval: refetch ? 2_000 : false });
}

const STATUS_TONE: Record<DeviceStatus, 'pine' | 'neutral' | 'clay' | 'yuzu'> = { online: 'pine', offline: 'neutral', error: 'clay', unknown: 'yuzu' };
const STATUS_ICON: Record<DeviceStatus, typeof CircleCheck> = { online: CircleCheck, offline: CircleOff, error: CircleAlert, unknown: CircleDashed };

export function StatusBadge({ device }: { device: Pick<Device, 'status' | 'enabled'> }) {
  if (!device.enabled) return <Badge tone="neutral">已停用</Badge>;
  const Icon = STATUS_ICON[device.status];
  return (
    <Badge tone={STATUS_TONE[device.status]} icon={<Icon className="size-3.5" aria-hidden />}>
      {DEVICE_STATUS_LABELS[device.status]}
    </Badge>
  );
}

type KindFilter = 'all' | 'print' | 'input' | 'terminal';
const KIND_GROUPS: Record<Exclude<KindFilter, 'all'>, DeviceKind[]> = {
  print: ['printer', 'label_printer', 'print_server'],
  input: ['card_reader', 'scanner'],
  terminal: ['terminal'],
};

const canPrint = (d: Device) => d.enabled && (d.kind === 'printer' || d.kind === 'label_printer') && NETWORK_CONNECTIONS.includes(d.connection) && !!d.host && !!d.port;
const address = (d: Device) =>
  NETWORK_CONNECTIONS.includes(d.connection) ? (d.host ? `${d.host}:${d.port ?? ''}` : '没填 IP') : d.connection === 'bridge' || d.connection === 'keyboard' ? (d.hostDeviceCode ?? '没指定终端') : '';

export function DevicesPage() {
  const can = useCan();
  const overview = useDeviceOverview();
  const [kind, setKind] = useState<KindFilter>('all');
  const [onlyTrouble, setOnlyTrouble] = useState(false);
  const o = overview.data;
  const devices = useMemo(() => {
    const list = o?.devices ?? [];
    return list.filter((d) => (kind === 'all' || KIND_GROUPS[kind].includes(d.kind)) && (!onlyTrouble || (d.enabled && d.status !== 'online')));
  }, [o, kind, onlyTrouble]);
  const areas = useMemo(() => {
    const map = new Map<string, Device[]>();
    for (const d of devices) map.set(d.area, [...(map.get(d.area) ?? []), d]);
    return [...map.entries()];
  }, [devices]);

  return (
    <div className="space-y-4" data-testid="devices-page">
      <PageHeader title="设备" subtitle="打印机、标签机、读卡器、扫码与终端，按区域一屏看全部状态（2 秒刷新）。离线变灰，故障标红，拔线 10 秒内能看到。" />
      <ErpPendingPanel types={['device_job']} className="space-y-2" />
      {!o ? (
        <Skeleton className="h-64" />
      ) : o.counts.total === 0 ? (
        <EmptyState
          art="calm"
          title="还没有登记设备"
          description={can('device.manage') ? '在「后台 → 设备」按采购清单导入，或逐台登记；网口打印机填上 IP 与端口后这里就能看到状态。' : '店主或店总在后台登记设备后，这里按区域显示状态。'}
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
          <div className="min-w-0 space-y-4">
            <Card className="flex flex-wrap items-center gap-2 p-3" data-testid="devices-counts">
              <Badge tone="pine">在线 {o.counts.online}</Badge>
              <Badge tone="neutral">离线 {o.counts.offline}</Badge>
              <Badge tone="clay">故障 {o.counts.error}</Badge>
              <Badge tone="yuzu">未知 {o.counts.unknown}</Badge>
              {o.counts.disabled > 0 && <Badge tone="neutral">停用 {o.counts.disabled}</Badge>}
              <span className="ml-auto text-[12px] text-ink-3">共 {o.counts.total} 台 · {relativeTime(o.checkedAt)}刷新</span>
            </Card>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented<KindFilter>
                value={kind}
                onChange={setKind}
                ariaLabel="设备种类"
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'print', label: '打印' },
                  { value: 'input', label: '读卡扫码' },
                  { value: 'terminal', label: '终端' },
                ]}
              />
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" checked={onlyTrouble} onChange={(e) => setOnlyTrouble(e.target.checked)} data-testid="devices-only-trouble" />
                只看不在线的
              </label>
            </div>
            {areas.length === 0 ? (
              <p className="text-[13px] text-ink-3">没有符合条件的设备。</p>
            ) : (
              areas.map(([area, list]) => (
                <Card key={area} className="p-0" data-testid={`devices-area-${area}`}>
                  <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                    <h2 className="text-[15px] font-bold">{area}</h2>
                    <span className="text-[12px] text-ink-3">
                      {list.filter((d) => d.enabled && d.status === 'online').length} / {list.length} 在线
                    </span>
                  </div>
                  <ul className="divide-y divide-line">
                    {list.map((d) => (
                      <DeviceRow key={d.id} device={d} />
                    ))}
                  </ul>
                </Card>
              ))
            )}
            <CatalogCard overview={o} />
          </div>
          <TerminalPanel terminals={o.devices.filter((d) => d.kind === 'terminal' && d.enabled)} />
        </div>
      )}
    </div>
  );
}

function DeviceRow({ device: d }: { device: Device }) {
  const can = useCan();
  return (
    <li className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5', (!d.enabled || d.status === 'offline') && 'opacity-60')} data-testid={`device-${d.code}`} data-status={d.enabled ? d.status : 'disabled'}>
      <StatusBadge device={d} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold">
          {d.name} <span className="font-mono text-[12px] font-normal text-ink-3">{d.code}</span>
        </p>
        <p className="truncate text-[12px] text-ink-3">
          {DEVICE_KIND_LABELS[d.kind]} · {[d.brand, d.model].filter(Boolean).join(' ') || '—'} · {DEVICE_CONNECTION_LABELS[d.connection]}
          {address(d) && ` · ${address(d)}`}
        </p>
        {d.enabled && d.statusCode && (
          <p className={cn('text-[12px]', d.status === 'error' ? 'text-clay' : 'text-ink-3')} data-testid={`device-${d.code}-reason`}>
            {DEVICE_ERROR_LABELS[d.statusCode]}
          </p>
        )}
      </div>
      <span className="text-[12px] text-ink-3" title={d.lastSeenAt ?? undefined}>
        {d.lastSeenAt ? `最近联系 ${relativeTime(d.lastSeenAt)}` : '还没联系上过'}
      </span>
      {can('device.test') && canPrint(d) && <TestPrintButton device={d} />}
    </li>
  );
}

/** 测试打印：发出前把编号与原请求存在本机（没收到结果时刷新后也能查回、重提或作废），之后跟着任务状态 */
function TestPrintButton({ device }: { device: Device }) {
  const toast = useToast();
  const session = useSession();
  const pending = useErpPending(['device_job']).some((p) => p.url === `/api/devices/${device.id}/jobs`);
  const [busy, setBusy] = useState(false);
  const kind = device.kind === 'label_printer' ? 'label_test' : 'test_page';
  const run = async () => {
    setBusy(true);
    try {
      const key = uuid();
      let job: DeviceJob;
      try {
        job = await sendErpOp<DeviceJob>({
          key,
          type: 'device_job',
          url: `/api/devices/${device.id}/jobs`,
          body: { clientKey: key, kind },
          summary: `${device.name}（${device.code}）· ${kind === 'label_test' ? '测试标签' : '测试页'}`,
          staffName: session.staff.displayName,
        });
      } catch (e) {
        if (e instanceof UncertainError) toast({ tone: 'info', title: '测试打印：没收到结果', body: '记录留在本机，到页面上方查回、按原内容重新提交或确认作废' });
        else toast({ tone: 'error', title: '测试打印没发出', body: errorMessage(e) });
        return;
      }
      // 到这里任务已经建好（本机的待确认记录随之删了）：之后查结果没成功，不能说没发出，也没有待确认的记录可查回——
      // 断网、超时的接着查；服务端明确拒绝了查询的不再查；到时还查不到就给出任务编号，去后台的打印任务里看（Codex 自动审查 8a20a54）
      let lookupError: unknown = null;
      const end = Date.now() + 20_000;
      while ((job.status === 'queued' || job.status === 'sending') && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 700));
        try {
          job = await api.get<DeviceJob>(`/api/devices/jobs/${job.id}`);
          lookupError = null;
        } catch (e) {
          lookupError = e;
          if (!(e instanceof UncertainError)) break;
        }
      }
      if (job.status === 'done') toast({ tone: 'success', title: `${device.name}：已打出${kind === 'label_test' ? '测试标签' : '测试页'}` });
      else if (job.status === 'failed') toast({ tone: 'error', title: `${device.name}：没打出来`, body: `${job.errorCode ? DEVICE_ERROR_LABELS[job.errorCode] : ''}${job.errorMessage ? `（${job.errorMessage}）` : ''}` });
      else if (lookupError)
        toast({ tone: 'info', title: `${device.name}：已提交，查不到结果`, body: `打印任务 #${job.id}（${errorMessage(lookupError)}）。稍后在后台「设备」的打印任务里看结果，先别重复提交` });
      else toast({ tone: 'info', title: `${device.name}：还在排队`, body: `打印任务 #${job.id}：稍后在后台「设备」的打印任务里看结果` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" icon={<Printer className="size-4" />} loading={busy} disabled={pending} onClick={() => void run()} data-testid={`device-${device.code}-test`}>
      {kind === 'label_test' ? '测试标签' : '测试打印'}
    </Button>
  );
}

function CatalogCard({ overview }: { overview: DeviceOverview }) {
  const lines = overview.catalog;
  if (!lines.some((l) => l.registered > 0)) return null;
  return (
    <Card className="p-4" data-testid="devices-catalog">
      <h2 className="mb-2 text-[15px] font-bold">采购清单对数</h2>
      <table className="w-full text-[13px]">
        <thead className="text-left text-ink-3">
          <tr>
            <th className="py-1 font-semibold">类别 · 型号</th>
            <th className="py-1 text-right font-semibold">采购</th>
            <th className="py-1 text-right font-semibold">已登记</th>
            <th className="py-1 text-right font-semibold">在线</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key} className="border-t border-line" data-testid={`devices-catalog-${l.key}`}>
              <td className="py-1.5">
                {l.category} · {l.brand} {l.model}
              </td>
              <td className="py-1.5 text-right tabular-nums">{l.purchased}</td>
              <td className={cn('py-1.5 text-right tabular-nums', l.registered !== l.purchased && 'font-semibold text-clay')}>{l.registered}</td>
              <td className="py-1.5 text-right tabular-nums">{l.online}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** 本机终端：选这台终端是哪台（记在本机）、桥连没连上、最近的读卡与扫码；设备页打开时也收模拟键盘输入 */
function TerminalPanel({ terminals }: { terminals: Device[] }) {
  const t = useTerminalState();
  const qc = useQueryClient();
  useTerminalBridge(true);
  const [url, setUrl] = useState(t.bridgeUrl);
  // 模拟键盘：很短时间内连续输入、以回车结束的认作一次扫码 / 读卡（在输入框里打字不算）
  useEffect(() => {
    const wedge = createWedgeRecognizer();
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const code = wedge.feed(e.key, e.timeStamp);
      if (code) terminalActions.keyboardInput(code);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const mine = terminals.find((x) => x.code === t.terminal) ?? null;
  return (
    <Card className="h-fit space-y-3 p-4" data-testid="terminal-panel">
      <h2 className="text-[15px] font-bold">本机终端</h2>
      <Field label="这台终端是" hint="记在这台设备的浏览器里；选了之后开着门店页面就会每 2 秒上报读卡器、扫码的状态">
        <Select
          value={t.terminal ?? ''}
          onChange={(e) => {
            terminalActions.setTerminal(e.target.value || null);
            void qc.invalidateQueries({ queryKey: deviceKeys.overview });
          }}
          data-testid="terminal-select"
        >
          <option value="">不是终端（不上报）</option>
          {terminals.map((x) => (
            <option key={x.id} value={x.code}>
              {x.area} · {x.name}（{x.code}）
            </option>
          ))}
        </Select>
      </Field>
      <Field label="设备服务地址" hint={`终端上的设备服务（桥）在本机开的 WebSocket，默认 ${DEFAULT_BRIDGE_URL}`}>
        <div className="flex gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} data-testid="terminal-bridge-url" />
          <Button icon={<RefreshCw className="size-4" />} onClick={() => terminalActions.setBridgeUrl(url)} data-testid="terminal-bridge-connect">
            连接
          </Button>
        </div>
      </Field>
      <div className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="terminal-bridge-state">
        {t.connected ? <Badge tone="pine">设备服务已连上</Badge> : <Badge tone="neutral">设备服务没连上</Badge>}
        {t.bridgeVersion && <span className="text-ink-3">版本 {t.bridgeVersion}</span>}
        {t.bridgeTerminal && mine && t.bridgeTerminal !== mine.code && <Badge tone="yuzu">设备服务报的终端是 {t.bridgeTerminal}</Badge>}
      </div>
      {t.protocolError && (
        <Notice tone="warning" title="设备服务的报文不对">
          {t.protocolError}
        </Notice>
      )}
      {t.devices.length > 0 && (
        <ul className="space-y-1 text-[13px]" data-testid="terminal-devices">
          {t.devices.map((d) => (
            <li key={d.key} className="flex items-center justify-between gap-2" data-testid={`terminal-device-${d.key}`} data-status={d.status}>
              <span>
                {DEVICE_KIND_LABELS[d.kind]} <span className="font-mono text-ink-3">{d.key}</span>
              </span>
              <Badge tone={STATUS_TONE[d.status]}>{DEVICE_STATUS_LABELS[d.status]}</Badge>
            </li>
          ))}
        </ul>
      )}
      {t.terminal && t.lastReport && (
        <p className={cn('text-[12px]', t.lastReport.ok ? 'text-ink-3' : 'text-clay')} data-testid="terminal-report">
          {t.lastReport.ok ? `已上报（${relativeTime(t.lastReport.at)}）` : `上报失败：${t.lastReport.message}`}
          {t.lastReport.result && t.lastReport.result.unknownKeys.length > 0 && `；登记里没有的设备：${t.lastReport.result.unknownKeys.join('、')}（在后台把设备挂到这台终端）`}
        </p>
      )}
      <div>
        <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
          <ScanLine className="size-4" aria-hidden /> 最近的读卡与扫码
        </h3>
        {t.events.length === 0 ? (
          <p className="text-[12px] text-ink-3">刷一下手牌、扫一下码就会出现在这里（模拟键盘的扫码枪直接在这一页扫）。</p>
        ) : (
          <ul className="space-y-1 text-[13px]" data-testid="terminal-events">
            {t.events.slice(0, 10).map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2" data-testid="terminal-event">
                <span className={cn(e.type === 'error' && 'text-clay')}>
                  {e.type === 'card' ? '读卡' : e.type === 'scan' ? '扫码' : '错误'} <span className="font-mono">{e.value}</span>
                </span>
                <span className="text-[12px] text-ink-3">
                  {e.source === 'keyboard' ? '键盘' : e.key} · {relativeTime(e.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
