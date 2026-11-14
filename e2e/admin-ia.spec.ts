// 8.0.17 浏览器验收：后台的信息架构（docs/IA_V8017.md）。只读（不保存任何东西），可重复执行；
// 依赖演示数据（仅独立演示库），账号：店主 linlan、值班经理 dutymgr（没有就跳过那一段），密码 yuzu2026。
//   · 侧栏 7 个一级分组，「设备」在里面；后台首页的分区卡片按同一套分组；
//   · 二级页签写进地址：点页签地址跟着变，刷新还在这个页签，不认识的页签回到第一个；
//   · 换页签不丢填到一半的东西；分区的旧地址、券的旧 ?tab= 地址照旧能用。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.describe('8.0.17 后台的信息架构', () => {
  test('侧栏：7 个一级分组、改过名的分区、「设备」进了侧栏；后台首页的分区卡片按同一套分组', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '宽屏的侧栏，只跑一次');
    await login(page, 'linlan');
    await page.goto('/admin');
    const nav = page.getByRole('navigation', { name: '后台导航' });
    await expect(nav.locator('p')).toHaveText(['概览', '规则中心', '会员与营销', '营业项目', '场地、设备与线上', '人员与行政', '数据与审计']);
    // 规则中心：规则总表、门店基本规则（原「经营规则」）
    await expect(page.getByTestId('admin-nav-settings')).toHaveText('规则总表');
    await expect(page.getByTestId('admin-nav-rules')).toHaveText('门店基本规则');
    // 8.0.19：会员规则、会员权益、渠道与标签合成「会员体系」一个分区；对客导览单列
    await expect(page.getByTestId('admin-nav-membership')).toHaveText('会员体系');
    await expect(page.getByTestId('admin-nav-members')).toHaveCount(0);
    await expect(page.getByTestId('admin-nav-benefits')).toHaveCount(0);
    await expect(page.getByTestId('admin-nav-guide')).toHaveText('对客导览');
    await expect(page.getByTestId('admin-nav-coupons')).toHaveText('券');
    await expect(page.getByTestId('admin-nav-opening')).toHaveText('期初与旧账');
    // 设备：8.0.16 以前不在侧栏里
    await page.getByTestId('admin-nav-devices').click();
    await expect(page).toHaveURL(/\/admin\/devices$/);
    await expect(page.getByRole('heading', { level: 1, name: '设备' })).toBeVisible();
    // 后台首页：同一套分组（没有「后台首页」自己）
    await page.goto('/admin');
    const groups = page.getByTestId('admin-home-groups');
    await expect(groups.locator('> div > p')).toHaveText(['概览', '规则中心', '会员与营销', '营业项目', '场地、设备与线上', '人员与行政', '数据与审计']);
    await groups.getByRole('link', { name: /门店基本规则/ }).click();
    await expect(page).toHaveURL(/\/admin\/rules$/);
  });

  test('二级页签写进地址：点页签地址变、刷新还在、不认识的回到第一个；规则在最前、导入在最后', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '后台页面，只跑一次');
    await login(page, 'linlan');
    await page.goto('/admin/technicians');
    const subnav = page.getByTestId('subnav');
    await expect(subnav.getByRole('link')).toHaveText(['规则', '技师名册', '需要技师的项目']);
    await expect(page.getByTestId('subnav-rules')).toHaveAttribute('aria-current', 'page');
    // 第一个页签的内容在，别的页签的内容藏着
    await expect(page.locator('[data-subpane="rules"]')).toBeVisible();
    await expect(page.locator('[data-subpane="roster"]')).toBeHidden();
    await page.getByTestId('subnav-roster').click();
    await expect(page).toHaveURL(/\/admin\/technicians\/roster$/);
    await expect(page.getByTestId('subnav-roster')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('subnav-rules')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-subpane="roster"]')).toBeVisible();
    await expect(page.locator('[data-subpane="rules"]')).toBeHidden();
    // 侧栏里「技师」仍是当前分区
    await expect(page.getByTestId('admin-nav-technicians')).toHaveClass(/nav-on/);
    // 刷新还在这个页签
    await page.reload();
    await expect(page.getByTestId('subnav-roster')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-subpane="roster"]')).toBeVisible();
    // 浏览器的后退回到上一个页签
    await page.getByTestId('subnav-items').click();
    await expect(page).toHaveURL(/\/admin\/technicians\/items$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/technicians\/roster$/);
    // 不认识的页签：回到第一个
    await page.goto('/admin/technicians/nope');
    await expect(page).toHaveURL(/\/admin\/technicians$/);
    await expect(page.getByTestId('subnav-rules')).toHaveAttribute('aria-current', 'page');

    // 各分区页签的顺序：规则在最前，导入与工具在最后
    const tabs = async (path: string, expected: (string | RegExp)[]) => {
      await page.goto(path);
      await expect(page.getByTestId('subnav').getByRole('link')).toHaveText(expected);
    };
    // 8.0.18：「库存与采购」归了 ERP（ERP 设置 → 库存与审批开关），e2e/erp-ia.spec.ts 核对旧地址的跳转
    await tabs('/admin/rules', ['基本与收款', '交班方式', '可调的数值']);
    await tabs('/admin/tags', ['前台规则', '手牌池', '建牌与导入']);
    await tabs('/admin/dining', ['餐饮规则', '档口与出品', '桌台']);
    await tabs('/admin/rooms', ['客房规则', '房型与房价', '房间']);
    await tabs('/admin/catalog', ['消费项目', '门票', '充值套餐', '导入价目表']);
    await tabs('/admin/devices', ['设备登记表', '打印任务与设备事件', '按采购清单导入']);
    await tabs('/admin/opening', ['会员余额期初', '旧系统逐笔流水']);
    // 8.0.19：批量发券、无记名券挪到门店「会员工作台 → 发券」（e2e/store-entries.spec.ts）
    await tabs('/admin/coupons', ['发券规则', '券模板', '统计', '使用率']);
    await tabs('/admin/spaces', ['空间', '楼层与区域', '底图', '实时位置', '导入']);
    await tabs('/admin/emenu', ['设置', /^分类与版面（\d+）$/, /^菜品图文（\d+）$/]);
  });

  test('换页签不丢填到一半的东西；旧地址照旧能用', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '后台页面，只跑一次');
    await login(page, 'linlan');
    // 门店基本规则：在「基本与收款」里改门店名称（不保存），切到别的页签再回来，改的还在
    await page.goto('/admin/rules');
    const name = page.locator('#r-store');
    await expect(name).toBeVisible();
    const before = await name.inputValue();
    await name.fill(`${before}（没保存）`);
    await page.getByTestId('subnav-tunables').click();
    await expect(page).toHaveURL(/\/admin\/rules\/tunables$/);
    await expect(name).toBeHidden();
    await expect(page.locator('[data-subpane="tunables"]')).toContainText('可调的数值');
    await page.getByTestId('subnav-basic').click();
    await expect(page).toHaveURL(/\/admin\/rules$/);
    await expect(name).toHaveValue(`${before}（没保存）`);
    // 换到别的分区再回来：没保存的不留（重新读服务器上的）
    await page.getByTestId('admin-nav-settings').click();
    await page.getByTestId('admin-nav-rules').click();
    await expect(page.locator('#r-store')).toHaveValue(before);

    // 电子菜单的设置也一样（Codex 2026-11-13 P2：8.0.16 起就会丢，换页签把设置那一块卸掉了）：
    // 改了「点单密码」不保存，切到「分类与版面」再回来，改的还在、保存按钮还能点；不保存，换分区再回来就是服务器上的
    await page.goto('/admin/emenu');
    const pin = page.getByTestId('emenu-admin-settings').getByRole('radiogroup', { name: '点单密码' });
    const save = page.getByTestId('emenu-admin-settings-save');
    const was = (await pin.getByRole('radio', { name: '不要' }).getAttribute('aria-checked')) === 'true' ? '不要' : '要';
    const now = was === '不要' ? '要' : '不要';
    await expect(save).toBeDisabled();
    await pin.getByRole('radio', { name: now, exact: true }).click();
    await expect(save).toBeEnabled();
    await page.getByTestId('subnav-pages').click();
    await expect(page).toHaveURL(/\/admin\/emenu\/pages$/);
    await expect(save).toBeHidden();
    await page.getByTestId('subnav-settings').click();
    await expect(pin.getByRole('radio', { name: now, exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(save).toBeEnabled();
    await page.getByTestId('admin-nav-settings').click();
    await page.getByTestId('admin-nav-emenu').click();
    await expect(pin.getByRole('radio', { name: was, exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(save).toBeDisabled();

    // 券的旧地址 ?tab=usage：跳到页签自己的地址
    await page.goto('/admin/coupons?tab=usage');
    await expect(page).toHaveURL(/\/admin\/coupons\/usage$/);
    await expect(page.getByTestId('subnav-usage')).toHaveAttribute('aria-current', 'page');
    // 「会员权益」里的「看使用率」也到这里
    await page.goto('/admin/vip-lockers');
    await expect(page).toHaveURL(/\/admin\/membership\/benefits\?view=vip$/);
    // 深链接：直接打开某个页签
    await page.goto('/admin/spaces/plans');
    await expect(page.getByTestId('subnav-plans')).toHaveAttribute('aria-current', 'page');
    await page.goto('/admin/emenu/dishes');
    await expect(page.getByTestId('subnav-dishes')).toHaveAttribute('aria-current', 'page');
  });

  test('窄屏（平板竖屏）：一级分区横排在顶上、二级页签在标题下面，都能横向滑，页面不横向滚动', async ({ page }, info) => {
    test.skip(info.project.name !== '平板竖屏', '窄屏的排法，只在平板竖屏这一组看');
    await login(page, 'linlan');
    await page.goto('/admin/spaces');
    await expect(page.getByRole('navigation', { name: '后台分区' })).toBeVisible();
    await expect(page.getByTestId('admin-tab-devices')).toBeAttached();
    await expect(page.getByTestId('subnav')).toBeVisible();
    await page.getByTestId('subnav-import').click();
    await expect(page).toHaveURL(/\/admin\/spaces\/import$/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
