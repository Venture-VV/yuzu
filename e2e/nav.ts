// 门店主导航（8.1.15 起按业务域分组，src/client/components/StoreRail.tsx）：前台、餐饮、房态、技师、会员、财务、设置七组，
// 每组下面是页面入口。展开的侧栏里没打开的组、收起时别的组（点一下才弹出）的入口在页面上但看不见：用例点入口时先打开那一组。
import { expect, type Locator, type Page } from '@playwright/test';

const mainNav = (page: Page) => page.getByRole('navigation', { name: '主导航', exact: true });

/** 主导航里有没有这个入口（不管所在的组折没折）：没有权限、功能没开的入口根本不在 */
export const navItem = (page: Page, name: string): Locator => mainNav(page).locator(`[data-nav-item="${name}"]`);

/** 主导航里的一个页面入口（链接）；所在的组折着、或收起时在弹出层里，先点开那一组 */
export async function navLink(page: Page, name: string): Promise<Locator> {
  const nav = mainNav(page);
  await navItem(page, name).first().waitFor({ state: 'attached', timeout: 30_000 });
  const link = nav.getByRole('link', { name, exact: true });
  if (await link.isVisible()) return link;
  await nav
    .locator('[data-nav-domain]')
    .filter({ has: page.locator(`[data-nav-item="${name}"]`) })
    .locator('[data-nav-toggle]')
    .click();
  await expect(link).toBeVisible();
  return link;
}

/** 点主导航里的一个页面入口 */
export async function clickNav(page: Page, name: string): Promise<void> {
  await (await navLink(page, name)).click();
}
