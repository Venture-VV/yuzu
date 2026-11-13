// 平板点餐页的顶栏（设计稿每一屏的最上面一条）：汤崎标志、分类页签、「中 | EN」、搜索、订单、手牌。
// 后台「电子菜单」的预览也用这一条（按钮不接事件）。

import type { ReactNode } from 'react';
import type { EmenuCategoryView } from '@shared/emenu';
import { namePair, useLang, useM, type Lang } from './i18n';
import { OrderIcon, SearchIcon } from './icons';
import { LogoRow } from './logo';
import { box, Hairline } from './stage';

/**
 * 「中 | EN」开关（8.0.13，设计稿之外补的）：与手牌色块一样高（22.3），当前语言的那一半是卡其色底。点一下换另一种语言。
 * light：压在起始页的氛围图上时用浅色的边与字。
 */
export function LangToggle({ lang, onToggle, x, y, light }: { lang: Lang; onToggle: () => void; x: number; y: number; light?: boolean }) {
  const off = light ? 'rgb(244 243 242 / 0.92)' : 'var(--em-mute)';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={lang === 'en' ? 'Switch to Chinese / 切换到中文' : '切换到英文 / Switch to English'}
      aria-pressed={lang === 'en'}
      style={{ ...box(x, y, 48, 22.3), padding: 0, border: 0, borderRadius: 2, background: light ? 'rgb(0 0 0 / 0.16)' : 'transparent' }}
      data-testid="emenu-lang"
      data-lang={lang}
    >
      <span style={{ position: 'absolute', inset: '-11px -6px' }} />
      <Hairline color={off} radius={2} />
      <span className="em-lang-knob" style={{ ...box(0, 0, 24, 22.3), borderRadius: 2, background: 'var(--em-tan)', transform: lang === 'en' ? 'translateX(24px)' : 'none' }} />
      {/* 字的文字框在上沿往下 5.2：与手牌色块里的字同一条基线 */}
      <span style={{ ...box(0, 5.2, 24), textAlign: 'center', fontSize: 13, lineHeight: '13px', color: lang === 'zh' ? 'var(--em-light)' : off, transition: 'color var(--em-in) ease' }}>中</span>
      <span className="em-en" style={{ ...box(24, 6, 24), textAlign: 'center', fontSize: 11, lineHeight: '11px', letterSpacing: '0.04em', color: lang === 'en' ? 'var(--em-light)' : off, transition: 'color var(--em-in) ease' }}>
        EN
      </span>
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
  /** 有「中 | EN」开关时给（后台关了中英切换就不给，顶栏与 8.0.12 一样） */
  onLang?: () => void;
}) {
  const lang = useLang();
  const m = useM();
  // 设计稿两个分类的中心在 367.6 与 514.5（相距 147）：分类多了往两边排开，放不下就挤一点。
  // 有「中 | EN」开关时它占了搜索左边的 726–774，分类最多排到 705
  const n = categories.length;
  const room = onLang ? 528 : 610;
  const gap = Math.min(147, room / Math.max(n, 1));
  const first = 441 - ((n - 1) * gap) / 2;
  const activeAt = categories.findIndex((c) => c.id === activeId);
  const icon = (onClick: () => void, x: number, y: number, w: number, h: number, label: string, testId: string, children: ReactNode) => (
    <button type="button" onClick={onClick} aria-label={label} className="em-tap" style={{ ...box(x, y, w, h), padding: 0, border: 0, background: 'none' }} data-testid={testId}>
      <span style={{ position: 'absolute', inset: -11 }} />
      {children}
    </button>
  );
  return (
    <div style={{ ...box(0, 0, 1024, 102), background: 'var(--em-bg)' }} data-testid="emenu-header">
      <div style={{ ...box(40, 48.6) }}>
        <LogoRow />
      </div>
      {/* 选中的分类下面的光晕：换分类时滑过去 */}
      {activeAt >= 0 && <span className="em-cat-glow" style={{ left: first + activeAt * gap - gap / 2 + 6, top: 30, width: gap - 12, height: 52 }} />}
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
            style={{ ...box(first + i * gap - gap / 2, 34, gap, 46), padding: 0, border: 0, background: 'none', color: on ? 'var(--em-ink)' : 'var(--em-mute)', textAlign: 'center', overflow: 'hidden' }}
            data-testid={`emenu-cat-${c.id}`}
          >
            {/* 设计稿：中文文字框上沿 45.7、英文 60.3（按钮从 34 开始）。按钮里的内容浏览器会上下居中，所以两行都自己定位 */}
            {name.mainEn ? (
              <>
                <span className="em-en" style={{ ...box(0, 12.6, gap), textAlign: 'center', fontSize: 12, lineHeight: '12px', whiteSpace: 'nowrap', letterSpacing: '0.058em' }}>
                  {name.main}
                </span>
                <span style={{ ...box(0, 27.2, gap), textAlign: 'center', fontSize: 9, lineHeight: '9px', whiteSpace: 'nowrap' }}>{name.sub}</span>
              </>
            ) : (
              <>
                <span style={{ ...box(0, 11.7, gap), textAlign: 'center', fontSize: 14, lineHeight: '14px', whiteSpace: 'nowrap' }}>{name.main}</span>
                <span className="em-en" style={{ ...box(0, 26.3, gap), textAlign: 'center', fontSize: 8, lineHeight: '8px', whiteSpace: 'nowrap', letterSpacing: '0.058em' }}>
                  {name.sub}
                </span>
              </>
            )}
          </button>
        );
      })}
      {onLang && <LangToggle lang={lang} onToggle={onLang} x={726} y={44.3} />}
      {icon(onSearch, 795.4, 45.4, 20.5, 20.5, m.search, 'emenu-search-open', <SearchIcon />)}
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
              style={{ ...box(10.6, -6.6, undefined, 11.4), minWidth: 11.4, padding: '0 2.6px', boxSizing: 'border-box', borderRadius: 6, background: pending ? 'var(--em-error)' : 'var(--em-tan)', color: '#fff', fontSize: 8, lineHeight: '11.4px', textAlign: 'center' }}
              data-testid="emenu-order-count"
            >
              {pending ? '!' : count}
            </span>
          )}
        </>,
      )}
      <button
        type="button"
        onClick={onTag}
        aria-label={m.tagAria(tagCode)}
        className="em-tap-soft"
        style={{ ...box(898.2, 44.3, undefined, 22.3), minWidth: 85.8, padding: '5.7px 5.9px 2.6px', border: 0, borderRadius: 2, background: 'var(--em-tan)', color: 'var(--em-light)', fontSize: 14, lineHeight: '14px', whiteSpace: 'nowrap', textAlign: 'left' }}
        data-testid="emenu-tag"
      >
        <span style={{ position: 'absolute', inset: '-11px -6px' }} />
        {lang === 'en' ? <span className="em-en">{m.tagPill}</span> : m.tagPill}
        <span className="em-en">: {tagCode}</span>
      </button>
    </div>
  );
}
