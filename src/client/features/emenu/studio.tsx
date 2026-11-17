// 平板电子菜单的版面（UI 工作台，8.1.1，docs/WORKBENCH_V811.md 第 4、7 节）：用哪一份版面，以及各功能块怎么画。
//
// 用哪一份：预览码（/emenu?studio=<码>，工作台「在平板上看」）> 这家店已发布的最新一版 > 代码里内置的默认版面（= 现在的样子）。
// 换版不打断客人：第一次取到就用；之后有新的一版，只在停在起始页（或空闲回到起始页）时才换（GZ6）。取不到、校验不过就接着用手上那一份。
//
// 功能块的画法平板与编辑器共用（编辑器的画布里画的就是这些组件，所见即所得）：每一块画在块的左上角，块的位置大小外面已经摆好。
// 默认版面里每一块的位置都是现在页面上的那个数，这里的画法与改造前逐处一致（浏览器用例逐屏截图比对）。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { colorValue, defaultStudioDoc, DocSchema, EMENU_SURFACE, themeVars, upgradeStudioDoc, type StudioBlockNode, type StudioDoc } from '@shared/studio';
import type { EmenuMenu } from '@shared/emenu';
import { api } from '../../lib/api';
import { blockScale } from '../../studio-render/StudioNodes';
import { LANG_ICON, LangToggle } from './header';
import type { Lang } from './i18n';
import { LogoRow, LogoStacked } from './logo';
import { BIG, box, STAGE_H, STAGE_W, useBig, useBleed } from './stage';

export const studioAssetUrl = (id: string) => `/api/studio/assets/${id}`;

/** 读到的版面：升到现在的格式、按格式核对；不合格的不用 */
export function parseEmenuDoc(raw: unknown): StudioDoc | null {
  try {
    const r = DocSchema.safeParse(upgradeStudioDoc(raw));
    return r.success && r.data.surface === 'emenu' ? r.data : null;
  } catch {
    return null;
  }
}

const DEFAULT_DOC = defaultStudioDoc('emenu');

export interface EmenuLayout {
  doc: StudioDoc;
  /** 主题改过的 CSS 变量（默认版面是空的） */
  vars: Record<string, string>;
  /** 用的是已发布的第几版（默认版面、预览为空） */
  version: number | null;
  /** 预览码打开的草稿：不能下单 */
  preview: { code: string; expiresAt: string } | null;
  previewError: string | null;
}

/** 平板现在用哪一份版面。canSwap：现在能不能换成新的一版（停在起始页、没有弹窗） */
export function useEmenuLayout(menu: EmenuMenu | null, canSwap: boolean): EmenuLayout {
  const code = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('studio')?.trim().toUpperCase() || null;
    } catch {
      return null;
    }
  }, []);
  const previewQ = useQuery({
    queryKey: ['studio', 'preview', code],
    queryFn: () => api.get<{ doc: unknown; expiresAt: string }>(`/api/studio/preview/${code}`),
    enabled: !!code,
    retry: false,
    staleTime: Infinity,
  });
  const ref = code ? null : (menu?.studio ?? null);
  const docQ = useQuery({
    queryKey: ['studio', 'doc', ref?.id ?? 0],
    queryFn: () => api.get<{ id: number; version: number; doc: unknown }>(`/api/studio/docs/${ref!.id}`),
    enabled: !!ref,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const [active, setActive] = useState<{ id: number; version: number; doc: StudioDoc } | null>(null);
  const fetched = docQ.data && ref && docQ.data.id === ref.id ? docQ.data : null;
  useEffect(() => {
    if (code) return;
    if (menu && !menu.studio) {
      // 菜单里说现在没有发布过的版面（换了门店之类）：能换的时候回到默认版面
      if (active && canSwap) setActive(null);
      return;
    }
    if (!fetched || fetched.id === active?.id) return;
    // 客人点菜中途不换：等回到起始页
    if (active && !canSwap) return;
    const doc = parseEmenuDoc(fetched.doc);
    if (doc) setActive({ id: fetched.id, version: fetched.version, doc });
  }, [code, menu, fetched, active, canSwap]);
  const previewDoc = useMemo(() => (previewQ.data ? parseEmenuDoc(previewQ.data.doc) : null), [previewQ.data]);
  const doc = previewDoc ?? active?.doc ?? DEFAULT_DOC;
  const vars = useMemo(() => themeVars(doc), [doc]);
  return {
    doc,
    vars,
    version: previewDoc ? null : (active?.version ?? null),
    preview: code && previewDoc && previewQ.data ? { code, expiresAt: previewQ.data.expiresAt } : null,
    previewError: code && previewQ.isError ? '预览码不对或已经过期（30 分钟有效）：在工作台里重新生成' : null,
  };
}

/** 功能块的颜色：auto 用给的「自动」那个颜色（起始页有大图时浅色、没图时深棕） */
export function blockColor(value: unknown, auto: string): string {
  return typeof value === 'string' && value !== 'auto' ? (colorValue(value, EMENU_SURFACE.cssVar) ?? auto) : auto;
}
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// ───────────────────────── 起始页的几块 ─────────────────────────

/** 氛围大图：后台传的那张铺满这一块，极慢地放大缩小（24 秒一个来回），压一层暗 */
/**
 * 起始页的氛围大图。铺满整个画布（默认的位置）时往外铺到屏幕边（8.1.6 出血，QZ2）；设计师挪小了就只画在那一块里。
 * still：输入信息的弹窗开着时停住慢慢放大缩小——弹窗后面是一层虚化，图一动虚化就得每一帧重算，大屏的平板上会卡（QZ4）。
 */
export function StartCoverBlock({ node, coverUrl, still }: { node: StudioBlockNode; coverUrl: string | null; still?: boolean }) {
  const bleed = useBleed();
  if (!coverUrl) return null;
  const dim = num(node.props.dim, 0.18);
  const full = node.x <= 0.5 && node.y <= 0.5 && node.w >= STAGE_W - 0.5 && node.h >= STAGE_H - 0.5;
  const bx = full ? bleed.x : 0;
  const by = full ? bleed.y : 0;
  const frame = { position: 'absolute' as const, left: -bx, top: -by, right: -bx, bottom: -by };
  return (
    <div style={{ ...box(0, 0, node.w, node.h) }}>
      <div style={{ ...frame, overflow: 'hidden' }}>
        <img
          src={coverUrl}
          alt=""
          draggable={false}
          className={node.props.kenburns === false ? undefined : 'em-kenburns'}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', animationPlayState: still ? 'paused' : undefined }}
        />
        {dim > 0 && <div style={{ position: 'absolute', inset: 0, background: `rgb(0 0 0 / ${dim})` }} />}
      </div>
    </div>
  );
}

/** 竖排字标（等比缩放：宽跟着块） */
export function LogoBlock({ node, tone }: { node: StudioBlockNode; tone: string }) {
  return (
    <div style={{ color: blockColor(node.props.color, tone) }}>
      <LogoStacked width={node.w} />
    </div>
  );
}

/** 横排字标 */
export function LogoRowBlock({ node, tone }: { node: StudioBlockNode; tone: string }) {
  return (
    <div style={{ color: blockColor(node.props.color, tone) }}>
      <LogoRow width={node.w} />
    </div>
  );
}

/** 有一单结果待确认时的提示（居中在块里） */
export function StartPendingBlock({ node, tone, show }: { node: StudioBlockNode; tone: string; show: boolean }) {
  const large = useBig();
  if (!show) return null;
  const size = num(node.props.size, 12);
  return (
    <div style={{ ...box(0, 0, node.w), textAlign: 'center', fontSize: large ? (size * 4) / 3 : size, color: blockColor(node.props.color, tone) }} data-testid="emenu-start-pending">
      有一单结果待确认，请服务员输入手牌后在订单里处理
    </div>
  );
}

/** 版权行：长按 3 秒退出这台平板的登录（员工用）；文字在后台「电子菜单 → 设置」里改 */
export function StartFooterBlock({ node, tone, text, onExit }: { node: StudioBlockNode; tone: string; text: string; onExit?: () => void }) {
  const large = useBig();
  const size = num(node.props.size, 12);
  const hold = useRef<number | null>(null);
  const stop = () => {
    if (hold.current) window.clearTimeout(hold.current);
    hold.current = null;
  };
  return (
    <div
      className="em-en"
      onPointerDown={
        onExit
          ? () => {
              hold.current = window.setTimeout(onExit, 3000);
            }
          : undefined
      }
      onPointerUp={onExit ? stop : undefined}
      onPointerLeave={onExit ? stop : undefined}
      style={{
        ...box(0, 0, node.w),
        textAlign: 'center',
        fontSize: size,
        lineHeight: `${size}px`,
        letterSpacing: '0.09em',
        color: blockColor(node.props.color, tone),
        transform: large ? 'scale(1.2)' : undefined,
        transformOrigin: '50% 100%',
      }}
      data-testid="emenu-footer"
    >
      {/* 设计稿：英文 12 号、夹在中间的中文（汤崎）13 号，同一条基线 */}
      {text.split(/([⺀-鿿豈-﫿]+)/).map((part, i) =>
        i % 2 ? (
          <span key={i} style={{ fontFamily: 'var(--em-zh)', fontSize: size + 1, letterSpacing: '0.5px' }}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </div>
  );
}

/**
 * 中英切换（8.1.5 换成品牌给的图标，PP6）：块还是原来「中 | EN」的 48 × 22.3（已经发布过的版面照常用），
 * 图标是块的高那么大的正方形，靠右、竖直居中；放大的一档图标再大 BIG.ui 倍，右边仍贴着块的右边
 */
export function LangBlock({ node, lang, onToggle, autoLight }: { node: StudioBlockNode; lang: Lang; onToggle: () => void; autoLight: boolean }) {
  const large = useBig();
  const tone = node.props.tone;
  const light = tone === 'light' ? true : tone === 'dark' ? false : autoLight;
  const size = LANG_ICON * blockScale(node, EMENU_SURFACE) * (large ? BIG.ui : 1);
  return <LangToggle lang={lang} onToggle={onToggle} x={node.w - size} y={(node.h - size) / 2} size={size} light={light} />;
}

/** 起始页右下角很小的版本标记（发布过的才有）：出问题时好对是哪一版 */
export function StudioVersionMark({ version, tone }: { version: number | null; tone: string }) {
  if (!version) return null;
  return (
    <div className="em-en" style={{ ...box(0, 754, 1016), textAlign: 'right', fontSize: 7, lineHeight: '7px', color: tone, opacity: 0.35, pointerEvents: 'none' }} data-testid="emenu-studio-version">
      v{version}
    </div>
  );
}

/** 预览码打开的草稿：顶上一条提示（不能下单） */
export function StudioPreviewBand({ preview, error }: { preview: EmenuLayout['preview']; error: string | null }): ReactNode {
  if (!preview && !error) return null;
  return (
    <div
      style={{
        ...box(0, 0, 1024, 22),
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        background: error ? 'var(--em-error)' : 'var(--em-tan)',
        color: 'var(--em-light)',
        fontSize: 11,
        pointerEvents: 'none',
      }}
      data-testid="emenu-studio-preview"
    >
      {error ?? `工作台预览（码 ${preview!.code}）· 这是草稿，不能下单 · ${new Date(preview!.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效`}
    </div>
  );
}
