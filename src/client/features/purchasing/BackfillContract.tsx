// 8.1.10 急采后补合同（docs/ERP_V8110.md 第 1 节，PENDING_DECISIONS CK18–CK22）：补单采购单详情里的一块。
//   · 急采金额达到补合同的线的：写着期限（还剩几天 / 超期几天），补上之前不能付款；
//   · 没达到的也能补（年度框架合同也行）；
//   · 「补合同」：选这家供应商的采购合同（生效中、到期日不早于下单日，补签的开始日可以晚于下单日），
//     单价、数量超出合同的要写原因；挂上以后不能换、不能取消。
// 同一份合同重提照原样返回（天然幂等），没收到结果时直接再点一次就行。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileSignature } from 'lucide-react';
import type { ContractOption } from '@shared/contracts';
import type { PurchaseOrder } from '@shared/purchasing';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Notice, Skeleton, Textarea } from '../../components/ui';
import { useInvalidateAll } from './queries';

export function BackfillContract({ po, canManage }: { po: PurchaseOrder; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const due = po.contractDue ?? null;
  return (
    <>
      <Notice
        tone={due ? (due.daysLeft < 0 ? 'error' : 'warning') : 'info'}
        title={due ? (due.daysLeft < 0 ? `急采要补合同 · 已超期 ${-due.daysLeft} 天（期限 ${due.dueOn}）` : `急采要补合同 · 还剩 ${due.daysLeft} 天（期限 ${due.dueOn}）`) : '补单采购单可以补挂合同'}
        data-testid="po-contract-due"
      >
        {due ? '这笔急采达到要补合同的金额，补上之前不能付款；补上以后从合同的付款计划里申请付款。' : '没达到要补合同的金额，补不补都可以；挂上年度框架合同的，货款以后照合同付。'}
        {canManage && (
          <div className="mt-2">
            <Button size="sm" variant={due ? 'primary' : 'secondary'} icon={<FileSignature className="size-4" />} onClick={() => setOpen(true)} data-testid="po-contract-add">
              补合同
            </Button>
          </div>
        )}
      </Notice>
      {open && <AttachDialog po={po} onClose={() => setOpen(false)} />}
    </>
  );
}

function AttachDialog({ po, onClose }: { po: PurchaseOrder; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const options = useQuery({
    queryKey: ['inv', 'po-contract-options', po.id],
    queryFn: () => api.get<ContractOption[]>(`/api/purchase-orders/${po.id}/contract-options`),
  });
  const [contractId, setContractId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (contractId === null) return setError('请选一份合同');
    setBusy(true);
    setError(null);
    try {
      await api.post<PurchaseOrder>(`/api/purchase-orders/${po.id}/contract`, { contractId, contractNote: note.trim() });
      await invalidate();
      toast({ tone: 'success', title: '已补合同', body: po.docNo });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      await invalidate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`补合同 · ${po.docNo}`}
      description={`选 ${po.supplier.name} 的采购合同：生效中、到期日不早于下单日 ${po.orderDate}（补签的开始日可以晚于下单日）。挂上以后不能换。`}
      width="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={contractId === null} data-testid="po-contract-save">
            补上这份合同
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="po-contract-dialog">
        {options.isPending ? (
          <Skeleton className="h-24" />
        ) : options.isError && !options.data ? (
          <LoadFailed title="能挂的合同没取回来" onRetry={() => void options.refetch()} retrying={options.isFetching} />
        ) : options.data!.length === 0 ? (
          <Notice tone="warning" title="没有能挂的合同">
            这家供应商还没有生效中的采购合同。请先在「合同」里起草、审批、签署（年度框架合同也行），再回来补。
          </Notice>
        ) : (
          <div className="space-y-2" role="radiogroup" aria-label="选合同">
            {options.data!.map((c) => (
              <label
                key={c.id}
                className={cn(
                  'flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-[13px]',
                  contractId === c.id ? 'border-pine bg-pine-soft/40' : 'border-line bg-card hover:bg-paper',
                )}
                data-testid={`po-contract-option-${c.id}`}
              >
                <input type="radio" name="contract" className="mt-1 size-4 accent-[var(--color-pine)]" checked={contractId === c.id} onChange={() => setContractId(c.id)} />
                <span className="min-w-0 flex-1">
                  <span className="num font-semibold">{c.contractNo}</span>
                  <span className="ml-2 break-words text-ink-2">{c.title}</span>
                  <span className="block text-[12px] text-ink-3">
                    到期：{c.endDate ?? '长期'} · 单价表 {c.lines.length} 项
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        <Field label="原因（单价或数量超出合同时必填）" htmlFor="po-contract-note" hint="至少 2 个字；没超出可以不写">
          <Textarea id="po-contract-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={200} data-testid="po-contract-note" />
        </Field>
        {error && <Notice tone="error" title={error} data-testid="po-contract-error" />}
      </div>
    </Dialog>
  );
}
