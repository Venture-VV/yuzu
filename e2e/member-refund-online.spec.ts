// 退储值「门店系统原路退回」的浏览器验收（v0.7.29；main v0.7.27 定时测试报告里小程序线转来的 ②，PR #54 上答应 2d 合并后补）：
//   这个选项要小程序线的原路退回能接才出现：门店系统的微信支付配好（演示库、本机用模拟微信支付 MP_PAY_MOCK=true）、
//   小程序端口开着（MP_PORT、MP_GATEWAY_KEY）、后台「线上充值」开着原路退回。平时的浏览器验收不开小程序端口，
//   所以 playwright.config.ts 只在设了 E2E_MP_PORT 与 E2E_MP_GATEWAY_KEY（与应用的 MP_PORT、MP_GATEWAY_KEY 相同）时才收这个文件，
//   只在门店电脑尺寸跑。流程：
//   ① 小程序端口上（照网关的样子带网关密钥与 openid）绑定一位新会员、线上充值 5,000 元并模拟付款；
//   ② 店员在会员详情「储值与账户」退储值：线上充值那一行默认「门店系统原路退回」、不用填退款单号，店主当场授权；
//   ③ 列表写「门店系统原路退回」；每分钟的处理取走以后，后台「线上充值」的原路退回单里有这一笔、按模拟微信支付申请了退款。
//   用例开头记下小程序开关与线上充值规则，结束时（含失败）照原样改回。每次新建会员、新的 openid，可重复执行。

import { randomUUID } from 'node:crypto';
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test';
import type { MpRechargeAdminData, MpRechargeRules } from '../src/shared/mp';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';
const MP_URL = `http://127.0.0.1:${process.env.E2E_MP_PORT ?? ''}`;
const GATEWAY_KEY = process.env.E2E_MP_GATEWAY_KEY ?? '';
// 与 src/shared/mp.ts 的 MP_GATEWAY_HEADER、MP_OPENID_HEADER 相同（网关转发时带的两个头）
const GATEWAY_HEADER = 'x-mp-gateway-key';
const OPENID_HEADER = 'x-mp-openid';
const AMOUNT = 5_000_00;

async function login(page: Page, username: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function call<T>(api: APIRequestContext, method: 'GET' | 'POST' | 'PUT', url: string, data?: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await api.fetch(url, { method, ...(data === undefined ? {} : { data }), ...(headers ? { headers } : {}) });
  expect(res.ok(), `${method} ${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** 照网关的样子调小程序端口（带网关密钥与顾客的 openid） */
const mp = <T>(api: APIRequestContext, method: 'GET' | 'POST', path: string, openid: string, data?: unknown) =>
  call<T>(api, method, `${MP_URL}${path}`, data, { [GATEWAY_HEADER]: GATEWAY_KEY, [OPENID_HEADER]: openid });

const uniquePhone = () => `194${String(Date.now()).slice(-8)}`;

test.describe('退储值：门店系统原路退回', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(180_000);

  test('线上充值那一行默认交给门店系统原路退回、不用填退款单号；店主授权后列表写明，后台的原路退回单里有这一笔', async ({ page, baseURL }) => {
    // 店主的接口会话：开小程序、开原路退回，结束时改回
    const owner = await pwRequest.newContext({ baseURL });
    await call(owner, 'POST', '/api/auth/login', { username: 'linlan', password: PASSWORD });
    const before = await call<MpRechargeAdminData>(owner, 'GET', '/api/admin/mp/recharge');
    expect(before.payMode, '应用要用模拟微信支付启动（MP_PAY_MOCK=true）并开小程序端口').toBe('mock');
    const admin = await call<{ rules: { enabled: boolean } }>(owner, 'GET', '/api/admin/mp');
    const saved: MpRechargeRules = before.rules;
    try {
      await call(owner, 'PUT', '/api/admin/mp/rules', { enabled: true });
      const maxCents = Math.min(Math.max(saved.maxCents, AMOUNT), before.counterMaxCents);
      await call(owner, 'PUT', '/api/admin/mp/recharge/rules', {
        enabled: true,
        planIds: saved.planIds,
        customEnabled: true,
        maxCents,
        dailyLimit: Math.max(saved.dailyLimit, 1),
        refundAuto: true,
      });

      // ① 新会员在小程序上绑定、线上充值 5,000 元（模拟付款）
      const phone = uniquePhone();
      const member = await call<{ id: number }>(owner, 'POST', '/api/members', { name: 'E2E 原路退回会员', phone });
      const openid = `openid-e2e-${randomUUID().slice(0, 12)}`;
      const v0 = (await mp<{ bindVersion: number }>(owner, 'GET', '/api/mp/me', openid)).bindVersion;
      await mp(owner, 'POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: v0, mock: true });
      const v1 = (await mp<{ bindVersion: number }>(owner, 'GET', '/api/mp/me', openid)).bindVersion;
      const created = await mp<{ order: { orderNo: string } }>(owner, 'POST', '/api/mp/recharge/orders', openid, { clientKey: randomUUID(), amount: AMOUNT, bindVersion: v1 });
      const paid = await mp<{ status: string }>(owner, 'POST', `/api/mp/recharge/orders/${created.order.orderNo}/mock-pay`, openid, {});
      expect(paid.status).toBe('paid');

      // ② 店员退储值：线上充值那一行默认「门店系统原路退回」，不用填退款单号
      await login(page, 'xiaozhou');
      await ensureShift(page);
      await page.goto(`/?m=${member.id}`);
      const card = page.getByTestId('member-account');
      await expect(card).toContainText('没有退过储值');
      await card.getByTestId('member-refund-open').click();
      const dialog = page.getByRole('dialog').filter({ hasText: '退储值' });
      await dialog.getByTestId('member-refund-amount').fill('5000');
      const line = dialog.getByTestId('member-refund-line-0');
      await expect(line).toContainText('小程序');
      await expect(line).toContainText('5,000.00');
      await expect(dialog.getByTestId('member-refund-route-0')).toHaveValue('mp_auto');
      await expect(dialog.getByTestId('member-refund-route-hint-0')).toContainText('门店系统会自动原路退回到顾客的微信');
      await expect(line.getByLabel('退款单号')).toHaveCount(0);
      // 改成「已在商户平台退过」要填退款单号，改回来就不用
      await dialog.getByTestId('member-refund-route-0').selectOption('manual');
      await expect(line.getByLabel('退款单号')).toBeVisible();
      await dialog.getByTestId('member-refund-route-0').selectOption('mp_auto');
      await expect(line.getByLabel('退款单号')).toHaveCount(0);
      await dialog.getByTestId('member-refund-reason').fill('E2E：顾客要求退回线上充值');
      await dialog.getByTestId('member-refund-submit').click();
      const auth = page.getByRole('dialog', { name: /^当场授权/ });
      await expect(auth).toBeVisible();
      await auth.getByLabel('授权人账号').fill('linlan');
      await auth.getByLabel('授权人密码').fill(PASSWORD);
      await auth.getByTestId('authorize-submit').click();
      await expect(auth).toBeHidden();
      await expect(page.getByText('已退储值')).toBeVisible();

      // ③ 列表写明交给门店系统原路退回；每分钟的处理取走以后，后台的原路退回单里有这一笔
      const list = card.getByTestId('member-refund-list');
      await expect(list).toContainText('门店系统原路退回');
      await expect(list).toContainText('5,000.00');
      await expect
        .poll(
          async () => {
            const data = await call<MpRechargeAdminData>(owner, 'GET', '/api/admin/mp/recharge');
            return data.refunds.find((r) => r.memberId === member.id)?.amount ?? 0;
          },
          { timeout: 120_000, intervals: [5_000], message: '每分钟的处理应取走交给门店系统的那一行、建原路退回单' },
        )
        .toBe(AMOUNT);
    } finally {
      // 照原样改回：线上充值规则、小程序开关
      await call(owner, 'PUT', '/api/admin/mp/recharge/rules', {
        enabled: saved.enabled,
        planIds: saved.planIds,
        customEnabled: saved.customEnabled,
        maxCents: saved.maxCents,
        dailyLimit: saved.dailyLimit,
        refundAuto: saved.refundAuto,
      });
      await call(owner, 'PUT', '/api/admin/mp/rules', { enabled: admin.rules.enabled });
      await owner.dispose();
    }
  });
});
