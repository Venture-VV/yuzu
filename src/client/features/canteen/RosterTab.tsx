// 员工名单：员工扫注册二维码自己登记的（第二期）、后台单个加、粘贴一批加；修改（工号、部门、角色）与停用、重新开通、打印开通卡片。
// 写操作都是「原样重试不会重复」：结果不确定时刷新名单核对，或者原样再点一次（同一个工号、同一个版本号、同一个操作编号）。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Search, UsersRound } from 'lucide-react';
import { CANTEEN_ROLE_LABELS, displayActivationCode, displayPhone, type ActivationCard, type BatchPreviewRow, type CanteenEmployeeRow, type CanteenRole } from '@shared/canteen';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { relativeTime, uuid } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { EmptyState } from '../../components/EmptyState';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { PrintButton } from '../print/PrintButton';
import { useOverview } from './CanteenPage';

type Filter = 'all' | 'self' | 'pending' | 'activated' | 'inactive';
const ROLE_TONE: Record<CanteenRole, 'neutral' | 'yuzu' | 'pine'> = { staff: 'neutral', cook: 'yuzu', manager: 'pine' };
const uncertainHint = '结果不确定：刷新名单看看加上没有；原样再点一次也不会重复';

export const useDepartments = () => useQuery({ queryKey: ['canteen', 'departments'], queryFn: () => api.get<{ id: number; name: string }[]>('/api/erp/canteen/departments') });

export function RosterTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['canteen', 'employees'], queryFn: () => api.get<CanteenEmployeeRow[]>('/api/erp/canteen/employees') });
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<CanteenEmployeeRow | 'new' | null>(null);
  const [batch, setBatch] = useState(false);
  const [reissue, setReissue] = useState<CanteenEmployeeRow | null>(null);
  const [card, setCard] = useState<ActivationCard | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['canteen'] });
  };
  const rows = useMemo(() => {
    const kw = q.trim().toUpperCase();
    return (list.data ?? []).filter((e) => {
      if (kw && !e.empNo.includes(kw) && !e.name.toUpperCase().includes(kw) && !(e.username ?? '').toUpperCase().includes(kw) && !(e.phone ?? '').includes(kw)) return false;
      if (filter === 'self') return e.source === 'self';
      if (filter === 'pending') return e.active && !e.activated;
      if (filter === 'activated') return e.active && e.activated;
      if (filter === 'inactive') return !e.active;
      return true;
    });
  }, [list.data, q, filter]);
  const pendingCards = (list.data ?? []).filter((e) => e.active && e.activationPending).length;

  return (
    <div className="space-y-4" data-testid="canteen-roster">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input className="pl-9" placeholder="搜工号、姓名、用户名或手机号" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜工号或姓名" />
        </div>
        <Segmented<Filter>
          size="sm"
          value={filter}
          onChange={setFilter}
          ariaLabel="筛选"
          options={[
            { value: 'all', label: '全部' },
            { value: 'self', label: '自己登记的' },
            { value: 'pending', label: '待开通' },
            { value: 'activated', label: '已开通' },
            { value: 'inactive', label: '已停用' },
          ]}
        />
        <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="canteen-add">
          加一位
        </Button>
        <Button variant="secondary" icon={<UsersRound className="size-4" />} onClick={() => setBatch(true)} data-testid="canteen-batch">
          粘贴一批
        </Button>
        {pendingCards > 0 && (
          <PrintButton path="/print/canteen-cards/all" paper="a4" testId="canteen-print-all">
            {`打印开通卡片（${pendingCards}）`}
          </PrintButton>
        )}
      </div>

      {list.isLoading ? (
        <Skeleton className="h-48" />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            art="leaf"
            title={list.data?.length ? '没有符合条件的员工' : '名单还是空的'}
            description="在「设置」里打开自己登记，大家扫注册二维码自己登记；没手机的同事在这里单个加，或者把「工号 姓名 部门」一行一位粘贴进来。"
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <thead className="border-b border-line text-left text-[12px] text-ink-3">
              <tr>
                <th className="px-4 py-2.5 font-semibold">员工</th>
                <th className="px-3 py-2.5 font-semibold">部门</th>
                <th className="px-3 py-2.5 font-semibold">角色</th>
                <th className="px-3 py-2.5 font-semibold">柚子饭堂</th>
                <th className="px-3 py-2.5 font-semibold">最近用过</th>
                <th className="px-4 py-2.5 text-right font-semibold">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((e) => (
                <tr key={e.id} className={e.active ? '' : 'text-ink-3'} data-testid={`canteen-row-${e.empNo}`}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[22px]">{e.avatar}</span>
                      <div>
                        <p className="flex items-center gap-1.5 font-semibold">
                          {e.name}
                          {e.source === 'self' && <Badge tone="lake">自己登记</Badge>}
                        </p>
                        <p className="num text-[12px] text-ink-3">
                          {e.empNo}
                          {e.username && e.username !== e.name && ` · 用户名 ${e.username}`}
                          {e.phone && ` · ${displayPhone(e.phone)}`}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">{e.department || <span className="text-ink-4">—</span>}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={ROLE_TONE[e.role]}>{CANTEEN_ROLE_LABELS[e.role]}</Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    {!e.active ? (
                      <Badge tone="neutral">已停用</Badge>
                    ) : e.activated ? (
                      <Badge tone="pine">已开通</Badge>
                    ) : e.activationPending ? (
                      <Badge tone="yuzu">待开通 · {e.activationExpiresAt ? `${e.activationExpiresAt.slice(5, 10)} 前` : ''}</Badge>
                    ) : (
                      <Badge tone="clay">开通码过期</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-ink-3">{e.lastSeenAt ? relativeTime(e.lastSeenAt) : '—'}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1">
                      {e.active && e.activationPending && (
                        <PrintButton path={`/print/canteen-cards/${e.id}`} paper="a4" size="sm" testId={`canteen-print-${e.empNo}`}>
                          开通卡片
                        </PrintButton>
                      )}
                      {e.active && (
                        <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setReissue(e)}>
                          重新开通
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(e)} data-testid={`canteen-edit-${e.empNo}`}>
                        修改
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <EmployeeDialog
        open={editing !== null}
        row={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(created) => {
          setEditing(null);
          refresh();
          if (created) setCard(created);
        }}
      />
      <BatchDialog open={batch} onClose={() => setBatch(false)} onDone={refresh} />
      <ReissueDialog
        row={reissue}
        onClose={() => setReissue(null)}
        onDone={(c) => {
          setReissue(null);
          refresh();
          setCard(c);
        }}
      />
      <Dialog open={!!card} onClose={() => setCard(null)} title="开通卡片准备好了">
        {card && (
          <div className="space-y-3" data-testid="canteen-new-card">
            <p className="text-[14px]">
              <b>{card.name}</b>（{card.empNo}）的开通码：
            </p>
            <p className="num rounded-lg bg-yuzu-tint py-3 text-center font-mono text-[28px] font-bold tracking-[0.25em]" data-testid="canteen-activation-code">
              {displayActivationCode(card.code)}
            </p>
            <p className="text-[13px] text-ink-3">7 天内有效。打印开通卡片交给本人；也可以让本人打开柚子饭堂、点「我有开通码」输入。</p>
            <PrintButton path={`/print/canteen-cards/${card.employeeId}`} paper="a4">
              打印这张开通卡片
            </PrintButton>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function EmployeeDialog({ open, row, onClose, onSaved }: { open: boolean; row: CanteenEmployeeRow | null; onClose: () => void; onSaved: (created: ActivationCard | null) => void }) {
  const toast = useToast();
  const departments = useDepartments();
  const overview = useOverview();
  const canteenDept = overview.data?.settings.departmentId ?? null;
  const [form, setForm] = useState({ empNo: '', name: '', departmentId: '' as string, role: 'staff' as CanteenRole, active: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useResetOnOpen(open, () => {
    setError('');
    setForm(row ? { empNo: row.empNo, name: row.name, departmentId: row.departmentId ? String(row.departmentId) : '', role: row.role, active: row.active } : { empNo: '', name: '', departmentId: '', role: 'staff', active: true });
  }, [row?.id]);

  const save = async () => {
    setBusy(true);
    setError('');
    const body = { empNo: form.empNo, name: form.name, departmentId: form.departmentId ? Number(form.departmentId) : null, role: form.role };
    try {
      if (row) {
        await api.put(`/api/erp/canteen/employees/${row.id}`, { ...body, active: form.active, version: row.version });
        toast({ tone: 'success', title: `${form.name} 改好了` });
        onSaved(null);
      } else {
        const r = await api.post<{ employee: CanteenEmployeeRow; created: boolean }>('/api/erp/canteen/employees', body);
        const [c] = await api.get<ActivationCard[]>(`/api/erp/canteen/activation-cards?ids=${r.employee.id}`);
        toast({ tone: 'success', title: r.created ? `加上了 ${r.employee.name}` : `${r.employee.name} 已经在名单里了` });
        onSaved(c ?? null);
      }
    } catch (e) {
      setError(e instanceof UncertainError ? uncertainHint : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const roleNeedsDept = form.role !== 'staff';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={row ? `修改 ${row.name}` : '加一位员工'}
      description="员工账号只能登录手机上的柚子饭堂，进不了管理后台。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!form.empNo.trim() || !form.name.trim()} data-testid="canteen-save-employee">
            {row ? '保存' : '加上并生成开通码'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="工号" hint="字母、数字和短横线，例如 A012">
          <Input value={form.empNo} onChange={(e) => setForm({ ...form, empNo: e.target.value.toUpperCase() })} maxLength={16} data-autofocus aria-label="工号" />
        </Field>
        <Field label="姓名">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={16} aria-label="姓名" />
        </Field>
        <Field label="角色" className="sm:col-span-2" hint={roleNeedsDept ? '厨师、负责人要在食堂部门里' : '普通员工：看菜单、点赞、亮饭卡码'}>
          <Segmented<CanteenRole>
            value={form.role}
            onChange={(role) => setForm({ ...form, role, departmentId: role !== 'staff' && canteenDept ? String(canteenDept) : form.departmentId })}
            ariaLabel="角色"
            options={[
              { value: 'staff', label: '员工' },
              { value: 'cook', label: '厨师' },
              { value: 'manager', label: '食堂负责人' },
            ]}
          />
        </Field>
        <Field label="部门" className="sm:col-span-2">
          <Select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} aria-label="部门">
            <option value="">（不填）</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.id === canteenDept ? '（食堂部门）' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {row && (
          <Field label="状态" className="sm:col-span-2" hint={form.active ? undefined : '停用后马上失效：他手机上的登录和饭卡码都不能用了'}>
            <Segmented<'on' | 'off'>
              value={form.active ? 'on' : 'off'}
              onChange={(v) => setForm({ ...form, active: v === 'on' })}
              ariaLabel="状态"
              options={[
                { value: 'on', label: '在用' },
                { value: 'off', label: '停用' },
              ]}
            />
          </Field>
        )}
      </div>
      {error && (
        <Notice tone="error" className="mt-4">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}

function BatchDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<BatchPreviewRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (apply: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ rows: BatchPreviewRow[]; created: number }>('/api/erp/canteen/employees/batch', { text, apply });
      setRows(r.rows);
      if (apply) {
        toast({ tone: 'success', title: `加上了 ${r.created} 位`, body: '在名单里点「打印开通卡片」发给大家' });
        onDone();
        setText('');
        setRows(null);
        onClose();
      }
    } catch (e) {
      setError(e instanceof UncertainError ? uncertainHint : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const fresh = rows?.filter((r) => r.status === 'new').length ?? 0;
  const bad = rows?.filter((r) => r.status === 'error').length ?? 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title="粘贴一批员工"
      description="一行一位：工号 姓名 部门（用空格、Tab 或逗号隔开；部门可以不写，要和已有的部门同名）。都先加成普通员工，厨师和负责人单独改。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="secondary" onClick={() => void run(false)} loading={busy && !rows} disabled={!text.trim()} data-testid="canteen-batch-preview">
            预览
          </Button>
          <Button onClick={() => void run(true)} loading={busy && !!rows} disabled={!rows || bad > 0 || fresh === 0} data-testid="canteen-batch-apply">
            加进名单（{fresh} 位）
          </Button>
        </>
      }
    >
      <Textarea
        rows={7}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setRows(null);
        }}
        placeholder={'A001 小林 前厅\nA002 小周 后厨\nB013 阿美'}
        className="font-mono text-[13px]"
        aria-label="名单"
      />
      {error && (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      )}
      {rows && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-line">
          <table className="w-full text-[13px]">
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.line} className={r.status === 'error' ? 'bg-clay-soft/40' : ''}>
                  <td className="num w-10 px-3 py-1.5 text-ink-3">{r.line}</td>
                  <td className="num px-2 py-1.5 font-semibold">{r.empNo}</td>
                  <td className="px-2 py-1.5">{r.name}</td>
                  <td className="px-2 py-1.5 text-ink-3">{r.department}</td>
                  <td className="px-3 py-1.5 text-right">
                    {r.status === 'new' ? <Badge tone="pine">新加</Badge> : r.status === 'same' ? <Badge tone="neutral">已有，跳过</Badge> : <span className="text-[12.5px] font-semibold text-clay">{r.message}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

function ReissueDialog({ row, onClose, onDone }: { row: CanteenEmployeeRow | null; onClose: () => void; onDone: (card: ActivationCard) => void }) {
  const [clientKey, setClientKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!row) return;
    setBusy(true);
    setError('');
    try {
      const c = await api.post<ActivationCard>(`/api/erp/canteen/employees/${row.id}/activation`, { clientKey });
      setClientKey(uuid());
      onDone(c);
    } catch (e) {
      // 结果不确定：同一个编号再点一次，拿到的是同一张开通码
      setError(e instanceof UncertainError ? '结果不确定：再点一次「重新开通」（同一个编号，不会作废两次）' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!row}
      onClose={onClose}
      title={`重新开通 ${row?.name ?? ''}`}
      description="忘了密码、换了手机、开通码过期时用。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" onClick={() => void go()} loading={busy} data-testid="canteen-reissue-confirm">
            重新开通
          </Button>
        </>
      }
    >
      <p className="text-[14px] leading-relaxed text-ink-2">重新开通后，他手机上的登录、饭卡码和原来的密码马上作废；要用新的开通卡片重新设密码。</p>
      {error && (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}
