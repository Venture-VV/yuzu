import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ban, CircleCheck, CornerUpLeft, FilePen, Lock, PackagePlus, Pencil, Send, X } from 'lucide-react';
import { INV_STATUS_LABELS } from '@shared/inventory';
import type { PurchaseOrder } from '@shared/purchasing';
import { formatQty } from '@shared/quantity';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { ImageThumbs } from '../../components/Images';
import { Money } from '../../components/Money';
import { Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, IconButton, Notice, Spinner } from '../../components/ui';
import { Qty, SimRule } from '../inventory/parts';
import { CompareChip, PoStatusChip, ReceivingChip } from './parts';
import { useInvalidateAll, usePo } from './queries';

const ACTION_LABELS: Record<PurchaseOrder['approvals'][number]['action'], string> = {
  create: '创建',
  submit: '提交',
  approve: '确认',
  return: '退回修改',
  cancel: '撤回',
  void: '冲销',
  close: '关闭',
  revise: '改版',
  sign: '签收',
  supplier_agree: '供应商已同意',
  supplier_reject: '供应商不同意',
};

export function PoSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const po = usePo(id);
  return (
    <Sheet open={!!id} onClose={onClose} label="采购单详情" width="w-[min(660px,100vw)]">
      {po.error ? (
        <Notice tone="error" title={errorMessage(po.error)} className="m-5" />
      ) : !po.data ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <PoBody po={po.data} onClose={onClose} />
      )}
    </Sheet>
  );
}

type Pending = 'return' | 'cancel' | 'close' | null;

function PoBody({ po, onClose }: { po: PurchaseOrder; onClose: () => void }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateAll();
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Pending>(null);
  const canManage = can('purchase.manage');
  const canApprove = can('inventory.approve');
  const editable = (po.status === 'draft' || po.status === 'returned') && canManage && !po.backfill;

  const run = async (key: string, path: string, body: unknown, success: string) => {
    setBusy(key);
    try {
      await api.post(`/api/purchase-orders/${po.id}/${path}`, body);
      await invalidate();
      toast({ tone: 'success', title: success, body: po.docNo });
      setDialog(null);
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      await invalidate();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <header className="flex items-start gap-3 border-b border-line bg-card px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-ink-3">
            采购单{po.revision > 1 && ` · 第 ${po.revision} 版`}
          </p>
          <p className="num text-[18px] font-bold">{po.docNo}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <PoStatusChip status={po.status} />
            {(po.status === 'approved' || po.status === 'closed') && <ReceivingChip state={po.receiving} />}
            {po.backfill && <Badge tone="ember">补单</Badge>}
            {po.isSynthetic && <Badge tone="ember">合成演示</Badge>}
          </div>
        </div>
        <IconButton label="关闭" onClick={onClose} className="-mr-2">
          <X className="size-[18px]" />
        </IconButton>
      </header>

      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {po.status === 'returned' && po.returnedReason && <Notice tone="warning" title="负责人退回修改">{po.returnedReason}</Notice>}
        {po.status === 'submitted' && (
          <Notice tone="warning" title={po.revision > 1 ? '改版待确认：确认前不能继续收货' : '待负责人确认：确认前不能收货'}>
            采购审批安排为模拟规则 <SimRule className="align-middle" />
          </Notice>
        )}
        {po.status === 'closed' && (
          <Notice tone="info" title={`已关闭 · ${po.closedByName ?? ''} ${po.closedAt ? formatDateTime(po.closedAt) : ''}`}>
            {po.closeReason}。剩余未到的数量不再收货，已收货与货款不受影响。
          </Notice>
        )}
        {po.backfill && po.backfillReceipt && (
          <Notice tone="info" title="先收货后补单">
            原收货单{' '}
            <Link to={`/inventory/docs?doc=${po.backfillReceipt.id}`} className="num font-semibold text-pine hover:underline">
              {po.backfillReceipt.docNo}
            </Link>{' '}
            已入库并计入货款；本单确认后只建立关联，不再入库或形成应付。
          </Notice>
        )}

        {/* 下单、收货、付款分别展示 */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MoneyTile label="下单金额" cents={po.totalCents} hint="采购承诺" />
          <MoneyTile label="已确认收货" cents={po.receivedCents} tone="pine" hint="合格实收 × 单价" />
          <MoneyTile label="已登记付款" cents={po.paidCents} tone="lake" hint={po.returnCreditCents ? `另有退货抵扣 ¥${(po.returnCreditCents / 100).toFixed(2)}` : '含核销到本单收货的'} />
          <MoneyTile
            label="本单未付"
            cents={po.unpaidCents}
            tone={po.unpaidCents < 0 ? 'clay' : 'ink'}
            hint={po.returnBalanceCents > 0 ? `另有退货余额 ¥${(po.returnBalanceCents / 100).toFixed(2)}（在货款的可抵扣里）` : '收货 − 退货抵扣 − 已付'}
          />
        </div>

        <dl className="grid grid-cols-2 gap-x-5 gap-y-2.5 rounded-lg border border-line bg-card px-4 py-3.5 text-[13px] sm:grid-cols-3">
          <Info label="供应商">{po.supplier.name}</Info>
          <Info label="下单日期">
            <span className="num">{po.orderDate}</span>
          </Info>
          <Info label="预计到货">
            <span className="num">{po.expectedDate ?? '—'}</span>
          </Info>
          <Info label="价格口径">{po.priceBasis || '—'}</Info>
          <Info label="编制">{po.createdByName}</Info>
          <Info label="确认">{po.approvedByName ? `${po.approvedByName} · ${formatDateTime(po.approvedAt!)}` : '—'}</Info>
          {po.note && (
            <Info label="备注" wide>
              {po.note}
            </Info>
          )}
        </dl>

        <section>
          <h3 className="mb-2 text-[13px] font-bold text-ink-2">明细 · {po.lines.length} 行</h3>
          <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card">
            {po.lines.map((l) => {
              const ratio = Math.min(1, l.receivedMilli / l.baseQtyMilli);
              return (
                <li key={l.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] leading-snug font-bold">{l.materialName}</p>
                      <p className="truncate text-[12px] text-ink-3">
                        <span className="num">{l.materialCode}</span>
                        {l.specification && ` · ${l.specification}`}
                      </p>
                      {l.spec && <p className="text-[12.5px] font-semibold text-ink-2">规格：{l.spec}</p>}
                    </div>
                    <div className="shrink-0 text-right">
                      <Qty milli={l.purchaseQtyMilli} unit={l.purchaseUnit} className="text-[16px] font-bold" />
                      <p className="num text-[11.5px] text-ink-3">
                        = {formatQty(l.baseQtyMilli)} {l.inventoryUnit}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
                    <span className="num">
                      ¥{(l.priceCents / 100).toFixed(2)}/{l.purchaseUnit} × {formatQty(l.purchaseQtyMilli)} = <Money cents={l.amountCents} className="font-bold" />
                    </span>
                    <CompareChip compare={l.compare} unit={l.purchaseUnit} />
                  </div>
                  <ImageThumbs images={l.images} size={40} className="mt-2" />
                  {l.requests.length > 0 && (
                    <p className="mt-1.5 text-[12px] text-ink-3">
                      需求：
                      {l.requests.map((r, i) => (
                        <span key={r.lineId}>
                          {i > 0 && '、'}
                          <Link to={`/erp/requests?request=${r.requestId}`} className="num font-semibold text-lake hover:underline">
                            {r.requestNo}
                          </Link>{' '}
                          {r.departmentName} {formatQty(r.qtyMilli)} {r.unit}
                        </span>
                      ))}
                    </p>
                  )}
                  {(po.status === 'approved' || po.status === 'closed' || l.receivedMilli > 0) && (
                    <div className="mt-2 flex items-center gap-3">
                      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-paper-3">
                        <span className="absolute inset-y-0 left-0 rounded-full bg-pine" style={{ width: `${ratio * 100}%` }} />
                      </span>
                      <span className="num shrink-0 text-[12px] text-ink-2">
                        已收 {formatQty(l.receivedMilli)} / {formatQty(l.baseQtyMilli)} {l.inventoryUnit}
                        {/* 称重物料按实际称重收货，可以比订购数量多一点（v0.7.13） */}
                        {l.weighed && l.receivedMilli > l.baseQtyMilli && (
                          <span className="ml-1 font-semibold text-lake">
                            · 称重多到 {formatQty(l.receivedMilli - l.baseQtyMilli)} {l.inventoryUnit}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {po.receipts.length > 0 && (
          <section>
            <h3 className="mb-2 text-[13px] font-bold text-ink-2">收货记录</h3>
            <ul className="space-y-1.5">
              {po.receipts.map((r) => (
                <li key={r.id}>
                  <Link to={`/inventory/docs?doc=${r.id}`} className="flex items-center gap-3 rounded-md border border-line bg-card px-3 py-2 text-[13px] hover:border-line-strong">
                    <span className="num font-semibold">{r.docNo}</span>
                    <span className="num text-ink-3">{r.docDate}</span>
                    <span className="flex-1" />
                    <Money cents={r.amountCents} className="font-semibold" />
                    <span className={cn('text-[12px] font-semibold', r.status === 'confirmed' ? 'text-pine' : 'text-ink-3')}>{INV_STATUS_LABELS[r.status]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {po.revisions.length > 0 && (
          <section>
            <h3 className="mb-2 text-[13px] font-bold text-ink-2">历史版本</h3>
            <ul className="space-y-2">
              {po.revisions.map((r) => (
                <li key={r.revision} className="rounded-md border border-dashed border-line-strong bg-paper/60 px-3 py-2 text-[12.5px]">
                  <p className="font-semibold">
                    第 {r.revision} 版 · {r.snapshot.supplierName} · <Money cents={r.snapshot.totalCents} />
                    <span className="font-normal text-ink-3">
                      {' '}
                      · {r.changedByName} 于 {formatDateTime(r.changedAt)} 改版
                    </span>
                  </p>
                  <p className="text-ink-3">
                    {r.snapshot.lines.map((l) => `${l.materialName} ${formatQty(l.purchaseQtyMilli)}${l.purchaseUnit} × ¥${(l.priceCents / 100).toFixed(2)}`).join('；')}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="mb-2 text-[13px] font-bold text-ink-2">经办记录</h3>
          <ol className="space-y-2 border-l-2 border-line pl-4">
            {po.approvals.map((a) => (
              <li key={a.id} className="relative text-[12.5px]">
                <span className={cn('absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-2 ring-paper', a.action === 'approve' ? 'bg-pine' : a.action === 'return' || a.action === 'cancel' ? 'bg-clay' : 'bg-ink-4')} />
                <span className="font-bold">{ACTION_LABELS[a.action]}</span>
                {a.revision && a.revision > 1 && <span className="text-ink-3"> · 第 {a.revision} 版</span>}
                <span className="text-ink-2"> · {a.actorName}</span>
                <span className="num text-ink-3"> · {formatDateTime(a.createdAt)}</span>
                {a.reason && <p className="text-ink-2">{a.reason}</p>}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-card px-5 py-3.5">
        {po.status === 'approved' && !po.backfill && po.receiving !== 'full' && can('inventory.operate') && (
          <Button variant="primary" icon={<PackagePlus className="size-4" />} onClick={() => navigate(`/inventory/new/receipt?po=${po.id}`)}>
            按单收货
          </Button>
        )}
        {po.status === 'approved' && !po.backfill && canManage && (
          <Button variant="secondary" icon={<FilePen className="size-4" />} onClick={() => navigate(`/purchasing/${po.id}/revise`)}>
            改版
          </Button>
        )}
        {po.status === 'approved' && (canManage || canApprove) && (
          <Button variant="ghost" size="sm" icon={<Lock className="size-4" />} onClick={() => setDialog('close')}>
            关闭
          </Button>
        )}
        {['draft', 'submitted', 'returned'].includes(po.status) && po.receipts.length === 0 && (canApprove || (canManage && po.createdBy === session.staff.id)) && (
          <Button variant="ghost" size="sm" icon={<Ban className="size-4" />} onClick={() => setDialog('cancel')}>
            撤回
          </Button>
        )}
        {editable && (
          <>
            <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => navigate(`/purchasing/${po.id}/edit`)}>
              修改
            </Button>
            <Button variant="primary" loading={busy === 'submit'} icon={<Send className="size-4" />} onClick={() => run('submit', 'submit', {}, '已提交')}>
              提交
            </Button>
          </>
        )}
        {po.status === 'submitted' && canApprove && (
          <>
            <Button variant="secondary" icon={<CornerUpLeft className="size-4" />} onClick={() => setDialog('return')}>
              退回修改
            </Button>
            <Button variant="primary" loading={busy === 'approve'} icon={<CircleCheck className="size-4" />} onClick={() => run('approve', 'approve', {}, '采购单已确认')}>
              {po.backfill ? '确认补单' : '确认采购'}
            </Button>
          </>
        )}
      </footer>

      <ReasonDialog
        open={!!dialog}
        busy={!!busy}
        title={`${dialog === 'close' ? '关闭' : dialog === 'return' ? '退回修改' : '撤回'} ${po.docNo}`}
        description={
          dialog === 'close'
            ? '关闭后剩余未到的数量不再收货（例如供应商缺货）；已收货与货款不受影响。'
            : dialog === 'return'
              ? '退回后采购经办可以修改再提交。'
              : '撤回尚未确认的采购单。'
        }
        label={dialog === 'return' ? '需要修改什么' : '原因'}
        confirmLabel={dialog === 'close' ? '确认关闭' : dialog === 'return' ? '退回修改' : '确认撤回'}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => void run(dialog!, dialog!, { reason }, dialog === 'close' ? '采购单已关闭' : dialog === 'return' ? '已退回修改' : '已撤回')}
      />
    </>
  );
}

function MoneyTile({ label, cents, hint, tone = 'ink' }: { label: string; cents: number; hint: string; tone?: 'ink' | 'pine' | 'lake' | 'clay' }) {
  const color = { ink: 'text-ink', pine: 'text-pine', lake: 'text-lake', clay: 'text-clay' }[tone];
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2.5">
      <p className="text-[11.5px] font-semibold text-ink-3">{label}</p>
      <Money cents={cents} className={cn('text-[17px] font-bold', color)} />
      <p className="truncate text-[11px] text-ink-3">{hint}</p>
    </div>
  );
}

function Info({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-full')}>
      <dt className="text-[11.5px] font-semibold text-ink-3">{label}</dt>
      <dd className="truncate font-semibold text-ink">{children}</dd>
    </div>
  );
}
