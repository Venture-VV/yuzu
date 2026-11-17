// 平板点餐页的顶栏（设计稿每一屏的最上面一条）：汤崎标志、分类页签、中英切换、搜索、订单、手牌。
// 后台「电子菜单」的预览也用这一条（按钮不接事件）。

import { useEffect, useState, type ReactNode } from 'react';
import type { EmenuCategoryView } from '@shared/emenu';
import { namePair, useLang, useM, type Lang } from './i18n';
import langEn from './assets/lang-en.png';
import langZh from './assets/lang-zh.png';
import { OrderIcon, SearchIcon } from './icons';
import { LogoRow, LOGO_ROW_RATIO } from './logo';
import { BIG, box, useBig, ZoomAt } from './stage';

/** 中英切换图标的边长（8.1.5，PP6）：与手牌色块一样高 */
export const LANG_ICON = 22.3;
/** 横排字标的高是右上角切换图标的几倍（8.1.5，PP7） */
export const LOGO_TO_ICON = 0.7;
/** 顶栏右边几样（切换图标、搜索、订单、手牌）的中线：字标也对齐在这条线上（PP7） */
const ROW_MID = 55.45;

// ───────────── 分类名的字宽（8.1.6，QZ5） ─────────────
// 原来按字数估（英文一个字 8.2、中文 14），长的英文名估少了会被裁掉一截。现在用页面上的字体在画布上量；
// 字体下载完（document.fonts 的 loadingdone）重新量一次。量不了（没有画布）时照旧按字数估。

const EN_FONTS = "'Tangqi Brand En', 'Average Sans', 'Optima', 'Zhuque Fangsong', 'FangSong', sans-serif";
const ZH_FONTS = "'Zhuque Fangsong', 'FangSong', 'STFangsong', 'Songti SC', 'Noto Serif CJK SC', serif";
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
/** 字体下载完以后变一次：量过的字宽作废、顶栏重新排 */
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
export function LangToggle({ lang, onToggle, x, y, size = LANG_ICON, light }: { lang: Lang; onToggle: () => void; x: number; y: number; size?: number; light?: boolean }) {
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
    >
      <span style={{ position: 'absolute', inset: -11 }} />
      {face(langEn, lang === 'zh')}
      {face(langZh, lang === 'en')}
      {light && <span style={{ position: 'absolute', inset: 0, borderRadius: radius, boxShadow: '0 0 0 1px rgb(244 243 242 / 0.55)', pointerEvents: 'none' }} />}
    </button>
  );
}

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
  // 设计稿两个分类的中心在 367.6 与 514.5（相距 147）：分类多了往两边排开，放不下就挤一点。
  // 有中英切换时图标占了搜索左边的 751.7–774（原来「中 | EN」开关占 726–774），分类照旧最多排到 705
  // 放大的一档：右边几样大了、往左多占一点（切换图标的左边在 735），分类照旧最多排到 690
  const n = categories.length;
  const room = large ? (onLang ? 498 : 610) : onLang ? 528 : 610;
  const gap = Math.min(147, room / Math.max(n, 1));
  const first = 441 - ((n - 1) * gap) / 2;
  const activeAt = categories.findIndex((c) => c.id === activeId);
  // 分类的字（8.1.6，QZ5）：按最宽的那个名字实际量出来的宽排——放大的一档最多放大 BIG.ui 倍；
  // 分类多、名字长放不下时整组一起缩小一点（最多缩到 CAT_MIN_SCALE），不挤到旁边；还放不下的末尾显示「…」。放得下时与原来一样
  const spacingEn = 0.058;
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
  // 排字的那一块：一格的宽减去两边各 4，换算回缩放以前（放得下时字照旧居中；放不下的在这一块里末尾显示「…」）
  const textRoom = (gap - 8) / kc;
  const fit = { overflow: 'hidden', textOverflow: 'ellipsis' } as const;
  const ku = large ? BIG.ui : 1;
  // 图标：设计稿的位置是左上角；放大的一档绕 (cx, 中线) 放大
  const icon = (onClick: () => void, x: number, y: number, w: number, h: number, label: string, testId: string, children: ReactNode, cx: number) => {
    const button = (bx: number, by: number) => (
      <button type="button" onClick={onClick} aria-label={label} className="em-tap" style={{ ...box(bx, by, w, h), padding: 0, border: 0, background: 'none' }} data-testid={testId}>
        <span style={{ position: 'absolute', inset: -11 }} />
        {children}
      </button>
    );
    return large ? (
      <ZoomAt x={cx} y={y + h / 2} k={ku}>
        {button(-w / 2, -h / 2)}
      </ZoomAt>
    ) : (
      button(x, y)
    );
  };
  // 左上角的横排字标（8.1.5，PP7）：高是右上角切换图标的 0.7 倍（放大的一档图标也放大，字标跟着），与右边几样中线对齐
  const logoH = LANG_ICON * ku * LOGO_TO_ICON;
  return (
    <div style={{ ...box(0, 0, 1024, 102), background: 'var(--em-bg)' }} data-testid="emenu-header">
      <div style={{ ...box(40, ROW_MID - logoH / 2, logoH * LOGO_ROW_RATIO, logoH) }} data-testid="emenu-logo">
        <LogoRow width={logoH * LOGO_ROW_RATIO} className="block" />
      </div>
      {/* 选中的分类下面的光晕：换分类时滑过去 */}
      {activeAt >= 0 && <span className="em-cat-glow" style={{ left: 0, transform: `translateX(${first + activeAt * gap - gap / 2 + 6}px)`, top: 57 - 27 * kc, width: gap - 12, height: 52 * kc }} />}
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
              ...box(first + i * gap - gap / 2, 57 - 23 * kc, gap, 46 * kc),
              padding: 0,
              border: 0,
              background: 'none',
              color: on ? 'var(--em-ink)' : 'var(--em-mute)',
              textAlign: 'center',
              overflow: 'hidden',
            }}
            data-testid={`emenu-cat-${c.id}`}
          >
            {/* 里面照设计稿的像素写（46 高、gap 宽），整块绕上沿的正中按 kc 放大、缩小 */}
            <span style={{ ...box(gap / 2, 0, 0, 0), transform: kc === 1 ? undefined : `scale(${kc})`, transformOrigin: '0 0' }}>
              <span style={{ ...box(-textRoom / 2, 0, textRoom, 46) }}>
                {/* 设计稿：中文文字框上沿 45.7、英文 60.3（按钮从 34 开始）。按钮里的内容浏览器会上下居中，所以两行都自己定位 */}
                {name.mainEn ? (
                  <>
                    <span className="em-en" style={{ ...box(0, 12.6, textRoom), ...fit, textAlign: 'center', fontSize: 12, lineHeight: '12px', whiteSpace: 'nowrap', letterSpacing: `${spacingEn}em` }}>
                      {name.main}
                    </span>
                    <span style={{ ...box(0, 27.2, textRoom), ...fit, textAlign: 'center', fontSize: 9, lineHeight: '9px', whiteSpace: 'nowrap' }}>{name.sub}</span>
                  </>
                ) : (
                  <>
                    <span style={{ ...box(0, 11.7, textRoom), ...fit, textAlign: 'center', fontSize: 14, lineHeight: '14px', whiteSpace: 'nowrap' }}>{name.main}</span>
                    <span className="em-en" style={{ ...box(0, 26.3, textRoom), ...fit, textAlign: 'center', fontSize: 8, lineHeight: '8px', whiteSpace: 'nowrap', letterSpacing: `${spacingEn}em` }}>
                      {name.sub}
                    </span>
                  </>
                )}
              </span>
            </span>
          </button>
        );
      })}
      {/* 切换图标的右边仍在原来「中 | EN」开关的右边（原样 774、放大一档 764.2），离搜索的空不变 */}
      {onLang &&
        (large ? (
          <ZoomAt x={764.2 - (LANG_ICON / 2) * ku} y={ROW_MID} k={ku}>
            <LangToggle lang={lang} onToggle={onLang} x={-LANG_ICON / 2} y={-LANG_ICON / 2} />
          </ZoomAt>
        ) : (
          <LangToggle lang={lang} onToggle={onLang} x={774 - LANG_ICON} y={ROW_MID - LANG_ICON / 2} />
        ))}
      {icon(onSearch, 795.4, 45.4, 20.5, 20.5, m.search, 'emenu-search-open', <SearchIcon />, 796)}
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
      )}
      {/* 手牌色块：放大的一档右边仍贴在 984，往左长 */}
      <div style={large ? { position: 'absolute', right: 40, top: 44.3, transform: `scale(${ku})`, transformOrigin: '100% 50%' } : { ...box(898.2, 44.3) }}>
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
            minWidth: 85.8,
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
        >
          <span style={{ position: 'absolute', inset: '-11px -6px' }} />
          {lang === 'en' ? <span className="em-en">{m.tagPill}</span> : m.tagPill}
          <span className="em-en">: {tagCode}</span>
        </button>
      </div>
    </div>
  );
}
