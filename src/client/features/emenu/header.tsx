// 平板点餐页的顶栏（设计稿每一屏的最上面一条）：汤崎标志、分类页签、搜索、订单、手牌。
// 后台「电子菜单」的预览也用这一条（按钮不接事件）。

import type { ReactNode } from 'react';
import type { EmenuCategoryView } from '@shared/emenu';
import { OrderIcon, SearchIcon } from './icons';
import { LogoRow } from './logo';
import { box } from './stage';

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
}) {
  // 设计稿两个分类的中心在 367.6 与 514.5（相距 147）：分类多了往两边排开，放不下就挤一点
  const n = categories.length;
  const gap = Math.min(147, 610 / Math.max(n, 1));
  const first = 441 - ((n - 1) * gap) / 2;
  const icon = (onClick: () => void, x: number, y: number, w: number, h: number, label: string, testId: string, children: ReactNode) => (
    <button type="button" onClick={onClick} aria-label={label} style={{ ...box(x, y, w, h), padding: 0, border: 0, background: 'none' }} data-testid={testId}>
      <span style={{ position: 'absolute', inset: -11 }} />
      {children}
    </button>
  );
  return (
    <div style={{ ...box(0, 0, 1024, 102), background: 'var(--em-bg)' }} data-testid="emenu-header">
      <div style={{ ...box(40, 48.6) }}>
        <LogoRow />
      </div>
      {categories.map((c, i) => {
        const on = c.id === activeId;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onCategory(c.id)}
            aria-pressed={on}
            style={{ ...box(first + i * gap - gap / 2, 34, gap, 46), padding: 0, border: 0, background: 'none', color: on ? 'var(--em-ink)' : 'var(--em-mute)', textAlign: 'center', overflow: 'hidden' }}
            data-testid={`emenu-cat-${c.id}`}
          >
            {/* 设计稿：中文文字框上沿 45.7、英文 60.3（按钮从 34 开始）。按钮里的内容浏览器会上下居中，所以两行都自己定位 */}
            <span style={{ ...box(0, 11.7, gap), textAlign: 'center', fontSize: 14, lineHeight: '14px', whiteSpace: 'nowrap' }}>{c.name}</span>
            <span className="em-en" style={{ ...box(0, 26.3, gap), textAlign: 'center', fontSize: 8, lineHeight: '8px', whiteSpace: 'nowrap', letterSpacing: '0.058em' }}>
              {c.nameEn}
            </span>
          </button>
        );
      })}
      {icon(onSearch, 795.4, 45.4, 20.5, 20.5, '搜索', 'emenu-search-open', <SearchIcon />)}
      {icon(
        onOrder,
        837.5,
        45.2,
        17.9,
        20.4,
        pending ? '订单（有一单结果待确认）' : `订单（未下单 ${count} 份）`,
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
        aria-label={`手牌 ${tagCode}，点这里结束点餐`}
        style={{ ...box(898.2, 44.3, undefined, 22.3), minWidth: 85.8, padding: '5.7px 5.9px 2.6px', border: 0, borderRadius: 2, background: 'var(--em-tan)', color: 'var(--em-light)', fontSize: 14, lineHeight: '14px', whiteSpace: 'nowrap', textAlign: 'left' }}
        data-testid="emenu-tag"
      >
        <span style={{ position: 'absolute', inset: '-11px -6px' }} />
        手牌<span className="em-en">: {tagCode}</span>
      </button>
    </div>
  );
}
