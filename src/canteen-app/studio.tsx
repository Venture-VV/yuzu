// 柚子饭堂的版面（8.1.2，docs/WORKBENCH_V811.md 第 8 节）：首页、饭卡码页照 UI 工作台发布的版面排——现在的每一段都是功能块
// （逻辑照旧，在 pages/Home.tsx、pages/Code.tsx 里），设计师调先后、藏起来、在中间加图文、换主题色。
//   · 联网打开时取一次这家店发布的那一版，存在这台手机上：没网时用上次的；从没取到过（或门店还没发布过）用内置的默认版面 = 原来的样子；
//   · 主题色改过的写到页面最外层（老的颜色名字 leaf、peach、berry、sky 跟着新的走）；没改过的照样式表；
//   · 预览：地址带 ?studio=<预览码>（工作台里生成的，30 分钟有效）时用那一份草稿，不存。

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CANTEEN_SURFACE, defaultStudioDoc, themeVars } from '@shared/studio/surfaces';
import type { StudioDoc } from '@shared/studio/format';
import type { CanteenMe } from '@shared/canteen';
import { StudioFillScreen, type StudioRenderCtx } from '../client/studio-render/StudioNodes';
import { call, readJson, writeJson } from './lib';

const KEY = 'yuzu.canteen.studio.v1';
/** 老的颜色名字跟着新的走（样式表里两个名字一样的值，见 styles.css） */
const ALIASES: Record<string, string> = { '--color-organic': '--color-leaf', '--color-energy': '--color-peach', '--color-danger': '--color-berry', '--color-relax': '--color-sky' };

/**
 * 门店系统送来的版面（服务端存、发、生成预览码时都按格式核对过）：认得出是员工食堂的才用，坏的、别的界面的当没有。
 * 这里不再带上 zod 逐项核对（员工食堂的包小一点）；渲染器遇到认不出的节点不画。
 */
function parseLayout(raw: unknown): StudioDoc | null {
  const d = raw as Partial<StudioDoc> | null;
  if (!d || typeof d !== 'object' || d.schema !== 1 || d.surface !== 'canteen' || !d.theme || !d.screens || typeof d.screens !== 'object') return null;
  for (const s of Object.values(d.screens)) if (!s || !Array.isArray(s.nodes)) return null;
  return d as StudioDoc;
}

const previewCode = (): string | null => {
  try {
    const c = new URLSearchParams(window.location.search).get('studio')?.trim().toUpperCase() ?? '';
    return /^[A-Z2-9]{8}$/.test(c) ? c : null;
  } catch {
    return null;
  }
};

/** 这台手机现在用的版面：先用存着的（或默认），联网以后换成门店发布的那一版 */
export function useCanteenLayout(online: boolean): { doc: StudioDoc; preview: boolean } {
  const preview = useMemo(previewCode, []);
  const [doc, setDoc] = useState<StudioDoc>(() => (preview ? null : parseLayout(readJson<unknown>(KEY))) ?? defaultStudioDoc('canteen'));
  useEffect(() => {
    if (!online) return;
    let alive = true;
    call<{ layout: { doc: unknown } | null }>('GET', preview ? `/api/canteen/studio/preview/${preview}` : '/api/canteen/studio')
      .then((r) => {
        if (!alive) return;
        const next = r.layout ? parseLayout(r.layout.doc) : null;
        setDoc(next ?? defaultStudioDoc('canteen'));
        // 草稿的预览不存（关掉就回到发布的样子）
        if (!preview) writeJson(KEY, next ? r.layout!.doc : null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [online, preview]);
  // 主题色、字体：改过的写到页面最外层
  useEffect(() => {
    const root = document.documentElement;
    const set: string[] = [];
    for (const [k, v] of Object.entries(themeVars(doc))) {
      root.style.setProperty(k, v);
      set.push(k);
      const alias = ALIASES[k];
      if (alias) {
        root.style.setProperty(alias, v);
        set.push(alias);
      }
    }
    return () => set.forEach((k) => root.style.removeProperty(k));
  }, [doc]);
  return { doc, preview: !!preview };
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 一屏：照版面排，功能块是现在页面上的那几段 */
export function CanteenScreen({
  doc,
  screen,
  blocks,
  go,
  me,
  testId,
}: {
  doc: StudioDoc;
  screen: 'home' | 'code';
  blocks: Record<string, () => ReactNode>;
  go: (route: string) => void;
  me: CanteenMe;
  testId?: string;
}) {
  const s = doc.screens[screen] ?? defaultStudioDoc('canteen').screens[screen]!;
  const ctx: StudioRenderCtx = {
    surface: CANTEEN_SURFACE,
    lang: 'zh',
    assetUrl: (id) => `/api/canteen/studio/assets/${id}`,
    blocks,
    components: doc.components,
    data: (field) => {
      if (field === 'me.name') return me.employee.name;
      if (field === 'me.department') return me.employee.department;
      if (field === 'me.mealsThisMonth') return String(me.mealsThisMonth);
      if (field === 'today.date') {
        const [y, m, d] = me.today.split('-').map(Number);
        return `${m} 月 ${d} 日 ${WEEK[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]}`;
      }
      return null;
    },
    onAction: (a) => {
      if (a.action === 'open.page' && a.arg) go(a.arg);
    },
  };
  // 外壳左右留的 16 让给版面（版面里默认也是左右各 16，设计师可以改）
  return (
    <div className="-mx-4">
      <StudioFillScreen screen={s} ctx={ctx} testId={testId} />
    </div>
  );
}
