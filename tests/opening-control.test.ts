// R1.5：期初导入与 EBC 控制总数比对。导入 + 排除清单 = 控制总数（人数、本金、赠金、累计充值）四项分毫不差才能导入；
// 不一致整批不导入；正式环境必须给控制总数。排除清单（没有合格手机号等、之后补导的会员）只用来对总数。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareOpeningControl, sumOpeningCsv, type OpeningImportReport } from '../src/shared/opening-import';
import { applyOpeningImport } from '../src/server/modules/opening';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

const HEADER = '姓名,手机号,旧卡号,本金,赠金,赠金到期日,累计充值,性别,生日,备注';
const csv = [HEADER, '控甲,13900000001,K001,100,20,,1000,,,', '控乙,13900000002,K002,50.5,0,,500,,,'].join('\n');
// 排除清单：没有合格手机号的会员，这次不导入
const excluded = [HEADER, '控丙,,K003,30,5,,300,,,', '控丁,0755-1234,K004,0,0,,,,,'].join('\n');
// 控制总数（分）：导入 2 位（本金 150.50、赠金 20、累计 1500）+ 排除 2 位（本金 30、赠金 5、累计 300）
const control = { count: 4, principal: 18050, bonus: 2500, legacyRecharged: 180000 };

const body = (extra: Record<string, unknown> = {}) => ({ source: 'EBC', fileName: 'ebc.csv', note: '控制总数测试', csv, ...extra });
const importCount = async () => Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM opening_imports`)[0]!.n);

describe('排除清单与比对', () => {
  it('排除清单逐行累计人数与金额，不核对手机号；金额写错的行报错', () => {
    expect(sumOpeningCsv(excluded)).toEqual({ totals: { count: 2, principal: 3000, bonus: 500, legacyRecharged: 30000 }, errors: [] });
    const bad = sumOpeningCsv([HEADER, '甲,,,abc,,,,,,', '乙,,,10,,,,,,'].join('\n'));
    expect(bad.totals.count).toBe(1);
    expect(bad.errors).toEqual([{ line: 2, message: expect.stringContaining('本金、赠金或累计充值不正确') }]);
  });

  it('四项都一致才算一致；不一致时写明差额', () => {
    const imported = { count: 2, principal: 15050, bonus: 2000, legacyRecharged: 150000 };
    const ex = { count: 2, principal: 3000, bonus: 500, legacyRecharged: 30000 };
    expect(compareOpeningControl(control, imported, ex)).toMatchObject({ ok: true, mismatches: [] });
    const off = compareOpeningControl({ ...control, principal: 18062 }, imported, ex);
    expect(off.ok).toBe(false);
    expect(off.mismatches).toEqual(['本金：导入 + 排除 ¥180.50，控制总数 ¥180.62，少 ¥0.12']);
  });
});

describe('预览与导入', () => {
  it('预览：给了控制总数与排除清单时逐项比对；没给时不比对', async () => {
    const ok = (await api<OpeningImportReport>(ctx.app, ctx.owner, 'POST', '/api/opening-imports/preview', body({ control, excludedCsv: excluded }))).body;
    expect(ok.control).toMatchObject({ ok: true, imported: { count: 2, principal: 15050 }, excluded: { count: 2, principal: 3000 } });
    const off = (await api<OpeningImportReport>(ctx.app, ctx.owner, 'POST', '/api/opening-imports/preview', body({ control, excludedCsv: '' }))).body;
    expect(off.control?.ok).toBe(false);
    expect(off.control?.mismatches[0]).toContain('人数：导入 2 位，控制总数 4 位，少 2 位');
    expect((await api<OpeningImportReport>(ctx.app, ctx.owner, 'POST', '/api/opening-imports/preview', body())).body.control).toBeNull();
  });

  it('与控制总数不一致：整批不导入', async () => {
    const before = await importCount();
    const res = await api(ctx.app, ctx.owner, 'POST', '/api/opening-imports', body({ control: { ...control, bonus: 2400 }, excludedCsv: excluded, clientKey: randomUUID() }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OPENING_CONTROL_MISMATCH');
    expect(res.body.error.message).toContain('赠金');
    expect(await importCount()).toBe(before);
  });

  it('正式环境必须给控制总数', async () => {
    const actor = { id: ctx.ownerId, username: 'owner', displayName: '测试店主', role: 'owner' as const, duties: [], mustChangePassword: false };
    await expect(
      applyOpeningImport({ sql: ctx.sql, config: { ...ctx.config, env: 'production' } }, { ...body(), clientKey: randomUUID() }, { actor }),
    ).rejects.toMatchObject({ code: 'OPENING_CONTROL_REQUIRED' });
    expect(await importCount()).toBe(0);
  });

  it('一致时照常导入，审计里记下控制总数与排除清单合计', async () => {
    const res = await api<OpeningImportReport>(ctx.app, ctx.owner, 'POST', '/api/opening-imports', body({ control, excludedCsv: excluded, clientKey: randomUUID() }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, principalTotal: 15050, bonusTotal: 2000 });
    const [audit] = await ctx.sql<{ detail: { control: unknown; excluded: unknown } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'opening_imported' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.control).toEqual(control);
    expect(audit!.detail.excluded).toEqual({ count: 2, principal: 3000, bonus: 500, legacyRecharged: 30000 });
  });
});
