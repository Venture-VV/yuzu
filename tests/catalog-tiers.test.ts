// Batch 2.3：消费项目多档价格与属性、汤崎价目表导入（店主 2026-10-27 #8）。
//   · 同一项目可设标准 / 专业 / 优选多档价格；默认档 = 标准 → 专业 → 优选中第一个提供的，service_items.price 与之一致；
//   · 会员消费与前台挂账按所选档位计价，明细留存档位与带档位的名称；不带档位的旧请求按默认档计价；
//   · 只限某一性别的项目（私汤木桶浴仅女宾）在前台按客人分区核对；属性不影响计价；
//   · 价目表按名称导入：预览不写入、以清单为准更新价格与排序、清单里留空的属性保持现有设置。

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePriceListCsv } from '../src/shared/price-list-import';
import { TANGQI_PRICE_LIST_CSV } from '../src/server/demo/price-list-tangqi-2026-10-27';
import { api, createMember, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Item = { id: number; name: string; price: number; prices: { tier: string; price: number }[]; active: boolean; sortOrder: number } & Record<string, unknown>;
const items = async (all = true) => (await api(ctx.app, ctx.owner, 'GET', `/api/catalog${all ? '?all=1' : ''}`)).body.items as Item[];
const itemNamed = async (name: string) => (await items()).find((i) => i.name === name)!;
const saveItem = (body: Record<string, unknown>, id?: number) =>
  id ? api(ctx.app, ctx.owner, 'PUT', `/api/items/${id}`, body) : api(ctx.app, ctx.owner, 'POST', '/api/items', body);

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

describe('项目多档价格与属性', () => {
  it('多档项目：价格按标准、专业、优选排序，默认档价格写入 price；只提供「专业」档时默认档为专业', async () => {
    const r = await saveItem({
      name: '泰式经典按摩',
      category: '全身按摩',
      prices: { standard: 40900, professional: 48900, premium: null },
      durationMinutes: 90,
      strength: 'strong',
      essentialOil: false,
      heatTherapy: true,
      popular: true,
      note: '含热敷',
    });
    expect(r.status).toBe(200);
    expect(await itemNamed('泰式经典按摩')).toMatchObject({
      price: 40900,
      prices: [
        { tier: 'standard', price: 40900 },
        { tier: 'professional', price: 48900 },
      ],
      durationMinutes: 90,
      gender: null,
      strength: 'strong',
      essentialOil: false,
      heatTherapy: true,
      popular: true,
      note: '含热敷',
    });
    await saveItem({ name: '运动筋膜舒压', category: '全身按摩', prices: { professional: 58900 }, durationMinutes: 90 });
    expect(await itemNamed('运动筋膜舒压')).toMatchObject({ price: 58900, prices: [{ tier: 'professional', price: 58900 }] });
    // 只有一个价格的旧写法：记为标准档
    await saveItem({ name: '柠檬水', category: '饮品', price: 1800 });
    expect(await itemNamed('柠檬水')).toMatchObject({ price: 1800, prices: [{ tier: 'standard', price: 1800 }] });
  });

  it('修改价格档：去掉标准档后默认档变为专业；至少要有一档；店员不能维护项目', async () => {
    const item = await itemNamed('泰式经典按摩');
    const r = await saveItem({ name: item.name, category: '全身按摩', prices: { professional: 49900, premium: 55900 }, durationMinutes: 90 }, item.id);
    expect(r.status).toBe(200);
    expect(await itemNamed('泰式经典按摩')).toMatchObject({
      price: 49900,
      prices: [
        { tier: 'professional', price: 49900 },
        { tier: 'premium', price: 55900 },
      ],
    });
    const empty = await saveItem({ name: '空价格', prices: { standard: null } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain('至少填写一档价格');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/items', { name: '店员项目', price: 100 })).status).toBe(403);
    // 恢复标准档供后续用例使用（PUT 是整体替换，属性一并写回）
    await saveItem(
      { name: item.name, category: '全身按摩', prices: { standard: 40900, professional: 48900 }, durationMinutes: 90, strength: 'strong', heatTherapy: true, popular: true, note: '含热敷' },
      item.id,
    );
  });
});

describe('会员消费按档计价', () => {
  let memberId: number;
  beforeAll(async () => {
    memberId = (await createMember(ctx, '分档会员', '19900003301')).id;
    await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(memberId, 500000));
  });
  const consume = (lines: unknown[], expectedTotal: number, key = randomUUID()) =>
    api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', {
      idempotencyKey: key,
      memberId,
      lines,
      expectedTotal,
      expectedSplit: { principal: expectedTotal, bonus: 0 },
    });

  it('选「专业」档按专业价扣款，明细留存档位与带档位的名称；单档项目名称不变', async () => {
    const thai = await itemNamed('泰式经典按摩');
    const lemon = await itemNamed('柠檬水');
    const key = randomUUID();
    const r = await consume(
      [
        { itemId: thai.id, quantity: 1, tier: 'professional' },
        { itemId: lemon.id, quantity: 2 },
      ],
      48900 + 3600,
      key,
    );
    expect(r.status).toBe(200);
    expect(r.body.consumption.lines).toMatchObject([
      { itemId: thai.id, tier: 'professional', name: '泰式经典按摩（专业）', unitPrice: 48900, quantity: 1, amount: 48900 },
      { itemId: lemon.id, tier: 'standard', name: '柠檬水', unitPrice: 1800, quantity: 2, amount: 3600 },
    ]);
    // 同一编号原样重提：返回第一次的结果
    const replay = await consume(
      [
        { itemId: thai.id, quantity: 1, tier: 'professional' },
        { itemId: lemon.id, quantity: 2 },
      ],
      48900 + 3600,
      key,
    );
    expect(replay.body.replayed).toBe(true);
  });

  it('不带档位（升级前的待确认请求）按默认档计价；项目没有的档位、价格变动都要求重新选择', async () => {
    const thai = await itemNamed('泰式经典按摩');
    const legacy = await consume([{ itemId: thai.id, quantity: 1 }], 40900);
    expect(legacy.status).toBe(200);
    expect(legacy.body.consumption.lines[0]).toMatchObject({ tier: 'standard', name: '泰式经典按摩（标准）', unitPrice: 40900 });
    const noPremium = await consume([{ itemId: thai.id, quantity: 1, tier: 'premium' }], 50000);
    expect(noPremium.status).toBe(409);
    expect(noPremium.body.error).toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    expect(noPremium.body.error.message).toContain('优选');
    const stale = await consume([{ itemId: thai.id, quantity: 1, tier: 'professional' }], 47900);
    expect(stale.body.error.code).toBe('PRICE_CHANGED');
    const bad = await consume([{ itemId: thai.id, quantity: 1, tier: 'vip' }], 48900);
    expect(bad.status).toBe(400);
  });
});

describe('前台挂账按档计价与性别限定', () => {
  let maleVisit: number;
  let femaleVisit: number;
  beforeAll(async () => {
    await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'A', from: 1, to: 3, width: 3, zone: 'male' });
    await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'B', from: 1, to: 3, width: 3, zone: 'female' });
    await saveItem({ name: '私汤木桶浴', category: '沐浴项目', prices: { standard: 18900 }, durationMinutes: 20, gender: 'female' });
    const checkin = async (tagCode: string, zone: string) =>
      (await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone }] })).body.visits[0].id as number;
    maleVisit = await checkin('A001', 'male');
    femaleVisit = await checkin('B001', 'female');
  });
  const post = (visitId: number, lines: unknown[], expectedTotal: number) =>
    api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines, expectedTotal });

  it('挂「专业」档：明细名称带档位、记下档位，账单合计按专业价；自检通过', async () => {
    const thai = await itemNamed('泰式经典按摩');
    const r = await post(maleVisit, [{ itemId: thai.id, quantity: 1, tier: 'professional' }], 48900);
    expect(r.status).toBe(200);
    expect(r.body.lines[0]).toMatchObject({ tier: 'professional', name: '泰式经典按摩（专业）', unitPrice: 48900, amount: 48900 });
    expect(r.body.bill.amountCents).toBe(48900);
    for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body) expect(c, c.label).toMatchObject({ ok: true });
  });

  it('仅女宾的项目不能挂到男宾手牌，女宾可以', async () => {
    const bath = await itemNamed('私汤木桶浴');
    const male = await post(maleVisit, [{ itemId: bath.id, quantity: 1 }], 18900);
    expect(male.status).toBe(422);
    expect(male.body.error).toMatchObject({ code: 'ITEM_GENDER' });
    expect(male.body.error.message).toContain('仅限女宾');
    const female = await post(femaleVisit, [{ itemId: bath.id, quantity: 1 }], 18900);
    expect(female.status).toBe(200);
    expect(female.body.lines[0]).toMatchObject({ name: '私汤木桶浴', tier: 'standard', amount: 18900 });
  });

  it('数据库层：挂账明细名称放宽到 48 字，带档位的长名称也能留存', async () => {
    const name = '砭石香薰肩颈舒压、采耳、按头、按肩、按手、眼部热疗';
    await saveItem({ name, category: '大堂按摩', prices: { standard: 20900, professional: 24900, premium: 24900 }, durationMinutes: 45 });
    const item = await itemNamed(name);
    const r = await post(femaleVisit, [{ itemId: item.id, quantity: 1, tier: 'premium' }], 24900);
    expect(r.status).toBe(200);
    expect(r.body.lines.at(-1)).toMatchObject({ name: `${name}（优选）`, tier: 'premium' });
  });
});

describe('价目表导入', () => {
  it('内置的汤崎价目表与 docs/data 下的 CSV 逐字一致：29 个项目、无错误', async () => {
    const file = await readFile(new URL('../docs/data/price-list-tangqi-2026-10-27.csv', import.meta.url), 'utf8');
    expect(TANGQI_PRICE_LIST_CSV.trim()).toBe(file.trim());
    const parsed = parsePriceListCsv(file);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(29);
    expect(parsed.rows.find((r) => r.name === '运动筋膜舒压')!.prices).toEqual([{ tier: 'professional', price: 58900 }]);
    expect(parsed.rows.find((r) => r.name === '私汤木桶浴')).toMatchObject({ gender: 'female', durationMinutes: 20, prices: [{ tier: 'standard', price: 18900 }] });
    expect(parsed.rows.find((r) => r.name.startsWith('砭石香薰'))!.prices.map((p) => p.tier)).toEqual(['standard', 'professional', 'premium']);
  });

  it('预览不写入；正式导入以价目表为准更新已有项目，属性留空时保持现有设置；再导一次全部未变', async () => {
    const rows = parsePriceListCsv(TANGQI_PRICE_LIST_CSV).rows;
    const before = await items();
    // 已有「泰式经典按摩」（属性：力道强劲、热疗、超人气）与「私汤木桶浴」「砭石香薰…」「运动筋膜舒压」
    const preview = (await api(ctx.app, ctx.owner, 'POST', '/api/items/import', { rows })).body;
    expect(preview).toMatchObject({ dryRun: true, total: 29, created: 25, updated: 4, unchanged: 0, deactivated: 0 });
    expect(await items()).toEqual(before);

    const applied = (await api(ctx.app, ctx.owner, 'POST', '/api/items/import', { rows, dryRun: false })).body;
    expect(applied).toMatchObject({ dryRun: false, created: 25, updated: 4 });
    const thai = await itemNamed('泰式经典按摩');
    expect(thai).toMatchObject({
      category: '全身按摩 · 基础系列',
      price: 40900,
      prices: [
        { tier: 'standard', price: 40900 },
        { tier: 'professional', price: 48900 },
      ],
      strength: 'strong',
      heatTherapy: true,
      popular: true,
      note: '含热敷',
    });
    // 排序按价目表顺序
    const all = await items(false);
    const listed = all.filter((i) => rows.some((r) => r.name === i.name));
    expect(listed.map((i) => i.name)).toEqual(rows.map((r) => r.name));
    const again = (await api(ctx.app, ctx.owner, 'POST', '/api/items/import', { rows, dryRun: false })).body;
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 29 });
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM audit_logs WHERE action = 'price_list_imported'`;
    expect(audit!.n).toBe(2);
  });

  it('表格补齐属性后再导入：属性按表格更新；勾选「停用价目表外的项目」时停用其余项目，历史明细不受影响', async () => {
    const csv = TANGQI_PRICE_LIST_CSV.replace('全身按摩 · 基础系列,日式指压,90,,409,489,,,,,,', '全身按摩 · 基础系列,日式指压,90,,409,489,,适中,否,否,是,招牌项目');
    const rows = parsePriceListCsv(csv).rows;
    const r = (await api(ctx.app, ctx.owner, 'POST', '/api/items/import', { rows, deactivateMissing: true, dryRun: false })).body;
    expect(r).toMatchObject({ updated: 1, unchanged: 28, deactivated: 1 });
    expect(r.samples.deactivated).toEqual(['柠檬水']);
    expect(await itemNamed('日式指压')).toMatchObject({ strength: 'medium', essentialOil: false, heatTherapy: false, popular: true, note: '招牌项目' });
    expect((await itemNamed('柠檬水')).active).toBe(false);
    // 停用前的消费明细原样保留
    const [line] = await ctx.sql<{ name: string }[]>`SELECT name FROM consumption_lines WHERE name = '柠檬水' LIMIT 1`;
    expect(line!.name).toBe('柠檬水');
  });

  it('清单校验与权限：重复项目、没有价格的项目拒绝；已有同名项目不止一个时拒绝；店员不能导入', async () => {
    const dup = await api(ctx.app, ctx.owner, 'POST', '/api/items/import', {
      rows: [
        { category: 'A', name: '重复', durationMinutes: null, gender: null, prices: [{ tier: 'standard', price: 100 }] },
        { category: 'A', name: '重复', durationMinutes: null, gender: null, prices: [{ tier: 'standard', price: 200 }] },
      ],
    });
    expect(dup.status).toBe(400);
    const noPrice = await api(ctx.app, ctx.owner, 'POST', '/api/items/import', {
      rows: [{ category: 'A', name: '无价', durationMinutes: null, gender: null, prices: [] }],
    });
    expect(noPrice.status).toBe(400);
    await ctx.sql`INSERT INTO service_items (name, price) VALUES ('同名项目', 100), ('同名项目', 200)`;
    const ambiguous = await api(ctx.app, ctx.owner, 'POST', '/api/items/import', {
      rows: [{ category: 'A', name: '同名项目', durationMinutes: null, gender: null, prices: [{ tier: 'standard', price: 300 }] }],
    });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe('ITEM_AMBIGUOUS');
    const rows = parsePriceListCsv(TANGQI_PRICE_LIST_CSV).rows;
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/items/import', { rows })).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/items/price-lists')).status).toBe(403);
    const lists = (await api(ctx.app, ctx.owner, 'GET', '/api/items/price-lists')).body;
    expect(lists).toEqual([{ key: 'tangqi-2026-10-27', title: '汤崎价目表（店主 2026-10-27）', csv: TANGQI_PRICE_LIST_CSV }]);
  });

  it('CSV 解析：中文表头、「—」表示不提供、逐行报出错误', () => {
    const ok = parsePriceListCsv('﻿分类,项目,时长,性别,标准,专业,优选,力道,精油,热疗,超人气\r\n理疗系列,火罐 / 刮痧,30 分钟,,189,219,—,强劲,否,是,\r\n');
    expect(ok.errors).toEqual([]);
    expect(ok.rows).toEqual([
      {
        category: '理疗系列',
        name: '火罐 / 刮痧',
        durationMinutes: 30,
        gender: null,
        prices: [
          { tier: 'standard', price: 18900 },
          { tier: 'professional', price: 21900 },
        ],
        strength: 'strong',
        essentialOil: false,
        heatTherapy: true,
      },
    ]);
    const bad = parsePriceListCsv('name,standard,professional,gender,strength\n甲,abc,,,\n乙,—,—,,\n丙,100,,child,\n丁,100,,,很重\n甲,200,,,\n');
    expect(bad.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(bad.errors[1]!.message).toContain('至少要有一档价格');
    expect(bad.errors[2]!.message).toContain('性别');
    expect(bad.errors[3]!.message).toContain('力道');
    expect(bad.rows.map((r) => r.name)).toEqual(['甲']);
    expect(parsePriceListCsv('a,b\n1,2').errors[0]!.message).toContain('表头缺少');
  });
});
