// 工作台 · 小程序版面渲染器、容错回退与「每次进页面 / 回到前台重新取版面（定时发布）」的单元测试（8.1.2，docs/STUDIO_MP.md）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MpStore, MpStudioDoc, MpStudioNode } from '../../src/shared/mp';
import type { CardView } from '../src/utils/member-card';
import {
  buildThemeStyle,
  formatTodayBeijing,
  prepareScreenRender,
  resolveMpField,
  rpx,
  runMpStudioAction,
  screenUsesMemberField,
  studioColor,
  validateMpStudioDoc,
} from '../src/utils/studio-style';
import type { RenderNode } from '../src/utils/studio-style';

const FIXTURES_DIR = fileURLToPath(new URL('../../tests/fixtures/studio/mp', import.meta.url));

function loadFixture(name: string): { name: string; screen: 'home' | 'activity' | 'member'; doc: MpStudioDoc } {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as {
    name: string;
    screen: 'home' | 'activity' | 'member';
    doc: MpStudioDoc;
  };
}

function flattenNodes(nodes: RenderNode[]): RenderNode[] {
  const out: RenderNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.children.length) out.push(...flattenNodes(n.children));
  }
  return out;
}

const SAMPLE_STORE: MpStore = {
  code: 'baoan',
  name: '汤崎·前海店',
  isHome: true,
  hours: '10:00–次日 02:00',
  address: '深圳市南山区前海路 88 号',
  phone: '0755-8888 0000',
  latitude: 22.5333,
  longitude: 113.9001,
  notice: '夜场延长至凌晨两点',
  imageId: null,
};

const SAMPLE_CARD: CardView = {
  name: '林女士',
  memberNo: '1024',
  frozen: false,
  merged: false,
  code: 'L2',
  gradeName: '潭影',
  tierName: '享',
  ladder: [],
  bar: null,
  cycle: '',
  next: '',
  total: '¥1,280.00',
  principal: '¥1,000.00',
  bonus: '¥280.00',
  deduction: '先本金，后赠金',
  coupons: 3,
  recharge: true,
  couponCenter: true,
  invite: true,
  food: true,
  booking: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('样式换算、颜色与主题变量（docs/STUDIO_MP.md 第 1、3 节）', () => {
  it('375 设计宽换算成 750rpx（1px = 2rpx），颜色把 8 位十六进制转成 rgba()、主题变量转成 var(--…)', () => {
    expect(rpx(0)).toBe('0');
    expect(rpx(18)).toBe('36rpx');
    expect(rpx(375)).toBe('750rpx');
    expect(rpx(0.5)).toBe('1rpx');

    expect(studioColor('#4E6B82')).toBe('#4E6B82');
    expect(studioColor('#B5532F80')).toBe('rgba(181, 83, 47, 0.502)');
    expect(studioColor('$wood')).toBe('var(--wood)');
    expect(studioColor('$wood6')).toBe('var(--wood-6)');
    expect(studioColor('$cardInk')).toBe('var(--card-ink)');
    expect(studioColor('$unknown')).toBe('');
    expect(studioColor(null)).toBe('');
  });

  it('主题色与衬线字体转成页面最外层的行内 CSS 变量，忽略自引用与非法颜色', () => {
    const f1 = loadFixture('01-home-default');
    const css = buildThemeStyle({
      colors: { ...f1.doc.theme.colors, bg: '#FAF6EF', wood: '$wood' },
      fonts: { zh: 'serif', en: 'serif' },
    });
    expect(css).toContain('--bg:#FAF6EF;');
    expect(css).toContain('--card-a:#5B4432;');
    expect(css).not.toContain('--wood:var(');
    expect(css).toContain("--font-zh:'Songti SC'");
    expect(css).toContain('--font-en:Georgia');
  });

  it('数据字段：门店、已绑定会员与北京时间今天日期；未绑定或字段未知时返回空串', () => {
    // 2026-11-15T12:00:00Z = 北京时间 2026-11-15 20:00（周日）
    const nowMs = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(formatTodayBeijing(nowMs)).toBe('11 月 15 日 周日');
    expect(resolveMpField('store.name', { store: SAMPLE_STORE })).toBe('汤崎·前海店');
    expect(resolveMpField('store.hours', { store: SAMPLE_STORE })).toBe('10:00–次日 02:00');
    expect(resolveMpField('member.name', { card: SAMPLE_CARD })).toBe('林女士');
    expect(resolveMpField('member.grade', { card: SAMPLE_CARD })).toBe('L2 潭影 · 享');
    expect(resolveMpField('member.balance', { card: SAMPLE_CARD })).toBe('¥1,280.00');
    expect(resolveMpField('member.coupons', { card: SAMPLE_CARD })).toBe('3');
    expect(resolveMpField('member.coupons', { card: null })).toBe('');
    expect(resolveMpField('today.date', { nowMs })).toBe('11 月 15 日 周日');
    expect(resolveMpField('not.exists', { store: SAMPLE_STORE, card: SAMPLE_CARD })).toBe('');
  });
});

describe('五份官方样例逐份核对（tests/fixtures/studio/mp/01..05.json）', () => {
  const assetUrl = (id: string) => `https://mp.example.com/v1/studio/assets/${id}`;

  it('01-home-default：功能块插槽、不换行横排外边距、换行横排负外边距抵消、全程不用 CSS gap', () => {
    const f = loadFixture('01-home-default');
    expect(validateMpStudioDoc(f.doc)).not.toBeNull();
    expect(screenUsesMemberField(f.doc.screens.home)).toBe(false);

    const rendered = prepareScreenRender(f.doc, 'home', { store: SAMPLE_STORE, card: null }, assetUrl)!;
    expect(rendered).not.toBeNull();
    expect(rendered.nodes.map((n) => [n.id, n.type, n.blockSlot])).toEqual([
      ['home-banner', 'block', 'banner'],
      ['home-store', 'block', 'store'],
      ['home-pillars', 'frame', ''],
      ['home-services', 'frame', ''],
    ]);
    expect(rendered.bannerProps).toMatchObject({ shade: 0.2, wordmark: true, autoplay: true });
    expect(rendered.storeProps).toMatchObject({ cardBg: 'var(--surface)', buttons: true });

    const all = flattenNodes(rendered.nodes);
    for (const n of all) {
      expect(/(^|[\s;{])gap:/.test(n.style), n.id).toBe(false);
      expect(/(^|[\s;{])gap:/.test(n.innerWrapStyle), n.id).toBe(false);
    }

    const byId = Object.fromEntries(all.map((n) => [n.id, n]));
    // 三块业务：不换行横排 gap=8 -> 16rpx，前两个带 margin-right:16rpx，最后一个不带
    expect(byId['home-taste']!.style).toContain('flex:1 1 0%;min-width:0;');
    expect(byId['home-taste']!.style).toContain('margin-right:16rpx;');
    expect(byId['home-wellness']!.style).toContain('margin-right:16rpx;');
    expect(byId['home-exp']!.style).not.toContain('margin-right:');

    // 服务入口：换行横排 gap=11 -> 22rpx，内层包 width:calc(100% + 22rpx) 负外边距，4 个 152rpx 卡片一行排满
    expect(byId['home-services-grid']!.innerWrapStyle).toContain('width:calc(100% + 22rpx);margin-right:-22rpx;margin-bottom:-22rpx;');
    expect(byId['home-code']!.style).toContain('width:152rpx;');
    expect(byId['home-code']!.style).toContain('margin-right:22rpx;margin-bottom:22rpx;');
    expect(byId['home-code']!.action).toEqual({ action: 'open.page', arg: 'code' });
  });

  it('02-member-default：会员卡功能块渐变色与 8 个宫格入口动作', () => {
    const f = loadFixture('02-member-default');
    const rendered = prepareScreenRender(f.doc, 'member', { store: SAMPLE_STORE, card: SAMPLE_CARD }, assetUrl)!;
    expect(rendered.nodes[0]).toMatchObject({ id: 'member-card', type: 'block', blockKey: 'mp.memberCard', blockSlot: 'memberCard' });
    expect(rendered.memberCardProps).toMatchObject({ from: 'var(--card-a)', to: 'var(--card-b)', ink: 'var(--card-ink)' });
    expect(rendered.memberCardProps.cardStyle).toContain('linear-gradient(150deg, var(--card-b), var(--card-a))');

    const actions = flattenNodes(rendered.nodes)
      .filter((n) => n.hasAction)
      .map((n) => `${n.action!.action}:${n.action!.arg}`);
    expect(actions).toEqual([
      'open.page:coupons',
      'open.page:benefits',
      'open.page:ledger',
      'open.page:recharge',
      'open.page:bookings',
      'open.page:invite',
      'open.page:coupon-center',
      'open.page:code',
    ]);
  });

  it('03-activity-poster：海报素材地址、占位底色、门店字段回填与按钮 24rpx 左右内边距', () => {
    const f = loadFixture('03-activity-poster');
    const rendered = prepareScreenRender(f.doc, 'activity', { store: SAMPLE_STORE, card: SAMPLE_CARD }, assetUrl)!;
    const byId = Object.fromEntries(flattenNodes(rendered.nodes).map((n) => [n.id, n]));

    expect(byId.poster).toMatchObject({
      type: 'image',
      imageSrc: 'https://mp.example.com/v1/studio/assets/00424d7a0218b97c8e5bbae2da9e8b7cd341468e9b8780d77d0f3754b3cc8ca8',
      imageMode: 'aspectFill',
    });
    expect(byId.poster!.style).toContain('background-color:var(--wood-6);');
    expect(byId['fact-hours-v']!.text).toBe('10:00–次日 02:00');
    expect(byId['fact-phone-v']!.text).toBe('0755-8888 0000');
    expect(byId['cta-coupon']!.style).toContain('padding-left:24rpx;padding-right:24rpx;');
    expect(byId['cta-coupon']!.action).toEqual({ action: 'open.page', arg: 'coupon-center' });
  });

  it('04-layout-sheet：分布、交叉轴拉伸、内边距、自由定位嵌套与旋转角度', () => {
    const f = loadFixture('04-layout-sheet');
    const rendered = prepareScreenRender(f.doc, 'activity', { store: SAMPLE_STORE, card: SAMPLE_CARD }, assetUrl)!;
    const byId = Object.fromEntries(flattenNodes(rendered.nodes).map((n) => [n.id, n]));

    expect(byId['j-between']!.style).toContain('justify-content:space-between;');
    expect(byId['a-stretch-2']!.style).toContain('align-self:stretch;');
    expect(byId.pad!.style).toContain('padding:40rpx 20rpx 8rpx 60rpx;');
    expect(byId['free-dot']!.style).toContain('position:absolute;left:32rpx;top:32rpx;width:112rpx;height:112rpx;');
    expect(byId['free-dot']!.style).toContain('border-radius:50%;');
    expect(byId['free-sq']!.style).toContain('transform:rotate(15deg);');
  });

  it('05-text-sheet：文字排版、竖直对齐、前后缀数据字段、8 位十六进制颜色、投影与描边', () => {
    const f = loadFixture('05-text-sheet');
    expect(screenUsesMemberField(f.doc.screens.activity)).toBe(true);
    const rendered = prepareScreenRender(f.doc, 'activity', { store: SAMPLE_STORE, card: SAMPLE_CARD }, assetUrl)!;
    const byId = Object.fromEntries(flattenNodes(rendered.nodes).map((n) => [n.id, n]));

    expect(byId['size-32']!.style).toContain('font-size:64rpx;');
    expect(byId['w-900']!.style).toContain('font-weight:900;');
    expect(byId.en!.style).toContain('font-family:var(--font-en);');
    expect(byId.lh!.style).toContain('line-height:56rpx;');
    expect(byId['valign-middle']!.style).toContain('justify-content:center;');
    expect(byId['valign-bottom']!.style).toContain('justify-content:flex-end;');
    expect(byId.deco!.style).toContain('font-style:italic;text-decoration:underline;');
    expect(byId['field-name']!.text).toBe('汤崎·前海店');
    expect(byId['field-coupons']!.text).toBe('可用的券：3 张');
    expect(byId['c-alpha']!.style).toContain('background-color:rgba(181, 83, 47, 0.502);');
    expect(byId['c-opacity']!.style).toContain('opacity:0.5;');
    expect(byId['sh-lg']!.style).toContain('box-shadow:0 24rpx 64rpx rgba(0, 0, 0, 0.22);');
    expect(byId.stroke!.style).toContain('border:6rpx solid var(--wood);');

    // 未绑定会员时字段值为空，但前后缀保留
    const unboundRender = prepareScreenRender(f.doc, 'activity', { store: SAMPLE_STORE, card: null }, assetUrl)!;
    const unboundField = flattenNodes(unboundRender.nodes).find((n) => n.id === 'field-coupons')!;
    expect(unboundField.text).toBe('可用的券： 张');
  });
});

describe('容错与动作执行（docs/STUDIO_MP.md 第 3.8、6 节）', () => {
  it('schema 不是 1 或缺关键结构返回 null；未知节点 type 与 hidden 节点跳过且不给前一个可见节点留尾间距', () => {
    const f = loadFixture('01-home-default');
    expect(validateMpStudioDoc({ ...f.doc, schema: 2 })).toBeNull();
    expect(validateMpStudioDoc({ ...f.doc, surface: 'emenu' })).toBeNull();
    expect(validateMpStudioDoc({ schema: 1, surface: 'mp' })).toBeNull();

    const customDoc: MpStudioDoc = JSON.parse(JSON.stringify(f.doc));
    const base = { name: '', x: 0, y: 0, w: 375, h: 200, rotate: 0, opacity: 1, hidden: false, locked: false };
    customDoc.screens.activity = {
      background: '$bg',
      layout: { mode: 'column', wrap: false, gap: 10, padding: [0, 0, 0, 0], align: 'stretch', justify: 'start' },
      nodes: [
        { ...base, type: 'block', id: 'b1', block: 'mp.banner', props: {} },
        // 重复的同名插槽与放错屏的 mp.memberCard 都安全跳过
        { ...base, type: 'block', id: 'b2', block: 'mp.banner', props: {} },
        { ...base, type: 'block', id: 'b3', block: 'mp.memberCard', props: {} },
        {
          ...base,
          type: 'text',
          id: 't1',
          w: 100,
          h: 20,
          text: { zh: '唯一可见文字', en: '' },
          font: 'zh',
          size: 14,
          weight: 400,
          color: '$ink',
          align: 'left',
          valign: 'top',
          lineHeight: 1.4,
          letterSpacing: 0,
          italic: false,
          underline: false,
          fill: null,
        },
        { ...base, type: 'future-carousel' as unknown as 'rect', id: 'u1', w: 100, h: 40 } as MpStudioNode,
        { ...base, type: 'rect', id: 'h1', w: 100, h: 40, hidden: true, fill: '$wood', stroke: null, strokeWidth: 0, radius: 0, shadow: 'none' },
      ],
    };

    const rendered = prepareScreenRender(customDoc, 'activity', {}, (id) => id)!;
    expect(rendered.nodes.map((n) => n.id)).toEqual(['b1', 't1']);
    expect(rendered.nodes[0]!.style).toContain('margin-bottom:20rpx;');
    // t1 后面的未知节点与隐藏节点都被滤掉，t1 成为最后一个可见节点，不带多余的 margin-bottom
    expect(rendered.nodes[1]!.style).not.toContain('margin-bottom:');
  });

  it('动作：标签栏走 switchTab、子页面走 navigateTo、冻结会员拦住会员码、拨号与导航调微信接口、未知动作忽略', () => {
    const calls: string[] = [];
    vi.stubGlobal('wx', {
      switchTab: (o: { url: string }) => calls.push(`switchTab:${o.url}`),
      navigateTo: (o: { url: string }) => calls.push(`navigateTo:${o.url}`),
      showToast: (o: { title: string }) => calls.push(`toast:${o.title}`),
      makePhoneCall: (o: { phoneNumber: string }) => {
        calls.push(`call:${o.phoneNumber}`);
        return Promise.resolve();
      },
      openLocation: (o: { name: string }) => calls.push(`loc:${o.name}`),
    });

    runMpStudioAction({ action: 'open.page', arg: 'prices' });
    runMpStudioAction({ action: 'open.page', arg: 'activity' });
    runMpStudioAction({ action: 'open.page', arg: 'activity' }, { currentRoute: 'pages/activity/index' });
    runMpStudioAction({ action: 'open.page', arg: 'code' }, { cardFrozen: true });
    runMpStudioAction({ action: 'open.page', arg: 'code' }, { cardFrozen: false });
    runMpStudioAction({ action: 'call.store', arg: '' }, { store: SAMPLE_STORE });
    runMpStudioAction({ action: 'nav.store', arg: '' }, { store: SAMPLE_STORE });
    runMpStudioAction({ action: 'open.page', arg: 'not-a-page' });
    runMpStudioAction({ action: 'unknown.act', arg: 'x' });

    expect(calls).toEqual([
      'switchTab:/pages/prices/index',
      'navigateTo:/pages/activity/index',
      'toast:会员已冻结，会员码用不了，请到前台咨询',
      'navigateTo:/pages/code/index',
      'call:0755-88880000',
      'loc:汤崎 TOUCHILL 汤崎·前海店',
    ]);
  });
});

describe('定时发布前台刷新、缓存兜底与解绑清理（studio.ts + App / Page）', () => {
  it('每次进页面（Page.onShow）与回到前台（App.onShow）重新取版面：定时生效立即换版、同版不重绘、撤销回退原页面、断网用 7 天缓存', async () => {
    const f1 = loadFixture('01-home-default').doc;
    const f2: MpStudioDoc = JSON.parse(JSON.stringify(f1));
    f2.theme.colors.bg = '#EFE6D8';

    let serverLayout: { id: number; version: number; publishedAt: string; doc: unknown } | null = null;
    let networkUp = true;
    const storage: Record<string, unknown> = {};
    let studioRequests = 0;

    let appOptions: { onLaunch?: () => void; onShow?: () => void } | null = null;
    let lastPageOptions: Record<string, unknown> | null = null;

    vi.stubGlobal('App', (o: { onLaunch?: () => void; onShow?: () => void }) => {
      appOptions = o;
    });
    vi.stubGlobal('Page', (o: Record<string, unknown>) => {
      lastPageOptions = o;
    });
    vi.stubGlobal('wx', {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0', appId: 'wx0' } }),
      getWindowInfo: () => ({ windowWidth: 375 }),
      getMenuButtonBoundingClientRect: () => ({ top: 24, bottom: 56, left: 280, right: 365, width: 85, height: 32 }),
      getStorageSync: (k: string) => (k in storage ? storage[k] : ''),
      setStorageSync: (k: string, v: unknown) => {
        storage[k] = JSON.parse(JSON.stringify(v));
      },
      removeStorageSync: (k: string) => {
        delete storage[k];
      },
      login: (o: { success: (r: { code: string }) => void }) => o.success({ code: 'wxcode' }),
      request: (o: { url: string; success: (r: unknown) => void; fail: (e: unknown) => void }) => {
        const path = o.url.replace(/^https?:\/\/[^/]+/, '');
        if (path === '/v1/studio') {
          studioRequests += 1;
          if (!networkUp) {
            setTimeout(() => o.fail({ errMsg: 'request:fail' }), 0);
            return;
          }
          setTimeout(() => o.success({ statusCode: 200, data: { layout: serverLayout }, header: {} }), 0);
          return;
        }
        if (path === '/v1/home') {
          setTimeout(() => o.success({ statusCode: 200, data: { stores: [SAMPLE_STORE], banners: [] }, header: {} }), 0);
          return;
        }
        if (path === '/v1/login') {
          setTimeout(
            () => o.success({ statusCode: 200, data: { token: 'v1.t', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }, header: {} }),
            0,
          );
          return;
        }
        setTimeout(() => o.fail({ errMsg: 'request:fail' }), 0);
      },
    });

    vi.resetModules();
    await import('../src/app');
    await import('../src/pages/home/index');

    const o = lastPageOptions!;
    const setDataCalls: Record<string, unknown>[] = [];
    const page: Record<string, unknown> & { data: Record<string, unknown> } = {
      ...o,
      data: JSON.parse(JSON.stringify(o.data)),
    };
    page.setData = (d: Record<string, unknown>) => {
      setDataCalls.push(d);
      Object.assign(page.data, d);
    };
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'function') page[k] = (o[k] as (...a: unknown[]) => unknown).bind(page);
    }

    // 1. 定时发布还没到点（layout: null）：进首页时使用原来的回退页面
    (page.onLoad as () => void)();
    await vi.waitFor(() => expect(page.data.status).toBe('ready'));
    await vi.waitFor(() => expect(studioRequests).toBeGreaterThanOrEqual(1));
    expect(page.data.studioScreen).toBeNull();
    expect(page.data.themeStyle).toBe('');

    // 2. 设计师的定时发布到点了（id = 10, version = 1）：顾客把小程序切回前台（App.onShow），立即切到新版面
    await new Promise((r) => setTimeout(r, 60));
    serverLayout = { id: 10, version: 1, publishedAt: new Date().toISOString(), doc: f1 };
    appOptions!.onShow!();
    await vi.waitFor(() => expect(page.data.studioScreen).not.toBeNull());
    expect(page.data.themeStyle).toContain('--bg:#F5F1EA;');

    // 3. 再次进页面（Page.onShow），id 仍是 10：重新问了网关，但不重复触发 studioScreen 重绘闪烁
    await new Promise((r) => setTimeout(r, 60));
    const beforeCount = setDataCalls.length;
    const prevRequests = studioRequests;
    (page.onShow as () => void)();
    await vi.waitFor(() => expect(studioRequests).toBeGreaterThan(prevRequests));
    await new Promise((r) => setTimeout(r, 20));
    expect(setDataCalls.slice(beforeCount).filter((d) => 'studioScreen' in d)).toEqual([]);

    // 4. 第二份定时版面到点（id = 11，底色改成 #EFE6D8）：进页面立即换到第 11 版
    await new Promise((r) => setTimeout(r, 60));
    serverLayout = { id: 11, version: 2, publishedAt: new Date().toISOString(), doc: f2 };
    (page.onShow as () => void)();
    await vi.waitFor(() => expect(page.data.themeStyle).toContain('--bg:#EFE6D8;'));

    // 5. 断网时进页面：继续沿用本机缓存的第 11 版，不白屏、不丢版面
    await new Promise((r) => setTimeout(r, 60));
    networkUp = false;
    (page.onShow as () => void)();
    await new Promise((r) => setTimeout(r, 20));
    expect(page.data.studioScreen).not.toBeNull();
    expect(page.data.themeStyle).toContain('--bg:#EFE6D8;');

    // 6. 网络恢复后后台把所有版面撤销了（layout: null）：回到前台立即清掉本机缓存、回退原页面
    await new Promise((r) => setTimeout(r, 60));
    networkUp = true;
    serverLayout = null;
    appOptions!.onShow!();
    await vi.waitFor(() => expect(page.data.studioScreen).toBeNull());
    expect(page.data.themeStyle).toBe('');
    expect(storage.tq_studio_mp).toBeUndefined();
  });
});
