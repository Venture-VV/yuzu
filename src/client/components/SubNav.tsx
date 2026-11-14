// 二级页签（8.0.17，docs/IA_V8017.md 第 3.5 节）：页面标题下面一排页签，全站一个样。
//
//   · 写进地址：`<base>/<页签>`（如 /admin/technicians/roster）。刷新、收藏、发给同事都到同一个页签；
//     不带页签的地址（/admin/technicians）就是第一个页签，地址栏里不认识的页签回到第一个。
//   · 换页签不卸掉别的页签里的东西（只是藏起来）：填到一半的表单切过去再切回来还在，保存按钮照旧管它那一块。
//   · 顺序固定：规则 → 清单 → 导入与工具（各分区自己按这个顺序排）。
//   · 用 8.0.16 的滑块：当前页签下面的那条线滑过去。

import { createContext, useContext, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useSlidingIndicator } from '../lib/motion';
import { cn } from '../lib/utils';

export interface SubTab {
  /** 地址里的那一段：小写字母、数字、短横线 */
  key: string;
  label: ReactNode;
  /** 页签上的数字（待办等）；0 或不给不显示 */
  badge?: number;
  /**
   * 这个页签自己的地址（8.0.18）：ERP 的采购、报销原来是一组各有地址的子页（/purchasing/flow、/erp/petty……），
   * 改成页签以后地址不变，就在这里给；不给的照旧是 `<base>/<key>`
   */
  to?: string;
  /** 自动化用的标识；不给的是 `subnav-<key>` */
  testId?: string;
}

const SubTabContext = createContext<string | null>(null);

/** 现在在哪个页签（没有二级页签的页面为 null） */
export const useActiveSubTab = () => useContext(SubTabContext);

/**
 * 按地址算出现在在哪个页签。路由要写成 `<分区>/:tab?`。
 * 返回 redirect：地址里的页签不认识（旧链接、手打错了）时要跳回去的地址。
 */
export function useSubTabs(tabs: readonly SubTab[], base: string): { active: string; redirect: string | null } {
  const { tab } = useParams();
  const first = tabs[0]?.key ?? '';
  if (!tab) return { active: first, redirect: null };
  if (tabs.some((t) => t.key === tab)) return { active: tab, redirect: null };
  return { active: first, redirect: base };
}

/** 程序里换页签用（「去设置」这类按钮）：返回一个函数，给页签的名字就跳过去 */
export function useGoSubTab(tabs: readonly SubTab[], base: string): (key: string) => void {
  const navigate = useNavigate();
  return (key) => navigate(tabs[0]?.key === key ? base : `${base}/${key}`);
}

/** 一排页签。base 是这个分区的地址（不带页签的那一段）；第一个页签的地址就是 base */
export function SubNav({ tabs, base, active, label, className }: { tabs: readonly SubTab[]; base: string; active: string; label: string; className?: string }) {
  const line = useSlidingIndicator<HTMLElement>('[aria-current="page"]', `${active}|${tabs.length}`);
  if (tabs.length < 2) return null;
  return (
    <nav ref={line.ref} aria-label={label} className={cn('scroll-thin relative flex gap-1 overflow-x-auto border-b border-line', className)} data-testid="subnav">
      {line.style && <span aria-hidden className="mo-indicator rounded-t-full bg-pine" data-settled={line.settled} style={{ ...line.style, height: 2, transform: `translate3d(${line.box!.x}px, ${line.box!.y + line.box!.h - 2}px, 0)` }} />}
      {tabs.map((t, i) => {
        const on = t.key === active;
        return (
          // 用 Link 不用 NavLink：是不是当前页签由 active 定。NavLink 自己按地址算——第一个页签的地址是别的页签的前缀，
          // 它会一直把第一个标成当前页
          <Link
            key={t.key}
            to={t.to ?? (i === 0 ? base : `${base}/${t.key}`)}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'relative flex h-10 shrink-0 items-center gap-1.5 px-3.5 text-[14px] font-semibold whitespace-nowrap transition-colors duration-150',
              on ? 'text-pine' : 'text-ink-3 hover:text-ink',
              // 量不到位置时（容器还没显示）当前页签自己画底下那条线
              on && !line.style && 'shadow-[inset_0_-2px_0_var(--color-pine)]',
            )}
            data-testid={t.testId ?? `subnav-${t.key}`}
          >
            {t.label}
            {!!t.badge && (
              <span key={t.badge} className="num flex h-[18px] min-w-[18px] animate-tick items-center justify-center rounded-full bg-yuzu px-1 text-[11px] font-bold text-ink">
                {t.badge > 99 ? '99+' : t.badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 有二级页签的一页：算出现在的页签、画页签、把「现在在哪个页签」交给里面的 SubPane。
 * header 画在页签上面（标题、说明、右边的按钮）。
 */
export function SubTabPage({ tabs, base, label, header, children }: { tabs: readonly SubTab[]; base: string; label: string; header?: ReactNode; children: ReactNode }) {
  const { active, redirect } = useSubTabs(tabs, base);
  if (redirect) return <Navigate to={redirect} replace />;
  return (
    <SubTabContext.Provider value={active}>
      {header}
      <SubNav tabs={tabs} base={base} active={active} label={label} className="mb-5" />
      {children}
    </SubTabContext.Provider>
  );
}

/**
 * 一个页签里的内容。不是当前页签时藏起来（不卸掉）：里面填到一半的东西、已经取到的数据都留着。
 * 页面没有二级页签（没包在 SubTabPage 里）时照常显示。
 */
export function SubPane({ tab, children, className, lazy }: { tab: string; children: ReactNode; className?: string; /** 第一次点到这个页签才挂上（里面的东西重的时候用）；挂上以后照样只藏不卸 */ lazy?: boolean }) {
  const active = useActiveSubTab();
  const shown = active === null || active === tab;
  const [visited, setVisited] = useState(shown);
  if (shown && !visited) setVisited(true);
  if (lazy && !shown && !visited) return null;
  return (
    <div role="tabpanel" hidden={!shown} className={cn(shown && 'animate-page-in', className)} data-subpane={tab}>
      {children}
    </div>
  );
}
