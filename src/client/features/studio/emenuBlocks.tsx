// UI 工作台编辑器里平板菜单的功能块（8.1.1）：画的就是平板上的那些组件（所见即所得），数据用真实的菜单（后台「电子菜单」排的），
// 按钮不接事件（编辑器的画布上点一下是选中，不是点菜）。

import type { ReactNode } from 'react';
import type { EmenuCategoryView, EmenuMenu, EmenuPageView } from '@shared/emenu';
import type { StudioBlockNode, StudioDoc } from '@shared/studio';
import { Header } from '../emenu/header';
import type { Lang } from '../emenu/i18n';
import { PageCanvas } from '../emenu/pages';
import { EmenuTemplatesProvider } from '../emenu/templates';
import { box } from '../emenu/stage';
import { LangBlock, LogoBlock, LogoRowBlock, StartCoverBlock, StartFooterBlock, StartPendingBlock } from '../emenu/studio';

const noop = () => undefined;

export interface FlatEmenuPage {
  category: EmenuCategoryView;
  page: EmenuPageView;
  pageNo: number;
}
export const flatPages = (menu: EmenuMenu | null): FlatEmenuPage[] => (menu?.categories ?? []).flatMap((category) => category.pages.map((page, pageNo) => ({ category, page, pageNo })));

/** 画布上没有内容可画时的一块浅色提示（只在编辑器里） */
function Placeholder({ w, h, text }: { w: number; h: number; text: string }) {
  // 字写在左上角（不压着中间的字标、海报）
  return (
    <div style={{ ...box(0, 0, w, h), border: '1px dashed rgb(0 0 0 / 0.22)' }}>
      <span style={{ position: 'absolute', left: 10, top: 8, right: 10, color: 'rgb(0 0 0 / 0.42)', fontSize: 11, lineHeight: '15px' }}>{text}</span>
    </div>
  );
}

/** 编辑器画布上平板菜单的功能块 */
export function emenuEditorBlocks(
  menu: EmenuMenu | null,
  opts: { lang: Lang; pageIndex: number; templates?: StudioDoc['templates']; dishStates?: StudioDoc['dishStates'] },
): Record<string, (n: StudioBlockNode) => ReactNode> {
  const cover = menu?.rules.coverUrl ?? null;
  const tone = cover ? '#f4f3f2' : 'var(--em-ink)';
  const flat = flatPages(menu);
  const at = flat[Math.min(Math.max(opts.pageIndex, 0), Math.max(flat.length - 1, 0))];
  return {
    'start.cover': (n) => (cover ? <StartCoverBlock node={n} coverUrl={cover} /> : <Placeholder w={n.w} h={n.h} text="氛围大图（在后台「电子菜单 → 设置」里传；没传时平板上这里是底色）" />),
    'brand.logo': (n) => <LogoBlock node={n} tone={tone} />,
    'brand.logoRow': (n) => <LogoRowBlock node={n} tone={tone} />,
    // 编辑器里一直显示，好摆位置（平板上只在有一单结果待确认时出现）
    'start.pending': (n) => <StartPendingBlock node={n} tone={tone} show />,
    'start.footer': (n) => <StartFooterBlock node={n} tone={tone} text={menu?.rules.footerText ?? 'COPYRIGHT©2026 汤崎 ALL RIGHTS RESERVED'} />,
    lang: (n) => <LangBlock node={n} lang={opts.lang} onToggle={noop} autoLight={!!cover} />,
    'menu.pages': (n) =>
      at ? (
        <EmenuTemplatesProvider templates={opts.templates} dishStates={opts.dishStates}>
          <PageCanvas page={at.page} ctx={{ categoryName: at.category.name, categoryNameEn: at.category.nameEn, open: true }} />
        </EmenuTemplatesProvider>
      ) : (
        <Placeholder w={n.w} h={n.h} text="菜单页（后台「电子菜单」里还没有排菜）" />
      ),
    // 顶栏（8.1.6）：设计师改过的位置照版面画（与平板同一个组件）
    'menu.header': () => (
      <EmenuTemplatesProvider templates={opts.templates}>
        <Header
          categories={menu?.categories ?? []}
          activeId={at?.category.id ?? null}
          onCategory={noop}
          tagCode="A8060"
          count={2}
          bump={0}
          pending={false}
          onSearch={noop}
          onOrder={noop}
          onTag={noop}
          onLang={menu?.rules.langSwitch === false ? undefined : noop}
        />
      </EmenuTemplatesProvider>
    ),
    'menu.dots': (n) => (
      <div style={{ ...box(0, 0, n.w, 14), display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 7 }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: i === 0 ? 12 : 4, height: 4, borderRadius: 2, background: i === 0 ? 'var(--em-tan)' : 'var(--em-photo)' }} />
        ))}
      </div>
    ),
  };
}
