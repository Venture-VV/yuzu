// UI 工作台编辑器（8.1.1，docs/WORKBENCH_V811.md）：设计师在系统里直接改平板电子菜单的版面——所见即所得、改完自己发布（GZ3）。
//
// 顶栏：回后台、屏（起始页 / 菜单页）、预览的语言与字号档、撤销重做、缩放、保存状态、检查、预览、版本、发布。
// 左栏：图层、插入、素材、主题；中间：画布（与平板同一个渲染器）；右栏：属性 / 检查。
// 草稿每改一步自动存（带版本号，别处改过时拒绝、提示刷新）；撤销、重做在本机，最多 200 步。
// 发布、回滚带操作编号，接进「结果待确认」（断网时查回、重提或作废）；发布前跑检查，红的拦下。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Eye, History, Maximize2, Minus, Plus, Redo2, Send, TriangleAlert, Undo2 } from 'lucide-react';
import type { EmenuMenu } from '@shared/emenu';
import { qrShape } from '@shared/qr-svg';
import {
  checkStudioDoc,
  defaultStudioDoc,
  screenLabel,
  STUDIO_SURFACE_DEFS,
  STUDIO_SURFACES,
  themeVars,
  type StudioAssetView,
  type StudioDoc,
  type StudioIssue,
  type StudioNode,
  type StudioPreviewCode,
  type StudioState,
  type StudioSurface,
  type StudioVersionView,
} from '@shared/studio';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Dialog } from '../../components/Overlay';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Skeleton, Textarea } from '../../components/ui';
import { StudioCanvas } from './Canvas';
import { emenuEditorBlocks, flatPages } from './emenuBlocks';
import { useDocHistory } from './history';
import { duplicateNodes, findNode, geometryRules, insertNode, makeEllipse, makeFrame, makeImage, makeRect, makeText, moveLayer, newId, removeNodes, round1, screenOf, updateNodes } from './model';
import { AssetsPanel, ChecksPanel, InsertPanel, LayersPanel, PropsPanel, ThemePanel } from './panels';

type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
const ZOOMS = [0.5, 0.75, 1, 1.25] as const;

function QrCode({ text, className }: { text: string; className?: string }) {
  const shape = useMemo(() => qrShape(text), [text]);
  return (
    <svg viewBox={`-2 -2 ${shape.size + 4} ${shape.size + 4}`} className={className} role="img" aria-label="二维码">
      <rect x={-2} y={-2} width={shape.size + 4} height={shape.size + 4} fill="#fff" />
      <path d={shape.modules} fill="#1c231f" />
      {shape.eyes.map((e) => (
        <g key={`${e.x}-${e.y}`}>
          <rect x={e.x + 0.5} y={e.y + 0.5} width="6" height="6" rx="1.8" fill="none" stroke="#24493a" strokeWidth="1" />
          <rect x={e.x + 2} y={e.y + 2} width="3" height="3" rx="0.9" fill="#24493a" />
        </g>
      ))}
    </svg>
  );
}

function ToolButton({ title, onClick, disabled, children, active, testId }: { title: string; onClick: () => void; disabled?: boolean; children: ReactNode; active?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn('flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] text-ink-2 hover:bg-paper-2 disabled:opacity-35', active && 'bg-pine-tint text-pine')}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

const isEditable = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

export function StudioPage() {
  const params = useParams();
  const surface = (STUDIO_SURFACES as readonly string[]).includes(params.surface ?? '') ? (params.surface as StudioSurface) : 'emenu';
  const def = STUDIO_SURFACE_DEFS[surface];
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const canPublish = can('studio.publish');

  const stateQ = useQuery({ queryKey: ['studio', 'state', surface], queryFn: () => api.get<StudioState>(`/api/studio/${surface}`), refetchOnWindowFocus: false, staleTime: Infinity });
  const menuQ = useQuery({ queryKey: ['studio', 'menu'], queryFn: () => api.get<EmenuMenu>('/api/studio/emenu/menu'), staleTime: 60_000 });
  const assetsQ = useQuery({ queryKey: ['studio', 'assets'], queryFn: () => api.get<StudioAssetView[]>('/api/studio/assets') });

  const history = useDocHistory(defaultStudioDoc(surface));
  const { doc } = history;
  const [loaded, setLoaded] = useState(false);
  const rev = useRef(0);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [selection, setSelection] = useState<string[]>([]);
  const [screen, setScreen] = useState(def.screens[0]!.key);
  const [left, setLeft] = useState<'layers' | 'insert' | 'assets' | 'theme'>('layers');
  const [right, setRight] = useState<'props' | 'checks'>('props');
  const [zoom, setZoom] = useState<'fit' | (typeof ZOOMS)[number]>('fit');
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [big, setBig] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [dialog, setDialog] = useState<null | 'publish' | 'versions' | 'preview'>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const clipboard = useRef<StudioNode[]>([]);

  // 第一次取到草稿：放进编辑器（之后不再被服务端的覆盖，除非刷新）
  useEffect(() => {
    if (!stateQ.data || loaded) return;
    history.reset(stateQ.data.draft.doc);
    rev.current = stateQ.data.draft.rev;
    setBig(menuQ.data ? menuQ.data.rules.textSize !== 'design' : false);
    setLoaded(true);
  }, [stateQ.data, loaded, history, menuQ.data]);

  // ── 自动保存：改了以后停 1.2 秒存一次；带版本号，别处改过时拒绝 ──
  const saving = useRef<Promise<boolean> | null>(null);
  const latest = useRef(doc);
  latest.current = doc;
  const save = useCallback(async (): Promise<boolean> => {
    if (saving.current) await saving.current;
    const body = latest.current;
    const run = (async () => {
      setStatus('saving');
      try {
        const r = await api.put<{ rev: number }>(`/api/studio/${surface}/draft`, { rev: rev.current, doc: body }, { timeoutMs: 20_000 });
        rev.current = r.rev;
        setStatus(latest.current === body ? 'saved' : 'dirty');
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'STUDIO_REV') setStatus('conflict');
        else {
          setStatus('error');
          if (e instanceof ApiError && e.status === 422) toast({ tone: 'error', title: '这一步存不进去', body: e.message });
        }
        return false;
      }
    })();
    saving.current = run;
    try {
      return await run;
    } finally {
      if (saving.current === run) saving.current = null;
    }
  }, [surface, toast]);
  useEffect(() => {
    if (!loaded || history.changes === 0) return;
    setStatus((s) => (s === 'conflict' ? s : 'dirty'));
    const t = window.setTimeout(() => {
      if (status !== 'conflict') void save();
    }, 1200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.changes, loaded]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (status === 'dirty' || status === 'saving' || status === 'error') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [status]);

  const change = useCallback((fn: (d: StudioDoc) => StudioDoc, coalesce?: string) => history.set(fn(latest.current), coalesce), [history]);

  // ── 选中的那一屏、检查 ──
  const assetSizes = useMemo(() => new Map((assetsQ.data ?? []).map((a) => [a.id, a.size])), [assetsQ.data]);
  const issues: StudioIssue[] = useMemo(
    () => checkStudioDoc(doc, { assets: assetsQ.data ? assetSizes : undefined, langSwitch: stateQ.data?.langSwitch ?? true }),
    [doc, assetSizes, assetsQ.data, stateQ.data?.langSwitch],
  );
  const red = issues.filter((i) => i.level === 'error').length;
  const vars = useMemo(() => themeVars(doc), [doc]);
  const blocks = useMemo(() => emenuEditorBlocks(menuQ.data ?? null, { lang, pageIndex }), [menuQ.data, lang, pageIndex]);
  const flat = useMemo(() => flatPages(menuQ.data ?? null), [menuQ.data]);

  // ── 缩放：适应画布区域 ──
  const area = useRef<HTMLDivElement>(null);
  const [areaSize, setAreaSize] = useState({ w: 1024, h: 768 });
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);
  const fit = Math.max(0.2, Math.min((areaSize.w - 48) / def.size.w, (areaSize.h - 48) / def.size.h));
  const scale = zoom === 'fit' ? fit : zoom;

  // ── 操作 ──
  const insert = useCallback(
    (node: StudioNode) => {
      change((d) => insertNode(d, screen, node));
      setSelection([node.id]);
      setLeft('layers');
      setRight('props');
    },
    [change, screen],
  );
  const deleteSelection = useCallback(() => {
    const removable = selection.filter((id) => {
      const f = findNode(latest.current, screen, id);
      return f && !(f.node.type === 'block' && def.blocks[f.node.block]?.required);
    });
    if (removable.length < selection.length) toast({ tone: 'info', title: '必需的功能块不能删（可以挪、改样子）' });
    if (!removable.length) return;
    change((d) => removeNodes(d, screen, removable));
    setSelection([]);
  }, [selection, screen, change, def.blocks, toast]);
  const nudge = useCallback(
    (dx: number, dy: number) => {
      const patches: Record<string, Partial<StudioNode>> = {};
      for (const id of selection) {
        const f = findNode(latest.current, screen, id);
        if (f && geometryRules(f.node, def).move) patches[id] = { x: round1(f.node.x + dx), y: round1(f.node.y + dy) };
      }
      if (Object.keys(patches).length) change((d) => updateNodes(d, screen, patches), `nudge.${selection.join(',')}`);
    },
    [selection, screen, change, def],
  );

  // ── 快捷键（照 Figma 的习惯） ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || isEditable(document.activeElement)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        history.redo();
      } else if (mod && k === 's') {
        e.preventDefault();
        void save();
      } else if (mod && k === 'd') {
        e.preventDefault();
        const r = duplicateNodes(latest.current, screen, selection, def);
        if (r.ids.length) {
          history.set(r.doc);
          setSelection(r.ids);
        }
      } else if (mod && k === 'c') {
        clipboard.current = selection.map((id) => findNode(latest.current, screen, id)?.node).filter((n): n is StudioNode => !!n && n.type !== 'block');
      } else if (mod && k === 'v') {
        if (!clipboard.current.length) return;
        e.preventDefault();
        let d = latest.current;
        const ids: string[] = [];
        for (const n of clipboard.current) {
          const copy = { ...structuredClone(n), id: newId(n.type.slice(0, 1)), x: n.x + 16, y: n.y + 16 } as StudioNode;
          d = insertNode(d, screen, copy);
          ids.push(copy.id);
        }
        history.set(d);
        setSelection(ids);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection.length) {
          e.preventDefault();
          deleteSelection();
        }
      } else if (e.key.startsWith('Arrow')) {
        if (!selection.length) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      } else if (e.key === 'Escape') {
        setSelection([]);
      } else if (!mod && !e.altKey) {
        const cx = def.size.w / 2;
        const cy = def.size.h / 2;
        if (k === 't') insert(makeText(cx - 160, cy - 20));
        else if (k === 'r') insert(makeRect(cx - 100, cy - 60));
        else if (k === 'o') insert(makeEllipse(cx - 60, cy - 60));
        else if (k === 'f') insert(makeFrame(cx - 160, cy - 100));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, history, save, selection, screen, def, deleteSelection, nudge, insert]);

  // 选中的不在这一屏了（撤销、删掉、换屏）：去掉
  useEffect(() => {
    setSelection((sel) => {
      const next = sel.filter((id) => findNode(doc, screen, id));
      return next.length === sel.length ? sel : next;
    });
  }, [doc, screen]);

  if (stateQ.isError && !stateQ.data) {
    return (
      <div className="flex h-dvh items-center justify-center bg-paper p-6">
        <LoadFailed title="工作台的版面取不回来，请检查网络" onRetry={() => void stateQ.refetch()} retrying={stateQ.isFetching} testId="studio-load-error" />
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex h-dvh items-center justify-center bg-paper">
        <Skeleton className="h-[480px] w-[640px]" />
      </div>
    );
  }

  const statusText: Record<SaveStatus, string> = { saved: '草稿已保存', dirty: '有改动，马上保存…', saving: '正在保存…', error: '没存上（网络不通？）', conflict: '别处改过这份版面' };

  return (
    <div className="flex h-dvh flex-col bg-paper-2 text-ink" data-testid="studio">
      {/* 顶栏 */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-card px-2">
        <Link to="/admin/studio" className="flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] text-ink-2 hover:bg-paper-2" title="回后台的「工作台」">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="mr-2 text-[13.5px] font-bold">
          工作台 <span className="font-normal text-ink-3">· {def.label}</span>
        </div>
        <div className="flex rounded-md border border-line p-0.5" data-testid="studio-screens">
          {def.screens.map((s) => (
            <button
              key={s.key}
              type="button"
              className={cn('h-7 rounded px-2.5 text-[12.5px]', screen === s.key ? 'bg-pine text-white' : 'text-ink-2 hover:bg-paper-2')}
              onClick={() => {
                setScreen(s.key);
                setSelection([]);
              }}
              data-testid={`studio-screen-${s.key}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {screen === 'menu' && flat.length > 0 && (
          <select className="ml-1 h-8 max-w-44 rounded-md border border-line bg-card px-1.5 text-[12px]" value={pageIndex} onChange={(e) => setPageIndex(Number(e.target.value))} title="画布上显示哪一页菜单（只是预览）">
            {flat.map((f, i) => (
              <option key={i} value={i}>
                {f.category.name} · 第 {f.pageNo + 1} 页
              </option>
            ))}
          </select>
        )}
        <div className="mx-1 h-5 w-px bg-line" />
        <ToolButton title="看中文 / 英文的样子" onClick={() => setLang((l) => (l === 'zh' ? 'en' : 'zh'))} testId="studio-lang">
          {lang === 'zh' ? '中' : 'EN'}
        </ToolButton>
        <ToolButton title="字与按钮：设计稿原样 / 放大（平板上按后台「电子菜单 → 设置」）" onClick={() => setBig((b) => !b)} active={big}>
          {big ? '放大' : '原样'}
        </ToolButton>
        <div className="mx-1 h-5 w-px bg-line" />
        <ToolButton title="撤销（⌘/Ctrl+Z）" onClick={history.undo} disabled={!history.canUndo} testId="studio-undo">
          <Undo2 className="size-4" />
        </ToolButton>
        <ToolButton title="重做（⌘/Ctrl+Shift+Z）" onClick={history.redo} disabled={!history.canRedo} testId="studio-redo">
          <Redo2 className="size-4" />
        </ToolButton>
        <div className="mx-1 h-5 w-px bg-line" />
        <ToolButton title="缩小" onClick={() => setZoom(ZOOMS.filter((z) => z < scale - 0.01).at(-1) ?? 0.5)}>
          <Minus className="size-4" />
        </ToolButton>
        <span className="w-11 text-center text-[12px] tabular-nums text-ink-3">{Math.round(scale * 100)}%</span>
        <ToolButton title="放大" onClick={() => setZoom(ZOOMS.find((z) => z > scale + 0.01) ?? 1.25)}>
          <Plus className="size-4" />
        </ToolButton>
        <ToolButton title="适应窗口" onClick={() => setZoom('fit')} active={zoom === 'fit'}>
          <Maximize2 className="size-4" />
        </ToolButton>
        <div className="flex-1" />
        <span className={cn('mr-2 text-[12px]', status === 'error' || status === 'conflict' ? 'text-clay' : 'text-ink-3')} data-testid="studio-save-status" data-status={status}>
          {statusText[status]}
        </span>
        {status === 'error' && (
          <Button size="sm" variant="secondary" onClick={() => void save()}>
            再存一次
          </Button>
        )}
        <ToolButton title="检查" onClick={() => setRight('checks')} active={right === 'checks'} testId="studio-open-checks">
          {red ? <TriangleAlert className="size-4 text-clay" /> : <CheckCircle2 className="size-4 text-pine" />}
          检查{issues.length ? `（${issues.length}）` : ''}
        </ToolButton>
        <ToolButton title="像客人一样点一点；也可以在真平板上扫码看" onClick={() => setDialog('preview')} testId="studio-open-preview">
          <Eye className="size-4" /> 预览
        </ToolButton>
        <ToolButton title="已发布的各版，可以回到任何一版" onClick={() => setDialog('versions')} testId="studio-open-versions">
          <History className="size-4" /> 版本
        </ToolButton>
        <Button size="sm" variant="primary" disabled={!canPublish} onClick={() => setDialog('publish')} data-testid="studio-open-publish" title={canPublish ? undefined : '这个账号没有「工作台：发布」'}>
          <Send className="size-3.5" /> 发布
        </Button>
      </header>

      {status === 'conflict' && (
        <div className="flex items-center gap-3 border-b border-clay/30 bg-[#fbecea] px-4 py-2 text-[12.5px] text-clay" data-testid="studio-conflict">
          这份版面刚刚在别处改过（另一个人或另一个窗口），这里的改动没有存上。
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
            重新载入（丢掉这里没存的）
          </Button>
        </div>
      )}
      <ErpPendingPanel types={['studio_publish']} className="mx-3 mt-2" onFound={() => void qc.invalidateQueries({ queryKey: ['studio'] })} />

      <div className="flex min-h-0 flex-1">
        {/* 左栏 */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-card">
          <div className="grid grid-cols-4 border-b border-line text-[12.5px]">
            {(
              [
                ['layers', '图层'],
                ['insert', '插入'],
                ['assets', '素材'],
                ['theme', '主题'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" className={cn('h-9 border-b-2', left === k ? 'border-pine font-medium text-pine' : 'border-transparent text-ink-3 hover:text-ink')} onClick={() => setLeft(k)} data-testid={`studio-tab-${k}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {left === 'layers' && <LayersPanel doc={doc} screen={screen} surface={def} selection={selection} onSelect={setSelection} onChange={change} />}
            {left === 'insert' && <InsertPanel doc={doc} screen={screen} surface={def} onInsert={insert} />}
            {left === 'assets' && (
              <AssetsPanel
                assets={assetsQ.data ?? []}
                loading={assetsQ.isPending}
                disabled={false}
                onUploaded={() => void qc.invalidateQueries({ queryKey: ['studio', 'assets'] })}
                onUse={(a) => insert(makeImage(def.size.w / 2 - 150, def.size.h / 2 - 100, a.id, a.width, a.height))}
              />
            )}
            {left === 'theme' && <ThemePanel doc={doc} surface={def} onChange={change} />}
          </div>
        </aside>

        {/* 画布 */}
        <main ref={area} className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-6" onPointerDown={(e) => e.target === e.currentTarget && setSelection([])}>
          <StudioCanvas
            doc={doc}
            screen={screen}
            surface={def}
            selection={selection}
            onSelect={(ids) => {
              setSelection(ids);
              if (ids.length) setRight('props');
            }}
            scale={scale}
            lang={lang}
            big={big}
            vars={vars}
            blocks={blocks}
            onLive={history.live}
            onCommit={history.commit}
            onEditText={(id) => {
              setSelection([id]);
              setRight('props');
              window.setTimeout(() => textRef.current?.focus(), 30);
            }}
          />
        </main>

        {/* 右栏 */}
        <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-card">
          <div className="grid grid-cols-2 border-b border-line text-[12.5px]">
            <button type="button" className={cn('h-9 border-b-2', right === 'props' ? 'border-pine font-medium text-pine' : 'border-transparent text-ink-3')} onClick={() => setRight('props')}>
              属性
            </button>
            <button type="button" className={cn('h-9 border-b-2', right === 'checks' ? 'border-pine font-medium text-pine' : 'border-transparent text-ink-3')} onClick={() => setRight('checks')}>
              检查{red ? <span className="ml-1 rounded-full bg-clay px-1.5 text-[10px] text-white">{red}</span> : null}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {right === 'props' ? (
              <PropsPanel doc={doc} screen={screen} surface={def} selection={selection} onChange={change} onDelete={deleteSelection} onLayer={(dir) => selection[0] && change((d) => moveLayer(d, screen, selection[0]!, dir))} textRef={textRef} />
            ) : (
              <ChecksPanel
                issues={issues}
                surface={def}
                onGo={(sc, id) => {
                  if (sc) setScreen(sc);
                  setSelection(id ? [id] : []);
                  if (id) setRight('props');
                }}
              />
            )}
          </div>
        </aside>
      </div>

      {dialog === 'publish' && (
        <PublishDialog
          surface={surface}
          issues={issues}
          staffName={session.staff.displayName}
          flush={save}
          revOf={() => rev.current}
          published={stateQ.data?.published ?? null}
          onClose={() => setDialog(null)}
          onDone={(v) => {
            setDialog(null);
            void qc.invalidateQueries({ queryKey: ['studio'] });
            toast({ tone: 'success', title: `已发布第 ${v.version} 版`, body: '各台平板回到起始页（或空闲）时换成新样子；改坏了在「版本」里回到上一版。' });
          }}
          onShowChecks={() => {
            setDialog(null);
            setRight('checks');
          }}
        />
      )}
      {dialog === 'versions' && (
        <VersionsDialog
          surface={surface}
          canPublish={canPublish}
          staffName={session.staff.displayName}
          onClose={() => setDialog(null)}
          onUseAsDraft={(d) => {
            history.set(d);
            setSelection([]);
            setDialog(null);
            toast({ tone: 'success', title: '已把这一版放进草稿', body: '可以接着改；发布以后平板才换。' });
          }}
        />
      )}
      {dialog === 'preview' && <PreviewDialog surface={surface} doc={doc} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ───────────────────────── 发布 ─────────────────────────

function PublishDialog({
  surface,
  issues,
  staffName,
  flush,
  revOf,
  published,
  onClose,
  onDone,
  onShowChecks,
}: {
  surface: StudioSurface;
  issues: StudioIssue[];
  staffName: string;
  flush: () => Promise<boolean>;
  revOf: () => number;
  published: StudioVersionView | null;
  onClose: () => void;
  onDone: (v: StudioVersionView) => void;
  onShowChecks: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const red = issues.filter((i) => i.level === 'error');
  const yellow = issues.filter((i) => i.level === 'warn');
  const go = async () => {
    if (!note.trim()) {
      toast({ tone: 'error', title: '写一句改了什么（版本列表里看得到）' });
      return;
    }
    setBusy(true);
    try {
      // 先把还没存的草稿存上：发布的是存好的那一份
      if (!(await flush())) {
        toast({ tone: 'error', title: '草稿没存上，先处理顶上的提示再发布' });
        return;
      }
      const key = uuid();
      const v = await sendErpOp<StudioVersionView>({ key, type: 'studio_publish', url: `/api/studio/${surface}/publish`, body: { clientKey: key, rev: revOf(), note: note.trim() }, summary: `发布：${note.trim()}`.slice(0, 200), staffName });
      onDone(v);
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'info', title: '发布的结果没有收到', body: '顶上的「结果待确认」里可以查回、按原内容重新提交或作废；不要另发一次。' });
      else toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open title="发布" description={published ? `平板现在用的是第 ${published.version} 版（${published.publishedBy} ${new Date(published.publishedAt).toLocaleString('zh-CN')}）` : '平板现在用的是内置的默认版面（还没发布过）'} onClose={onClose}>
      <div className="space-y-3" data-testid="studio-publish">
        {red.length > 0 ? (
          <div className="rounded-md border border-clay/40 bg-[#fbecea] px-3 py-2 text-[12.5px] text-clay">
            检查有 {red.length} 处红的，改掉才能发布。
            <button type="button" className="ml-2 underline" onClick={onShowChecks}>
              去看看
            </button>
          </div>
        ) : yellow.length > 0 ? (
          <div className="rounded-md border border-yuzu/50 bg-yuzu-soft px-3 py-2 text-[12.5px] text-yuzu-deep">有 {yellow.length} 处提醒（黄的），可以先发布，之后再改。</div>
        ) : (
          <div className="rounded-md bg-pine-tint px-3 py-2 text-[12.5px] text-pine">检查都过了。</div>
        )}
        <label className="block text-[12.5px] text-ink-2">
          这一版改了什么（版本列表里看得到）
          <Textarea className="mt-1" rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：起始页加了冬季海报、强调色换深一点" data-testid="studio-publish-note" />
        </label>
        <p className="text-[12px] leading-relaxed text-ink-3">发布以后各台平板在停在起始页、或空闲回到起始页时换成新样子（客人点菜中途不换）；改坏了在「版本」里一键回到上一版。发布记在操作审计里。</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            再看看
          </Button>
          <Button variant="primary" loading={busy} disabled={red.length > 0} onClick={() => void go()} data-testid="studio-publish-go">
            发布
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────── 版本 ─────────────────────────

function VersionsDialog({ surface, canPublish, staffName, onClose, onUseAsDraft }: { surface: StudioSurface; canPublish: boolean; staffName: string; onClose: () => void; onUseAsDraft: (doc: StudioDoc) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['studio', 'versions', surface], queryFn: () => api.get<StudioVersionView[]>(`/api/studio/${surface}/versions`) });
  const [busy, setBusy] = useState<number | null>(null);
  const rollback = async (v: StudioVersionView) => {
    if (!window.confirm(`回到第 ${v.version} 版？会照第 ${v.version} 版再发一版（历史都留着），平板回到起始页时换。`)) return;
    setBusy(v.version);
    try {
      const key = uuid();
      const r = await sendErpOp<StudioVersionView>({ key, type: 'studio_publish', url: `/api/studio/${surface}/rollback`, body: { clientKey: key, version: v.version, note: '' }, summary: `回到第 ${v.version} 版`, staffName });
      toast({ tone: 'success', title: `已回到第 ${v.version} 版（发成第 ${r.version} 版）` });
      void qc.invalidateQueries({ queryKey: ['studio'] });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const useAsDraft = async (v: StudioVersionView) => {
    try {
      const r = await api.get<{ doc: StudioDoc }>(`/api/studio/${surface}/versions/${v.version}`);
      onUseAsDraft(r.doc);
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  return (
    <Dialog open title="已发布的版本" description="任何一版都能回去（照那一版再发一版，历史不丢），也能放进草稿接着改" onClose={onClose}>
      <div className="max-h-[60vh] space-y-2 overflow-y-auto" data-testid="studio-versions">
        {q.isPending ? (
          <Skeleton className="h-24" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="版本列表取不回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : q.data!.length === 0 ? (
          <p className="text-[13px] text-ink-3">还没发布过：平板用的是内置的默认版面。</p>
        ) : (
          q.data!.map((v, i) => (
            <div key={v.id} className="rounded-md border border-line px-3 py-2" data-testid={`studio-version-${v.version}`}>
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-bold">第 {v.version} 版</span>
                {i === 0 && <span className="rounded bg-pine-tint px-1.5 text-[11px] text-pine">平板现在用的</span>}
                {v.kind === 'rollback' && <span className="rounded bg-paper-2 px-1.5 text-[11px] text-ink-3">回到第 {v.rollbackOf} 版</span>}
                <span className="ml-auto text-[11.5px] text-ink-3">
                  {v.publishedBy} · {new Date(v.publishedAt).toLocaleString('zh-CN')}
                </span>
              </div>
              <div className="mt-0.5 text-[12.5px] text-ink-2">{v.note}</div>
              <div className="mt-0.5 text-[11.5px] text-ink-3">改了：{v.screensChanged.map((s) => screenLabel(surface, s)).join('、') || '—'}</div>
              <div className="mt-1.5 flex gap-2">
                {i > 0 && canPublish && (
                  <Button size="sm" variant="secondary" loading={busy === v.version} onClick={() => void rollback(v)} data-testid={`studio-rollback-${v.version}`}>
                    回到这一版
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void useAsDraft(v)}>
                  放进草稿接着改
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 预览 ─────────────────────────

function PreviewDialog({ surface, doc, onClose }: { surface: StudioSurface; doc: StudioDoc; onClose: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState<StudioPreviewCode | null>(null);
  const [busy, setBusy] = useState(false);
  const make = useCallback(async () => {
    setBusy(true);
    try {
      setCode(await api.post<StudioPreviewCode>(`/api/studio/${surface}/preview-code`, { doc }));
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }, [surface, doc, toast]);
  useEffect(() => {
    void make();
    // 打开时生成一次（之后改了再点「重新生成」）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const url = code ? `${window.location.origin}/emenu?studio=${code.code}` : '';
  return (
    <Dialog open title="预览（现在的草稿）" description="像客人一样点一点：翻分类、加菜、开订单；预览里不能下单" onClose={onClose}>
      <div className="space-y-3" data-testid="studio-preview">
        {!code ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="flex gap-4">
            <QrCode text={url} className="size-36 shrink-0 rounded border border-line" />
            <div className="min-w-0 space-y-2 text-[12.5px] text-ink-2">
              <p>
                预览码 <span className="font-mono text-[15px] font-bold tracking-wider text-ink" data-testid="studio-preview-code">{code.code}</span>，{new Date(code.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效（30 分钟）。
              </p>
              <p>在真平板上看：平板登录着「点餐平板」账号，扫左边的码，或打开 <span className="break-all font-mono text-[11.5px]">{url}</span></p>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={() => window.open(url, '_blank', 'noopener')} data-testid="studio-preview-open">
                  在这台电脑上打开
                </Button>
                <Button size="sm" variant="secondary" loading={busy} onClick={() => void make()}>
                  照现在的改动重新生成
                </Button>
              </div>
            </div>
          </div>
        )}
        <p className="text-[11.5px] text-ink-3">预览用的是生成那一刻的草稿；之后又改了，点「照现在的改动重新生成」。</p>
      </div>
    </Dialog>
  );
}
