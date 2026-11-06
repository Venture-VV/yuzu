import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { Check, Clipboard, ExternalLink, Plus, RefreshCw, Utensils } from 'lucide-react';
import { CANTEEN_MEALS, CANTEEN_MEAL_LABELS, type CanteenCheckin, type CanteenEmployee, type CanteenMeal, type CanteenMenu, type CanteenMenuInput, type CanteenRole } from '@shared/canteen';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { uuid } from '../../lib/utils';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useCanteenOperation } from './pending';

type Employee = CanteenEmployee & { version: number };
interface Department { id: number; name: string; active: boolean }
interface Overview {
  settings: { departmentId: number | null; version: number };
  departments: Department[];
  employees: Employee[];
  sync: { configured: boolean; lastSuccessAt: string | null; lastError: string | null; pending: boolean; portalUrl: string | null };
  menus: CanteenMenu[];
}
type Tab = 'employees' | 'menus' | 'checkins';
type Operation = ReturnType<typeof useCanteenOperation>;
const BASE = '/api/erp/canteen';
const ROLE_LABELS: Record<CanteenRole, string> = { employee: '员工', chef: '厨师', manager: '食堂负责人' };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const clock = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value)) : '尚未同步';

export function CanteenPage() {
  const session = useSession();
  return <CanteenContent key={session.staff.id} />;
}

function CanteenContent() {
  const can = useCan();
  const allowed = can('canteen.manage');
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('employees');
  const [date, setDate] = useState(today);
  const [notice, setNotice] = useState('');
  const [temporary, setTemporary] = useState<{ label: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [formVersion, setFormVersion] = useState(0);
  const overview = useQuery({ queryKey: ['canteen', 'overview'], queryFn: () => api.get<Overview>(`${BASE}/overview`), enabled: allowed, refetchInterval: 30_000 });
  const menus = useQuery({ queryKey: ['canteen', 'menus', date], queryFn: () => api.get<{ menus: CanteenMenu[] }>(`${BASE}/menus?date=${date}`), enabled: allowed && tab === 'menus' });
  const checkins = useQuery({ queryKey: ['canteen', 'checkins', date], queryFn: () => api.get<{ checkins: CanteenCheckin[] }>(`${BASE}/checkins?date=${date}`), enabled: allowed && tab === 'checkins', refetchInterval: 30_000 });
  const op = useCanteenOperation(async (result, label) => {
    const password = (result as { temporaryPassword?: string } | null)?.temporaryPassword;
    if (password) { setTemporary({ label, password }); setCopied(false); }
    setNotice(`${label}成功。人员变更以员工服务同步完成为准。`);
    setFormVersion(v => v + 1);
    await qc.invalidateQueries({ queryKey: ['canteen'] });
  });
  if (!allowed) return <Navigate to="/erp" replace />;

  async function syncNow() {
    setSyncing(true); setSyncError('');
    try {
      await api.post(`${BASE}/sync`, {}, { timeoutMs: 30_000 });
      setNotice('员工名单、菜单和打卡记录已同步。');
      await qc.invalidateQueries({ queryKey: ['canteen'] });
    } catch (err) { setSyncError(errorMessage(err)); }
    finally { setSyncing(false); }
  }

  async function copyPassword() {
    if (!temporary) return;
    try { await navigator.clipboard.writeText(temporary.password); setCopied(true); }
    catch { setCopied(false); setSyncError('无法访问剪贴板，请选中临时密码手动复制。'); }
  }

  return (
    <ErpPage title="员工食堂" description="管理员工端资格、每日菜单和食堂打卡。员工账号独立于门店后台权限。"
      actions={<Button icon={<RefreshCw className="size-4" />} loading={syncing} disabled={!overview.data?.sync.configured || op.busy} onClick={() => void syncNow()} data-testid="canteen-sync">立即同步</Button>}>
      <div className="space-y-4" data-testid="canteen-page">
        {overview.error && <Notice tone="error" title={errorMessage(overview.error)} />}
        {syncError && <Notice tone="error" title={syncError} />}
        {notice && <Notice tone="success" title={notice} />}
        {temporary && <Notice tone="info" title="请将临时密码交给本人" data-testid="canteen-temporary-password">
          <p>{temporary.label}。员工首次登录后需要修改密码，关闭后不再在本页展示。</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <code className="select-all break-all rounded-sm bg-card px-3 py-2 font-semibold text-ink">{temporary.password}</code>
            <Button size="sm" icon={copied ? <Check className="size-4" /> : <Clipboard className="size-4" />} onClick={() => void copyPassword()}>{copied ? '已复制' : '复制密码'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setTemporary(null)}>已交付，关闭</Button>
          </div>
        </Notice>}
        {op.pending?.uncertain && <Notice tone="warning" title={`${op.pending.label}：结果待确认`} data-testid="canteen-pending"
          action={<><Button size="sm" variant="primary" loading={op.busy} onClick={() => void op.retry()}>按原内容重新提交</Button>{op.canAbandon && <Button size="sm" disabled={op.busy} onClick={() => void op.abandon()} data-testid="canteen-abandon">确认作废原操作</Button>}</>}>
          请求可能已经生效。重新提交会使用同一个操作编号，不另建一条；确认前请勿重复操作。
        </Notice>}
        {op.message && <Notice tone="info" title={op.message} />}
        {op.error && <Notice tone="error" title={op.error} />}
        {!overview.data ? <Skeleton className="h-48" /> : <>
          <SyncStatus data={overview.data} />
          <SettingsPanel key={`${overview.data.settings.version}-${formVersion}`} data={overview.data} op={op} />
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="max-w-full overflow-x-auto">
              <Segmented<Tab> value={tab} onChange={setTab} ariaLabel="员工食堂分页" options={[{ value: 'employees', label: '员工名册' }, { value: 'menus', label: '每日菜单' }, { value: 'checkins', label: '打卡记录' }]} />
            </div>
            {tab !== 'employees' && <Field label="日期（北京时间）" htmlFor="canteen-date"><Input type="date" id="canteen-date" value={date} onChange={e => e.target.value && setDate(e.target.value)} data-testid="canteen-date" /></Field>}
          </div>
          {tab === 'employees' && <EmployeesPanel key={formVersion} data={overview.data} op={op} />}
          {tab === 'menus' && (menus.error ? <Notice tone="error" title={errorMessage(menus.error)} /> : !menus.data ? <Skeleton className="h-40" /> : <MenusPanel key={`${date}-${formVersion}`} date={date} menus={menus.data.menus} configured={overview.data.sync.configured} op={op} />)}
          {tab === 'checkins' && (checkins.error ? <Notice tone="error" title={errorMessage(checkins.error)} /> : !checkins.data ? <Skeleton className="h-40" /> : <CheckinsPanel items={checkins.data.checkins} />)}
        </>}
      </div>
    </ErpPage>
  );
}

function SyncStatus({ data }: { data: Overview }) {
  const syncedAge = data.sync.lastSuccessAt ? Date.now() - Date.parse(data.sync.lastSuccessAt) : Infinity;
  const healthy = data.sync.configured && !data.sync.lastError && !data.sync.pending && syncedAge < 300_000;
  const url = data.sync.portalUrl;
  const safeUrl = url && /^https?:\/\//i.test(url) ? url : null;
  return <Card className="p-4" data-testid="canteen-sync-status">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="flex items-center gap-2 font-semibold"><Utensils className="size-4 text-pine" />员工服务<Badge tone={healthy ? 'moss' : 'ember'}>{!data.sync.configured ? '尚未连接' : healthy ? '同步正常' : '等待同步'}</Badge></p>
        <p className="mt-1 text-[13px] text-ink-3">最近成功同步：{clock(data.sync.lastSuccessAt)}</p>
      </div>
      {safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold text-pine hover:underline">打开员工 Web App <ExternalLink className="size-4" /></a>}
    </div>
    {data.sync.lastError && <p className="mt-2 break-words text-sm text-clay">{data.sync.lastError}</p>}
    {!data.sync.configured && <p className="mt-2 text-sm text-ink-3">员工服务连接完成后，可以发布菜单并接收打卡记录。</p>}
    {data.sync.pending && <p className="mt-2 text-sm text-yuzu-deep">有人员或权限变更尚未同步到员工端。</p>}
    {data.sync.configured && syncedAge >= 300_000 && <p className="mt-2 text-sm text-clay">员工名单长时间未同步，员工服务将暂停发码与核验；恢复同步后再打卡。</p>}
  </Card>;
}

function SettingsPanel({ data, op }: { data: Overview; op: Operation }) {
  const [departmentId, setDepartmentId] = useState(data.settings.departmentId ? String(data.settings.departmentId) : '');
  return <Card className="p-4">
    <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); void op.submit('保存食堂部门', 'PUT', `${BASE}/settings`, { departmentId: Number(departmentId), version: data.settings.version }, false); }}>
      <Field label="食堂所属部门" htmlFor="canteen-department" hint="厨师和食堂负责人需要归属这个部门。" className="min-w-0 flex-1">
        <Select id="canteen-department" required value={departmentId} onChange={e => setDepartmentId(e.target.value)} disabled={op.busy || !!op.pending} data-testid="canteen-department">
          <option value="">请选择食堂部门</option>
          {data.departments.filter(d => d.active || d.id === data.settings.departmentId).map(d => <option key={d.id} value={d.id} disabled={!d.active}>{d.name}{d.active ? '' : '（已停用）'}</option>)}
        </Select>
      </Field>
      <Button type="submit" disabled={!departmentId || op.busy || !!op.pending || Number(departmentId) === data.settings.departmentId} data-testid="canteen-save-settings">保存部门</Button>
    </form>
    {!data.departments.some(d => d.active) && <p className="mt-2 text-sm text-ink-3">请先在 ERP 库存的部门档案中建立食堂部门。</p>}
  </Card>;
}

function EmployeesPanel({ data, op }: { data: Overview; op: Operation }) {
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const [search, setSearch] = useState('');
  const rows = data.employees.filter(e => `${e.employeeNo} ${e.name} ${e.departmentName}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="space-y-3" data-testid="canteen-employees">
    <div className="flex flex-wrap items-center gap-3">
      <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索工号、姓名或部门" aria-label="搜索员工" className="min-w-0 flex-1" />
      <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} disabled={op.busy || !!op.pending} data-testid="canteen-create-employee">新增员工</Button>
    </div>
    {editing && <EmployeeForm key={editing === 'new' ? 'new' : editing.id} employee={editing === 'new' ? null : editing} data={data} op={op} onClose={() => setEditing(null)} />}
    {rows.length === 0 ? <Card className="p-8 text-center text-sm text-ink-3">暂无员工。新增工号后，同步至员工服务即可登录。</Card> : <div className="space-y-2">
      {rows.map(employee => <Card key={employee.id} className="flex flex-wrap items-center gap-3 p-4" data-testid={`canteen-employee-${employee.employeeNo}`}>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold"><span>{employee.name}</span><span className="num text-sm text-ink-3">{employee.employeeNo}</span><Badge tone={employee.active ? 'moss' : 'neutral'}>{employee.active ? '已启用' : '已停用'}</Badge></p>
          <p className="mt-1 text-sm text-ink-3">{employee.departmentName} · {ROLE_LABELS[employee.role]}</p>
        </div>
        <Button size="sm" onClick={() => setEditing(employee)} disabled={op.busy || !!op.pending} aria-label={`编辑 ${employee.employeeNo}`}>编辑</Button>
        <Button size="sm" variant="ghost" disabled={op.busy || !!op.pending || !employee.active} onClick={() => {
          if (window.confirm(`重置 ${employee.name}（${employee.employeeNo}）的员工端密码？同步后其已有登录会话将失效。`)) void op.submit(`重置 ${employee.employeeNo} 密码`, 'POST', `${BASE}/employees/${employee.id}/reset-password`, {});
        }}>重设密码</Button>
      </Card>)}
    </div>}
  </div>;
}

function EmployeeForm({ employee, data, op, onClose }: { employee: Employee | null; data: Overview; op: Operation; onClose: () => void }) {
  const [employeeNo, setEmployeeNo] = useState(employee?.employeeNo ?? '');
  const [name, setName] = useState(employee?.name ?? '');
  const [departmentId, setDepartmentId] = useState(employee ? String(employee.departmentId) : '');
  const [role, setRole] = useState<CanteenRole>(employee?.role ?? 'employee');
  const [active, setActive] = useState(employee?.active ?? true);
  const roleDepartmentMismatch = role !== 'employee' && Number(departmentId) !== data.settings.departmentId;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (employee) void op.submit(`保存 ${employeeNo}`, 'PUT', `${BASE}/employees/${employee.id}`, { name: name.trim(), departmentId: Number(departmentId), role, active, version: employee.version }, false);
    else void op.submit(`创建 ${employeeNo.trim()}`, 'POST', `${BASE}/employees`, { employeeNo: employeeNo.trim(), name: name.trim(), departmentId: Number(departmentId), role });
  }
  return <Card className="p-4" data-testid="canteen-employee-form">
    <SectionTitle>{employee ? '编辑员工' : '新增员工端账号'}</SectionTitle>
    <form className="mt-3 space-y-3" onSubmit={submit}>
      <fieldset disabled={op.busy || !!op.pending} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="工号" htmlFor="canteen-employee-no"><Input id="canteen-employee-no" required maxLength={32} value={employeeNo} onChange={e => setEmployeeNo(e.target.value)} disabled={!!employee} autoComplete="off" data-testid="canteen-employee-no" /></Field>
        <Field label="姓名" htmlFor="canteen-employee-name"><Input id="canteen-employee-name" required maxLength={40} value={name} onChange={e => setName(e.target.value)} data-testid="canteen-employee-name" /></Field>
        <Field label="所属部门" htmlFor="canteen-employee-department"><Select id="canteen-employee-department" required value={departmentId} onChange={e => setDepartmentId(e.target.value)} data-testid="canteen-employee-department"><option value="">请选择部门</option>{data.departments.filter(d => d.active || d.id === employee?.departmentId).map(d => <option value={d.id} key={d.id} disabled={!d.active}>{d.name}{d.active ? '' : '（已停用）'}</option>)}</Select></Field>
        <Field label="员工端身份" htmlFor="canteen-employee-role"><Select id="canteen-employee-role" value={role} onChange={e => setRole(e.target.value as CanteenRole)} data-testid="canteen-employee-role"><option value="employee">员工：查看菜单、出示员工码</option><option value="chef">厨师：另可发布菜单</option><option value="manager">食堂负责人：另可发布菜单、扫码打卡</option></Select></Field>
        {employee && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="size-4 accent-[var(--color-pine)]" data-testid="canteen-employee-active" />启用员工端资格</label>}
      </fieldset>
      {roleDepartmentMismatch && <Notice tone="warning" title="厨师和食堂负责人必须属于已设置的食堂部门。" />}
      {!employee && <p className="text-sm text-ink-3">系统生成临时密码，首次登录需修改。这个账号不会获得 ERP 登录权限。</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" variant="primary" loading={op.busy} disabled={!!op.pending || roleDepartmentMismatch || !departmentId} data-testid="canteen-save-employee">{employee ? '保存员工' : '创建员工账号'}</Button><Button onClick={onClose} disabled={op.busy}>取消</Button></div>
    </form>
  </Card>;
}

function MenusPanel({ date, menus, configured, op }: { date: string; menus: CanteenMenu[]; configured: boolean; op: Operation }) {
  const [editing, setEditing] = useState<CanteenMenu | CanteenMeal | null>(null);
  return <div className="space-y-3" data-testid="canteen-menus">
    {!configured && <Notice tone="info" title="连接员工服务后可保存和发布菜单。" />}
    {editing && <MenuForm key={typeof editing === 'string' ? editing : editing.id} date={date} menu={typeof editing === 'string' ? null : editing} meal={typeof editing === 'string' ? editing : editing.meal} op={op} onClose={() => setEditing(null)} />}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {CANTEEN_MEALS.map(meal => {
        const menu = menus.find(m => m.meal === meal && m.date === date);
        return <Card key={meal} className="flex flex-col p-4" data-testid={`canteen-menu-${meal}`}>
          <div className="flex items-center justify-between gap-2"><h2 className="font-bold">{CANTEEN_MEAL_LABELS[meal]}</h2>{menu && <Badge tone={menu.published ? 'moss' : 'neutral'}>{menu.published ? '已发布' : '草稿'}</Badge>}</div>
          <div className="my-3 min-h-24 flex-1">{menu ? <><h3 className="font-semibold">{menu.title}</h3><ul className="mt-2 space-y-1 text-sm text-ink-2">{menu.dishes.map((dish, index) => <li key={`${index}-${dish}`} className="break-words">{dish}</li>)}</ul>{menu.notes && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-3">{menu.notes}</p>}</> : <p className="text-sm text-ink-3">还没有安排菜单</p>}</div>
          {menu && <p className="mb-3 text-xs text-ink-3">更新于 {clock(menu.updatedAt)}</p>}
          <Button size="sm" disabled={!configured || op.busy || !!op.pending} onClick={() => setEditing(menu ?? meal)} data-testid={`canteen-edit-${meal}`}>{menu ? '编辑菜单' : '安排菜单'}</Button>
        </Card>;
      })}
    </div>
  </div>;
}

function MenuForm({ date, menu, meal, op, onClose }: { date: string; menu: CanteenMenu | null; meal: CanteenMeal; op: Operation; onClose: () => void }) {
  const [id] = useState(menu?.id ?? uuid());
  const [title, setTitle] = useState(menu?.title ?? `${CANTEEN_MEAL_LABELS[meal]}菜单`);
  const [dishes, setDishes] = useState(menu?.dishes.join('\n') ?? '');
  const [notes, setNotes] = useState(menu?.notes ?? '');
  const [published, setPublished] = useState(menu?.published ?? true);
  const dishItems = dishes.split('\n').map(s => s.trim()).filter(Boolean);
  const dishesError = dishItems.length > 30 ? '每份菜单最多填写 30 道菜。' : dishItems.some(dish => dish.length > 80) ? '每道菜的名称不能超过 80 字。' : '';
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !dishItems.length || dishesError) return;
    const input: CanteenMenuInput = { id, date, meal, title: title.trim(), dishes: dishItems, notes: notes.trim(), published, version: menu?.version ?? 0 };
    void op.submit(`${published ? '发布' : '保存'}${date} ${CANTEEN_MEAL_LABELS[meal]}菜单`, 'POST', `${BASE}/menus`, { menu: input });
  }
  return <Card className="p-4" data-testid="canteen-menu-form">
    <SectionTitle>{date} · {CANTEEN_MEAL_LABELS[meal]}</SectionTitle>
    <form onSubmit={submit} className="mt-3 space-y-3">
      <fieldset disabled={op.busy || !!op.pending} className="min-w-0 space-y-3">
        <Field label="菜单标题" htmlFor="canteen-menu-title"><Input id="canteen-menu-title" required value={title} maxLength={80} onChange={e => setTitle(e.target.value)} data-testid="canteen-menu-title" /></Field>
        <Field label="菜品（每行一道）" htmlFor="canteen-menu-dishes" hint="填写 1–30 道菜，每道菜的名称最多 80 字。"><Textarea id="canteen-menu-dishes" required rows={5} maxLength={2429} value={dishes} onChange={e => setDishes(e.target.value)} aria-invalid={!!dishesError} aria-describedby={dishesError ? 'canteen-dishes-error' : undefined} placeholder={'番茄炒蛋\n香菇炖鸡\n清炒时蔬\n紫菜蛋花汤'} data-testid="canteen-menu-dishes" /></Field>
        {dishesError && <p id="canteen-dishes-error" role="alert" className="text-sm text-clay">{dishesError}</p>}
        <Field label="备注" htmlFor="canteen-menu-notes" hint="可注明供餐时间、辣度和过敏原。"><Textarea id="canteen-menu-notes" maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} data-testid="canteen-menu-notes" /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={published} onChange={e => setPublished(e.target.checked)} className="size-4 accent-[var(--color-pine)]" data-testid="canteen-menu-published" />发布给员工查看</label>
      </fieldset>
      <div className="flex flex-wrap gap-2"><Button type="submit" variant="primary" loading={op.busy} disabled={!!op.pending || !title.trim() || !dishItems.length || !!dishesError} data-testid="canteen-save-menu">{published ? '发布菜单' : '保存草稿'}</Button><Button disabled={op.busy} onClick={onClose}>取消</Button></div>
    </form>
  </Card>;
}

function CheckinsPanel({ items }: { items: CanteenCheckin[] }) {
  return <Card className="overflow-hidden" data-testid="canteen-checkins">
    <div className="border-b border-line px-4 py-3"><h2 className="font-semibold">食堂打卡记录 <span className="num text-ink-3">{items.length} 条</span></h2><p className="mt-1 text-sm text-ink-3">按成功扫码记录展示，同一员工可以多次打卡，不等同于实际就餐人数。</p></div>
    {items.length === 0 ? <p className="p-8 text-center text-sm text-ink-3">这个日期还没有同步到打卡记录。</p> : <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm">
      <thead className="bg-paper-2 text-ink-3"><tr>{['工号 / 姓名', '部门', '扫码负责人', '打卡时间（北京时间）'].map(text => <th className="px-4 py-3 font-semibold" key={text}>{text}</th>)}</tr></thead>
      <tbody>{items.map(item => <tr key={item.id} className="border-t border-line" data-testid={`canteen-checkin-${item.id}`}><td className="px-4 py-3"><p className="font-semibold">{item.name}</p><p className="num text-xs text-ink-3">{item.employeeNo}</p></td><td className="px-4 py-3">{item.departmentName}</td><td className="px-4 py-3">{item.scannerName}</td><td className="num px-4 py-3">{clock(item.checkedAt)}</td></tr>)}</tbody>
    </table></div>}
  </Card>;
}
