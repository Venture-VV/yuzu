import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ban, CircleCheck, CircleX, CornerUpLeft, FilePlus2, Handshake, Pencil, RotateCcw, Send, Truck, Undo2, X } from 'lucide-react';
import { COUNT_REASON_LABELS, COUNT_REASONS, INV_DOC_META, type CountReason, type InvDoc } from '@shared/inventory';
import { formatQty } from '@shared/quantity';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { Dialog, Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { ApprovalProgress, ApprovalResend, useApprovalGate } from '../approvals/ApprovalProgress';
import { postDocAction } from '../approvals/uncertain';
import { Money } from '../../components/Money';
import { ReceiptAttachmentsPanel } from '../../components/ReceiptAttachments';
import { useToast } from '../../components/Toast';
import { Badge, Button, IconButton, Notice, Select, Spinner, InfoItem as Info } from '../../components/ui';
import { DOC_VISUAL, DocTypeChip, PackHint, Qty, SimRule, StatusChip } from './parts';
import { CompareChip } from '../purchasing/parts';
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
  sign: '部门签收',
  supplier_agree: '供应商已同意',
  supplier_reject: '供应商不同意',
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

type Pending = { kind: 'return' | 'cancel' | 'void' | 'reject' } | null;

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

  const meta = doc.urgent ? { ...INV_DOC_META[doc.docType], title: '急采收货' } : INV_DOC_META[doc.docType];
  const visual = DOC_VISUAL[doc.docType];
  // v0.7.11：部门小仓的单据（耗用、报损、盘点、期初）由部门在「本部门小仓」登记，这里只看、冲销与确认；
  // 急采 8.0.1 起由采购在「采购 → 急采」登记（CG05），这里能改、提交、撤回
  const deptDoc = doc.warehouse?.kind === 'department' && doc.docType !== 'issue' && doc.docType !== 'issue_return' && !doc.urgent;
  const Icon = visual.icon;
  const operatePerm = doc.urgent ? 'purchase.manage' : doc.docType === 'supplier_return' ? 'supplierReturn.create' : 'inventory.operate';
  const canOperate = can(operatePerm);
  const canApprove = can('inventory.approve');
  // 急采按金额分级审批（8.0.1）：已提交、还没批的在审批中；批了以后等仓库到部门验收
  const urgentPending = doc.urgent && doc.status === 'submitted' && !doc.urgentApprovedAt;
  // 审批中心（v0.7.30）：报损、退供应商、期初、盘点、急采同意的是当前这一级，带上看到的审批单与级别
  const gate = useApprovalGate(doc.urgent && !urgentPending ? null : doc.approval, 'inv_doc');
  const finalLevel = !doc.approval || doc.approval.currentLevel === doc.approval.levels;
  // #21：库存冲销由仓库或财务成本岗，只限当月（v0.7.11）
  const canVoid = can('inventory.void');
  const isMine = doc.createdBy === session.staff.id;
  const editable = (doc.status === 'draft' || doc.status === 'returned') && canOperate && !deptDoc;
  // 急采：批了以后仓库到部门验收确认（#19）；登记的人不能自己验收
  const canVerify = doc.urgent && doc.status === 'submitted' && !urgentPending && (can('inventory.operate') || canApprove) && (!isMine || session.staff.role === 'owner');
  // 能在这里同意、退回的：待确认的单据（急采只在审批中时）
  const approvable = doc.status === 'submitted' && canApprove && (!doc.urgent || urgentPending);
  // 退货等供应商确认（#20，v0.7.12）：采购登记供应商的答复
  const awaiting = doc.status === 'awaiting_supplier';
  const canAnswer = awaiting && can('supplierReturn.answer');
  const [agreeOpen, setAgreeOpen] = useState(false);

  const run = async (key: string, url: string, body: unknown, success: string) => {
    setBusy(key);
    try {
      // 同意、退回带着审批单与级别：没收到结果时记下，之后只能按原内容重新提交（uncertain.ts）
      await postDocAction(url, body, doc.docNo, session.staff.id);
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

  /** 先收货后补单：按本收货单生成补单采购单，确认后只关联、不再入库或计款 */
  const backfill = async () => {
    setBusy('backfill');
    try {
      const r = await api.post<{ po: { id: number; docNo: string } }>('/api/purchase-orders/backfill', { clientKey: uuid(), receiptDocId: doc.id });
      await invalidate();
      toast({
        tone: 'success',
        title: `已生成补单 ${r.po.docNo}`,
        // 急采的补单提交即确认（8.0.1，急采已按金额分级审批过）
        body: doc.urgent ? '急采已经审批过，补单提交即确认、关联这张急采，不会重复入库或计款。' : '负责人确认后关联本收货单，不会重复入库或计款。',
      });
      navigate(`/purchasing?po=${r.po.id}`);
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

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
            {doc.noPo && doc.docType === 'receipt' && !doc.urgent && <Badge tone="ember">缺少采购依据</Badge>}
            {doc.urgent && (
              <Badge tone="yuzu">
                急采 · 上限 <Money cents={doc.urgentCapCents ?? 0} />
              </Badge>
            )}
            {doc.warehouse && <Badge tone={doc.warehouse.kind === 'central' ? 'neutral' : 'lake'}>{doc.warehouse.name}</Badge>}
            {doc.docType === 'issue' && doc.warehouse && doc.status === 'confirmed' && (doc.deptSign ? <Badge tone="pine">部门已签收</Badge> : <Badge tone="yuzu">部门待签收</Badge>)}
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
        {doc.status === 'submitted' &&
          (doc.urgent ? (
            urgentPending ? (
              <Notice tone="warning" title="急采：按金额分级审批中，批了以后仓库到部门验收" data-testid="urgent-pending">
                采购登记的急采（没有采购单），在审批中心按金额由指定的审批人审；批了以后仓库到部门验收，确认后进{doc.warehouse?.name}。审批与验收前都不影响库存与货款。
              </Notice>
            ) : (
              <Notice tone="warning" title="急采：已批准，等仓库到部门验收，确认前不影响库存与货款">
                验收确认后进{doc.warehouse?.name}；合计不超过登记时的上限，确认时按现在的上限再核对一次。
              </Notice>
            )
          ) : (
            <Notice tone="warning" title="待负责人确认，确认前不影响库存">
              {doc.docType === 'count' ? '盘点差异目前是「待核差异」，不是已认定的浪费或损失。' : '审批安排为模拟规则，待店主确认。'}
            </Notice>
          ))}
        {doc.urgent && doc.status === 'confirmed' && !doc.purchaseOrder && (
          <Notice tone="warning" title="急采还没补采购单">由采购在「采购 → 急采」里补采购单，急采已经审批过，补单提交即确认。</Notice>
        )}
        {doc.deptSign && (
          <Notice tone="success" title={`${doc.deptSign.signedByName} 已签收 · ${formatDateTime(doc.deptSign.signedAt)}`}>
            {doc.deptSign.note || '部门签收时没有写差异。'}
          </Notice>
        )}
        {awaiting && (
          <Notice tone="warning" title="等供应商确认：库存、货款都还没动">
            与供应商谈妥后由采购登记「供应商已同意」，才从{doc.warehouse?.name ?? '原收货单的仓'}出库、扣款；供应商不同意就撤回。只同意一部分的，先撤回再按同意的数量重新登记。
          </Notice>
        )}
        {doc.supplierAnswer && (
          <Notice
            tone={doc.supplierAnswer.agreed ? 'success' : 'info'}
            title={`${doc.supplierAnswer.agreed ? `供应商 ${doc.supplierAnswer.date} 同意` : '供应商不同意'} · ${doc.supplierAnswer.byName} 登记于 ${formatDateTime(doc.supplierAnswer.at)}`}
          >
            {doc.supplierAnswer.note || '没有写说明。'}
          </Notice>
        )}
        {doc.returnCredit && doc.amountCents > 0 && (
          <div className="rounded-lg border border-line bg-card px-4 py-3 text-[13px]" data-testid="return-credit">
            <p className="font-bold text-ink-2">退货扣款的去向</p>
            {doc.returnCredit.settlement === 'cash' ? (
              <p className="mt-1 text-ink-3">现付供应商的退货不记应付：退回的钱在「货款 → 对账单 → 可抵扣」登记供应商退款。</p>
            ) : (
              <p className="mt-1 text-ink-3">
                抵原收货单 <Money cents={doc.returnCredit.appliedCents} className="font-semibold text-ink" />；多出来的是退货余额（原收货单已经付过款），在「货款 → 对账单 → 可抵扣」核销到以后的货款或登记供应商退款。
              </p>
            )}
            <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              <span>
                已核销 <Money cents={doc.returnCredit.offsetCents} />
              </span>
              <span>
                已退款 <Money cents={doc.returnCredit.refundedCents} />
              </span>
              <span className="font-bold text-ember">
                还可以抵扣 / 退款 <Money cents={doc.returnCredit.availableCents} />
              </span>
            </p>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-5 gap-y-2.5 rounded-lg border border-line bg-card px-4 py-3.5 text-[13px]">
          <Info label="单据日期">
            <span className="num">{doc.docDate}</span>
          </Info>
          {doc.supplier && <Info label="供应商">{doc.supplier.name}</Info>}
          {doc.department && (
            <Info label={doc.docType === 'issue_return' ? '退回部门' : doc.docType === 'issue' ? '领料部门' : '部门'}>{doc.department.name}</Info>
          )}
          {doc.warehouse && (
            <Info label={doc.docType === 'issue' ? '进' : doc.docType === 'issue_return' ? '从' : '仓'}>
              {doc.warehouse.name}
              {(doc.docType === 'issue' || doc.docType === 'issue_return') && <span className="ml-1 text-[12px] text-ink-3">（另一头是总仓）</span>}
            </Info>
          )}
          {doc.coAcceptor && <Info label="一起验收的采购">{doc.coAcceptor.name}</Info>}
          {doc.docType === 'direct_use' && <Info label="用途">{doc.usePurpose ?? <span className="text-ink-3">（v8.0.7 以前没记）</span>}</Info>}
          {doc.useHandler && <Info label="耗用经办人">{doc.useHandler.name}</Info>}
          {doc.handler && <Info label={doc.docType === 'receipt' ? '收货人' : doc.docType === 'issue' ? '领料人' : '经办人'}>{doc.handler}</Info>}
          {doc.sourceDoc && (
            <Info label="原单">
              <Link to={`/inventory/docs?doc=${doc.sourceDoc.id}`} className="num font-semibold text-pine hover:underline">
                {doc.sourceDoc.docNo}
              </Link>
            </Info>
          )}
          {doc.purchaseOrder && (
            <Info label="采购单">
              <Link to={`/purchasing?po=${doc.purchaseOrder.id}`} className="num font-semibold text-pine hover:underline">
                {doc.purchaseOrder.docNo}
              </Link>
              {doc.noPo && <span className="ml-1 text-[12px] text-ink-3">（补单）</span>}
            </Info>
          )}
          {doc.note && (
            <Info label={doc.docType === 'direct_use' ? '用途' : doc.docType === 'damage' || doc.docType === 'supplier_return' ? '原因' : '备注'} wide>
              {doc.note}
            </Info>
          )}
          <Info label="创建">
            {doc.createdByName} · {formatDateTime(doc.createdAt)}
          </Info>
          {doc.confirmedAt && (
            <Info label={doc.urgent ? '仓库验收' : '生效'}>
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
                    <p className="text-[14px] leading-snug font-bold">
                      {l.materialName}
                      {/* 台面日耗品（v0.7.13）：领到部门（或急采验收）时已自动记为部门耗用 */}
                      {l.autoConsumed && (
                        <Badge tone="lake" className="ml-1.5 align-middle">
                          已记部门耗用
                        </Badge>
                      )}
                    </p>
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
                    {(l.batchNo || l.expiresOn) && (
                      <p className="col-span-full text-ink-3">
                        {l.batchNo ? `批号 ${l.batchNo}` : ''}
                        {l.producedOn ? ` · 生产 ${l.producedOn}` : ''}
                        {l.expiresOn ? ` · 到期 ${l.expiresOn}` : ''}
                      </p>
                    )}
                    {l.compare && (
                      <p className="col-span-full">
                        <CompareChip compare={l.compare} unit={l.purchaseUnit} />
                      </p>
                    )}
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
                      (doc.status === 'submitted' && canApprove && gate.canActHere && !gate.uncertain && finalLevel ? (
                        <label className="ml-auto flex items-center gap-2">
                          <span className="font-semibold text-ink-3">确认原因</span>
                          <Select
                            fullWidth={false}
                            value={reasons[l.id] ?? (l.diffReason && l.diffReason !== 'pending' ? l.diffReason : doc.warehouse?.kind === 'department' ? 'consumed' : 'unknown')}
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
                    {l.diffNote && <p className="w-full text-ink-2">差异说明：{l.diffNote}</p>}
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

        {/* 收货单的附件（8.0.1 采购组整改 11）：仓库、采购都能补传；现付的推送到财务待报销 */}
        {doc.docType === 'receipt' && doc.status !== 'cancelled' && (
          <ReceiptAttachmentsPanel
            docId={doc.id}
            items={doc.attachments ?? []}
            canUpload={doc.status !== 'voided' && (can('inventory.operate') || can('purchase.manage'))}
            onChanged={invalidate}
          />
        )}

        <ApprovalProgress approval={doc.urgent && !doc.approval ? null : doc.approval} />

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

        {doc.status === 'confirmed' && !doc.voidable.ok && canVoid && <p className="text-[12.5px] text-ink-3">不能冲销：{doc.voidable.reason}</p>}
      </div>

      {/* 操作 */}
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-card px-5 py-3.5">
        {doc.status === 'confirmed' && doc.docType === 'issue' && can('inventory.operate') && (
          <Button variant="secondary" size="sm" icon={<Undo2 className="size-4" />} onClick={() => navigate(`/inventory/new/issue_return?src=${doc.id}`)}>
            领料退回
          </Button>
        )}
        {doc.status === 'confirmed' && doc.docType === 'receipt' && doc.noPo && !doc.purchaseOrder && can('purchase.manage') && (
          <Button variant="secondary" size="sm" loading={busy === 'backfill'} icon={<FilePlus2 className="size-4" />} onClick={backfill} data-testid="doc-backfill">
            补采购单
          </Button>
        )}
        {doc.status === 'confirmed' && doc.docType === 'receipt' && can('supplierReturn.create') && (
          <Button variant="secondary" size="sm" icon={<Truck className="size-4" />} onClick={() => navigate(`/inventory/new/supplier_return?src=${doc.id}`)}>
            退供应商
          </Button>
        )}
        {doc.status === 'confirmed' && canVoid && doc.voidable.ok && (
          <Button variant="ghost" size="sm" icon={<RotateCcw className="size-4" />} onClick={() => setDialog({ kind: 'void' })} className="text-clay hover:bg-clay-soft/60 hover:text-clay">
            冲销
          </Button>
        )}
        {['draft', 'submitted', 'returned', 'awaiting_supplier'].includes(doc.status) && !deptDoc && (canApprove || (canOperate && isMine) || canAnswer) && (
          <Button variant="ghost" size="sm" icon={<Ban className="size-4" />} onClick={() => setDialog({ kind: 'cancel' })}>
            撤回
          </Button>
        )}
        {canAnswer && (
          <>
            <Button variant="secondary" icon={<CircleX className="size-4" />} onClick={() => setDialog({ kind: 'reject' })} data-testid="supplier-reject">
              供应商不同意
            </Button>
            <Button variant="primary" icon={<Handshake className="size-4" />} onClick={() => setAgreeOpen(true)} data-testid="supplier-agree">
              供应商已同意
            </Button>
          </>
        )}
        {editable && (
          <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => navigate(doc.urgent ? `/purchasing/urgent/${doc.id}/edit` : `/inventory/docs/${doc.id}/edit`)}>
            修改
          </Button>
        )}
        {editable && (
          <Button variant="primary" loading={busy === 'submit'} icon={<Send className="size-4" />} onClick={() => run('submit', `/api/inventory/docs/${doc.id}/submit`, {}, '已提交')}>
            提交
          </Button>
        )}
        {canVerify && (
          <Button
            variant="primary"
            loading={busy === 'verify'}
            icon={<CircleCheck className="size-4" />}
            onClick={() => run('verify', `/api/inventory/docs/${doc.id}/verify-urgent`, {}, '急采已验收，进部门小仓')}
            data-testid="verify-urgent"
          >
            到部门验收确认
          </Button>
        )}
        {approvable && gate.uncertain && <ApprovalResend sent={gate.uncertain} onDone={invalidate} />}
        {(approvable || urgentPending) && !gate.uncertain && !(approvable && gate.canActHere) && gate.waiting && <span className="text-[12.5px] text-ink-3">{gate.waiting}</span>}
        {/* 急采的审批人不一定有「确认库存单据」：到审批中心里审（审批中心按审批单核对谁能审） */}
        {urgentPending && !canApprove && gate.canActHere && !gate.uncertain && (
          <Link to="/approvals" className="text-[13px] font-bold text-lake hover:underline">
            到审批中心审批
          </Link>
        )}
        {approvable && !gate.uncertain && gate.canActHere && (
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
                  // 只带确认时改过的原因；没改的照提交时写的（没写的按默认：部门小仓「耗用」、总仓「不明差异」）
                  { ...gate.fence, countReasons: Object.fromEntries(diffLines.filter((l) => reasons[l.id]).map((l) => [String(l.id), reasons[l.id]!])) },
                  !finalLevel ? `已同意第 ${doc.approval!.currentLevel} 级` : doc.urgent ? '急采已批准，等仓库到部门验收' : doc.docType === 'count' ? '盘点调整已确认' : '已确认生效',
                )
              }
            >
              {doc.approval && doc.approval.levels > 1 ? `同意（第 ${doc.approval.currentLevel}/${doc.approval.levels} 级）` : doc.urgent ? '批准急采' : doc.docType === 'count' ? '确认盘点调整' : '确认生效'}
            </Button>
          </>
        )}
      </footer>

      <ReasonDialog
        open={!!dialog}
        busy={!!busy}
        title={`${dialog?.kind === 'void' ? '冲销' : dialog?.kind === 'return' ? '退回修改' : dialog?.kind === 'reject' ? '供应商不同意' : '撤回'} ${doc.docNo}`}
        description={
          dialog?.kind === 'void'
            ? '冲销会按原流水反向记账：原单保留并标记「已冲销」，库存与货款恢复到这张单之前。'
            : dialog?.kind === 'return'
              ? '退回后经办人可以修改再提交；退回不影响库存。'
              : dialog?.kind === 'reject'
                ? '登记供应商不同意退货：退货单撤回，库存与货款都不动。'
                : '撤回未生效的单据，不影响库存。'
        }
        label={dialog?.kind === 'return' ? '需要修改什么' : dialog?.kind === 'reject' ? '供应商为什么不同意' : '原因'}
        confirmLabel={dialog?.kind === 'void' ? '确认冲销' : dialog?.kind === 'return' ? '退回修改' : dialog?.kind === 'reject' ? '登记不同意' : '确认撤回'}
        danger={dialog?.kind === 'void'}
        extra={
          dialog?.kind === 'void' && (
            <p className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-3">
              冲销权限与范围 <SimRule />
            </p>
          )
        }
        onClose={() => setDialog(null)}
        onConfirm={(reason) => {
          const kind = dialog!.kind;
          if (kind === 'reject') {
            void run('reject', `/api/inventory/docs/${doc.id}/supplier-answer`, { agreed: false, note: reason }, '已登记供应商不同意，退货单撤回');
            return;
          }
          void run(kind, `/api/inventory/docs/${doc.id}/${kind}`, kind === 'return' ? { reason, ...gate.fence } : { reason }, kind === 'void' ? '已冲销' : kind === 'return' ? '已退回修改' : '已撤回');
        }}
      />
      <AgreeDialog
        open={agreeOpen}
        doc={doc}
        busy={busy === 'agree'}
        onClose={() => setAgreeOpen(false)}
        onConfirm={async (date, note) => {
          await run('agree', `/api/inventory/docs/${doc.id}/supplier-answer`, { agreed: true, date, note }, '供应商已同意：退货生效，已出库扣款');
          setAgreeOpen(false);
        }}
      />
    </>
  );
}

/** 登记供应商已同意（#20）：写明同意的日期（出库、扣款记在这天）与对方联系人或说明 */
function AgreeDialog({ open, doc, busy, onClose, onConfirm }: { open: boolean; doc: InvDoc; busy: boolean; onClose: () => void; onConfirm: (date: string, note: string) => Promise<void> }) {
  const session = useSession();
  const [date, setDate] = useState(session.calendarToday);
  const [note, setNote] = useState('');
  const [last, setLast] = useState(false);
  if (open !== last) {
    setLast(open);
    if (open) {
      setDate(session.calendarToday);
      setNote('');
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`供应商已同意 · ${doc.docNo}`}
      description={`登记后退货生效：从${doc.warehouse?.name ?? '原收货单的仓'}出库，${doc.amountCents > 0 ? '按原收货价扣款' : '不涉及金额'}。出库与扣款记在供应商同意的那天。`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void onConfirm(date, note.trim())} data-testid="supplier-agree-submit">
            确认，退货生效
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
          供应商同意的日期
          <input
            type="date"
            className="h-10 rounded-sm border border-line-strong bg-card px-3 text-[14px] font-normal"
            value={date}
            min={doc.docDate}
            max={session.calendarToday}
            onChange={(e) => setDate(e.target.value)}
            aria-label="供应商同意的日期"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
          对方联系人或说明
          <input
            className="h-10 rounded-sm border border-line-strong bg-card px-3 text-[14px] font-normal"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：业务员王经理电话确认"
            aria-label="对方联系人或说明"
          />
        </label>
      </div>
    </Dialog>
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
