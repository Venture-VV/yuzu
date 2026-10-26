import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Ban, CircleCheck, CornerUpLeft, RotateCcw, Send, X } from 'lucide-react';
import { PAY_METHOD_LABELS, type OpeningPayableDoc, type PaymentDoc } from '@shared/purchasing';
import { parseYuan } from '@shared/money';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog, Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, IconButton, Input, MoneyInput, Notice, Select, Spinner } from '../../components/ui';
import { SimRule } from '../inventory/parts';
import { useInvSettings, useSuppliers } from '../inventory/queries';
import { PayableStatusChip } from '../purchasing/parts';
import { useInvalidateAll, usePayment } from '../purchasing/queries';

const ACTION_LABELS: Record<string, string> = { create: '登记', submit: '提交', approve: '确认', return: '退回修改', cancel: '撤回', void: '冲销' };

type Act = 'approve' | 'return' | 'cancel' | 'void' | 'resubmit';

function useActions(base: string, docNo: string) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [busy, setBusy] = useState<Act | null>(null);
  const run = async (act: Act, body: unknown = {}) => {
    setBusy(act);
    try {
      await api.post(`${base}/${act}`, body);
      await invalidate();
      toast({ tone: 'success', title: { approve: '已确认', return: '已退回修改', cancel: '已撤回', void: '已冲销', resubmit: '已重新提交' }[act], body: docNo });
      return true;
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      await invalidate();
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

function Timeline({ items }: { items: PaymentDoc['approvals'] }) {
  return (
    <ol className="space-y-2 border-l-2 border-line pl-4">
      {items.map((a) => (
        <li key={a.id} className="relative text-[12.5px]">
          <span className={cn('absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-2 ring-paper', a.action === 'approve' ? 'bg-pine' : a.action === 'return' || a.action === 'void' ? 'bg-clay' : 'bg-ink-4')} />
          <span className="font-bold">{ACTION_LABELS[a.action] ?? a.action}</span>
          <span className="text-ink-2"> · {a.actorName}</span>
          <span className="num text-ink-3"> · {formatDateTime(a.createdAt)}</span>
          {a.reason && <p className="text-ink-2">{a.reason}</p>}
        </li>
      ))}
    </ol>
  );
}

function Footer({
  status,
  createdBy,
  busy,
  onAct,
  onReason,
}: {
  status: PaymentDoc['status'];
  createdBy: number;
  busy: Act | null;
  onAct: (a: Act) => void;
  onReason: (a: 'return' | 'cancel' | 'void') => void;
}) {
  const can = useCan();
  const session = useSession();
  const approve = can('inventory.approve');
  const manage = can('payable.manage');
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-card px-5 py-3.5">
      {status === 'confirmed' && approve && (
        <Button variant="ghost" size="sm" icon={<RotateCcw className="size-4" />} onClick={() => onReason('void')} className="text-clay hover:bg-clay-soft/60 hover:text-clay">
          冲销
        </Button>
      )}
      {(status === 'submitted' || status === 'returned') && (approve || (manage && createdBy === session.staff.id)) && (
        <Button variant="ghost" size="sm" icon={<Ban className="size-4" />} onClick={() => onReason('cancel')}>
          撤回
        </Button>
      )}
      {status === 'returned' && (manage || approve) && (
        <Button variant="primary" loading={busy === 'resubmit'} icon={<Send className="size-4" />} onClick={() => onAct('resubmit')}>
          按原内容重新提交
        </Button>
      )}
      {status === 'submitted' && approve && (
        <>
          <Button variant="secondary" icon={<CornerUpLeft className="size-4" />} onClick={() => onReason('return')}>
            退回修改
          </Button>
          <Button variant="primary" loading={busy === 'approve'} icon={<CircleCheck className="size-4" />} onClick={() => onAct('approve')}>
            确认
          </Button>
        </>
      )}
    </footer>
  );
}

const REASON_TEXT = {
  return: { title: '退回修改', confirm: '退回修改', desc: '退回后经办人可撤回后重新登记，或按原内容重新提交。' },
  cancel: { title: '撤回', confirm: '确认撤回', desc: '撤回尚未确认的记录，不影响货款。' },
  void: { title: '冲销', confirm: '确认冲销', desc: '冲销保留原记录并反向记账，供应商余额恢复到这笔之前。' },
} as const;

export function PaymentSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const payment = usePayment(id);
  return (
    <Sheet open={!!id} onClose={onClose} label="付款详情" width="w-[min(560px,100vw)]">
      {payment.error ? (
        <Notice tone="error" title={errorMessage(payment.error)} className="m-5" />
      ) : !payment.data ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <PaymentBody p={payment.data} onClose={onClose} />
      )}
    </Sheet>
  );
}

function PaymentBody({ p, onClose }: { p: PaymentDoc; onClose: () => void }) {
  const { busy, run } = useActions(`/api/payables/payments/${p.id}`, p.docNo);
  const [reason, setReason] = useState<'return' | 'cancel' | 'void' | null>(null);
  return (
    <>
      <header className="flex items-start gap-3 border-b border-line bg-card px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-ink-3">付款登记</p>
          <p className="num text-[18px] font-bold">{p.docNo}</p>
          <div className="mt-1 flex items-center gap-1.5">
            <PayableStatusChip status={p.status} />
            {p.isSynthetic && <Badge tone="ember">合成演示</Badge>}
          </div>
        </div>
        <IconButton label="关闭" onClick={onClose} className="-mr-2">
          <X className="size-[18px]" />
        </IconButton>
      </header>
      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {p.status === 'submitted' && <Notice tone="warning" title="待负责人确认，确认前不计入已付款">付款审批安排为模拟规则 <SimRule className="align-middle" /></Notice>}
        {p.status === 'returned' && p.returnedReason && <Notice tone="warning" title="负责人退回修改">{p.returnedReason}</Notice>}
        {p.status === 'voided' && <Notice tone="error" title={`已冲销 · ${p.voidedByName ?? ''}`}>{p.voidReason}</Notice>}
        <div className="rounded-lg border border-line bg-card px-4 py-3.5">
          <p className="text-[12px] font-semibold text-ink-3">付款金额</p>
          <Money cents={p.amountCents} className="text-[28px] font-bold text-lake" />
          <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 text-[13px]">
            <Info label="供应商">{p.supplier.name}</Info>
            <Info label="付款日期">
              <span className="num">{p.payDate}</span>
            </Info>
            <Info label="方式">{PAY_METHOD_LABELS[p.method]}</Info>
            <Info label="凭据说明">{p.evidence}</Info>
            {p.note && (
              <Info label="备注" wide>
                {p.note}
              </Info>
            )}
            <Info label="登记">
              {p.createdByName} · {formatDateTime(p.createdAt)}
            </Info>
            <Info label="确认">{p.confirmedByName ? `${p.confirmedByName} · ${formatDateTime(p.confirmedAt!)}` : '—'}</Info>
          </dl>
        </div>
        <section>
          <h3 className="mb-2 text-[13px] font-bold text-ink-2">核销到</h3>
          <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card">
            {p.allocations.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                {a.kind === 'receipt' ? (
                  <Link to={`/inventory/docs?doc=${a.targetId}`} className="num font-semibold text-pine hover:underline">
                    {a.docNo}
                  </Link>
                ) : (
                  <span className="num font-semibold">{a.docNo}</span>
                )}
                <span className="text-ink-3">{a.kind === 'receipt' ? '收货货款' : '期初未付'}</span>
                <span className="flex-1" />
                <Money cents={a.amountCents} className="font-bold" />
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 text-[13px] font-bold text-ink-2">经办记录</h3>
          <Timeline items={p.approvals} />
        </section>
      </div>
      <Footer status={p.status} createdBy={p.createdBy} busy={busy} onAct={(a) => void run(a)} onReason={setReason} />
      <ReasonDialog
        open={!!reason}
        busy={!!busy}
        title={`${reason ? REASON_TEXT[reason].title : ''} ${p.docNo}`}
        description={reason ? REASON_TEXT[reason].desc : ''}
        confirmLabel={reason ? REASON_TEXT[reason].confirm : ''}
        danger={reason === 'void'}
        onClose={() => setReason(null)}
        onConfirm={async (text) => {
          if (await run(reason!, { reason: text })) setReason(null);
        }}
      />
    </>
  );
}

export function OpeningSheet({ doc, onClose }: { doc: OpeningPayableDoc | null; onClose: () => void }) {
  const { busy, run } = useActions(`/api/payables/openings/${doc?.id ?? 0}`, doc?.docNo ?? '');
  const [reason, setReason] = useState<'return' | 'cancel' | 'void' | null>(null);
  return (
    <Sheet open={!!doc} onClose={onClose} label="期初未付详情" width="w-[min(520px,100vw)]">
      {doc && (
        <>
          <header className="flex items-start gap-3 border-b border-line bg-card px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold text-ink-3">期初未付</p>
              <p className="num text-[18px] font-bold">{doc.docNo}</p>
              <div className="mt-1">
                <PayableStatusChip status={doc.status} />
              </div>
            </div>
            <IconButton label="关闭" onClick={onClose} className="-mr-2">
              <X className="size-[18px]" />
            </IconButton>
          </header>
          <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            {doc.status === 'returned' && doc.returnedReason && <Notice tone="warning" title="负责人退回修改">{doc.returnedReason}</Notice>}
            {doc.status === 'voided' && <Notice tone="error" title="已冲销">{doc.voidReason}</Notice>}
            <div className="rounded-lg border border-line bg-card px-4 py-3.5">
              <p className="text-[12px] font-semibold text-ink-3">上期已收货未付</p>
              <Money cents={doc.amountCents} className="text-[26px] font-bold" />
              <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 text-[13px]">
                <Info label="供应商">{doc.supplier.name}</Info>
                <Info label="截至日期">
                  <span className="num">{doc.asOfDate}</span>
                </Info>
                <Info label="已核销">
                  <Money cents={doc.paidCents} />
                </Info>
                <Info label="登记">{doc.createdByName}</Info>
                {doc.note && (
                  <Info label="说明" wide>
                    {doc.note}
                  </Info>
                )}
              </dl>
            </div>
            <p className="text-[12.5px] text-ink-3">期初未付只记已对账确认的上期欠款，不计入本期采购或收货。</p>
            <Timeline items={doc.approvals} />
          </div>
          <Footer status={doc.status} createdBy={doc.createdBy} busy={busy} onAct={(a) => void run(a).then((ok) => ok && onClose())} onReason={setReason} />
          <ReasonDialog
            open={!!reason}
            busy={!!busy}
            title={`${reason ? REASON_TEXT[reason].title : ''} ${doc.docNo}`}
            description={reason ? REASON_TEXT[reason].desc : ''}
            confirmLabel={reason ? REASON_TEXT[reason].confirm : ''}
            danger={reason === 'void'}
            onClose={() => setReason(null)}
            onConfirm={async (text) => {
              if (await run(reason!, { reason: text })) {
                setReason(null);
                onClose();
              }
            }}
          />
        </>
      )}
    </Sheet>
  );
}

/** 登记期初未付：已对账确认的上期欠款 */
export function OpeningDialog({ open, onClose, supplierId }: { open: boolean; onClose: () => void; supplierId?: number | null }) {
  const session = useSession();
  const can = useCan();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const suppliers = useSuppliers();
  const settings = useInvSettings();
  const [form, setForm] = useState({ supplierId: '', amount: '', date: session.calendarToday, note: '' });
  const [approveNow, setApproveNow] = useState(false);
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState(false);
  if (open !== last) {
    setLast(open);
    if (open) {
      setForm({ supplierId: supplierId ? String(supplierId) : '', amount: '', date: session.calendarToday, note: '' });
      setKey(uuid());
      setError(null);
    }
  }
  const cents = parseYuan(form.amount);
  const needsApproval = !!settings.data?.approvalRules.opening;
  const save = async () => {
    if (!form.supplierId) return setError('请选择供应商');
    if (!cents) return setError('请填写正确的金额');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/payables/openings', {
        clientKey: key,
        supplierId: Number(form.supplierId),
        amountCents: cents,
        asOfDate: form.date,
        note: form.note.trim(),
        approveNow: needsApproval && approveNow,
      });
      await invalidate();
      toast({ tone: 'success', title: needsApproval && !approveNow ? '已提交，等待负责人确认' : '期初未付已确认' });
      onClose();
    } catch (e) {
      // 同一操作编号重提不会重复登记
      setError(e instanceof UncertainError ? '结果待确认：请再点一次「保存」核对（不会重复登记）' : e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="登记期初未付"
      description="只登记已与供应商对账确认的上期欠款；不计入本期采购。"
      footer={
        <>
          {needsApproval && can('inventory.approve') && (
            <label className="mr-auto flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ink-2">
              <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={approveNow} onChange={(e) => setApproveNow(e.target.checked)} />
              同时确认
            </label>
          )}
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="供应商" htmlFor="op-sup" className="sm:col-span-2">
          <Select id="op-sup" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
            <option value="">选择供应商</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="金额" htmlFor="op-amt">
          <MoneyInput id="op-amt" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="截至日期" htmlFor="op-date">
          <Input id="op-date" type="date" value={form.date} max={session.calendarToday} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </Field>
        <Field label="说明" htmlFor="op-note" className="sm:col-span-2" hint="例如：截至 9 月底对账单确认">
          <Input id="op-note" value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        {needsApproval && (
          <p className="flex items-center gap-2 text-[12.5px] text-ink-3 sm:col-span-2">
            提交后需负责人确认 <SimRule />
          </p>
        )}
        {error && <Notice tone="error" title={error} className="sm:col-span-2" />}
      </div>
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
