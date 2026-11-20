// UI 工作台编辑器（8.1.1 起，docs/WORKBENCH_V811.md）：设计师在系统里直接改版面（平板电子菜单、微信小程序……）——所见即所得、改完自己发布（GZ3）。
//
// 顶栏：回后台、屏（起始页 / 菜单页……）、预览的语言与字号档（平板菜单）、撤销重做、缩放、保存状态、检查、预览、版本、发布。
// 左栏：图层、插入、素材、主题；中间：画布（与平板同一个渲染器）；右栏：属性 / 检查。
// 草稿每改一步自动存（带版本号，别处改过时拒绝、提示刷新）；撤销、重做在本机，最多 200 步。
// 发布、回滚带操作编号，接进「结果待确认」（断网时查回、重提或作废）；发布前跑检查，红的拦下。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBlocker, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Ellipsis, Eye, History, Languages, LogOut, Maximize2, MessageSquare, Minus, Package, Plus, Redo2, Send, TriangleAlert, Undo2 } from 'lucide-react';
import { formatWindow, periodWindow, type EmenuLayout, type EmenuMenu, type EmenuPeriodKey } from '@shared/emenu';
import { qrShape } from '@shared/qr-svg';
import {
  checkStudioDoc,
  defaultStudioDoc,
  EMENU_ALL_TEMPLATES,
  EMENU_HEADER_LAYOUT,
  isFlow,
  resolveSlot,
  screenLabel,
  setSlotSpot,
  slotSpot,
  STUDIO_SURFACE_DEFS,
  STUDIO_SURFACES,
  themeVars,
  type StudioAssetView,
  type StudioDishState,
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
import {
  componentIdOf,
  componentScreen,
  deleteComponent,
  detachInstance,
  duplicateNodes,
  findNode,
  isComponentScreen,
  makeComponentFrom,
  geometryRules,
  insertNode,
  makeEllipse,
  makeFrame,
  makeImage,
  makeRect,
  makeText,
  moveLayer,
  newId,
  removeNodes,
  round1,
  screenOf,
  sizeForFlow,
  updateNodes,
  type Box,
} from './model';
import { phoneEditorBlocks } from './phoneBlocks';
import { AssetsPanel, ChecksPanel, InsertPanel, LayersPanel, PropsPanel, ThemePanel, type ComponentOps } from './panels';
import { TemplateCanvas } from './TemplateCanvas';
import { CommentPins, CommentsPanel, CopyDialog, PackDialog, PresenceChip, useComments, usePresence } from './collab';
import { SHOWN_ON } from './shownOn';
import { DishStatePanel, SlotPanel, TemplatesPanel } from './templatePanels';
import { headerPage, pagesWithLayout, templatePage } from './templateModel';

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
      className={cn('flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[12.5px] text-ink-2 hover:bg-paper-2 disabled:opacity-35', active && 'bg-pine-tint text-pine')}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

/** 顶栏上按钮的字：宽屏（1400 以上）才显示，窄一点只留图标（按钮有说明） */
const Wide = ({ children }: { children: ReactNode }) => <span className="hidden min-[1400px]:inline">{children}</span>;

/** 顶栏的「更多」：不常用的几样收在这里（点外面或按 Esc 收起） */
function MoreMenu({ items }: { items: { key: string; label: string; hint: string; icon: ReactNode; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <ToolButton title="更多：中英文案、设计包" onClick={() => setOpen((o) => !o)} active={open} testId="studio-more">
        <Ellipsis className="size-4" /> <Wide>更多</Wide>
      </ToolButton>
      {open && (
        <div className="absolute right-0 top-9 z-40 w-64 rounded-lg border border-line bg-card p-1 shadow-lg" data-testid="studio-more-menu">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-paper-2"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              data-testid={`studio-open-${it.key}`}
            >
              <span className="mt-0.5 text-ink-3">{it.icon}</span>
              <span>
                <span className="block text-[13px] text-ink">{it.label}</span>
                <span className="block text-[12px] leading-snug text-ink-3">{it.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
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
  const isEmenu = surface === 'emenu';
  const phone = def.kind === 'phone';
  // 平板菜单的画布用真实的菜单画菜单页、顶栏；手机界面的功能块画示意，不用菜单。
  // 时段（8.1.5，PP8）：画布上按现在 / 早餐 / 午餐 / 晚餐 / 全部分类看，只是预览、不改平板
  const [periodView, setPeriodView] = useState<'now' | EmenuPeriodKey | 'all'>('now');
  const menuQ = useQuery({
    queryKey: ['studio', 'menu', periodView],
    queryFn: () => api.get<EmenuMenu>(periodView === 'now' ? '/api/studio/emenu/menu' : `/api/studio/emenu/menu?period=${periodView}`),
    staleTime: 60_000,
    enabled: isEmenu,
    placeholderData: keepPreviousData,
  });
  const assetsQ = useQuery({ queryKey: ['studio', 'assets'], queryFn: () => api.get<StudioAssetView[]>('/api/studio/assets') });

  const history = useDocHistory(defaultStudioDoc(surface));
  const { doc } = history;
  const others = usePresence(surface);
  const commentsQ = useComments(surface);
  const openComments = (commentsQ.data ?? []).filter((c) => c.parentId === null && !c.resolvedAt).length;
  const [loaded, setLoaded] = useState(false);
  const rev = useRef(0);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [selection, setSelection] = useState<string[]>([]);
  const [screen, setScreen] = useState(def.screens[0]!.key);
  const [left, setLeft] = useState<'layers' | 'insert' | 'assets' | 'theme' | 'templates'>('layers');
  const [right, setRight] = useState<'props' | 'checks' | 'comments'>('props');
  // 批注（8.1.2）：在加批注（点画布上的地方）、刚点下的位置、看着的那一条
  const [commentAdding, setCommentAdding] = useState(false);
  const [commentDraftAt, setCommentDraft] = useState<{ screen: string; x: number; y: number; nodeId: string | null } | null>(null);
  // 点下的位置记着是哪一屏：换了屏就不算（回到那一屏还在）
  const commentDraft = commentDraftAt && commentDraftAt.screen === screen ? commentDraftAt : null;
  const [activeComment, setActiveComment] = useState<number | null>(null);
  const [zoom, setZoom] = useState<'fit' | (typeof ZOOMS)[number]>('fit');
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [big, setBig] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [dialog, setDialog] = useState<null | 'publish' | 'versions' | 'preview' | 'copy' | 'pack'>(null);
  // 卡片模板（8.1.2，平板菜单）：左栏「版式」打开时画布改成那种版式的一页，选中的是版式里的一块
  // 顶栏（8.1.6，QZ8）也在这里：tplLayout 为 header
  const [tplLayout, setTplLayout] = useState<EmenuLayout | typeof EMENU_HEADER_LAYOUT>('cover');
  const [tplSlot, setTplSlot] = useState<string | null>(null);
  // 菜的几种样子（变体，8.1.2）：选了一种时画布上的菜都按这种状态画，右栏改它的样子
  const [tplState, setTplState] = useState<StudioDishState | null>(null);
  const [tplPageNo, setTplPageNo] = useState(0);
  // 顶栏各块在画布上量到的框（右边「间距」用，8.1.6）
  const [headBoxes, setHeadBoxes] = useState<ReadonlyMap<string, Box> | null>(null);
  const tplMode = isEmenu && left === 'templates';
  const textRef = useRef<HTMLTextAreaElement>(null);
  const clipboard = useRef<StudioNode[]>([]);

  // 第一次取到草稿：放进编辑器（之后不再被服务端的覆盖，除非刷新）。
  // 平板菜单还要等菜单回来（取不回来也算回来了）再开：「原样 / 放大」按平板现在的设置——
  // 之前草稿先回来时菜单还没到，就一直停在「原样」，开在哪一档看两个请求谁先回来（8.1.4，PR #119 的 CI）
  useEffect(() => {
    if (!stateQ.data || loaded) return;
    if (isEmenu && menuQ.isPending) return;
    history.reset(stateQ.data.draft.doc);
    rev.current = stateQ.data.draft.rev;
    setBig(menuQ.data ? menuQ.data.rules.textSize !== 'design' : false);
    setLoaded(true);
  }, [stateQ.data, loaded, history, menuQ.data, menuQ.isPending, isEmenu]);

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

  // ── 退出（8.1.15，TC8、TC9）：回后台的「工作台」。还有没存上的改动时先存，存好马上走；存不上停下来问 ──
  // 点顶栏的「退出」、按浏览器的后退键走的是同一条路（都被下面这个拦一下）；关页面、刷新照旧由上面的 beforeunload 提醒
  const navigate = useNavigate();
  const statusNow = useRef(status);
  statusNow.current = status;
  /** 点过「不保存，直接退出」：这一次不再拦 */
  const letGo = useRef(false);
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }: { currentLocation: { pathname: string }; nextLocation: { pathname: string } }) =>
        !letGo.current && statusNow.current !== 'saved' && currentLocation.pathname !== nextLocation.pathname,
      [],
    ),
  );
  const [leaveStep, setLeaveStep] = useState<'saving' | 'failed' | null>(null);
  const saveThenLeave = useCallback(async () => {
    setLeaveStep('saving');
    // 别处改过这份版面（版本号对不上）：再存也存不进去，直接问
    const ok = statusNow.current === 'conflict' ? false : await save();
    if (ok && blocker.state === 'blocked') {
      letGo.current = true;
      blocker.proceed();
    } else if (!ok) setLeaveStep('failed');
  }, [blocker, save]);
  useEffect(() => {
    if (blocker.state === 'blocked' && leaveStep === null) void saveThenLeave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);
  const stayHere = () => {
    setLeaveStep(null);
    if (blocker.state === 'blocked') blocker.reset();
  };
  const leaveAnyway = () => {
    letGo.current = true;
    if (blocker.state === 'blocked') blocker.proceed();
    else void navigate('/admin/studio');
  };

  const change = useCallback((fn: (d: StudioDoc) => StudioDoc, coalesce?: string) => history.set(fn(latest.current), coalesce), [history]);

  // ── 选中的那一屏、检查 ──
  const assetSizes = useMemo(() => new Map((assetsQ.data ?? []).map((a) => [a.id, a.size])), [assetsQ.data]);
  const issues: StudioIssue[] = useMemo(
    () => checkStudioDoc(doc, { assets: assetsQ.data ? assetSizes : undefined, langSwitch: stateQ.data?.langSwitch ?? true }),
    [doc, assetSizes, assetsQ.data, stateQ.data?.langSwitch],
  );
  const red = issues.filter((i) => i.level === 'error').length;
  // 手机界面在工作台里画：那个界面自己的样式表不在这里，主题色、字体全写上（员工食堂的默认值也要）
  const vars = useMemo(() => themeVars(doc, phone), [doc, phone]);
  const blocks = useMemo(
    () => (isEmenu ? emenuEditorBlocks(menuQ.data ?? null, { lang, pageIndex, templates: doc.templates, dishStates: doc.dishStates }) : phoneEditorBlocks(def)),
    [isEmenu, def, menuQ.data, lang, pageIndex, doc.templates, doc.dishStates],
  );
  const flat = useMemo(() => flatPages(menuQ.data ?? null), [menuQ.data]);
  const tplPages = useMemo(() => (tplLayout === EMENU_HEADER_LAYOUT ? [] : pagesWithLayout(menuQ.data ?? null, tplLayout)), [menuQ.data, tplLayout]);
  const tplPage = useMemo(() => (tplLayout === EMENU_HEADER_LAYOUT ? headerPage(menuQ.data ?? null) : templatePage(menuQ.data ?? null, tplLayout, tplPageNo)), [menuQ.data, tplLayout, tplPageNo]);

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
  // 平板：整屏放得下；手机：按宽放（屏往下长，画布区域上下滚）
  const fit = phone ? Math.max(0.5, Math.min(1.5, (areaSize.w - 48) / def.size.w)) : Math.max(0.2, Math.min((areaSize.w - 48) / def.size.w, (areaSize.h - 48) / def.size.h));
  const scale = zoom === 'fit' ? fit : zoom;

  // ── 操作 ──
  /**
   * 插入：选中了一个框时插到框里（功能块除外，它们只能放在屏上）；放进自动排列的（屏或框）时大小跟着排
   * （文字、框宽撑满、高跟内容……），自由摆放的框里放在框的中间。
   */
  const insert = useCallback(
    (node: StudioNode) => {
      const d0 = latest.current;
      const sel = selection.length === 1 ? findNode(d0, screen, selection[0]!) : null;
      let into = sel && sel.node.type === 'frame' && node.type !== 'block' ? sel.node : null;
      // 改组件时：只能加在组件这个框里（没选中框就加在最外面那个框里）；组件不是框的加不了
      if (isComponentScreen(screen) && !into) {
        const master = screenOf(d0, screen).nodes[0];
        if (!master || master.type !== 'frame' || node.type === 'block') {
          toast({ tone: 'info', title: '这个组件不是框，里面加不了东西', body: '要加的话：回到屏上把它拆开，放进一个框里，再存成组件。' });
          return;
        }
        into = master;
      }
      const sc = screenOf(d0, screen);
      const flow = into ? (into.layout && isFlow(into.layout) ? into.layout : null) : sc.layout && isFlow(sc.layout) ? sc.layout : null;
      let n = sizeForFlow(node, flow, def);
      if (into && !flow) n = { ...n, x: round1(Math.max(0, (into.w - n.w) / 2)), y: round1(Math.max(0, (into.h - n.h) / 2)) } as StudioNode;
      change((d) => insertNode(d, screen, n, undefined, into?.id));
      setSelection([n.id]);
      setLeft('layers');
      setRight('props');
    },
    [change, screen, selection, def, toast],
  );
  const deleteSelection = useCallback(() => {
    const removable = selection.filter((id) => {
      const f = findNode(latest.current, screen, id);
      // 改组件时最外面那一块就是组件本身：删组件到「插入 → 组件」里删
      if (f && isComponentScreen(screen) && !f.parent) return false;
      return f && !(f.node.type === 'block' && def.blocks[f.node.block]?.required);
    });
    if (removable.length < selection.length)
      toast({ tone: 'info', title: isComponentScreen(screen) ? '组件本身不能在这里删（到「插入 → 组件」里删没人用的）' : '必需的功能块不能删（可以挪、改样子）' });
    if (!removable.length) return;
    change((d) => removeNodes(d, screen, removable));
    setSelection([]);
  }, [selection, screen, change, def.blocks, toast]);
  const nudge = useCallback(
    (dx: number, dy: number) => {
      // 自动排列里的一块：方向键换先后（← ↑ 往前排，→ ↓ 往后排）
      if (selection.length === 1) {
        const f = findNode(latest.current, screen, selection[0]!);
        if (f?.flow) {
          if (dx < 0 || dy < 0) change((d) => moveLayer(d, screen, f.node.id, 'down'));
          else if (dx > 0 || dy > 0) change((d) => moveLayer(d, screen, f.node.id, 'up'));
          return;
        }
      }
      const patches: Record<string, Partial<StudioNode>> = {};
      for (const id of selection) {
        const f = findNode(latest.current, screen, id);
        if (f && geometryRules(f.node, def, f.flow).move) patches[id] = { x: round1(f.node.x + dx), y: round1(f.node.y + dy) };
      }
      if (Object.keys(patches).length) change((d) => updateNodes(d, screen, patches), `nudge.${selection.join(',')}`);
    },
    [selection, screen, change, def],
  );

  /** 卡片模板里选中的一块：方向键挪（放大一档里往上长的文字挪的是下沿） */
  const nudgeSlot = useCallback(
    (dx: number, dy: number) => {
      const def = tplSlot ? EMENU_ALL_TEMPLATES[tplLayout]?.slots.find((x) => x.key === tplSlot) : undefined;
      if (!def) return;
      const s = resolveSlot(def, latest.current.templates?.[tplLayout]?.[def.key]);
      if (s.hidden) return;
      const mode = big ? 'big' : 'design';
      const p = slotSpot(s, mode);
      const next = p.bottom !== undefined ? { x: round1(p.x + dx), bottom: round1(p.bottom + dy) } : { x: round1(p.x + dx), y: round1(p.y + dy) };
      change((d) => setSlotSpot(d, tplLayout, def.key, mode, next), `nudge.slot.${tplLayout}.${def.key}.${mode}`);
    },
    [tplSlot, tplLayout, big, change],
  );
  // ── 组件（8.1.2）：存成组件、打开组件那一屏改、拆开、改完回到原来那一屏 ──
  const backTo = useRef(def.screens[0]!.key);
  /** 画布上量到的各块（存成组件时用量到的大小） */
  const measuredRef = useRef<ReadonlyMap<string, { x: number; y: number; w: number; h: number }>>(new Map());
  const componentOps: ComponentOps = useMemo(
    () => ({
      make: (id) => {
        const r = makeComponentFrom(latest.current, screen, id, def, measuredRef.current.get(id));
        if (!r) {
          toast({ tone: 'info', title: '这一块存不成组件', body: '功能块、已经是组件的、里面有功能块的不能存。' });
          return;
        }
        history.set(r.doc);
        setSelection([id]);
        toast({ tone: 'success', title: `已存成组件「${r.doc.components![r.cid]!.name}」`, body: '「插入 → 组件」里可以再放几个；改组件时各处一起变。' });
      },
      edit: (cid) => {
        if (!isComponentScreen(screen)) backTo.current = screen;
        setLeft('layers');
        setScreen(componentScreen(cid));
        setSelection([]);
        setRight('props');
      },
      detach: (id) => {
        change((d) => detachInstance(d, screen, id));
        setSelection([id]);
      },
      finish: () => {
        setScreen(backTo.current);
        setSelection([]);
      },
      remove: (cid) => change((d) => deleteComponent(d, cid)),
    }),
    [screen, def, history, change, toast],
  );
  // 改着的组件没了（撤销了「存成组件」、删掉了）：回到原来那一屏
  useEffect(() => {
    const cid = componentIdOf(screen);
    if (cid && !doc.components?.[cid]) {
      setScreen(backTo.current);
      setSelection([]);
    }
  }, [doc, screen]);

  const openTemplates = useCallback((layout?: typeof EMENU_HEADER_LAYOUT) => {
    setLeft('templates');
    setScreen('menu');
    setSelection([]);
    setRight('props');
    if (layout) {
      setTplLayout(layout);
      setTplSlot(null);
      setTplState(null);
    }
  }, []);

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
      } else if (tplMode) {
        // 改卡片模板时：方向键挪选中的一块，Esc 取消选中；别的快捷键（插入、复制、删除）不管
        if (e.key.startsWith('Arrow') && tplSlot) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          nudgeSlot(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
        } else if (e.key === 'Escape') setTplSlot(null);
      } else if (mod && e.altKey && e.code === 'KeyK') {
        // 存成组件（照 Figma）
        e.preventDefault();
        if (selection.length === 1) componentOps.make(selection[0]!);
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
        const t = def.tokens;
        if (k === 't') insert(makeText(cx - 160, cy - 20, undefined, t, phone ? 16 : 24));
        else if (k === 'r') insert(makeRect(cx - 100, cy - 60, t));
        else if (k === 'o') insert(makeEllipse(cx - 60, cy - 60, t));
        else if (k === 'f') insert(makeFrame(cx - 160, cy - 100, t, phone ? 'column' : undefined));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, history, save, selection, screen, def, phone, deleteSelection, nudge, insert, tplMode, tplSlot, nudgeSlot, componentOps]);

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
      {leaveStep && (
        <Dialog
          open
          dismissible={leaveStep === 'failed'}
          onClose={stayHere}
          title={leaveStep === 'saving' ? '正在保存草稿…' : '最近的改动没存上'}
          description={
            leaveStep === 'saving'
              ? '存好就退出，不用再点'
              : status === 'conflict'
                ? '别处（另一个窗口或另一位同事）改过这份版面，你这边最近的几步存不进去。'
                : '可能是网络不通。现在退出，最近这几步改动会丢；之前存好的草稿不受影响。'
          }
          width="max-w-md"
          footer={
            leaveStep === 'failed' ? (
              <>
                <Button variant="ghost" onClick={leaveAnyway} data-testid="studio-exit-discard">
                  不保存，直接退出
                </Button>
                {status !== 'conflict' && (
                  <Button variant="secondary" onClick={() => void saveThenLeave()} data-testid="studio-exit-retry">
                    再存一次
                  </Button>
                )}
                <Button variant="primary" onClick={stayHere} data-testid="studio-exit-stay">
                  继续编辑
                </Button>
              </>
            ) : undefined
          }
        >
          <div className="text-[13px] text-ink-2" data-testid="studio-exit-dialog" data-step={leaveStep}>
            {leaveStep === 'saving' ? (
              <div className="flex items-center gap-2.5">
                <span className="size-4 animate-spin rounded-full border-2 border-pine border-t-transparent" aria-hidden />
                工作台每改一步都会自动存草稿，这是最后一次。
              </div>
            ) : (
              <p>选「继续编辑」留在这里：可以等网络好了再点「退出」，或者把要紧的改动记下来。</p>
            )}
          </div>
        </Dialog>
      )}
      {/* 顶栏 */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-card px-2">
        {/* 退出（8.1.15，TC8）：最左边固定一个带字、有边框的键，与右边的工具按钮分开；原来只有一个没有字的小箭头 */}
        <button
          type="button"
          onClick={() => void navigate('/admin/studio')}
          className="group mr-1 flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-paper px-3 text-[12.5px] font-semibold text-ink-2 transition-colors hover:border-clay hover:bg-clay-soft hover:text-clay"
          title="退出工作台，回后台的「工作台」（草稿会先存好）"
          data-testid="studio-exit"
        >
          <LogOut className="size-4 -scale-x-100 transition-transform group-hover:-translate-x-0.5" />
          退出
        </button>
        <span className="mr-1 h-5 w-px shrink-0 bg-line" aria-hidden />
        {/* 顶栏在窄一点的屏幕上（不到 1400 宽）只留图标与要紧的字，鼠标停上去有说明 */}
        <div className="mr-2 shrink-0 whitespace-nowrap text-[13.5px] font-bold">
          <span className="hidden min-[1400px]:inline">工作台 </span>
          <span className="font-normal text-ink-3">
            <span className="hidden min-[1400px]:inline">· </span>
            {def.label}
          </span>
        </div>
        <div className="flex shrink-0 rounded-md border border-line p-0.5" data-testid="studio-screens">
          {def.screens.map((s) => (
            <button
              key={s.key}
              type="button"
              className={cn('h-7 whitespace-nowrap rounded px-2.5 text-[12.5px]', screen === s.key ? 'bg-pine text-white' : 'text-ink-2 hover:bg-paper-2')}
              onClick={() => {
                setScreen(s.key);
                setSelection([]);
                if (tplMode) setLeft('layers');
              }}
              data-testid={`studio-screen-${s.key}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {isComponentScreen(screen) && (
          <div className="ml-1 flex h-8 items-center gap-1.5 rounded-md bg-[#7b61ff]/10 px-2 text-[12.5px] text-[#5b45d6]" data-testid="studio-component-bar">
            ◆ 改组件「{doc.components?.[componentIdOf(screen)!]?.name ?? ''}」
            <button type="button" className="rounded bg-[#5b45d6] px-2 py-0.5 text-[12px] text-white" onClick={componentOps.finish} data-testid="studio-component-finish">
              改好了
            </button>
          </div>
        )}
        {isEmenu && (tplMode || screen === 'menu') && menuQ.data && (
          <select
            className="ml-1 h-8 max-w-40 rounded-md border border-line bg-card px-1.5 text-[12px]"
            value={periodView}
            onChange={(e) => {
              setPeriodView(e.target.value as typeof periodView);
              setPageIndex(0);
              setTplPageNo(0);
            }}
            title="画布上按哪个时段看菜单（只是预览，不改平板；按某一段看时分类另外限定的时间不算）"
            data-testid="studio-period"
          >
            <option value="now">时段：现在</option>
            {menuQ.data.rules.periods.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} {formatWindow(periodWindow(menuQ.data!.rules.periods, p.key))}
              </option>
            ))}
            <option value="all">全部分类</option>
          </select>
        )}
        {tplMode ? (
          <select
            className="ml-1 h-8 max-w-52 rounded-md border border-line bg-card px-1.5 text-[12px]"
            value={tplPage.real ? tplPageNo : -1}
            onChange={(e) => setTplPageNo(Number(e.target.value))}
            title={tplPage.filled && tplPage.real ? `这一页空着的 ${tplPage.filled} 个位置补上了示例菜（只在工作台里）` : '画布上用哪一页看（只是预览）'}
            data-testid="studio-template-page"
          >
            {tplPages.map((f, i) => (
              <option key={i} value={i}>
                {f.category.name} · 第 {f.pageNo + 1} 页
              </option>
            ))}
            <option value={-1}>示例菜（整页）</option>
          </select>
        ) : (
          screen === 'menu' &&
          flat.length > 0 && (
            <select
              className="ml-1 h-8 max-w-44 rounded-md border border-line bg-card px-1.5 text-[12px]"
              value={pageIndex}
              onChange={(e) => setPageIndex(Number(e.target.value))}
              title="画布上显示哪一页菜单（只是预览）"
            >
              {flat.map((f, i) => (
                <option key={i} value={i}>
                  {f.category.name} · 第 {f.pageNo + 1} 页
                </option>
              ))}
            </select>
          )
        )}
        <div className="mx-1 h-5 w-px bg-line" />
        <ToolButton title="看中文 / 英文的样子" onClick={() => setLang((l) => (l === 'zh' ? 'en' : 'zh'))} testId="studio-lang">
          {lang === 'zh' ? '中' : 'EN'}
        </ToolButton>
        {isEmenu && (
          <ToolButton title="字与按钮：设计稿原样 / 放大（平板上按后台「电子菜单 → 设置」）" onClick={() => setBig((b) => !b)} active={big} testId="studio-text-size">
            {big ? '放大' : '原样'}
          </ToolButton>
        )}
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
        <span
          className={cn('mr-2 shrink-0 whitespace-nowrap text-[12px]', status === 'error' || status === 'conflict' ? 'text-clay' : 'text-ink-3')}
          data-testid="studio-save-status"
          data-status={status}
        >
          {statusText[status]}
        </span>
        {status === 'error' && (
          <Button size="sm" variant="secondary" onClick={() => void save()}>
            再存一次
          </Button>
        )}
        <PresenceChip others={others} />
        {(stateQ.data?.scheduled ?? []).slice(0, 1).map((v) => {
          const at = new Date(v.effectiveAt!).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return (
            <button
              key={v.id}
              type="button"
              className="mr-2 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-pine-tint px-2 py-0.5 text-[12px] text-pine"
              title={`第 ${v.version} 版定在 ${at} 生效（点开「版本」可以撤销）`}
              onClick={() => setDialog('versions')}
              data-testid="studio-scheduled"
            >
              <Clock className="size-3" /> {at} 换版
            </button>
          );
        })}
        <ToolButton title="批注：在画布上留言，设计师和店主来回说" onClick={() => setRight('comments')} active={right === 'comments'} testId="studio-open-comments">
          <MessageSquare className="size-4" /> <Wide>批注</Wide>
          {openComments > 0 && <span className="rounded-full bg-clay px-1.5 text-[12px] font-bold leading-4 text-white">{openComments}</span>}
        </ToolButton>
        <ToolButton title="检查" onClick={() => setRight('checks')} active={right === 'checks'} testId="studio-open-checks">
          {red ? <TriangleAlert className="size-4 text-clay" /> : <CheckCircle2 className="size-4 text-pine" />}
          <Wide>检查</Wide>
          {issues.length ? <span className="tabular-nums">（{issues.length}）</span> : null}
        </ToolButton>
        <ToolButton title={phone ? '在手机大小的页面上点一点' : '像客人一样点一点；也可以在真平板上扫码看'} onClick={() => setDialog('preview')} testId="studio-open-preview">
          <Eye className="size-4" /> <Wide>预览</Wide>
        </ToolButton>
        <ToolButton title="已发布的各版，可以回到任何一版" onClick={() => setDialog('versions')} testId="studio-open-versions">
          <History className="size-4" /> <Wide>版本</Wide>
        </ToolButton>
        <MoreMenu
          items={[
            { key: 'copy', label: '中英文案', hint: '所有的字列成一张表，中英对着改；可以导出给人翻译', icon: <Languages className="size-4" />, onClick: () => setDialog('copy') },
            { key: 'pack', label: '设计包', hint: '版面连同用到的图存成一个文件，换个地方导进来', icon: <Package className="size-4" />, onClick: () => setDialog('pack') },
          ]}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!canPublish}
          onClick={() => setDialog('publish')}
          data-testid="studio-open-publish"
          title={canPublish ? undefined : '这个账号没有「工作台：发布」'}
        >
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
          <div className={cn('grid border-b border-line text-[12.5px]', isEmenu ? 'grid-cols-5' : 'grid-cols-4')}>
            {(
              [
                ['layers', '图层'],
                ['insert', '插入'],
                ['assets', '素材'],
                ['theme', '主题'],
                // 卡片模板只有平板菜单有（菜单页的 11 种版式）
                ...(isEmenu ? ([['templates', '版式']] as const) : []),
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={cn('h-9 border-b-2', left === k ? 'border-pine font-medium text-pine' : 'border-transparent text-ink-3 hover:text-ink')}
                onClick={() => (k === 'templates' ? openTemplates() : setLeft(k))}
                data-testid={`studio-tab-${k}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {left === 'layers' && <LayersPanel doc={doc} screen={screen} surface={def} selection={selection} onSelect={setSelection} onChange={change} />}
            {left === 'insert' && <InsertPanel doc={doc} screen={screen} surface={def} onInsert={insert} components={componentOps} />}
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
            {tplMode && (
              <TemplatesPanel
                doc={doc}
                menu={menuQ.data ?? null}
                layout={tplLayout}
                onLayout={(l) => {
                  setTplLayout(l);
                  setTplPageNo(0);
                }}
                slot={tplSlot}
                onSlot={(k) => {
                  setTplSlot(k);
                  setRight('props');
                }}
                state={tplState}
                onState={(k) => {
                  setTplState(k);
                  setRight('props');
                }}
                onChange={change}
              />
            )}
          </div>
        </aside>

        {/* 画布 */}
        <main
          ref={area}
          className={cn('flex min-w-0 flex-1 justify-center overflow-auto p-6', phone ? 'items-start' : 'items-center')}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            setSelection([]);
            setTplSlot(null);
          }}
        >
          {tplMode ? (
            <TemplateCanvas
              doc={doc}
              surface={def}
              layout={tplLayout}
              page={tplPage.page}
              categoryName={tplPage.categoryName}
              categoryNameEn={tplPage.categoryNameEn}
              selected={tplSlot}
              onSelect={(k) => {
                setTplSlot(k);
                if (k) {
                  setTplState(null);
                  setRight('props');
                }
              }}
              previewState={tplState}
              langOn={menuQ.data?.rules.langSwitch !== false}
              onHeadBoxes={(b) => setHeadBoxes((cur) => (cur && sameHeadBoxes(cur, b) ? cur : new Map(b)))}
              scale={scale}
              lang={lang}
              big={big}
              vars={vars}
              blocks={blocks}
              onLive={history.live}
              onCommit={history.commit}
            />
          ) : (
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
              onMeasure={(m) => (measuredRef.current = m)}
              overlay={
                <CommentPins
                  comments={commentsQ.data ?? []}
                  screen={screen}
                  scale={scale}
                  adding={commentAdding && right === 'comments'}
                  draft={commentDraft}
                  active={activeComment}
                  onPlace={(p) => {
                    setCommentDraft({ ...p, screen });
                    setCommentAdding(false);
                  }}
                  onPick={(id) => {
                    setActiveComment(id);
                    setRight('comments');
                  }}
                />
              }
            />
          )}
        </main>

        {/* 右栏 */}
        <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-card">
          <div className="grid grid-cols-3 border-b border-line text-[12.5px]">
            <button type="button" className={cn('h-9 border-b-2', right === 'props' ? 'border-pine font-medium text-pine' : 'border-transparent text-ink-3')} onClick={() => setRight('props')}>
              属性
            </button>
            <button type="button" className={cn('h-9 border-b-2', right === 'checks' ? 'border-pine font-medium text-pine' : 'border-transparent text-ink-3')} onClick={() => setRight('checks')}>
              检查{red ? <span className="ml-1 rounded-full bg-clay px-1.5 text-[12px] text-white">{red}</span> : null}
            </button>
            <button
              type="button"
              className={cn('h-9 border-b-2', right === 'comments' ? 'border-pine font-medium text-pine' : 'border-transparent text-ink-3')}
              onClick={() => setRight('comments')}
              data-testid="studio-tab-comments"
            >
              批注{openComments ? <span className="ml-1 rounded-full bg-clay px-1.5 text-[12px] text-white">{openComments}</span> : null}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {right === 'props' ? (
              tplMode ? (
                tplState ? (
                  <DishStatePanel doc={doc} state={tplState} onChange={change} />
                ) : (
                  <SlotPanel
                    doc={doc}
                    layout={tplLayout}
                    slot={tplSlot}
                    big={big}
                    onToggleBig={() => setBig((b) => !b)}
                    onChange={change}
                    headBoxes={tplLayout === EMENU_HEADER_LAYOUT ? headBoxes : null}
                  />
                )
              ) : (
                <PropsPanel
                  doc={doc}
                  screen={screen}
                  surface={def}
                  selection={selection}
                  onChange={change}
                  onDelete={deleteSelection}
                  onLayer={(dir) => selection[0] && change((d) => moveLayer(d, screen, selection[0]!, dir))}
                  textRef={textRef}
                  onOpenTemplates={isEmenu ? openTemplates : undefined}
                  components={componentOps}
                />
              )
            ) : right === 'comments' ? (
              <CommentsPanel
                surface={surface}
                screen={screen}
                screenLabel={(k) => screenLabel(surface, k)}
                adding={commentAdding}
                onAdding={(on) => {
                  // 批注留在屏上：「版式」看的是卡片模板，先回到普通的画布
                  if (on && tplMode) setLeft('layers');
                  setCommentAdding(on);
                  if (on) setCommentDraft(null);
                }}
                draft={commentDraft}
                onDraftDone={() => setCommentDraft(null)}
                active={activeComment}
                onActive={(id) => {
                  if (id !== null && tplMode) setLeft('layers');
                  setActiveComment(id);
                }}
                onGoScreen={(sc) => {
                  if (tplMode) setLeft('layers');
                  setScreen(sc);
                  setSelection([]);
                }}
              />
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
            const later = v.effectiveAt && new Date(v.effectiveAt).getTime() > Date.now();
            toast({
              tone: 'success',
              title: later
                ? `第 ${v.version} 版定在 ${new Date(v.effectiveAt!).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 生效`
                : `已发布第 ${v.version} 版`,
              body: later ? '到点以前在「版本」里可以撤销定时；到点以后照常' + SHOWN_ON[surface].when + '。' : `${SHOWN_ON[surface].when}；改坏了在「版本」里回到上一版。`,
            });
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
            toast({ tone: 'success', title: '已把这一版放进草稿', body: `可以接着改；发布以后${SHOWN_ON[surface].where}才换。` });
          }}
        />
      )}
      {dialog === 'preview' && <PreviewDialog surface={surface} doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'copy' && <CopyDialog doc={doc} onChange={change} onClose={() => setDialog(null)} />}
      {dialog === 'pack' && (
        <PackDialog
          surface={surface}
          flush={save}
          onImported={(d) => {
            history.set(d);
            setSelection([]);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
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
  // 定时发布（8.1.2，GZ27）：现在生效，或定在以后某个时候（这台电脑的时间）
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const red = issues.filter((i) => i.level === 'error');
  const yellow = issues.filter((i) => i.level === 'warn');
  const go = async () => {
    if (!note.trim()) {
      toast({ tone: 'error', title: '写一句改了什么（版本列表里看得到）' });
      return;
    }
    const effectiveAt = when === 'later' && at ? new Date(at).toISOString() : null;
    if (when === 'later' && !effectiveAt) {
      toast({ tone: 'error', title: '选一个生效的时间' });
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
      const v = await sendErpOp<StudioVersionView>({
        key,
        type: 'studio_publish',
        url: `/api/studio/${surface}/publish`,
        body: { clientKey: key, rev: revOf(), note: note.trim(), ...(effectiveAt ? { effectiveAt } : {}) },
        summary: `${effectiveAt ? '定时发布' : '发布'}：${note.trim()}`.slice(0, 200),
        staffName,
      });
      onDone(v);
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'info', title: '发布的结果没有收到', body: '顶上的「结果待确认」里可以查回、按原内容重新提交或作废；不要另发一次。' });
      else toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="发布"
      description={
        published
          ? `${SHOWN_ON[surface].where}现在用的是第 ${published.version} 版（${published.publishedBy} ${new Date(published.publishedAt).toLocaleString('zh-CN')}）`
          : `${SHOWN_ON[surface].where}现在用的是内置的默认版面（还没发布过）`
      }
      onClose={onClose}
    >
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
          <Textarea
            className="mt-1"
            rows={2}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：起始页加了冬季海报、强调色换深一点"
            data-testid="studio-publish-note"
          />
        </label>
        <div className="space-y-1.5 text-[12.5px] text-ink-2">
          <div>什么时候生效</div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} data-testid="studio-publish-now" /> 现在
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} data-testid="studio-publish-later" /> 定时
            </label>
            {when === 'later' && (
              <input
                type="datetime-local"
                className="h-8 rounded-md border border-line bg-card px-2 text-[12.5px]"
                value={at}
                onChange={(e) => setAt(e.target.value)}
                data-testid="studio-publish-at"
              />
            )}
          </div>
          {when === 'later' && <p className="text-[12px] text-ink-3">到点才换（最早 2 分钟以后、最晚 60 天以内）；没到点之前在「版本」里能撤。到点前又发了一版也照样到点换成这一版。</p>}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-3">发布以后{SHOWN_ON[surface].when}；改坏了在「版本」里一键回到上一版。发布记在操作审计里。</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            再看看
          </Button>
          <Button variant="primary" loading={busy} disabled={red.length > 0} onClick={() => void go()} data-testid="studio-publish-go">
            {when === 'later' ? '定时发布' : '发布'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────── 版本 ─────────────────────────

function VersionsDialog({
  surface,
  canPublish,
  staffName,
  onClose,
  onUseAsDraft,
}: {
  surface: StudioSurface;
  canPublish: boolean;
  staffName: string;
  onClose: () => void;
  onUseAsDraft: (doc: StudioDoc) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['studio', 'versions', surface], queryFn: () => api.get<StudioVersionView[]>(`/api/studio/${surface}/versions`) });
  const [busy, setBusy] = useState<number | null>(null);
  // 还没生效（定时的）或撤销了的一版从没用过：按钮叫「现在就用这一版」
  const neverLive = (v: StudioVersionView) => !!v.cancelledAt || (!!v.effectiveAt && new Date(v.effectiveAt).getTime() > Date.now());
  const rollback = async (v: StudioVersionView) => {
    const ask = neverLive(v)
      ? `现在就用第 ${v.version} 版？会照它马上再发一版（历史都留着）${v.cancelledAt ? '' : '；原来定的时间到了也照样换成它，不想要就再撤销定时'}。`
      : `回到第 ${v.version} 版？会照第 ${v.version} 版再发一版（历史都留着）：${SHOWN_ON[surface].when}。`;
    if (!window.confirm(ask)) return;
    setBusy(v.version);
    try {
      const key = uuid();
      const r = await sendErpOp<StudioVersionView>({
        key,
        type: 'studio_publish',
        url: `/api/studio/${surface}/rollback`,
        body: { clientKey: key, version: v.version, note: '' },
        summary: `回到第 ${v.version} 版`,
        staffName,
      });
      toast({ tone: 'success', title: neverLive(v) ? `照第 ${v.version} 版发成了第 ${r.version} 版，现在就用` : `已回到第 ${v.version} 版（发成第 ${r.version} 版）` });
      void qc.invalidateQueries({ queryKey: ['studio'] });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const cancel = async (v: StudioVersionView) => {
    if (!window.confirm(`撤销第 ${v.version} 版的定时发布？撤了以后这一版不会生效（记录留着）。`)) return;
    try {
      await api.post(`/api/studio/${surface}/versions/${v.version}/cancel`, {});
      toast({ tone: 'success', title: `第 ${v.version} 版的定时发布撤销了` });
      void qc.invalidateQueries({ queryKey: ['studio'] });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
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
          <p className="text-[13px] text-ink-3">还没发布过：{SHOWN_ON[surface].where}用的是内置的默认版面。</p>
        ) : (
          q.data!.map((v) => (
            <div key={v.id} className={cn('rounded-md border border-line px-3 py-2', v.cancelledAt && 'opacity-60')} data-testid={`studio-version-${v.version}`}>
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-bold">第 {v.version} 版</span>
                {v.current && <span className="rounded bg-pine-tint px-1.5 text-[12px] text-pine">现在用的</span>}
                {v.effectiveAt && !v.cancelledAt && new Date(v.effectiveAt).getTime() > Date.now() && (
                  <span className="rounded bg-yuzu-soft px-1.5 text-[12px] text-yuzu-deep" data-testid={`studio-version-pending-${v.version}`}>
                    定在 {new Date(v.effectiveAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 生效
                  </span>
                )}
                {v.cancelledAt && (
                  <span className="rounded bg-paper-2 px-1.5 text-[12px] text-ink-3">
                    {v.cancelledBy} 撤销了（{new Date(v.cancelledAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）
                  </span>
                )}
                {v.kind === 'rollback' && <span className="rounded bg-paper-2 px-1.5 text-[12px] text-ink-3">回到第 {v.rollbackOf} 版</span>}
                <span className="ml-auto text-[12px] text-ink-3">
                  {v.publishedBy} · {new Date(v.publishedAt).toLocaleString('zh-CN')}
                </span>
              </div>
              <div className="mt-0.5 text-[12.5px] text-ink-2">{v.note}</div>
              <div className="mt-0.5 text-[12px] text-ink-3">改了：{v.screensChanged.map((s) => screenLabel(surface, s)).join('、') || '—'}</div>
              <div className="mt-1.5 flex gap-2">
                {!v.current && canPublish && (
                  <Button size="sm" variant="secondary" loading={busy === v.version} onClick={() => void rollback(v)} data-testid={`studio-rollback-${v.version}`}>
                    {neverLive(v) ? '现在就用这一版' : '回到这一版'}
                  </Button>
                )}
                {v.effectiveAt && !v.cancelledAt && new Date(v.effectiveAt).getTime() > Date.now() + 60_000 && canPublish && (
                  <Button size="sm" variant="ghost" onClick={() => void cancel(v)} data-testid={`studio-cancel-${v.version}`}>
                    撤销定时
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
  const phone = STUDIO_SURFACE_DEFS[surface].kind === 'phone';
  // 平板菜单：点餐平板打开 /emenu?studio=<码>；手机界面：在手机大小的预览页上看（登录着工作台的账号）
  const url = code ? (phone ? `${window.location.origin}/studio-preview/${surface}/${code.code}` : `${window.location.origin}/emenu?studio=${code.code}`) : '';
  return (
    <Dialog
      open
      title="预览（现在的草稿）"
      description={phone ? '在手机大小的页面上点一点：按钮、入口点了会写出「会打开哪一页」，不真的跳' : '像客人一样点一点：翻分类、加菜、开订单；预览里不能下单'}
      onClose={onClose}
    >
      <div className="space-y-3" data-testid="studio-preview">
        {!code ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="flex gap-4">
            <QrCode text={url} className="size-36 shrink-0 rounded border border-line" />
            <div className="min-w-0 space-y-2 text-[12.5px] text-ink-2">
              <p>
                预览码{' '}
                <span className="font-mono text-[15px] font-bold tracking-wider text-ink" data-testid="studio-preview-code">
                  {code.code}
                </span>
                ，{new Date(code.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效（30 分钟）。
              </p>
              {surface === 'canteen' ? (
                <>
                  <p>
                    在这台电脑上看示意：扫左边的码或打开 <span className="break-all font-mono text-[12px]">{url}</span>（各段画的是示意）。
                  </p>
                  <p data-testid="studio-preview-canteen">
                    在员工手机上看真实的样子：用员工账号登录柚子饭堂，在它的地址后面加 <span className="font-mono text-[12px] font-bold text-ink">?studio={code.code}</span>
                    （比如 <span className="font-mono text-[12px]">http://柚子饭堂的地址/?studio={code.code}</span>），首页、饭卡码页就是这份草稿的样子；不存进手机，关掉再开回到发布的那一版。
                  </p>
                </>
              ) : phone ? (
                <p>
                  在手机上看：手机浏览器登录着工作台的账号，扫左边的码，或打开 <span className="break-all font-mono text-[12px]">{url}</span>。小程序里的样子以小程序线照这份版面画的为准。
                </p>
              ) : (
                <p>
                  在真平板上看：平板登录着「点餐平板」账号，扫左边的码，或打开 <span className="break-all font-mono text-[12px]">{url}</span>
                </p>
              )}
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
        <p className="text-[12px] text-ink-3">预览用的是生成那一刻的草稿；之后又改了，点「照现在的改动重新生成」。</p>
      </div>
    </Dialog>
  );
}

/** 两份量到的顶栏框一样（差不到 0.05 像素）就不换，免得右边「间距」白白重画 */
function sameHeadBoxes(a: ReadonlyMap<string, Box>, b: ReadonlyMap<string, Box>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || Math.abs(w.x - v.x) > 0.05 || Math.abs(w.y - v.y) > 0.05 || Math.abs(w.w - v.w) > 0.05 || Math.abs(w.h - v.h) > 0.05) return false;
  }
  return true;
}
