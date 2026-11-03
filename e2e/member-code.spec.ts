// 前台查找框接小程序会员码（v0.7.25，docs/MINIPROGRAM.md MP9）浏览器验收：
//   扫码盒把会员码（16 或 19 位、8 或 9 开头）扫进会员工作台、接待对话框、桌台开台的查找框，yuzu 在本机校验后直接打开 / 选上那位会员；
//   门店系统没配会员码（没有 MP_CODE_SECRET，浏览器验收的环境就是这样）时写明原因、让客人报手机号，不当成手机号去搜。
// 校验通过的路径（签名、时间、绑定）由小程序线的会员码用例覆盖；这里核对页面认得出会员码、出错时写明原因。
// 同一个码先认出过、之后失效（过期、解绑）再扫（测试会话预检 a040d79）：每次扫都重新校验，不拿上一次成功的结果选人、不清空查找框，
// 校验期间回车、点选都选不到人；校验结果用 page.route 模拟（第一次认出演示会员，之后都是过期）。

import { expect, test, type Page } from '@playwright/test';
import type { MemberSummary } from '../src/shared/types';

const PASSWORD = 'yuzu2026';
/** 会员码过期时服务端的原话（src/server/modules/mp/member.ts） */
const EXPIRED = '会员码过期或不对（或微信已解绑），请让客人刷新后再扫';
/** 演示会员（seed-frontdesk-demo）的手机号 */
const HAN_PHONE = '19900008801';
const QIAO_PHONE = '19900008802';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/** 演示会员（seed-frontdesk-demo）：按手机号查 */
async function demoMember(page: Page, phone: string): Promise<MemberSummary> {
  const res = await page.request.get(`/api/members?q=${phone}`);
  expect(res.ok(), `/api/members?q=${phone} → ${res.status()}`).toBe(true);
  const [m] = (await res.json()) as MemberSummary[];
  expect(m, `演示会员 ${phone}`).toBeTruthy();
  return m!;
}

/**
 * 模拟会员码的校验：member 给了时第一次认出这位会员，之后（以及没给 member 时的每一次）都是过期（410）；
 * laterDelayMs 让过期的结果晚一点回来，核对校验期间回车不会选人。返回「校验了几次」
 */
async function mockCode(page: Page, code: string, member: MemberSummary | null, laterDelayMs = 0) {
  let calls = 0;
  await page.route(`**/api/mp-codes/${code}`, async (route) => {
    calls += 1;
    if (calls === 1 && member) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ memberId: member.id, memberNo: member.memberNo, name: member.name }) });
      return;
    }
    if (laterDelayMs) await new Promise((r) => setTimeout(r, laterDelayMs));
    await route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CODE_EXPIRED', message: EXPIRED } }) });
  });
  return () => calls;
}

test.describe('会员码', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸执行一次');

  test('会员工作台查找框扫到会员码：没配会员码时写明原因（不当手机号搜）', async ({ page }) => {
    await login(page, 'xiaozhou');
    await page.goto('/');
    const search = page.getByRole('textbox', { name: '搜索会员' });
    await search.fill('8000001123456789');
    await expect(page.getByTestId('member-search-status')).toContainText('没有配会员码');
    // 普通的搜索照常
    await search.fill('1990000');
    await expect(page.getByTestId('member-search-status')).toContainText('找到');
  });

  test('会员工作台：同一个码先认出、之后失效再扫，写明原因、保留查找框，不选回上一次的会员；校验期间回车不选人；第一次就过期的写明原因', async ({ page }) => {
    await login(page, 'xiaozhou');
    const qiao = await demoMember(page, QIAO_PHONE);
    const han = await demoMember(page, HAN_PHONE);
    const code = '8000002246813579';
    const expiredFirst = '9000000003135792468';
    const calls = await mockCode(page, code, qiao, 800);
    const expiredCalls = await mockCode(page, expiredFirst, null);
    const selected = (id: number) => new RegExp(`[?&]m=${id}(&|$)`);
    try {
      await page.goto('/');
      const search = page.getByRole('textbox', { name: '搜索会员' });
      const status = page.getByTestId('member-search-status');

      // ① 第一次扫：认出乔木，直接打开、清空查找框
      await search.fill(code);
      await expect(page).toHaveURL(selected(qiao.id));
      await expect(search).toHaveValue('');

      // ② 改看韩松；查找框留着乔木的手机号（列表里只有乔木：之后回车若用旧列表就会选到乔木）
      await search.fill(HAN_PHONE);
      await expect(status).toHaveText('找到 1 位会员');
      await page.getByRole('listbox', { name: '会员列表' }).getByRole('option').filter({ hasText: '韩松' }).click();
      await expect(page).toHaveURL(selected(han.id));
      await search.fill(QIAO_PHONE);
      await expect(status).toHaveText('找到 1 位会员');

      // ③ 同一个码再扫（这次过期、校验晚 0.8 秒回来），扫码盒紧跟回车：校验期间不选人，过期后写明原因、查找框留着码
      await search.fill(code);
      await search.press('Enter');
      await expect(status).toHaveText('核对会员码…');
      await expect(status).toHaveText(EXPIRED);
      await expect(search).toHaveValue(code);
      await expect(page).toHaveURL(selected(han.id));
      await search.press('Enter');
      await expect(page).toHaveURL(selected(han.id));
      expect(calls()).toBe(2);

      // ④ 对照：第一次就过期的码，同样写明原因、保留查找框
      await search.fill(expiredFirst);
      await expect(status).toHaveText(EXPIRED);
      await expect(search).toHaveValue(expiredFirst);
      await expect(page).toHaveURL(selected(han.id));
      expect(expiredCalls()).toBe(1);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });

  test('接待发牌：同一个码先选上、换人后失效再扫，写明原因、保留查找框，不选回上一次的会员；第一次就过期的写明原因', async ({ page }) => {
    await login(page, 'xiaozhou');
    const qiao = await demoMember(page, QIAO_PHONE);
    const code = '8000003357924680';
    const expiredFirst = '9000000004246813579';
    const calls = await mockCode(page, code, qiao);
    const expiredCalls = await mockCode(page, expiredFirst, null);
    try {
      await page.goto('/frontdesk');
      await expect(page.getByTestId('tag-board')).toBeVisible();
      await page.keyboard.press('F2');
      const dialog = page.getByRole('dialog', { name: '接待发牌' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('radiogroup', { name: '客人类型' }).getByRole('radio', { name: '会员' }).click();
      const search = dialog.getByLabel('查找会员');

      // ① 第一次扫：直接选上乔木
      await search.fill(code);
      await expect(dialog.getByTestId('checkin-member')).toContainText('乔木');
      // ② 换人，再扫同一个码（这次过期）：写明原因、查找框留着码、没有选上会员
      await dialog.getByTestId('checkin-member').getByRole('button', { name: '换人' }).click();
      await expect(dialog.getByTestId('checkin-member')).toHaveCount(0);
      await search.fill(code);
      await expect(dialog.getByTestId('checkin-member-code-error')).toHaveText(EXPIRED);
      await expect(search).toHaveValue(code);
      await expect(dialog.getByTestId('checkin-member')).toHaveCount(0);
      expect(calls()).toBe(2);

      // ③ 对照：第一次就过期的码
      await search.fill(expiredFirst);
      await expect(dialog.getByTestId('checkin-member-code-error')).toHaveText(EXPIRED);
      await expect(search).toHaveValue(expiredFirst);
      await expect(dialog.getByTestId('checkin-member')).toHaveCount(0);
      expect(expiredCalls()).toBe(1);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });
});
