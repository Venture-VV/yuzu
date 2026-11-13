// 8.0.13 电子菜单整改（docs/EMENU.md 第 11 节）里服务端的部分：菜品与规格的英文、设置里的中英切换 / 选项的英文 / 动效、
// 平板菜单带出这些、英文对照表的导出与导入（只更新英文、空着的不动、编号对不上的跳过、再导一次不变）。
// 下单不受语言影响：交的仍是中文选项，进厨房的备注是中文。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EMENU_RULES, EMENU_ENGLISH_COLUMNS, parseEmenuEnglishCsv, type EmenuAdmin, type EmenuEnglishResult, type EmenuMenu } from '../src/shared/emenu';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let pad: string;
const item: Record<string, number> = {};
const dish: Record<string, number> = {};

const admin = async () => (await api<EmenuAdmin>(ctx.app, ctx.owner, 'GET', '/api/admin/emenu')).body;
const menu = async () => (await api<EmenuMenu>(ctx.app, pad, 'GET', '/api/emenu/menu')).body;
const rules = async (patch: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/emenu/rules', { rev: (await admin()).rulesRev, ...patch });
const dishOnMenu = async (id: number) =>
  (await menu()).categories
    .flatMap((c) => c.pages)
    .flatMap((p) => p.dishes)
    .find((d) => d?.id === id)!;
const sheet = async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/emenu/english.csv', headers: { cookie: ctx.owner } });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/csv');
  return res.body;
};
const importRows = (rows: unknown[], cookie = ctx.owner) => api<EmenuAdmin & { english: EmenuEnglishResult; error: { code: string } }>(ctx.app, cookie, 'POST', '/api/admin/emenu/english', { rows });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'pad1', displayName: '一号桌平板', role: 'tablet', password: PASSWORD, mustChangePassword: false });
  pad = await login(ctx.app, 'pad1');
  for (const [name, price] of [
    ['砂锅焗溪鳗（大份）', 8800],
    ['砂锅焗溪鳗（小份）', 4800],
    ['龙虾班尼迪蛋', 4200],
    ['小梦若奇白葡萄酒', 28800],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category: '午餐', price });
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '厨房' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '厨房').id;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: Object.values(item).map((id) => ({ id, stationId })) })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
});

afterAll(async () => {
  await ctx?.close();
});

describe('菜品与规格的英文', () => {
  it('新建、修改都能带英文各项；不带就是空的；长度与行数有上限', async () => {
    // 不带英文：都是空的（与 8.0.12 建菜品的请求一样）
    let r = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', { name: '龙虾班尼迪蛋', nameEn: 'Lobster Eggs Benedict', description: '现拆龙虾肉，荷兰汁。', specs: [{ itemId: item['龙虾班尼迪蛋'] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const egg = r.body.dishes.find((d) => d.name === '龙虾班尼迪蛋')!;
    dish.egg = egg.id;
    expect([egg.taglineEn, egg.descriptionEn, egg.attrsEn, egg.unitEn, egg.specs[0]!.labelEn]).toEqual(['', '', [], '', '']);

    // 带英文：两个规格各有英文
    r = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', {
      name: '砂锅焗溪鳗',
      nameEn: 'Clay Pot Baked Stream Eel',
      tagline: '煎档',
      taglineEn: 'Pan-fried',
      description: '砂锅慢焗，皮脆肉嫩。',
      descriptionEn: 'Slow-baked in a clay pot until the skin is crisp.',
      unit: '份',
      unitEn: 'pot',
      specs: [
        { itemId: item['砂锅焗溪鳗（大份）'], label: '大份', labelEn: 'Big' },
        { itemId: item['砂锅焗溪鳗（小份）'], label: '小份' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const eel = r.body.dishes.find((d) => d.name === '砂锅焗溪鳗')!;
    dish.eel = eel.id;
    expect([eel.taglineEn, eel.descriptionEn, eel.unitEn]).toEqual(['Pan-fried', 'Slow-baked in a clay pot until the skin is crisp.', 'pot']);
    expect(eel.specs.map((s) => [s.label, s.labelEn])).toEqual([
      ['大份', 'Big'],
      ['小份', ''],
    ]);

    // 酒：属性行与它的英文
    r = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', {
      name: '小梦若奇白葡萄酒',
      attrs: ['产地：法国', '年份：NV'],
      attrsEn: ['Origin: France', 'Vintage: NV'],
      unit: '瓶',
      specs: [{ itemId: item['小梦若奇白葡萄酒'] }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const wine = r.body.dishes.find((d) => d.name === '小梦若奇白葡萄酒')!;
    dish.wine = wine.id;
    expect(wine.attrsEn).toEqual(['Origin: France', 'Vintage: NV']);

    // 修改：改英文介绍、版本号加一；只有一个规格时规格的英文不存
    const body = { name: egg.name, nameEn: egg.nameEn, description: egg.description, descriptionEn: 'Fresh lobster with hollandaise.', specs: [{ itemId: item['龙虾班尼迪蛋'], label: '', labelEn: 'Single' }], version: egg.version };
    r = await api<EmenuAdmin>(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/dishes/${egg.id}`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const egg2 = r.body.dishes.find((d) => d.id === egg.id)!;
    expect([egg2.descriptionEn, egg2.version, egg2.specs[0]!.labelEn]).toEqual(['Fresh lobster with hollandaise.', egg.version + 1, '']);

    // 上限
    const bad = (patch: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/dishes/${egg.id}`, { ...body, version: egg2.version, ...patch });
    expect((await bad({ descriptionEn: 'x'.repeat(401) })).status).toBe(400);
    expect((await bad({ taglineEn: 'x'.repeat(81) })).status).toBe(400);
    expect((await bad({ unitEn: 'x'.repeat(13) })).status).toBe(400);
    expect((await bad({ attrsEn: ['a', 'b', 'c', 'd'] })).status).toBe(400);
    expect((await bad({ attrsEn: ['x'.repeat(49)] })).status).toBe(400);
    expect((await bad({ specs: [{ itemId: item['龙虾班尼迪蛋'], labelEn: 'x'.repeat(17) }] })).status).toBe(400);
  });

  it('平板的菜单带出英文各项；没填的是空的（页面上显示中文）', async () => {
    let r = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/categories', { name: '午餐', nameEn: 'LUNCH' });
    const c = r.body.categories.find((x) => x.name === '午餐')!;
    r = await api<EmenuAdmin>(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/categories/${c.id}/pages`, { version: c.version, pages: [{ layout: 'trio_row', dishIds: [dish.eel, dish.egg, dish.wine] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await rules({ enabled: true })).status).toBe(200);

    const eel = await dishOnMenu(dish.eel!);
    expect([eel.nameEn, eel.taglineEn, eel.descriptionEn, eel.unitEn]).toEqual(['Clay Pot Baked Stream Eel', 'Pan-fried', 'Slow-baked in a clay pot until the skin is crisp.', 'pot']);
    expect(eel.specs.map((s) => [s.label, s.labelEn])).toEqual([
      ['大份', 'Big'],
      ['小份', ''],
    ]);
    const wine = await dishOnMenu(dish.wine!);
    expect([wine.attrs, wine.attrsEn, wine.unit, wine.unitEn]).toEqual([['产地：法国', '年份：NV'], ['Origin: France', 'Vintage: NV'], '瓶', '']);
    const egg = await dishOnMenu(dish.egg!);
    expect([egg.taglineEn, egg.attrsEn]).toEqual(['', []]);
  });
});

describe('设置：中英切换、选项的英文、动效', () => {
  it('默认开着中英切换与动效；平板的菜单带出；能关', async () => {
    expect([DEFAULT_EMENU_RULES.langSwitch, DEFAULT_EMENU_RULES.motion, DEFAULT_EMENU_RULES.optionsEn]).toEqual([true, true, {}]);
    let m = await menu();
    expect([m.rules.langSwitch, m.rules.motion, m.rules.optionsEn]).toEqual([true, true, {}]);
    expect((await rules({ langSwitch: false, motion: false })).status).toBe(200);
    m = await menu();
    expect([m.rules.langSwitch, m.rules.motion]).toEqual([false, false]);
    expect((await rules({ langSwitch: true, motion: true })).status).toBe(200);
    expect((await rules({ langSwitch: 'yes' })).status).toBe(400);
  });

  it('选项的英文：只留现在还有的选项、填了字的；删掉选项时它的英文跟着去掉；太长拒绝', async () => {
    let r = await rules({ optionsEn: { 不加香菜: ' No coriander ', 重辣: '', 没有这个选项: 'Nope' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as EmenuAdmin).rules.optionsEn).toEqual({ 不加香菜: 'No coriander' });
    expect((await menu()).rules.optionsEn).toEqual({ 不加香菜: 'No coriander' });
    // 删掉「不加香菜」这个选项：它的英文不留
    r = await rules({ avoidOptions: ['少辣', '重辣'] });
    expect((r.body as EmenuAdmin).rules.optionsEn).toEqual({});
    expect((await rules({ optionsEn: { 少辣: 'x'.repeat(25) } })).status).toBe(400);
    expect((await rules({ avoidOptions: DEFAULT_EMENU_RULES.avoidOptions, optionsEn: { 不加香菜: 'No coriander' } })).status).toBe(200);
  });

  it('下单交的仍是中文选项：进厨房的备注是中文（页面切到英文只是显示）', async () => {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'A', from: 8001, to: 8003, width: 4, zone: 'male' })).status).toBe(200);
    const checkin = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'A8001', zone: 'male' }] });
    expect(checkin.status, JSON.stringify(checkin.body)).toBe(201);
    const visitId = checkin.body.visits[0].id as number;
    const pin = (await api(ctx.app, ctx.owner, 'POST', `/api/staff/${ctx.clerkId}/order-pin`)).body.pin as string;
    const send = (avoid: string[]) =>
      api(ctx.app, pad, 'POST', '/api/emenu/orders', { clientKey: randomUUID(), visitId, tagCode: 'A8001', tableName: 'A01', guests: 2, lines: [{ itemId: item['龙虾班尼迪蛋'], quantity: 1 }], avoid, serve: null, customNote: 'no ice please', expectedTotal: 4200, pin });
    // 交英文的选项不认（页面不会这样交）
    expect((await send(['Mild'])).body.error.code).toBe('REMARK_OPTION_INVALID');
    const ok = await send(['不加香菜']);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const [k] = await ctx.sql<{ note: string }[]>`SELECT k.note FROM kitchen_items k JOIN bill_lines l ON l.id = k.bill_line_id JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${visitId}`;
    expect(k!.note).toBe('不加香菜，no ice please');
    // 已下单里带英文名（页面切到英文时用）
    expect(ok.body.guest.ordered.map((l: { name: string; nameEn: string }) => [l.name, l.nameEn])).toEqual([['龙虾班尼迪蛋', 'Lobster Eggs Benedict']]);
  });
});

describe('英文对照表', () => {
  it('导出：表头与每道菜一行；只有「维护电子菜单」的人能导出、导入', async () => {
    const csv = await sheet();
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(EMENU_ENGLISH_COLUMNS.join(','));
    expect(lines).toHaveLength(1 + (await admin()).dishes.length);
    const eel = lines.find((l) => l.startsWith(`${dish.eel},`))!;
    expect(eel).toBe(`${dish.eel},砂锅焗溪鳗,Clay Pot Baked Stream Eel,煎档,Pan-fried,砂锅慢焗，皮脆肉嫩。,Slow-baked in a clay pot until the skin is crisp.,,,份,pot`);
    expect(lines.find((l) => l.startsWith(`${dish.wine},`))).toContain('产地：法国 | 年份：NV,Origin: France | Vintage: NV,瓶,');
    // 平板账号、前台都不行
    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/emenu/english.csv', headers: { cookie: pad } })).statusCode).toBe(403);
    expect((await importRows([{ id: dish.eel, nameEn: 'X' }], ctx.clerk)).status).toBe(403);
  });

  it('导入：只更新英文、空着的不动、编号对不上的跳过、版本号只在有变化时加一；再导一次不变', async () => {
    const before = await admin();
    const eel0 = before.dishes.find((d) => d.id === dish.eel)!;
    const egg0 = before.dishes.find((d) => d.id === dish.egg)!;
    const wine0 = before.dishes.find((d) => d.id === dish.wine)!;
    const rows = [
      // 溪鳗：只给英文介绍——英文名、小字、单位都不动
      { id: dish.eel, descriptionEn: 'Stream eel slow-baked in a clay pot.' },
      // 班尼迪蛋：补小字与单位；英文名给的是空字（空着的格子）不动
      { id: dish.egg, nameEn: '', taglineEn: '2 pcs', unitEn: 'set' },
      // 酒：与现在的一样
      { id: dish.wine, attrsEn: ['Origin: France', 'Vintage: NV'] },
      { id: 999_999, nameEn: 'Ghost' },
    ];
    const r = await importRows(rows);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.english).toEqual({ updated: 2, unchanged: 1, missing: [999_999] });
    const eel = r.body.dishes.find((d) => d.id === dish.eel)!;
    expect([eel.nameEn, eel.taglineEn, eel.descriptionEn, eel.unitEn, eel.version]).toEqual(['Clay Pot Baked Stream Eel', 'Pan-fried', 'Stream eel slow-baked in a clay pot.', 'pot', eel0.version + 1]);
    // 中文各项、图片、规格都没有动
    expect([eel.name, eel.tagline, eel.description, eel.unit, eel.specs]).toEqual([eel0.name, eel0.tagline, eel0.description, eel0.unit, eel0.specs]);
    const egg = r.body.dishes.find((d) => d.id === dish.egg)!;
    expect([egg.nameEn, egg.taglineEn, egg.unitEn, egg.descriptionEn, egg.version]).toEqual(['Lobster Eggs Benedict', '2 pcs', 'set', egg0.descriptionEn, egg0.version + 1]);
    expect(r.body.dishes.find((d) => d.id === dish.wine)!.version).toBe(wine0.version);
    // 平板上跟着变
    expect((await dishOnMenu(dish.eel!)).descriptionEn).toBe('Stream eel slow-baked in a clay pot.');
    // 记了一条审计
    const [log] = await ctx.sql<{ detail: { summary: string; updated: number } }[]>`SELECT detail FROM audit_logs WHERE action = 'emenu_saved' AND target_type = 'emenu' ORDER BY id DESC LIMIT 1`;
    expect(log!.detail.summary).toContain('导入电子菜单的英文对照表：更新 2 道菜，1 个编号对不上');

    // 同样的内容再导一次：什么都不改、不再记审计
    const logs = async () => (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'emenu_saved' AND target_type = 'emenu'`)[0]!.n;
    const n = await logs();
    const again = await importRows(rows);
    expect(again.body.english).toEqual({ updated: 0, unchanged: 3, missing: [999_999] });
    expect(again.body.dishes.find((d) => d.id === dish.eel)!.version).toBe(eel.version);
    expect(await logs()).toBe(n);

    // 开着的「修改菜品」窗口拿的是旧版本号：保存被拒绝（要重新载入）
    const stale = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/dishes/${dish.eel}`, { name: eel0.name, specs: eel0.specs.map((s) => ({ itemId: s.itemId, label: s.label })), version: eel0.version });
    expect(stale.body.error.code).toBe('EMENU_CHANGED');
  });

  it('导入的格式：同一个编号两次、太长、空的都拒绝，一行都不写', async () => {
    const eel = (await admin()).dishes.find((d) => d.id === dish.eel)!;
    expect((await importRows([{ id: dish.eel, nameEn: 'A' }, { id: dish.eel, nameEn: 'B' }])).body.error.code).toBe('ENGLISH_DUPLICATE_ID');
    expect((await importRows([{ id: dish.eel, nameEn: 'x'.repeat(81) }])).status).toBe(400);
    expect((await importRows([{ id: dish.eel, attrsEn: ['a', 'b', 'c', 'd'] }])).status).toBe(400);
    expect((await importRows([])).status).toBe(400);
    expect((await importRows([{ id: 'abc', nameEn: 'X' }])).status).toBe(400);
    expect((await admin()).dishes.find((d) => d.id === dish.eel)).toEqual(eel);
  });

  it('导出的文件填好英文再读回来：按表头找列，空行、没填英文的行跳过，有问题的行说清第几行', async () => {
    const csv = await sheet();
    // 原样读回来：每道有英文的菜一行，内容与导出的一样（再导入不会有变化）
    const same = parseEmenuEnglishCsv(csv);
    expect(same.problems).toEqual([]);
    const r0 = await importRows(same.rows);
    expect(r0.body.english.updated).toBe(0);

    // 在表格软件里填：换了列的先后、多了一列备注、中间有空行
    const text = [
      '备注,英文介绍,编号,英文名,属性行的英文,单位的英文,小字的英文',
      `翻译：小王,"Baked eel, served in a clay pot",${dish.eel},,,,`,
      ',,,,,,',
      `,,${dish.wine},Petit Monrachet Blanc,Origin: France｜Vintage: NV,bottle,`,
      `,,${dish.egg},,,,`,
      `,,abc,Bad Row,,,`,
      `,,${dish.egg},${'x'.repeat(81)},,,`,
    ].join('\n');
    const parsed = parseEmenuEnglishCsv(text);
    expect(parsed.rows).toEqual([
      { id: dish.eel, descriptionEn: 'Baked eel, served in a clay pot' },
      { id: dish.wine, nameEn: 'Petit Monrachet Blanc', unitEn: 'bottle', attrsEn: ['Origin: France', 'Vintage: NV'] },
    ]);
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems[0]).toContain('第 6 行');
    expect(parsed.problems[0]).toContain('abc');
    expect(parsed.problems[1]).toContain('第 7 行');
    expect(parsed.problems[1]).toContain('英文名');
    const r = await importRows(parsed.rows);
    expect(r.body.english).toEqual({ updated: 2, unchanged: 0, missing: [] });
    const wine = await dishOnMenu(dish.wine!);
    expect([wine.nameEn, wine.unitEn, wine.attrsEn]).toEqual(['Petit Monrachet Blanc', 'bottle', ['Origin: France', 'Vintage: NV']]);

    // 不是导出的那种文件
    expect(parseEmenuEnglishCsv('').problems).toEqual(['文件是空的']);
    expect(parseEmenuEnglishCsv('菜名,英文名\n溪鳗,Eel').problems[0]).toContain('编号');
    expect(parseEmenuEnglishCsv('编号,菜名\n1,溪鳗').problems[0]).toContain('没有找到英文的列');
    expect(parseEmenuEnglishCsv('编号,英文名\n1,"没配对').problems[0]).toContain('引号没有配对');
    expect(parseEmenuEnglishCsv(`编号,英文名\n7,A\n7,B`).problems[0]).toContain('出现了两次');
  });
});
