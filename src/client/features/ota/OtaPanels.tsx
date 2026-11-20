// OTA 渠道订单（8.0.21，docs/INTEGRATIONS_V8021.md 第 4 节，CW-I）：
//   · OtaOrdersPanel（前台「预约 → 渠道订单」）：选渠道、选渠道后台导出的订单表（CSV / Excel）→ 先看认出了几张、哪些房型没对照
//     → 导入（建、改、取消客房预约）→ 订单列表（没建成的补了对照以后重试）→ 渠道对账（按入住月份，可导出）。
//   · OtaChannelsCard（后台「客房 → 渠道」）：渠道、佣金比例、渠道房型 → 本店房型的对照。
// 导入带操作编号：没收到结果时按原内容再提交一次（同一份文件只导一次，重提返回上一次的结果）。

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Upload } from 'lucide-react';
import { formatYuan } from '@shared/money';
import {
  OTA_FIELD_LABELS,
  OTA_ORDER_STATUS_LABELS,
  type OtaChannel,
  type OtaColumnMap,
  type OtaImportResult,
  type OtaOrderStatus,
  type OtaOrderView,
  type OtaReconRow,
  type ParsedOtaOrder,
} from '@shared/ota';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { DataTable } from '../../components/DataTable';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { useCan, useSession } from '../../lib/session';
import { downloadUrl, uuid } from '../../lib/utils';
import { readTablePayload } from '../../lib/import-file';
import { useRoomsAdmin } from '../rooms/queries';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, IconButton, Input, Notice, Select, Skeleton } from '../../components/ui';

const otaKeys = { channels: ['ota', 'channels'] as const, orders: (s: string) => ['ota', 'orders', s] as const, recon: (m: string) => ['ota', 'recon', m] as const };
const useChannels = () => useQuery({ queryKey: otaKeys.channels, queryFn: () => api.get<OtaChannel[]>('/api/ota/channels') });

interface Preview {
  header: string[];
  columnMap: OtaColumnMap;
  problem: string | null;
  duplicate: boolean;
  total: number;
  unmapped: string[];
  orders: ParsedOtaOrder[];
  problems: { row: number; message: string }[];
}

type PickedFile = { name: string; payload: { csv?: string; xlsxBase64?: string } };

const STATUS_TONE: Record<OtaOrderStatus, 'pine' | 'neutral' | 'clay' | 'yuzu'> = { new: 'neutral', booked: 'pine', cancelled: 'neutral', failed: 'clay', skipped: 'neutral' };

export function OtaOrdersPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const channels = useChannels();
  const active = (channels.data ?? []).filter((c) => c.active);
  const [channelId, setChannelId] = useState<number | null>(null);
  const cid = channelId ?? active[0]?.id ?? null;
  const [file, setFile] = useState<PickedFile | null>(null);
  // 预览记着是按哪个渠道看的：换了渠道就作废、按新渠道重新预览（各渠道的列对照、房型对照不一样，Codex 审查 26fe580 后补）
  const [preview, setPreview] = useState<(Preview & { forChannel: number }) | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  // 每发一次预览加一：回来晚了的（之前那个渠道、之前那份文件的）不再用
  const previewSeq = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OtaImportResult | null>(null);
  const [status, setStatus] = useState<OtaOrderStatus | ''>('');
  const orders = useQuery({ queryKey: otaKeys.orders(status), queryFn: () => api.get<OtaOrderView[]>(`/api/ota/orders${status ? `?status=${status}` : ''}`) });
  const [month, setMonth] = useState(session.today.slice(0, 7));
  const recon = useQuery({ queryKey: otaKeys.recon(month), queryFn: () => api.get<OtaReconRow[]>(`/api/ota/recon?month=${month}`) });

  const runPreview = async (f: PickedFile, channel: number) => {
    const seq = ++previewSeq.current;
    setPreview(null);
    setPreviewing(true);
    try {
      const p = await api.post<Preview>('/api/ota/import/preview', { channelId: channel, fileName: f.name, ...f.payload });
      if (seq === previewSeq.current) setPreview({ ...p, forChannel: channel });
    } catch (e) {
      if (seq === previewSeq.current) setError(errorMessage(e));
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  };
  const pick = async (f: File | null) => {
    previewSeq.current += 1;
    setPreview(null);
    setPreviewing(false);
    setResult(null);
    setError(null);
    if (!f || !cid) return setFile(null);
    try {
      const picked = { name: f.name, payload: await readTablePayload(f) };
      setFile(picked);
      await runPreview(picked, cid);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const changeChannel = (id: number | null) => {
    setChannelId(id);
    previewSeq.current += 1;
    setPreview(null);
    setPreviewing(false);
    setResult(null);
    setError(null);
    if (file && id) void runPreview(file, id);
  };
  // 结果待确认（AGENTS.md；Codex 审查 e64932b 后补）：与网银流水导入同一套——发出去之前把编号与原请求存进本机（存不了不发），
  // 超时、断网、5xx 以后记在上面的「结果待确认」里，刷新页面、关掉再开也能按原编号查回、原样重提（接着处理没做完的订单）或确认作废
  const doImport = async () => {
    // 只导看过预览的那个渠道（按钮在预览与当前渠道对不上时本来就点不了）
    if (!file || !preview || preview.forChannel !== cid) return;
    setImporting(true);
    setError(null);
    // 每次提交一个新编号（与网银流水导入一样）：没收到结果的那一次留在「结果待确认」里按它自己的编号处理，接着导别的文件不会盖掉它
    const key = uuid();
    const body = { clientKey: key, channelId: preview.forChannel, fileName: file.name, ...file.payload };
    try {
      const r = await sendErpOp<OtaImportResult>({ key, type: 'ota_import', url: '/api/ota/import', body, summary: `导入渠道订单 ${file.name}`, staffName: session.staff.displayName });
      setResult(r);
      setPreview(null);
      toast({ tone: 'success', title: `导入完成：新建 ${r.created}、改了 ${r.updated}、取消 ${r.cancelled}`, body: r.failed ? `${r.failed} 张没建成，看下面的原因` : undefined });
    } catch (e) {
      if (e instanceof UncertainError) {
        setPreview(null);
        setError('导入没收到结果：记在上面的「结果待确认」里，查回或原样重提（没处理完的订单会接着处理），不要换一个文件重新导');
      } else setError(errorMessage(e));
    } finally {
      setImporting(false);
      await qc.invalidateQueries({ queryKey: ['ota'] });
      await qc.invalidateQueries({ queryKey: ['bookings'] });
    }
  };
  const retry = async (o: OtaOrderView) => {
    try {
      const r = await api.post<OtaOrderView>(`/api/ota/orders/${o.id}/retry`, { rev: o.rev });
      toast({ tone: r.status === 'booked' ? 'success' : 'error', title: r.status === 'booked' ? `订单 ${o.orderNo} 建好了预约` : (r.failReason ?? '还是没建成') });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      await qc.invalidateQueries({ queryKey: ['ota'] });
    }
  };

  if (channels.isError && !channels.data) return <LoadFailed title="渠道取不回来，请检查网络" onRetry={() => void channels.refetch()} retrying={channels.isFetching} testId="ota-channels-error" />;
  if (channels.data && !active.length) return <Notice tone="info" title="还没有渠道：请到后台「营业项目 → 客房 → 渠道」先加渠道和房型对照。" />;
  return (
    <div className="space-y-4" data-testid="ota-orders">
      <ErpPendingPanel
        types={['ota_import']}
        onFound={() => {
          void qc.invalidateQueries({ queryKey: ['ota'] });
          void qc.invalidateQueries({ queryKey: ['bookings'] });
        }}
      />
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="渠道" htmlFor="ota-channel">
            <Select
              id="ota-channel"
              value={cid ?? ''}
              fullWidth={false}
              className="h-10 w-40"
              disabled={importing}
              onChange={(e) => changeChannel(Number(e.target.value) || null)}
              data-testid="ota-channel"
            >
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="渠道后台导出的订单表（CSV / Excel）" htmlFor="ota-file">
            <input
              id="ota-file"
              type="file"
              accept=".csv,.xlsx,text/csv"
              disabled={importing}
              onChange={(e) => void pick(e.target.files?.[0] ?? null)}
              className="block text-[13px]"
              data-testid="ota-file"
            />
          </Field>
          <span className="flex-1" />
          <Button
            variant="primary"
            icon={<Upload className="size-4" />}
            loading={importing || previewing}
            disabled={!preview || preview.forChannel !== cid || !!preview.problem || preview.duplicate || preview.total === 0}
            onClick={() => void doImport()}
            data-testid="ota-import"
          >
            导入
          </Button>
        </div>
        {preview && (
          <div className="space-y-2 text-[13px]" data-testid="ota-preview">
            {preview.problem ? (
              <Notice tone="error" title={preview.problem} />
            ) : preview.duplicate ? (
              <Notice tone="warning" title="这份文件已经导过了：渠道有新的变化请重新导出一份" />
            ) : (
              <p>
                认出 <b>{preview.total}</b> 张订单（列：
                {Object.entries(preview.columnMap)
                  .map(([f, h]) => `${OTA_FIELD_LABELS[f as keyof typeof OTA_FIELD_LABELS]}=${h}`)
                  .join('、')}
                ）
              </p>
            )}
            {preview.unmapped.length > 0 && <Notice tone="warning" title={`这些渠道房型还没对照本店房型，导入会记「没建成」：${preview.unmapped.join('、')}`} />}
            {preview.problems.length > 0 && (
              <ul className="list-disc pl-5 text-clay">
                {preview.problems.slice(0, 10).map((p) => (
                  <li key={p.row}>
                    第 {p.row} 行：{p.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {result && (
          <Notice
            tone={result.failed ? 'warning' : 'success'}
            title={`导入完成：${result.rows} 张，新建 ${result.created}、改了 ${result.updated}、取消 ${result.cancelled}、没建成 ${result.failed}、跳过 ${result.skipped}、没变 ${result.unchanged}`}
            data-testid="ota-result"
          />
        )}
        {error && <Notice tone="error" title={error} />}
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-bold">渠道订单</h3>
        <Select value={status} fullWidth={false} className="h-9 w-32" onChange={(e) => setStatus(e.target.value as OtaOrderStatus | '')} aria-label="状态">
          <option value="">全部</option>
          {(Object.keys(OTA_ORDER_STATUS_LABELS) as OtaOrderStatus[]).map((s) => (
            <option key={s} value={s}>
              {OTA_ORDER_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>
      {/* 取不回来（也没有上一次的）写明加载失败、可以重试，不一直转圈（Codex 审查 73ae462 后补，AGENTS.md「列表取不回来用 LoadFailed」） */}
      {!orders.data ? (
        orders.isError ? (
          <LoadFailed title="渠道订单加载失败，请检查网络" onRetry={() => void orders.refetch()} retrying={orders.isFetching} testId="ota-orders-error" />
        ) : (
          <Skeleton className="h-32" />
        )
      ) : orders.data.length === 0 ? (
        <p className="text-[13px] text-ink-3">还没有渠道订单。</p>
      ) : (
        <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card text-[13px]" data-testid="ota-order-list">
          {orders.data.map((o) => (
            <li key={o.id} className="space-y-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[o.status]}>{OTA_ORDER_STATUS_LABELS[o.status]}</Badge>
                {o.overbooked && <Badge tone="clay">超订</Badge>}
                <span className="font-semibold">
                  {o.channelName} · <span className="num">{o.orderNo}</span>
                </span>
                <span>
                  {o.guestName || '—'} · {o.roomTypeName ?? o.channelRoom} × {o.rooms} 间 · {o.checkinDate} 起 {o.nights} 晚 · {formatYuan(o.amountCents)}（{o.payMode === 'prepaid' ? '预付' : '现付'}
                  ）
                </span>
                <span className="flex-1" />
                {o.status === 'failed' && (
                  <Button size="sm" variant="secondary" onClick={() => void retry(o)} data-testid={`ota-retry-${o.orderNo}`}>
                    重试
                  </Button>
                )}
              </div>
              {(o.failReason || o.notice) && <p className="text-[12.5px] text-clay">{o.notice ?? o.failReason}</p>}
              {o.bookings.length > 0 && (
                <p className="text-[12px] text-ink-3">
                  预约：
                  {o.bookings.map((b) => `${b.bookingNo}（${b.status === 'confirmed' ? '已预约' : b.status === 'arrived' ? '已到店' : b.status === 'cancelled' ? '已取消' : b.status}）`).join('、')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-bold">渠道对账</h3>
        <Input type="month" fullWidth={false} value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 w-40" aria-label="月份" />
        <Button size="sm" variant="ghost" onClick={() => downloadUrl(`/api/ota/recon.csv?month=${month}`)}>
          导出
        </Button>
        <span className="text-[12px] text-ink-3">按入住月份、已建预约的订单；渠道打款照旧在「平台核销补录 → 打款与对账」登记（平台选「其他」、备注写渠道）</span>
      </div>
      {!recon.data ? (
        recon.isError ? (
          <LoadFailed title="渠道对账加载失败，请检查网络" onRetry={() => void recon.refetch()} retrying={recon.isFetching} testId="ota-recon-error" />
        ) : (
          <Skeleton className="h-24" />
        )
      ) : (
        // 没有订单的月份也留着 ota-recon 这一块（空态在里面），取不回来时上面是 ota-recon-error
        <div data-testid="ota-recon">
          <DataTable
            onPage
            rows={recon.data}
            rowKey={(r) => r.channelId}
            empty="这个月没有渠道订单"
            columns={[
              { key: 'channel', header: '渠道', cell: (r) => r.channelName },
              { key: 'orders', header: '订单数', numeric: true, cell: (r) => r.orders },
              { key: 'nights', header: '间夜', numeric: true, cell: (r) => r.roomNights },
              { key: 'amount', header: '订单金额', numeric: true, cell: (r) => formatYuan(r.amountCents) },
              { key: 'commission', header: '佣金', numeric: true, cell: (r) => formatYuan(r.commissionCents) },
              { key: 'net', header: '应收净额', numeric: true, cellClassName: 'font-semibold', cell: (r) => formatYuan(r.netCents) },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/** 后台「客房 → 渠道」 */
export function OtaChannelsCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useChannels();
  const types = useRoomsAdmin();
  const [editing, setEditing] = useState<(Partial<OtaChannel> & { rows: { name: string; roomTypeId: number | '' }[]; commission: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can('settings.manage') || can('catalog.manage');
  const open = (c: OtaChannel | null) =>
    setEditing(
      c
        ? { ...c, rows: Object.entries(c.roomMap).map(([name, roomTypeId]) => ({ name, roomTypeId })), commission: String(c.commissionBp / 100) }
        : { name: '', active: true, rows: [{ name: '', roomTypeId: '' }], commission: '0' },
    );
  const save = async () => {
    if (!editing) return;
    const commission = Number(editing.commission);
    if (!(commission >= 0 && commission <= 100)) return toast({ tone: 'error', title: '佣金比例写 0–100 的数' });
    const roomMap = Object.fromEntries(editing.rows.filter((r) => r.name.trim() && r.roomTypeId).map((r) => [r.name.trim(), Number(r.roomTypeId)]));
    const body = { name: (editing.name ?? '').trim(), commissionBp: Math.round(commission * 100), roomMap, columnMap: editing.columnMap ?? {}, active: editing.active ?? true };
    setBusy(true);
    try {
      if (editing.id) await api.put(`/api/ota/channels/${editing.id}`, { ...body, version: editing.version });
      else await api.post('/api/ota/channels', body);
      await qc.invalidateQueries({ queryKey: otaKeys.channels });
      setEditing(null);
      toast({ tone: 'success', title: '渠道已保存' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const roomTypes = (types.data?.types ?? []).filter((t) => t.active);
  return (
    <Card className="space-y-3 p-5" data-testid="ota-channels">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-bold">OTA 渠道</h2>
        <span className="text-[12.5px] text-ink-3">渠道后台导出的订单表在前台「预约 → 渠道订单」导入；渠道房型要对照本店房型才能建预约。房量房价不自动推给渠道。</span>
        <span className="flex-1" />
        {manage && (
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => open(null)} data-testid="ota-channel-new">
            新建渠道
          </Button>
        )}
      </div>
      {!channels.data ? (
        channels.isError ? (
          <LoadFailed title="渠道取不回来，请检查网络" onRetry={() => void channels.refetch()} retrying={channels.isFetching} testId="ota-channel-list-error" />
        ) : (
          <Skeleton className="h-20" />
        )
      ) : (
        <ul className="divide-y divide-line/70 rounded-md border border-line text-[13px]">
          {channels.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-semibold">{c.name}</span>
              {!c.active && <Badge>已停用</Badge>}
              <span className="text-ink-3">
                佣金 {c.commissionBp / 100}% · 对照 {Object.keys(c.roomMap).length} 个房型
              </span>
              <span className="flex-1" />
              {manage && (
                <Button size="sm" variant="ghost" onClick={() => open(c)}>
                  改
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <div className="space-y-2 rounded-lg border border-line bg-paper-2/50 p-3" data-testid="ota-channel-form">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="渠道名称" htmlFor="oc-name">
              <Input id="oc-name" value={editing.name ?? ''} maxLength={20} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="h-9" data-testid="oc-name" />
            </Field>
            <Field label="佣金比例（%）" htmlFor="oc-comm">
              <Input id="oc-comm" inputMode="decimal" value={editing.commission} onChange={(e) => setEditing({ ...editing, commission: e.target.value })} className="h-9" data-testid="oc-commission" />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-[13px]">
              <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={editing.active ?? true} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              启用
            </label>
          </div>
          <p className="text-[13px] font-semibold text-ink-2">渠道房型 → 本店房型</p>
          {types.isError && !types.data && (
            <LoadFailed title="本店房型取不回来，对照选不了（已有的对照保存时照旧留着），请检查网络" onRetry={() => void types.refetch()} retrying={types.isFetching} testId="ota-room-types-error" />
          )}
          {!types.data && !types.isError && <Skeleton className="h-9" />}
          {types.data &&
            editing.rows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  value={r.name}
                  fullWidth={false}
                  placeholder="渠道上的房型名（照订单表写）"
                  className="h-9 w-56"
                  onChange={(e) => setEditing({ ...editing, rows: editing.rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                  aria-label={`渠道房型 ${i + 1}`}
                />
                <Select
                  value={r.roomTypeId}
                  fullWidth={false}
                  className="h-9 w-44"
                  onChange={(e) => setEditing({ ...editing, rows: editing.rows.map((x, j) => (j === i ? { ...x, roomTypeId: Number(e.target.value) || '' } : x)) })}
                  aria-label={`本店房型 ${i + 1}`}
                >
                  <option value="">选本店房型</option>
                  {roomTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                <IconButton label="删掉" onClick={() => setEditing({ ...editing, rows: editing.rows.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            ))}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" />}
              disabled={!types.data}
              onClick={() => setEditing({ ...editing, rows: [...editing.rows, { name: '', roomTypeId: '' }] })}
            >
              加一条对照
            </Button>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
              取消
            </Button>
            <Button size="sm" variant="primary" loading={busy} disabled={!(editing.name ?? '').trim()} onClick={() => void save()} data-testid="oc-save">
              保存
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
