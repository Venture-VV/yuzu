// 后台「微信小程序」（小程序线，docs/MINIPROGRAM.md 第 5 节）：对顾客开放的开关、两家店的门店信息、首页轮播、
// 价目项目的对外介绍、会员的微信绑定与解绑。
// 修改都带版本号：没收到结果再保存，会因为版本号对不上被拒绝，不会改两次；新建轮播、解绑带操作编号，重提返回原来那次。
// 维护内容要「维护小程序内容」；只有「解绑会员的微信」的（值班经理）只看到绑定这一页。

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Link2Off, Pencil, Plus, Search, X } from 'lucide-react';
import {
  MP_BANNER_LINKS,
  type MpAdminData,
  type MpBannerAdmin,
  type MpBannerLink,
  type MpBindingRow,
  type MpItemIntroAdmin,
  type MpStoreAdmin,
} from '@shared/mp';
import { IMAGE_MAX_EDGE, IMAGE_QUALITY, MAX_IMAGE_BYTES } from '@shared/requests';
import type { MemberSummary } from '@shared/types';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';

type Tab = 'store' | 'banners' | 'items' | 'bindings';
const key = ['mp', 'admin'] as const;
const imageUrl = (id: number) => `/api/admin/mp/images/${id}`;

/** 上传前在浏览器里压缩成 JPEG（与采购单图片同样的做法：最长边 1600、质量 0.8，压缩后不超过 1 MB） */
async function compress(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('只能上传图片');
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const g = canvas.getContext('2d');
    if (!g) throw new Error('canvas');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', IMAGE_QUALITY));
    if (blob) return blob;
  } catch {
    /* 浏览器不支持就原样上传（服务端再核对大小与格式） */
  }
  return file;
}
const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('读取图片失败'));
    r.readAsDataURL(blob);
  });
async function uploadMpImage(file: File): Promise<number> {
  const blob = await compress(file);
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片压缩后仍超过 1 MB，请换一张或裁小一点');
  const mime = blob.type === 'image/png' || blob.type === 'image/webp' ? blob.type : 'image/jpeg';
  return (await api.post<{ id: number }>('/api/admin/mp/images', { mime, data: await toBase64(blob) }, { timeoutMs: 30_000 })).id;
}

/** 没收到结果时的统一提示：带版本号 / 操作编号，刷新后核对，重提不会改两次 */
function saveError(error: unknown): string {
  return error instanceof UncertainError ? '没收到结果，请刷新后核对；再保存不会改两次' : errorMessage(error);
}

export function MpAdminSection() {
  const can = useCan();
  const canContent = can('mp.content');
  const q = useQuery({ queryKey: key, queryFn: () => api.get<MpAdminData>('/api/admin/mp') });
  const tabs = useMemo(
    () =>
      [
        { value: 'store' as const, label: '开关与门店', show: canContent },
        { value: 'banners' as const, label: '首页轮播', show: canContent },
        { value: 'items' as const, label: '项目介绍', show: canContent },
        { value: 'bindings' as const, label: '会员的微信', show: true },
      ].filter((t) => t.show),
    [canContent],
  );
  const [tab, setTab] = useState<Tab>(tabs[0]!.value);
  return (
    <AdminPage
      section="mp"
      wide
      description="顾客在微信小程序里看到的门店信息、首页轮播与项目介绍；价格照旧读「价目与套餐」。会员用微信验证过的手机号绑定，换手机号、换微信在这里解绑。"
    >
      <div className="space-y-4">
        {tabs.length > 1 && <Segmented value={tab} onChange={setTab} options={tabs} ariaLabel="小程序后台分页" />}
        {!q.data ? (
          <Skeleton className="h-48" />
        ) : tab === 'store' ? (
          <StoresTab data={q.data} />
        ) : tab === 'banners' ? (
          <BannersTab banners={q.data.banners} />
        ) : tab === 'items' ? (
          <ItemsTab items={q.data.items} />
        ) : (
          <BindingsTab />
        )}
      </div>
    </AdminPage>
  );
}

// ── 图片 ──

function ImagePicker({ imageId, onChange, label = '图片' }: { imageId: number | null; onChange: (id: number | null) => void; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Field label={label} hint="会压缩成宽高不超过 1600 像素的 JPEG；顾客看到的是这张图">
      <div className="flex items-center gap-3">
        {imageId ? (
          <img src={imageUrl(imageId)} alt="" className="h-20 w-32 rounded-md border border-line object-cover" />
        ) : (
          <div className="grid h-20 w-32 place-items-center rounded-md border border-dashed border-line-strong text-[12px] text-ink-3">没有图片</div>
        )}
        <label className={cn('inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-semibold', busy && 'pointer-events-none opacity-60')}>
          <ImagePlus className="size-4" />
          {busy ? '上传中…' : imageId ? '换一张' : '上传'}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            data-testid="mp-image-input"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setBusy(true);
              try {
                onChange(await uploadMpImage(file));
              } catch (error) {
                toast({ tone: 'error', title: '图片没有上传', body: errorMessage(error) });
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {imageId && (
          <Button variant="ghost" size="sm" icon={<X className="size-4" />} onClick={() => onChange(null)}>
            不用图片
          </Button>
        )}
      </div>
    </Field>
  );
}

// ── 开关与门店 ──

function StoresTab({ data }: { data: MpAdminData }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const enabled = data.rules.enabled;
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-[15px] font-semibold text-ink">对顾客开放</p>
          <p className="text-[13px] text-ink-3">{enabled ? '已开放：顾客能在小程序里看到门店信息、价目、导览，绑定会员。' : '没开放：小程序只显示「还没开放」。网关与门店系统接好、内容填好后再开。'}</p>
        </div>
        <Segmented
          value={enabled ? 'on' : 'off'}
          ariaLabel="对顾客开放"
          onChange={async (v) => {
            if (busy || (v === 'on') === enabled) return;
            setBusy(true);
            try {
              await api.put('/api/admin/mp/rules', { enabled: v === 'on' });
              await qc.invalidateQueries({ queryKey: key });
              toast({ tone: 'success', title: v === 'on' ? '小程序已对顾客开放' : '小程序已关闭' });
            } catch (error) {
              toast({ tone: 'error', title: '没有保存', body: saveError(error) });
            } finally {
              setBusy(false);
            }
          }}
          options={[
            { value: 'off', label: '关闭' },
            { value: 'on', label: '开放' },
          ]}
        />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {data.stores.map((s) => (
          <StoreForm key={`${s.code}-${s.version}`} store={s} />
        ))}
      </div>
    </div>
  );
}

const coord = (v: string): number | null => (v.trim() === '' ? null : Number(v));

function StoreForm({ store }: { store: MpStoreAdmin }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: store.name,
    hours: store.hours,
    address: store.address,
    phone: store.phone,
    latitude: store.latitude === null ? '' : String(store.latitude),
    longitude: store.longitude === null ? '' : String(store.longitude),
    notice: store.notice,
    imageId: store.imageId,
    visible: store.visible,
  });
  const [saving, setSaving] = useState(false);
  const fid = (k: string) => `mp-store-${store.code}-${k}`;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/admin/mp/stores/${store.code}`, { ...f, version: store.version, latitude: coord(f.latitude), longitude: coord(f.longitude) });
      await qc.invalidateQueries({ queryKey: key });
      toast({ tone: 'success', title: `${f.name}的门店信息已保存` });
    } catch (error) {
      toast({ tone: 'error', title: '没有保存', body: saveError(error) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="space-y-3 p-4" data-testid={`mp-store-${store.code}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[15px] font-semibold text-ink">{store.name}</p>
        {store.isHome ? <Badge tone="pine">本系统所在的门店</Badge> : <Badge>只放门店信息</Badge>}
      </div>
      <Field label="名称" htmlFor={fid('name')}>
        <Input id={fid('name')} value={f.name} maxLength={32} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="营业时间" hint="例如：全天营业；或 10:00 – 次日 02:00" htmlFor={fid('hours')}>
        <Input id={fid('hours')} value={f.hours} maxLength={60} onChange={(e) => set('hours', e.target.value)} />
      </Field>
      <Field label="地址" htmlFor={fid('address')}>
        <Input id={fid('address')} value={f.address} maxLength={120} onChange={(e) => set('address', e.target.value)} />
      </Field>
      <Field label="电话" htmlFor={fid('phone')}>
        <Input id={fid('phone')} value={f.phone} maxLength={30} onChange={(e) => set('phone', e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="纬度" hint="导航用（微信地图坐标）" htmlFor={fid('latitude')}>
          <Input id={fid('latitude')} value={f.latitude} inputMode="decimal" onChange={(e) => set('latitude', e.target.value)} />
        </Field>
        <Field label="经度" htmlFor={fid('longitude')}>
          <Input id={fid('longitude')} value={f.longitude} inputMode="decimal" onChange={(e) => set('longitude', e.target.value)} />
        </Field>
      </div>
      <Field label="门店公告" hint="例如停水检修、节假日营业时间；最多 300 字" htmlFor={fid('notice')}>
        <Textarea id={fid('notice')} value={f.notice} maxLength={300} rows={3} onChange={(e) => set('notice', e.target.value)} />
      </Field>
      <ImagePicker imageId={f.imageId} onChange={(id) => set('imageId', id)} label="门店图片" />
      <label className="flex items-center gap-2 text-[13.5px]">
        <input type="checkbox" checked={f.visible} onChange={(e) => set('visible', e.target.checked)} className="size-4 accent-[var(--color-pine)]" />
        在小程序里显示这家店
      </label>
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} onClick={save}>
          保存
        </Button>
      </div>
    </Card>
  );
}

// ── 首页轮播 ──

function BannersTab({ banners }: { banners: MpBannerAdmin[] }) {
  const [target, setTarget] = useState<{ mode: 'new' } | { mode: 'edit'; banner: MpBannerAdmin } | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setTarget({ mode: 'new' })} data-testid="mp-banner-new">
          新建轮播
        </Button>
      </div>
      {banners.length === 0 ? (
        <Notice tone="info" title="还没有轮播">首页版头照 VI 用门店的氛围实拍图加标志；活动图也放在这里，按日期自动上下架。</Notice>
      ) : (
        <Card className="divide-y divide-line p-0">
          {banners.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <img src={imageUrl(b.imageId)} alt="" className="h-14 w-24 rounded-md border border-line object-cover" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{b.title}</p>
                <p className="text-[12.5px] text-ink-3">
                  点了去：{MP_BANNER_LINKS.find((l) => l.value === b.link)?.label} · {b.startsOn ?? '不限'} 至 {b.endsOn ?? '不限'} · 排序 {b.sortOrder}
                </p>
              </div>
              {b.active ? <Badge tone="pine">显示中</Badge> : <Badge>已停用</Badge>}
              <Button variant="secondary" size="sm" icon={<Pencil className="size-4" />} onClick={() => setTarget({ mode: 'edit', banner: b })}>
                修改
              </Button>
            </div>
          ))}
        </Card>
      )}
      {target && <BannerDialog target={target} onClose={() => setTarget(null)} />}
    </div>
  );
}

function BannerDialog({ target, onClose }: { target: { mode: 'new' } | { mode: 'edit'; banner: MpBannerAdmin }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const b = target.mode === 'edit' ? target.banner : null;
  // 新建的操作编号在这次弹窗里一直用同一个：没收到结果再提交，返回原来那条，不会多建
  const [clientKey] = useState(uuid);
  const [f, setF] = useState({
    title: b?.title ?? '',
    imageId: b?.imageId ?? null,
    link: (b?.link ?? 'none') as MpBannerLink,
    startsOn: b?.startsOn ?? '',
    endsOn: b?.endsOn ?? '',
    sortOrder: String(b?.sortOrder ?? 0),
    active: b?.active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setSaving(true);
    const body = { title: f.title, imageId: f.imageId, link: f.link, startsOn: f.startsOn || null, endsOn: f.endsOn || null, sortOrder: Number(f.sortOrder) || 0 };
    try {
      if (b) await api.put(`/api/admin/mp/banners/${b.id}`, { ...body, version: b.version, active: f.active });
      else await api.post('/api/admin/mp/banners', { ...body, clientKey });
      await qc.invalidateQueries({ queryKey: key });
      toast({ tone: 'success', title: b ? '轮播已保存' : '轮播已新建' });
      onClose();
    } catch (error) {
      toast({ tone: 'error', title: '没有保存', body: saveError(error) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={b ? '修改轮播' : '新建轮播'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} disabled={!f.title.trim() || !f.imageId} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="标题" hint="小程序里不显示，只用来认是哪一张" htmlFor="mp-banner-title">
          <Input id="mp-banner-title" value={f.title} maxLength={40} onChange={(e) => set('title', e.target.value)} data-testid="mp-banner-title" />
        </Field>
        <ImagePicker imageId={f.imageId} onChange={(id) => set('imageId', id)} label="轮播图" />
        <Field label="点了去哪" htmlFor="mp-banner-link">
          <Select id="mp-banner-link" value={f.link} onChange={(e) => set('link', e.target.value as MpBannerLink)}>
            {MP_BANNER_LINKS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="开始日期" hint="空着为不限" htmlFor="mp-banner-starts">
            <Input id="mp-banner-starts" type="date" value={f.startsOn} onChange={(e) => set('startsOn', e.target.value)} />
          </Field>
          <Field label="结束日期" hint="含这一天" htmlFor="mp-banner-ends">
            <Input id="mp-banner-ends" type="date" value={f.endsOn} onChange={(e) => set('endsOn', e.target.value)} />
          </Field>
        </div>
        <Field label="排序" hint="小的排前面" htmlFor="mp-banner-sort">
          <Input id="mp-banner-sort" value={f.sortOrder} inputMode="numeric" onChange={(e) => set('sortOrder', e.target.value)} />
        </Field>
        {b && (
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} className="size-4" />
            显示这张轮播
          </label>
        )}
      </div>
    </Dialog>
  );
}

// ── 项目介绍 ──

function ItemsTab({ items }: { items: MpItemIntroAdmin[] }) {
  const [editing, setEditing] = useState<MpItemIntroAdmin | null>(null);
  const [q, setQ] = useState('');
  const shown = items.filter((i) => i.active && (!q.trim() || i.name.includes(q.trim()) || i.category.includes(q.trim())));
  return (
    <div className="space-y-3">
      <Notice tone="info">价格读「价目与套餐」，这里只写顾客看到的介绍与图片。停用的项目小程序里不显示。</Notice>
      <Input placeholder="按项目名或分类找" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
      <Card className="divide-y divide-line p-0">
        {shown.map((i) => (
          <div key={i.itemId} className="flex flex-wrap items-center gap-3 px-4 py-3">
            {i.imageId ? (
              <img src={imageUrl(i.imageId)} alt="" className="size-12 rounded-md border border-line object-cover" />
            ) : (
              <div className="size-12 rounded-md border border-dashed border-line-strong" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-ink">
                {i.name} <span className="text-[12.5px] font-normal text-ink-3">{i.category}</span>
              </p>
              <p className="truncate text-[12.5px] text-ink-3">{i.intro || '还没写介绍'}</p>
            </div>
            <Button variant="secondary" size="sm" icon={<Pencil className="size-4" />} onClick={() => setEditing(i)}>
              写介绍
            </Button>
          </div>
        ))}
        {shown.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-ink-3">没有对上的项目</p>}
      </Card>
      {editing && <IntroDialog item={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function IntroDialog({ item, onClose }: { item: MpItemIntroAdmin; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [intro, setIntro] = useState(item.intro);
  const [imageId, setImageId] = useState(item.imageId);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/admin/mp/items/${item.itemId}/intro`, { version: item.version, intro, imageId });
      await qc.invalidateQueries({ queryKey: key });
      toast({ tone: 'success', title: `「${item.name}」的介绍已保存` });
      onClose();
    } catch (error) {
      toast({ tone: 'error', title: '没有保存', body: saveError(error) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`「${item.name}」的介绍`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="介绍" hint="最多 300 字；不写价格，价格照价目表显示" htmlFor="mp-intro-text">
          <Textarea id="mp-intro-text" value={intro} maxLength={300} rows={4} onChange={(e) => setIntro(e.target.value)} />
        </Field>
        <ImagePicker imageId={imageId} onChange={setImageId} label="项目图片" />
      </div>
    </Dialog>
  );
}

// ── 会员的微信 ──

function BindingsTab() {
  const can = useCan();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [member, setMember] = useState<MemberSummary | null>(null);
  const found = useQuery({ queryKey: ['mp', 'members', term], queryFn: () => api.get<MemberSummary[]>(`/api/members?q=${encodeURIComponent(term)}&limit=8`), enabled: term.length > 0 });
  const bindings = useQuery({
    queryKey: ['mp', 'bindings', member?.id],
    queryFn: () => api.get<MpBindingRow[]>(`/api/admin/mp/members/${member!.id}/bindings`),
    enabled: !!member,
  });
  const [unbinding, setUnbinding] = useState<MpBindingRow | null>(null);
  useEffect(() => setUnbinding(null), [member?.id]);
  return (
    <div className="space-y-3">
      <Notice tone="info">会员用微信验证过的手机号自己绑定。换手机号、换微信时，核对本人后在这里解绑，再让客人用新的微信或手机号重新绑定。</Notice>
      <form
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setMember(null);
          setTerm(q.trim());
        }}
      >
        <Input placeholder="会员号、姓名或手机号" value={q} onChange={(e) => setQ(e.target.value)} data-testid="mp-bindings-search" />
        <Button type="submit" variant="secondary" icon={<Search className="size-4" />}>
          找会员
        </Button>
      </form>
      {term && !member && (
        <Card className="divide-y divide-line p-0">
          {found.data?.map((m) => (
            <button key={m.id} type="button" className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-paper" onClick={() => setMember(m)}>
              <span className="font-semibold text-ink">{m.name}</span>
              <span className="text-[12.5px] text-ink-3">
                {m.memberNo} · {m.phone}
              </span>
            </button>
          ))}
          {found.data?.length === 0 && <p className="px-4 py-4 text-center text-[13px] text-ink-3">没找到会员</p>}
        </Card>
      )}
      {member && (
        <Card className="space-y-2 p-4">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-ink">
              {member.name} <span className="text-[12.5px] font-normal text-ink-3">{member.memberNo}</span>
            </p>
            <Button variant="ghost" size="sm" onClick={() => setMember(null)}>
              换一位
            </Button>
          </div>
          {!bindings.data ? (
            <Skeleton className="h-16" />
          ) : bindings.data.length === 0 ? (
            <p className="text-[13px] text-ink-3">还没绑定过微信</p>
          ) : (
            <div className="divide-y divide-line">
              {bindings.data.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1 text-[13.5px]">
                    <p>
                      微信 …{b.openidTail} · 手机号 {b.phone} {b.mock && <Badge tone="ember">模拟微信</Badge>}
                    </p>
                    <p className="text-[12.5px] text-ink-3">
                      {formatDateTime(b.boundAt)} 绑定
                      {b.unboundAt && ` · ${formatDateTime(b.unboundAt)} ${b.unboundByName ?? ''}解绑（${b.unbindReason}）`}
                    </p>
                  </div>
                  {b.unboundAt ? (
                    <Badge>已解绑</Badge>
                  ) : can('mp.unbind') ? (
                    <Button variant="secondary" size="sm" icon={<Link2Off className="size-4" />} onClick={() => setUnbinding(b)}>
                      解绑
                    </Button>
                  ) : (
                    <Badge tone="pine">绑定中</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
      {unbinding && member && <UnbindDialog binding={unbinding} memberId={member.id} onClose={() => setUnbinding(null)} />}
    </div>
  );
}

function UnbindDialog({ binding, memberId, onClose }: { binding: MpBindingRow; memberId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  // 这次解绑一直用同一个操作编号：没收到结果再提交，返回原来那次
  const [clientKey] = useState(uuid);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/api/admin/mp/bindings/${binding.id}/unbind`, { clientKey, reason });
      await qc.invalidateQueries({ queryKey: ['mp', 'bindings', memberId] });
      toast({ tone: 'success', title: '已解绑' });
      onClose();
    } catch (error) {
      toast({ tone: 'error', title: '没有解绑', body: saveError(error) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="解绑这个微信"
      description={`微信 …${binding.openidTail}，绑定时的手机号 ${binding.phone}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={saving} disabled={!reason.trim()} onClick={save}>
            解绑
          </Button>
        </>
      }
    >
      <Field label="原因" hint="例如：换手机号、换微信、手机丢了" htmlFor="mp-unbind-reason">
        <Input id="mp-unbind-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus data-testid="mp-unbind-reason" />
      </Field>
    </Dialog>
  );
}
