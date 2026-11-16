// 库存「调拨」（8.0.22，docs/MULTISTORE_V8022.md 第 8 节）：门店之间调货。
//   · 新建：调出仓、调入仓（不同门店的仓）、物料与数量 → 调出仓马上扣减、记在途；
//   · 调入：按实收登记，少了的写原因（短少、损坏）；在途的可以撤回（原数退回调出仓）。
// 新建走「结果待确认」：提交前本机先存原请求，断网、超时后原样重提或确认作废（与别的 ERP 单据一样）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { STOCK_TRANSFER_STATUS_LABELS, type StockTransfer, type StockTransferStatus } from '@shared/inventory';
import { formatQty, parseQty } from '@shared/quantity';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, uuid } from '../../lib/utils';
import { sendErpOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Badge, Button, Card, Field, Input, Segmented, Select, Skeleton } from '../../components/ui';
import { useMaterials, useWarehouses } from './queries';

const TONE: Record<StockTransferStatus, 'yuzu' | 'pine' | 'neutral'> = { in_transit: 'yuzu', received: 'pine', cancelled: 'neutral' };

export function TransfersTab() {
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | StockTransferStatus>('in_transit');
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<StockTransfer | null>(null);
  const [cancelling, setCancelling] = useState<StockTransfer | null>(null);
  const list = useQuery({
    queryKey: ['inv', 'transfers', status],
    queryFn: () => api.get<StockTransfer[]>(`/api/inventory/transfers${status === 'all' ? '' : `?status=${status}`}`),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inv'] });
  };
  const operate = can('inventory.operate');
  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-5 md:px-7">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          value={status}
          onChange={setStatus}
          ariaLabel="按状态看"
          options={[
            { value: 'in_transit', label: '在途' },
            { value: 'received', label: '已调入' },
            { value: 'cancelled', label: '已撤回' },
            { value: 'all', label: '全部' },
          ]}
        />
        <p className="flex-1 text-[13px] text-ink-3">门店之间调货：调出时调出仓马上扣减、记在途，调入时按实收入库；同一家店里的仓之间请用领料、退回。</p>
        {operate && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="transfer-new">
            新建调拨
          </Button>
        )}
      </div>
      <ErpPendingPanel types={['stock_transfer']} onFound={refresh} />
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError && !list.data ? (
        <LoadFailed title="调拨单取不回来，请检查网络" onRetry={() => void list.refetch()} retrying={list.isFetching} testId="transfers-error" />
      ) : list.data.length === 0 ? (
        <p className="py-10 text-center text-[14px] text-ink-3" data-testid="transfers-empty">
          没有{status === 'all' ? '' : STOCK_TRANSFER_STATUS_LABELS[status]}的调拨单
        </p>
      ) : (
        <div className="grid gap-3">
          {list.data.map((t) => (
            <Card key={t.id} className="p-4" data-testid={`transfer-${t.transferNo}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="num text-[15px] font-bold">{t.transferNo}</span>
                <Badge tone={TONE[t.status]}>{STOCK_TRANSFER_STATUS_LABELS[t.status]}</Badge>
                <span className="flex items-center gap-1.5 text-[14px] text-ink-2">
                  {t.fromName} <ArrowRight className="size-4 text-ink-3" /> {t.toName}
                </span>
                <span className="ml-auto text-[12.5px] text-ink-3">
                  {t.sentByName} {formatDateTime(t.sentAt)} 调出
                  {t.receivedAt && ` · ${t.receivedByName} ${formatDateTime(t.receivedAt)} 调入`}
                  {t.cancelledAt && ` · ${t.cancelledByName} ${formatDateTime(t.cancelledAt)} 撤回（${t.cancelReason}）`}
                </span>
              </div>
              <ul className="mt-2 grid gap-1 text-[13.5px]">
                {t.lines.map((l) => (
                  <li key={l.materialId} className="flex flex-wrap gap-x-3">
                    <span className="num text-ink-3">{l.code}</span>
                    <span>{l.name}</span>
                    <span className="num">
                      调出 {formatQty(l.qtyMilli)} {l.inventoryUnit}
                    </span>
                    {l.receivedMilli !== null && (
                      <span className={l.receivedMilli < l.qtyMilli ? 'num font-semibold text-clay' : 'num text-pine'}>
                        实收 {formatQty(l.receivedMilli)} {l.inventoryUnit}
                        {l.varianceReason && `（${l.varianceReason}）`}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {t.note && <p className="mt-1 text-[13px] text-ink-3">备注：{t.note}</p>}
              {t.status === 'in_transit' && operate && (
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => setReceiving(t)} data-testid={`transfer-receive-${t.transferNo}`}>
                    调入
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(t)} data-testid={`transfer-cancel-${t.transferNo}`}>
                    撤回
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} onDone={refresh} />}
      {receiving && <ReceiveDialog transfer={receiving} onClose={() => setReceiving(null)} onDone={refresh} />}
      {cancelling && <CancelDialog transfer={cancelling} onClose={() => setCancelling(null)} onDone={refresh} />}
    </div>
  );
}

interface Draft {
  materialId: number | null;
  qty: string;
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const session = useSession();
  const warehouses = useWarehouses();
  const materials = useMaterials();
  const [from, setFrom] = useState<number | null>(1);
  const [to, setTo] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Draft[]>([{ materialId: null, qty: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const whs = (warehouses.data ?? []).filter((w) => w.active);
  const fromStore = whs.find((w) => w.id === from)?.storeId;
  const mats = (materials.data ?? []).filter((m) => m.active && m.tracked);
  const parsed = lines.map((l) => {
    const m = mats.find((x) => x.id === l.materialId);
    const milli = m ? parseQty(l.qty, m.decimals) : null;
    return { m, milli };
  });
  const valid = from !== null && to !== null && from !== to && parsed.length > 0 && parsed.every((p) => p.m && p.milli !== null && p.milli > 0);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const body = {
        fromWarehouseId: from!,
        toWarehouseId: to!,
        note,
        lines: parsed.map((p) => ({ materialId: p.m!.id, qtyMilli: p.milli! })),
      };
      const key = uuid();
      const fromName = whs.find((w) => w.id === from)?.name ?? '';
      const toName = whs.find((w) => w.id === to)?.name ?? '';
      const r = await sendErpOp<StockTransfer>({
        key,
        type: 'stock_transfer',
        url: '/api/inventory/transfers',
        body: { clientKey: key, ...body },
        summary: `调拨 ${fromName} → ${toName} · ${parsed.length} 样`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: `已调出（${r.transferNo}），在途` });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      width="max-w-2xl"
      onClose={busy ? () => {} : onClose}
      title="新建调拨"
      description="调出仓马上扣减、记在途；到了以后在调入方按实收登记。"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()} data-testid="transfer-submit">
            调出
          </Button>
        </>
      }
    >
      {warehouses.isError && !warehouses.data ? (
        <LoadFailed title="仓库取不回来" onRetry={() => void warehouses.refetch()} retrying={warehouses.isFetching} />
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="调出仓">
              <Select value={from ?? ''} onChange={(e) => setFrom(Number(e.target.value) || null)} data-testid="transfer-from">
                {whs.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.storeName} · {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="调入仓" hint="别家门店的仓">
              <Select value={to ?? ''} onChange={(e) => setTo(Number(e.target.value) || null)} data-testid="transfer-to">
                <option value="">请选择</option>
                {whs
                  .filter((w) => w.storeId !== fromStore)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.storeName} · {w.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          {lines.map((l, i) => {
            const m = parsed[i]!.m;
            return (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_140px_36px] items-end gap-2">
                <Field label={i === 0 ? '物料' : undefined}>
                  <Select
                    value={l.materialId ?? ''}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, materialId: Number(e.target.value) || null } : x)))}
                    data-testid={`transfer-material-${i}`}
                  >
                    <option value="">请选择</option>
                    {mats.map((x) => (
                      <option key={x.id} value={x.id} disabled={lines.some((o, j) => j !== i && o.materialId === x.id)}>
                        {x.code} {x.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={i === 0 ? '数量' : undefined}>
                  <Input
                    inputMode="decimal"
                    value={l.qty}
                    placeholder={m ? m.inventoryUnit : ''}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                    data-testid={`transfer-qty-${i}`}
                  />
                </Field>
                <Button size="sm" variant="ghost" aria-label="删掉这一行" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            );
          })}
          <div>
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setLines((ls) => [...ls, { materialId: null, qty: '' }])}>
              加一样物料
            </Button>
          </div>
          <Field label="备注">
            <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {error && (
            <p className="text-[13.5px] text-clay" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function ReceiveDialog({ transfer, onClose, onDone }: { transfer: StockTransfer; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState(transfer.lines.map((l) => ({ materialId: l.materialId, qty: formatQty(l.qtyMilli), reason: '' })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const parsed = transfer.lines.map((l, i) => ({ l, milli: parseQty(rows[i]!.qty, l.decimals), reason: rows[i]!.reason.trim() }));
  const valid = parsed.every((p) => p.milli !== null && p.milli >= 0 && p.milli <= p.l.qtyMilli && (p.milli === p.l.qtyMilli || p.reason.length >= 2));
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/inventory/transfers/${transfer.id}/receive`, {
        expectedVersion: transfer.version,
        lines: parsed.map((p) => ({ materialId: p.l.materialId, receivedMilli: p.milli!, varianceReason: p.reason })),
      });
      toast({ tone: 'success', title: `${transfer.transferNo} 已调入` });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      width="max-w-2xl"
      onClose={busy ? () => {} : onClose}
      title={`调入 ${transfer.transferNo}`}
      description={`${transfer.fromName} → ${transfer.toName}：按实际收到的填；少了的写原因（短少、损坏），少的部分不再回到哪个仓。`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()} data-testid="transfer-receive-submit">
            确认调入
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {parsed.map((p, i) => (
          <div key={p.l.materialId} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-[minmax(0,1fr)_120px]">
            <p className="text-[14px]">
              <span className="num mr-2 text-ink-3">{p.l.code}</span>
              {p.l.name}
              <span className="num ml-2 text-ink-3">
                调出 {formatQty(p.l.qtyMilli)} {p.l.inventoryUnit}
              </span>
            </p>
            <Input
              inputMode="decimal"
              value={rows[i]!.qty}
              onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, qty: e.target.value } : r)))}
              aria-label={`${p.l.name}实收`}
              data-testid={`transfer-received-${i}`}
            />
            {p.milli !== null && p.milli < p.l.qtyMilli && (
              <Input
                className="sm:col-span-2"
                placeholder="少了的原因（短少、损坏……）"
                value={rows[i]!.reason}
                maxLength={200}
                onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, reason: e.target.value } : r)))}
                data-testid={`transfer-reason-${i}`}
              />
            )}
          </div>
        ))}
        {error && (
          <p className="text-[13.5px] text-clay" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function CancelDialog({ transfer, onClose, onDone }: { transfer: StockTransfer; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/inventory/transfers/${transfer.id}/cancel`, { expectedVersion: transfer.version, reason });
      toast({ tone: 'success', title: `${transfer.transferNo} 已撤回，原数退回${transfer.fromName}` });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`撤回 ${transfer.transferNo}`}
      description={`在途的整单撤回，原数退回${transfer.fromName}。`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 2} onClick={() => void submit()} data-testid="transfer-cancel-submit">
            撤回
          </Button>
        </>
      }
    >
      <Field label="原因">
        <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="transfer-cancel-reason" />
      </Field>
      {error && (
        <p className="mt-3 text-[13.5px] text-clay" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
