// 平板点餐页的顶栏（设计稿每一屏的最上面一条）：汤崎标志、分类页签、中英切换、搜索、订单、手牌。
// 后台「电子菜单」的预览也用这一条（按钮不接事件）。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { EmenuCategoryView } from '@shared/emenu';
import { EMENU_HEADER_TEMPLATE, EMENU_TAG_W, slotDefault } from '@shared/studio';
import { loadBrandFont } from './brandFont';
import { namePair, useLang, useM, type Lang } from './i18n';
import langEn from './assets/lang-en.png';
import langZh from './assets/lang-zh.png';
import { OrderIcon, SearchIcon } from './icons';
import { LogoRow, LOGO_ROW_RATIO } from './logo';
import { BIG, box, useBig, ZoomAt } from './stage';
import { useHeaderSpots } from './templates';

/** 中英切换图标的边长（8.1.5，PP6）：与手牌色块一样高 */
export const LANG_ICON = 22.3;
/** 横排字标的高是右上角切换图标的几倍（8.1.5，PP7） */
export const LOGO_TO_ICON = 0.7;
/** 顶栏右边几样（切换图标、搜索、订单、手牌）的中线：字标也对齐在这条线上（PP7） */
const ROW_MID = 55.45;

// ───────────── 分类名的字宽（8.1.6，QZ5） ─────────────
// 原来按字数估（英文一个字 8.2、中文 14），长的英文名估少了会被裁掉一截。现在用页面上的字体在画布上量；
// 字体下载完（document.fonts 的 loadingdone）重新量一次。量不了（没有画布）时照旧按字数估。

// 分类的英文是衬线展示体（8.1.14，品牌部，PC1；样式表的 --em-en-display）：量宽用同一串字体。
// 8.1.19（PD1）起授权的品牌英文字体排在最前，没放授权文件时量出来的就是 Playfair Display
const EN_FONTS = "'Tangqi Brand En', 'Playfair Display', 'Average Sans', 'Zhuque Fangsong', 'FangSong', serif";
const ZH_FONTS = "'Tangqi Brand Latin', 'Zhuque Fangsong', 'FangSong', 'STFangsong', 'Songti SC', 'Noto Serif CJK SC', serif";
/** 分类名最多缩到设计稿的几成：再长的末尾显示「…」（一般是后台的英文名太长，后台填英文名的地方有提示） */
export const CAT_MIN_SCALE = 0.8;

let measurer: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
/** 一行字的宽（设计稿像素）：size 字号，spacing 字距（em） */
function textWidth(text: string, en: boolean, size: number, spacing: number): number {
  if (!text) return 0;
  if (measurer === undefined) {
    try {
      measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    } catch {
      measurer = null;
    }
  }
  const chars = [...text].length;
  if (!measurer) return chars * size * (en ? 0.62 : 1) + chars * size * spacing;
  const key = `${en ? 'e' : 'z'}${size}|${spacing}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    measurer.font = `${size}px ${en ? EN_FONTS : ZH_FONTS}`;
    w = measurer.measureText(text).width + chars * size * spacing;
    widths.set(key, w);
  }
  return w;
}
/**
 * 字体下载完以后变一次：量过的字宽作废、顶栏重新排。授权的品牌英文字体是页面自己加进去的（brandFont.ts），
 * 加进去时浏览器不发 loadingdone，所以另外等它取完（8.1.8：原来测试服上分类的英文按顶替字体量、换成品牌字体后宽了，末尾被裁）
 */
function useFontsLoaded(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (!fonts) return;
    let live = true;
    const again = () => {
      widths.clear();
      if (live) setN((x) => x + 1);
    };
    fonts.addEventListener?.('loadingdone', again);
    void fonts.ready.then(again);
    void loadBrandFont().then(again);
    return () => {
      live = false;
      fonts.removeEventListener?.('loadingdone', again);
    };
  }, []);
  return n;
}

/**
 * 中英切换（8.1.5，PP6）：品牌给的两张图——深棕方块上浅色的「En」「中」——显示要切去的那种语言：中文时是「En」、英文时是「中」。
 * 换的时候两张图交叉淡入。x、y 是图标的左上角，size 是边长；light：压在起始页的氛围图上时外加一圈很淡的浅色描边。
 */
export function LangToggle({
  lang,
  onToggle,
  x,
  y,
  size = LANG_ICON,
  light,
  headSlot,
}: {
  lang: Lang;
  onToggle: () => void;
  x: number;
  y: number;
  size?: number;
  light?: boolean;
  /** 顶栏里的那一个（8.1.6）：工作台量位置用 */
  headSlot?: boolean;
}) {
  // 原图 191 见方、圆角约 10
  const radius = size * 0.053;
  const face = (src: string, shown: boolean) => (
    <img src={src} alt="" draggable={false} className="em-lang-face" style={{ ...box(0, 0, size, size), opacity: shown ? 1 : 0, transform: shown ? 'none' : 'scale(0.8)' }} />
  );
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={lang === 'en' ? 'Switch to Chinese / 切换到中文' : '切换到英文 / Switch to English'}
      aria-pressed={lang === 'en'}
      className="em-tap"
      style={{ ...box(x, y, size, size), padding: 0, border: 0, borderRadius: radius, background: 'none' }}
      data-testid="emenu-lang"
      data-lang={lang}
      data-shows={lang === 'zh' ? 'en' : 'zh'}
      data-studio-head={headSlot ? 'lang' : undefined}
    >
      <span style={{ position: 'absolute', inset: -11 }} />
      {face(langEn, lang === 'zh')}
      {face(langZh, lang === 'en')}
      {light && <span style={{ position: 'absolute', inset: 0, borderRadius: radius, boxShadow: '0 0 0 1px rgb(244 243 242 / 0.55)', pointerEvents: 'none' }} />}
    </button>
  );
}

/**
 * 顶栏分类的一行字（8.1.8，品牌部「菜单页顶栏标题不完整」，PENDING_DECISIONS.md PB1）：
 *   · 不裁：外面没有裁剪的框，字的上下缘照样画出来（行框只有 1 个字高，品牌英文字体的大写字母比它高一点，原来上沿被切掉一丝）；
 *   · 放得下照原样居中；比这一格宽的整行按比例缩小到放得下（量的是页面上实际排出来的宽：字体换了、下载完都重新量），不再显示「…」。
 * room 是这一行能用的宽，top 是文字框上沿（都是设计稿像素，与原来的位置一样）。
 */
function FitLine({ room, top, size, en, spacing, children }: { room: number; top: number; size: number; en?: boolean; spacing?: number; children: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  // 每次重画都量一次（顶栏只有几个分类；字体下载完、换语言、换分类数顶栏都会重画）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = '';
    const w = el.offsetWidth;
    const k = w > room ? room / w : 1;
    el.style.transform = k < 1 ? `scale(${k})` : '';
    el.dataset.fit = k < 1 ? k.toFixed(3) : '1';
  });
  return (
    <span style={{ ...box(0, top, room), display: 'flex', justifyContent: 'center' }}>
      <span
        ref={ref}
        className={en ? 'em-en-display' : undefined}
        style={{ flex: 'none', fontSize: size, lineHeight: `${size}px`, whiteSpace: 'nowrap', letterSpacing: spacing ? `${spacing}em` : undefined, transformOrigin: '50% 50%' }}
        data-cat-line
      >
        {children}
      </span>
    </span>
  );
}

const CATS_DEF = EMENU_HEADER_TEMPLATE.slots.find((s) => s.key === 'cats')!;

export function Header({
  categories,
  activeId,
  onCategory,
  tagCode,
  count,
  bump,
  pending,
  onSearch,
  onOrder,
  onTag,
  onLang,
}: {
  categories: EmenuCategoryView[];
  activeId: number | null;
  onCategory: (id: number) => void;
  tagCode: string;
  count: number;
  bump: number;
  pending: boolean;
  onSearch: () => void;
  onOrder: () => void;
  onTag: () => void;
  /** 有中英切换时给（后台关了中英切换就不给，顶栏与 8.0.12 一样） */
  onLang?: () => void;
}) {
  const lang = useLang();
  const m = useM();
  const large = useBig();
  useFontsLoaded();
  // 设计师在工作台里改过顶栏（8.1.6，QZ8）：各块照版面里的位置画；没改过照原来写死的数画（与设计稿逐像素一致）
  const head = useHeaderSpots();
  const ku = large ? BIG.ui : 1;
  // 设计稿两个分类的中心在 367.6 与 514.5（相距 147）：分类多了往两边排开，放不下就挤一点。
  // 有中英切换时图标占了搜索左边的 751.7–774（原来「中 | EN」开关占 726–774），分类照旧最多排到 705
  // 放大的一档：右边几样大了、往左多占一点（切换图标的左边在 735），分类照旧最多排到 690。
  // 顶栏改过「分类」这一块时：在那一块的范围里排开（中线、宽照版面），上下挪了多少整排跟着挪
  const catsSpot = head?.changed('cats') ? head.spot('cats') : null;
  const room = catsSpot ? catsSpot.w : large ? (onLang ? 498 : 610) : onLang ? 528 : 610;
  const center = catsSpot ? catsSpot.x + catsSpot.w / 2 : 441;
  const dy = catsSpot ? catsSpot.y - slotDefault(CATS_DEF, large ? 'big' : 'design').y : 0;
  const n = categories.length;
  const gap = Math.min(147, room / Math.max(n, 1));
  const first = center - ((n - 1) * gap) / 2;
  // 分类的字（8.1.6，QZ5）：按最宽的那个名字实际量出来的宽排——放大的一档最多放大 BIG.ui 倍；
  // 分类多、名字长放不下时整组一起缩小一点（最多缩到 CAT_MIN_SCALE），不挤到旁边；还放不下的末尾显示「…」。放得下时与原来一样
  // 全大写的英文补的字距：衬线展示体（8.1.14）本身比原来的字体宽，补 0.03em（原来给顶替字体 Average Sans 补 0.058em）——
  // 这样一行的宽与门店服务器上用授权品牌字体时差不多，分类整组不会因此多缩一截
  const spacingEn = 0.03;
  const widest = Math.max(
    1,
    ...categories.map((c) => {
      const name = namePair(c.name, c.nameEn, lang);
      return name.mainEn
        ? Math.max(textWidth(name.main, true, 12, spacingEn), textWidth(name.sub, false, 9, lang === 'en' ? 0.027 : 0))
        : Math.max(textWidth(name.main, false, 14, 0), textWidth(name.sub, true, 8, spacingEn));
    }),
  );
  const kc = Math.max(CAT_MIN_SCALE, Math.min(large ? BIG.ui : 1, (gap - 8) / widest));
  // 排字的那一块：一格的宽减去两边各 4，换算回缩放以前（放得下时字照旧居中；还放不下的那一行自己再缩小，见 FitLine）
  const textRoom = (gap - 8) / kc;
  const iconButton = (onClick: () => void, bx: number, by: number, w: number, h: number, label: string, testId: string, slot: string, children: ReactNode) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="em-tap"
      style={{ ...box(bx, by, w, h), padding: 0, border: 0, background: 'none' }}
      data-testid={testId}
      data-studio-head={slot}
    >
      <span style={{ position: 'absolute', inset: -11 }} />
      {children}
    </button>
  );
  // 图标：设计稿的位置是左上角；放大的一档绕 (cx, 中线) 放大。顶栏改过时照版面里的位置与大小（里面按原来的大小画、整体缩放）
  const icon = (onClick: () => void, x: number, y: number, w: number, h: number, label: string, testId: string, children: ReactNode, cx: number, slot: string) => {
    if (head) {
      const p = head.spot(slot);
      const k = p.w / w;
      return iconButton(
        onClick,
        p.x,
        p.y,
        p.w,
        p.h,
        label,
        testId,
        slot,
        <span style={{ ...box(0, 0, w, h), transform: Math.abs(k - 1) < 1e-6 ? undefined : `scale(${k})`, transformOrigin: '0 0' }}>{children}</span>,
      );
    }
    return large ? (
      <ZoomAt x={cx} y={y + h / 2} k={ku}>
        {iconButton(onClick, -w / 2, -h / 2, w, h, label, testId, slot, children)}
      </ZoomAt>
    ) : (
      iconButton(onClick, x, y, w, h, label, testId, slot, children)
    );
  };
  // 左上角的横排字标（8.1.5，PP7）：高是右上角切换图标的 0.7 倍（放大的一档图标也放大，字标跟着），与右边几样中线对齐
  const logoH = LANG_ICON * ku * LOGO_TO_ICON;
  const logo = head ? head.spot('logo') : { x: 40, y: ROW_MID - logoH / 2, w: logoH * LOGO_ROW_RATIO, h: logoH };
  // 手牌色块：原样左边贴在 898.2、往右长；放大的一档右边仍贴在 984、往左长。顶栏改过时照版面的位置，按高缩放
  const tagBox = (() => {
    if (!head) return large ? { position: 'absolute' as const, right: 40, top: 44.3, transform: `scale(${ku})`, transformOrigin: '100% 50%' } : { ...box(898.2, 44.3) };
    const p = head.spot('tag');
    const k = p.h / LANG_ICON;
    const top = p.y + p.h / 2 - LANG_ICON / 2;
    const scale = Math.abs(k - 1) < 1e-6 ? undefined : `scale(${k})`;
    return large
      ? { position: 'absolute' as const, right: 1024 - (p.x + p.w), top, transform: scale, transformOrigin: '100% 50%' }
      : { position: 'absolute' as const, left: p.x, top, transform: scale, transformOrigin: '0 50%' };
  })();
  return (
    <div style={{ ...box(0, 0, 1024, 102), background: 'var(--em-bg)' }} data-testid="emenu-header">
      <div style={{ ...box(logo.x, logo.y, logo.w, logo.h) }} data-testid="emenu-logo" data-studio-head="logo">
        <LogoRow width={logo.w} className="block" />
      </div>
      {/* 分类页签排开的那一块（工作台量位置用，不画东西） */}
      <span aria-hidden style={{ ...box(center - room / 2, 57 - 23 * ku + dy, room, 46 * ku), pointerEvents: 'none' }} data-studio-head="cats" />
      {/* 8.1.8（品牌部，PB5）：选中的分类下面不再有光晕与细线，选中的只是字变成深棕 */}
      {categories.map((c, i) => {
        const on = c.id === activeId;
        const name = namePair(c.name, c.nameEn, lang);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onCategory(c.id)}
            aria-pressed={on}
            className="em-cat"
            style={{
              ...box(first + i * gap - gap / 2, 57 - 23 * kc + dy, gap, 46 * kc),
              padding: 0,
              border: 0,
              background: 'none',
              color: on ? 'var(--em-ink)' : 'var(--em-mute)',
              textAlign: 'center',
            }}
            data-testid={`emenu-cat-${c.id}`}
          >
            {/* 里面照设计稿的像素写（46 高、gap 宽），整块绕上沿的正中按 kc 放大、缩小 */}
            <span style={{ ...box(gap / 2, 0, 0, 0), transform: kc === 1 ? undefined : `scale(${kc})`, transformOrigin: '0 0' }}>
              <span style={{ ...box(-textRoom / 2, 0, textRoom, 46) }}>
                {/* 设计稿：中文文字框上沿 45.7、英文 60.3（按钮从 34 开始）。按钮里的内容浏览器会上下居中，所以两行都自己定位 */}
                {name.mainEn ? (
                  <>
                    <FitLine room={textRoom} top={12.6} size={12} en spacing={spacingEn}>
                      {name.main}
                    </FitLine>
                    {name.sub && (
                      <FitLine room={textRoom} top={27.2} size={9}>
                        {name.sub}
                      </FitLine>
                    )}
                  </>
                ) : (
                  <>
                    <FitLine room={textRoom} top={11.7} size={14}>
                      {name.main}
                    </FitLine>
                    {name.sub && (
                      <FitLine room={textRoom} top={26.3} size={8} en spacing={spacingEn}>
                        {name.sub}
                      </FitLine>
                    )}
                  </>
                )}
              </span>
            </span>
          </button>
        );
      })}
      {/* 切换图标的右边仍在原来「中 | EN」开关的右边（原样 774、放大一档 764.2），离搜索的空不变 */}
      {onLang &&
        (head ? (
          <LangToggle lang={lang} onToggle={onLang} x={head.spot('lang').x} y={head.spot('lang').y} size={head.spot('lang').w} headSlot />
        ) : large ? (
          <ZoomAt x={764.2 - (LANG_ICON / 2) * ku} y={ROW_MID} k={ku}>
            <LangToggle lang={lang} onToggle={onLang} x={-LANG_ICON / 2} y={-LANG_ICON / 2} headSlot />
          </ZoomAt>
        ) : (
          <LangToggle lang={lang} onToggle={onLang} x={774 - LANG_ICON} y={ROW_MID - LANG_ICON / 2} headSlot />
        ))}
      {icon(onSearch, 795.4, 45.4, 20.5, 20.5, m.search, 'emenu-search-open', <SearchIcon />, 796, 'search')}
      {icon(
        onOrder,
        837.5,
        45.2,
        17.9,
        20.4,
        pending ? m.orderPendingAria : m.orderAria(count),
        'emenu-order-open',
        <>
          <OrderIcon />
          {(count > 0 || pending) && (
            <span
              key={bump}
              className="em-en em-bump"
              style={{
                ...box(10.6, -6.6, undefined, 11.4),
                minWidth: 11.4,
                padding: '0 2.6px',
                boxSizing: 'border-box',
                borderRadius: 6,
                background: pending ? 'var(--em-error)' : 'var(--em-tan)',
                color: '#fff',
                fontSize: 8,
                lineHeight: '11.4px',
                textAlign: 'center',
              }}
              data-testid="emenu-order-count"
            >
              {pending ? '!' : count}
            </span>
          )}
        </>,
        842,
        'order',
      )}
      {/* 手牌色块：放大的一档右边仍贴在 984，往左长 */}
      <div style={tagBox}>
        <button
          type="button"
          onClick={onTag}
          aria-label={m.tagAria(tagCode)}
          className="em-tap-soft"
          style={{
            position: 'relative',
            display: 'block',
            boxSizing: 'border-box',
            height: 22.3,
            minWidth: EMENU_TAG_W,
            padding: '5.7px 5.9px 2.6px',
            border: 0,
            borderRadius: 2,
            background: 'var(--em-tan)',
            color: 'var(--em-light)',
            fontSize: 14,
            lineHeight: '14px',
            whiteSpace: 'nowrap',
            textAlign: 'left',
          }}
          data-testid="emenu-tag"
          data-studio-head="tag"
        >
          <span style={{ position: 'absolute', inset: '-11px -6px' }} />
          {lang === 'en' ? <span className="em-en">{m.tagPill}</span> : m.tagPill}
          <span className="em-en">: {tagCode}</span>
        </button>
      </div>
    </div>
  );
}
