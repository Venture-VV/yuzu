// 后台「电子菜单」（8.0.10，docs/EMENU.md 第 4 节）：餐桌平板上的菜单在这里排。
//
//   · 分类与版面：分类（名称、英文名、供应时段、排序）；每个分类一页一页排——选版面、往位置里放菜，右边是照平板样子画的预览；
//   · 菜品图文：展示名、英文名、介绍、图片与特写图、规格（挂到价目表的项目）；可以从价目表一键生成初稿；
//   · 设置：平板点餐的开关、起始页大图、版权行、忌口与起菜方式的选项、多久没人动回到起始页。
//
// 价格、估清、上下架不在这里维护：价格读价目表，估清在厨房出品屏，价目项目停用、没挂出品档口的菜平板上自动标「已下架」。
// 各页整批保存、带版本号：别人先改过会被拒绝（EMENU_CHANGED），重新载入再排。

import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, ImagePlus, Pencil, Plus, Search, Trash2, Wand2, X } from 'lucide-react';
import {
  DEFAULT_EMENU_RULES,
  EMENU_LAYOUT_INFO,
  EMENU_LAYOUTS,
  EMENU_MAX_AVOID_OPTIONS,
  EMENU_MAX_FOOTER,
  EMENU_MAX_IDLE_MINUTES,
  EMENU_MAX_NOTE,
  EMENU_MAX_OPTION_LENGTH,
  EMENU_MAX_PAGES,
  EMENU_MAX_SERVE_OPTIONS,
  emenuImageUrl,
  emenuNoteWorstCase,
  formatMinute,
  formatWindow,
  parseMinute,
  type EmenuAdmin,
  type EmenuCategoryAdmin,
  type EmenuCategoryView,
  type EmenuDishAdmin,
  type EmenuDishView,
  type EmenuLayout,
  type EmenuPageAdmin,
  type EmenuRules,
} from '@shared/emenu';
import { formatYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { cn, formatDateTime } from '../../lib/utils';
import { imagePayload } from '../../components/Images';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { Header } from './header';
import { PageCanvas } from './pages';
import './emenu.css';

const adminKey = ['admin', 'emenu'] as const;
const useEmenuAdmin = () => useQuery({ queryKey: adminKey, queryFn: () => api.get<EmenuAdmin>('/api/admin/emenu') });

type Tab = 'pages' | 'dishes' | 'settings';
type Apply = (next: EmenuAdmin) => void;

export function EmenuAdminSection() {
  const admin = useEmenuAdmin();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('pages');
  const apply: Apply = (next) => {
    qc.setQueryData(adminKey, next);
    void qc.invalidateQueries({ queryKey: ['emenu'] });
  };
  return (
    <AdminPage
      section="emenu"
      wide
      description="餐桌平板上的电子菜单：分类与供应时段、每一页的版面与菜品、菜品的图片与介绍、忌口与起菜方式。价格读价目表，估清、上下架跟着厨房与价目表走。"
      actions={
        <a
          href="/emenu"
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3.5 text-[13.5px] font-semibold text-ink hover:border-ink-4"
          data-testid="emenu-admin-open"
        >
          <ExternalLink className="size-4" />
          打开平板点餐页
        </a>
      }
    >
      {admin.isPending ? (
        <Skeleton className="h-64" />
      ) : admin.isError ? (
        <Notice tone="error" title="电子菜单没读出来" action={<Button onClick={() => void admin.refetch()}>再试一次</Button>}>
          {errorMessage(admin.error)}
        </Notice>
      ) : (
        <div className="space-y-5" data-testid="emenu-admin">
          <Checklist data={admin.data} onSettings={() => setTab('settings')} onDishes={() => setTab('dishes')} />
          <Segmented
            ariaLabel="电子菜单的分区"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'pages', label: `分类与版面（${admin.data.categories.length}）` },
              { value: 'dishes', label: `菜品图文（${admin.data.dishes.length}）` },
              { value: 'settings', label: '设置' },
            ]}
          />
          {tab === 'pages' && <PagesTab data={admin.data} apply={apply} />}
          {tab === 'dishes' && <DishesTab data={admin.data} apply={apply} />}
          {tab === 'settings' && <SettingsTab data={admin.data} apply={apply} />}
        </div>
      )}
    </AdminPage>
  );
}

// ───────────────────────── 还差什么 ─────────────────────────

function Checklist({ data, onSettings, onDishes }: { data: EmenuAdmin; onSettings: () => void; onDishes: () => void }) {
  const link = 'font-semibold text-pine underline underline-offset-2';
  const todo: ReactNode[] = [];
  if (!data.diningEnabled)
    todo.push(
      <>
        餐饮功能还没开，菜进不了厨房屏：到「
        <Link to="/admin/dining" className={link}>
          餐饮
        </Link>
        」里打开
      </>,
    );
  if (!data.dishes.some((d) => d.active))
    todo.push(
      <>
        还没有菜品：到「
        <button type="button" className={link} onClick={onDishes}>
          菜品图文
        </button>
        」里添加，或从价目表生成初稿
      </>,
    );
  if (!data.categories.some((c) => c.active && c.pages.length > 0)) todo.push('还没有排好版面的分类');
  if (data.tabletAccounts === 0)
    todo.push(
      <>
        还没有「点餐平板」岗位的账号：到「
        <Link to="/admin/staff" className={link}>
          员工账号
        </Link>
        」里添加，每台平板登录一个
      </>,
    );
  // 平板上只有数字键盘：桌号靠名称里的数字找（输「8」找到「A08」「8 号桌」），名称里没有数字的输不了
  const noDigit = data.tables.filter((t) => !/\d/.test(t.name)).map((t) => t.name);
  if (noDigit.length > 0)
    todo.push(
      <>
        这几张桌的名称里没有数字，平板的数字键盘输不了：{noDigit.slice(0, 6).join('、')}
        {noDigit.length > 6 ? ` 等 ${noDigit.length} 张` : ''}。到「
        <Link to="/admin/dining" className={link}>
          餐饮
        </Link>
        」的桌台里改成带编号的名称
      </>,
    );
  if (data.pinHolders === 0)
    todo.push(
      <>
        还没有员工有点单密码（服务员在平板上确认下单用）：到「
        <Link to="/admin/staff" className={link}>
          员工账号
        </Link>
        」里生成
      </>,
    );
  if (!data.rules.enabled)
    todo.push(
      <>
        都准备好以后，到「
        <button type="button" className={link} onClick={onSettings}>
          设置
        </button>
        」里打开平板点餐
      </>,
    );
  if (todo.length === 0) {
    return (
      <Notice tone="success" title="平板点餐已开启" data-testid="emenu-admin-status">
        {data.tabletAccounts} 个点餐平板账号、{data.pinHolders} 位员工有点单密码。这里保存的改动，平板上 15 秒内跟上。
      </Notice>
    );
  }
  return (
    <Notice tone={data.rules.enabled ? 'warning' : 'info'} title={data.rules.enabled ? '平板点餐开着，但还差几步' : '平板点餐还没开启'} data-testid="emenu-admin-status">
      <ol className="list-decimal space-y-0.5 pl-5">
        {todo.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ol>
    </Notice>
  );
}

// ───────────────────────── 预览 ─────────────────────────

const noop = () => {};

/** 后台里的菜品 → 平板上的样子（预览用：价格、图片都是现在的；停用的、点不了的照平板上的样子标出来） */
function previewDish(d: EmenuDishAdmin): EmenuDishView {
  return {
    id: d.id,
    name: d.name,
    nameEn: d.nameEn,
    tagline: d.tagline,
    description: d.description,
    attrs: d.attrs,
    unit: d.unit,
    imageUrl: emenuImageUrl(d.imageId),
    detailUrl: emenuImageUrl(d.detailImageId),
    specs: d.specs.map((s) => ({ itemId: s.itemId, label: s.label, price: s.price, state: d.active && s.orderable ? 'ok' : 'off', remaining: null })),
  };
}

/** 照平板的样子画一页（整页 1024×768 等比缩小；不能点） */
function PagePreview({ page, category, data, scale }: { page: EmenuPageAdmin; category: EmenuCategoryAdmin; data: EmenuAdmin; scale: number }) {
  const dishOf = new Map(data.dishes.map((d) => [d.id, d]));
  const info = EMENU_LAYOUT_INFO[page.layout];
  const dishes = Array.from({ length: info.slots }, (_, i) => {
    const d = page.dishIds[i] != null ? dishOf.get(page.dishIds[i]!) : undefined;
    return d ? previewDish(d) : null;
  });
  const tabs: EmenuCategoryView[] = data.categories.filter((c) => c.active || c.id === category.id).map((c) => ({ id: c.id, name: c.name, nameEn: c.nameEn, window: c.window, open: true, pages: [] }));
  return (
    <div
      className="emenu shrink-0 overflow-hidden rounded-md border border-line"
      style={{ position: 'relative', width: 1024 * scale, height: 768 * scale, background: 'var(--em-bg)' }}
      aria-hidden
      data-testid="emenu-admin-preview"
    >
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1024, height: 768, transform: `scale(${scale})`, transformOrigin: '0 0', pointerEvents: 'none' }}>
        <PageCanvas page={{ layout: page.layout, title: page.title, titleEn: page.titleEn, dishes }} ctx={{ categoryName: category.name, open: true, preview: true }} />
        <Header categories={tabs} activeId={category.id} onCategory={noop} tagCode="A8060" count={0} bump={0} pending={false} onSearch={noop} onOrder={noop} onTag={noop} />
      </div>
    </div>
  );
}

// ───────────────────────── 分类与版面 ─────────────────────────

interface PagesDraft {
  id: number;
  version: number;
  pages: EmenuPageAdmin[];
}

const samePages = (a: EmenuPageAdmin[], b: EmenuPageAdmin[]) => JSON.stringify(a) === JSON.stringify(b);

/** 这一页有什么不对（与门店系统保存时核对的一样，先在页面上说） */
function pageProblem(p: EmenuPageAdmin): string | null {
  const placed = p.dishIds.filter((d): d is number => d !== null);
  if (placed.length === 0) return '这一页还没放菜；不要这一页请删掉';
  if (new Set(placed).size !== placed.length) return '同一道菜在这一页放了两次';
  return null;
}

function PagesTab({ data, apply }: { data: EmenuAdmin; apply: Apply }) {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<PagesDraft | null>(null);
  const [editing, setEditing] = useState<EmenuCategoryAdmin | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cat = data.categories.find((c) => c.id === selectedId) ?? data.categories[0] ?? null;
  const dirty = !!draft && !!cat && draft.id === cat.id && !samePages(draft.pages, cat.pages);
  // 换了分类、或门店系统里这个分类变了而这边没有没保存的改动：照门店系统的来
  if (cat && (!draft || draft.id !== cat.id || (draft.version !== cat.version && !dirty))) {
    setDraft({ id: cat.id, version: cat.version, pages: cat.pages });
    setError(null);
  }
  if (!cat && draft) setDraft(null);

  const pages = draft && cat && draft.id === cat.id ? draft.pages : [];
  const setPages = (next: EmenuPageAdmin[]) => draft && setDraft({ ...draft, pages: next });
  const patchPage = (i: number, patch: Partial<EmenuPageAdmin>) => setPages(pages.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const problems = pages.map(pageProblem);
  const stale = !!draft && !!cat && draft.id === cat.id && draft.version !== cat.version;

  const save = async () => {
    if (!cat || !draft) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<EmenuAdmin>(`/api/admin/emenu/categories/${cat.id}/pages`, { version: draft.version, pages });
      const saved = next.categories.find((c) => c.id === cat.id);
      apply(next);
      if (saved) setDraft({ id: saved.id, version: saved.version, pages: saved.pages });
      toast({ tone: 'success', title: `「${cat.name}」的版面已保存`, body: '平板上 15 秒内跟上。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
      <Card className="h-fit p-3" data-testid="emenu-admin-categories">
        <div className="flex items-center justify-between px-1 pb-2">
          <p className="text-[13px] font-bold text-ink-2">分类</p>
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setEditing('new')} data-testid="emenu-admin-category-new">
            新建
          </Button>
        </div>
        {data.categories.length === 0 && <p className="px-1 py-3 text-[13px] text-ink-3">还没有分类。先建一个（如「中式午餐」），再往里排页。</p>}
        <div className="flex flex-col gap-1">
          {data.categories.map((c) => {
            const on = c.id === cat?.id;
            return (
              <div key={c.id} className={cn('flex items-center gap-1 rounded-md border px-2.5 py-2', on ? 'border-pine bg-pine-tint' : 'border-transparent hover:bg-paper-2')}>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
                  disabled={dirty && !on}
                  title={dirty && !on ? '先保存或放弃现在这个分类的改动' : undefined}
                  onClick={() => setSelectedId(c.id)}
                  data-testid={`emenu-admin-category-${c.name}`}
                >
                  <span className="flex items-center gap-1.5 text-[14px] font-bold">
                    <span className="truncate">{c.name}</span>
                    {!c.active && <Badge tone="clay">停用</Badge>}
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {formatWindow(c.window)} · {c.pages.length} 页{c.nameEn ? ` · ${c.nameEn}` : ''}
                  </span>
                </button>
                <button type="button" className="rounded p-1.5 text-ink-3 hover:bg-card hover:text-ink" aria-label={`修改分类 ${c.name}`} onClick={() => setEditing(c)} data-testid={`emenu-admin-category-edit-${c.name}`}>
                  <Pencil className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <p className="mt-3 px-1 text-[12px] leading-relaxed text-ink-3">平板顶栏按「排序」从小到大排分类；不在供应时段的分类照「设置」里选的处理。</p>
      </Card>

      <div className="min-w-0 space-y-4">
        {!cat ? (
          <Card className="p-8 text-center text-[14px] text-ink-3">左边新建一个分类，就可以开始排页了。</Card>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[16px] font-bold">
                  {cat.name}
                  <span className="ml-2 text-[13px] font-semibold text-ink-3">
                    {pages.length} 页 · 供应时段 {formatWindow(cat.window)}
                  </span>
                </p>
                <p className="text-[12.5px] text-ink-3">客人在平板上从第 1 页往后翻；一页放不满的位置空着。</p>
              </div>
              {dirty && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDraft({ id: cat.id, version: cat.version, pages: cat.pages });
                    setError(null);
                  }}
                  data-testid="emenu-admin-pages-reset"
                >
                  放弃改动
                </Button>
              )}
              <Button variant="primary" loading={busy} disabled={!dirty || problems.some(Boolean)} onClick={save} data-testid="emenu-admin-pages-save">
                保存版面
              </Button>
            </div>
            {stale && dirty && (
              <Notice tone="warning" title="这个分类刚被别人改过">
                你这边还有没保存的改动：保存会被拒绝。请记下改动，点「放弃改动」载入最新的再排。
              </Notice>
            )}
            {error && <Notice tone="error" title={error} data-testid="emenu-admin-pages-error" />}
            {pages.length === 0 && <Card className="p-8 text-center text-[14px] text-ink-3">这个分类还没有页。点下面的「加一页」。</Card>}
            {pages.map((p, i) => (
              <PageCard
                key={i}
                index={i}
                count={pages.length}
                page={p}
                category={cat}
                data={data}
                problem={problems[i] ?? null}
                onChange={(patch) => patchPage(i, patch)}
                onMove={(d) => {
                  const next = [...pages];
                  const [x] = next.splice(i, 1);
                  next.splice(i + d, 0, x!);
                  setPages(next);
                }}
                onRemove={() => setPages(pages.filter((_, k) => k !== i))}
              />
            ))}
            <Button
              variant="secondary"
              icon={<Plus className="size-4" />}
              disabled={pages.length >= EMENU_MAX_PAGES}
              onClick={() => setPages([...pages, { layout: pages.length === 0 ? 'cover' : 'duo_row', title: '', titleEn: '', dishIds: [] }])}
              data-testid="emenu-admin-page-add"
            >
              加一页
            </Button>
          </>
        )}
      </div>

      <CategoryDialog
        target={editing}
        data={data}
        onClose={() => setEditing(null)}
        onSaved={(next, id) => {
          const saved = next.categories.find((c) => c.id === id);
          const before = data.categories.find((c) => c.id === id);
          // 自己刚改了这个分类的名称、时段：版本号跟着变，手上没保存的版面接着用新的版本号。
          // 手上的版面本来就是照旧版本排的（别人改过、还没载入最新的）：不跟，保存时照旧被拒，免得盖掉别人排的页
          if (saved && draft && draft.id === id && before && draft.version === before.version) setDraft({ ...draft, version: saved.version });
          apply(next);
          if (saved && !dirty) setSelectedId(saved.id);
        }}
      />
    </div>
  );
}

function PageCard({
  index,
  count,
  page,
  category,
  data,
  problem,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  page: EmenuPageAdmin;
  category: EmenuCategoryAdmin;
  data: EmenuAdmin;
  problem: string | null;
  onChange: (patch: Partial<EmenuPageAdmin>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const info = EMENU_LAYOUT_INFO[page.layout];
  const slots = Array.from({ length: info.slots }, (_, i) => page.dishIds[i] ?? null);
  const setSlot = (i: number, dishId: number | null) => {
    const next = [...slots];
    next[i] = dishId;
    while (next.length && next.at(-1) === null) next.pop();
    onChange({ dishIds: next });
  };
  const usable = data.dishes.filter((d) => d.active);
  const dishOf = new Map(data.dishes.map((d) => [d.id, d]));
  return (
    <Card className="p-4" data-testid={`emenu-admin-page-${index}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-bold">第 {index + 1} 页</p>
        <Select
          fullWidth={false}
          className="w-[190px]"
          aria-label={`第 ${index + 1} 页的版面`}
          value={page.layout}
          onChange={(e) => {
            const layout = e.target.value as EmenuLayout;
            const n = EMENU_LAYOUT_INFO[layout].slots;
            const kept = page.dishIds.slice(0, n);
            while (kept.length && kept.at(-1) === null) kept.pop();
            onChange({ layout, dishIds: kept, ...(EMENU_LAYOUT_INFO[layout].titled ? {} : { title: '', titleEn: '' }) });
          }}
          data-testid={`emenu-admin-page-layout-${index}`}
        >
          {EMENU_LAYOUTS.map((l) => (
            <option key={l} value={l}>
              {EMENU_LAYOUT_INFO[l].label}（{EMENU_LAYOUT_INFO[l].slots} 道）
            </option>
          ))}
        </Select>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">{info.hint}</span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" icon={<ArrowUp className="size-3.5" />} disabled={index === 0} onClick={() => onMove(-1)} aria-label={`第 ${index + 1} 页往前挪`} />
          <Button size="sm" variant="ghost" icon={<ArrowDown className="size-3.5" />} disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`第 ${index + 1} 页往后挪`} />
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={onRemove} aria-label={`删掉第 ${index + 1} 页`} data-testid={`emenu-admin-page-remove-${index}`} />
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <PagePreview page={page} category={category} data={data} scale={0.4} />
        <div className="min-w-[240px] flex-1 space-y-2.5">
          {info.titled && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="竖排小标题" hint="最多 8 个字，如「精品推荐」">
                <Input value={page.title} maxLength={8} onChange={(e) => onChange({ title: e.target.value })} data-testid={`emenu-admin-page-title-${index}`} />
              </Field>
              <Field label="小标题的英文" hint="如 BEST SELLERS">
                <Input value={page.titleEn} maxLength={24} onChange={(e) => onChange({ titleEn: e.target.value })} />
              </Field>
            </div>
          )}
          {slots.map((dishId, i) => {
            const picked = dishId !== null ? dishOf.get(dishId) : undefined;
            return (
              <div key={i} className="flex items-center gap-2">
                <span className="w-[52px] shrink-0 text-[12.5px] font-semibold text-ink-3">位置 {i + 1}</span>
                <Select
                  aria-label={`第 ${index + 1} 页位置 ${i + 1}`}
                  value={dishId ?? ''}
                  onChange={(e) => setSlot(i, Number(e.target.value) || null)}
                  data-testid={`emenu-admin-slot-${index}-${i}`}
                >
                  <option value="">（空着）</option>
                  {picked && !picked.active && <option value={picked.id}>{picked.name}（已停用）</option>}
                  {usable.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.specs.length ? ` · ${d.specs.map((s) => formatYuan(s.price)).join(' / ')}` : ''}
                      {d.specs.some((s) => s.orderable) ? '' : '（现在点不了）'}
                    </option>
                  ))}
                </Select>
              </div>
            );
          })}
          {problem && (
            <p className="text-[12.5px] font-semibold text-clay" data-testid={`emenu-admin-page-problem-${index}`}>
              {problem}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function CategoryDialog({ target, data, onClose, onSaved }: { target: EmenuCategoryAdmin | 'new' | null; data: EmenuAdmin; onClose: () => void; onSaved: (next: EmenuAdmin, id: number) => void }) {
  const toast = useToast();
  const existing = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState('11:00');
  const [end, setEnd] = useState('14:00');
  const [sortOrder, setSortOrder] = useState('0');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<typeof target>(null);
  if (target !== last) {
    setLast(target);
    setName(existing?.name ?? '');
    setNameEn(existing?.nameEn ?? '');
    setAllDay(!existing?.window);
    setStart(existing?.window ? formatMinute(existing.window.start) : '11:00');
    setEnd(existing?.window ? formatMinute(existing.window.end) : '14:00');
    setSortOrder(String(existing?.sortOrder ?? (data.categories.reduce((m, c) => Math.max(m, c.sortOrder), 0) + 10)));
    setActive(existing?.active ?? true);
    setError(null);
  }

  const save = async () => {
    const s = parseMinute(start);
    const e = parseMinute(end);
    if (!allDay && (s === null || e === null)) return setError('供应时段请按 11:00 这样填');
    if (!allDay && s === e) return setError('供应时段的开始与结束不能相同');
    const order = Number(sortOrder);
    if (!Number.isInteger(order)) return setError('排序请填整数（小的排在前面）');
    setBusy(true);
    setError(null);
    try {
      const body = { name, nameEn, window: allDay ? null : { start: s!, end: e! }, sortOrder: order, active };
      const next = existing ? await api.put<EmenuAdmin>(`/api/admin/emenu/categories/${existing.id}`, { ...body, version: existing.version }) : await api.post<EmenuAdmin>('/api/admin/emenu/categories', body);
      const id = existing?.id ?? next.categories.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase())?.id ?? 0;
      onSaved(next, id);
      toast({ tone: 'success', title: existing ? '分类已保存' : `已新建分类「${name.trim()}」` });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={existing ? '修改分类' : '新建分类'}
      description="分类显示在平板的顶栏；封面页用分类的名称做大标题。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={save} data-testid="emenu-admin-category-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称" htmlFor="ec-name" hint="最多 16 个字">
            <Input id="ec-name" value={name} maxLength={16} onChange={(e) => setName(e.target.value)} data-autofocus />
          </Field>
          <Field label="英文名" htmlFor="ec-en" hint="如 CHINESE LUNCH">
            <Input id="ec-en" value={nameEn} maxLength={32} onChange={(e) => setNameEn(e.target.value)} />
          </Field>
        </div>
        <Field label="供应时段" hint={allDay ? '全天都能点。' : '只在这段时间能点；结束早于开始算跨零点（如 21:00–02:00）。'}>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              ariaLabel="供应时段"
              value={allDay ? 'all' : 'window'}
              onChange={(v) => setAllDay(v === 'all')}
              options={[
                { value: 'all', label: '全天' },
                { value: 'window', label: '指定时段' },
              ]}
            />
            {!allDay && (
              <span className="flex items-center gap-1.5">
                <Input type="time" fullWidth={false} className="w-[118px]" aria-label="开始时间" value={start} onChange={(e) => setStart(e.target.value)} />
                <span className="text-ink-3">–</span>
                <Input type="time" fullWidth={false} className="w-[118px]" aria-label="结束时间" value={end} onChange={(e) => setEnd(e.target.value)} />
              </span>
            )}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="排序" htmlFor="ec-sort" hint="小的排在前面">
            <Input id="ec-sort" inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </Field>
          {existing && (
            <Field label="状态" hint="停用后平板上不显示，排好的页留着">
              <Segmented
                ariaLabel="分类状态"
                value={active ? 'on' : 'off'}
                onChange={(v) => setActive(v === 'on')}
                className="w-full"
                options={[
                  { value: 'on', label: '启用' },
                  { value: 'off', label: '停用' },
                ]}
              />
            </Field>
          )}
        </div>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 图片 ─────────────────────────

/** 一张图：缩略图 + 换一张 / 去掉；上传前在浏览器里压缩（最长边 1600、不超过 1 MB） */
function ImageSlot({ label, hint, imageId, onChange, testId }: { label: string; hint: string; imageId: number | null; onChange: (id: number | null) => void; testId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const img = await api.post<{ id: number }>('/api/admin/emenu/images', await imagePayload(file), { timeoutMs: 30_000 });
      onChange(img.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const url = emenuImageUrl(imageId);
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-[84px] w-[112px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-paper-2 text-[12px] text-ink-4">
        {url ? <img src={url} alt="" className="size-full object-cover" data-testid={`${testId}-img`} /> : '没有图片'}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink-2">{label}</p>
        <p className="text-[12px] text-ink-3">{hint}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" loading={busy} icon={<ImagePlus className="size-3.5" />} onClick={() => input.current?.click()}>
            {url ? '换一张' : '上传'}
          </Button>
          {url && (
            <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => onChange(null)}>
              去掉
            </Button>
          )}
        </div>
        {error && <p className="mt-1 text-[12.5px] font-medium text-clay">{error}</p>}
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} data-testid={testId} />
      </div>
    </div>
  );
}

// ───────────────────────── 菜品图文 ─────────────────────────

type DishFilter = 'all' | 'unplaced' | 'off';

function DishesTab({ data, apply }: { data: EmenuAdmin; apply: Apply }) {
  const toast = useToast();
  const [editing, setEditing] = useState<EmenuDishAdmin | 'new' | null>(null);
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState<DishFilter>('all');
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const free = data.items.filter((i) => i.dishId === null);
  const k = keyword.trim().toLowerCase();
  const list = data.dishes.filter((d) => {
    if (filter === 'unplaced' && (d.usedIn.length > 0 || !d.active)) return false;
    if (filter === 'off' && d.active && d.specs.some((s) => s.orderable)) return false;
    return !k || d.name.toLowerCase().includes(k) || d.nameEn.toLowerCase().includes(k);
  });

  const generate = async () => {
    setBusy(true);
    try {
      const next = await api.post<EmenuAdmin & { draft: { dishes: number; categories: number; pages: number } }>('/api/admin/emenu/draft');
      apply(next);
      setDrafting(false);
      toast(
        next.draft.dishes
          ? { tone: 'success', title: `生成了 ${next.draft.dishes} 道菜`, body: `新建 ${next.draft.categories} 个分类、${next.draft.pages} 页「文字陈列」。接着补图片、英文名与介绍，再换成带图的版面。` }
          : { tone: 'info', title: '价目表里挂了出品档口的菜都已经在电子菜单里了' },
      );
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
          <Input fullWidth={false} className="h-10 w-[220px] pl-9" placeholder="搜菜名、英文名" value={keyword} onChange={(e) => setKeyword(e.target.value)} aria-label="搜索菜品" />
        </span>
        <Segmented
          ariaLabel="筛选菜品"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'unplaced', label: '还没排进菜单' },
            { value: 'off', label: '停用或点不了' },
          ]}
        />
        <span className="flex-1" />
        <Button variant="secondary" icon={<Wand2 className="size-4" />} onClick={() => setDrafting(true)} data-testid="emenu-admin-draft">
          从价目表生成初稿
        </Button>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="emenu-admin-dish-new">
          添加菜品
        </Button>
      </div>
      <p className="text-[12.5px] text-ink-3">
        菜品的价格、能不能点都跟着价目表与厨房：价目项目要挂了出品档口（后台「餐饮」）才进得了电子菜单。还有 {free.length} 个挂了档口的价目项目没放进任何菜品。
      </p>
      <Card className="divide-y divide-line/70" data-testid="emenu-admin-dishes">
        {list.length === 0 && <p className="px-4 py-8 text-center text-[14px] text-ink-3">{data.dishes.length === 0 ? '还没有菜品。点「添加菜品」，或「从价目表生成初稿」。' : '没有符合的菜品。'}</p>}
        {list.map((d) => {
          const url = emenuImageUrl(d.imageId);
          const orderable = d.specs.some((s) => s.orderable);
          return (
            <button key={d.id} type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-paper-2/60" onClick={() => setEditing(d)} data-testid={`emenu-admin-dish-${d.name}`}>
              <span className="flex h-[54px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-paper-2 text-[11px] text-ink-4">
                {url ? <img src={url} alt="" loading="lazy" className="size-full object-cover" /> : '无图'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-[14.5px] font-bold">
                  {d.name}
                  {d.tagline && <span className="text-[12.5px] font-semibold text-ink-3">{d.tagline}</span>}
                  {!d.active && <Badge tone="clay">已停用</Badge>}
                  {d.active && !orderable && <Badge tone="ember">现在点不了</Badge>}
                  {d.active && d.usedIn.length === 0 && <Badge tone="yuzu">还没排进菜单</Badge>}
                </span>
                <span className="block truncate text-[12.5px] text-ink-3">
                  {d.nameEn || '（没有英文名）'}
                  {d.usedIn.length > 0 && ` · 在：${d.usedIn.join('、')}`}
                </span>
              </span>
              <span className="num shrink-0 text-right text-[13.5px] font-semibold text-ink-2">
                {d.specs.map((s) => (
                  <span key={s.itemId} className={cn('block', !s.orderable && 'text-ink-4 line-through')}>
                    {s.label ? `${s.label} ` : ''}
                    {formatYuan(s.price)}
                    <span className="text-[12px] font-normal text-ink-3">/{d.unit}</span>
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </Card>

      <DishDialog target={editing} data={data} onClose={() => setEditing(null)} apply={apply} />

      <Dialog
        open={drafting}
        onClose={() => setDrafting(false)}
        title="从价目表生成初稿"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDrafting(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} onClick={generate} data-testid="emenu-admin-draft-go">
              生成
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-[14px] text-ink-2">
          <p>
            把价目表里挂了出品档口、还没放进电子菜单的 <b className="num">{free.length}</b> 个项目各建成一道菜，按价目表的类别放进同名的分类，用「文字陈列」的版面每页 10 道排在后面。
          </p>
          <p>已经排好的页与菜品不动；生成后再补图片、英文名与介绍，换成带图的版面。可以重复点，只补新的。</p>
        </div>
      </Dialog>
    </div>
  );
}

interface SpecDraft {
  itemId: number | null;
  label: string;
}

function DishDialog({ target, data, onClose, apply }: { target: EmenuDishAdmin | 'new' | null; data: EmenuAdmin; onClose: () => void; apply: Apply }) {
  const toast = useToast();
  const existing = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [attrs, setAttrs] = useState('');
  const [unit, setUnit] = useState('份');
  const [imageId, setImageId] = useState<number | null>(null);
  const [detailImageId, setDetailImageId] = useState<number | null>(null);
  const [specs, setSpecs] = useState<SpecDraft[]>([{ itemId: null, label: '' }]);
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<typeof target>(null);
  if (target !== last) {
    setLast(target);
    setName(existing?.name ?? '');
    setNameEn(existing?.nameEn ?? '');
    setTagline(existing?.tagline ?? '');
    setDescription(existing?.description ?? '');
    setAttrs(existing?.attrs.join('\n') ?? '');
    setUnit(existing?.unit ?? '份');
    setImageId(existing?.imageId ?? null);
    setDetailImageId(existing?.detailImageId ?? null);
    setSpecs(existing?.specs.length ? existing.specs.map((s) => ({ itemId: s.itemId, label: s.label })) : [{ itemId: null, label: '' }]);
    setActive(existing?.active ?? true);
    setError(null);
  }

  // 能选的价目项目：还没放进别的菜品的，加上这道菜自己的
  const options = data.items.filter((i) => i.dishId === null || i.dishId === existing?.id);
  const gone = (existing?.specs ?? []).filter((s) => !options.some((o) => o.id === s.itemId));
  const setSpec = (i: number, patch: Partial<SpecDraft>) => setSpecs(specs.map((s, k) => (k === i ? { ...s, ...patch } : s)));

  const save = async () => {
    const picked = specs.filter((s) => s.itemId !== null);
    if (picked.length === 0) return setError('请至少选一个价目项目（价格、能不能点都跟着它）');
    const lines = attrs
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 3) return setError('属性行最多 3 行');
    setBusy(true);
    setError(null);
    try {
      const body = { name, nameEn, tagline, description, attrs: lines, unit, imageId, detailImageId, specs: picked.map((s) => ({ itemId: s.itemId, label: s.label })) };
      const next = existing ? await api.put<EmenuAdmin>(`/api/admin/emenu/dishes/${existing.id}`, { ...body, active, version: existing.version }) : await api.post<EmenuAdmin>('/api/admin/emenu/dishes', body);
      apply(next);
      toast({ tone: 'success', title: existing ? '菜品已保存' : `已添加「${name.trim()}」`, body: existing ? '平板上 15 秒内跟上。' : '到「分类与版面」里把它排进某一页。' });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      width="max-w-3xl"
      title={existing ? '修改菜品' : '添加菜品'}
      description={existing?.usedIn.length ? `排在：${existing.usedIn.join('、')}` : '平板上展示用的名称、图片与介绍；价格读价目表。'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={save} data-testid="emenu-admin-dish-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="菜名" htmlFor="ed-name" hint="最多 32 个字">
            <Input id="ed-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} data-autofocus />
          </Field>
          <Field label="英文名" htmlFor="ed-en">
            <Input id="ed-en" value={nameEn} maxLength={80} onChange={(e) => setNameEn(e.target.value)} />
          </Field>
          <Field label="名称后的小字" htmlFor="ed-tag" hint="如「2只」「煎档」；可不填">
            <Input id="ed-tag" value={tagline} maxLength={40} onChange={(e) => setTagline(e.target.value)} />
          </Field>
          <Field label="单位" htmlFor="ed-unit" hint="价格后面的「/份」">
            <Input id="ed-unit" value={unit} maxLength={4} onChange={(e) => setUnit(e.target.value)} />
          </Field>
        </div>
        <Field label="介绍" htmlFor="ed-desc" hint={`菜品详情与单菜版面上显示；最多 200 个字（现在 ${description.length}）`}>
          <Textarea id="ed-desc" value={description} maxLength={200} rows={3} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="属性行" htmlFor="ed-attrs" hint="「文字陈列」版面上英文名下面的小字，如「产地：法国」；一行一条，最多 3 行，每行 24 个字">
          <Textarea id="ed-attrs" value={attrs} rows={2} className="min-h-14" onChange={(e) => setAttrs(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <ImageSlot label="餐品展示图" hint="各版面的大图、菜品详情的主图" imageId={imageId} onChange={setImageId} testId="emenu-admin-dish-image" />
          <ImageSlot label="特写图" hint="封面页、「单菜」版面的小图；没传的用展示图" imageId={detailImageId} onChange={setDetailImageId} testId="emenu-admin-dish-detail" />
        </div>
        <Field label="规格与价目项目" hint="只有一个规格时规格名不用写；有大份、小份时各选一个价目项目、写上规格名。一个价目项目只能放进一道菜。">
          <div className="space-y-2">
            {specs.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select aria-label={`规格 ${i + 1} 的价目项目`} value={s.itemId ?? ''} onChange={(e) => setSpec(i, { itemId: Number(e.target.value) || null })} data-testid={`emenu-admin-spec-item-${i}`}>
                  <option value="">请选择价目项目</option>
                  {gone
                    .filter((g) => g.itemId === s.itemId)
                    .map((g) => (
                      <option key={g.itemId} value={g.itemId}>
                        {g.itemName} · {formatYuan(g.price)}（现在点不了：价目项目停用或没挂出品档口）
                      </option>
                    ))}
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} · {formatYuan(o.price)} · {o.category || '未分类'} · {o.stationName}
                    </option>
                  ))}
                </Select>
                <Input fullWidth={false} className="h-10 w-[110px]" placeholder="规格名" aria-label={`规格 ${i + 1} 的名称`} value={s.label} maxLength={8} onChange={(e) => setSpec(i, { label: e.target.value })} data-testid={`emenu-admin-spec-label-${i}`} />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={specs.length === 1} onClick={() => setSpecs(specs.filter((_, k) => k !== i))} aria-label={`去掉规格 ${i + 1}`} />
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={specs.length >= 6} onClick={() => setSpecs([...specs, { itemId: null, label: '' }])} data-testid="emenu-admin-spec-add">
              加一个规格
            </Button>
          </div>
        </Field>
        {existing && (
          <Field label="状态" hint="停用后平板上这道菜标「已下架」、点不了；排好的位置留着">
            <Segmented
              ariaLabel="菜品状态"
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              options={[
                { value: 'on', label: '上架' },
                { value: 'off', label: '停用' },
              ]}
            />
          </Field>
        )}
        {error && <Notice tone="error" title={error} data-testid="emenu-admin-dish-error" />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 设置 ─────────────────────────

/** 选项（忌口、起菜方式）：一个个小块，能删、能加 */
function OptionList({ label, value, max, onChange, testId }: { label: string; value: string[]; max: number; onChange: (next: string[]) => void; testId: string }) {
  const [text, setText] = useState('');
  const t = text.trim();
  const canAdd = t.length > 0 && t.length <= EMENU_MAX_OPTION_LENGTH && !value.includes(t) && value.length < max;
  const add = () => {
    if (!canAdd) return;
    onChange([...value, t]);
    setText('');
  };
  return (
    <div className="w-full max-w-[520px]" data-testid={testId}>
      <div className="flex flex-wrap gap-1.5">
        {value.map((o) => (
          <span key={o} className="inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-card pr-1 pl-3 text-[13px] font-semibold">
            {o}
            <button type="button" className="rounded-full p-1 text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label={`去掉${label}「${o}」`} onClick={() => onChange(value.filter((x) => x !== o))}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        {value.length === 0 && <span className="text-[13px] text-ink-3">没有选项（平板上不显示这一栏）</span>}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Input
          fullWidth={false}
          className="h-9 w-[160px]"
          placeholder={`加一个（最多 ${EMENU_MAX_OPTION_LENGTH} 个字）`}
          aria-label={`加一个${label}选项`}
          value={text}
          maxLength={EMENU_MAX_OPTION_LENGTH}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" variant="secondary" disabled={!canAdd} onClick={add}>
          加上
        </Button>
        <span className="text-[12px] text-ink-3">
          {value.length} / {max}
        </span>
      </div>
    </div>
  );
}

function SettingsTab({ data, apply }: { data: EmenuAdmin; apply: Apply }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<EmenuRules | null>(null);
  const [rev, setRev] = useState('');
  const [idleText, setIdleText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const same = (a: EmenuRules, b: EmenuRules) => JSON.stringify(a) === JSON.stringify(b);
  const dirtyNow = !!draft && !same(draft, data.rules);
  // 门店系统里的设置变了、这边没有没保存的改动：照门店系统的来
  if (!draft || (rev !== data.rulesRev && !dirtyNow)) {
    setDraft(data.rules);
    setRev(data.rulesRev);
    setIdleText(null);
  }
  if (!draft) return <Skeleton className="h-64" />;
  const set = (patch: Partial<EmenuRules>) => setDraft({ ...draft, ...patch });
  const idle = idleText === null ? draft.idleMinutes : idleText.trim() === '' ? NaN : Number(idleText);
  const idleOk = Number.isInteger(idle) && idle >= 0 && idle <= EMENU_MAX_IDLE_MINUTES;
  const worst = emenuNoteWorstCase(draft.avoidOptions, draft.serveOptions);
  const noteOk = worst <= EMENU_MAX_NOTE;
  const next: EmenuRules = { ...draft, idleMinutes: idleOk ? idle : draft.idleMinutes };
  const dirty = !same(next, data.rules);
  const stale = rev !== data.rulesRev;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // 只交改过的项：别人同时改了别的项不会被盖掉（门店系统在规则锁里合并，版本对不上拒绝）
      const patch: Partial<EmenuRules> = {};
      for (const k of Object.keys(next) as (keyof EmenuRules)[]) {
        if (JSON.stringify(next[k]) !== JSON.stringify(data.rules[k])) Object.assign(patch, { [k]: next[k] });
      }
      const saved = await api.put<EmenuAdmin>('/api/admin/emenu/rules', { rev, ...patch });
      apply(saved);
      setDraft(saved.rules);
      setRev(saved.rulesRev);
      setIdleText(null);
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: '电子菜单的设置已保存', body: saved.rules.enabled ? '平板点餐开着：点餐平板账号登录后直接进点餐页。' : '平板点餐已关闭，点餐页提示没有开启。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, hint: ReactNode, control: ReactNode, pending = false, top = false) => (
    <div className={cn('flex flex-wrap gap-x-4 gap-y-2 py-3.5', top ? 'items-start' : 'items-center')}>
      <div className="min-w-[220px] flex-1">
        <p className="flex items-center gap-2 text-[14px] font-bold">
          {label}
          {pending && <PendingBadge title="先按常见做法定的默认，待店主确认（PENDING_DECISIONS.md「8.0.10」）" />}
        </p>
        <p className="text-[12.5px] leading-relaxed text-ink-3">{hint}</p>
      </div>
      {control}
    </div>
  );

  return (
    <Card className="p-5" data-testid="emenu-admin-settings">
      <SectionTitle aside={data.rulesUpdatedAt ? <span className="text-[12px] text-ink-3">上次保存：{data.rulesUpdatedBy ?? '—'} · {formatDateTime(data.rulesUpdatedAt)}</span> : <Badge>都是默认值</Badge>}>平板点餐的设置</SectionTitle>
      <div className="mt-1 divide-y divide-line/70">
        {row(
          '平板点餐',
          <>
            开启后「点餐平板」账号登录直接进点餐页，客人翻菜单、加菜，服务员输点单密码确认，菜挂到手牌、进厨房屏。关闭时点餐页提示没有开启，其余与升级前一样。
            {!data.diningEnabled && <b className="text-clay"> 餐饮功能还没开（后台「餐饮」），开了这里也用不了。</b>}
          </>,
          <Segmented
            ariaLabel="平板点餐"
            value={draft.enabled ? 'on' : 'off'}
            onChange={(v) => set({ enabled: v === 'on' })}
            options={[
              { value: 'off', label: '关闭' },
              { value: 'on', label: '开启' },
            ]}
          />,
        )}
        {row(
          '起始页的氛围大图',
          '平板待机时整屏的那张图（设计稿「起始页」）。没传时是浅灰底。建议横图、4:3。',
          <div className="w-full max-w-[420px]">
            <ImageSlot label="氛围大图" hint="上传前自动压缩到最长边 1600 像素" imageId={draft.coverImageId} onChange={(id) => set({ coverImageId: id })} testId="emenu-admin-cover" />
          </div>,
          false,
          true,
        )}
        {row(
          '起始页底部的版权行',
          `最多 ${EMENU_MAX_FOOTER} 个字；留空不显示。`,
          <Input fullWidth={false} className="w-full max-w-[420px]" aria-label="版权行" value={draft.footerText} maxLength={EMENU_MAX_FOOTER} onChange={(e) => set({ footerText: e.target.value })} />,
        )}
        {row('忌口（多选）', '客人下单前在「备注」里勾选，写在这一单每道菜的口味备注上，厨房屏看得到。', <OptionList label="忌口" value={draft.avoidOptions} max={EMENU_MAX_AVOID_OPTIONS} onChange={(v) => set({ avoidOptions: v })} testId="emenu-admin-avoid" />, true, true)}
        {row('起菜方式（单选）', '如「即起」「慢起」；可以不选。', <OptionList label="起菜方式" value={draft.serveOptions} max={EMENU_MAX_SERVE_OPTIONS} onChange={(v) => set({ serveOptions: v })} testId="emenu-admin-serve" />, true, true)}
        {row(
          '多久没人动回到起始页',
          '客人走了没下单的菜会自动清掉，下一桌客人从起始页重新开始；填 0 为不自动回。',
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Input
              fullWidth={false}
              className="w-[90px]"
              type="number"
              inputMode="numeric"
              min={0}
              max={EMENU_MAX_IDLE_MINUTES}
              aria-label="多少分钟没人动回到起始页"
              value={idleText ?? String(draft.idleMinutes)}
              invalid={!idleOk}
              onChange={(e) => setIdleText(e.target.value)}
              data-testid="emenu-admin-idle"
            />
            <span className="text-[13px] text-ink-2">分钟（默认 {DEFAULT_EMENU_RULES.idleMinutes}）</span>
          </span>,
          true,
        )}
        {row(
          '不在供应时段的分类',
          '「不显示」：过了时段的分类平板上看不到；「显示但不能点」：看得到，菜上标「当前时段不可售」。',
          <Segmented
            ariaLabel="不在供应时段的分类"
            value={draft.offHours}
            onChange={(v) => set({ offHours: v })}
            options={[
              { value: 'hide', label: '不显示' },
              { value: 'show', label: '显示但不能点' },
            ]}
          />,
          true,
        )}
      </div>
      {!idleOk && <Notice tone="error" className="mt-3" title={`分钟数请填 0–${EMENU_MAX_IDLE_MINUTES} 的整数`} />}
      {!noteOk && (
        <Notice tone="error" className="mt-3" title="忌口与起菜方式的选项加起来太长了">
          全选上再写满 30 个字的自定义备注要放进 {EMENU_MAX_NOTE} 个字里（现在最长 {worst} 个字）。请减少或缩短选项。
        </Notice>
      )}
      {stale && dirty && (
        <Notice tone="warning" className="mt-3" title="设置刚被别人改过">
          保存会被拒绝。请记下你的改动，点「放弃改动」载入最新的再改。
        </Notice>
      )}
      {error && <Notice tone="error" className="mt-3" title={error} data-testid="emenu-admin-settings-error" />}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {dirty && (
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(data.rules);
              setRev(data.rulesRev);
              setIdleText(null);
              setError(null);
            }}
          >
            放弃改动
          </Button>
        )}
        <Button variant="primary" loading={busy} disabled={!dirty || !idleOk || !noteOk} onClick={save} data-testid="emenu-admin-settings-save">
          保存设置
        </Button>
      </div>
    </Card>
  );
}
