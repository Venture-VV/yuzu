// UI 工作台的接口（8.1.1，docs/WORKBENCH_V811.md 第 5、6、9 节）：设计师只进工作台；草稿带版本号；发布、回滚带操作编号
// （原样重提只发一版、内容不同拒绝、确认作废以后不再发）；检查拦得住红的；平板读到已发布的那一版；素材只收真图片、SVG 不收脚本；
// 预览码 30 分钟有效；发布、回滚记审计。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultStudioDoc, type StudioDoc, type StudioNode } from '../src/shared/studio';
import { createStaff } from '../src/server/modules/staff';
import { readPublishedStudio, readStudioAssetFor } from '../src/server/modules/studio/published';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let designer: string;
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const svg = (inner: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="40" height="20">${inner}</svg>`).toString('base64');

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'designer', displayName: '测试设计师', role: 'designer', password: PASSWORD, mustChangePassword: false });
  designer = await login(ctx.app, 'designer');
}, 60_000);
afterAll(async () => ctx.close());

const clone = (d: StudioDoc): StudioDoc => JSON.parse(JSON.stringify(d));
const state = async () => (await api(ctx.app, designer, 'GET', '/api/studio/emenu')).body;
const save = (rev: number, doc: StudioDoc) => api(ctx.app, designer, 'PUT', '/api/studio/emenu/draft', { rev, doc });

describe('设计师只进工作台', () => {
  it('能进工作台、取菜单内容；进不了会员、前台、后台电子菜单、按手牌找客人；别的岗位进不了工作台', async () => {
    expect((await api(ctx.app, designer, 'GET', '/api/studio')).status).toBe(200);
    expect((await api(ctx.app, designer, 'GET', '/api/studio/emenu/menu')).status).toBe(200);
    // 平板菜单只读给设计师（「预览 → 在这台电脑上打开」）；按手牌找客人、下单照旧不给
    expect((await api(ctx.app, designer, 'GET', '/api/emenu/menu')).status).toBe(200);
    for (const url of ['/api/members?q=1', '/api/frontdesk/board', '/api/admin/emenu', '/api/emenu/guest?tag=8060', '/api/emenu/table?table=01', '/api/admin/overview', '/api/ai/status']) {
      expect((await api(ctx.app, designer, 'GET', url)).status, url).toBe(403);
    }
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/studio')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/studio/emenu/draft', { rev: 0, doc: defaultStudioDoc('emenu') })).status).toBe(403);
  });
});

describe('草稿、发布、回滚', () => {
  it('没存过时是默认版面（rev 0）；存草稿带版本号，对不上拒绝；不合格式、按界面登记不过的存不进去', async () => {
    const s = await state();
    expect(s.draft.rev).toBe(0);
    expect(s.published).toBeNull();
    expect(s.draft.doc).toEqual(defaultStudioDoc('emenu'));

    const doc = clone(s.draft.doc);
    doc.theme.colors.tan = '#8a6d3b';
    const r1 = await save(0, doc);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.rev).toBe(1);
    // 另一个窗口还拿着 rev 0
    const stale = await save(0, doc);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STUDIO_REV');

    const unknownBlock = clone(doc);
    unknownBlock.screens.start!.nodes.push({ type: 'block', id: 'x1', name: '', block: 'evil.block', x: 0, y: 0, w: 10, h: 10, rotate: 0, opacity: 1, hidden: false, locked: false, props: {} });
    const bad = await save(1, unknownBlock);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('STUDIO_INVALID');
    const html = JSON.parse(JSON.stringify(doc));
    html.screens.start.nodes.push({ type: 'html', id: 'h', x: 0, y: 0, w: 1, h: 1, html: '<script>alert(1)</script>' });
    expect((await save(1, html)).body.error.code).toBe('STUDIO_FORMAT');
    expect((await state()).draft.rev).toBe(1);
  });

  it('发布：检查过了才发；原样重提只发一版、内容不同拒绝；平板的菜单里带上这一版，按编号取得到版面', async () => {
    const key = randomUUID();
    const r = await api(ctx.app, designer, 'POST', '/api/studio/emenu/publish', { clientKey: key, rev: 1, note: '换强调色' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ version: 1, kind: 'publish', note: '换强调色', screensChanged: ['theme'], publishedBy: '测试设计师' });
    const again = await api(ctx.app, designer, 'POST', '/api/studio/emenu/publish', { clientKey: key, rev: 1, note: '换强调色' });
    expect(again.body).toEqual(r.body);
    const other = await api(ctx.app, designer, 'POST', '/api/studio/emenu/publish', { clientKey: key, rev: 1, note: '另一句' });
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(ctx.app, designer, 'GET', '/api/studio/emenu/versions')).body).toHaveLength(1);

    // 平板（店主有「打开平板点餐」）：菜单里带上这一版，按编号取版面
    const menu = await api(ctx.app, ctx.owner, 'GET', '/api/emenu/menu');
    expect(menu.body.studio).toEqual({ id: r.body.id, version: 1, inherited: false });
    const doc = await api(ctx.app, ctx.owner, 'GET', `/api/studio/docs/${r.body.id}`);
    expect(doc.status).toBe(200);
    expect(doc.body.doc.theme.colors.tan).toBe('#8a6d3b');
    const raw = await ctx.app.inject({ method: 'GET', url: `/api/studio/docs/${r.body.id}`, headers: { cookie: ctx.owner } });
    expect(raw.headers['cache-control']).toContain('immutable');
    // 店员（前台岗位也有「打开平板点餐」）也取得到；没登录的不行
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/studio/docs/${r.body.id}`)).status).toBe(200);
    expect((await api(ctx.app, null, 'GET', `/api/studio/docs/${r.body.id}`)).status).toBe(401);
  });

  it('发布时草稿又改过拒绝；缺了必需的功能块、用了素材库里没有的图，检查拦下（红的）', async () => {
    const stale = await api(ctx.app, designer, 'POST', '/api/studio/emenu/publish', { clientKey: randomUUID(), rev: 2, note: 'x' });
    expect(stale.body.error.code).toBe('STUDIO_REV');

    const doc = clone((await state()).draft.doc);
    doc.screens.start!.nodes = doc.screens.start!.nodes.filter((n) => n.id !== 'start-footer');
    doc.screens.start!.nodes.push({ type: 'image', id: 'poster', name: '海报', x: 100, y: 100, w: 200, h: 100, rotate: 0, opacity: 1, hidden: false, locked: false, asset: 'f'.repeat(64), fit: 'cover', radius: 0, fill: null });
    expect((await save(1, doc)).body.rev).toBe(2);
    const r = await api(ctx.app, designer, 'POST', '/api/studio/emenu/publish', { clientKey: randomUUID(), rev: 2, note: '加海报' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('STUDIO_CHECK');
    const messages = (r.body.error.details.issues as { level: string; message: string }[]).filter((i) => i.level === 'error').map((i) => i.message);
    expect(messages).toContain('起始页缺了「版权行（长按 3 秒退出平板）」：从左边「插入 → 功能块」加回来');
    expect(messages).toContain('「海报」用的图片不在素材库里');
  });

  it('回滚：照旧的一版再发一版（只追加），记谁回滚的；发布、回滚都记审计', async () => {
    // 先把草稿改好发第 2 版（起始页加一行字）
    const doc = clone(defaultStudioDoc('emenu'));
    doc.theme.colors.tan = '#8a6d3b';
    doc.screens.start!.nodes.push({ type: 'text', id: 'hello', name: '欢迎', x: 300, y: 200, w: 424, h: 40, rotate: 0, opacity: 1, hidden: false, locked: false, text: { zh: '欢迎光临', en: 'Welcome' }, font: 'zh', size: 28, weight: 400, color: '$ink', align: 'center', valign: 'top', lineHeight: 1.4, letterSpacing: 0, italic: false, underline: false, fill: null });
    expect((await save(2, doc)).body.rev).toBe(3);
    const v2 = await api(ctx.app, ctx.owner, 'POST', '/api/studio/emenu/publish', { clientKey: randomUUID(), rev: 3, note: '起始页加欢迎语' });
    expect(v2.body).toMatchObject({ version: 2, screensChanged: ['start'], publishedBy: '测试店主' });

    const key = randomUUID();
    const back = await api(ctx.app, designer, 'POST', '/api/studio/emenu/rollback', { clientKey: key, version: 1 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ version: 3, kind: 'rollback', rollbackOf: 1, note: '回到第 1 版', screensChanged: ['start'] });
    expect((await api(ctx.app, designer, 'POST', '/api/studio/emenu/rollback', { clientKey: key, version: 1 })).body.id).toBe(back.body.id);
    const v3 = await api(ctx.app, designer, 'GET', '/api/studio/emenu/versions/3');
    const v1 = await api(ctx.app, designer, 'GET', '/api/studio/emenu/versions/1');
    expect(v3.body.doc).toEqual(v1.body.doc);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/emenu/menu')).body.studio.version).toBe(3);
    // 草稿不动（回滚只是发布）
    expect((await state()).draft.rev).toBe(3);
    expect((await api(ctx.app, designer, 'POST', '/api/studio/emenu/rollback', { clientKey: randomUUID(), version: 99 })).status).toBe(404);

    const audit = await ctx.sql<{ action: string; detail: { version: number } }[]>`
      SELECT action, detail FROM audit_logs WHERE action IN ('studio_publish', 'studio_rollback') ORDER BY id`;
    expect(audit.map((a) => [a.action, a.detail.version])).toEqual([
      ['studio_publish', 1],
      ['studio_publish', 2],
      ['studio_rollback', 3],
    ]);
  });

  it('结果待确认：确认作废以后，原来那一次再到也不会发；查回认得出已经发了的', async () => {
    const lost = randomUUID();
    const fence = await api(ctx.app, designer, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'studio_publish', summary: '发布' });
    expect(fence.status, JSON.stringify(fence.body)).toBe(200);
    const late = await api(ctx.app, designer, 'POST', '/api/studio/emenu/publish', { clientKey: lost, rev: 3, note: '晚到的' });
    expect(late.body.error.code).toBe('OP_ABANDONED');

    const key = randomUUID();
    expect((await api(ctx.app, designer, 'POST', '/api/studio/emenu/publish', { clientKey: key, rev: 3, note: '再发一次' })).status).toBe(200);
    const found = await api(ctx.app, designer, 'GET', `/api/erp/ops/${key}?type=studio_publish`);
    expect(found.body).toMatchObject({ found: true, abandoned: false });
    // 设计师作废不了别的业务的
    expect((await api(ctx.app, designer, 'POST', `/api/erp/ops/${randomUUID()}/abandon`, { type: 'stock_transfer', summary: 'x' })).status).toBe(403);
  });
});

describe('素材与预览码', () => {
  it('只收真图片：PNG 量出宽高、同一张只存一份；不是图片的、SVG 里有脚本或外部链接的不收；SVG 送出去带禁止脚本的 CSP', async () => {
    const a = await api(ctx.app, designer, 'POST', '/api/studio/assets', { name: '点.png', data: PNG_1x1 });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ mime: 'image/png', width: 1, height: 1, name: '点.png', uploadedBy: '测试设计师' });
    expect(a.body.id).toMatch(/^[0-9a-f]{64}$/);
    const b = await api(ctx.app, designer, 'POST', '/api/studio/assets', { name: '又一张.png', data: PNG_1x1 });
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.name).toBe('点.png');

    expect((await api(ctx.app, designer, 'POST', '/api/studio/assets', { name: 'a.png', data: Buffer.from('hello').toString('base64') })).body.error.code).toBe('ASSET_TYPE');
    for (const inner of ['<script>alert(1)</script>', '<rect onload="x()" />', '<image href="https://evil.example/a.png" />', '<foreignObject><div/></foreignObject>']) {
      const r = await api(ctx.app, designer, 'POST', '/api/studio/assets', { name: 'x.svg', data: svg(inner) });
      expect(r.body.error?.code, inner).toBe('ASSET_SVG_UNSAFE');
    }
    const ok = await api(ctx.app, designer, 'POST', '/api/studio/assets', { name: '圆.svg', data: svg('<circle cx="10" cy="10" r="8" fill="#a6947a"/><use href="#c"/>') });
    expect(ok.body).toMatchObject({ mime: 'image/svg+xml', width: 40, height: 20 });
    // 平板（店员有「打开平板点餐」）取得到；SVG 带 CSP
    const got = await ctx.app.inject({ method: 'GET', url: `/api/studio/assets/${ok.body.id}`, headers: { cookie: ctx.clerk } });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/svg+xml');
    expect(String(got.headers['content-security-policy'])).toContain('sandbox');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect((await api(ctx.app, designer, 'GET', '/api/studio/assets')).body.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([a.body.id, ok.body.id]));
  });

  it('预览码：存当时的草稿，平板（登录的）凭码取得到，过期取不到', async () => {
    const doc = clone(defaultStudioDoc('emenu'));
    doc.theme.colors.ink = '#222222';
    const r = await api(ctx.app, designer, 'POST', '/api/studio/emenu/preview-code', { doc });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.code).toMatch(/^[A-Z2-9]{8}$/);
    const got = await api(ctx.app, ctx.clerk, 'GET', `/api/studio/preview/${r.body.code.toLowerCase()}`);
    expect(got.status).toBe(200);
    expect(got.body.doc.theme.colors.ink).toBe('#222222');
    await ctx.sql`UPDATE studio_preview_codes SET expires_at = now() - interval '1 minute' WHERE code = ${r.body.code}`;
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/studio/preview/${r.body.code}`)).status).toBe(404);
  });
});

describe('8.1.2：微信小程序的版面（给小程序线读）', () => {
  const PNG_2x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M9Qz8DAwMAAAA4AAf8Y9gqmAAAAAElFTkSuQmCC';
  const image = (id: string, asset: string): StudioNode => ({ type: 'image', id, name: '海报', x: 0, y: 0, w: 375, h: 200, rotate: 0, opacity: 1, hidden: false, locked: false, sizing: { w: 'fill', h: 'fixed' }, asset, fit: 'cover', radius: 0, fill: null });

  it('设计师能改小程序的版面；发布以前读不到（小程序用自己原来的页面），发布以后读得到这一版；图只给发布过的版面里用到的', async () => {
    const overview = (await api(ctx.app, designer, 'GET', '/api/studio')).body;
    expect(overview.surfaces.map((x: { surface: string }) => x.surface)).toEqual(['emenu', 'mp', 'canteen']);
    const s = (await api(ctx.app, designer, 'GET', '/api/studio/mp')).body;
    expect(s.draft.rev).toBe(0);
    expect(s.draft.doc).toEqual(defaultStudioDoc('mp'));
    expect(s.langSwitch).toBe(false);
    expect(await readPublishedStudio(ctx.sql, 'mp')).toBeNull();

    // 两张图：一张放进小程序的活动页，一张只在素材库
    const used = (await api(ctx.app, designer, 'POST', '/api/studio/assets', { name: '海报.png', data: PNG_1x1 })).body.id as string;
    const unused = (await api(ctx.app, designer, 'POST', '/api/studio/assets', { name: '没用的.png', data: PNG_2x1 })).body.id as string;
    expect(used).not.toBe(unused);
    const doc = clone(s.draft.doc);
    doc.screens.activity!.nodes.unshift(image('poster', used));
    doc.theme.colors.wood = '#8A6A4A';
    const saved = await api(ctx.app, designer, 'PUT', '/api/studio/mp/draft', { rev: 0, doc });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // 没发布：图也取不到
    expect(await readStudioAssetFor(ctx.sql, 'mp', used)).toBeNull();

    const pub = await api(ctx.app, designer, 'POST', '/api/studio/mp/publish', { clientKey: randomUUID(), rev: saved.body.rev, note: '活动页加海报、换木色' });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body).toMatchObject({ version: 1, kind: 'publish', screensChanged: ['theme', 'activity'] });

    const read = await readPublishedStudio(ctx.sql, 'mp');
    expect(read).toMatchObject({ id: pub.body.id, version: 1, inherited: false });
    expect(read!.doc.theme.colors.wood).toBe('#8A6A4A');
    expect(read!.doc.screens.activity!.nodes[0]).toMatchObject({ type: 'image', asset: used });
    // 平板菜单的那一份不受影响
    expect((await readPublishedStudio(ctx.sql, 'emenu'))?.doc.surface ?? 'emenu').toBe('emenu');

    const img = await readStudioAssetFor(ctx.sql, 'mp', used);
    expect(img?.mime).toBe('image/png');
    expect(img?.data.length).toBeGreaterThan(0);
    // 素材库里有、但没在发布过的小程序版面里的：不给；乱写的编号也不给
    expect(await readStudioAssetFor(ctx.sql, 'mp', unused)).toBeNull();
    expect(await readStudioAssetFor(ctx.sql, 'mp', 'not-a-hash')).toBeNull();
    // 只在平板菜单里用的图，小程序取不到
    expect(await readStudioAssetFor(ctx.sql, 'emenu', used)).toBeNull();
  });

  it('组件（8.1.2）：小程序读到的版面里组件已经展开成普通节点（没有 instance、没有 components）；组件里的图取得到', async () => {
    const s = (await api(ctx.app, designer, 'GET', '/api/studio/mp')).body;
    const pic = (await api(ctx.app, designer, 'POST', '/api/studio/assets', { name: '组件里的图.png', data: PNG_2x1 })).body.id as string;
    const doc = clone(s.draft.doc);
    const base = { name: '', rotate: 0, opacity: 1, hidden: false, locked: false };
    doc.components = {
      'c-promo01': {
        name: '活动卡',
        node: { type: 'frame', id: 'card', ...base, x: 0, y: 0, w: 160, h: 90, fill: '$surface', stroke: null, strokeWidth: 0, radius: 12, shadow: 'none', clip: true, children: [{ ...image('pic', pic), w: 160, h: 60 }] },
      },
    };
    doc.screens.activity!.nodes.push(
      { type: 'instance', id: 'promo-a', ...base, x: 12, y: 500, w: 160, h: 90, component: 'c-promo01' },
      { type: 'instance', id: 'promo-b', ...base, x: 190, y: 500, w: 160, h: 90, component: 'c-promo01' },
    );
    const saved = await api(ctx.app, designer, 'PUT', '/api/studio/mp/draft', { rev: s.draft.rev, doc });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const pub = await api(ctx.app, designer, 'POST', '/api/studio/mp/publish', { clientKey: randomUUID(), rev: saved.body.rev, note: '活动页放两张活动卡（组件）' });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.screensChanged).toEqual(expect.arrayContaining(['activity', 'components']));

    const read = (await readPublishedStudio(ctx.sql, 'mp'))!;
    expect(read.version).toBe(pub.body.version);
    expect(read.doc.components).toBeUndefined();
    const nodes = read.doc.screens.activity!.nodes;
    expect(JSON.stringify(nodes)).not.toContain('"instance"');
    expect(nodes.find((n) => n.id === 'promo-b')).toMatchObject({ type: 'frame', x: 190, y: 500, w: 160, h: 90, children: [{ id: 'promo-b__pic', type: 'image', asset: pic }] });
    // 组件里的图：发布过的版面里用到，取得到
    expect((await readStudioAssetFor(ctx.sql, 'mp', pic))?.mime).toBe('image/png');
    // 编辑器、版本里存的还是组件本来的样子
    const v = (await api(ctx.app, designer, 'GET', `/api/studio/mp/versions/${pub.body.version}`)).body;
    expect(Object.keys(v.doc.components)).toEqual(['c-promo01']);
  });

  it('小程序的版面里不认识的动作、字段存不进去；预览码在手机预览页取得到', async () => {
    const s = (await api(ctx.app, designer, 'GET', '/api/studio/mp')).body;
    const bad = clone(s.draft.doc);
    bad.screens.activity!.nodes.push({
      type: 'button', id: 'evil', name: '', x: 0, y: 0, w: 160, h: 44, rotate: 0, opacity: 1, hidden: false, locked: false,
      fill: '$wood', stroke: null, strokeWidth: 0, radius: 8, shadow: 'none', text: { zh: '去', en: '' }, font: 'zh', size: 15, weight: 600, color: '#FFFFFF',
      align: 'center', valign: 'middle', lineHeight: 1.4, letterSpacing: 0, italic: false, underline: false, action: { action: 'open.page', arg: 'pay-anything' },
    });
    const r = await api(ctx.app, designer, 'PUT', '/api/studio/mp/draft', { rev: s.draft.rev, doc: bad });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('STUDIO_INVALID');

    const code = await api(ctx.app, designer, 'POST', '/api/studio/mp/preview-code', { doc: s.draft.doc });
    expect(code.status, JSON.stringify(code.body)).toBe(200);
    const got = await api(ctx.app, designer, 'GET', `/api/studio/preview/${code.body.code}`);
    expect(got.status).toBe(200);
    expect(got.body.surface).toBe('mp');
  });
});
