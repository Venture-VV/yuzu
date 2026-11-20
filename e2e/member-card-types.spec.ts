// 8.1.15 浏览器验收：新建会员先选卡类型、表单字段补全、实体卡押金（docs/MEMBERS_V8115.md）。
//   ① 两步：先选卡类型，再填表；选的类型固定在表单顶上，「上一步」回去改、填过的还在；匿名卡不留手机号也能建，详情写「未留手机号」；
//   ② 实体卡：填卡号、收押金（要先开班）建档 → 详情是实体卡、押着押金、储值余额不变、班次里有这笔押金 →
//     挂失（押金照旧押着）→ 补卡（押金沿用）→ 退卡全额退、记回电子卡；
//   ③ 电子卡：推荐人（找一位已有的会员）、偏好项目，建档后详情里看得到；
//   ④ 后台「建档表单」把生日设成不显示 → 建档表单里没有生日；结束时（含失败）照原样改回；
//   ⑤ 三台目标设备的尺寸上对话框不横向滚动、「建档」按钮点得到。
// 依赖演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。每次新建会员、新的卡号，可重复执行。
import { expect, test, type Page } from '@playwright/test';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';
const run = Date.now().toString(36).toUpperCase().slice(-6);
const uniquePhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-8)}`;

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

interface FormRules {
  cardDeposit: number;
  fields: Record<string, { show: boolean; required: boolean }>;
}
const formRules = async (page: Page) => (await getJson<{ rules: { memberForm: FormRules } }>(page, '/api/auth/me')).rules.memberForm;

/** 会员工作台点「新建会员」，停在第 1 步（选卡类型） */
async function openCreate(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '新建会员' }).first().click();
  const dialog = page.getByRole('dialog').filter({ hasText: '新建会员' });
  await expect(dialog.getByTestId('member-card-type-step')).toBeVisible();
  return dialog;
}

const memberIdFromUrl = (page: Page) => Number(new URL(page.url()).searchParams.get('m'));

test.describe('新建会员先选卡类型', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');

  test('两步建档：选的类型固定在顶上、上一步能改；匿名卡不留手机号也能建', async ({ page }) => {
    await login(page, 'linlan');
    const dialog = await openCreate(page);
    // 第 1 步：三种卡，各有一行说明
    for (const [id, title] of [
      ['ecard', '电子卡'],
      ['physical', '实体卡'],
      ['anonymous', '匿名卡'],
    ] as const) {
      await expect(dialog.getByTestId(`card-type-${id}`)).toContainText(title);
    }
    await expect(dialog.getByTestId('card-type-ecard')).toContainText('凭手机号认人');
    await expect(dialog.locator('#m-name')).toHaveCount(0);

    // 选电子卡：进第 2 步，类型固定在顶上；手机号必填
    await dialog.getByTestId('card-type-ecard').click();
    await expect(dialog.getByTestId('member-card-type-pinned')).toContainText('电子卡');
    await dialog.locator('#m-name').fill(`E2E 两步 ${run}`);
    await dialog.getByTestId('member-form-submit').click();
    await expect(dialog).toContainText('请输入 11 位手机号');

    // 上一步改成匿名卡：填过的姓名还在；手机号可以不留
    await dialog.getByTestId('member-form-back').click();
    await expect(dialog.getByTestId('member-card-type-step')).toBeVisible();
    await dialog.getByTestId('card-type-anonymous').click();
    await expect(dialog.getByTestId('member-card-type-pinned')).toContainText('匿名卡');
    await expect(dialog.locator('#m-name')).toHaveValue(`E2E 两步 ${run}`);
    await expect(dialog).toContainText('匿名卡可以不留');
    // 顶上那一行里也能回上一步
    await dialog.getByTestId('member-card-type-change').click();
    await dialog.getByTestId('card-type-anonymous').click();
    await dialog.getByTestId('member-form-submit').click();
    await expect(page.getByText(`已为「E2E 两步 ${run}」建档`)).toBeVisible();

    // 详情：没留手机号、匿名卡
    await expect(page.getByTestId('member-profile-extras')).toContainText('匿名卡');
    await expect(page.getByRole('heading', { name: `E2E 两步 ${run}` })).toBeVisible();
    await expect(page.getByText('未留手机号').first()).toBeVisible();
    const m = await getJson<{ phone: string | null; cardType: string }>(page, `/api/members/${memberIdFromUrl(page)}`);
    expect(m).toMatchObject({ phone: null, cardType: 'anonymous' });
  });

  test('实体卡：填卡号、收押金建档；押金押着、储值余额不变、班次里有这笔；挂失、补卡押金照旧；退卡全额退', async ({ page }) => {
    await login(page, 'linlan');
    // 收押金是收款：要先开班
    await ensureShift(page);
    const deposit = (await formRules(page)).cardDeposit;
    test.skip(deposit <= 0, '这个库把实体卡押金设成了 0（不收押金），押金的流程不走');
    const yuan = (deposit / 100).toFixed(2);
    const shiftBefore = await getJson<{ shift: { summary: { cash: { expected: number } } } }>(page, '/api/shifts/current');
    const phone = uniquePhone('197');
    const cardNo = `P${run}01`;

    const dialog = await openCreate(page);
    await dialog.getByTestId('card-type-physical').click();
    await expect(dialog.getByTestId('member-card-type-pinned')).toContainText('实体卡');
    await dialog.locator('#m-name').fill(`E2E 实体卡 ${run}`);
    await dialog.locator('#m-phone').fill(phone);
    // 没填卡号：拦下
    await dialog.getByTestId('member-form-submit').click();
    await expect(dialog).toContainText('请刷卡或输入卡号');
    await dialog.getByTestId('member-card-no').fill(cardNo.toLowerCase());
    await expect(dialog.getByTestId('card-deposit-amount')).toContainText(yuan);
    await expect(dialog.getByTestId('member-form-submit')).toContainText(`建档并收押金 ¥${yuan}`);
    await dialog.getByTestId('member-form-submit').click();
    await expect(page.getByText(`已为「E2E 实体卡 ${run}」建档`)).toBeVisible();

    // 详情：实体卡、在用的卡、押着押金；储值余额还是 0
    const id = memberIdFromUrl(page);
    const box = page.getByTestId('member-cards');
    await expect(box.getByTestId(`member-card-${cardNo}`)).toHaveAttribute('data-status', 'active');
    await expect(box.getByTestId('member-card-deposit-held')).toContainText(yuan);
    await expect(page.getByTestId('member-profile-extras')).toContainText('实体卡');
    const created = await getJson<{ principalBalance: number; bonusBalance: number; cardType: string; cardDepositHeld: number }>(page, `/api/members/${id}`);
    expect(created).toMatchObject({ principalBalance: 0, bonusBalance: 0, cardType: 'physical', cardDepositHeld: deposit });
    // 班次：应有现金多了这笔押金
    const shiftAfter = await getJson<{ shift: { summary: { cash: { expected: number; cardDeposit?: number } } } }>(page, '/api/shifts/current');
    expect(shiftAfter.shift.summary.cash.expected - shiftBefore.shift.summary.cash.expected).toBe(deposit);

    // 挂失：这张卡从此不能用，押金照旧押着
    await box.getByTestId(`member-card-lost-${cardNo}`).click();
    await expect(page.getByRole('dialog')).toContainText('照旧押着');
    await page.getByTestId('member-card-lost-reason').fill('E2E：客人说卡丢了');
    await page.getByTestId('member-card-lost-submit').click();
    await expect(box.getByTestId(`member-card-${cardNo}`)).toHaveAttribute('data-status', 'lost');
    await expect(box.getByTestId('member-card-deposit-held')).toContainText(yuan);
    // 补卡：押金沿用原来的，不另收
    const second = `P${run}02`;
    await box.getByTestId('member-card-issue-open').click();
    const again = page.getByRole('dialog').filter({ hasText: '补卡' });
    await expect(again).toContainText('押金沿用原来的');
    await expect(again.getByTestId('card-deposit-fields')).toHaveCount(0);
    await again.getByTestId('member-card-no').fill(second);
    await again.getByTestId('member-card-issue-submit').click();
    await expect(page.getByText('已补卡')).toBeVisible();
    await expect(box.getByTestId(`member-card-${second}`)).toHaveAttribute('data-status', 'active');
    await expect(box.getByTestId('member-card-deposit-held')).toContainText(yuan);

    // 退卡：写原因，押金全额退（现金）；卡记「已退卡」，人记回电子卡
    await box.getByTestId('member-card-return-open').click();
    const back = page.getByRole('dialog').filter({ hasText: '退卡' });
    await expect(back.getByTestId('card-deposit-amount')).toContainText(yuan);
    await back.getByTestId('member-card-return-reason').fill('E2E：客人不再用卡了');
    await back.getByTestId('member-card-return-submit').click();
    await expect(page.getByText('已退卡').first()).toBeVisible();
    await expect(box.getByTestId(`member-card-${second}`)).toHaveAttribute('data-status', 'returned');
    await expect(box.getByTestId('member-card-deposit-held')).toHaveCount(0);
    await expect(page.getByTestId('member-profile-extras')).toContainText('电子卡');
    const after = await getJson<{ cardType: string; cardDepositHeld: number }>(page, `/api/members/${id}`);
    expect(after).toMatchObject({ cardType: 'ecard', cardDepositHeld: 0 });
    const shiftEnd = await getJson<{ shift: { summary: { cash: { expected: number } } } }>(page, '/api/shifts/current');
    expect(shiftEnd.shift.summary.cash.expected).toBe(shiftBefore.shift.summary.cash.expected);
  });

  test('电子卡：推荐人、偏好项目；建档后详情里看得到', async ({ page }) => {
    await login(page, 'linlan');
    const refPhone = uniquePhone('196');
    const referrer = await page.request.post('/api/members', { data: { name: `E2E 介绍人 ${run}`, phone: refPhone } });
    expect(referrer.ok(), await referrer.text()).toBe(true);
    const ref = (await referrer.json()) as { id: number; memberNo: string };

    const dialog = await openCreate(page);
    await dialog.getByTestId('card-type-ecard').click();
    await dialog.locator('#m-name').fill(`E2E 被介绍 ${run}`);
    await dialog.locator('#m-phone').fill(uniquePhone('195'));
    // 会员等级：店主可以手动指定，默认按规则自动
    await expect(dialog.getByRole('radiogroup', { name: '会员等级' }).getByRole('radio', { name: '按规则自动' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByTestId('member-referrer-input').fill(refPhone);
    await dialog.getByTestId(`member-referrer-option-${ref.id}`).click();
    await expect(dialog.getByTestId('member-referrer-chosen')).toContainText(`E2E 介绍人 ${run}`);
    await dialog.getByTestId('member-preferred').fill('足疗、汗蒸');
    await dialog.getByTestId('member-form-submit').click();
    await expect(page.getByText(`已为「E2E 被介绍 ${run}」建档`)).toBeVisible();
    await expect(page.getByTestId('member-referrer')).toContainText(`E2E 介绍人 ${run}`);
    await expect(page.getByTestId('member-preferred-items')).toContainText('足疗、汗蒸');
    await expect(page.getByTestId('member-profile-extras')).toContainText('电子卡');
  });

  test('后台「建档表单」把生日设成不显示：建档表单里没有生日；结束时照原样改回', async ({ page }) => {
    await login(page, 'linlan');
    const before = await formRules(page);
    try {
      await page.goto('/admin/membership/channels');
      const card = page.getByTestId('member-form-card');
      await expect(card).toBeVisible({ timeout: 20_000 });
      const birthday = card.getByTestId('member-form-field-birthday');
      await birthday.getByRole('radio', { name: '不显示', exact: true }).click();
      // 不显示的字段不能设成必填
      await expect(birthday.getByRole('radio', { name: '必填', exact: true })).toBeDisabled();
      await card.getByTestId('member-form-save').click();
      await expect(page.getByText('建档表单已保存')).toBeVisible();
      expect((await formRules(page)).fields.birthday).toEqual({ show: false, required: false });

      const dialog = await openCreate(page);
      await dialog.getByTestId('card-type-ecard').click();
      await expect(dialog.locator('#m-name')).toBeVisible();
      await expect(dialog.locator('#m-birthday')).toHaveCount(0);
      // 别的选填项照旧
      await expect(dialog.getByTestId('member-preferred')).toBeVisible();
    } finally {
      const res = await page.request.put('/api/settings', { data: { memberForm: before } });
      expect(res.ok(), await res.text()).toBe(true);
    }
    // 改回以后生日又出来了
    const dialog = await openCreate(page);
    await dialog.getByTestId('card-type-ecard').click();
    await expect(dialog.locator('#m-birthday')).toBeVisible();
  });

  test('三台目标设备的尺寸：两步都不横向滚动，选卡类型的按钮与「建档」点得到', async ({ page }) => {
    await login(page, 'linlan');
    for (const size of [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 1355, height: 903 },
      { width: 360, height: 800 },
    ]) {
      await page.setViewportSize(size);
      const dialog = await openCreate(page);
      const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      expect(await fits(), `${size.width}×${size.height} 第 1 步横向滚动了`).toBe(true);
      for (const id of ['ecard', 'physical', 'anonymous']) await expect(dialog.getByTestId(`card-type-${id}`)).toBeInViewport();
      await dialog.getByTestId('card-type-physical').click();
      await expect(dialog.getByTestId('member-card-type-pinned')).toBeInViewport();
      await expect(dialog.getByTestId('member-form-submit')).toBeInViewport();
      expect(await fits(), `${size.width}×${size.height} 第 2 步横向滚动了`).toBe(true);
      // 表单比窗口长时滚到底：卡类型那一行还固定在顶上
      await dialog.locator('#member-form').evaluate((el) => el.parentElement?.scrollTo(0, 99_999));
      await expect(dialog.getByTestId('member-card-type-pinned')).toBeInViewport();
      const box = await dialog.getByTestId('member-form-submit').boundingBox();
      expect(box!.height, `${size.width}×${size.height} 「建档」按钮不够高`).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });
});
