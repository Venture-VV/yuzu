// 供应商的准入与证照（8.0.7 供应链收尾 2.1）：待准入 / 已准入 / 暂停；证照（营业执照、食品经营许可证、卫生许可证、其他）的
// 号码、有效期至（空 = 长期）、照片或 PDF。维护档案的人登记、撤下证照（撤下写原因、留记录）；负责人（「审核」权限）准入、暂停。

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, ShieldCheck, Upload } from 'lucide-react';
import type { Supplier } from '@shared/inventory';
import { LICENSE_KIND_LABELS, LICENSE_KINDS, SUPPLIER_ADMISSION_LABELS, type LicenseKind, type SupplierAdmission, type SupplierAdmissionView, type SupplierLicense } from '@shared/supply';
import { pdfMaxBytes } from '@shared/tunables';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { imagePayload } from '../../components/Images';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { useInvalidateInventory } from './queries';

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('读不了这个文件'));
    r.readAsDataURL(file);
  });

export const ADMISSION_TONES: Record<SupplierAdmission, 'pine' | 'yuzu' | 'clay'> = { approved: 'pine', pending: 'yuzu', suspended: 'clay' };

/** 供应商卡片上的准入与证照到期标记 */
export function AdmissionBadges({ s, today, remindDays }: { s: Supplier; today: string; remindDays: number }) {
  const days = s.licenseDue ? Math.round((Date.parse(`${s.licenseDue}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  return (
    <>
      {s.admission !== 'approved' && <Badge tone={ADMISSION_TONES[s.admission]}>{SUPPLIER_ADMISSION_LABELS[s.admission]}</Badge>}
      {days !== null && days <= remindDays && <Badge tone={days < 0 ? 'clay' : 'yuzu'}>{days < 0 ? '证照已过期' : `证照 ${days} 天后到期`}</Badge>}
    </>
  );
}

export function AdmissionSection({ supplier }: { supplier: Supplier }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const invalidate = useInvalidateInventory();
  const key = ['inv', 'supplier-admission', supplier.id] as const;
  const view = useQuery({ queryKey: key, queryFn: () => api.get<SupplierAdmissionView>(`/api/inventory/suppliers/${supplier.id}/admission`) });
  const manage = can('inventory.master');
  const approver = can('inventory.approve');
  const [kind, setKind] = useState<LicenseKind>('business');
  const [name, setName] = useState('');
  const [licenseNo, setLicenseNo] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SupplierLicense | null>(null);
  const [suspending, setSuspending] = useState(false);
  const done = async (next: SupplierAdmissionView) => {
    qc.setQueryData(key, next);
    await invalidate();
  };
  const add = async () => {
    setError(null);
    if (!licenseNo.trim()) return setError('请填写证照号码');
    if (kind === 'other' && !name.trim()) return setError('「其他」证照请写名称');
    setBusy('add');
    try {
      let media: Record<string, string> = {};
      if (file) {
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
          if (file.size > pdfMaxBytes(session.rules)) throw new Error(`文件不能超过 ${session.rules.pdfMaxMb} MB`);
          media = { mime: 'application/pdf', data: await toBase64(file) };
        } else media = await imagePayload(file);
      }
      const next = await api.post<SupplierAdmissionView>(
        `/api/inventory/suppliers/${supplier.id}/licenses`,
        { kind, name: name.trim(), licenseNo: licenseNo.trim(), validUntil: validUntil || null, ...media },
        { timeoutMs: 60_000 },
      );
      await done(next);
      setLicenseNo('');
      setName('');
      setValidUntil('');
      setFile(null);
      if (input.current) input.current.value = '';
      toast({ tone: 'success', title: '证照已登记', body: `${LICENSE_KIND_LABELS[kind]} ${licenseNo.trim()}` });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const approve = async () => {
    setBusy('approve');
    setError(null);
    try {
      await done(await api.post<SupplierAdmissionView>(`/api/inventory/suppliers/${supplier.id}/admission`, { action: 'approve' }));
      toast({ tone: 'success', title: '已准入', body: supplier.name });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const v = view.data;
  return (
    <section className="space-y-2.5 rounded-lg border border-line p-3 sm:col-span-3" data-testid="supplier-admission">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 text-ink-3" />
        <span className="text-[13.5px] font-bold">准入与证照</span>
        {v && <Badge tone={ADMISSION_TONES[v.admission]}>{SUPPLIER_ADMISSION_LABELS[v.admission]}</Badge>}
        {v?.admissionByName && (
          <span className="text-[12px] text-ink-3">
            {v.admissionByName} · {formatDateTime(v.admissionAt!)}
            {v.admissionNote ? ` · ${v.admissionNote}` : ''}
          </span>
        )}
        {v && approver && (
          <span className="ml-auto flex gap-1.5">
            {v.admission !== 'approved' && (
              <Button size="sm" variant="primary" loading={busy === 'approve'} disabled={!v.canApprove} onClick={() => void approve()} data-testid="admission-approve">
                准入
              </Button>
            )}
            {v.admission !== 'suspended' && (
              <Button size="sm" variant="ghost" onClick={() => setSuspending(true)} data-testid="admission-suspend">
                暂停
              </Button>
            )}
          </span>
        )}
      </div>
      {v && v.admission !== 'approved' && !v.canApprove && <p className="text-[12.5px] text-ink-3">准入前要登记一张没过期（或长期）的营业执照。</p>}
      {!v ? (
        <Skeleton className="h-16" />
      ) : v.licenses.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">还没有登记证照。</p>
      ) : (
        <ul className="divide-y divide-line/70 rounded-md border border-line" data-testid="supplier-licenses">
          {v.licenses.map((l) => {
            const days = l.validUntil ? Math.round((Date.parse(`${l.validUntil}T00:00:00Z`) - Date.parse(`${session.calendarToday}T00:00:00Z`)) / 86_400_000) : null;
            return (
              <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                <span className="font-semibold">{l.kind === 'other' ? l.name : LICENSE_KIND_LABELS[l.kind]}</span>
                <span className="num text-ink-2">{l.licenseNo}</span>
                <span className="text-[12.5px] text-ink-3">{l.validUntil ? `有效期至 ${l.validUntil}` : '长期'}</span>
                {days !== null && days < 0 && <Badge tone="clay">已过期</Badge>}
                {days !== null && days >= 0 && days <= session.rules.licenseRemindDays && <Badge tone="yuzu">{days} 天后到期</Badge>}
                {l.media && (
                  <a href={l.media.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-lake hover:underline">
                    <FileText className="size-3.5" />
                    {l.media.kind === 'pdf' ? 'PDF' : '照片'}
                  </a>
                )}
                {manage && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setRemoving(l)}>
                    撤下
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {manage && (
        <div className="grid gap-2 rounded-md bg-paper-2 p-2.5 sm:grid-cols-4">
          <Field label="种类" htmlFor="lic-kind">
            <Select id="lic-kind" value={kind} onChange={(e) => setKind(e.target.value as LicenseKind)} className="h-10">
              {LICENSE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LICENSE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          {kind === 'other' && (
            <Field label="名称" htmlFor="lic-name">
              <Input id="lic-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="h-10" />
            </Field>
          )}
          <Field label="证照号码" htmlFor="lic-no">
            <Input id="lic-no" value={licenseNo} maxLength={64} onChange={(e) => setLicenseNo(e.target.value)} className="h-10" data-testid="license-no" />
          </Field>
          <Field label="有效期至（空 = 长期）" htmlFor="lic-until">
            <Input id="lic-until" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="h-10" data-testid="license-until" />
          </Field>
          <div className="flex items-end gap-2 sm:col-span-4">
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button size="sm" variant="secondary" icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>
              {file ? file.name.slice(0, 24) : '照片或 PDF（选填）'}
            </Button>
            <Button size="sm" variant="primary" loading={busy === 'add'} onClick={() => void add()} data-testid="license-add">
              登记证照
            </Button>
          </div>
        </div>
      )}
      {error && <Notice tone="error" title={error} />}
      <ReasonDialog
        open={!!removing}
        title={removing ? `撤下证照 · ${removing.licenseNo}` : '撤下证照'}
        description="证照不能删，撤下以后记录保留（换证 = 撤下旧的、登记新的）。"
        confirmLabel="撤下"
        onClose={() => setRemoving(null)}
        onConfirm={async (reason) => {
          if (!removing) return;
          try {
            await done(await api.post<SupplierAdmissionView>(`/api/inventory/supplier-licenses/${removing.id}/remove`, { reason }));
            setRemoving(null);
          } catch (e) {
            toast({ tone: 'error', title: errorMessage(e) });
          }
        }}
      />
      <ReasonDialog
        open={suspending}
        title={`暂停 · ${supplier.name}`}
        description="暂停以后下采购单时提醒；经营规则里打开「采购单只能给已准入的供应商」时直接拦。"
        confirmLabel="暂停"
        onClose={() => setSuspending(false)}
        onConfirm={async (reason) => {
          try {
            await done(await api.post<SupplierAdmissionView>(`/api/inventory/suppliers/${supplier.id}/admission`, { action: 'suspend', note: reason }));
            setSuspending(false);
          } catch (e) {
            toast({ tone: 'error', title: errorMessage(e) });
          }
        }}
      />
    </section>
  );
}
