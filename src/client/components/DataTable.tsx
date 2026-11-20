// 公共表格（8.1.17，《浴族系统需求汇总》系统整体 YS-5，docs/YUZU_REQ_V8117.md 3.1）：表头、行高、对齐、
// 金额与数量右对齐等宽、整行可点（键盘回车也能点）、没有数据的空态、取不回来的 LoadFailed、窄屏横向滚动都在这里，
// 页面只给列与数据。新写的表格用它：npm run check:gov 记页面里手写 <table> 的数，只降不升（docs/CONVENTIONS.md「页面部件」）。

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { EmptyState } from './EmptyState';
import { LoadFailed } from './LoadFailed';
import { Skeleton } from './ui';
import { cn } from '../lib/utils';

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** 金额、数量这类数：右对齐、等宽数字，竖着好对 */
  numeric?: boolean;
  align?: 'left' | 'center' | 'right';
  /** th 与 td 都加（宽度、不换行、窄屏隐藏这类） */
  className?: string;
  /** 只加在表头上 */
  headerClassName?: string;
  /** 只加在单元格上；按行变的写成函数 */
  cellClassName?: string | ((row: T) => string | undefined);
  /** 单元格的 data-testid（按行） */
  cellTestId?: (row: T) => string | undefined;
  /** 单元格的 data-label：窄屏把一行排成卡片时，样式表用 attr(data-label) 在格子前面写上列名 */
  dataLabel?: string;
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

/** 点在行里的按钮、链接、输入框上：交给它们自己，不当成点了这一行 */
const fromControl = (e: MouseEvent | KeyboardEvent) => {
  const target = e.target as HTMLElement;
  return target !== e.currentTarget && !!target.closest('button, a, input, select, textarea, label, [role="button"], [role="checkbox"]');
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  variant = 'boxed',
  onRowClick,
  rowLabel,
  rowClassName,
  rowTestId,
  empty = '暂无记录',
  emptyDescription,
  loading,
  failed,
  onRetry,
  retrying,
  failedTitle = '没有取回来，请重试',
  footer,
  caption,
  testId,
  className,
  tableClassName = 'min-w-max',
}: {
  columns: DataColumn<T>[];
  /** 还没取到时是 undefined（显示占位）；取到了是数组（空数组显示空态） */
  rows: readonly T[] | undefined;
  rowKey: (row: T, index: number) => string | number;
  /** boxed：独立的一张表（带边框、表头有底色）；plain：卡片里的小表 */
  variant?: 'boxed' | 'plain';
  /** 整行可点：鼠标、触摸、键盘回车都行；行里自己的按钮照旧只管自己 */
  onRowClick?: (row: T) => void;
  /** 可点的行念给读屏的那一句（不给就念这一行的文字） */
  rowLabel?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  rowTestId?: (row: T) => string | undefined;
  /** 没有数据时的一句话 */
  empty?: string;
  emptyDescription?: ReactNode;
  loading?: boolean;
  /** 取数出错：显示 LoadFailed，点「重试」只重发这一个请求 */
  failed?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
  failedTitle?: string;
  /** 合计行（<tr>…</tr>），放在表尾 */
  footer?: ReactNode;
  /** 表格的名字（读屏用，不显示） */
  caption?: string;
  testId?: string;
  /** 外面那一层（边框、底色、阴影、外边距） */
  className?: string;
  /** 表格本身：默认按内容撑开（窄屏横向滚动）；列多、有长文字的给一个最小宽度，如 min-w-[860px] */
  tableClassName?: string;
}) {
  if (failed && onRetry) return <LoadFailed title={failedTitle} onRetry={onRetry} retrying={retrying} className={className} testId={testId ? `${testId}-failed` : undefined} />;
  if (!rows)
    return (
      <div className={cn('space-y-2', className)} aria-busy={loading ?? true} data-testid={testId ? `${testId}-loading` : undefined}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  if (rows.length === 0)
    // 卡片里的小表只写一句话；独立的一张表用空态插图
    return variant === 'plain' ? (
      <p className={cn('py-3 text-[13px] text-ink-4', className)} data-testid={testId ? `${testId}-empty` : undefined}>
        {empty}
      </p>
    ) : (
      <EmptyState title={empty} description={emptyDescription} art="calm" className={className} testId={testId ? `${testId}-empty` : undefined} />
    );
  const boxed = variant === 'boxed';
  const alignOf = (c: DataColumn<T>) => ALIGN[c.align ?? (c.numeric ? 'right' : 'left')];
  return (
    <div className={cn('max-w-full overflow-x-auto', boxed && 'rounded-lg border border-line', className)} data-testid={testId}>
      <table className={cn('w-full text-[13px]', tableClassName)}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className={cn('text-[12px] text-ink-3', boxed && 'bg-paper-2/70')}>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn('font-bold whitespace-nowrap', boxed ? 'px-3 py-2' : 'py-1.5 pr-3 last:pr-0', alignOf(c), c.className, c.headerClassName)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={cn('divide-y', boxed ? 'divide-line' : 'divide-line/70')}>
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick ? rowLabel?.(row) : undefined}
              onClick={onRowClick ? (e) => !fromControl(e) && onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              className={cn(onRowClick && 'cursor-pointer hover:bg-paper-2/60 focus-visible:bg-paper-2 focus-visible:outline-none', rowClassName?.(row))}
              data-testid={rowTestId?.(row)}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    boxed ? 'px-3 py-2.5' : 'py-2 pr-3 last:pr-0',
                    alignOf(c),
                    c.numeric && 'num',
                    c.className,
                    typeof c.cellClassName === 'function' ? c.cellClassName(row) : c.cellClassName,
                  )}
                  data-testid={c.cellTestId?.(row)}
                  data-label={c.dataLabel}
                >
                  {c.cell(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot className="border-t border-line-strong font-bold">{footer}</tfoot>}
      </table>
    </div>
  );
}
