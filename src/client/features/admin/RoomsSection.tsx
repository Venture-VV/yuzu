// 后台「客房」（S7，v0.7.4，见 docs/ROOMS.md）：客房规则（只有店主能改：开关、退房时间、加收一晚的时刻、钟点房宽限、入住默认押金）、
// 房型与房价（全天房每晚、钟点房每段；能管理价目的岗位）、房间（房号、楼层、房型）。
// 房型、房间停用不删除，历史入住单与结账单照常显示；有人住的房间不能停用、不能改房型；改房价只影响之后的入住。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { formatYuan, centsToInput, parseYuan } from '@shared/money';
import {
  DEFAULT_BLOCK_MINUTES,
  DEFAULT_HOURLY_PRICE,
  DEFAULT_ROOM_RULES,
  MAX_ROOM_FLOOR,
  MAX_ROOM_NO,
  MAX_ROOM_TYPE_NAME,
  ROOM_KIND_LABELS,
  type Room,
  type RoomKind,
  type RoomRules,
  type RoomsAdmin,
  type RoomType,
} from '@shared/rooms';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { minuteText, roomsAdminKey as adminKey, useRoomsAdmin } from '../rooms/queries';
import { rateText } from '../rooms/parts';
import { AdminPage } from './AdminShell';


export function RoomsSection() {
  return (
    <AdminPage section="rooms" description="客房功能开关与退房、押金规则，房型与房价（全天房、钟点房），房间（房号、楼层）。">
      <div className="space-y-5">
        <RulesCard />
        <TypesCard />
        <RoomsCard />
      </div>
    </AdminPage>
  );
}

/** "12:00" → 720；格式不对返回 null */
const parseClock = (v: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
};

function RulesCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const admin = useRoomsAdmin();
  const [draft, setDraft] = useState<{ enabled: boolean; checkout: string; lateFull: string; grace: string; deposit: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toDraft = (r: RoomRules) => ({
    enabled: r.enabled,
    checkout: minuteText(r.checkoutMinute),
    lateFull: minuteText(r.lateFullMinute),
    grace: String(r.hourlyGraceMinutes),
    deposit: r.defaultDeposit ? centsToInput(r.defaultDeposit) : '0',
  });
  if (admin.data && !draft) setDraft(toDraft(admin.data.rules));
  if (!draft || !admin.data) return <Skeleton className="h-48" />;
  const editable = can('settings.manage');
  const checkoutMinute = parseClock(draft.checkout);
  const lateFullMinute = parseClock(draft.lateFull);
  const grace = Number(draft.grace);
  const deposit = parseYuan(draft.deposit || '0');
  const problem =
    checkoutMinute === null || lateFullMinute === null
      ? '时间格式为 时:分，例如 12:00'
      : lateFullMinute <= checkoutMinute
        ? '加收一晚的时刻要晚于退房时间'
        : !Number.isInteger(grace) || grace < 0 || grace > 120
          ? '宽限分钟要在 0 到 120 之间'
          : deposit === null || deposit < 0
            ? '默认押金不正确'
            : null;
  const next: RoomRules | null =
    problem === null ? { enabled: draft.enabled, checkoutMinute: checkoutMinute!, lateFullMinute: lateFullMinute!, hourlyGraceMinutes: grace, defaultDeposit: deposit! } : null;
  const dirty = !!next && JSON.stringify(next) !== JSON.stringify(admin.data.rules);
  const set = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });
  const activeRooms = admin.data.rooms.filter((r) => r.active).length;

  const save = async () => {
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.put<RoomsAdmin>('/api/admin/rooms/rules', next);
      qc.setQueryData(adminKey, data);
      setDraft(toDraft(data.rules));
      await qc.invalidateQueries({ queryKey: qk.session });
      await qc.invalidateQueries({ queryKey: ['rooms'] });
      toast({ tone: 'success', title: '客房规则已保存', body: data.rules.enabled ? '主导航有「客房」：房态、入住、押金、退房与夜审。' : '客房功能已关闭，前台与结账与升级前一样。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, hint: string, control: React.ReactNode, pending = false) => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-[200px] flex-1">
        <p className="flex items-center gap-2 text-[14px] font-bold">
          {label}
          {pending && <PendingBadge title="按洗浴中心客房、酒店常见做法先定的默认，待店主确认" />}
        </p>
        <p className="text-[12.5px] text-ink-3">{hint}</p>
      </div>
      {control}
    </div>
  );
  const clockInput = (value: string, onChange: (v: string) => void, label: string, testId: string) => (
    <Input fullWidth={false} value={value} onChange={(e) => onChange(e.target.value)} disabled={!editable} placeholder="12:00" className="num h-10 w-24 shrink-0 text-center" aria-label={label} data-testid={testId} />
  );

  return (
    <Card className="p-5" data-testid="rooms-rules-card">
      <SectionTitle aside={!editable && <Badge>只有店主能改</Badge>}>客房规则</SectionTitle>
      <div className="mt-1 divide-y divide-line/70">
        {row(
          '客房功能',
          `开启后主导航有「客房」：房态看板、入住、押金、退房与夜审。关闭时前台、结账与升级前完全一样。现在有 ${activeRooms} 间启用的房间。`,
          <Segmented
            ariaLabel="客房功能"
            value={draft.enabled ? 'on' : 'off'}
            onChange={(v) => editable && set({ enabled: v === 'on' })}
            options={[
              { value: 'off', label: '关闭', disabled: !editable },
              { value: 'on', label: '开启', disabled: !editable },
            ]}
          />,
        )}
        {row(
          '全天房退房时间',
          '过了这个时间退房加收半天房费（按营业日算：入住后的第二个营业日起）。',
          clockInput(draft.checkout, (v) => set({ checkout: v }), '退房时间', 'rooms-checkout-time'),
          true,
        )}
        {row(
          '加收一晚的时刻',
          '过了这个时刻退房再加收一晚（不再收半天）；夜审也在这个时刻以后做，给还在住的客人挂今晚的房费。',
          clockInput(draft.lateFull, (v) => set({ lateFull: v }), '加收一晚的时刻', 'rooms-late-full-time'),
          true,
        )}
        {row(
          '钟点房超时宽限',
          '钟点房超过已付时段多少分钟内不补下一段。',
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Input fullWidth={false} type="number" inputMode="numeric" min={0} max={120} value={draft.grace} disabled={!editable} onChange={(e) => set({ grace: e.target.value })} className="num h-10 w-20" aria-label="钟点房超时宽限（分钟）" data-testid="rooms-grace" />
            <span className="text-[13px] text-ink-3">分钟</span>
          </span>,
          true,
        )}
        {row(
          '入住默认押金',
          '入住时默认收的押金，入住时可以改；填 0 为默认不收（住客都有手牌，离店前在前台结清）。',
          <div className="w-[140px]">
            <MoneyInput value={draft.deposit} onChange={(e) => set({ deposit: e.target.value })} disabled={!editable} aria-label="默认押金" className="h-10" data-testid="rooms-default-deposit" />
          </div>,
          true,
        )}
      </div>
      {problem && <Notice tone="error" title={problem} className="mt-3" />}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-[12px] text-ink-4">
          {admin.data.rulesUpdatedAt ? `最近由${admin.data.rulesUpdatedBy ?? '系统'}于 ${formatDateTime(admin.data.rulesUpdatedAt)} 修改` : '一直按默认'}
        </span>
        {editable && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(toDraft({ ...DEFAULT_ROOM_RULES, enabled: draft.enabled }))}>
            其他规则恢复默认
          </Button>
        )}
        {editable && (
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={save} data-testid="rooms-rules-save">
            保存客房规则
          </Button>
        )}
      </div>
    </Card>
  );
}

function TypesCard() {
  const can = useCan();
  const admin = useRoomsAdmin();
  const [editing, setEditing] = useState<RoomType | 'new' | null>(null);
  if (!admin.data) return <Skeleton className="h-40" />;
  const editable = can('catalog.manage');
  const types = admin.data.types;
  return (
    <Card className="p-5" data-testid="rooms-types">
      <SectionTitle
        aside={
          editable && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="rooms-type-new">
              新建房型
            </Button>
          )
        }
      >
        房型与房价
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        全天房按晚计价（入住挂第一晚、夜审每晚挂一晚、退房时补齐）；钟点房按小时（每段 60 分钟）或按段计价（入住挂第一段、续住加一段、超时按段补）。改房价只影响之后的入住，在住的客人按入住时的房价。
      </p>
      {types.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">
          还没有房型。{editable ? '点「新建房型」，例如「标准间」全天房 ¥288 / 晚、「钟点房」¥60 / 小时。' : ''}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {types.map((t) => (
            <li key={t.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', !t.active && 'bg-paper-2/50 opacity-70')} data-testid={`rooms-type-${t.name}`}>
              <span className="min-w-[96px] text-[14.5px] font-bold">{t.name}</span>
              <Badge tone={t.kind === 'daily' ? 'pine' : 'yuzu'}>{ROOM_KIND_LABELS[t.kind]}</Badge>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{rateText(t.kind, t.price, t.blockMinutes)}</span>
              <span className="text-[12px] text-ink-4">{t.roomCount} 间</span>
              <span className="num text-[12px] text-ink-4">排序 {t.sortOrder}</span>
              {!t.active && <Badge tone="clay">已停用</Badge>}
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                  编辑
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <TypeDialog target={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function TypeDialog({ target, onClose }: { target: RoomType | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<RoomKind>('daily');
  const [price, setPrice] = useState('');
  const [block, setBlock] = useState(String(DEFAULT_BLOCK_MINUTES));
  const [sortOrder, setSortOrder] = useState('0');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<typeof target>(null);
  if (target !== opened) {
    setOpened(target);
    const t = target && target !== 'new' ? target : null;
    setName(t?.name ?? '');
    setKind(t?.kind ?? 'daily');
    setPrice(t ? centsToInput(t.price) : '');
    setBlock(String(t?.blockMinutes ?? DEFAULT_BLOCK_MINUTES));
    setSortOrder(String(t?.sortOrder ?? 0));
    setActive(t?.active ?? true);
    setError(null);
  }
  const cents = parseYuan(price);
  const blockNum = Number(block);
  const order = Number(sortOrder);
  const ok =
    name.trim().length >= 1 &&
    name.trim().length <= MAX_ROOM_TYPE_NAME &&
    cents !== null &&
    cents > 0 &&
    (kind === 'daily' || (Number.isInteger(blockNum) && blockNum >= 30 && blockNum <= 720)) &&
    Number.isInteger(order) &&
    order >= 0 &&
    order <= 9999;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), kind, price: cents!, blockMinutes: kind === 'hourly' ? blockNum : null, sortOrder: order, active };
      const next = target === 'new' ? await api.post<RoomsAdmin>('/api/admin/rooms/types', body) : await api.put<RoomsAdmin>(`/api/admin/rooms/types/${target!.id}`, body);
      qc.setQueryData(adminKey, next);
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      toast({ tone: 'success', title: target === 'new' ? `已新建房型「${body.name}」` : '房型已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : onClose}
      title={target === 'new' ? '新建房型' : '编辑房型'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={save} data-testid="rooms-type-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="房型名称" htmlFor="room-type-name" hint={`最多 ${MAX_ROOM_TYPE_NAME} 字，例如 标准间、大床房、钟点房`}>
          <Input id="room-type-name" value={name} maxLength={MAX_ROOM_TYPE_NAME} onChange={(e) => setName(e.target.value)} data-autofocus data-testid="rooms-type-name" />
        </Field>
        <Segmented
          ariaLabel="计价方式"
          value={kind}
          onChange={(k) => {
            setKind(k);
            // 新建钟点房：按小时计费，每段 1 小时、¥60 / 小时（默认，待确认；可改）
            if (target === 'new' && k === 'hourly' && !price.trim()) setPrice(centsToInput(DEFAULT_HOURLY_PRICE));
          }}
          options={[
            { value: 'daily', label: '全天房（按晚）' },
            { value: 'hourly', label: '钟点房（按小时 / 按段）' },
          ]}
        />
        <div className="flex flex-wrap gap-4">
          <Field label={kind === 'daily' ? '每晚房价' : Number(block) === 60 ? '每小时房价' : '每段房价'} htmlFor="room-type-price" hint={kind === 'hourly' && target === 'new' ? '默认 ¥60 / 小时（待确认）' : undefined}>
            <div className="w-[160px]">
              <MoneyInput id="room-type-price" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="rooms-type-price" />
            </div>
          </Field>
          {kind === 'hourly' && (
            <Field label="每段时长（分钟）" htmlFor="room-type-block" hint="30–720；60 = 按小时计费，180 = 3 小时一段">
              <Input fullWidth={false} id="room-type-block" type="number" inputMode="numeric" min={30} max={720} value={block} onChange={(e) => setBlock(e.target.value)} className="num w-28" data-testid="rooms-type-block" />
            </Field>
          )}
          <Field label="排序" htmlFor="room-type-order" hint="小的排前面">
            <Input fullWidth={false} id="room-type-order" type="number" inputMode="numeric" min={0} max={9999} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="num w-28" />
          </Field>
        </div>
        {target !== 'new' && target && target.price !== cents && cents !== null && (
          <p className="text-[12.5px] text-ink-3">
            原房价 <Money cents={target.price} />：改价只影响之后的入住，在住的客人按入住时的房价。
          </p>
        )}
        {target !== 'new' && (
          <Segmented
            ariaLabel="房型状态"
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function RoomsCard() {
  const can = useCan();
  const admin = useRoomsAdmin();
  const [editing, setEditing] = useState<Room | 'new' | null>(null);
  if (!admin.data) return <Skeleton className="h-40" />;
  const editable = can('catalog.manage');
  const { rooms, types } = admin.data;
  const typeName = (id: number) => types.find((t) => t.id === id)?.name ?? '';
  return (
    <Card className="p-5" data-testid="rooms-rooms">
      <SectionTitle
        aside={
          editable && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} disabled={!types.some((t) => t.active)} data-testid="rooms-room-new">
              新建房间
            </Button>
          )
        }
      >
        房间
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">房号在房态看板上按楼层排在一起。有人住的房间不能停用、不能改房型（先退房或换房）；房间不删除，历史入住单照常显示房号。</p>
      {rooms.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">
          还没有房间。{editable ? (types.some((t) => t.active) ? '点「新建房间」，例如 301（3 楼）。' : '先建一个房型，再建房间。') : ''}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {rooms.map((r) => (
            <li key={r.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', !r.active && 'bg-paper-2/50 opacity-70')} data-testid={`rooms-room-${r.roomNo}`}>
              <span className="num min-w-[72px] text-[14.5px] font-bold">{r.roomNo}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">
                {r.floor ? `${r.floor} 楼` : '未分楼层'} · {typeName(r.roomTypeId)}
              </span>
              {r.occupied && <Badge tone="yuzu">在住</Badge>}
              <span className="num text-[12px] text-ink-4">排序 {r.sortOrder}</span>
              {!r.active && <Badge tone="clay">已停用</Badge>}
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                  编辑
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <RoomDialog target={editing} types={types} floors={[...new Set(rooms.map((r) => r.floor).filter(Boolean))]} onClose={() => setEditing(null)} />
    </Card>
  );
}

function RoomDialog({ target, types, floors, onClose }: { target: Room | 'new' | null; types: RoomType[]; floors: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [roomNo, setRoomNo] = useState('');
  const [floor, setFloor] = useState('');
  const [typeId, setTypeId] = useState<number | null>(null);
  const [sortOrder, setSortOrder] = useState('0');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<typeof target>(null);
  if (target !== opened) {
    setOpened(target);
    const r = target && target !== 'new' ? target : null;
    setRoomNo(r?.roomNo ?? '');
    setFloor(r?.floor ?? '');
    setTypeId(r?.roomTypeId ?? types.find((t) => t.active)?.id ?? null);
    setSortOrder(String(r?.sortOrder ?? 0));
    setActive(r?.active ?? true);
    setError(null);
  }
  const order = Number(sortOrder);
  const choices = types.filter((t) => t.active || (target !== 'new' && target?.roomTypeId === t.id));
  const ok = roomNo.trim().length >= 1 && roomNo.trim().length <= MAX_ROOM_NO && floor.trim().length <= MAX_ROOM_FLOOR && typeId !== null && Number.isInteger(order) && order >= 0 && order <= 9999;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { roomNo: roomNo.trim(), floor: floor.trim(), roomTypeId: typeId!, sortOrder: order, active };
      const next = target === 'new' ? await api.post<RoomsAdmin>('/api/admin/rooms/rooms', body) : await api.put<RoomsAdmin>(`/api/admin/rooms/rooms/${target!.id}`, body);
      qc.setQueryData(adminKey, next);
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      toast({ tone: 'success', title: target === 'new' ? `已新建房间「${body.roomNo}」` : '房间已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : onClose}
      title={target === 'new' ? '新建房间' : '编辑房间'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={save} data-testid="rooms-room-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <Field label="房号" htmlFor="room-no" hint={`最多 ${MAX_ROOM_NO} 字，例如 301、8A`}>
            <Input fullWidth={false} id="room-no" value={roomNo} maxLength={MAX_ROOM_NO} onChange={(e) => setRoomNo(e.target.value)} className="num w-32" data-autofocus data-testid="rooms-room-no" />
          </Field>
          <Field label="楼层" htmlFor="room-floor" hint="选填，例如 3">
            <Input fullWidth={false} id="room-floor" value={floor} maxLength={MAX_ROOM_FLOOR} onChange={(e) => setFloor(e.target.value)} list="room-floors" className="num w-28" data-testid="rooms-room-floor" />
            <datalist id="room-floors">
              {floors.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
          <Field label="排序" htmlFor="room-order" hint="同一楼层小的排前面">
            <Input fullWidth={false} id="room-order" type="number" inputMode="numeric" min={0} max={9999} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="num w-28" />
          </Field>
        </div>
        <Field label="房型" htmlFor="room-type">
          <Select id="room-type" value={typeId ?? ''} onChange={(e) => setTypeId(Number(e.target.value) || null)} data-testid="rooms-room-type">
            {choices.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {ROOM_KIND_LABELS[t.kind]} {formatYuan(t.price)}
                {t.active ? '' : '（已停用）'}
              </option>
            ))}
          </Select>
        </Field>
        {target !== 'new' && (
          <Segmented
            ariaLabel="房间状态"
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
