// UI 工作台编辑器的左右两栏（8.1.1 起，docs/WORKBENCH_V811.md 第 1、2 节）：图层、插入、素材、主题（左），属性、检查（右）。
// 傻瓜：每一项都写中文、给默认值；颜色可以点主题色，也可以填 #RRGGBB；功能块的属性按界面登记自动出表单。
// 8.1.2：自动排列（横排、竖排、换行、间距、内边距、对齐）、尺寸规则（固定 / 撑满 / 跟内容）、按钮、数据字段、点了做什么。

import { useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  Circle,
  Columns3,
  Database,
  Eye,
  EyeOff,
  Frame,
  ImagePlus,
  Lock,
  LogOut,
  MousePointerClick,
  Rows3,
  Square,
  Trash2,
  Type,
  Unlock,
} from 'lucide-react';
import {
  componentUses,
  defaultStudioDoc,
  SHADOWS,
  themeColor,
  type StudioAction,
  type StudioAssetView,
  type StudioBlockDef,
  type StudioDoc,
  type StudioIssue,
  type StudioLayout,
  type StudioNode,
  type StudioPropDef,
  type StudioSurfaceDef,
} from '@shared/studio';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { Button } from '../../components/ui';
import { cn } from '../../lib/utils';
import {
  canAddNode,
  componentIdOf,
  findNode,
  geometryRules,
  makeBlock,
  makeButton,
  makeEllipse,
  makeField,
  makeFrame,
  makeInstance,
  makeRect,
  makeText,
  moveOutOfFrame,
  nodeLabel,
  renameComponent,
  round1,
  screenOf,
} from './model';

const SHADOW_LABELS: Record<(typeof SHADOWS)[number], string> = { none: '无', sm: '轻', md: '中', lg: '重' };

export function PanelTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[12.5px] font-bold text-ink-2">{children}</h3>
      {aside}
    </div>
  );
}

export function Row({ label, children, narrow }: { label: string; children: ReactNode; narrow?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-[12.5px]">
      <span className={cn('shrink-0 whitespace-nowrap text-ink-3', narrow ? 'w-7' : 'w-16')}>{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </label>
  );
}

const inputCls = 'h-8 w-full min-w-0 rounded-md border border-line bg-card px-2 text-[12.5px] text-ink outline-none focus:border-pine';

/** 数字：失焦或回车时生效；拖动以外的精确调整 */
export function NumberInput({ value, onChange, min, max, step = 1, testId }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; testId?: string }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const v = Number(text);
    if (Number.isFinite(v)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
    setText(null);
  };
  return (
    <input
      className={inputCls}
      inputMode="decimal"
      value={text ?? String(round1(value))}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const v = round1(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
          onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
        }
      }}
      data-testid={testId}
    />
  );
}

/** 颜色：主题色（点小方块）、自定义（色板 + #RRGGBB）、可选「无」与「自动」 */
export function ColorField({
  value,
  onChange,
  surface,
  doc,
  allowNone,
  allowAuto,
  testId,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  surface: StudioSurfaceDef;
  doc: StudioDoc;
  allowNone?: boolean;
  allowAuto?: boolean;
  testId?: string;
}) {
  const resolved = value === 'auto' || !value ? null : value.startsWith('$') ? themeColor(doc, value.slice(1)) : value;
  const [hex, setHex] = useState<string | null>(null);
  return (
    <div className="flex w-full flex-col gap-1.5" data-testid={testId}>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          className="h-8 w-9 shrink-0 cursor-pointer rounded border border-line bg-card p-0.5"
          value={(resolved ?? '#ffffff').slice(0, 7)}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          className={inputCls}
          value={hex ?? (value === 'auto' ? '自动' : value === null ? '无' : value.startsWith('$') ? `主题：${surface.colors.find((c) => c.key === value.slice(1))?.label ?? value}` : value)}
          onFocus={() => setHex(value && !value.startsWith('$') && value !== 'auto' ? value : '#')}
          onChange={(e) => setHex(e.target.value)}
          onBlur={() => {
            if (hex && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) onChange(hex);
            setHex(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {allowAuto && (
          <button type="button" className={cn('h-5 rounded border px-1 text-[10.5px]', value === 'auto' ? 'border-pine text-pine' : 'border-line text-ink-3')} onClick={() => onChange('auto')}>
            自动
          </button>
        )}
        {allowNone && (
          <button type="button" className={cn('h-5 rounded border px-1 text-[10.5px]', value === null ? 'border-pine text-pine' : 'border-line text-ink-3')} onClick={() => onChange(null)}>
            无
          </button>
        )}
        {surface.colors.map((c) => (
          <button
            key={c.key}
            type="button"
            title={`主题：${c.label}`}
            className={cn('size-5 rounded border', value === `$${c.key}` ? 'ring-2 ring-pine ring-offset-1' : 'border-line')}
            style={{ background: themeColor(doc, c.key) ?? c.default }}
            onClick={() => onChange(`$${c.key}`)}
          />
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── 图层 ─────────────────────────

export function LayersPanel({
  doc,
  screen,
  surface,
  selection,
  onSelect,
  onChange,
}: {
  doc: StudioDoc;
  screen: string;
  surface: StudioSurfaceDef;
  selection: string[];
  onSelect: (ids: string[]) => void;
  onChange: (fn: (d: StudioDoc) => StudioDoc, coalesce?: string) => void;
}) {
  const nodes = screenOf(doc, screen).nodes;
  const toggle = (id: string, key: 'hidden' | 'locked') =>
    onChange((d) => {
      const f = findNode(d, screen, id);
      if (!f) return d;
      if (key === 'hidden' && f.node.type === 'block' && surface.blocks[f.node.block]?.required && !f.node.hidden) return d;
      return updateFlag(d, screen, id, key);
    });
  const rows: ReactNode[] = [];
  const walk = (list: readonly StudioNode[], depth: number) => {
    // 图层列表上面的盖在下面的上面：倒着列
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i]!;
      const on = selection.includes(n.id);
      const required = n.type === 'block' && !!surface.blocks[n.block]?.required;
      rows.push(
        <div
          key={n.id}
          className={cn('group flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-[12.5px]', on ? 'bg-pine-tint text-pine' : 'hover:bg-paper-2')}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={(e) => onSelect(e.shiftKey ? (on ? selection.filter((x) => x !== n.id) : [...selection, n.id]) : [n.id])}
          data-testid={`studio-layer-${n.id}`}
        >
          <span className="w-4 shrink-0 text-center text-[10px] text-ink-3">
            {
              {
                text: 'T',
                image: '图',
                block: '块',
                frame: n.type === 'frame' && n.layout && n.layout.mode !== 'free' ? (n.layout.mode === 'row' ? '⇥' : '⇩') : '框',
                ellipse: '○',
                rect: '□',
                button: '钮',
                field: '数',
                instance: '◆',
              }[n.type]
            }
          </span>
          <span className={cn('min-w-0 flex-1 truncate', n.hidden && 'text-ink-4 line-through')}>{nodeLabel(n, surface, doc)}</span>
          {required && <span className="shrink-0 rounded bg-yuzu-soft px-1 text-[10px] text-yuzu-deep">必需</span>}
          <button
            type="button"
            title={n.hidden ? '显示' : required ? '必需的块不能隐藏' : '隐藏'}
            disabled={required && !n.hidden}
            className="shrink-0 rounded p-0.5 text-ink-3 opacity-70 hover:bg-paper-3 disabled:opacity-30"
            onClick={(e) => {
              e.stopPropagation();
              toggle(n.id, 'hidden');
            }}
          >
            {n.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            type="button"
            title={n.locked ? '解锁' : '锁住（画布上点不中、挪不动）'}
            className="shrink-0 rounded p-0.5 text-ink-3 opacity-70 hover:bg-paper-3"
            onClick={(e) => {
              e.stopPropagation();
              toggle(n.id, 'locked');
            }}
          >
            {n.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
          </button>
        </div>,
      );
      if (n.type === 'frame') walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return (
    <div data-testid="studio-layers">
      <PanelTitle>图层（上面的盖住下面的）</PanelTitle>
      <div className="space-y-0.5">{rows.length ? rows : <p className="text-[12px] text-ink-3">这一屏还没有东西：从「插入」加</p>}</div>
    </div>
  );
}

function updateFlag(d: StudioDoc, screen: string, id: string, key: 'hidden' | 'locked'): StudioDoc {
  const next = structuredClone(d);
  const f = findNode(next, screen, id);
  if (f) f.list[f.index] = { ...f.node, [key]: !f.node[key] } as StudioNode;
  return next;
}

// ───────────────────────── 插入 ─────────────────────────

/** 组件的几个操作（8.1.2）：存成组件、改组件（打开它那一屏）、拆开、改完回去、删掉没人用的 */
export interface ComponentOps {
  make: (id: string) => void;
  edit: (cid: string) => void;
  detach: (id: string) => void;
  finish: () => void;
  remove: (cid: string) => void;
}

export function InsertPanel({
  doc,
  screen,
  surface,
  onInsert,
  components,
}: {
  doc: StudioDoc;
  screen: string;
  surface: StudioSurfaceDef;
  onInsert: (node: StudioNode) => void;
  components?: ComponentOps;
}) {
  const cx = surface.size.w / 2;
  const cy = surface.size.h / 2;
  const nodes = screenOf(doc, screen).nodes;
  const full = !canAddNode(doc, screen);
  const t = surface.tokens;
  const phone = surface.kind === 'phone';
  const basics: { label: string; icon: ReactNode; make: () => StudioNode; key: string }[] = [
    { key: 'text', label: '文字', icon: <Type className="size-4" />, make: () => makeText(cx - 160, cy - 20, undefined, t, phone ? 16 : 24) },
    { key: 'rect', label: '矩形', icon: <Square className="size-4" />, make: () => makeRect(cx - 100, cy - 60, t) },
    { key: 'ellipse', label: '椭圆', icon: <Circle className="size-4" />, make: () => makeEllipse(cx - 60, cy - 60, t) },
    { key: 'frame', label: '框（卡片）', icon: <Frame className="size-4" />, make: () => makeFrame(cx - 160, cy - 100, t) },
    { key: 'column', label: '竖排框', icon: <Rows3 className="size-4" />, make: () => makeFrame(cx - 160, cy - 100, t, 'column') },
    { key: 'row', label: '横排框', icon: <Columns3 className="size-4" />, make: () => makeFrame(cx - 160, cy - 100, t, 'row') },
    { key: 'button', label: '按钮', icon: <MousePointerClick className="size-4" />, make: () => makeButton(cx - 80, cy - 22, t) },
  ];
  const defaults = defaultStudioDoc(surface.key);
  const blocks = Object.values(surface.blocks).filter((b) => b.screens.includes(screen));
  const has = (b: StudioBlockDef) => nodes.some((n) => n.type === 'block' && n.block === b.key);
  /** 功能块加回来：放在默认版面里的那个位置（没有就放中间） */
  const addBlock = (b: StudioBlockDef) => {
    const ref = Object.values(defaults.screens)
      .flatMap((s) => s.nodes)
      .find((n) => n.type === 'block' && n.block === b.key);
    const node = makeBlock(b, cx - b.size.w / 2, cy - b.size.h / 2, ref ? { x: ref.x, y: ref.y } : undefined);
    onInsert(ref && ref.type === 'block' ? ({ ...node, w: ref.w, h: ref.h, props: { ...ref.props } } as StudioNode) : node);
  };
  return (
    <div className="space-y-4" data-testid="studio-insert">
      <div>
        <PanelTitle>基本元素</PanelTitle>
        <div className="grid grid-cols-2 gap-1.5">
          {basics.map((b) => (
            <button
              key={b.key}
              type="button"
              disabled={full}
              className="flex h-14 flex-col items-center justify-center gap-1 rounded-md border border-line bg-card text-[12px] text-ink-2 hover:border-pine hover:text-pine disabled:opacity-40"
              onClick={() => onInsert(b.make())}
              data-testid={`studio-insert-${b.key}`}
            >
              {b.icon}
              {b.label}
            </button>
          ))}
        </div>
        {full && <p className="mt-1 text-[11.5px] text-clay">这一屏的图层到上限了，删掉一些再加</p>}
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">先选中一个框再点，就插在这个框里；框可以「竖排 / 横排」自动排好里面的东西。</p>
      </div>
      {surface.fields.length > 0 && (
        <div>
          <PanelTitle>数据（显示真实的门店、会员信息）</PanelTitle>
          <div className="space-y-1">
            {surface.fields.map((f) => (
              <button
                key={f.key}
                type="button"
                disabled={full}
                className="flex w-full items-center gap-2 rounded-md border border-line bg-card px-2.5 py-1.5 text-left text-[12.5px] hover:border-pine disabled:opacity-45"
                onClick={() => onInsert(makeField(cx - 120, cy - 12, f, t))}
                data-testid={`studio-insert-field-${f.key}`}
              >
                <Database className="size-3.5 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
                <span className="max-w-24 truncate text-[11px] text-ink-3">{f.sample.zh}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {components && (
        <div data-testid="studio-components">
          <PanelTitle>组件（自己存的，改一处各处跟着变）</PanelTitle>
          {Object.keys(doc.components ?? {}).length === 0 ? (
            <p className="text-[11.5px] leading-snug text-ink-3">还没有。选中画布上的一块（框连着里面的也行），在右边点「存成组件」（⌘/Ctrl+Alt+K）。</p>
          ) : (
            <div className="space-y-1">
              {Object.entries(doc.components ?? {}).map(([cid, c]) => {
                const uses = componentUses(doc, cid);
                // 改组件时不能往它自己里面放自己
                const self = componentIdOf(screen) === cid;
                return (
                  <div key={cid} className="flex items-center gap-1.5 rounded-md border border-line bg-card px-2 py-1.5 text-[12.5px]" data-testid={`studio-component-${cid}`}>
                    <span className="text-[11px] text-ink-3">◆</span>
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="shrink-0 text-[11px] text-ink-3">{uses} 处</span>
                    <button
                      type="button"
                      disabled={full || self}
                      className="shrink-0 rounded px-1.5 text-[12px] text-pine hover:bg-pine-tint disabled:opacity-40"
                      onClick={() => {
                        const n = makeInstance(doc, cid, cx - c.node.w / 2, cy - c.node.h / 2);
                        if (n) onInsert(n);
                      }}
                      data-testid={`studio-component-insert-${cid}`}
                    >
                      放一个
                    </button>
                    <button type="button" className="shrink-0 rounded px-1.5 text-[12px] text-ink-2 hover:bg-paper-2" onClick={() => components.edit(cid)} data-testid={`studio-component-edit-${cid}`}>
                      改
                    </button>
                    <button
                      type="button"
                      disabled={uses > 0}
                      title={uses > 0 ? `还有 ${uses} 处在用：先拆开或删掉那几处` : '删掉这个组件'}
                      className="shrink-0 rounded px-1 text-ink-3 hover:bg-paper-2 hover:text-clay disabled:opacity-30"
                      onClick={() => components.remove(cid)}
                      data-testid={`studio-component-remove-${cid}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div>
        <PanelTitle>功能块（带逻辑，只改位置与样子）</PanelTitle>
        <div className="space-y-1.5">
          {blocks.map((b) => {
            const disabled = full || (b.single && has(b));
            return (
              <button
                key={b.key}
                type="button"
                disabled={disabled}
                title={b.hint}
                className="w-full rounded-md border border-line bg-card px-2.5 py-2 text-left hover:border-pine disabled:opacity-45"
                onClick={() => addBlock(b)}
                data-testid={`studio-insert-block-${b.key}`}
              >
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                  {b.label}
                  {b.required && <span className="rounded bg-yuzu-soft px-1 text-[10px] text-yuzu-deep">必需</span>}
                  {b.single && has(b) && <span className="text-[10.5px] text-ink-3">已在这一屏</span>}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{b.hint}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── 素材 ─────────────────────────

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('读不了这个文件'));
    r.readAsDataURL(file);
  });

export function AssetsPanel({
  assets,
  loading,
  onUploaded,
  onUse,
  disabled,
}: {
  assets: StudioAssetView[];
  loading: boolean;
  onUploaded: () => void;
  onUse: (a: StudioAssetView) => void;
  disabled: boolean;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 5 * 1024 * 1024) {
          toast({ tone: 'error', title: `「${file.name}」大于 5 MB：压缩一下再传` });
          continue;
        }
        const a = await api.post<StudioAssetView>('/api/studio/assets', { name: file.name.slice(0, 80), data: await toBase64(file) });
        onUploaded();
        onUse(a);
      }
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div data-testid="studio-assets">
      <PanelTitle>素材库（PNG、JPG、WebP、SVG，单张最大 5 MB）</PanelTitle>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" multiple className="hidden" onChange={(e) => void upload(e.target.files)} data-testid="studio-asset-file" />
      <button
        type="button"
        disabled={busy || disabled}
        className="mb-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong text-[12.5px] text-ink-2 hover:border-pine hover:text-pine disabled:opacity-50"
        onClick={() => input.current?.click()}
      >
        <ImagePlus className="size-4" />
        {busy ? '正在上传…' : '传图片（传完直接放到画布上）'}
      </button>
      {loading ? (
        <p className="text-[12px] text-ink-3">正在取素材…</p>
      ) : assets.length === 0 ? (
        <p className="text-[12px] text-ink-3">还没有素材。Figma 里做好的图标、海报导出成 PNG 或 SVG 传进来。</p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {assets.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={disabled}
              title={`${a.name} · ${a.width ?? '?'}×${a.height ?? '?'} · ${Math.round(a.size / 1024)} KB`}
              className="aspect-square overflow-hidden rounded-md border border-line bg-paper-2 hover:border-pine disabled:opacity-50"
              onClick={() => onUse(a)}
            >
              <img src={`/api/studio/assets/${a.id}`} alt={a.name} className="size-full object-contain" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── 主题 ─────────────────────────

export function ThemePanel({ doc, surface, onChange }: { doc: StudioDoc; surface: StudioSurfaceDef; onChange: (fn: (d: StudioDoc) => StudioDoc, coalesce?: string) => void }) {
  const setColor = (key: string, v: string) => onChange((d) => ({ ...d, theme: { ...d.theme, colors: { ...d.theme.colors, [key]: v } } }), `theme.${key}`);
  return (
    <div className="space-y-4" data-testid="studio-theme">
      <div>
        <PanelTitle
          aside={
            <button type="button" className="text-[11.5px] text-pine hover:underline" onClick={() => onChange((d) => ({ ...d, theme: defaultStudioDoc(surface.key).theme }))}>
              恢复默认
            </button>
          }
        >
          主题色（改一处，用到它的地方一起变）
        </PanelTitle>
        <div className="space-y-1.5">
          {surface.colors.map((c) => {
            const v = themeColor(doc, c.key) ?? c.default;
            // 品牌规定的颜色（8.1.8，平板菜单的主文字）：只显示、不能改
            if (c.locked)
              return (
                <div key={c.key} className="flex items-center gap-2 text-[12.5px]" data-testid={`studio-theme-${c.key}`} data-locked="">
                  <span className="h-7 w-8 shrink-0 rounded border border-line p-0.5">
                    <span className="block size-full rounded-sm" style={{ background: v }} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">{c.label}</span>
                  <Lock className="size-3.5 shrink-0 text-ink-3" aria-label="不能改" />
                  <span className="font-mono text-[11px] text-ink-3">{v}</span>
                </div>
              );
            return (
              <label key={c.key} className="flex items-center gap-2 text-[12.5px]" data-testid={`studio-theme-${c.key}`}>
                <input type="color" className="h-7 w-8 shrink-0 cursor-pointer rounded border border-line bg-card p-0.5" value={v.slice(0, 7)} onChange={(e) => setColor(c.key, e.target.value)} />
                <span className="min-w-0 flex-1 truncate text-ink-2">{c.label}</span>
                <span className="font-mono text-[11px] text-ink-3">{v}</span>
              </label>
            );
          })}
        </div>
      </div>
      <div>
        <PanelTitle>字体</PanelTitle>
        <div className="space-y-2">
          {(['zh', 'en'] as const).map((k) => (
            <Row key={k} label={k === 'zh' ? '中文' : '英文、数字'}>
              <select
                className={inputCls}
                value={doc.theme.fonts[k]}
                onChange={(e) => onChange((d) => ({ ...d, theme: { ...d.theme, fonts: { ...d.theme.fonts, [k]: e.target.value } } }))}
                data-testid={`studio-font-${k}`}
              >
                {surface.fonts[k].map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Row>
          ))}
          <p className="text-[11.5px] leading-snug text-ink-3">只列有授权、平板上有的字体（品牌字体随应用打包；系统字体是平板自带的）。</p>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── 属性 ─────────────────────────

function BlockPropField({ def, value, onChange, surface, doc }: { def: StudioPropDef; value: unknown; onChange: (v: string | number | boolean) => void; surface: StudioSurfaceDef; doc: StudioDoc }) {
  switch (def.kind) {
    case 'color':
      return <ColorField value={typeof value === 'string' ? value : String(def.default)} onChange={(v) => onChange(v ?? String(def.default))} surface={surface} doc={doc} allowAuto={def.auto} />;
    case 'number':
      return (
        <div className="flex w-full items-center gap-2">
          <input
            type="range"
            className="min-w-0 flex-1 accent-[var(--color-pine)]"
            min={def.min}
            max={def.max}
            step={def.step}
            value={Number(value ?? def.default)}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <span className="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-ink-3">{Number(value ?? def.default)}</span>
        </div>
      );
    case 'boolean':
      return <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={Boolean(value ?? def.default)} onChange={(e) => onChange(e.target.checked)} />;
    case 'select':
      return (
        <select className={inputCls} value={String(value ?? def.default)} onChange={(e) => onChange(e.target.value)}>
          {def.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
  }
}

// ── 8.1.2 的几块：自动排列、尺寸规则、点了做什么、字的样子 ──

const seg = (on: boolean) => cn('h-7 flex-1 rounded border text-[12px]', on ? 'border-pine bg-pine-tint text-pine' : 'border-line text-ink-2');

const DEFAULT_LAYOUT: StudioLayout = { mode: 'column', wrap: false, gap: 8, padding: [12, 12, 12, 12], align: 'stretch', justify: 'start' };

/** 自动排列（框、手机的屏）：自由摆放 / 竖排 / 横排，换行，间距，内边距，对齐 */
function LayoutEditor({ value, onChange, allowFree = true, testId }: { value: StudioLayout | undefined; onChange: (v: StudioLayout | undefined) => void; allowFree?: boolean; testId?: string }) {
  const v = value ?? { ...DEFAULT_LAYOUT, mode: 'free' as const };
  const set = (patch: Partial<StudioLayout>) => onChange({ ...v, ...patch });
  const flow = v.mode !== 'free';
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <Row label="排列">
        {allowFree && (
          <button type="button" className={seg(!flow)} onClick={() => onChange(undefined)}>
            自由摆放
          </button>
        )}
        <button type="button" className={seg(v.mode === 'column')} onClick={() => set({ ...(flow ? {} : DEFAULT_LAYOUT), mode: 'column' })} data-testid={testId && `${testId}-column`}>
          竖排
        </button>
        <button
          type="button"
          className={seg(v.mode === 'row')}
          onClick={() => set({ ...(flow ? {} : DEFAULT_LAYOUT), mode: 'row', align: v.align === 'stretch' && !flow ? 'center' : v.align })}
          data-testid={testId && `${testId}-row`}
        >
          横排
        </button>
      </Row>
      {flow && (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <Row label="间距" narrow>
              <NumberInput value={v.gap} min={0} max={400} onChange={(x) => set({ gap: x })} testId={testId && `${testId}-gap`} />
            </Row>
            {v.mode === 'row' && (
              <label className="flex items-center gap-1 text-[12px]">
                <input type="checkbox" checked={v.wrap} onChange={(e) => set({ wrap: e.target.checked })} /> 放不下换行
              </label>
            )}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {(['上', '右', '下', '左'] as const).map((label, i) => (
              <label key={label} className="flex flex-col gap-0.5 text-[11px] text-ink-3">
                内边距 {label}
                <NumberInput
                  value={v.padding[i]!}
                  min={0}
                  max={400}
                  onChange={(x) => {
                    const p = [...v.padding] as StudioLayout['padding'];
                    p[i] = x;
                    set({ padding: p });
                  }}
                />
              </label>
            ))}
          </div>
          <Row label={v.mode === 'row' ? '上下对齐' : '左右对齐'}>
            {(['start', 'center', 'end', 'stretch'] as const).map((a) => (
              <button key={a} type="button" className={seg(v.align === a)} onClick={() => set({ align: a })}>
                {{ start: v.mode === 'row' ? '上' : '左', center: '中', end: v.mode === 'row' ? '下' : '右', stretch: '撑满' }[a]}
              </button>
            ))}
          </Row>
          <Row label={v.mode === 'row' ? '左右分布' : '上下分布'}>
            {(['start', 'center', 'end', 'between'] as const).map((a) => (
              <button key={a} type="button" className={seg(v.justify === a)} onClick={() => set({ justify: a })}>
                {{ start: v.mode === 'row' ? '靠左' : '靠上', center: '居中', end: v.mode === 'row' ? '靠右' : '靠下', between: '两头' }[a]}
              </button>
            ))}
          </Row>
        </>
      )}
    </div>
  );
}

/** 自动排列里一块的宽、高：固定 / 撑满 / 跟内容 */
function SizingRows({ node, onChange }: { node: StudioNode; onChange: (patch: Partial<StudioNode>) => void }) {
  const sz = node.sizing ?? { w: 'fixed' as const, h: 'fixed' as const };
  const pick = (axis: 'w' | 'h', mode: 'fixed' | 'fill' | 'hug') => onChange({ sizing: { ...sz, [axis]: mode } });
  return (
    <>
      {(['w', 'h'] as const).map((axis) => (
        <div key={axis} className="space-y-1">
          <Row label={axis === 'w' ? '宽' : '高'} narrow>
            {(['fixed', 'fill', 'hug'] as const).map((m) => (
              <button key={m} type="button" className={seg(sz[axis] === m)} onClick={() => pick(axis, m)} data-testid={`studio-sizing-${axis}-${m}`}>
                {{ fixed: '固定', fill: '撑满', hug: '跟内容' }[m]}
              </button>
            ))}
          </Row>
          {sz[axis] === 'fixed' && (
            <Row label="" narrow>
              <NumberInput value={axis === 'w' ? node.w : node.h} min={4} onChange={(v) => onChange(axis === 'w' ? { w: v } : { h: v })} testId={`studio-prop-${axis}`} />
            </Row>
          )}
        </div>
      ))}
    </>
  );
}

/** 点了做什么：界面登记的动作（打开哪一页、拨打门店电话……） */
function ActionEditor({ value, surface, onChange }: { value: StudioAction | undefined; surface: StudioSurfaceDef; onChange: (v: StudioAction | undefined) => void }) {
  if (!surface.actions.length) return null;
  const def = value ? surface.actions.find((a) => a.key === value.action) : undefined;
  return (
    <div className="space-y-1.5" data-testid="studio-action">
      <PanelTitle>点了做什么</PanelTitle>
      <Row label="动作">
        <select
          className={inputCls}
          value={value?.action ?? ''}
          onChange={(e) => {
            const a = surface.actions.find((x) => x.key === e.target.value);
            onChange(a ? { action: a.key, arg: a.args?.[0]?.value ?? '' } : undefined);
          }}
          data-testid="studio-action-kind"
        >
          <option value="">什么都不做（只是样子）</option>
          {surface.actions.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </select>
      </Row>
      {value && def?.args && (
        <Row label="打开">
          <select className={inputCls} value={value.arg} onChange={(e) => onChange({ ...value, arg: e.target.value })} data-testid="studio-action-arg">
            {def.args.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
      )}
    </div>
  );
}

type TextLike = Extract<StudioNode, { type: 'text' | 'button' | 'field' }>;

/** 字的样子：字体、字号、粗细、行高、字距、对齐、斜体下划线、颜色（文字、按钮、数据字段共用） */
function TextStyleRows({ n, set, surface, doc }: { n: TextLike; set: (patch: Partial<StudioNode>, key: string) => void; surface: StudioSurfaceDef; doc: StudioDoc }) {
  return (
    <>
      <Row label="字体">
        <select className={inputCls} value={n.font} onChange={(e) => set({ font: e.target.value as 'zh' | 'en' }, 'font')}>
          <option value="zh">中文字体（主题）</option>
          <option value="en">英文字体（主题）</option>
        </select>
      </Row>
      <div className="grid grid-cols-2 gap-1.5">
        <Row label="字号" narrow>
          <NumberInput value={n.size} min={4} max={400} onChange={(v) => set({ size: v }, 'size')} testId="studio-prop-size" />
        </Row>
        <Row label="粗细" narrow>
          <select className={inputCls} value={n.weight} onChange={(e) => set({ weight: Number(e.target.value) as 400 }, 'weight')}>
            {[300, 400, 500, 600, 700, 900].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </Row>
        <Row label="行高" narrow>
          <NumberInput value={n.lineHeight} min={0.5} max={4} step={0.1} onChange={(v) => set({ lineHeight: v }, 'lh')} />
        </Row>
        <Row label="字距" narrow>
          <NumberInput value={n.letterSpacing} min={-0.5} max={2} step={0.01} onChange={(v) => set({ letterSpacing: v }, 'ls')} />
        </Row>
      </div>
      <Row label="对齐">
        {(['left', 'center', 'right'] as const).map((a) => (
          <button key={a} type="button" className={seg(n.align === a)} onClick={() => set({ align: a }, 'align')}>
            {{ left: '左', center: '中', right: '右' }[a]}
          </button>
        ))}
      </Row>
      <Row label="竖直">
        {(['top', 'middle', 'bottom'] as const).map((a) => (
          <button key={a} type="button" className={seg(n.valign === a)} onClick={() => set({ valign: a }, 'valign')}>
            {{ top: '上', middle: '中', bottom: '下' }[a]}
          </button>
        ))}
      </Row>
      <Row label="样式">
        <label className="flex items-center gap-1 text-[12px]">
          <input type="checkbox" checked={n.italic} onChange={(e) => set({ italic: e.target.checked }, 'italic')} /> 斜体
        </label>
        <label className="flex items-center gap-1 text-[12px]">
          <input type="checkbox" checked={n.underline} onChange={(e) => set({ underline: e.target.checked }, 'underline')} /> 下划线
        </label>
      </Row>
      <Row label="颜色">
        <ColorField value={n.color} onChange={(v) => set({ color: v ?? surface.tokens.text }, 'color')} surface={surface} doc={doc} testId="studio-prop-color" />
      </Row>
    </>
  );
}

export function PropsPanel({
  doc,
  screen,
  surface,
  selection,
  onChange,
  onDelete,
  onLayer,
  textRef,
  onOpenTemplates,
  components,
}: {
  doc: StudioDoc;
  screen: string;
  surface: StudioSurfaceDef;
  selection: string[];
  onChange: (fn: (d: StudioDoc) => StudioDoc, coalesce?: string) => void;
  onDelete: () => void;
  onLayer: (dir: 'up' | 'down' | 'top' | 'bottom') => void;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  /** 菜单页这一块：去左边「版式」改里面每一块的位置（8.1.2） */
  /** 打开左边「版式」：菜单页的版式，或 header 直接改顶栏（8.1.6） */
  onOpenTemplates?: (layout?: 'header') => void;
  /** 组件的几个操作（8.1.2） */
  components?: ComponentOps;
}) {
  const screenDef = surface.screens.find((s) => s.key === screen);
  const s = screenOf(doc, screen);
  const cid = componentIdOf(screen);
  if (selection.length === 0 && cid) {
    // 改组件时什么都没选：组件的名字、在几处用、改完回去
    const comp = doc.components?.[cid];
    return (
      <div className="space-y-3" data-testid="studio-props-component">
        <PanelTitle>组件</PanelTitle>
        <Row label="名字">
          <input
            className={inputCls}
            value={comp?.name ?? ''}
            maxLength={40}
            onChange={(e) => onChange((d) => renameComponent(d, cid, e.target.value), `comp.${cid}.name`)}
            data-testid="studio-component-name"
          />
        </Row>
        <p className="text-[12px] leading-relaxed text-ink-3">
          这份版面里有 {componentUses(doc, cid)} 处放了它：这里改了，那几处一起变（位置、大小是各处自己的）。点画布上的组件选中它，像平常一样改；选中组件这个框再「插入」就加在里面。
        </p>
        {components && (
          <Button size="sm" variant="primary" onClick={components.finish} data-testid="studio-component-done">
            改好了，回去
          </Button>
        )}
      </div>
    );
  }
  if (selection.length === 0) {
    return (
      <div className="space-y-3" data-testid="studio-props-screen">
        <PanelTitle>{screenDef?.label ?? screen}</PanelTitle>
        <p className="text-[12px] leading-relaxed text-ink-3">{screenDef?.hint}</p>
        <Row label="底色">
          <ColorField
            value={s.background}
            onChange={(v) => onChange((d) => ({ ...d, screens: { ...d.screens, [screen]: { ...screenOf(d, screen), background: v } } }), 'screen.bg')}
            surface={surface}
            doc={doc}
            allowNone
          />
        </Row>
        {surface.kind === 'phone' && (
          <>
            <Row label="屏高">
              <NumberInput
                value={s.height ?? surface.size.h}
                min={100}
                max={20000}
                onChange={(v) => onChange((d) => ({ ...d, screens: { ...d.screens, [screen]: { ...screenOf(d, screen), height: v } } }), 'screen.h')}
                testId="studio-screen-height"
              />
            </Row>
            <p className="text-[11.5px] leading-snug text-ink-3">手机往下滚：自动排列时内容多了会往下长，屏高是最少这么高。</p>
            <PanelTitle>整屏的排列</PanelTitle>
            <LayoutEditor
              value={s.layout}
              onChange={(v) =>
                onChange((d) => {
                  const cur = screenOf(d, screen);
                  const next = { ...cur };
                  if (v) next.layout = v;
                  else delete next.layout;
                  return { ...d, screens: { ...d.screens, [screen]: next } };
                }, 'screen.layout')
              }
              testId="studio-screen-layout"
            />
          </>
        )}
        <p className="text-[11.5px] leading-snug text-ink-3">
          点画布上的一块选中它；按住 Shift 点可以多选。方向键挪 1 像素（Shift 10 像素；在自动排列里是往前、往后排），Delete 删除，⌘/Ctrl+Z 撤销，⌘/Ctrl+D 复制一份。
        </p>
      </div>
    );
  }
  if (selection.length > 1) {
    return (
      <div className="space-y-3">
        <PanelTitle>选了 {selection.length} 块</PanelTitle>
        <p className="text-[12px] text-ink-3">可以一起拖动、一起删掉、一起复制。改样式请一块一块选。</p>
        <button type="button" className="flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12.5px] text-clay hover:border-clay" onClick={onDelete}>
          <Trash2 className="size-3.5" /> 删掉这几块
        </button>
      </div>
    );
  }
  const f = findNode(doc, screen, selection[0]!);
  if (!f) return null;
  const n = f.node;
  const rules = geometryRules(n, surface, f.flow);
  const block = n.type === 'block' ? surface.blocks[n.block] : undefined;
  const set = (patch: Partial<StudioNode>, key: string) =>
    onChange((d) => {
      const next = structuredClone(d);
      const x = findNode(next, screen, n.id);
      if (x) x.list[x.index] = { ...x.node, ...patch } as StudioNode;
      return next;
    }, `${n.id}.${key}`);
  const ratio = n.h > 0 ? n.w / n.h : 1;
  return (
    <div className="space-y-4" data-testid="studio-props">
      <div>
        <PanelTitle
          aside={
            <span className="text-[11px] text-ink-3">
              {block ? '功能块' : { text: '文字', rect: '矩形', ellipse: '椭圆', frame: '框', image: '图片', button: '按钮', field: '数据字段', instance: '组件' }[n.type as 'text']}
            </span>
          }
        >
          {nodeLabel(n, surface, doc)}
        </PanelTitle>
        {block && <p className="mb-2 text-[11.5px] leading-snug text-ink-3">{block.hint}</p>}
        {n.type === 'instance' && components && (
          <div className="mb-2 space-y-1.5 rounded-md border border-line bg-paper-2/60 px-2.5 py-2 text-[12px] text-ink-2" data-testid="studio-instance">
            <div>
              组件「{doc.components?.[n.component]?.name ?? '已删掉'}」，这份版面里 {componentUses(doc, n.component)} 处。位置、大小是这一处自己的，长什么样跟着组件。
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => components.edit(n.component)} data-testid="studio-instance-edit">
                改组件
              </Button>
              <Button size="sm" variant="ghost" onClick={() => components.detach(n.id)} data-testid="studio-instance-detach">
                拆开（只改这一处）
              </Button>
            </div>
          </div>
        )}
        {components && !cid && n.type !== 'block' && n.type !== 'instance' && (
          <Button size="sm" variant="secondary" className="mb-2" onClick={() => components.make(n.id)} title="⌘/Ctrl+Alt+K" data-testid="studio-make-component">
            存成组件（各处重复用，改一处都变）
          </Button>
        )}
        {block && n.type === 'block' && n.block === 'menu.pages' && onOpenTemplates && (
          <Button size="sm" variant="secondary" className="mb-2" onClick={() => onOpenTemplates()} data-testid="studio-open-templates">
            改里面每一块的位置（版式）
          </Button>
        )}
        {block && n.type === 'block' && n.block === 'menu.header' && onOpenTemplates && (
          <Button size="sm" variant="secondary" className="mb-2" onClick={() => onOpenTemplates('header')} data-testid="studio-open-header">
            编辑顶栏（每一块的位置、大小与间距）
          </Button>
        )}
        <Row label="名字">
          <input className={inputCls} value={n.name} maxLength={40} placeholder="给这一块起个名字" onChange={(e) => set({ name: e.target.value }, 'name')} />
        </Row>
      </div>
      {f.flow ? (
        <div className="space-y-1.5">
          <PanelTitle>大小（在自动排列里）</PanelTitle>
          <p className="text-[11px] leading-snug text-ink-3">位置按先后排：方向键或右边「前后」换位置。</p>
          {/* 大小由里面的内容定的功能块（员工食堂的各段、饭卡码）：不能改宽高规则 */}
          {block?.resize === 'none' ? (
            <p className="text-[11.5px] leading-snug text-ink-3">这一块的大小跟着里面的内容走，不能改。</p>
          ) : (
            <SizingRows node={n} onChange={(patch) => set(patch, 'sizing')} />
          )}
          <Row label="不透明">
            <input
              type="range"
              className="min-w-0 flex-1 accent-[var(--color-pine)]"
              min={0}
              max={1}
              step={0.05}
              value={n.opacity}
              onChange={(e) => set({ opacity: Number(e.target.value) }, 'opacity')}
            />
            <span className="w-9 shrink-0 text-right text-[11.5px] tabular-nums text-ink-3">{Math.round(n.opacity * 100)}%</span>
          </Row>
        </div>
      ) : (
        <div className="space-y-1.5">
          <PanelTitle>位置与大小</PanelTitle>
          <div className="grid grid-cols-2 gap-1.5">
            <Row label="左" narrow>
              <NumberInput value={n.x} onChange={(v) => rules.move && set({ x: v }, 'x')} testId="studio-prop-x" />
            </Row>
            <Row label="上" narrow>
              <NumberInput value={n.y} onChange={(v) => rules.move && set({ y: v }, 'y')} testId="studio-prop-y" />
            </Row>
            <Row label="宽" narrow>
              <NumberInput value={n.w} min={4} onChange={(v) => rules.resize !== 'none' && set(rules.resize === 'scale' ? { w: v, h: round1(v / ratio) } : { w: v }, 'w')} testId="studio-prop-w" />
            </Row>
            <Row label="高" narrow>
              <NumberInput value={n.h} min={4} onChange={(v) => rules.resize !== 'none' && set(rules.resize === 'scale' ? { h: v, w: round1(v * ratio) } : { h: v }, 'h')} testId="studio-prop-h" />
            </Row>
          </div>
          {(!rules.move || rules.resize === 'none') && <p className="text-[11px] text-ink-3">{n.locked ? '锁住了：在图层里解锁再改' : '这一块的位置与大小不能改（8.1.1）'}</p>}
          {n.type !== 'block' && (
            <Row label="旋转">
              <NumberInput value={n.rotate} min={-360} max={360} onChange={(v) => set({ rotate: v }, 'rotate')} />
            </Row>
          )}
          <Row label="不透明">
            <input
              type="range"
              className="min-w-0 flex-1 accent-[var(--color-pine)]"
              min={0}
              max={1}
              step={0.05}
              value={n.opacity}
              onChange={(e) => set({ opacity: Number(e.target.value) }, 'opacity')}
            />
            <span className="w-9 shrink-0 text-right text-[11.5px] tabular-nums text-ink-3">{Math.round(n.opacity * 100)}%</span>
          </Row>
        </div>
      )}

      {n.type === 'text' && (
        <div className="space-y-1.5">
          <PanelTitle>文字</PanelTitle>
          <textarea
            ref={textRef}
            className={cn(inputCls, 'h-20 py-1.5')}
            value={n.text.zh}
            maxLength={2000}
            placeholder="中文"
            onChange={(e) => set({ text: { ...n.text, zh: e.target.value } }, 'zh')}
            data-testid="studio-text-zh"
          />
          <textarea
            className={cn(inputCls, 'h-16 py-1.5')}
            value={n.text.en}
            maxLength={2000}
            placeholder="English（切到 EN 时显示；不填就显示中文）"
            onChange={(e) => set({ text: { ...n.text, en: e.target.value } }, 'en')}
            data-testid="studio-text-en"
          />
          <TextStyleRows n={n} set={set} surface={surface} doc={doc} />
          <Row label="底色">
            <ColorField value={n.fill} onChange={(v) => set({ fill: v }, 'fill')} surface={surface} doc={doc} allowNone />
          </Row>
        </div>
      )}

      {n.type === 'button' && (
        <div className="space-y-1.5">
          <PanelTitle>按钮上的字</PanelTitle>
          <input
            ref={textRef as unknown as React.RefObject<HTMLInputElement>}
            className={inputCls}
            value={n.text.zh}
            maxLength={80}
            placeholder="中文"
            onChange={(e) => set({ text: { ...n.text, zh: e.target.value } }, 'zh')}
            data-testid="studio-button-zh"
          />
          <input
            className={inputCls}
            value={n.text.en}
            maxLength={80}
            placeholder="English（不填就显示中文）"
            onChange={(e) => set({ text: { ...n.text, en: e.target.value } }, 'en')}
            data-testid="studio-button-en"
          />
          <TextStyleRows n={n} set={set} surface={surface} doc={doc} />
        </div>
      )}

      {n.type === 'field' && (
        <div className="space-y-1.5">
          <PanelTitle>显示哪一项数据</PanelTitle>
          <Row label="数据">
            <select className={inputCls} value={n.field} onChange={(e) => set({ field: e.target.value }, 'field')} data-testid="studio-field-key">
              {surface.fields.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}（例：{x.sample.zh}）
                </option>
              ))}
            </select>
          </Row>
          <div className="grid grid-cols-2 gap-1.5">
            <Row label="前面" narrow>
              <input className={inputCls} value={n.prefix.zh} maxLength={40} placeholder="如「营业」" onChange={(e) => set({ prefix: { ...n.prefix, zh: e.target.value } }, 'prefix')} />
            </Row>
            <Row label="后面" narrow>
              <input className={inputCls} value={n.suffix.zh} maxLength={40} placeholder="如「张」" onChange={(e) => set({ suffix: { ...n.suffix, zh: e.target.value } }, 'suffix')} />
            </Row>
          </div>
          <TextStyleRows n={n} set={set} surface={surface} doc={doc} />
          <Row label="底色">
            <ColorField value={n.fill} onChange={(v) => set({ fill: v }, 'fill')} surface={surface} doc={doc} allowNone />
          </Row>
        </div>
      )}

      {(n.type === 'rect' || n.type === 'ellipse' || n.type === 'frame' || n.type === 'button') && (
        <div className="space-y-1.5">
          <PanelTitle>样式</PanelTitle>
          <Row label="填充">
            <ColorField value={n.fill} onChange={(v) => set({ fill: v }, 'fill')} surface={surface} doc={doc} allowNone testId="studio-prop-fill" />
          </Row>
          <Row label="描边">
            <ColorField value={n.stroke} onChange={(v) => set({ stroke: v, strokeWidth: v && n.strokeWidth === 0 ? 1 : n.strokeWidth }, 'stroke')} surface={surface} doc={doc} allowNone />
          </Row>
          <div className="grid grid-cols-2 gap-1.5">
            <Row label="描边" narrow>
              <NumberInput value={n.strokeWidth} min={0} max={40} onChange={(v) => set({ strokeWidth: v }, 'sw')} />
            </Row>
            {n.type !== 'ellipse' && (
              <Row label="圆角">
                <NumberInput value={n.radius} min={0} max={4096} onChange={(v) => set({ radius: v }, 'radius')} testId="studio-prop-radius" />
              </Row>
            )}
          </div>
          <Row label="投影">
            {SHADOWS.map((sh) => (
              <button
                key={sh}
                type="button"
                className={cn('h-7 flex-1 rounded border text-[12px]', n.shadow === sh ? 'border-pine bg-pine-tint text-pine' : 'border-line text-ink-2')}
                onClick={() => set({ shadow: sh }, 'shadow')}
              >
                {SHADOW_LABELS[sh]}
              </button>
            ))}
          </Row>
          {n.type === 'frame' && (
            <Row label="裁剪">
              <label className="flex items-center gap-1 text-[12px]">
                <input type="checkbox" checked={n.clip} onChange={(e) => set({ clip: e.target.checked }, 'clip')} /> 超出框的部分不显示
              </label>
            </Row>
          )}
        </div>
      )}

      {n.type === 'frame' && (
        <div className="space-y-1.5">
          <PanelTitle>框里的东西怎么排</PanelTitle>
          <LayoutEditor
            value={n.layout}
            onChange={(v) =>
              onChange((d) => {
                const next = structuredClone(d);
                const x = findNode(next, screen, n.id);
                if (x && x.node.type === 'frame') {
                  const frame = { ...x.node };
                  if (v) frame.layout = v;
                  else delete frame.layout;
                  x.list[x.index] = frame;
                }
                return next;
              }, `${n.id}.layout`)
            }
            testId="studio-frame-layout"
          />
        </div>
      )}

      {(n.type === 'frame' || n.type === 'image' || n.type === 'button') && (
        <ActionEditor
          value={n.action}
          surface={surface}
          onChange={(v) =>
            onChange((d) => {
              const next = structuredClone(d);
              const x = findNode(next, screen, n.id);
              if (x && (x.node.type === 'frame' || x.node.type === 'image' || x.node.type === 'button')) {
                const node = { ...x.node };
                if (v) node.action = v;
                else delete node.action;
                x.list[x.index] = node;
              }
              return next;
            }, `${n.id}.action`)
          }
        />
      )}

      {n.type === 'image' && (
        <div className="space-y-1.5">
          <PanelTitle>图片</PanelTitle>
          <Row label="填充方式">
            <select className={inputCls} value={n.fit} onChange={(e) => set({ fit: e.target.value as 'cover' }, 'fit')}>
              <option value="cover">铺满（多出来的裁掉）</option>
              <option value="contain">完整显示（留边）</option>
              <option value="fill">拉伸</option>
            </select>
          </Row>
          {surface.squareImages ? (
            <p className="text-[11.5px] leading-snug text-ink-3" data-testid="studio-image-square">
              图片一律直角（品牌规定）。
            </p>
          ) : (
            <Row label="圆角">
              <NumberInput value={n.radius} min={0} max={4096} onChange={(v) => set({ radius: v }, 'radius')} />
            </Row>
          )}
          <Row label="底色">
            <ColorField value={n.fill} onChange={(v) => set({ fill: v }, 'fill')} surface={surface} doc={doc} allowNone />
          </Row>
        </div>
      )}

      {block && block.props.length > 0 && n.type === 'block' && (
        <div className="space-y-2">
          <PanelTitle>这一块的样子</PanelTitle>
          {block.props.map((p) => (
            <Row key={p.key} label={p.label.split('（')[0]!.slice(0, 8)}>
              <BlockPropField def={p} value={n.props[p.key]} surface={surface} doc={doc} onChange={(v) => set({ props: { ...n.props, [p.key]: v } } as Partial<StudioNode>, `prop.${p.key}`)} />
            </Row>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <PanelTitle>{f.flow ? '先后（自动排列里的顺序）' : '前后'}</PanelTitle>
        <div className="flex gap-1">
          {(
            [
              ['top', <ChevronsUp key="t" className="size-3.5" />, f.flow ? '排到最后' : '到最上'],
              ['up', <ArrowUp key="u" className="size-3.5" />, f.flow ? '往后排一个' : '往上一层'],
              ['down', <ArrowDown key="d" className="size-3.5" />, f.flow ? '往前排一个' : '往下一层'],
              ['bottom', <ChevronsDown key="b" className="size-3.5" />, f.flow ? '排到最前' : '到最下'],
            ] as const
          ).map(([dir, icon, label]) => (
            <button
              key={dir}
              type="button"
              title={label}
              className="flex h-8 flex-1 items-center justify-center rounded-md border border-line text-ink-2 hover:border-pine hover:text-pine"
              onClick={() => onLayer(dir)}
            >
              {icon}
            </button>
          ))}
        </div>
        {f.parent && (
          <button
            type="button"
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-line text-[12.5px] text-ink-2 hover:border-pine hover:text-pine"
            onClick={() => onChange((d) => moveOutOfFrame(d, screen, n.id))}
            data-testid="studio-move-out"
          >
            <LogOut className="size-3.5" /> 移出框（放到「{nodeLabel(f.parent, surface)}」后面）
          </button>
        )}
        <button
          type="button"
          disabled={!!block?.required}
          title={block?.required ? '必需的块不能删，可以挪' : undefined}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-line text-[12.5px] text-clay hover:border-clay disabled:opacity-40"
          onClick={onDelete}
          data-testid="studio-delete"
        >
          <Trash2 className="size-3.5" /> {block?.required ? '必需的块不能删' : '删掉这一块'}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── 检查 ─────────────────────────

export function ChecksPanel({ issues, surface, onGo }: { issues: StudioIssue[]; surface: StudioSurfaceDef; onGo: (screen?: string, nodeId?: string) => void }) {
  const red = issues.filter((i) => i.level === 'error');
  const yellow = issues.filter((i) => i.level === 'warn');
  const item = (i: StudioIssue, k: number) => (
    <button
      key={k}
      type="button"
      className={cn(
        'w-full rounded-md border px-2.5 py-2 text-left text-[12px] leading-snug',
        i.level === 'error' ? 'border-clay/40 bg-[#fbecea] text-clay' : 'border-yuzu/50 bg-yuzu-soft text-yuzu-deep',
      )}
      onClick={() => onGo(i.screen, i.nodeId)}
    >
      {i.screen && <span className="mr-1 font-medium">{surface.screens.find((s) => s.key === i.screen)?.label ?? i.screen} ·</span>}
      {i.message}
    </button>
  );
  return (
    <div className="space-y-3" data-testid="studio-checks">
      <PanelTitle>检查（红的改掉才能发布，黄的提醒一下）</PanelTitle>
      {issues.length === 0 && <p className="rounded-md bg-pine-tint px-3 py-2 text-[12.5px] text-pine">都没问题，可以发布。</p>}
      {red.map(item)}
      {yellow.map(item)}
    </div>
  );
}
