// 供应商收款账户（8.0.21 批量付款；Codex 安全审查后补，PENDING_DECISIONS CW28）：
//   · 由应付岗（「应付」权限：店主与「应付」职责）在这里改，采购改供应商档案改不了它；
//   · 店主以外的人改了要另一位应付或店主跟供应商核对后「复核」，批量付款只用复核过的；店主改的直接算复核过；
//   · 完整账号不发到页面：只看得到后四位，改就整个重填，复核时带上看到的后四位（对不上说明刚被改过）。

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Supplier } from '@shared/inventory';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice } from '../../components/ui';
import { useInvalidateInventory, useSuppliers } from './queries';

const STATUS: Record<Supplier['bankStatus'], { label: string; tone: 'neutral' | 'yuzu' | 'pine' }> = {
  none: { label: '没有收款账户', tone: 'neutral' },
  pending: { label: '待复核', tone: 'yuzu' },
  verified: { label: '已复核', tone: 'pine' },
};

export function SupplierBankSection({ supplier }: { supplier: Supplier }) {
  // 对话框里拿着的是打开时的那一份：改了、复核了以后按编号从刷新过的名单里取
  const fresh = useSuppliers(true).data?.find((x) => x.id === supplier.id);
  const s = fresh ?? supplier;
  const can = useCan();
  const me = useSession().staff;
  const toast = useToast();
  const invalidate = useInvalidateInventory();
  const manage = can('payable.manage');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ bankPayee: '', bankName: '', bankAccount: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const st = STATUS[s.bankStatus];
  // 改的人自己不能复核（店主除外）
  const selfChanged = s.bankChangedBy !== null && s.bankChangedBy === me.id && me.role !== 'owner';

  const open = () => {
    setForm({ bankPayee: s.bankPayee, bankName: s.bankName, bankAccount: '' });
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/inventory/suppliers/${s.id}/bank`, { bankPayee: form.bankPayee.trim(), bankName: form.bankName.trim(), bankAccount: form.bankAccount.trim() });
      await invalidate();
      toast({ tone: 'success', title: me.role === 'owner' ? '收款账户已保存' : '收款账户已保存，等另一位应付或店主复核' });
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    try {
      await api.post(`/api/inventory/suppliers/${s.id}/bank/verify`, { tail: s.bankAccountTail, rowVersion: s.rowVersion });
      await invalidate();
      toast({ tone: 'success', title: '收款账户已复核' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-line pt-3 sm:col-span-3" data-testid="supplier-bank">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13.5px] font-bold">收款账户</h3>
        <span data-testid="supplier-bank-status">
          <Badge tone={st.tone}>{st.label}</Badge>
        </span>
        <span className="flex-1" />
        {manage && (
          <Button size="sm" variant="ghost" onClick={open} data-testid="supplier-bank-edit">
            {s.bankStatus === 'none' ? '填写收款账户' : '修改'}
          </Button>
        )}
        {manage && s.bankStatus === 'pending' && !selfChanged && (
          <Button size="sm" variant="secondary" icon={<ShieldCheck className="size-4" />} loading={busy} onClick={() => void verify()} data-testid="supplier-bank-verify">
            复核
          </Button>
        )}
      </div>
      {s.bankStatus !== 'none' && (
        <p className="text-[13px]">
          {s.bankPayee} · {s.bankName} · <span className="num">尾号 {s.bankAccountTail}</span>
        </p>
      )}
      <p className="text-[12px] text-ink-3">
        {s.bankChangedByName && `${s.bankChangedByName} ${s.bankChangedAt ? formatDateTime(s.bankChangedAt) : ''} 改的`}
        {s.bankStatus === 'verified' && s.bankVerifiedByName && `；${s.bankVerifiedByName} ${s.bankVerifiedAt ? formatDateTime(s.bankVerifiedAt) : ''} 复核`}
        {s.bankStatus === 'pending' && (selfChanged ? '；改的人自己不能复核，请另一位应付或店主跟供应商核对后复核' : '；跟供应商核对账号以后点「复核」，批量付款才用它')}
        {s.bankStatus === 'none' && '批量付款要用：应付岗填写，店主以外的人填的要另一人复核'}
      </p>
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title={`收款账户 · ${s.name}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void save()} data-testid="supplier-bank-save">
              保存
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field label="收款户名" htmlFor="sb-payee">
            <Input id="sb-payee" value={form.bankPayee} maxLength={60} onChange={(e) => setForm({ ...form, bankPayee: e.target.value })} data-testid="s-bank-payee" data-autofocus />
          </Field>
          <Field label="收款开户行" htmlFor="sb-bank">
            <Input id="sb-bank" value={form.bankName} maxLength={60} onChange={(e) => setForm({ ...form, bankName: e.target.value })} data-testid="s-bank-name" />
          </Field>
          <Field label="收款账号" htmlFor="sb-account" hint={s.bankAccountTail ? `现在是尾号 ${s.bankAccountTail}；空着不改，要改就整个重填` : '8–32 位数字'}>
            <Input
              id="sb-account"
              value={form.bankAccount}
              maxLength={40}
              inputMode="numeric"
              onChange={(e) => setForm({ ...form, bankAccount: e.target.value })}
              placeholder={s.bankAccountTail ? `**** ${s.bankAccountTail}` : ''}
              className="num"
              data-testid="s-bank-account"
            />
          </Field>
          {me.role !== 'owner' && <p className="text-[12.5px] text-ink-3">保存以后是「待复核」：要另一位应付或店主跟供应商核对后复核，批量付款才用它。</p>}
          {error && <Notice tone="error" title={error} />}
        </div>
      </Dialog>
    </div>
  );
}
