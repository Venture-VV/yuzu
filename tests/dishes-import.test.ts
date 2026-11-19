// 8.1.15 菜品管理的导出与导入（docs/DISHES_V8115.md 第 6 节）：
//   · 导出全部菜品（Excel）：列与导入认的一样，改完可以原样导回来；
//   · 导入先预览再生效：预览什么都不写；逐行写问题，有一行有问题整份不写；
//   · 已有的菜格子空着是不改，写「无」是清掉；有编号的按编号找（可以改名），没有的按名称找，找不到就新建；
//   · 加料、套餐内容按菜名找，这份表里新建的也能用；
//   · 生效要带回预览的摘要：预览以后菜品被改过就拒绝；有改价要写原因；同一个操作编号重提返回第一次的结果；
//   · 每一行照那道菜的出品口核对维护权限，改价、新建的还要「定价与改价」；
//   · 电子菜单里有图的菜，菜品表上带出来。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISH_EXPORT_EXTRA_COLUMNS, DISH_SHEET_COLUMNS, type DishImportPreview, type DishPriceChange, type DishesBoard } from '../src/shared/dishes';
import { readSheet } from '../src/server/lib/sheet-read';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let water: string;
const station: Record<string, number> = {};
const legacy: Record<string, number> = {};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HEAD = [...DISH_SHEET_COLUMNS];
/** 一行：按列名给值，没给的空着 */
const line = (cells: Partial<Record<(typeof DISH_SHEET_COLUMNS)[number], string | number>>) => HEAD.map((h) => String(cells[h] ?? ''));
const csvOf = (rows: string[][], head: string[] = HEAD) => [head, ...rows].map((r) => r.join(',')).join('\r\n');

const board = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes')).body as DishesBoard;
const dishOf = async (name: string) => (await board()).dishes.find((d) => d.name === name);
const preview = async (csv: string, cookie = ctx.owner) => {
  const r = await api(ctx.app, cookie, 'POST', '/api/dining/dishes/import/preview', { fileName: '菜品.csv', csv });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as DishImportPreview;
};
const apply = (csv: string, planHash: string, extra: Record<string, unknown> = {}, cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', '/api/dining/dishes/import', { clientKey: randomUUID(), fileName: '菜品.csv', csv, planHash, ...extra });
const history = async (itemId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/dining/dishes/price-changes?itemId=${itemId}`)).body as DishPriceChange[];
const counts = async () => {
  const [c] = await ctx.sql<{ items: number; ops: number; prices: number }[]>`
    SELECT (SELECT count(*) FROM service_items)::int AS items, (SELECT count(*) FROM dish_ops)::int AS ops, (SELECT count(*) FROM dish_price_changes)::int AS prices`;
  return c!;
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'water', displayName: '水吧主管', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('role_permissions', ${ctx.sql.json({ duty_manager: { add: ['dish.water'], remove: [] } })})`;
  water = await login(ctx.app, 'water');
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
  for (const name of ['热菜', '水吧', '果吧档']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  for (const [name, category, price, at] of [
    ['宫保鸡丁', '餐饮', 4800, '热菜'],
    ['柠檬茶', '饮品', 1500, '水吧'],
    ['鲜切果盘', '果吧', 3800, '果吧档'],
    ['汤泉门票', '门票', 12800, null],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    legacy[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    if (at) expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: legacy[name], stationId: station[at] }] })).status).toBe(200);
  }
});
afterAll(async () => ctx.close());

describe('导出', () => {
  it('Excel：一行一道菜，列与导入认的一样（后面多三列只读的）；记一条导出的审计', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${legacy['柠檬茶']}`, { remaining: 0 })).status).toBe(200);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/dining/dishes/export.xlsx', headers: { cookie: ctx.owner } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(decodeURIComponent(String(res.headers['content-disposition']))).toMatch(/菜品_\d{4}-\d{2}-\d{2}\.xlsx/);
    const sheet = readSheet({ xlsxBase64: res.rawPayload.toString('base64') });
    expect(sheet.header).toEqual([...DISH_SHEET_COLUMNS, ...DISH_EXPORT_EXTRA_COLUMNS]);
    expect(sheet.rows.map((r) => r.cells.join('|'))).toEqual([
      `${legacy['宫保鸡丁']}|宫保鸡丁|餐饮|餐厅|餐饮|热菜|48|||上架||||不限量||`,
      `${legacy['柠檬茶']}|柠檬茶|饮品|水吧|手作饮料|水吧|15|||上架||||已沽清||`,
      `${legacy['鲜切果盘']}|鲜切果盘|果吧|果吧||果吧档|38|||上架||||不限量||`,
    ]);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'export' AND target_type = 'dishes'`).length).toBe(1);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${legacy['柠檬茶']}`, { remaining: null })).status).toBe(200);
  });

  it('导出的表原样导回来：全部没变、没有问题、没有要改的', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/dining/dishes/export.xlsx', headers: { cookie: ctx.owner } });
    const xlsxBase64 = res.rawPayload.toString('base64');
    const p = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import/preview', { fileName: '菜品.xlsx', xlsxBase64 });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ rowCount: 3, createCount: 0, updateCount: 0, unchangedCount: 3, issues: [], changes: [] });
    const a = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import', { clientKey: randomUUID(), fileName: '菜品.xlsx', xlsxBase64, planHash: p.body.planHash });
    expect(a.status).toBe(422);
    expect(a.body.error.code).toBe('IMPORT_NOTHING');
    // 按默认归的出品口没有被写成「设过」
    expect((await dishOf('宫保鸡丁'))!.slotAssigned).toBe(false);
  });
});

describe('导入：先预览再生效', () => {
  const good = () =>
    csvOf([
      // 已有的菜：改价、加做法（按名称找）
      line({ 名称: '宫保鸡丁', 标准价: 52, 做法: '微辣、中辣' }),
      // 新菜：带做法、两档价格
      line({ 名称: '牛肉面', 分类: '面点', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜', 标准价: 38, 优选价: '58.5', 做法: '免葱' }),
      // 新菜当加料
      line({ 名称: '加蛋', 分类: '面点', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜', 标准价: 3 }),
      // 新套餐：含这份表里新建的菜与原有的菜；先不上架
      line({ 名称: '面茶套餐', 分类: '套餐', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜', 标准价: 48, 状态: '下架', 套餐内容: '牛肉面×1、柠檬茶 x2' }),
      // 没变的
      line({ 名称: '鲜切果盘' }),
      // 已有的菜加上加料（这份表里新建的）
      line({ 名称: '柠檬茶', 加料: '加蛋' }),
    ]);

  it('预览：列出新建、修改、没变的各几道与每一道改什么；什么都不写', async () => {
    const before = await counts();
    const p = await preview(good());
    expect(p).toMatchObject({ fileName: '菜品.csv', rowCount: 6, createCount: 3, updateCount: 2, unchangedCount: 1, priceChangeCount: 1, issues: [] });
    expect(p.changes).toEqual([
      { row: 2, name: '宫保鸡丁', action: 'update', fields: ['做法 （没有） → 微辣、中辣', '标准 ¥48.00 → ¥52.00'] },
      { row: 3, name: '牛肉面', action: 'create', fields: ['餐厅 · 餐饮 · 热菜 · 标准 ¥38.00 / 优选 ¥58.50 · 做法 免葱'] },
      { row: 4, name: '加蛋', action: 'create', fields: ['餐厅 · 餐饮 · 热菜 · ¥3.00'] },
      { row: 5, name: '面茶套餐', action: 'create', fields: ['餐厅 · 餐饮 · 热菜 · ¥48.00 · 下架', '套餐内容 牛肉面×1、柠檬茶×2'] },
      { row: 7, name: '柠檬茶', action: 'update', fields: ['加料 （没有） → 加蛋'] },
    ]);
    expect(p.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await counts()).toEqual(before);
    expect(await dishOf('牛肉面')).toBeUndefined();
    expect((await dishOf('宫保鸡丁'))!.price).toBe(4800);
    // 同一份再预览一次，摘要一样
    expect((await preview(good())).planHash).toBe(p.planHash);
  });

  it('逐行写问题；有一行有问题整份不写', async () => {
    const before = await counts();
    const bad = csvOf([
      line({ 名称: '宫保鸡丁', 标准价: 52 }),
      line({ 名称: '', 标准价: 10 }),
      line({ 名称: '新菜甲', 出品口: '吧台', 档口: '热菜', 标准价: 20 }),
      line({ 名称: '新菜乙', 出品口: '水吧', 档口: '热菜', 标准价: 20 }),
      line({ 名称: '新菜丙', 出品口: '水吧', 小类: '餐饮', 档口: '热菜', 标准价: 20 }),
      line({ 名称: '新菜丁', 出品口: '果吧', 小类: '鲜果', 档口: '果吧档', 标准价: 20 }),
      line({ 名称: '新菜戊', 出品口: '餐厅', 小类: '餐饮', 档口: '烧烤', 标准价: 20 }),
      line({ 名称: '新菜己', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜', 标准价: '二十' }),
      line({ 名称: '新菜庚', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜' }),
      line({ 名称: '新菜辛', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜', 标准价: 20, 状态: '暂停' }),
      line({ 名称: '新菜壬', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜', 标准价: 20, 做法: '一二三四五六七八九' }),
      line({ 名称: '新菜癸', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜', 标准价: 20, 套餐内容: '柠檬茶×0' }),
      line({ 名称: '汤泉门票', 标准价: 100 }),
      line({ 编号: 999999, 名称: '没有这道', 标准价: 20 }),
      line({ 名称: '宫保鸡丁', 标准价: 55 }),
      line({ 名称: '鲜切果盘', 加料: '不存在的菜' }),
      line({ 名称: '柠檬茶', 标准价: '无' }),
      line({ 名称: '新菜子', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜', 标准价: 20, 套餐内容: '宫保鸡丁、宫保鸡丁×2' }),
    ]);
    const p = await preview(bad);
    expect(p.issues.map((i) => `${i.row}:${i.message}`)).toEqual([
      '3:名称为空',
      '4:出品口「吧台」不认识（写餐厅、水吧或果吧）',
      '5:水吧要写小类（手作饮料、糖水、调酒）',
      '6:水吧没有「餐饮」这个小类（有 手作饮料、糖水、调酒）',
      '7:果吧不分小类，小类请留空',
      '8:档口「烧烤」不存在（先在后台「餐饮 → 出品档口与菜品」里建）',
      '9:标准价「二十」不是有效的金额（写元，最多两位小数）',
      '9:新菜至少要写一档价格',
      '10:新菜至少要写一档价格',
      '11:状态「暂停」不认识（写上架或下架）',
      '12:做法「一二三四五六七八九」太长或带了空格（一种做法最多 8 个字）',
      '13:套餐内容「柠檬茶×0」看不懂（写「菜名×份数」，份数 1–99）',
      '14:价目里已有「汤泉门票」，但它不是菜品（没挂出品档口或需要技师）；要当菜品卖，先在后台「餐饮」里给它挂上出品档口',
      '15:编号 999999 不是菜品（新菜的编号请留空）',
      '16:与第 2 行是同一道菜',
      '17:加料里的「不存在的菜」不是菜品（先在这份表里或菜品管理里建好）',
      '18:不能把价格全去掉（至少留一档）',
      '19:套餐内容里同一道菜写了两次',
    ]);
    // 没问题的那一行照样列出来（改好别的再导）
    expect(p.changes).toEqual([{ row: 2, name: '宫保鸡丁', action: 'update', fields: ['标准 ¥48.00 → ¥52.00'] }]);
    const r = await apply(bad, p.planHash, { reason: '调价' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('IMPORT_INVALID');
    expect(r.body.error.message).toContain('有 18 处要先改好才能导入：第 3 行 名称为空');
    expect(r.body.error.details.issues.length).toBe(18);
    expect(await counts()).toEqual(before);
    expect((await dishOf('宫保鸡丁'))!.price).toBe(4800);
  });

  it('文件不对的：没有「名称」列、只有表头、既不是 CSV 也不是 Excel', async () => {
    const send = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import/preview', { fileName: 'x.csv', ...body });
    const noName = await send({ csv: '菜名,价格\r\n宫保鸡丁,48' });
    expect(noName.status).toBe(422);
    expect(noName.body.error.message).toContain('没有「名称」这一列');
    expect((await send({ csv: HEAD.join(',') })).body.error.message).toContain('没有菜品');
    expect((await send({})).status).toBe(400);
    expect((await send({ csv: 'a', xlsxBase64: 'b' })).status).toBe(400);
    expect((await send({ xlsxBase64: Buffer.from('不是 Excel').toString('base64') })).status).toBe(422);
  });

  it('生效：有改价要写原因；摘要对不上（预览以后菜被改过）拒绝；对上了整份写入，定价与改价都进改价记录', async () => {
    const csv = good();
    const p = await preview(csv);
    const noReason = await apply(csv, p.planHash);
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.message).toContain('请填写改价原因');
    expect((await apply(csv, 'f'.repeat(64), { reason: '菜单调整' })).body.error.code).toBe('IMPORT_CHANGED');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import', { clientKey: randomUUID(), fileName: '菜品.csv', csv })).body.error.message).toContain('请先预览');
    expect(await dishOf('牛肉面')).toBeUndefined();

    const key = randomUUID();
    const body = { clientKey: key, fileName: '菜品.csv', csv, planHash: p.planHash, reason: '菜单调整' };
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import', body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ created: 3, updated: 2, unchanged: 1, priceChanges: 1, replayed: false });

    const kungpao = (await dishOf('宫保鸡丁'))!;
    expect(kungpao).toMatchObject({ price: 5200, methods: ['微辣', '中辣'] });
    expect((await history(kungpao.id))[0]).toMatchObject({ oldPrice: 4800, newPrice: 5200, reason: '菜单调整', source: 'import', staffName: '测试店主' });
    const noodle = (await dishOf('牛肉面'))!;
    expect(noodle).toMatchObject({ category: '面点', outlet: 'restaurant', group: '餐饮', slotAssigned: true, stationName: '热菜', price: 3800, active: true, methods: ['免葱'] });
    expect(noodle.prices).toEqual([
      { tier: 'standard', price: 3800 },
      { tier: 'premium', price: 5850 },
    ]);
    expect((await history(noodle.id)).map((c) => `${c.tier}|${c.oldPrice}→${c.newPrice}|${c.reason}|${c.source}`)).toEqual(['premium|null→5850|导入新建|import', 'standard|null→3800|导入新建|import']);
    const set = (await dishOf('面茶套餐'))!;
    expect(set.active).toBe(false);
    expect(set.combo.map((c) => `${c.name}×${c.quantity}`)).toEqual(['牛肉面×1', '柠檬茶×2']);
    expect((await dishOf('柠檬茶'))!.addons.map((a) => a.name)).toEqual(['加蛋']);
    expect((await dishOf('加蛋'))!.usedBy).toEqual(['「柠檬茶」的加料']);
    const [audit] = await ctx.sql<{ summary: string }[]>`SELECT detail->>'summary' AS summary FROM audit_logs WHERE action = 'dishes_imported'`;
    expect(audit!.summary).toBe('导入菜品（菜品.csv）：新建 3 道、修改 2 道（其中改价 1 道：菜单调整）');
    // 整份只记一条审计，不逐道记
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action IN ('dish_saved', 'dish_price_changed', 'dish_active_set')`).length).toBe(0);

    // 同一个操作编号重提：返回第一次的结果，不再写一遍
    const after = await counts();
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import', body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ created: 3, updated: 2, unchanged: 1, priceChanges: 1, replayed: true });
    expect(await counts()).toEqual(after);
    // 同一个编号换了内容：拒绝
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import', { ...body, reason: '换个原因' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 同一份再导一次（新的编号）：全部没变
    const p2 = await preview(csv);
    expect(p2).toMatchObject({ createCount: 0, updateCount: 0, unchangedCount: 6, issues: [] });
    expect((await apply(csv, p2.planHash, { reason: '菜单调整' })).body.error.code).toBe('IMPORT_NOTHING');
  });

  it('预览以后菜被别人改了：生效时算出来的不一样，拒绝，请重新预览', async () => {
    const csv = csvOf([line({ 名称: '鲜切果盘', 做法: '去皮' })]);
    const p = await preview(csv);
    expect(p.changes).toEqual([{ row: 2, name: '鲜切果盘', action: 'update', fields: ['做法 （没有） → 去皮'] }]);
    const d = (await dishOf('鲜切果盘'))!;
    const edit = await api(ctx.app, ctx.owner, 'PUT', `/api/dining/dishes/${d.id}`, {
      clientKey: randomUUID(),
      rev: d.rev,
      name: d.name,
      category: d.category,
      slot: 'fruit',
      stationId: d.stationId,
      imageId: null,
      methods: ['切块'],
      addons: [],
      combo: [],
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const r = await apply(csv, p.planHash);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IMPORT_CHANGED');
    expect((await dishOf('鲜切果盘'))!.methods).toEqual(['切块']);
    const p2 = await preview(csv);
    expect(p2.changes[0]!.fields).toEqual(['做法 切块 → 去皮']);
    expect((await apply(csv, p2.planHash)).status).toBe(200);
  });

  it('空着不改、写「无」清掉；有编号的按编号找、可以改名；多出来的列、列的先后都不要紧', async () => {
    const kungpao = (await dishOf('宫保鸡丁'))!;
    const noodle = (await dishOf('牛肉面'))!;
    const tea = (await dishOf('柠檬茶'))!;
    const head = ['备注', '做法', '名称', '编号', '优选价', '加料', '状态'];
    const csv = csvOf(
      [
        ['厨房说不做中辣了', '无', '宫保鸡丁（招牌）', String(kungpao.id), '', '', ''],
        ['不卖优选了', '', '牛肉面', String(noodle.id), '无', '', '下架'],
        ['', '', '柠檬茶', '', '', '无', ''],
      ],
      head,
    );
    const p = await preview(csv);
    expect(p.issues).toEqual([]);
    expect(p.changes).toEqual([
      { row: 2, name: '宫保鸡丁（招牌）', action: 'update', fields: ['名称 宫保鸡丁 → 宫保鸡丁（招牌）', '做法 微辣、中辣 → （没有）'] },
      { row: 3, name: '牛肉面', action: 'update', fields: ['去掉 优选（原 ¥58.50）', '上架 → 下架'] },
      { row: 4, name: '柠檬茶', action: 'update', fields: ['加料 加蛋 → （没有）'] },
    ]);
    expect((await apply(csv, p.planHash, { reason: '不卖优选了' })).status).toBe(200);
    expect(await dishOf('宫保鸡丁（招牌）')).toMatchObject({ id: kungpao.id, methods: [], price: 5200, category: '餐饮' });
    expect(await dishOf('牛肉面')).toMatchObject({ active: false, prices: [{ tier: 'standard', price: 3800 }], methods: ['免葱'] });
    expect((await dishOf('柠檬茶'))!.addons).toEqual([]);
    expect(tea.addons.length).toBe(1);
    // 套餐里用到的菜改了名：套餐内容跟着显示新名字（引用的是那道菜，不是名字）
    expect((await dishOf('面茶套餐'))!.combo.map((c) => c.name)).toEqual(['牛肉面', '柠檬茶']);
  });

  it('每一行照那道菜的出品口核对权限：水吧主管能导水吧的菜；餐厅的菜、改价、新建都被那一行拒绝', async () => {
    const mine = csvOf([line({ 名称: '柠檬茶', 做法: '去冰、少冰' })]);
    const ok = await preview(mine, water);
    expect(ok).toMatchObject({ updateCount: 1, issues: [] });
    expect((await apply(mine, ok.planHash, {}, water)).status).toBe(200);
    expect((await dishOf('柠檬茶'))!.methods).toEqual(['去冰', '少冰']);

    const others = csvOf([
      line({ 名称: '宫保鸡丁（招牌）', 做法: '微辣' }),
      line({ 名称: '柠檬茶', 标准价: 18 }),
      line({ 名称: '杨枝甘露', 出品口: '水吧', 小类: '糖水', 档口: '水吧', 标准价: 32 }),
      line({ 名称: '柠檬茶二号', 出品口: '餐厅', 小类: '酒水', 档口: '水吧', 标准价: 15 }),
    ]);
    const p = await preview(others, water);
    expect(p.issues.map((i) => `${i.row}:${i.message}`)).toEqual([
      '2:没有餐厅的菜品维护权限，不能改「宫保鸡丁（招牌）」',
      '3:没有「菜品管理：定价与改价」的权限',
      '4:新建菜品要定价，需要「菜品管理：定价与改价」的权限',
      '5:没有餐厅的菜品维护权限，不能在这里新建菜品',
    ]);
    expect((await apply(others, p.planHash, { reason: '试试' }, water)).status).toBe(422);
    expect((await dishOf('柠檬茶'))!.price).toBe(1500);
    // 没有任何菜品维护权限的进不来
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/dining/dishes/import/preview', { fileName: 'x.csv', csv: mine })).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/dining/dishes/import', { clientKey: randomUUID(), fileName: 'x.csv', csv: mine, planHash: ok.planHash })).status).toBe(403);
  });

  it('套餐不套套餐这些规矩，导入时照样核对（写在那一行上）', async () => {
    const csv = csvOf([
      line({ 名称: '大套餐', 出品口: '餐厅', 小类: '餐饮', 档口: '热菜', 标准价: 98, 套餐内容: '面茶套餐×1' }),
      line({ 名称: '鲜切果盘', 加料: '面茶套餐' }),
      line({ 名称: '牛肉面', 套餐内容: '鲜切果盘' }),
    ]);
    const p = await preview(csv);
    expect(p.issues.map((i) => `${i.row}:${i.message}`)).toEqual([
      '2:「面茶套餐」本身是套餐，套餐里不能再放套餐',
      '3:「面茶套餐」是套餐，不能当加料',
      '4:这道菜已经在套餐「面茶套餐」里，不能再做成套餐',
    ]);
    // 第 2 行的新建在预览里做过又回滚了：库里没有
    expect(await dishOf('大套餐')).toBeUndefined();
  });
});

describe('图片', () => {
  it('电子菜单里有图的菜，菜品表上带出来；菜品自己传了图就用自己的', async () => {
    const img = await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/images', { mime: 'image/png', data: PNG });
    expect(img.status, JSON.stringify(img.body)).toBe(201);
    const d = (await dishOf('鲜切果盘'))!;
    const made = await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', { name: '时令鲜果拼盘', imageId: img.body.id, specs: [{ itemId: d.id }] });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const shown = (await dishOf('鲜切果盘'))!;
    expect(shown).toMatchObject({ emenuDish: '时令鲜果拼盘', imageId: null, imageUrl: `/api/dining/dishes/images/${img.body.id}` });
    const pic = await ctx.app.inject({ method: 'GET', url: shown.imageUrl!, headers: { cookie: water } });
    expect(pic.statusCode).toBe(200);
    expect(pic.headers['content-type']).toBe('image/png');
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes/images/999999')).status).toBe(404);
  });
});
