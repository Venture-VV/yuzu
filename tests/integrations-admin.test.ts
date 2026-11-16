// 8.0.21 后台「对外接口」（docs/INTEGRATIONS_V8021.md 第 1 节）：模式只看运行环境、门店开关默认开、最近的对外调用。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadIntegrationsConfig, modeOf } from '../src/server/integrations/config';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup();
}, 60_000);
afterAll(async () => ctx.close());

describe('对外接口', () => {
  it('模式：模拟只许开发、测试实例；和正式密钥同时配置拒绝；正式的要那一样的变量都在', () => {
    expect(() => loadIntegrationsConfig({ INTEGRATIONS_MOCK: 'true' }, 'production', 'demo')).toThrow(/只能用在/);
    expect(() => loadIntegrationsConfig({ INTEGRATIONS_MOCK: 'true' }, 'development', 'prod')).toThrow(/不能用在 prod/);
    expect(() => loadIntegrationsConfig({ INTEGRATIONS_MOCK: 'true', MEITUAN_APP_KEY: 'x' }, 'development', 'demo')).toThrow(/不能和正式接口的密钥同时配置/);
    const half = loadIntegrationsConfig({ WXPAY_MICRO_MCH_ID: '1', WXPAY_MICRO_APP_ID: '2' }, 'production', 'prod');
    expect(modeOf(half, 'pay_terminal')).toBe('off');
    const full = loadIntegrationsConfig({ WXPAY_MICRO_MCH_ID: '1', WXPAY_MICRO_APP_ID: '2', WXPAY_MICRO_API_KEY: '3' }, 'production', 'prod');
    expect(modeOf(full, 'pay_terminal')).toBe('live');
    expect(modeOf(full, 'platform_voucher')).toBe('off');
  });

  it('后台看模式、门店开关（默认开、06:10）、改开关只改提交的字段；关了扫码收款以后收不了；要「门店设置」', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/integrations')).status).toBe(403);
    const info = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/integrations')).body;
    expect(info.kinds.map((k: { kind: string; mode: string }) => [k.kind, k.mode])).toEqual([
      ['pay_terminal', 'mock'],
      ['platform_voucher', 'mock'],
      ['einvoice', 'mock'],
      ['bank_direct', 'off'],
      ['ota', 'off'],
      // AI 辅助（8.0.22）：模拟模式下也是模拟
      ['ai', 'mock'],
    ]);
    expect(info.switches).toEqual({ payTerminal: true, platformVoucher: true, voucherReconcileAt: '06:10' });
    expect(JSON.stringify(info)).not.toMatch(/WXPAY_MICRO_API_KEY.*=/);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/integrations/switches', { voucherReconcileAt: '25:00' })).status).toBe(400);
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/integrations/switches', { payTerminal: false });
    expect(saved.body).toEqual({ payTerminal: false, platformVoucher: true, voucherReconcileAt: '06:10' });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/pay/terminal/status')).body).toEqual({ mode: 'mock', enabled: false });
    await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 });
    const blocked = await api(ctx.app, ctx.clerk, 'POST', '/api/pay/terminal', { clientKey: randomUUID(), provider: 'wechat', purpose: 'checkout', amountCents: 100, authCode: '134500000000008888' });
    expect(blocked.body.error.code).toBe('PAY_TERMINAL_OFF');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/integrations/switches', { payTerminal: true })).status).toBe(200);
    // 最近的对外调用：扫一次，后台看得到（付款码只留后四位）
    expect(
      (await api(ctx.app, ctx.clerk, 'POST', '/api/pay/terminal', { clientKey: randomUUID(), provider: 'wechat', purpose: 'checkout', amountCents: 100, authCode: '134500000000008888' })).status,
    ).toBe(201);
    const calls = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/integrations/calls?kind=pay_terminal')).body;
    expect(calls[0]).toMatchObject({ kind: 'pay_terminal', action: 'pay', mode: 'mock', ok: true, staffName: '测试店员' });
    expect(calls[0].request.authCode).toBe('******8888');
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/admin/integrations/calls?failed=1')).body.every((c: { ok: boolean }) => !c.ok)).toBe(true);
  });
});
