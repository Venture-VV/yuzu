import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ban, CircleCheck, CornerUpLeft, Pencil, RotateCcw, Send, Truck, Undo2, X } from 'lucide-react';
import { COUNT_REASON_LABELS, COUNT_REASONS, INV_DOC_META, type CountReason, type InvDoc } from '@shared/inventory';
import { formatQty } from '@shared/quantity';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Dialog, Sheet } from '../../components/Overlay';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, IconButton, Notice, Select, Spinner, Textarea } from '../../components/ui';
import { DOC_VISUAL, DocTypeChip, PackHint, Qty, SimRule, StatusChip } from './parts';
import { useInvDoc, useInvalidateInventory } from './queries';

const ACTION_LABELS: Record<InvDoc['approvals'][number]['action'], string> = {
  create: '创建',
  submit: '提交',
  approve: '确认生效',
  return: '退回修改',
  cancel: '撤回',
  void: '冲销',
  close: '关闭',
  revise: '修改版本',
};

/** 单据详情抽屉：明细、审批记录、关联单据，以及按状态与职责可做的操作 */
export function DocSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const doc = useInvDoc(id);
  return (
    <Sheet open={!!id} onClose={onClose} label="库存单据详情" width="w-[min(620px,100vw)]">
      {doc.error ? (
        <div className="p-5">
          <Notice tone="error" title={errorMessage(doc.error)} />
        </div>
      ) : !doc.data ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <DocBody doc={doc.data} onClose={onClose} />
      )}
    </Sheet>
  );
}

type Pending = { kind: 'return' | 'cancel' | 'void' } | null;

function DocBody({ doc, onClose }: { doc: InvDoc; onClose: () => void }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateInventory();
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Pending>(null);
  const [reasons, setReasons] = useState<Record<number, CountReason>>({});
  useEffect(() => setReasons({}), [doc.id]);

  const meta = INV_DOC_META[doc.docType];
  const visual = DOC_VISUAL[doc.docType];
  const Icon = visual.icon;
  const operatePerm = doc.docType === 'supplier_return' ? 'supplierReturn.create' : 'inventory.operate';
  const canOperate = can(operatePerm);
  const canApprove = can('inventory.approve');
  const isMine = doc.createdBy === session.staff.id;
  const editable = (doc.status === 'draft' || doc.status === 'returned') && canOperate;

  const run = async (key: string, url: string, body: unknown, success: string) => {
    setBusy(key);
    try {
      await api.post(url, body);
      await invalidate();
      toast({ tone: 'success', title: success, body: doc.docNo });
      setDialog(null);
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      await invalidate();
    } finally {
      setBusy(null);
    }
  };

  const diffLines = doc.docType === 'count' ? doc.lines.filter((l) => l.qtyMilli !== 0) : [];

  return (
    <>
      <header className="flex items-start gap-3 border-b border-line bg-card px-5 py-4">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', visual.tone)}>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-ink-3">{meta.title}</p>
          <p className="num text-[18px] font-bold">{doc.docNo}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusChip status={doc.status} />
            {doc.noPo && doc.docType === 'receipt' && <Badge tone="ember">缺少采购依据</Badge>}
            {doc.isSynthetic && <Badge tone="ember">合成演示</Badge>}
          </div>
        </div>
        <IconButton label="关闭" onClick={onClose} className="-mr-2">
          <X className="size-[18px]" />
        </IconButton>
      </header>

      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {doc.status === 'returned' && doc.returnedReason && (
          <Notice tone="warning" title="负责人退回修改">
            {doc.returnedReason}
          </Notice>
        )}
        {doc.status === 'cancelled' && <Notice tone="info" title="已撤回，没有影响库存">{doc.returnedReason}</Notice>}
        {doc.status === 'voided' && (
          <Notice tone="error" title={`已冲销 · ${doc.voidedByName ?? ''} ${doc.voidedAt ? formatDateTime(doc.voidedAt) : ''}`}>
            {doc.voidReason}。原单内容保留，库存已按原流水反向记回。
          </Notice>
        )}
        {doc.status === 'submitted' && (
          <Notice tone="warning" title="待负责人确认，确认前不影响库存">
            {doc.docType === 'count' ? '盘点差异目前是「待核差异」，不是已认定的浪费或损失。' : '审批安排为模拟规则，待店主确认。'}
          </Notice>
        )}

        <dl className="grid grid-cols-2 gap-x-5 gap-y-2.5 rounded-lg border border-line bg-card px-4 py-3.5 text-[13px]">
          <Info label="单据日期">
            <span className="num">{doc.docDate}</span>
          </Info>
          {doc.supplier && <Info label="供应商">{doc.supplier.name}</Info>}
          {doc.department && <Info label={doc.docType === 'issue_return' ? '退回部门' : '领用部门'}>{doc.department.name}</Info>}
          {doc.handler && <Info label={doc.docType === 'receipt' ? '收货人' : doc.docType === 'issue' ? '领用人' : '经办人'}>{doc.handler}</Info>}
          {doc.sourceDoc && (
            <Info label="原单">
              <Link to={`/inventory/docs?doc=${doc.sourceDoc.id}`} className="num font-semibold text-pine hover:underline">
                {doc.sourceDoc.docNo}
              </Link>
            </Info>
          )}
          {doc.purchaseOrder && <Info label="采购单">{doc.purchaseOrder.docNo}</Info>}
          {doc.note && (
            <Info label={doc.docType === 'direct_use' ? '用途' : doc.docType === 'damage' || doc.docType === 'supplier_return' ? '原因' : '备注'} wide>
              {doc.note}
            </Info>
          )}
          <Info label="创建">
            {doc.createdByName} · {formatDateTime(doc.createdAt)}
          </Info>
          {doc.confirmedAt && (
            <Info label="生效">
              {doc.confirmedByName} · {formatDateTime(doc.confirmedAt)}
            </Info>
          )}
        </dl>

        <section>
          <h3 className="mb-2 text-[13px] font-bold text-ink-2">明细 · {doc.lines.length} 行</h3>
          <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card">
            {doc.lines.map((l) => (
              <li key={l.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] leading-snug font-bold">{l.materialName}</p>
                    <p className="truncate text-[12px] text-ink-3">
                      <span className="num">{l.materialCode}</span>
                      {l.specification && ` · ${l.specification}`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {doc.docType === 'count' ? (
                      <Qty milli={l.qtyMilli} unit={l.inventoryUnit} signed className={cn('text-[16px] font-bold', l.qtyMilli < 0 ? 'text-clay' : l.qtyMilli > 0 ? 'text-lake' : 'text-pine')} />
                    ) : (
                      <Qty milli={l.qtyMilli} unit={l.inventoryUnit} className="text-[16px] font-bold" />
                    )}
                    {doc.docType !== 'count' && (
                      <span className="block">
                        {l.enteredUnit && l.enteredUnit !== l.inventoryUnit && l.enteredQtyMilli !== null ? (
                          <span className="num text-[11.5px] text-ink-3">
                            录入 {formatQty(l.enteredQtyMilli)} {l.enteredUnit}
                          </span>
                        ) : (
                          <PackHint milli={l.qtyMilli} factorMilli={l.factorMilli} purchaseUnit={l.purchaseUnit} inventoryUnit={l.inventoryUnit} />
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {doc.docType === 'receipt' && (
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-paper-2/60 px-3 py-2 text-[12.5px] sm:grid-cols-4">
                    <Mini label="送达">
                      <Qty milli={l.deliveredMilli ?? 0} unit={l.inventoryUnit} />
                    </Mini>
                    <Mini label="合格实收">
                      <Qty milli={l.qtyMilli} unit={l.inventoryUnit} className="font-bold text-pine" />
                    </Mini>
                    <Mini label="拒收">
                      {l.rejectedMilli ? <Qty milli={l.rejectedMilli} unit={l.inventoryUnit} className="font-bold text-clay" /> : '—'}
                    </Mini>
                    <Mini label={`单价/${l.purchaseUnit}`}>{l.priceCents !== null ? <Money cents={l.priceCents} /> : '—'}</Mini>
                    {l.rejectReason && <p className="col-span-full text-clay">拒收原因：{l.rejectReason}（不入库、不计货款）</p>}
                    <p className="col-span-full text-ink-3">
                      1 {l.purchaseUnit} = {formatQty(l.factorMilli)} {l.inventoryUnit} · 金额 <Money cents={l.amountCents ?? 0} className="font-bold text-ink" />
                      {l.returnedMilli > 0 && (
                        <>
                          {' '}
                          · 已退货 <Qty milli={l.returnedMilli} unit={l.inventoryUnit} />
                        </>
                      )}
                    </p>
                  </div>
                )}

                {doc.docType === 'count' && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-paper-2/60 px-3 py-2 text-[12.5px]">
                    <Mini label="账面">
                      <Qty milli={l.bookMilli ?? 0} unit={l.inventoryUnit} />
                    </Mini>
                    <Mini label="实盘">
                      <Qty milli={l.countedMilli ?? 0} unit={l.inventoryUnit} className="font-bold" />
                    </Mini>
                    {l.qtyMilli !== 0 &&
                      (doc.status === 'submitted' && canApprove ? (
                        <label className="ml-auto flex items-center gap-2">
                          <span className="font-semibold text-ink-3">确认原因</span>
                          <Select
                            fullWidth={false}
                            value={reasons[l.id] ?? 'unknown'}
                            onChange={(e) => setReasons((r) => ({ ...r, [l.id]: e.target.value as CountReason }))}
                            className="h-8 text-[12.5px]"
                            aria-label={`${l.materialName}差异原因`}
                          >
                            {COUNT_REASONS.map((r) => (
                              <option key={r} value={r}>
                                {COUNT_REASON_LABELS[r]}
                              </option>
                            ))}
                          </Select>
                        </label>
                      ) : (
                        <Badge tone={l.diffReason ? 'lake' : 'yuzu'} className="ml-auto">
                          {COUNT_REASON_LABELS[l.diffReason ?? 'pending']}
                        </Badge>
                      ))}
                    {l.stale && <p className="w-full font-semibold text-clay">盘点后这项物料又有收发，需重新核对账面</p>}
                  </div>
                )}

                {(doc.docType === 'issue' || doc.docType === 'supplier_return' || doc.docType === 'issue_return') && (l.returnedMilli > 0 || l.amountCents) ? (
                  <p className="mt-1 text-[12px] text-ink-3">
                    {doc.docType === 'issue' && l.returnedMilli > 0 && (
                      <>
                        已退回 <Qty milli={l.returnedMilli} unit={l.inventoryUnit} />
                      </>
                    )}
                    {doc.docType === 'supplier_return' && l.amountCents !== null && (
                      <>
                        扣款 <Money cents={l.amountCents} className="font-semibold text-clay" />（按原收货价 <Money cents={l.priceCents ?? 0} />/{l.purchaseUnit}）
                      </>
                    )}
                  </p>
                ) : null}
                {l.note && <p className="mt-1 text-[12px] text-ink-3">备注：{l.note}</p>}
              </li>
            ))}
          </ul>
          {(doc.docType === 'receipt' || doc.docType === 'supplier_return') && (
            <div className="mt-2 flex items-baseline justify-end gap-2 px-1">
              <span className="text-[12.5px] font-semibold text-ink-3">{doc.docType === 'receipt' ? '确认货款' : '退货扣款'}</span>
              <Money cents={doc.amountCents} className={cn('text-[20px] font-bold', doc.docType === 'receipt' ? 'text-pine' : 'text-clay')} />
            </div>
          )}
        </section>

        {doc.children.length > 0 && (
          <section>
            <h3 className="mb-2 text-[13px] font-bold text-ink-2">后续单据</h3>
            <ul className="space-y-1.5">
              {doc.children.map((c) => (
                <li key={c.id}>
                  <Link to={`/inventory/docs?doc=${c.id}`} className="flex items-center gap-2 rounded-md border border-line bg-card px-3 py-2 text-[13px] hover:border-line-strong">
                    <DocTypeChip type={c.docType} />
                    <span className="num font-semibold">{c.docNo}</span>
                    <span className="flex-1" />
                    <StatusChip status={c.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="mb-2 text-[13px] font-bold text-ink-2">经办记录</h3>
          <ol className="space-y-2 border-l-2 border-line pl-4">
            {doc.approvals.map((a) => (
              <li key={a.id} className="relative text-[12.5px]">
                <span className={cn('absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-2 ring-paper', a.action === 'approve' ? 'bg-pine' : a.action === 'return' || a.action === 'void' ? 'bg-clay' : 'bg-ink-4')} />
                <span className="font-bold">{ACTION_LABELS[a.action]}</span>
                <span className="text-ink-2"> · {a.actorName}</span>
                <span className="num text-ink-3"> · {formatDateTime(a.createdAt)}</span>
                {a.reason && <p className="text-ink-2">{a.reason}</p>}
              </li>
            ))}
          </ol>
        </section>

        {doc.status === 'confirmed' && !doc.voidable.ok && canApprove && <p className="text-[12.5px] text-ink-3">不能冲销：{doc.voidable.reason}</p>}
      </div>

      {/* 操作 */}
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-card px-5 py-3.5">
        {doc.status === 'confirmed' && doc.docType === 'issue' && can('inventory.operate') && (
          <Button variant="secondary" size="sm" icon={<Undo2 className="size-4" />} onClick={() => navigate(`/inventory/new/issue_return?src=${doc.id}`)}>
            领用退回
          </Button>
        )}
        {doc.status === 'confirmed' && doc.docType === 'receipt' && can('supplierReturn.create') && (
          <Button variant="secondary" size="sm" icon={<Truck className="size-4" />} onClick={() => navigate(`/inventory/new/supplier_return?src=${doc.id}`)}>
            退供应商
          </Button>
        )}
        {doc.status === 'confirmed' && canApprove && doc.voidable.ok && (
          <Button variant="ghost" size="sm" icon={<RotateCcw className="size-4" />} onClick={() => setDialog({ kind: 'void' })} className="text-clay hover:bg-clay-soft/60 hover:text-clay">
            冲销
          </Button>
        )}
        {['draft', 'submitted', 'returned'].includes(doc.status) && (canApprove || (canOperate && isMine)) && (
          <Button variant="ghost" size="sm" icon={<Ban className="size-4" />} onClick={() => setDialog({ kind: 'cancel' })}>
            撤回
          </Button>
        )}
        {editable && (
          <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => navigate(`/inventory/docs/${doc.id}/edit`)}>
            修改
          </Button>
        )}
        {editable && (
          <Button variant="primary" loading={busy === 'submit'} icon={<Send className="size-4" />} onClick={() => run('submit', `/api/inventory/docs/${doc.id}/submit`, {}, '已提交')}>
            提交
          </Button>
        )}
        {doc.status === 'submitted' && canApprove && (
          <>
            <Button variant="secondary" icon={<CornerUpLeft className="size-4" />} onClick={() => setDialog({ kind: 'return' })}>
              退回修改
            </Button>
            <Button
              variant="primary"
              loading={busy === 'approve'}
              icon={<CircleCheck className="size-4" />}
              onClick={() =>
                run(
                  'approve',
                  `/api/inventory/docs/${doc.id}/approve`,
                  { countReasons: Object.fromEntries(diffLines.map((l) => [String(l.id), reasons[l.id] ?? 'unknown'])) },
                  doc.docType === 'count' ? '盘点调整已确认' : '已确认生效',
                )
              }
            >
              {doc.docType === 'count' ? '确认盘点调整' : '确认生效'}
            </Button>
          </>
        )}
      </footer>

      <ReasonDialog
        open={!!dialog}
        kind={dialog?.kind ?? 'cancel'}
        doc={doc}
        busy={!!busy}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => {
          const kind = dialog!.kind;
          void run(kind, `/api/inventory/docs/${doc.id}/${kind}`, { reason }, kind === 'void' ? '已冲销' : kind === 'return' ? '已退回修改' : '已撤回');
        }}
      />
    </>
  );
}

function ReasonDialog({
  open,
  kind,
  doc,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  kind: 'return' | 'cancel' | 'void';
  doc: InvDoc;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const title = kind === 'void' ? `冲销 ${doc.docNo}` : kind === 'return' ? `退回修改 ${doc.docNo}` : `撤回 ${doc.docNo}`;
  const description =
    kind === 'void'
      ? '冲销会按原流水反向记账：原单保留并标记「已冲销」，库存与货款恢复到这张单之前。'
      : kind === 'return'
        ? '退回后经办人可以修改再提交；退回不影响库存。'
        : '撤回未生效的单据，不影响库存。';
  const ok = reason.trim().length >= 2;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant={kind === 'void' ? 'danger' : 'primary'} disabled={!ok} loading={busy} onClick={() => onConfirm(reason.trim())}>
            {kind === 'void' ? '确认冲销' : kind === 'return' ? '退回修改' : '确认撤回'}
          </Button>
        </>
      }
    >
      <Field label={kind === 'return' ? '需要修改什么' : '原因'} htmlFor="reason" hint="至少 2 个字，会记在单据的经办记录里">
        <Textarea id="reason" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </Field>
      {kind === 'void' && (
        <p className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-3">
          冲销权限与范围 <SimRule />
        </p>
      )}
    </Dialog>
  );
}

function Info({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <dt className="text-[11.5px] font-semibold text-ink-3">{label}</dt>
      <dd className="truncate font-semibold text-ink">{children}</dd>
    </div>
  );
}

function Mini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-ink-3">{label}</span>
      <span className="num">{children}</span>
    </span>
  );
}
