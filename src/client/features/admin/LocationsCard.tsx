// 后台「空间台账 → 实时位置」（飞书需求 RQ-004 第一级，v0.7.17，见 docs/ROOMMAP.md 第 3 节）：
// 开关、接待区与技师休息区；刷卡点登记（装在哪个区域或空间，修改带版本号）与模拟刷卡（RQ-001 设备桥之前用它试）；
// 项目所在区域（挂账的客人推到这里）。与空间台账同一组权限（店主、店总）；模拟刷卡要「上报位置」权限。

import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { placeText, type LocationAdmin, type LocationReader, type LocationReportResult, type LocationRules, type LocationZone } from '@shared/locations';
import type { SpaceLedger } from '@shared/spaces';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { serverNowMs } from '../../lib/serverClock';
import { useCan, useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { useSpaceLedger } from '../spaces/queries';

const adminKey = ['admin', 'locations'] as const;
const useLocationAdmin = () => useQuery({ queryKey: adminKey, queryFn: () => api.get<LocationAdmin>('/api/admin/locations') });

/** 刷卡记上之后：刷卡点的「最近刷卡」与平面图人员图层重新取 */
export function useInvalidateLocations() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: adminKey });
    void qc.invalidateQueries({ queryKey: ['rooms', 'locations'] });
  }, [qc]);
}

export function LocationsCard() {
  const admin = useLocationAdmin();
  const ledger = useSpaceLedger();
  if (admin.error) return <Notice tone="error" title={errorMessage(admin.error)} />;
  if (!admin.data || !ledger.data) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-4" data-testid="locations-admin">
      <RulesCard data={admin.data} />
      <ReadersCard data={admin.data} ledger={ledger.data} />
      <ItemZonesCard data={admin.data} />
    </div>
  );
}

/** 区域下拉：按楼层分组，只列在用的；已选的停用了也显示出来 */
function ZoneSelect({ id, zones, value, onChange, empty, testId }: { id?: string; zones: LocationZone[]; value: number | null; onChange: (v: number | null) => void; empty: string; testId?: string }) {
  const floors = [...new Set(zones.map((z) => z.floorCode))];
  const current = value === null ? null : zones.find((z) => z.id === value);
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} data-testid={testId}>
      <option value="">{empty}</option>
      {current && !current.active && <option value={current.id}>{`${current.floorCode} ${current.name}（已停用）`}</option>}
      {floors.map((f) => (
        <optgroup key={f} label={f}>
          {zones
            .filter((z) => z.floorCode === f && z.active)
            .map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
        </optgroup>
      ))}
    </Select>
  );
}

function RulesCard({ data }: { data: LocationAdmin }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<LocationRules>(data.rules);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.rules);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<LocationAdmin>('/api/admin/locations/rules', draft);
      qc.setQueryData(adminKey, next);
      setDraft(next.rules);
      void qc.invalidateQueries({ queryKey: ['rooms', 'locations'] });
      toast({ tone: 'success', title: '实时位置的设置已保存', body: next.rules.enabled ? '之后的发牌、挂账、开房、上下钟、刷卡按新设置推导位置。' : '已关闭：不再推导，离开、离店照样清掉已有的位置。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-4 p-5" data-testid="locations-rules">
      <SectionTitle aside={<PendingBadge title="开发时按常见做法定的默认，待店主确认（docs/PENDING_DECISIONS.md「第一级实时位置」）" />}>开关与区域</SectionTitle>
      <label className="flex items-start gap-2.5 text-[14px]">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-pine)]" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} data-testid="locations-enabled" />
        <span>
          <b>开启实时位置</b>
          <span className="block text-[12.5px] text-ink-3">由刷卡点刷卡与业务动作（发手牌、挂账、开房、上下钟、结账）推出客人在哪个区、技师在哪间房，「客房 → 平面图」显示人员。关着时不推导、刷卡上报拒绝。</span>
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="接待区" htmlFor="loc-checkin-zone" hint="发手牌后客人在这里；不选就不推导">
          <ZoneSelect id="loc-checkin-zone" zones={data.zones} value={draft.checkinZoneId} onChange={(v) => setDraft({ ...draft, checkinZoneId: v })} empty="不推导" testId="locations-checkin-zone" />
        </Field>
        <Field label="技师休息区" htmlFor="loc-rest-zone" hint="技师上牌、下钟后在这里；不选的下钟后位置不明">
          <ZoneSelect id="loc-rest-zone" zones={data.zones} value={draft.restZoneId} onChange={(v) => setDraft({ ...draft, restZoneId: v })} empty="不推导" testId="locations-rest-zone" />
        </Field>
      </div>
      {data.zones.length === 0 && <Notice tone="info" title="空间台账里还没有区域：先在「楼层与区域」或「导入」里建区域。" />}
      {error && <Notice tone="error" title={error} />}
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()} data-testid="locations-rules-save">
          保存
        </Button>
      </div>
    </Card>
  );
}

// ───────────────────────── 刷卡点 ─────────────────────────

function ReadersCard({ data, ledger }: { data: LocationAdmin; ledger: SpaceLedger }) {
  const can = useCan();
  const [editing, setEditing] = useState<LocationReader | 'new' | null>(null);
  const [swiping, setSwiping] = useState<LocationReader | null>(null);
  const canReport = can('location.report');
  return (
    <Card className="space-y-3 p-5" data-testid="locations-readers">
      <SectionTitle
        aside={
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="reader-new">
            登记刷卡点
          </Button>
        }
      >
        刷卡点
      </SectionTitle>
      <p className="text-[12.5px] text-ink-3">需求文档有 16 个 RC300（接待 2、收银 4、助浴 2、水吧 2、娱乐 2、餐厅 1、休息 1、按摩 2），各自装在哪、编号多少由现场补。读卡器的设备接入在 RQ-001；之前用「模拟刷卡」试。</p>
      {data.readers.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-strong px-4 py-5 text-center text-[13px] text-ink-3">还没有登记刷卡点。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-3">
                <th className="py-2 pr-3 font-semibold">编号</th>
                <th className="py-2 pr-3 font-semibold">名称</th>
                <th className="py-2 pr-3 font-semibold">装在哪</th>
                <th className="py-2 pr-3 font-semibold">最近刷卡</th>
                <th className="py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {data.readers.map((r) => (
                <tr key={r.id} className="border-b border-line/70 last:border-0" data-testid={`reader-${r.code}`}>
                  <td className="num py-2 pr-3 font-bold">{r.code}</td>
                  <td className="py-2 pr-3">
                    {r.name} {!r.active && <Badge>停用</Badge>}
                  </td>
                  <td className="py-2 pr-3">
                    {placeText(r.place)} {r.placeInactive && <Badge tone="ember">地方已停用</Badge>}
                  </td>
                  <td className="py-2 pr-3 text-ink-3">{r.lastAt ? formatDateTime(r.lastAt) : '还没刷过'}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)} data-testid="reader-edit">
                      修改
                    </Button>
                    {canReport && r.active && (
                      <Button size="sm" variant="ghost" disabled={!data.rules.enabled} title={data.rules.enabled ? undefined : '先打开实时位置'} onClick={() => setSwiping(r)} data-testid="reader-swipe">
                        模拟刷卡
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ReaderDialog reader={editing} zones={data.zones} ledger={ledger} onClose={() => setEditing(null)} />
      <SwipeDialog reader={swiping} onClose={() => setSwiping(null)} />
    </Card>
  );
}

function ReaderDialog({ reader, zones, ledger, onClose }: { reader: LocationReader | 'new' | null; zones: LocationZone[]; ledger: SpaceLedger; onClose: () => void }) {
  const open = reader !== null;
  const qc = useQueryClient();
  const toast = useToast();
  const existing = reader && reader !== 'new' ? reader : null;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [where, setWhere] = useState<'zone' | 'space'>('zone');
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [spaceId, setSpaceId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setCode(existing?.code ?? '');
    setName(existing?.name ?? '');
    setWhere(existing?.spaceId ? 'space' : 'zone');
    setZoneId(existing?.zoneId ?? null);
    setSpaceId(existing?.spaceId ?? null);
    setNote(existing?.note ?? '');
    setActive(existing?.active ?? true);
    setError(null);
  });
  if (!open) return null;
  const floors = new Map(ledger.floors.map((f) => [f.id, f.code]));
  const spaces = ledger.spaces.filter((s) => s.active || s.id === existing?.spaceId).sort((a, b) => (floors.get(a.floorId) ?? '').localeCompare(floors.get(b.floorId) ?? '') || a.code.localeCompare(b.code));
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { code, name, zoneId: where === 'zone' ? zoneId : null, spaceId: where === 'space' ? spaceId : null, note, active };
    try {
      const next = existing
        ? await api.put<LocationAdmin>(`/api/admin/locations/readers/${existing.id}`, { ...body, expectedVersion: existing.version })
        : await api.post<LocationAdmin>('/api/admin/locations/readers', body);
      qc.setQueryData(adminKey, next);
      toast({ tone: 'success', title: existing ? `刷卡点 ${code.toUpperCase()} 已修改` : `刷卡点 ${code.toUpperCase()} 已登记` });
      onClose();
    } catch (e) {
      // 别人刚改过：刷新后按最新的再改
      setError(e instanceof UncertainError ? `${e.message}，请刷新看是否已保存` : errorMessage(e));
      void qc.invalidateQueries({ queryKey: adminKey });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={existing ? `修改刷卡点 ${existing.code}` : '登记刷卡点'}
      description="刷卡点装在哪：选区域（例如接待区）或具体的空间（例如水吧 W101）。刷卡的人就推到那里。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!code.trim() || !name.trim() || (where === 'zone' ? zoneId === null : spaceId === null)} onClick={() => void save()} data-testid="reader-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="编号" htmlFor="reader-code" hint="读卡器上贴的号或设备序列号">
            <Input id="reader-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={24} data-testid="reader-code" />
          </Field>
          <Field label="名称" htmlFor="reader-name" hint="例如「接待 1」">
            <Input id="reader-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} data-testid="reader-name" />
          </Field>
        </div>
        <Field label="装在哪">
          <Segmented<'zone' | 'space'> size="sm" value={where} onChange={setWhere} ariaLabel="装在哪" options={[{ value: 'zone', label: '区域' }, { value: 'space', label: '空间' }]} />
        </Field>
        {where === 'zone' ? (
          <ZoneSelect zones={zones} value={zoneId} onChange={setZoneId} empty="选区域" testId="reader-zone" />
        ) : (
          <Select value={spaceId ?? ''} onChange={(e) => setSpaceId(e.target.value ? Number(e.target.value) : null)} data-testid="reader-space">
            <option value="">选空间</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {`${floors.get(s.floorId) ?? ''} ${s.code} ${s.displayName}${s.active ? '' : '（已停用）'}`}
              </option>
            ))}
          </Select>
        )}
        <Field label="备注" htmlFor="reader-note">
          <Input id="reader-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        {existing && (
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={active} onChange={(e) => setActive(e.target.checked)} data-testid="reader-active" />
            在用（停用后这个刷卡点刷卡会被拒绝）
          </label>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/**
 * 模拟刷卡：输手牌号或技师工号，按这个刷卡点上报一次。与其他登记一样走「结果待确认」（AGENTS.md；Codex 复审 PR #33）：
 * 每次刷卡用新的操作编号，发出前把编号与原请求（含刷卡的时刻，按服务器时间）存在本机并读回核对，存不了就不发；
 * 结果不明时记录留在本机（关掉对话框、刷新都在），在「空间台账」页面上方查回、按原内容重新提交（同一编号不会重复记；
 * 晚到的只记事件、不改当前位置）或确认作废（原请求晚到也不记）。有待确认的不能再刷，免得同一次刷卡记两遍。
 */
function SwipeDialog({ reader, onClose }: { reader: LocationReader | null; onClose: () => void }) {
  const open = !!reader;
  const session = useSession();
  const invalidate = useInvalidateLocations();
  const pending = useErpPending(['location_report']);
  const [who, setWho] = useState<'guest' | 'technician'>('guest');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // 连按回车：上一次还没返回时不发第二次（每次刷卡是新的操作编号，发两次就记两次）
  const sending = useRef(false);
  useResetOnOpen(open, () => {
    setValue('');
    setError(null);
    setResult(null);
  });
  if (!reader) return null;
  const blocked = pending.length > 0;
  const submit = async () => {
    const code = value.trim();
    if (!code || blocked || sending.current) return;
    sending.current = true;
    const opId = uuid();
    const label = who === 'guest' ? `手牌 ${code.toUpperCase()}` : `技师 ${code}`;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await sendErpOp<LocationReportResult>({
        key: opId,
        type: 'location_report',
        url: '/api/locations/report',
        body: {
          opId,
          source: 'reader',
          readerCode: reader.code,
          ...(who === 'guest' ? { tagCode: code } : { technicianNo: code }),
          // 刷卡的时刻写进原请求：之后原样重发时，期间这个人去了别处的，这次刷卡只记事件、不会把人拉回这里
          at: new Date(serverNowMs()).toISOString(),
        },
        summary: `${reader.code} ${reader.name} · ${label}`,
        staffName: session.staff.displayName,
      });
      setResult(!r.applied ? '已记下，但比这个人最近一次位置还早，只记事件、不改当前位置' : r.current ? `已记：${label} 现在在 ${placeText(r.current)}` : '已记');
      setValue('');
      invalidate();
    } catch (e) {
      // 结果不明：记录留在本机，下面提示关掉对话框到页面上方处理；被明确拒绝的写原因；本机存不了的这笔没有发出
      if (!(e instanceof UncertainError)) setError(errorMessage(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`模拟刷卡 · ${reader.code} ${reader.name}`}
      description={`刷卡的人推到「${placeText(reader.place)}」。读卡器接入（RQ-001）之前用它试实时位置。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          <Button variant="primary" loading={busy} disabled={!value.trim() || blocked} onClick={() => void submit()} data-testid="swipe-submit">
            刷卡
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {blocked && (
          <div data-testid="swipe-pending">
            <Notice tone="warning" title="上一次模拟刷卡结果待确认">
              连不上服务器时不确定记上没有，已记在本机。请关掉这个窗口，在页面上方查回、按原内容重新提交或作废，再刷下一次，免得同一次刷卡记两遍。
            </Notice>
          </div>
        )}
        <Segmented<'guest' | 'technician'>
          size="sm"
          value={who}
          onChange={setWho}
          ariaLabel="谁刷卡"
          options={[{ value: 'guest', label: '客人（手牌号）' }, { value: 'technician', label: '技师（工号）' }]}
        />
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder={who === 'guest' ? '手牌号，例如 A023' : '技师工号，例如 07'}
          aria-label={who === 'guest' ? '手牌号' : '技师工号'}
          data-testid="swipe-value"
        />
        {result && <Notice tone="success" title={result} />}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 项目所在区域 ─────────────────────────

function ItemZonesCard({ data }: { data: LocationAdmin }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Map<number, number | null>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = data.items.filter((i) => i.active || i.zoneId !== null);
  const categories = [...new Set(items.map((i) => i.category || '未分类'))];
  const zoneOf = (id: number, saved: number | null) => (draft.has(id) ? draft.get(id)! : saved);
  const changed = items.filter((i) => draft.has(i.id) && draft.get(i.id) !== i.zoneId);
  const set = (id: number, v: number | null) => setDraft((m) => new Map(m).set(id, v));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<LocationAdmin>('/api/admin/locations/items', { items: changed.map((i) => ({ id: i.id, zoneId: draft.get(i.id)! })) });
      qc.setQueryData(adminKey, next);
      setDraft(new Map());
      toast({ tone: 'success', title: `已保存 ${changed.length} 个项目的区域`, body: '之后挂这些项目的客人推到对应的区域。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-5" data-testid="locations-items">
      <SectionTitle aside={<PendingBadge title="一次挂了几个不同区域的项目，按项目多的区域，一样多按先挂的（待确认）" />}>项目所在区域</SectionTitle>
      <p className="text-[12.5px] text-ink-3">挂账时客人推到项目所在的区域（例如饮品 → 水吧区、简餐 → 餐厅区）；没选的项目不推导。技师项目派钟马上上钟的，按钟单的房间算。</p>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-3">价目里还没有项目。</p>
      ) : (
        <div className="space-y-3">
          {categories.map((c) => {
            const list = items.filter((i) => (i.category || '未分类') === c);
            return (
              <div key={c} className="rounded-md border border-line" data-testid={`item-zones-${c}`}>
                <div className="flex flex-wrap items-center gap-2 border-b border-line bg-paper-2/60 px-3 py-2">
                  <span className="flex-1 text-[13px] font-bold">
                    {c} <span className="num text-ink-4">{list.length}</span>
                  </span>
                  <div className="w-[200px]">
                    <ZoneSelect zones={data.zones} value={null} onChange={(v) => list.forEach((i) => set(i.id, v))} empty="整类设成……" testId={`item-zones-all-${c}`} />
                  </div>
                </div>
                <ul className="divide-y divide-line/70">
                  {list.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[13px]" data-testid={`item-zone-${i.name}`}>
                      <span className="min-w-0 flex-1">
                        {i.name} {!i.active && <Badge>停用</Badge>}
                        {draft.has(i.id) && draft.get(i.id) !== i.zoneId && <Badge tone="yuzu">未保存</Badge>}
                      </span>
                      <div className="w-[200px]">
                        <ZoneSelect zones={data.zones} value={zoneOf(i.id, i.zoneId)} onChange={(v) => set(i.id, v)} empty="不推导" testId={`item-zone-select-${i.name}`} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {error && <Notice tone="error" title={error} />}
      <div className="flex justify-end gap-2">
        {changed.length > 0 && (
          <Button variant="ghost" onClick={() => setDraft(new Map())} disabled={busy}>
            撤回修改
          </Button>
        )}
        <Button variant="primary" loading={busy} disabled={changed.length === 0} onClick={() => void save()} data-testid="item-zones-save">
          {changed.length ? `保存 ${changed.length} 个项目` : '保存'}
        </Button>
      </div>
    </Card>
  );
}
