// 小程序页面的自动化冒烟（docs/MINIPROGRAM.md 第 11 节；给本地 AI 在装了微信开发者工具的电脑上跑，云端跑不了）。
// 用官方的 miniprogram-automator 驱动微信开发者工具：逐页打开、核对关键内容、截图；用「模拟微信」绑定一位演示会员，
// 看会员卡、会员码、流水与券，最后在员工端口解绑、把小程序开关关上（可重复执行）。
//
// 只在独立演示库上跑（红线）：先做只读的检查——参数、yuzu 的实例标识必须是 demo（试用库、正式服、测试服、没设标识的一律拒绝）、
// 网关必须是模拟微信——都过了才登录、才改数据；改了数据（解绑、打开开关）之后不论成败都收尾：解绑、关上开关，再回读核对。
// 实例标识只防误操作，不能代替正式主机、账号与数据库的权限隔离。
//
// 前提（见 miniprogram/README.md「在微信开发者工具里打开」）：
//   · 本机的独立演示库（demo-prepare 准备好）与 yuzu：.env 设 YUZU_INSTANCE=demo、MP_PORT、MP_GATEWAY_KEY、MP_CODE_SECRET；
//   · 本机网关：MP_MOCK_WECHAT=true，默认 http://127.0.0.1:8300（与 src/config/env.ts 的 DEV_GATEWAY 一致，别的地址用 GATEWAY_URL）；
//   · 开发者工具已登录、「设置 → 安全设置」打开了服务端口。
// 运行（在 miniprogram/ 下；YUZU_URL 没有默认值，必须写明）：
//   MP_APPID=<测试号的 AppID> WECHAT_CLI=<开发者工具的 cli> YUZU_URL=http://127.0.0.1:<演示库 yuzu 的端口> npm run e2e
//   开发者工具稳定版（2.02）用命令行打开时不认仓库里占位的 touristappid（报「不存在此 AppID」）：
//   给了 MP_APPID 时脚本把它写进 project.private.config.json（按人存、不进仓库），顺带关掉合法域名校验（本机网关是 http）。
//   测试号在 https://developers.weixin.qq.com/sandbox 扫码领取，只用 AppID，AppSecret 不用给。
//   macOS 的 cli 一般在 /Applications/wechatwebdevtools.app/Contents/MacOS/cli，
//   Windows 在 C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat。
// 截图写到 miniprogram/e2e/screenshots/（不进仓库）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import automator from 'miniprogram-automator';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(here, '..');
const SHOTS = join(here, 'screenshots');
const YUZU = (process.env.YUZU_URL || '').trim().replace(/\/+$/, '');
const GATEWAY = (process.env.GATEWAY_URL || 'http://127.0.0.1:8300').trim().replace(/\/+$/, '');
const APPID = (process.env.MP_APPID || '').trim();
const OWNER = process.env.OWNER_USER || 'linlan';
const PASSWORD = process.env.OWNER_PASSWORD || 'yuzu2026';
// 演示库里的会员（seed-demo）：YZ01004 沈知夏
const PHONE = (process.env.MEMBER_PHONE || '19900001004').trim();

// 开发者工具第一次没连上时等多久再试一次（毫秒；单元测试里设成 0）
const RETRY_MS = Number(process.env.MP_E2E_RETRY_MS ?? 5000);

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (e) => (e && e.message ? String(e.message).split('\n')[0] : String(e));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} 返回 ${res.status}`);
  return res.json();
}

/** 只读的准备检查：参数、实例标识（只认 demo）、网关是模拟微信。不登录、不写数据 */
async function preflight() {
  if (!/^https?:\/\/[^/]+$/.test(YUZU)) throw new Error('请用 YUZU_URL 写明本机独立演示库的 yuzu 地址，例如 http://127.0.0.1:18080（没有默认值，免得连到别的实例）');
  if (APPID && !/^wx[0-9a-f]{16}$/.test(APPID)) throw new Error(`MP_APPID 不像小程序的 AppID：${APPID}`);
  if (!/^1\d{10}$/.test(PHONE)) throw new Error(`MEMBER_PHONE 不是 11 位手机号：${PHONE}`);
  const health = await getJson(`${YUZU}/api/health`);
  const instance = health && typeof health.instance === 'string' ? health.instance : '';
  if (instance !== 'demo') {
    throw new Error(`YUZU_URL 的实例标识是「${instance || '未设置'}」：自动化只在实例标识为 demo 的独立演示库上跑（演示库的 .env 设 YUZU_INSTANCE=demo）`);
  }
  const gw = await getJson(`${GATEWAY}/v1/health`);
  if (!gw || gw.mockWechat !== true) throw new Error('GATEWAY_URL 的网关不是模拟微信（MP_MOCK_WECHAT=true）');
}

/** 员工端口登录（店主账号）；返回带会话的请求函数 */
async function staffLogin() {
  const res = await fetch(`${YUZU}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: OWNER, password: PASSWORD }) });
  if (!res.ok) throw new Error(`店主账号登录失败：${res.status}`);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return (method, path, body) =>
    fetch(`${YUZU}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** 测试号的 AppID 写进按人存的 project.private.config.json（不进仓库），并关掉合法域名校验 */
function usePrivateAppid(appid) {
  const file = join(PROJECT, 'project.private.config.json');
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  cfg.appid = appid;
  cfg.setting = { ...(cfg.setting || {}), urlCheck: false };
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

/** 员工端口的请求：不是 2xx 就报错（收尾时据此记「收尾未确认」） */
async function okJson(res) {
  const r = await res;
  if (!r.ok) throw new Error(`员工端口返回 ${r.status}`);
  return r.json();
}

/** 这位演示会员现在有效的微信绑定（上次中途退出时可能留着） */
async function activeBindings(staff, memberId) {
  const rows = await okJson(staff('GET', `/api/admin/mp/members/${memberId}/bindings`));
  if (!Array.isArray(rows)) throw new Error('绑定记录的格式不对');
  return rows.filter((x) => !x.unboundAt);
}

/** 把这位演示会员有效的微信绑定都解掉，返回解掉了几条；有一条没解掉就报错 */
async function unbindAll(staff, memberId, reason) {
  let n = 0;
  for (const r of await activeBindings(staff, memberId)) {
    await okJson(staff('POST', `/api/admin/mp/bindings/${r.id}/unbind`, { clientKey: crypto.randomUUID(), reason }));
    n++;
  }
  return n;
}

/** 关上小程序开关：失败时隔一会儿再试，最多三次 */
async function closeSwitch(staff) {
  let last = null;
  for (const wait of [0, 1000, 3000]) {
    if (wait && RETRY_MS) await sleep(Math.min(wait, RETRY_MS));
    try {
      await okJson(staff('PUT', '/api/admin/mp/rules', { enabled: false }));
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** 启动开发者工具：新项目第一次打开时它要初始化，自动化常常等不到，等一会儿再试一次 */
async function launchTool() {
  const options = { cliPath: process.env.WECHAT_CLI, projectPath: PROJECT, trustProject: true, timeout: 90000 };
  try {
    return await automator.launch(options);
  } catch (e) {
    console.log(`… 开发者工具没连上（${msg(e)}），${RETRY_MS / 1000} 秒后再试一次`);
    await sleep(RETRY_MS);
    return automator.launch(options);
  }
}

async function textOf(page, selector) {
  const el = await page.$(selector);
  return el ? (await el.text()).trim() : '';
}

/** 等页面的 data 满足条件（最多 timeout 毫秒） */
async function waitData(page, pred, timeout = 10000) {
  const until = Date.now() + timeout;
  for (;;) {
    const d = await page.data();
    if (pred(d)) return d;
    if (Date.now() > until) return d;
    await sleep(300);
  }
}

async function main() {
  // ① 只读检查都过了才登录；找不到演示会员时也还没写任何数据
  await preflight();
  const staff = await staffLogin();
  const found = await (await staff('GET', `/api/members?q=${PHONE}&limit=1`)).json();
  const memberId = Array.isArray(found) && found[0] ? found[0].id : null;
  if (!memberId) throw new Error(`演示库里找不到手机号 ${PHONE} 的会员（先执行 demo-prepare）`);

  // ② 从第一次写数据起，不论成败都收尾
  let mp = null;
  let bound = false;
  let switched = false;
  const shot = async (name) => {
    await sleep(500);
    mkdirSync(SHOTS, { recursive: true });
    await mp.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  try {
    await unbindAll(staff, memberId, '小程序自动化测试开始前解绑');
    switched = true;
    const opened = await staff('PUT', '/api/admin/mp/rules', { enabled: true });
    check('员工端口：打开小程序开关', opened.ok);
    if (APPID) usePrivateAppid(APPID);
    mp = await launchTool();
    // 首页
    let page = await mp.reLaunch('/pages/home/index');
    let d = await waitData(page, (x) => x.status !== 'loading');
    check('首页：门店信息', d.status === 'ready' && d.stores.length >= 1, d.stores.map((s) => s.name).join('、'));
    // 版头的标志是图片（品牌书 / VI 的几何字，miniprogram/src/assets/brand）
    const logo = await page.$('.wordmark .wm-logo');
    check('首页：版头的标志', !!logo && String(await logo.attribute('src')).includes('/assets/brand/logo-stacked'));
    await shot('01-home');

    // 价目表
    page = await mp.switchTab('/pages/prices/index');
    d = await waitData(page, (x) => x.status !== 'loading');
    check('价目表：分类与价格', d.status === 'ready' && d.tabs.length > 0 && d.rows.length > 0, `${d.tabs.length} 个分类`);
    await shot('02-prices');

    // 导览
    page = await mp.switchTab('/pages/guide/index');
    d = await waitData(page, (x) => x.status !== 'loading');
    check('导览：楼层图或「还在准备」', d.status === 'ready' || d.status === 'empty', d.status);
    await shot('03-guide');

    // 我的：没绑定 → 模拟绑定
    page = await mp.switchTab('/pages/me/index');
    d = await waitData(page, (x) => x.state !== 'loading');
    check('我的：显示模拟微信的绑定', d.state === 'unbound' && d.mock === true, d.state);
    await shot('04-me-unbound');
    // 照顾客的操作：填手机号，再点「模拟绑定」（开发者工具 2.02 里直接调页面方法会报 No context found）
    const input = await page.$('.mock-in');
    if (input) await input.input(PHONE);
    await page.setData({ mockPhone: PHONE });
    const bindButton = await page.$('.mock .pair .primary');
    if (!bindButton) throw new Error('「我的」页找不到「模拟绑定」按钮');
    await bindButton.tap();
    d = await waitData(page, (x) => x.state === 'bound' && !!x.card);
    bound = d.state === 'bound';
    check('绑定后显示会员卡', bound && !!d.card, d.card ? `${d.card.name} ${d.card.code} ${d.card.gradeName}` : d.state);
    await shot('05-me-card');

    // 会员码
    page = await mp.navigateTo('/pages/code/index');
    d = await waitData(page, (x) => x.state !== 'loading');
    check('会员码：16 位数字', d.state === 'ready' && /^\d{4} \d{4} \d{4} \d{4}/.test(d.digits), d.digits);
    await shot('06-code');
    if (d.state === 'ready') {
      const code = d.digits.replace(/\s/g, '');
      const res = await staff('GET', `/api/mp-codes/${code}`);
      const who = res.ok ? await res.json() : null;
      check('前台扫会员码（员工端口）查到这位会员', !!who && who.memberId === memberId, who ? `${who.memberNo} ${who.name}` : String(res.status));
    }
    await mp.navigateBack();

    // 流水、券、解绑说明
    page = await mp.navigateTo('/pages/ledger/index');
    d = await waitData(page, (x) => x.state !== 'loading');
    check('余额与流水', d.state === 'ready', `${d.rows ? d.rows.length : 0} 条`);
    await shot('07-ledger');
    await mp.navigateBack();
    page = await mp.navigateTo('/pages/coupons/index');
    d = await waitData(page, (x) => x.state !== 'loading');
    check('我的券', d.state === 'ready', `可用 ${d.usable ? d.usable.length : 0} 张`);
    await shot('08-coupons');
    await mp.navigateBack();
    page = await mp.navigateTo('/pages/benefits/index');
    d = await waitData(page, (x) => x.state !== 'loading');
    check('本月可享', d.state === 'ready' && !!d.view, d.view ? `${d.view.groups.reduce((n, g) => n + g.items.length, 0)} 项，升档以后 ${d.view.upcoming.length} 项` : d.message);
    await shot('08b-benefits');
    await mp.navigateBack();
    page = await mp.navigateTo('/pages/unbind/index');
    check('解绑与换号：到前台办理', (await textOf(page, '.panel')).includes('前台'));
    await shot('09-unbind');
  } finally {
    // ③ 收尾：解绑（写原因）、关上开关、回读核对，演示库恢复原样。
    // 几步互不影响：哪一步出错只记下「收尾未确认」，后面的照做（解绑出错也照样关开关）
    const step = async (label, fn) => {
      try {
        await fn();
      } catch (e) {
        check(label, false, `收尾未确认：${msg(e)}`);
      }
    };
    await step('收尾：解绑', async () => {
      const n = await unbindAll(staff, memberId, '小程序自动化测试后解绑');
      if (bound) check('员工端口解绑', n >= 1);
    });
    if (switched) await step('收尾：关上小程序开关', () => closeSwitch(staff));
    await step('收尾：回读小程序开关', async () => {
      const admin = await okJson(staff('GET', '/api/admin/mp'));
      check('收尾：小程序开关已关上', !!admin && !!admin.rules && admin.rules.enabled === false);
    });
    await step('收尾：回读绑定', async () => {
      check('收尾：没有留下有效绑定', (await activeBindings(staff, memberId)).length === 0);
    });
    if (results.some((r) => !r.ok && r.label.startsWith('收尾'))) {
      console.log('！收尾没有确认完：请在后台「微信小程序」确认开关已关上、这位演示会员没有有效绑定，或恢复后重跑本脚本');
    }
    if (mp) await step('收尾：关闭开发者工具的自动化', () => mp.close());
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项没过；截图在 ${SHOTS}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('✗ 出错：', e && e.message ? e.message : e);
  process.exit(1);
});
