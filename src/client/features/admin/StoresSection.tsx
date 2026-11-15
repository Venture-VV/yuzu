// 后台「门店与主体」（8.0.22，docs/MULTISTORE_V8022.md 第 1、7 节）：
//   · 门店：代码、名称、所属主体、地址电话、排序、启用（本店不能停用）；新门店的员工在「员工账号」里挂门店；
//   · 公司主体：名称（发票抬头）、税号、地址电话、开户行与账号（合同、开票申请、批量付款的「我方」取这里）；
//   · 门店之间的储值结算：会员在开卡店以外的门店用储值，按「开卡店 → 消费店」汇总、两两轧差（只是报表，不记账）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EntityView, StoreSettlementReport, StoreView } from '@shared/stores';
import { api, errorMessage } from '../../lib/api';
import { formatYuan } from '@shared/money';
import { useCan, useSession } from '../../lib/session';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Card, Field, Input, Select, Skeleton } from '../../components/ui';
import { AdminPage } from './AdminShell';

interface StoresData {
  stores: StoreView[];
  entities: EntityView[];
}

type StoreDraft = { code: string; name: string; entityId: number; address: string; phone: string; sortOrder: number; active: boolean };
type EntityDraft = { name: string; taxNo: string; addressPhone: string; bankName: string; bankAccount: string; active: boolean };

export function StoresSection() {
  const qc = useQueryClient();
  const can = useCan();
  const data = useQuery({ queryKey: ['admin', 'stores'], queryFn: () => api.get<StoresData>('/api/admin/stores') });
  const [store, setStore] = useState<{ mode: 'new' } | { mode: 'edit'; store: StoreView } | null>(null);
  const [entity, setEntity] = useState<{ mode: 'new' } | { mode: 'edit'; entity: EntityView } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'stores'] });
  return (
    <AdminPage
      section="stores"
      description="只有一家店时什么都不用设。开第二家店：先建它所属的公司主体（同一家公司就用「本公司」），再建门店，然后到「员工账号」给员工挂门店。"
    >
      {data.isPending ? (
        <Skeleton className="h-64" />
      ) : data.isError && !data.data ? (
        <LoadFailed title="门店与主体取不回来，请检查网络" onRetry={() => void data.refetch()} retrying={data.isFetching} testId="stores-error" />
      ) : (
        <div className="grid gap-5">
          <Card className="p-5" data-testid="stores-card">
            <div className="mb-3 flex items-center gap-3">
              <h2 className="flex-1 text-[16px] font-bold">门店</h2>
              <Button variant="secondary" onClick={() => setStore({ mode: 'new' })} data-testid="store-new">
                新建门店
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[14px]">
                <thead className="text-left text-[12.5px] text-ink-3">
                  <tr>
                    <th className="py-2 pr-3 font-medium">代码</th>
                    <th className="py-2 pr-3 font-medium">名称</th>
                    <th className="py-2 pr-3 font-medium">公司主体</th>
                    <th className="py-2 pr-3 font-medium">地址 · 电话</th>
                    <th className="py-2 pr-3 text-right font-medium">挂着的员工</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {data.data.stores.map((s) => (
                    <tr key={s.id} className="border-t border-line" data-testid={`store-row-${s.code}`}>
                      <td className="num py-2.5 pr-3 font-semibold">{s.code}</td>
                      <td className="py-2.5 pr-3">
                        {s.name}
                        {s.id === 1 && <span className="ml-1.5 text-[12px] text-ink-3">（本店）</span>}
                        {!s.active && (
                          <Badge tone="neutral" className="ml-1.5">
                            已停用
                          </Badge>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">{s.entityName}</td>
                      <td className="py-2.5 pr-3 text-ink-2">{[s.address, s.phone].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="num py-2.5 pr-3 text-right">{s.staffCount}</td>
                      <td className="py-2.5 text-right">
                        <Button size="sm" variant="ghost" onClick={() => setStore({ mode: 'edit', store: s })} data-testid={`store-edit-${s.code}`}>
                          修改
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-5" data-testid="entities-card">
            <div className="mb-3 flex items-center gap-3">
              <h2 className="flex-1 text-[16px] font-bold">公司主体</h2>
              <Button variant="secondary" onClick={() => setEntity({ mode: 'new' })} data-testid="entity-new">
                新建主体
              </Button>
            </div>
            <p className="mb-3 text-[13px] text-ink-3">合同、进项发票、付款、开票申请、银行账户按主体分；打印、导出里的「我方」抬头与税号取这里。</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[14px]">
                <thead className="text-left text-[12.5px] text-ink-3">
                  <tr>
                    <th className="py-2 pr-3 font-medium">名称（发票抬头）</th>
                    <th className="py-2 pr-3 font-medium">税号</th>
                    <th className="py-2 pr-3 font-medium">开户行 · 账号</th>
                    <th className="py-2 pr-3 text-right font-medium">门店</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {data.data.entities.map((e) => (
                    <tr key={e.id} className="border-t border-line" data-testid={`entity-row-${e.id}`}>
                      <td className="py-2.5 pr-3">
                        {e.name}
                        {!e.active && (
                          <Badge tone="neutral" className="ml-1.5">
                            已停用
                          </Badge>
                        )}
                      </td>
                      <td className="num py-2.5 pr-3">{e.taxNo || '—'}</td>
                      <td className="py-2.5 pr-3 text-ink-2">{[e.bankName, e.bankAccount].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="num py-2.5 pr-3 text-right">{e.storeCount}</td>
                      <td className="py-2.5 text-right">
                        <Button size="sm" variant="ghost" onClick={() => setEntity({ mode: 'edit', entity: e })} data-testid={`entity-edit-${e.id}`}>
                          修改
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {can('report.executive') && data.data.stores.filter((s) => s.active).length > 1 && <SettlementCard />}
        </div>
      )}
      {store && data.data && <StoreDialog target={store} entities={data.data.entities} onClose={() => setStore(null)} onSaved={() => void refresh()} />}
      {entity && <EntityDialog target={entity} onClose={() => setEntity(null)} onSaved={() => void refresh()} />}
    </AdminPage>
  );
}

function StoreDialog({ target, entities, onClose, onSaved }: { target: { mode: 'new' } | { mode: 'edit'; store: StoreView }; entities: EntityView[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const editing = target.mode === 'edit' ? target.store : null;
  const [draft, setDraft] = useState<StoreDraft>(
    editing
      ? { code: editing.code, name: editing.name, entityId: editing.entityId, address: editing.address, phone: editing.phone, sortOrder: editing.sortOrder, active: editing.active }
      : { code: '', name: '', entityId: entities.find((e) => e.active)?.id ?? 1, address: '', phone: '', sortOrder: 0, active: true },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (p: Partial<StoreDraft>) => setDraft((d) => ({ ...d, ...p }));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { code: draft.code, name: draft.name, entityId: draft.entityId, address: draft.address, phone: draft.phone, sortOrder: draft.sortOrder };
      if (editing) await api.put(`/api/admin/stores/${editing.id}`, { ...body, active: draft.active, version: editing.version });
      else await api.post('/api/admin/stores', body);
      toast({ tone: 'success', title: editing ? '门店已保存' : `已建门店「${draft.name}」` });
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
      open
      onClose={busy ? () => {} : onClose}
      title={editing ? `修改门店 ${editing.code}` : '新建门店'}
      description="门店代码 2–8 位字母或数字（例如 FT），建好以后员工、手牌、设备、客房、技师、桌台、空间都按店分开。"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!draft.code.trim() || !draft.name.trim()} onClick={() => void save()} data-testid="store-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="代码">
          <Input value={draft.code} maxLength={8} onChange={(e) => set({ code: e.target.value.toUpperCase() })} data-testid="store-code" />
        </Field>
        <Field label="名称">
          <Input value={draft.name} maxLength={32} onChange={(e) => set({ name: e.target.value })} data-testid="store-name" />
        </Field>
        <Field label="公司主体">
          <Select value={String(draft.entityId)} onChange={(e) => set({ entityId: Number(e.target.value) })} data-testid="store-entity">
            {entities
              .filter((e) => e.active || e.id === draft.entityId)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="排序">
          <Input type="number" value={draft.sortOrder} min={0} max={9999} onChange={(e) => set({ sortOrder: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="地址" className="sm:col-span-2">
          <Input value={draft.address} maxLength={120} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <Field label="电话">
          <Input value={draft.phone} maxLength={40} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        {editing && editing.id !== 1 && (
          <Field label="状态">
            <Select value={draft.active ? 'on' : 'off'} onChange={(e) => set({ active: e.target.value === 'on' })} data-testid="store-active">
              <option value="on">启用</option>
              <option value="off">停用</option>
            </Select>
          </Field>
        )}
      </div>
      {error && <p className="mt-3 text-[13.5px] text-clay" role="alert">{error}</p>}
    </Dialog>
  );
}

function EntityDialog({ target, onClose, onSaved }: { target: { mode: 'new' } | { mode: 'edit'; entity: EntityView }; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const editing = target.mode === 'edit' ? target.entity : null;
  const [draft, setDraft] = useState<EntityDraft>(
    editing
      ? { name: editing.name, taxNo: editing.taxNo, addressPhone: editing.addressPhone, bankName: editing.bankName, bankAccount: editing.bankAccount, active: editing.active }
      : { name: '', taxNo: '', addressPhone: '', bankName: '', bankAccount: '', active: true },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (p: Partial<EntityDraft>) => setDraft((d) => ({ ...d, ...p }));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { name: draft.name, taxNo: draft.taxNo, addressPhone: draft.addressPhone, bankName: draft.bankName, bankAccount: draft.bankAccount };
      if (editing) await api.put(`/api/admin/entities/${editing.id}`, { ...body, active: draft.active, version: editing.version });
      else await api.post('/api/admin/entities', body);
      toast({ tone: 'success', title: editing ? '主体已保存' : `已建主体「${draft.name}」` });
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
      open
      onClose={busy ? () => {} : onClose}
      title={editing ? `修改主体「${editing.name}」` : '新建公司主体'}
      description="名称就是发票抬头；税号、开户行与账号用在开票申请、合同与付款的打印里。"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!draft.name.trim()} onClick={() => void save()} data-testid="entity-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名称（发票抬头）" className="sm:col-span-2">
          <Input value={draft.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} data-testid="entity-name" />
        </Field>
        <Field label="税号">
          <Input value={draft.taxNo} maxLength={30} onChange={(e) => set({ taxNo: e.target.value })} data-testid="entity-tax" />
        </Field>
        <Field label="地址电话">
          <Input value={draft.addressPhone} maxLength={120} onChange={(e) => set({ addressPhone: e.target.value })} />
        </Field>
        <Field label="开户行">
          <Input value={draft.bankName} maxLength={60} onChange={(e) => set({ bankName: e.target.value })} />
        </Field>
        <Field label="账号">
          <Input value={draft.bankAccount} maxLength={40} onChange={(e) => set({ bankAccount: e.target.value })} />
        </Field>
        {editing && editing.id !== 1 && (
          <Field label="状态">
            <Select value={draft.active ? 'on' : 'off'} onChange={(e) => set({ active: e.target.value === 'on' })}>
              <option value="on">启用</option>
              <option value="off">停用</option>
            </Select>
          </Field>
        )}
      </div>
      {error && <p className="mt-3 text-[13.5px] text-clay" role="alert">{error}</p>}
    </Dialog>
  );
}

/** 门店之间的储值结算（只是报表）：默认看本月 1 号到今天的营业日 */
function SettlementCard() {
  const session = useSession();
  const today = session.today;
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const report = useQuery({
    queryKey: ['reports', 'store-settlement', from, to],
    queryFn: () => api.get<StoreSettlementReport>(`/api/reports/store-settlement?from=${from}&to=${to}`),
    enabled: !!from && !!to && from <= to,
  });
  const name = (id: number) => report.data?.stores.find((s) => Number(s.id) === id)?.name ?? `门店 ${id}`;
  return (
    <Card className="p-5" data-testid="store-settlement">
      <div className="mb-1 flex flex-wrap items-end gap-3">
        <h2 className="flex-1 text-[16px] font-bold">门店之间的储值结算</h2>
        <Field label="从">
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} data-testid="settle-from" />
        </Field>
        <Field label="到">
          <Input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} data-testid="settle-to" />
        </Field>
      </div>
      <p className="mb-3 text-[13px] text-ink-3">
        会员在开卡店（第一笔充值所在的门店）以外的门店用储值：开卡店收着钱、别家店做了服务。时段内的储值消费计正、撤销冲回；只是报表，不记账。
      </p>
      {report.isPending ? (
        <Skeleton className="h-24" />
      ) : report.isError && !report.data ? (
        <LoadFailed title="储值结算取不回来，请检查网络" onRetry={() => void report.refetch()} retrying={report.isFetching} testId="store-settlement-error" />
      ) : report.data.pairs.length === 0 ? (
        <p className="py-6 text-center text-[14px] text-ink-3" data-testid="store-settlement-empty">
          这段时间没有跨店用储值的
        </p>
      ) : (
        <div className="grid gap-4">
          <table className="w-full text-[14px]">
            <thead className="text-left text-[12.5px] text-ink-3">
              <tr>
                <th className="py-2 pr-3 font-medium">开卡店</th>
                <th className="py-2 pr-3 font-medium">消费店</th>
                <th className="py-2 pr-3 text-right font-medium">笔数</th>
                <th className="py-2 pr-3 text-right font-medium">本金</th>
                <th className="py-2 text-right font-medium">赠金</th>
              </tr>
            </thead>
            <tbody>
              {report.data.pairs.map((p) => (
                <tr key={`${p.homeStoreId}-${p.spendStoreId}`} className="border-t border-line" data-testid={`settle-pair-${p.homeStoreId}-${p.spendStoreId}`}>
                  <td className="py-2 pr-3">{name(p.homeStoreId)}</td>
                  <td className="py-2 pr-3">{name(p.spendStoreId)}</td>
                  <td className="num py-2 pr-3 text-right">{p.count}</td>
                  <td className="num py-2 pr-3 text-right">{formatYuan(p.principal)}</td>
                  <td className="num py-2 text-right text-ink-2">{formatYuan(p.bonus)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rounded-md bg-paper-2 px-4 py-3 text-[14px]" data-testid="store-settlement-net">
            <p className="mb-1 font-semibold">两两轧差（本金）</p>
            {report.data.net.map((n) => (
              <p key={`${n.fromStoreId}-${n.toStoreId}`}>
                {name(n.fromStoreId)} 应付 {name(n.toStoreId)} <span className="num font-semibold">{formatYuan(n.principal)}</span>
              </p>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
