// 后台「设备」（飞书需求 RQ-001，v0.7.21，docs/HARDWARE.md 第 4、5 节）：设备登记（新建、修改、停用）、按采购清单导入、
// 最近的打印任务与设备事件。新建走「结果待确认」（同 ERP 一套）；修改带版本号，没收到结果再保存会因版本号对不上被拒绝，不会改两次。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Upload } from 'lucide-react';
import {
  DEFAULT_PRINTER_PORT,
  DEVICE_AREAS,
  DEVICE_CONNECTION_LABELS,
  DEVICE_ERROR_LABELS,
  DEVICE_JOB_KIND_LABELS,
  DEVICE_JOB_STATUS_LABELS,
  DEVICE_KIND_CONNECTIONS,
  DEVICE_KIND_LABELS,
  DEVICE_KINDS,
  NETWORK_CONNECTIONS,
  type Device,
  type DeviceConnection,
  type DeviceEvent,
  type DeviceImportPreview,
  type DeviceJob,
  type DeviceKind,
} from '@shared/devices';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { StatusBadge, useDeviceOverview } from '../devices/DevicesPage';
import { AdminPage } from './AdminShell';

const keys = { list: ['devices', 'admin'] as const, jobs: ['devices', 'jobs'] as const, events: ['devices', 'events'] as const, preview: ['devices', 'import'] as const };

export function DevicesSection() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: keys.list, queryFn: () => api.get<Device[]>('/api/devices') });
  const overview = useDeviceOverview(false);
  const [target, setTarget] = useState<{ mode: 'new' } | { mode: 'edit'; device: Device } | null>(null);
  const pendingNew = useErpPending(['device_create']).length > 0;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['devices'] });
  return (
    <AdminPage
      section="devices"
      wide
      description="打印机、标签机、读卡器、扫码、终端与打印服务器的登记。网口设备填 IP 与端口，读卡与扫码挂到所在的终端；状态在门店主导航「设备」一屏看。"
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} disabled={pendingNew} onClick={() => setTarget({ mode: 'new' })} data-testid="device-new">
          登记设备
        </Button>
      }
    >
      <div className="space-y-4">
        <ErpPendingPanel types={['device_create']} className="space-y-2" onFound={() => void invalidate()} />
        <ImportCard onDone={() => void invalidate()} />
        <Card className="p-0">
          {!list.data ? (
            <Skeleton className="m-4 h-40" />
          ) : list.data.length === 0 ? (
            <p className="p-4 text-[13px] text-ink-3">还没有登记设备。可以先按采购清单导入，再逐台填 IP 与所属终端。</p>
          ) : (
            <table className="w-full text-[13px]" data-testid="device-table">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="px-4 py-2 font-semibold">编号 · 名称</th>
                  <th className="px-2 py-2 font-semibold">种类 · 型号</th>
                  <th className="px-2 py-2 font-semibold">区域</th>
                  <th className="px-2 py-2 font-semibold">接法 · 地址</th>
                  <th className="px-2 py-2 font-semibold">状态</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {list.data.map((d) => (
                  <tr key={d.id} className="border-t border-line" data-testid={`device-row-${d.code}`}>
                    <td className="px-4 py-2">
                      <span className="font-mono text-[12px] text-ink-3">{d.code}</span>
                      <br />
                      {d.name}
                    </td>
                    <td className="px-2 py-2">
                      {DEVICE_KIND_LABELS[d.kind]}
                      <br />
                      <span className="text-ink-3">{[d.brand, d.model].filter(Boolean).join(' ') || '—'}</span>
                    </td>
                    <td className="px-2 py-2">{d.area}</td>
                    <td className="px-2 py-2">
                      {DEVICE_CONNECTION_LABELS[d.connection]}
                      <br />
                      <span className="text-ink-3">
                        {NETWORK_CONNECTIONS.includes(d.connection) ? (d.host ? `${d.host}:${d.port}` : '没填 IP') : d.connection === 'bridge' ? `${d.hostDeviceCode ?? '没指定终端'} · ${d.bridgeKey}` : (d.hostDeviceCode ?? '')}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <StatusBadge device={d} />
                      {d.enabled && d.statusCode && <p className="mt-0.5 text-[12px] text-ink-3">{DEVICE_ERROR_LABELS[d.statusCode]}</p>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setTarget({ mode: 'edit', device: d })} data-testid={`device-edit-${d.code}`}>
                        修改
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <JobsAndEvents />
      </div>
      <DeviceDialog target={target} devices={list.data ?? overview.data?.devices ?? []} onClose={() => setTarget(null)} onSaved={() => void invalidate()} />
    </AdminPage>
  );
}

function ImportCard({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const preview = useQuery({ queryKey: keys.preview, queryFn: () => api.get<DeviceImportPreview>('/api/devices/import') });
  const [busy, setBusy] = useState(false);
  const p = preview.data;
  if (!p) return null;
  const run = async () => {
    setBusy(true);
    try {
      // 编号已有的跳过：没收到结果再点也只会补上缺的
      const r = await api.post<{ created: number; skipped: number }>('/api/devices/import');
      toast({ tone: 'success', title: `已按采购清单登记 ${r.created} 台`, body: r.skipped ? `编号已有、跳过 ${r.skipped} 台` : undefined });
      onDone();
    } catch (e) {
      toast({ tone: e instanceof UncertainError ? 'info' : 'error', title: e instanceof UncertainError ? '导入没收到结果' : '导入没成功', body: e instanceof UncertainError ? '刷新后看设备列表；再点导入只会补上缺的，不会重复' : errorMessage(e) });
      onDone();
    } finally {
      setBusy(false);
      void preview.refetch();
    }
  };
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4" data-testid="device-import">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">按采购清单导入（{p.total} 台）</p>
        <p className="text-[12.5px] text-ink-3">
          {p.create.length > 0 ? `会新建 ${p.create.length} 台` : '清单里的设备都登记了'}
          {p.skipped.length > 0 && `，编号已有、跳过 ${p.skipped.length} 台`}。导入后 IP、端口、所属终端由现场在这里填。
        </p>
      </div>
      {p.create.length > 0 && (
        <Button icon={<Upload className="size-4" />} loading={busy} onClick={() => void run()} data-testid="device-import-run">
          导入 {p.create.length} 台
        </Button>
      )}
    </Card>
  );
}

interface Draft {
  code: string;
  name: string;
  kind: DeviceKind;
  brand: string;
  model: string;
  area: string;
  connection: DeviceConnection;
  host: string;
  port: string;
  hostDeviceCode: string;
  bridgeKey: string;
  paperWidth: '58' | '80';
  labelLanguage: 'tspl' | 'escpos';
  labelWidthMm: string;
  labelHeightMm: string;
  note: string;
}

const draftOf = (d: Device | null): Draft => ({
  code: d?.code ?? '',
  name: d?.name ?? '',
  kind: d?.kind ?? 'printer',
  brand: d?.brand ?? '',
  model: d?.model ?? '',
  area: d?.area ?? '收银',
  connection: d?.connection ?? 'network',
  host: d?.host ?? '',
  port: d?.port ? String(d.port) : '',
  hostDeviceCode: d?.hostDeviceCode ?? '',
  bridgeKey: d?.bridgeKey ?? '',
  paperWidth: d?.options.paperWidth === 58 ? '58' : '80',
  labelLanguage: d?.options.labelLanguage ?? 'tspl',
  labelWidthMm: String(d?.options.labelWidthMm ?? 40),
  labelHeightMm: String(d?.options.labelHeightMm ?? 30),
  note: d?.note ?? '',
});

function DeviceDialog({ target, devices, onClose, onSaved }: { target: { mode: 'new' } | { mode: 'edit'; device: Device } | null; devices: Device[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const session = useSession();
  const editing = target?.mode === 'edit' ? target.device : null;
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 打开时按目标重置（新建为空、修改为那台设备）
  const key = target ? (editing ? `edit-${editing.id}-${editing.version}` : 'new') : null;
  if (key !== openKey) {
    setOpenKey(key);
    setDraft(draftOf(editing));
    setError(null);
  }
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const network = NETWORK_CONNECTIONS.includes(draft.connection);
  const hosts = useMemo(
    () => devices.filter((d) => d.enabled && d.id !== editing?.id && (draft.connection === 'print_server' ? d.kind === 'print_server' : d.kind === 'terminal')),
    [devices, editing, draft.connection],
  );
  const body = () => ({
    name: draft.name,
    kind: draft.kind,
    brand: draft.brand,
    model: draft.model,
    area: draft.area,
    connection: draft.connection,
    host: network ? draft.host || null : null,
    port: network && draft.port ? Number(draft.port) : null,
    hostDeviceCode: draft.connection === 'bridge' || draft.connection === 'keyboard' || draft.connection === 'print_server' ? draft.hostDeviceCode || null : null,
    bridgeKey: draft.connection === 'bridge' ? draft.bridgeKey || null : null,
    options:
      draft.kind === 'printer'
        ? { paperWidth: Number(draft.paperWidth) }
        : draft.kind === 'label_printer'
          ? { labelLanguage: draft.labelLanguage, labelWidthMm: Number(draft.labelWidthMm), labelHeightMm: Number(draft.labelHeightMm) }
          : {},
    note: draft.note,
  });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api.put<Device>(`/api/devices/${editing.id}`, { ...body(), expectedVersion: editing.version });
        toast({ tone: 'success', title: `已保存「${draft.name}」` });
      } else {
        const k = uuid();
        const created = await sendErpOp<Device>({
          key: k,
          type: 'device_create',
          url: '/api/devices',
          body: { ...body(), code: draft.code, clientKey: k },
          summary: `设备 ${draft.code.toUpperCase()}「${draft.name}」`,
          staffName: session.staff.displayName,
        });
        toast({ tone: 'success', title: `已登记「${created.name}」（${created.code}）` });
      }
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError && !editing) {
        toast({ tone: 'info', title: '登记设备：没收到结果', body: '记录留在本机，到页面上方查回、按原内容重新提交或确认作废' });
        onSaved();
        onClose();
      } else setError(e instanceof UncertainError ? `${e.message}，不确定有没有保存上：刷新后核对再改` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.post<Device>(`/api/devices/${editing.id}/enabled`, { enabled: !editing.enabled, expectedVersion: editing.version });
      toast({ tone: 'success', title: editing.enabled ? `已停用「${editing.name}」` : `已启用「${editing.name}」` });
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : onClose}
      width="max-w-2xl"
      title={editing ? `修改设备 ${editing.code}` : '登记设备'}
      description="网口打印机、标签机、打印服务器填 IP 与端口；读卡器、扫码挂到所在的终端（经设备服务的再填设备键）。"
      footer={
        <>
          {editing && (
            <Button variant={editing.enabled ? 'danger' : 'secondary'} disabled={busy} onClick={() => void toggle()} data-testid="device-toggle" className="mr-auto">
              {editing.enabled ? '停用' : '启用'}
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!draft.name.trim() || (!editing && !draft.code.trim())} onClick={() => void save()} data-testid="device-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="编号" hint={editing ? '编号登记后不能改' : '大写字母、数字与「-」，如 PRN-SY-05'}>
          <Input value={draft.code} disabled={!!editing} onChange={(e) => set({ code: e.target.value.toUpperCase() })} data-testid="device-code" />
        </Field>
        <Field label="名称">
          <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} data-testid="device-name" />
        </Field>
        <Field label="种类" hint={editing ? '种类登记后不能改' : undefined}>
          <Select
            value={draft.kind}
            disabled={!!editing}
            onChange={(e) => {
              const kind = e.target.value as DeviceKind;
              set({ kind, connection: DEVICE_KIND_CONNECTIONS[kind][0]! });
            }}
            data-testid="device-kind"
          >
            {DEVICE_KINDS.map((k) => (
              <option key={k} value={k}>
                {DEVICE_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="区域">
          <Select value={draft.area} onChange={(e) => set({ area: e.target.value })} data-testid="device-area">
            {[...DEVICE_AREAS.map((a) => a.name), ...(DEVICE_AREAS.some((a) => a.name === draft.area) ? [] : [draft.area])].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="品牌">
          <Input value={draft.brand} onChange={(e) => set({ brand: e.target.value })} />
        </Field>
        <Field label="型号">
          <Input value={draft.model} onChange={(e) => set({ model: e.target.value })} />
        </Field>
        <Field label="接法">
          <Select value={draft.connection} onChange={(e) => set({ connection: e.target.value as DeviceConnection })} data-testid="device-connection">
            {DEVICE_KIND_CONNECTIONS[draft.kind].map((c) => (
              <option key={c} value={c}>
                {DEVICE_CONNECTION_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        {(draft.connection === 'bridge' || draft.connection === 'keyboard' || draft.connection === 'print_server') && (
          <Field label={draft.connection === 'print_server' ? '所在打印服务器' : '所在终端'}>
            <Select value={draft.hostDeviceCode} onChange={(e) => set({ hostDeviceCode: e.target.value })} data-testid="device-host-device">
              <option value="">还没定</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.code}>
                  {h.area} · {h.name}（{h.code}）
                </option>
              ))}
            </Select>
          </Field>
        )}
        {network && (
          <>
            <Field label="IP 或主机名" hint="每台网口打印机要固定 IP（由门店 IT 在路由器上分配）">
              <Input value={draft.host} onChange={(e) => set({ host: e.target.value.trim() })} placeholder="192.168.1.50" data-testid="device-host" />
            </Field>
            <Field label="端口" hint={`不填按 ${DEFAULT_PRINTER_PORT}；经打印服务器的填它给这台打印机的端口`}>
              <Input value={draft.port} inputMode="numeric" onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} placeholder={String(DEFAULT_PRINTER_PORT)} data-testid="device-port" />
            </Field>
          </>
        )}
        {draft.connection === 'bridge' && (
          <Field label="设备键" hint="设备服务里这台设备的名字（同一台终端下唯一），如 rc300、scanner">
            <Input value={draft.bridgeKey} onChange={(e) => set({ bridgeKey: e.target.value.toLowerCase().trim() })} placeholder={draft.kind === 'scanner' ? 'scanner' : 'reader'} data-testid="device-bridge-key" />
          </Field>
        )}
        {draft.kind === 'printer' && (
          <Field label="纸宽">
            <Select value={draft.paperWidth} onChange={(e) => set({ paperWidth: e.target.value as Draft['paperWidth'] })}>
              <option value="80">80 毫米（每行 48 个半角字）</option>
              <option value="58">58 毫米（每行 32 个半角字）</option>
            </Select>
          </Field>
        )}
        {draft.kind === 'label_printer' && (
          <>
            <Field label="指令语言">
              <Select value={draft.labelLanguage} onChange={(e) => set({ labelLanguage: e.target.value as Draft['labelLanguage'] })}>
                <option value="tspl">TSPL（芯烨等）</option>
                <option value="escpos">ESC/POS（爱普生 TM-L100）</option>
              </Select>
            </Field>
            <Field label="标签尺寸（毫米，宽 × 高）">
              <div className="flex gap-2">
                <Input value={draft.labelWidthMm} inputMode="numeric" onChange={(e) => set({ labelWidthMm: e.target.value.replace(/\D/g, '') })} />
                <Input value={draft.labelHeightMm} inputMode="numeric" onChange={(e) => set({ labelHeightMm: e.target.value.replace(/\D/g, '') })} />
              </div>
            </Field>
          </>
        )}
        <Field label="备注" className="sm:col-span-2">
          <Input value={draft.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>
      </div>
      {error && (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}

function JobsAndEvents() {
  const jobs = useQuery({ queryKey: keys.jobs, queryFn: () => api.get<DeviceJob[]>('/api/devices/jobs?limit=20'), refetchInterval: 5_000 });
  const events = useQuery({ queryKey: keys.events, queryFn: () => api.get<DeviceEvent[]>('/api/devices/events?limit=30'), refetchInterval: 5_000 });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4" data-testid="device-jobs">
        <h2 className="mb-2 text-[15px] font-bold">最近的打印任务</h2>
        {(jobs.data ?? []).length === 0 ? (
          <p className="text-[13px] text-ink-3">还没有打印任务。</p>
        ) : (
          <ul className="space-y-1.5 text-[13px]">
            {jobs.data!.map((j) => (
              <li key={j.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  {j.deviceName} · {DEVICE_JOB_KIND_LABELS[j.kind]}
                  {j.errorCode && <span className="text-clay"> · {DEVICE_ERROR_LABELS[j.errorCode]}</span>}
                </span>
                <span className="text-[12px] text-ink-3">
                  {DEVICE_JOB_STATUS_LABELS[j.status]} · {j.createdByName} · {formatDateTime(j.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-4" data-testid="device-events">
        <h2 className="mb-2 text-[15px] font-bold">最近的设备事件</h2>
        {(events.data ?? []).length === 0 ? (
          <p className="text-[13px] text-ink-3">还没有设备事件（状态变化、读卡、扫码）。</p>
        ) : (
          <ul className="space-y-1.5 text-[13px]">
            {events.data!.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <span className="font-mono text-[12px] text-ink-3">{e.deviceCode ?? '—'}</span>{' '}
                  {e.type === 'status'
                    ? `状态 ${String(e.data.from ?? (e.data.enabled === undefined ? '' : e.data.enabled ? '启用' : '停用'))}${e.data.to ? ` → ${String(e.data.to)}` : ''}${e.data.reason ? `（${String(e.data.reason)}）` : ''}`
                    : `${e.type === 'card' ? '读卡' : e.type === 'scan' ? '扫码' : '错误'} ${String(e.data.value ?? '')}`}
                </span>
                <span className="text-[12px] text-ink-3">{formatDateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
