// UI 工作台：手机界面的预览页（8.1.2，/studio-preview/:surface/:code）。按预览码取当时的草稿，按 375 宽画出来（与编辑器、样例截图同一个渲染器），
// 可以切屏、切中英；点按钮、入口时只写出「会打开哪一页」，不真的跳。设计师在电脑上打开，或手机浏览器登录着工作台的账号扫码打开。
// ?screen=<屏> 直接打开那一屏；?bare=1 只画手机这一屏（没有顶上的工具栏，给样例截图用：scripts/studio-mp-shots.mjs）。
// 小程序里的样子以小程序线照这份版面画的为准（docs/STUDIO_MP.md）；这里看的是排版、颜色、字。

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { STUDIO_SURFACE_DEFS, STUDIO_SURFACES, themeVars, type StudioAction, type StudioDoc, type StudioSurface } from '@shared/studio';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Skeleton } from '../../components/ui';
import { StudioPhoneScreen } from '../../studio-render/StudioNodes';
import { phoneEditorBlocks } from './phoneBlocks';

/** 点了做什么，写成一句话（预览里不真的跳） */
function describe(surface: StudioSurface, a: StudioAction): string {
  const def = STUDIO_SURFACE_DEFS[surface].actions.find((x) => x.key === a.action);
  if (!def) return `点了：${a.action}`;
  const arg = def.args?.find((o) => o.value === a.arg)?.label;
  return arg ? `点了：${def.label} →「${arg}」` : `点了：${def.label}`;
}

export function PhonePreviewPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const bare = search.get('bare') === '1';
  const surface = (STUDIO_SURFACES as readonly string[]).includes(params.surface ?? '') ? (params.surface as StudioSurface) : null;
  const code = (params.code ?? '').toUpperCase();
  const q = useQuery({
    queryKey: ['studio', 'preview', code],
    queryFn: () => api.get<{ surface: StudioSurface; doc: StudioDoc; expiresAt: string }>(`/api/studio/preview/${encodeURIComponent(code)}`),
    enabled: !!surface && /^[A-Z2-9]{8}$/.test(code),
    retry: false,
  });
  const def = surface ? STUDIO_SURFACE_DEFS[surface] : null;
  const [screen, setScreen] = useState<string | null>(null);
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [tapped, setTapped] = useState<string | null>(null);
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth));
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const blocks = useMemo(() => (def ? phoneEditorBlocks(def) : {}), [def]);
  const doc = q.data?.doc ?? null;
  const vars = useMemo(() => (doc ? themeVars(doc) : {}), [doc]);

  if (!surface || !def || def.kind !== 'phone') {
    return <div className="p-6 text-[13px] text-ink-2">这个界面没有手机预览</div>;
  }
  if (q.isError && !q.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-paper p-6">
        <LoadFailed title="预览码不对或已经过期（30 分钟有效）：在工作台里重新生成" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="studio-phone-preview-error" />
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-paper">
        <Skeleton className="h-[640px] w-[375px]" />
      </div>
    );
  }
  const asked = search.get('screen');
  const current = screen ?? (asked && def.screens.some((x) => x.key === asked) ? asked : def.screens[0]!.key);
  const s = doc.screens[current] ?? { background: null, nodes: [] };
  // 手机上看：铺满屏幕宽；电脑上看：375 宽、居中
  const k = width < 420 ? width / def.size.w : 1;
  const frame: CSSProperties = { width: def.size.w * k, ...(vars as CSSProperties) };
  const ctx = { surface: def, lang, assetUrl: (id: string) => `/api/studio/assets/${id}`, blocks, components: doc.components, onAction: (a: StudioAction) => setTapped(describe(surface, a)) };
  if (bare) {
    return (
      <div style={frame} data-testid="studio-phone-preview">
        <StudioPhoneScreen screen={s} ctx={ctx} testId="studio-phone-screen" />
      </div>
    );
  }
  return (
    <div className="min-h-dvh bg-paper-2" data-testid="studio-phone-preview">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-card px-3 py-2">
        <Link to={`/studio/${surface}`} className="flex h-8 items-center rounded-md px-1.5 text-ink-2 hover:bg-paper-2" title="回工作台">
          <ArrowLeft className="size-4" />
        </Link>
        <span className="text-[12.5px] font-bold">预览 · {def.label}</span>
        <div className="flex rounded-md border border-line p-0.5">
          {def.screens.map((x) => (
            <button key={x.key} type="button" className={cn('h-7 rounded px-2 text-[12px]', current === x.key ? 'bg-pine text-white' : 'text-ink-2')} onClick={() => setScreen(x.key)} data-testid={`studio-phone-screen-${x.key}`}>
              {x.label}
            </button>
          ))}
        </div>
        <button type="button" className="h-8 rounded-md border border-line px-2 text-[12px]" onClick={() => setLang((l) => (l === 'zh' ? 'en' : 'zh'))}>
          {lang === 'zh' ? '中' : 'EN'}
        </button>
        <span className="text-[11.5px] text-ink-3">草稿的样子，不是真的小程序；按钮点了只写出会去哪</span>
      </div>
      {tapped && (
        <div className="mx-auto mt-2 w-fit rounded-md bg-ink px-3 py-1.5 text-[12.5px] text-paper" data-testid="studio-phone-tapped">
          {tapped}
        </div>
      )}
      <div className={cn('mx-auto overflow-hidden bg-card shadow-[0_8px_30px_rgb(0_0_0/0.14)]', width >= 420 && 'my-4 rounded-[18px]')} style={frame}>
        {/* 窄屏按比例缩（zoom 连同占的高一起缩，不留空白） */}
        <div style={{ width: def.size.w, zoom: k === 1 ? undefined : k }}>
          <StudioPhoneScreen screen={s} ctx={ctx} testId="studio-phone-screen" />
        </div>
      </div>
    </div>
  );
}
