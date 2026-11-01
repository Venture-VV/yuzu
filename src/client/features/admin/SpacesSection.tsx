// 后台「空间台账」（飞书需求 RQ-004 第一段，v0.7.14，见 docs/SPACES.md）：楼层 → 区域 → 空间（编码图的编码做主键，建好后不能改，缺号不补）、
// 别名（品牌名、编码图原始标注、旧名；只追加，不用了停用）、核对状态（已核对 / 推断 / 待现场核对，改状态要写说明）、
// 空间清单与区域清单的导入、导出。客房房间在「客房 → 房间」里挂接空间（房号就是空间编码）。店主、店总可以改（与「客房」同一组权限）。

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Download, Plus, Search } from 'lucide-react';
import { ADMIN_SECTIONS } from '@shared/admin';
import {
  FLOOR_CODE_RE,
  MAX_ALIAS,
  MAX_BUSINESS_TYPE,
  MAX_CAPACITY,
  MAX_DISPLAY_NAME,
  MAX_FLOOR_NAME,
  MAX_NAME_EN,
  MAX_SOURCE_LABEL,
  MAX_SPACE_CODE,
  MAX_SPACE_NOTE,
  MAX_ZONE_NAME,
  SPACE_ALIAS_KINDS,
  SPACE_ALIAS_LABELS,
  SPACE_CODE_RE,
  SPACE_VERIFY_LABELS,
  SPACE_VERIFY_STATUSES,
  areaText,
  parseArea,
  type Floor,
  type Space,
  type SpaceAliasKind,
  type SpaceLedger,
  type SpaceVerifyStatus,
  type Zone,
} from '@shared/spaces';
import { api, errorMessage } from '../../lib/api';
import { cn, downloadUrl, formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { useInvalidateSpaces, useSpaceLedger } from '../spaces/queries';
import { AdminPage } from './AdminShell';
import { SpaceImportCard } from './SpaceImportCard';

type Tab = 'spaces' | 'zones' | 'import';
type VerifyFilter = '' | SpaceVerifyStatus | 'unverified';
interface Filters {
  floorId: number;
  /** 0 = 全部，-1 = 不分区域 */
  zoneId: number;
  type: string;
  verify: VerifyFilter;
  q: string;
  showInactive: boolean;
}
const NO_FILTER: Filters = { floorId: 0, zoneId: 0, type: '', verify: '', q: '', showInactive: false };

const VERIFY_TONE = { confirmed: 'pine', inferred: 'yuzu', site_check: 'ember' } as const;

export function SpacesSection() {
  const [tab, setTab] = useState<Tab>('spaces');
  const [filters, setFilters] = useState<Filters>(NO_FILTER);
  const ledger = useSpaceLedger();
  const invalidate = useInvalidateSpaces();
  return (
    <AdminPage
      section="spaces"
      wide
      description="楼层、区域与空间（编码图的编码，建好后不能改）、别名与核对状态；空间清单、区域清单的导入与导出。客房房间在「客房」里挂接空间。"
    >
      <div className="space-y-4">
        <ErpPendingPanel types={['space_import']} className="space-y-2" onFound={() => void invalidate()} />
        {!ledger.data ? (
          <Skeleton className="h-28" />
        ) : (
          <Summary
            ledger={ledger.data}
            onShowUnverified={() => {
              setFilters({ ...NO_FILTER, verify: 'unverified' });
              setTab('spaces');
            }}
            onShowRoomSpaces={() => {
              setFilters({ ...NO_FILTER, type: '客房' });
              setTab('spaces');
            }}
          />
        )}
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          ariaLabel="空间台账"
          options={[
            { value: 'spaces', label: '空间' },
            { value: 'zones', label: '楼层与区域' },
            { value: 'import', label: '导入' },
          ]}
        />
        {tab === 'import' ? (
          <SpaceImportCard />
        ) : !ledger.data ? (
          <Skeleton className="h-64" />
        ) : tab === 'spaces' ? (
          <SpacesCard ledger={ledger.data} filters={filters} setFilters={setFilters} />
        ) : (
          <FloorsZonesCard ledger={ledger.data} />
        )}
      </div>
    </AdminPage>
  );
}

function Summary({ ledger, onShowUnverified, onShowRoomSpaces }: { ledger: SpaceLedger; onShowUnverified: () => void; onShowRoomSpaces: () => void }) {
  const c = ledger.counts;
  const zones = ledger.zones.filter((z) => z.active).length;
  return (
    <Card className="space-y-3 p-5" data-testid="spaces-summary">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className="text-[14px]">
          <span className="text-[20px] font-bold">{c.active}</span> 个在用的空间
          {c.spaces > c.active && <span className="text-ink-3">（另有停用的 {c.spaces - c.active} 个）</span>}
        </p>
        <p className="text-[13.5px] text-ink-2">区域 {zones} 个 · 楼层 {ledger.floors.filter((f) => f.active).length} 个</p>
        <p className="text-[13.5px] text-ink-2">
          客房 {c.roomSpaces} 间 · 已挂接客房房间 {c.roomSpacesLinked} 间
        </p>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl('/api/admin/spaces/export')} disabled={c.spaces === 0}>
          导出空间清单
        </Button>
      </div>
      {c.spaces === 0 && (
        <Notice tone="info" title="台账还是空的">
          先在「导入」里导入区域清单、空间清单（与需求文档附件的列名一致），也可以在「空间」里逐个新建。门店环境导入真实台账须店主同意。
        </Notice>
      )}
      {c.unverified > 0 && (
        <Notice tone="warning" title={`${c.unverified} 个空间还没核对（推断或待现场核对）`}>
          导入时备注写了「推断」「近邻标签」的标为推断。现场核对后在空间详情里改成「已核对」并写明怎么核对的。{' '}
          <button type="button" className="font-semibold text-pine hover:underline" onClick={onShowUnverified} data-testid="spaces-show-unverified">
            只看没核对的
          </button>
        </Notice>
      )}
      {c.roomSpacesWithoutBrand > 0 && (
        <Notice tone="info" title={`${c.roomSpacesWithoutBrand} 间客房还没有品牌名`}>
          品牌图上的房名（如「客房 C5」，可能几间同名）要现场按门牌核对后，在空间详情里加「品牌名」别名，系统不按图纸坐标推断。{' '}
          <button type="button" className="font-semibold text-pine hover:underline" onClick={onShowRoomSpaces}>
            只看客房
          </button>
          {' · '}
          <Link to={ADMIN_SECTIONS.rooms.path} className="font-semibold text-pine hover:underline">
            去「客房」挂接房间
          </Link>
        </Notice>
      )}
    </Card>
  );
}

// ───────────────────────── 空间清单 ─────────────────────────

function SpacesCard({ ledger, filters, setFilters }: { ledger: SpaceLedger; filters: Filters; setFilters: (f: Filters) => void }) {
  const [editing, setEditing] = useState<Space | 'new' | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState(false);
  const floorOf = useMemo(() => new Map(ledger.floors.map((f) => [f.id, f])), [ledger.floors]);
  const zoneOf = useMemo(() => new Map(ledger.zones.map((z) => [z.id, z])), [ledger.zones]);
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const q = filters.q.trim().toLowerCase();
  const shown = ledger.spaces.filter(
    (s) =>
      (filters.showInactive || s.active) &&
      (!filters.floorId || s.floorId === filters.floorId) &&
      (!filters.zoneId || (filters.zoneId === -1 ? s.zoneId === null : s.zoneId === filters.zoneId)) &&
      (!filters.type || s.businessType === filters.type) &&
      (!filters.verify || (filters.verify === 'unverified' ? s.verifyStatus !== 'confirmed' : s.verifyStatus === filters.verify)) &&
      (!q || s.code.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q) || s.aliases.some((a) => a.alias.toLowerCase().includes(q))),
  );
  const zoneChoices = ledger.zones.filter((z) => !filters.floorId || z.floorId === filters.floorId);
  const picked = shown.filter((s) => selected.has(s.id));
  const allPicked = shown.length > 0 && picked.length === shown.length;
  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const filtered = JSON.stringify({ ...filters, q: '' }) !== JSON.stringify({ ...NO_FILTER }) || q !== '';

  return (
    <Card className="p-5" data-testid="spaces-list">
      <SectionTitle
        aside={
          <div className="flex flex-wrap gap-2">
            {picked.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setBulk(true)} data-testid="spaces-bulk-zone">
                给选中的 {picked.length} 个设区域
              </Button>
            )}
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="spaces-new">
              新建空间
            </Button>
          </div>
        }
      >
        空间
      </SectionTitle>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.4fr)]">
        <Select aria-label="楼层" value={filters.floorId} onChange={(e) => set({ floorId: Number(e.target.value), zoneId: 0 })} data-testid="spaces-filter-floor">
          <option value={0}>全部楼层</option>
          {ledger.floors.map((f) => (
            <option key={f.id} value={f.id}>
              {f.code} {f.name}
            </option>
          ))}
        </Select>
        <Select aria-label="区域" value={filters.zoneId} onChange={(e) => set({ zoneId: Number(e.target.value) })}>
          <option value={0}>全部区域</option>
          <option value={-1}>不分区域</option>
          {zoneChoices.map((z) => (
            <option key={z.id} value={z.id}>
              {floorOf.get(z.floorId)?.code} · {z.name}
            </option>
          ))}
        </Select>
        <Select aria-label="业态" value={filters.type} onChange={(e) => set({ type: e.target.value })} data-testid="spaces-filter-type">
          <option value="">全部业态</option>
          {ledger.businessTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select aria-label="核对状态" value={filters.verify} onChange={(e) => set({ verify: e.target.value as VerifyFilter })} data-testid="spaces-filter-verify">
          <option value="">全部核对状态</option>
          <option value="unverified">没核对的（推断、待现场核对）</option>
          {SPACE_VERIFY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SPACE_VERIFY_LABELS[s]}
            </option>
          ))}
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
          <Input
            className="h-10 pl-9"
            placeholder="搜编码、显示名或别名"
            aria-label="搜编码、显示名或别名"
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            data-testid="spaces-search"
          />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
        <span data-testid="spaces-count">
          {filtered ? `筛出 ${shown.length} 个` : `共 ${shown.length} 个`}
          {picked.length > 0 && `，选中 ${picked.length} 个`}
        </span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={filters.showInactive} onChange={(e) => set({ showInactive: e.target.checked })} />
          显示停用的
        </label>
        {shown.length > 0 && (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={allPicked}
              onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...shown.map((s) => s.id)]) : new Set([...selected].filter((id) => !shown.some((s) => s.id === id))))}
            />
            全选筛出的
          </label>
        )}
        {filtered && (
          <button type="button" className="font-semibold text-pine hover:underline" onClick={() => setFilters(NO_FILTER)}>
            清除筛选
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">
          {ledger.spaces.length === 0 ? '台账里还没有空间：在「导入」里导入空间清单，或点「新建空间」。' : '没有符合筛选的空间。'}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {shown.map((s) => {
            const zone = s.zoneId ? zoneOf.get(s.zoneId) : null;
            const aliases = s.aliases.filter((a) => a.active && a.kind !== 'source').map((a) => a.alias);
            return (
              <li key={s.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', !s.active && 'bg-paper-2/50 opacity-70')} data-testid={`space-${s.code}`}>
                <input type="checkbox" aria-label={`选中 ${s.code}`} checked={selected.has(s.id)} onChange={() => toggle(s.id)} className="size-4" />
                <span className="num min-w-[56px] text-[14.5px] font-bold">{s.code}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{s.displayName}</span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {floorOf.get(s.floorId)?.code} · {zone ? zone.name : '不分区域'} · {s.businessType}
                    {s.capacity ? ` · ${s.capacity} 人` : ''}
                    {s.areaCentiM2 ? ` · ${areaText(s.areaCentiM2)}㎡` : ''}
                    {aliases.length ? ` · 别名：${aliases.join('、')}` : ''}
                  </span>
                </span>
                {s.verifyStatus !== 'confirmed' && <Badge tone={VERIFY_TONE[s.verifyStatus]}>{SPACE_VERIFY_LABELS[s.verifyStatus]}</Badge>}
                {s.room && <Badge tone="lake">客房 {s.room.roomNo}</Badge>}
                {!s.sellable && <Badge>不可售</Badge>}
                {!s.active && <Badge tone="clay">已停用</Badge>}
                <Button size="sm" variant="ghost" onClick={() => setEditing(s)} data-testid={`space-open-${s.code}`}>
                  详情
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <SpaceDialog target={editing} ledger={ledger} onClose={() => setEditing(null)} />
      {bulk && (
        <BulkZoneDialog
          spaces={picked}
          ledger={ledger}
          onClose={(done) => {
            setBulk(false);
            if (done) setSelected(new Set());
          }}
        />
      )}
    </Card>
  );
}

interface SpaceDraft {
  code: string;
  floorId: number | null;
  zoneId: number | null;
  businessType: string;
  capacity: string;
  area: string;
  displayName: string;
  nameEn: string;
  sellable: boolean;
  sourceLabel: string;
  note: string;
  active: boolean;
  verifyStatus: SpaceVerifyStatus;
}

const draftOf = (s: Space | null, ledger: SpaceLedger): SpaceDraft => ({
  code: s?.code ?? '',
  floorId: s?.floorId ?? ledger.floors.find((f) => f.active)?.id ?? null,
  zoneId: s?.zoneId ?? null,
  businessType: s?.businessType ?? '',
  capacity: s?.capacity ? String(s.capacity) : '',
  area: s ? areaText(s.areaCentiM2) : '',
  displayName: s?.displayName ?? '',
  nameEn: s?.nameEn ?? '',
  sellable: s?.sellable ?? true,
  sourceLabel: s?.sourceLabel ?? '',
  note: s?.note ?? '',
  active: s?.active ?? true,
  verifyStatus: s?.verifyStatus ?? 'confirmed',
});

function SpaceDialog({ target, ledger, onClose }: { target: Space | 'new' | null; ledger: SpaceLedger; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateSpaces();
  const [draft, setDraft] = useState<SpaceDraft | null>(null);
  // 打开时读到的版本号：保存、核对时原样带回，对不上（刚被改过）服务端拒绝；本对话框自己核对成功后跟着更新
  const [baseVersion, setBaseVersion] = useState(0);
  const [opened, setOpened] = useState<typeof target>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (target !== opened) {
    setOpened(target);
    setDraft(target ? draftOf(target === 'new' ? null : target, ledger) : null);
    setBaseVersion(target && target !== 'new' ? target.version : 0);
    setError(null);
  }
  // 详情里显示最新的（核对、加别名后台账会刷新）
  const current = target && target !== 'new' ? (ledger.spaces.find((s) => s.id === target.id) ?? target) : null;
  if (!target || !draft) return null;
  const set = (patch: Partial<SpaceDraft>) => setDraft({ ...draft, ...patch });
  const isNew = target === 'new';
  const code = draft.code.trim().toUpperCase();
  const capacity = draft.capacity.trim() === '' ? null : Number(draft.capacity);
  const area = parseArea(draft.area);
  const problem = isNew && !SPACE_CODE_RE.test(code)
    ? '编码是大写字母开头、2 到 8 位的字母或数字，例如 S301'
    : draft.floorId === null
      ? '请选择楼层'
      : !draft.businessType.trim()
        ? '请填写业态'
        : capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY)
          ? `容量要是 1 到 ${MAX_CAPACITY} 的整数（可以空着）`
          : area === undefined
            ? '面积要是大于 0 的数字，最多两位小数（可以空着）'
            : !draft.displayName.trim()
              ? '请填写显示名'
              : null;
  const zones = ledger.zones.filter((z) => z.floorId === draft.floorId && (z.active || z.id === draft.zoneId));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        floorId: draft.floorId,
        zoneId: draft.zoneId,
        businessType: draft.businessType.trim(),
        capacity,
        areaCentiM2: area ?? null,
        displayName: draft.displayName.trim(),
        nameEn: draft.nameEn.trim(),
        sellable: draft.sellable,
        sourceLabel: draft.sourceLabel.trim(),
        note: draft.note.trim(),
      };
      const next = isNew
        ? await api.post<SpaceLedger>('/api/admin/spaces', { ...body, code, verifyStatus: draft.verifyStatus })
        : await api.put<SpaceLedger>(`/api/admin/spaces/${target.id}`, { ...body, active: draft.active, version: baseVersion });
      await invalidate(next);
      toast({ tone: 'success', title: isNew ? `已新建空间 ${code}` : `空间 ${target.code} 已保存` });
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
      width="max-w-2xl"
      onClose={busy ? () => {} : onClose}
      title={isNew ? '新建空间' : `空间 ${target.code} · ${current?.displayName ?? ''}`}
      description={isNew ? '编码按编码图写（如 S301），建好后不能改；缺号不补。' : '编码建好后不能改；写错了停用，再新建正确的。'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {isNew ? '取消' : '关闭'}
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={save} data-testid="space-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {isNew && (
            <Field label="编码" htmlFor="space-code" hint="大写字母开头，如 S301">
              <Input id="space-code" value={draft.code} maxLength={MAX_SPACE_CODE} onChange={(e) => set({ code: e.target.value.toUpperCase() })} className="num" data-autofocus data-testid="space-code" />
            </Field>
          )}
          <Field label="楼层" htmlFor="space-floor">
            <Select id="space-floor" value={draft.floorId ?? ''} onChange={(e) => set({ floorId: Number(e.target.value) || null, zoneId: null })} data-testid="space-floor">
              {ledger.floors
                .filter((f) => f.active || f.id === draft.floorId)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.code} {f.name}
                    {f.active ? '' : '（已停用）'}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="区域" htmlFor="space-zone" hint="可以不分区域">
            <Select id="space-zone" value={draft.zoneId ?? ''} onChange={(e) => set({ zoneId: Number(e.target.value) || null })} data-testid="space-zone">
              <option value="">不分区域</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                  {z.active ? '' : '（已停用）'}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="业态" htmlFor="space-type" hint={`最多 ${MAX_BUSINESS_TYPE} 个字，可以写新的`}>
            <Input id="space-type" value={draft.businessType} maxLength={MAX_BUSINESS_TYPE} list="space-types" onChange={(e) => set({ businessType: e.target.value })} data-testid="space-type" />
            <datalist id="space-types">
              {ledger.businessTypes.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
          <Field label="容量（人）" htmlFor="space-capacity" hint="可以空着">
            <Input id="space-capacity" inputMode="numeric" value={draft.capacity} onChange={(e) => set({ capacity: e.target.value })} className="num" data-testid="space-capacity" />
          </Field>
          <Field label="面积（㎡）" htmlFor="space-area" hint="可以空着，最多两位小数">
            <Input id="space-area" inputMode="decimal" value={draft.area} onChange={(e) => set({ area: e.target.value })} className="num" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="显示名" htmlFor="space-name" hint="对客显示，通常是品牌图上的名字">
            <Input id="space-name" value={draft.displayName} maxLength={MAX_DISPLAY_NAME} onChange={(e) => set({ displayName: e.target.value })} data-testid="space-name" />
          </Field>
          <Field label="英文名" htmlFor="space-name-en" hint="可以空着">
            <Input id="space-name-en" value={draft.nameEn} maxLength={MAX_NAME_EN} onChange={(e) => set({ nameEn: e.target.value })} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="编码图原始标注" htmlFor="space-source" hint="如「足浴 C301 2人间」">
            <Input id="space-source" value={draft.sourceLabel} maxLength={MAX_SOURCE_LABEL} onChange={(e) => set({ sourceLabel: e.target.value })} />
          </Field>
          <Field label="备注" htmlFor="space-note">
            <Input id="space-note" value={draft.note} maxLength={MAX_SPACE_NOTE} onChange={(e) => set({ note: e.target.value })} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            ariaLabel="可售"
            value={draft.sellable ? 'on' : 'off'}
            onChange={(v) => set({ sellable: v === 'on' })}
            options={[
              { value: 'on', label: '可售' },
              { value: 'off', label: '不可售（暂停、改造）' },
            ]}
          />
          {isNew ? (
            <Select aria-label="核对状态" fullWidth={false} className="w-44" value={draft.verifyStatus} onChange={(e) => set({ verifyStatus: e.target.value as SpaceVerifyStatus })}>
              {SPACE_VERIFY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SPACE_VERIFY_LABELS[s]}
                </option>
              ))}
            </Select>
          ) : (
            <Segmented
              ariaLabel="在用"
              value={draft.active ? 'on' : 'off'}
              onChange={(v) => set({ active: v === 'on' })}
              options={[
                { value: 'on', label: '在用' },
                { value: 'off', label: '停用' },
              ]}
            />
          )}
        </div>
        {current?.room && (
          <p className="text-[12.5px] text-ink-3">
            挂着客房房间「{current.room.roomNo}」：不能停用、不能改业态（先在「客房 → 房间」里取消挂接）。
          </p>
        )}
        {problem && draft.code !== '' && <p className="text-[12.5px] text-clay">{problem}</p>}
        {error && <Notice tone="error" title={error} />}
        {current && (
          <>
            <VerifyPanel space={current} version={baseVersion} onVerified={setBaseVersion} />
            <AliasPanel space={current} />
          </>
        )}
      </div>
    </Dialog>
  );
}

function VerifyPanel({ space, version, onVerified }: { space: Space; version: number; onVerified: (version: number) => void }) {
  const toast = useToast();
  const invalidate = useInvalidateSpaces();
  const [status, setStatus] = useState<SpaceVerifyStatus>('confirmed');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<SpaceLedger>(`/api/admin/spaces/${space.id}/verify`, { status, note: note.trim(), version });
      await invalidate(next);
      const updated = next.spaces.find((s) => s.id === space.id);
      if (updated) onVerified(updated.version);
      toast({ tone: 'success', title: `${space.code} 改为${SPACE_VERIFY_LABELS[status]}` });
      setNote('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2 rounded-lg border border-line p-3" data-testid="space-verify">
      <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-bold">
        核对状态
        <Badge tone={VERIFY_TONE[space.verifyStatus]}>{SPACE_VERIFY_LABELS[space.verifyStatus]}</Badge>
        {space.verifiedAt && (
          <span className="text-[12px] font-normal text-ink-3">
            {space.verifiedByName ?? '系统'} · {formatDateTime(space.verifiedAt)}
            {space.verifyNote ? ` · ${space.verifyNote}` : ''}
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Select aria-label="改为" fullWidth={false} className="w-40" value={status} onChange={(e) => setStatus(e.target.value as SpaceVerifyStatus)} data-testid="space-verify-status">
          {SPACE_VERIFY_STATUSES.map((s) => (
            <option key={s} value={s}>
              改为{SPACE_VERIFY_LABELS[s]}
            </option>
          ))}
        </Select>
        <Input
          fullWidth={false}
          className="h-10 min-w-[200px] flex-1"
          placeholder="核对说明（如：店长现场按门牌核对）"
          aria-label="核对说明"
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="space-verify-note"
        />
        <Button size="sm" variant="secondary" loading={busy} disabled={note.trim().length < 2} onClick={save} data-testid="space-verify-save">
          保存核对
        </Button>
      </div>
      {error && <Notice tone="error" title={error} />}
    </section>
  );
}

function AliasPanel({ space }: { space: Space }) {
  const toast = useToast();
  const invalidate = useInvalidateSpaces();
  const [alias, setAlias] = useState('');
  const [kind, setKind] = useState<SpaceAliasKind>('brand');
  const [showRetired, setShowRetired] = useState(false);
  const [busy, setBusy] = useState<number | 'add' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = space.aliases.filter((a) => a.active);
  const retired = space.aliases.filter((a) => !a.active);
  const run = async (key: number | 'add', fn: () => Promise<SpaceLedger>, done: string) => {
    setBusy(key);
    setError(null);
    try {
      await invalidate(await fn());
      toast({ tone: 'success', title: done });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="space-y-2 rounded-lg border border-line p-3" data-testid="space-aliases">
      <p className="text-[13.5px] font-bold">别名</p>
      <p className="text-[12px] text-ink-3">品牌名、编码图原始标注、旧名都可以搜到；改名时加新的、旧的停用（留着可以搜），不删不改。不同空间可以有一样的别名（如 4 间「客房 C5」）。</p>
      {active.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">还没有别名。</p>
      ) : (
        <ul className="divide-y divide-line/70 rounded-md border border-line/70">
          {active.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[13px]">
              <Badge tone={a.kind === 'brand' ? 'lake' : 'neutral'}>{SPACE_ALIAS_LABELS[a.kind]}</Badge>
              <span className="min-w-0 flex-1 truncate font-semibold">{a.alias}</span>
              <span className="text-[11.5px] text-ink-4">
                {a.createdByName ?? '系统'} · {formatDateTime(a.createdAt)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === a.id}
                onClick={() => void run(a.id, () => api.post<SpaceLedger>(`/api/admin/spaces/${space.id}/aliases/${a.id}/retire`, {}), `已停用别名「${a.alias}」`)}
              >
                停用
              </Button>
            </li>
          ))}
        </ul>
      )}
      {retired.length > 0 && (
        <div className="text-[12.5px] text-ink-3">
          <button type="button" className="font-semibold text-pine hover:underline" onClick={() => setShowRetired(!showRetired)}>
            {showRetired ? '收起' : `停用的别名 ${retired.length} 个`}
          </button>
          {showRetired && (
            <ul className="mt-1 space-y-0.5">
              {retired.map((a) => (
                <li key={a.id}>
                  {SPACE_ALIAS_LABELS[a.kind]}「{a.alias}」· {a.retiredByName ?? '系统'} {a.retiredAt ? formatDateTime(a.retiredAt) : ''} 停用
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Select aria-label="别名类型" fullWidth={false} className="w-36" value={kind} onChange={(e) => setKind(e.target.value as SpaceAliasKind)} data-testid="space-alias-kind">
          {SPACE_ALIAS_KINDS.map((k) => (
            <option key={k} value={k}>
              {SPACE_ALIAS_LABELS[k]}
            </option>
          ))}
        </Select>
        <Input
          fullWidth={false}
          className="h-10 min-w-[180px] flex-1"
          placeholder="如：客房 C5"
          aria-label="新别名"
          maxLength={MAX_ALIAS}
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          data-testid="space-alias-input"
        />
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'add'}
          disabled={!alias.trim()}
          onClick={async () => {
            if (await run('add', () => api.post<SpaceLedger>(`/api/admin/spaces/${space.id}/aliases`, { alias: alias.trim(), kind }), `已加${SPACE_ALIAS_LABELS[kind]}「${alias.trim()}」`)) setAlias('');
          }}
          data-testid="space-alias-add"
        >
          加别名
        </Button>
      </div>
      {error && <Notice tone="error" title={error} />}
    </section>
  );
}

function BulkZoneDialog({ spaces, ledger, onClose }: { spaces: Space[]; ledger: SpaceLedger; onClose: (done: boolean) => void }) {
  const toast = useToast();
  const invalidate = useInvalidateSpaces();
  const floors = [...new Set(spaces.map((s) => s.floorId))];
  const zones = floors.length === 1 ? ledger.zones.filter((z) => z.floorId === floors[0] && z.active) : [];
  const [zoneId, setZoneId] = useState<number | null>(zones[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await invalidate(await api.post<SpaceLedger>('/api/admin/spaces/bulk-zone', { spaces: spaces.map((s) => ({ id: s.id, version: s.version })), zoneId }));
      toast({ tone: 'success', title: `${spaces.length} 个空间已设区域` });
      onClose(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : () => onClose(false)}
      title={`给 ${spaces.length} 个空间设区域`}
      description={spaces
        .map((s) => s.code)
        .slice(0, 12)
        .join('、')
        .concat(spaces.length > 12 ? '……' : '')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={save} data-testid="spaces-bulk-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {floors.length > 1 && <Notice tone="warning" title="选中的空间不在同一层：只能设为「不分区域」；要设区域请按楼层筛选后再选" />}
        <Field label="区域" htmlFor="bulk-zone">
          <Select id="bulk-zone" value={zoneId ?? ''} onChange={(e) => setZoneId(Number(e.target.value) || null)} data-testid="spaces-bulk-zone-select">
            <option value="">不分区域</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </Select>
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 楼层与区域 ─────────────────────────

function FloorsZonesCard({ ledger }: { ledger: SpaceLedger }) {
  const [floor, setFloor] = useState<Floor | 'new' | null>(null);
  const [zone, setZone] = useState<Zone | { floorId: number } | null>(null);
  return (
    <Card className="p-5" data-testid="spaces-zones">
      <SectionTitle
        aside={
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setFloor('new')}>
            新建楼层
          </Button>
        }
      >
        楼层与区域
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">系统基线是会所 1 至 3 层；公区（大堂、男汤、休息大厅……）只建区域、不建空间。楼层、区域不删除，不用了停用（里面没有在用的空间、区域时才能停用）。</p>
      <div className="mt-3 space-y-3">
        {ledger.floors.map((f) => {
          const zones = ledger.zones.filter((z) => z.floorId === f.id);
          return (
            <section key={f.id} className={cn('rounded-lg border border-line', !f.active && 'opacity-70')} data-testid={`floor-${f.code}`}>
              <header className="flex flex-wrap items-center gap-2 border-b border-line/70 bg-paper-2/50 px-3 py-2">
                <span className="num text-[14.5px] font-bold">{f.code}</span>
                <span className="text-[13.5px] font-semibold">{f.name}</span>
                <span className="text-[12px] text-ink-3">
                  区域 {f.zoneCount} 个 · 在用的空间 {f.spaceCount} 个
                </span>
                {!f.active && <Badge tone="clay">已停用</Badge>}
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setFloor(f)}>
                  编辑楼层
                </Button>
                {f.active && (
                  <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setZone({ floorId: f.id })} data-testid={`zone-new-${f.code}`}>
                    区域
                  </Button>
                )}
              </header>
              {zones.length === 0 ? (
                <p className="px-3 py-2 text-[12.5px] text-ink-3">还没有区域。</p>
              ) : (
                <ul className="divide-y divide-line/70">
                  {zones.map((z) => (
                    <li key={z.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2', !z.active && 'opacity-60')}>
                      <span className="text-[13.5px] font-semibold">{z.name}</span>
                      {z.nameEn && <span className="text-[12px] text-ink-3">{z.nameEn}</span>}
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-4">{z.note}</span>
                      <span className="num text-[12px] text-ink-3">空间 {z.spaceCount}</span>
                      {!z.active && <Badge tone="clay">已停用</Badge>}
                      <Button size="sm" variant="ghost" onClick={() => setZone(z)}>
                        编辑
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {floor && <FloorDialog target={floor} onClose={() => setFloor(null)} />}
      {zone && <ZoneDialog target={zone} ledger={ledger} onClose={() => setZone(null)} />}
    </Card>
  );
}

function FloorDialog({ target, onClose }: { target: Floor | 'new'; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateSpaces();
  const isNew = target === 'new';
  const [code, setCode] = useState(isNew ? '' : target.code);
  const [name, setName] = useState(isNew ? '' : target.name);
  const [sortOrder, setSortOrder] = useState(String(isNew ? 0 : target.sortOrder));
  const [active, setActive] = useState(isNew ? true : target.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const order = Number(sortOrder);
  const ok = (!isNew || FLOOR_CODE_RE.test(code.trim().toUpperCase())) && name.trim().length > 0 && Number.isInteger(order) && order >= 0 && order <= 9999;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = isNew
        ? await api.post<SpaceLedger>('/api/admin/spaces/floors', { code: code.trim().toUpperCase(), name: name.trim(), sortOrder: order })
        : await api.put<SpaceLedger>(`/api/admin/spaces/floors/${target.id}`, { name: name.trim(), sortOrder: order, active, version: target.version });
      await invalidate(next);
      toast({ tone: 'success', title: isNew ? `已新建楼层 ${code.trim().toUpperCase()}` : '楼层已保存' });
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
      title={isNew ? '新建楼层' : `编辑楼层 ${target.code}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          {isNew && (
            <Field label="编码" htmlFor="floor-code" hint="如 L4、B1，建好后不能改">
              <Input fullWidth={false} id="floor-code" className="num w-28" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} data-autofocus />
            </Field>
          )}
          <Field label="名称" htmlFor="floor-name">
            <Input fullWidth={false} id="floor-name" className="w-40" maxLength={MAX_FLOOR_NAME} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="排序" htmlFor="floor-order">
            <Input fullWidth={false} id="floor-order" type="number" min={0} max={9999} className="num w-24" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </Field>
        </div>
        {!isNew && (
          <Segmented
            ariaLabel="楼层状态"
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '在用' },
              { value: 'off', label: '停用' },
            ]}
          />
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function ZoneDialog({ target, ledger, onClose }: { target: Zone | { floorId: number }; ledger: SpaceLedger; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateSpaces();
  const existing = 'id' in target ? target : null;
  const floor = ledger.floors.find((f) => f.id === target.floorId);
  const [name, setName] = useState(existing?.name ?? '');
  const [nameEn, setNameEn] = useState(existing?.nameEn ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [sortOrder, setSortOrder] = useState(String(existing?.sortOrder ?? 0));
  const [active, setActive] = useState(existing?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const order = Number(sortOrder);
  const ok = name.trim().length > 0 && Number.isInteger(order) && order >= 0 && order <= 9999;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), nameEn: nameEn.trim(), note: note.trim(), sortOrder: order };
      const next = existing
        ? await api.put<SpaceLedger>(`/api/admin/spaces/zones/${existing.id}`, { ...body, active, version: existing.version })
        : await api.post<SpaceLedger>('/api/admin/spaces/zones', { ...body, floorId: target.floorId });
      await invalidate(next);
      toast({ tone: 'success', title: existing ? '区域已保存' : `已新建区域「${body.name}」` });
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
      title={existing ? `编辑区域「${existing.name}」` : `${floor?.code ?? ''} 新建区域`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={save} data-testid="zone-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="区域名" htmlFor="zone-name">
            <Input id="zone-name" maxLength={MAX_ZONE_NAME} value={name} onChange={(e) => setName(e.target.value)} data-autofocus data-testid="zone-name" />
          </Field>
          <Field label="英文名" htmlFor="zone-name-en" hint="可以空着">
            <Input id="zone-name-en" maxLength={MAX_NAME_EN} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </Field>
        </div>
        <Field label="备注" htmlFor="zone-note">
          <Textarea id="zone-note" maxLength={MAX_SPACE_NOTE} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <Field label="排序" htmlFor="zone-order">
            <Input fullWidth={false} id="zone-order" type="number" min={0} max={9999} className="num w-24" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </Field>
          {existing && (
            <Segmented
              ariaLabel="区域状态"
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              options={[
                { value: 'on', label: '在用' },
                { value: 'off', label: '停用' },
              ]}
            />
          )}
        </div>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
