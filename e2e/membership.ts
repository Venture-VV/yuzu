// 会员体系 v2（v0.7.23）：首充 / 续充单笔最低默认 5,000 元。之前的用例按小额套餐（轻享 300、常泡 500）充值，
// 这些用例开始前用店主账号把最低充值设成不限，结束后恢复原来的规则（在演示库上跑也不留改动）。
// 演示数据的会员累计充值都在 1 万以下（L0、L1，赠送比例 0），小额充值没有赠金，原来按余额核对的用例照旧成立。

import { request, test } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

async function ownerApi() {
  const api = await request.newContext({ baseURL: BASE });
  const r = await api.post('/api/auth/login', { data: { username: 'linlan', password: 'yuzu2026' } });
  if (!r.ok()) throw new Error(`店主登录失败（${r.status()}）`);
  return api;
}

export function relaxRechargeMinimum() {
  let saved: Record<string, unknown> | null = null;
  test.beforeAll(async () => {
    const api = await ownerApi();
    saved = (await (await api.get('/api/membership/rules')).json()) as Record<string, unknown>;
    const r = await api.put('/api/membership/rules', { data: { ...saved, firstRechargeMinCents: 0, topUpMinCents: 0 } });
    if (!r.ok()) throw new Error(`改最低充值失败（${r.status()}）：${await r.text()}`);
    await api.dispose();
  });
  test.afterAll(async () => {
    if (!saved) return;
    const api = await ownerApi();
    await api.put('/api/membership/rules', { data: saved });
    await api.dispose();
  });
}
