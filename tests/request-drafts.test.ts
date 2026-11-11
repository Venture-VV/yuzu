// 需求单草稿箱（供应链二次整改 03，docs/ERP_ROUND2.md）：
// 草稿按人存、只有本人看得到；内容不按提交的规则核对；版本号与保存编号；每人最多 20 份；
// 提交成需求单时在同一个事务里关掉（迟到的保存请求不会把它又建出来）；修改草稿一张需求单一份，
// 需求单结束审核后清掉；30 天没再保存的自动清理；自己草稿里的图片看得到。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRAFT_KEEP_DAYS, DRAFT_MAX_PER_STAFF, type RequestDraft, type RequestDraftsList, type RequestDraftSummary } from '@shared/requests';
import { runMinuteJobs } from '../src/server/jobs';
import { sweepDrafts } from '../src/server/modules/request-drafts';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let buyer: string; // 采购经办（审核需求单）
let reqA: string; // 部门申购（客房部）
let reqB: string; // 部门申购（水吧）
let reqAId: number;
let deptA: number;
let mat: { id: number; name: string };
const q = (n: number) => Math.round(n * 1000);
const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`yuzu-draft-${seed}`)]).toString('base64');
const upload = async (cookie: string, seed: string) => (await api(ctx.app, cookie, 'POST', '/api/erp/images', { mime: 'image/jpeg', data: jpeg(seed) })).body as { id: number; url: string };

const line = (over: Record<string, unknown> = {}) => ({
  kind: 'new',
  materialId: null,
  name: '玻璃杯',
  purpose: '',
  qty: '19',
  unit: '',
  refPrice: '',
  link: '',
  details: '水波杯 300ml',
  note: '',
  imageIds: [] as number[],
  ...over,
});
const body = (lines: unknown[] = [line()], over: Record<string, unknown> = {}) => ({ departmentId: null, needBy: '', priority: 'normal', note: '', lines, ...over });
const save = (cookie: string, key: string, rev: number, b: unknown = body(), extra: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'PUT', `/api/erp/requests/drafts/${key}`, { rev, saveId: randomUUID(), requestId: null, body: b, ...extra });
const list = async (cookie: string, qs = '') => (await api(ctx.app, cookie, 'GET', `/api/erp/requests/drafts${qs}`)).body as RequestDraftsList;
const remove = (cookie: string, key: string) => api(ctx.app, cookie, 'POST', `/api/erp/requests/drafts/${key}/delete`, {});
const fullLine = (imageId: number, over: Record<string, unknown> = {}) => ({
  name: '香薰扩香石',
  purpose: '客用消耗',
  qtyMilli: q(10),
  unit: '个',
  link: 'https://example.com/item/1',
  imageIds: [imageId],
  ...over,
});

beforeAll(async () => {
  ctx = await setup();
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  const mk = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
  };
  deptA = await mk('客房部');
  const deptB = await mk('水吧');
  reqAId = await createStaff(ctx.sql, { username: 'draft_a', displayName: '客房申购', role: 'backoffice', duties: ['request'], departmentId: deptA, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'draft_b', displayName: '水吧申购', role: 'backoffice', duties: ['request'], departmentId: deptB, password: PASSWORD, mustChangePassword: false });
  reqA = await login(ctx.app, 'draft_a');
  reqB = await login(ctx.app, 'draft_b');
  const mats = (await api(ctx.app, boss, 'GET', '/api/inventory/materials?all=1')).body as { id: number; code: string; name: string }[];
  mat = mats.find((m) => m.code === 'M016')!;
}, 120_000);
afterAll(async () => ctx.close());

describe('存草稿', () => {
  it('填到一半就能存：不按提交的规则核对；再打开内容、图片都在；只有本人看得到', async () => {
    const img = await upload(reqA, 'one');
    const key = randomUUID();
    // 没选用途、没填单位、新产品没有链接：提交不了，草稿照样存
    const first = await save(reqA, key, 0, body([line({ imageIds: [img.id] }), line({ kind: 'material', materialId: mat.id, name: mat.name, qty: '' })], { departmentId: deptA, note: '月底前要', needBy: '2027-01-05', priority: 'urgent' }));
    expect(first.status).toBe(200);
    const s1 = first.body as RequestDraftSummary;
    expect(s1).toMatchObject({ key, rev: 1, lineCount: 2, title: `玻璃杯、${mat.name}`, request: null });
    // 过期时间 = 最后一次保存 + 30 天
    expect(Math.round((Date.parse(s1.expiresAt) - Date.parse(s1.updatedAt)) / 86_400_000)).toBe(DRAFT_KEEP_DAYS);

    const got = (await api(ctx.app, reqA, 'GET', `/api/erp/requests/drafts/${key}`)).body as RequestDraft;
    expect(got.departmentName).toBe('客房部');
    expect(got.body).toMatchObject({ departmentId: deptA, note: '月底前要', needBy: '2027-01-05', priority: 'urgent' });
    expect(got.body.lines).toHaveLength(2);
    expect(got.body.lines[0]).toMatchObject({ kind: 'new', name: '玻璃杯', qty: '19', details: '水波杯 300ml', images: [{ id: img.id, url: `/api/erp/images/${img.id}` }] });
    expect(got.body.lines[1]).toMatchObject({ kind: 'material', materialId: mat.id, qty: '', images: [] });

    const mine = await list(reqA);
    expect(mine).toMatchObject({ max: DRAFT_MAX_PER_STAFF, keepDays: DRAFT_KEEP_DAYS });
    expect(mine.drafts.map((d) => d.key)).toEqual([key]);
    // 别人：列表里没有，拿编号也看不到、存不了、删不了
    expect((await list(reqB)).drafts).toEqual([]);
    expect((await api(ctx.app, reqB, 'GET', `/api/erp/requests/drafts/${key}`)).status).toBe(404);
    expect((await save(reqB, key, 1)).status).toBe(404);
    expect((await remove(reqB, key)).status).toBe(404);
    // 店主也看不到别人的草稿（草稿只有本人看得到）
    expect((await list(boss)).drafts).toEqual([]);
    // 没有「提需求单」权限的进不来
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/erp/requests/drafts')).status).toBe(403);
    expect((await remove(reqA, key)).status).toBe(200);
  });

  it('版本号：别处存过以后这边再存被拒绝，不会悄悄盖掉；同一次保存再发一次只算一次', async () => {
    const key = randomUUID();
    const saveId = randomUUID();
    const a = await api(ctx.app, reqA, 'PUT', `/api/erp/requests/drafts/${key}`, { rev: 0, saveId, requestId: null, body: body() });
    expect(a.body.rev).toBe(1);
    // 没收到回复、原样再发一次（rev 还是 0、同一个保存编号）：当作已经存过，不报「别处改过」
    const again = await api(ctx.app, reqA, 'PUT', `/api/erp/requests/drafts/${key}`, { rev: 0, saveId, requestId: null, body: body() });
    expect(again.status).toBe(200);
    expect(again.body.rev).toBe(1);
    // 另一个页面按版本 1 存了一次
    const b = await save(reqA, key, 1, body([line({ name: '实木托盘' })]));
    expect(b.body.rev).toBe(2);
    // 这边还拿着版本 1：被拒绝，内容还是另一个页面存的
    const stale = await save(reqA, key, 1, body([line({ name: '旧页面的内容' })]));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('DRAFT_CHANGED');
    expect(stale.body.error.details.rev).toBe(2);
    expect(((await api(ctx.app, reqA, 'GET', `/api/erp/requests/drafts/${key}`)).body as RequestDraft).body.lines[0]!.name).toBe('实木托盘');
    // 还没存过的草稿不能直接带版本号存（已删除、已过期的不会被迟到的请求建出来）
    const ghost = await save(reqA, randomUUID(), 3);
    expect(ghost.status).toBe(409);
    expect(ghost.body.error.code).toBe('DRAFT_GONE');
    await remove(reqA, key);
  });

  it('只限长度、行数与图片：超过的拒绝；图片要是已经上传的', async () => {
    const key = randomUUID();
    expect((await save(reqA, key, 0, body([line({ name: 'x'.repeat(81) })]))).status).toBe(400);
    expect((await save(reqA, key, 0, body(Array.from({ length: 51 }, () => line())))).status).toBe(400);
    expect((await save(reqA, key, 0, body([]))).status).toBe(400);
    expect((await save(reqA, key, 0, body([line()], { needBy: '明天' }))).status).toBe(400);
    const noImage = await save(reqA, key, 0, body([line({ imageIds: [99_999_999] })]));
    expect(noImage.body.error.code).toBe('IMAGE_NOT_FOUND');
    expect((await list(reqA)).drafts).toEqual([]);
    // 50 行可以
    const ok = await save(reqA, key, 0, body(Array.from({ length: 50 }, (_, i) => line({ name: `物品 ${i + 1}` }))));
    expect(ok.body).toMatchObject({ rev: 1, lineCount: 50, title: '物品 1、物品 2、物品 3' });
    await remove(reqA, key);
  });

  it(`每人最多 ${DRAFT_MAX_PER_STAFF} 份：满了新的存不了，已有的照样能存；删掉一份以后又能存`, async () => {
    const keys = Array.from({ length: DRAFT_MAX_PER_STAFF }, () => randomUUID());
    for (const k of keys) expect((await save(reqB, k, 0)).status).toBe(200);
    const full = await save(reqB, randomUUID(), 0);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('DRAFT_LIMIT');
    expect((await save(reqB, keys[0]!, 1, body([line({ name: '改一下' })]))).body.rev).toBe(2);
    expect((await remove(reqB, keys[1]!)).status).toBe(200);
    const extra = randomUUID();
    expect((await save(reqB, extra, 0)).status).toBe(200);
    // 别人的份数不受影响
    const mine = randomUUID();
    expect((await save(reqA, mine, 0)).status).toBe(200);
    for (const k of [...keys, extra]) await remove(reqB, k);
    await remove(reqA, mine);
    expect((await list(reqB)).drafts).toEqual([]);
  });
});

describe('删除与提交', () => {
  it('删除以后草稿箱里没有；迟到的保存请求不会把它又建出来；再删一次不报错', async () => {
    const key = randomUUID();
    await save(reqA, key, 0);
    expect((await remove(reqA, key)).body).toEqual({ ok: true });
    expect((await list(reqA)).drafts).toEqual([]);
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/requests/drafts/${key}`)).status).toBe(404);
    // 页面关掉之前发出的保存，删除以后才到：按版本存的、当成第一次存的都被拒绝
    for (const rev of [1, 0]) {
      const late = await save(reqA, key, rev);
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('DRAFT_CLOSED');
      expect(late.body.error.details.reason).toBe('deleted');
    }
    expect((await remove(reqA, key)).status).toBe(200);
    expect((await remove(reqA, randomUUID())).status).toBe(404);
  });

  it('提交成需求单时草稿在同一个事务里关掉；提交被拒绝的草稿还在；原样重提不受影响', async () => {
    const img = await upload(reqA, 'submit');
    const key = randomUUID();
    await save(reqA, key, 0, body([line({ imageIds: [img.id] })]));
    // 提交被拒绝（新产品没填链接）：草稿还在
    const clientKey = randomUUID();
    const refused = await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), draftKey: key, lines: [fullLine(img.id, { link: '' })] });
    expect(refused.body.error.code).toBe('LINK_REQUIRED');
    expect((await list(reqA)).drafts.map((d) => d.key)).toEqual([key]);
    // 提交成功：草稿没了
    const payload = { clientKey, draftKey: key, lines: [fullLine(img.id)] };
    const done = await api(ctx.app, reqA, 'POST', '/api/erp/requests', payload);
    expect(done.status).toBe(201);
    expect((await list(reqA)).drafts).toEqual([]);
    const late = await save(reqA, key, 1);
    expect(late.body.error.code).toBe('DRAFT_CLOSED');
    expect(late.body.error.details.reason).toBe('submitted');
    // 原样重提（同一个操作编号）：还是那张需求单
    const replay = await api(ctx.app, reqA, 'POST', '/api/erp/requests', payload);
    expect(replay.status).toBe(200);
    expect(replay.body.request.id).toBe(done.body.request.id);
    // 不带草稿编号的原样重提也认（升级前记在本机的「结果待确认」没有这一项，摘要要与当时的一样）
    const { draftKey: _drop, ...old } = payload;
    const replayOld = await api(ctx.app, reqA, 'POST', '/api/erp/requests', old);
    expect(replayOld.status).toBe(200);
    expect(replayOld.body.request.id).toBe(done.body.request.id);
  });

  it('草稿还没来得及存过就提交了：第一次保存的请求之后才到，也不会建出草稿', async () => {
    const img = await upload(reqA, 'race');
    const key = randomUUID();
    const done = await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), draftKey: key, lines: [fullLine(img.id, { name: '还没存过草稿' })] });
    expect(done.status).toBe(201);
    const late = await save(reqA, key, 0);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('DRAFT_CLOSED');
    expect((await list(reqA)).drafts).toEqual([]);
    // 带了别人的草稿编号提交：别人的草稿不受影响
    const theirs = randomUUID();
    await save(reqB, theirs, 0);
    const other = await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), draftKey: theirs, lines: [fullLine(img.id, { name: '带了别人的草稿编号' })] });
    expect(other.status).toBe(201);
    expect((await list(reqB)).drafts.map((d) => d.key)).toEqual([theirs]);
    await remove(reqB, theirs);
  });
});

describe('修改需求单的草稿', () => {
  const create = async (name: string) => {
    const img = await upload(reqA, name);
    const r = await api(ctx.app, reqA, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines: [fullLine(img.id, { name })] });
    expect(r.status).toBe(201);
    return { id: r.body.request.id as number, docNo: r.body.request.docNo as string, img: img.id };
  };

  it('一张需求单一人一份；只能给自己能改的需求单存；改好提交后清掉', async () => {
    const r = await create('要改的需求');
    const key = randomUUID();
    const first = await save(reqA, key, 0, body([line({ name: '改到一半' })]), { requestId: r.id });
    expect(first.body).toMatchObject({ rev: 1, request: { id: r.id, docNo: r.docNo } });
    expect((await list(reqA, `?requestId=${r.id}`)).drafts.map((d) => d.key)).toEqual([key]);
    expect((await list(reqA, `?requestId=${r.id + 999}`)).drafts).toEqual([]);
    // 部门显示的是需求单的部门
    expect(((await api(ctx.app, reqA, 'GET', `/api/erp/requests/drafts/${key}`)).body as RequestDraft).departmentName).toBe('客房部');
    // 草稿对应哪张需求单不能换
    expect((await save(reqA, key, 1, body(), { requestId: null })).status).toBe(400);
    // 另一个页面给同一张需求单新起了一份：原来那份关掉，只留新的
    const key2 = randomUUID();
    expect((await save(reqA, key2, 0, body([line({ name: '另一个页面改的' })]), { requestId: r.id })).status).toBe(200);
    expect((await list(reqA, `?requestId=${r.id}`)).drafts.map((d) => d.key)).toEqual([key2]);
    expect((await save(reqA, key, 1, body(), { requestId: r.id })).body.error.code).toBe('DRAFT_CLOSED');
    // 别人的需求单存不了修改草稿；采购经办没有「提需求单」，草稿的接口进不来
    expect((await save(reqB, randomUUID(), 0, body(), { requestId: r.id })).status).toBe(404);
    expect((await save(buyer, randomUUID(), 0, body(), { requestId: r.id })).status).toBe(403);
    // 改好提交：草稿清掉
    const put = await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${r.id}`, { draftKey: key2, lines: [fullLine(r.img, { name: '改好了' })] });
    expect(put.status).toBe(200);
    expect((await list(reqA)).drafts).toEqual([]);
    expect((await save(reqA, key2, 1, body(), { requestId: r.id })).body.error.code).toBe('DRAFT_CLOSED');
  });

  it('需求单通过、撤回以后它的修改草稿清掉，也不能再存', async () => {
    const a = await create('会被通过');
    const b = await create('会被撤回');
    const ka = randomUUID();
    const kb = randomUUID();
    await save(reqA, ka, 0, body(), { requestId: a.id });
    await save(reqA, kb, 0, body(), { requestId: b.id });
    expect((await list(reqA)).drafts).toHaveLength(2);
    // 退回：还能改，草稿留着
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${a.id}/return`, { reason: '数量再核一下' })).status).toBe(200);
    expect((await list(reqA, `?requestId=${a.id}`)).drafts).toHaveLength(1);
    // 改好重新提交以后再存一份，然后采购通过
    await api(ctx.app, reqA, 'PUT', `/api/erp/requests/${a.id}`, { lines: [fullLine(a.img, { name: '会被通过' })] });
    const ka2 = randomUUID();
    expect((await save(reqA, ka2, 0, body(), { requestId: a.id })).status).toBe(200);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${a.id}/approve`, {})).status).toBe(200);
    expect((await api(ctx.app, reqA, 'POST', `/api/erp/requests/${b.id}/cancel`, { reason: '不要了' })).status).toBe(200);
    expect((await list(reqA)).drafts).toEqual([]);
    expect((await save(reqA, ka2, 1, body(), { requestId: a.id })).body.error.code).toBe('DRAFT_CLOSED');
    const fresh = await save(reqA, randomUUID(), 0, body(), { requestId: b.id });
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe('DRAFT_CLOSED');
  });
});

describe('过期清理与图片', () => {
  it(`${DRAFT_KEEP_DAYS} 天没再保存的草稿自动清理；关闭满一天的也清掉；没到期的留着`, async () => {
    const old = randomUUID();
    const recent = randomUUID();
    const closed = randomUUID();
    const closedOld = randomUUID();
    for (const k of [old, recent, closed, closedOld]) await save(reqA, k, 0);
    await remove(reqA, closed);
    await remove(reqA, closedOld);
    await ctx.sql`UPDATE erp_drafts SET updated_at = now() - make_interval(days => ${DRAFT_KEEP_DAYS}, mins => 1) WHERE key = ${old}`;
    await ctx.sql`UPDATE erp_drafts SET updated_at = now() - make_interval(days => ${DRAFT_KEEP_DAYS - 1}) WHERE key = ${recent}`;
    await ctx.sql`UPDATE erp_drafts SET closed_at = now() - interval '25 hours' WHERE key = ${closedOld}`;
    // 过期的还没被清掉时草稿箱里也已经看不到
    expect((await list(reqA)).drafts.map((d) => d.key)).toEqual([recent]);
    expect((await api(ctx.app, reqA, 'GET', `/api/erp/requests/drafts/${old}`)).status).toBe(404);
    expect(await sweepDrafts(ctx.sql)).toBe(2);
    const left = await ctx.sql<{ key: string }[]>`SELECT key FROM erp_drafts WHERE key IN ${ctx.sql([old, recent, closed, closedOld])} ORDER BY id`;
    expect(left.map((r) => r.key).sort()).toEqual([recent, closed].sort());
    // 每分钟的自动任务里带着这一项
    await ctx.sql`UPDATE erp_drafts SET updated_at = now() - make_interval(days => ${DRAFT_KEEP_DAYS + 1}) WHERE key = ${recent}`;
    const logs: string[] = [];
    await runMinuteJobs({ sql: ctx.sql, config: ctx.config }, { info: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) }, { birthday: false });
    expect(logs.some((m) => m.startsWith('草稿箱：清理 1 份'))).toBe(true);
    expect((await ctx.sql`SELECT 1 FROM erp_drafts WHERE key = ${recent}`).length).toBe(0);
  });

  it('只有部门申购权限的账号：自己草稿里的图片看得到（同一张图别人先传过也一样），删掉草稿以后看不到', async () => {
    // 同一张图水吧先传过：按内容只存一份，上传人记的是水吧
    const theirs = await upload(reqB, 'shared');
    const mine = await upload(reqA, 'shared');
    expect(mine.id).toBe(theirs.id);
    expect((await ctx.app.inject({ method: 'GET', url: mine.url, headers: { cookie: reqA } })).statusCode).toBe(404);
    const key = randomUUID();
    await save(reqA, key, 0, body([line({ imageIds: [mine.id] })]));
    expect((await ctx.app.inject({ method: 'GET', url: mine.url, headers: { cookie: reqA } })).statusCode).toBe(200);
    await remove(reqA, key);
    expect((await ctx.app.inject({ method: 'GET', url: mine.url, headers: { cookie: reqA } })).statusCode).toBe(404);
    void reqAId;
  });
});
