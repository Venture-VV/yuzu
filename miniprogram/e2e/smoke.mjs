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

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 这位演示会员现在有效的微信绑定都解掉（上次中途退出时可能留着） */
async function unbindAll(staff, memberId, reason) {
  const rows = await (await staff('GET', `/api/admin/mp/members/${memberId}/bindings`)).json();
  let n = 0;
  for (const r of rows.filter((x) => !x.unboundAt)) {
    const u = await staff('POST', `/api/admin/mp/bindings/${r.id}/unbind`, { clientKey: crypto.randomUUID(), reason });
    if (u.ok) n++;
  }
  return n;
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
    // 开发者工具第一次启动、初始化要一会儿
    mp = await automator.launch({ cliPath: process.env.WECHAT_CLI, projectPath: PROJECT, trustProject: true, timeout: 90000 });
    // 首页
    let page = await mp.reLaunch('/pages/home/index');
    let d = await waitData(page, (x) => x.status !== 'loading');
    check('首页：门店信息', d.status === 'ready' && d.stores.length >= 1, d.stores.map((s) => s.name).join('、'));
    check('首页：版头的字标', (await textOf(page, '.wordmark')).includes('TOUCHILL'));
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
    page = await mp.navigateTo('/pages/unbind/index');
    check('解绑与换号：到前台办理', (await textOf(page, '.panel')).includes('前台'));
    await shot('09-unbind');
  } finally {
    // ③ 收尾：解绑（写原因）、关上开关，再回读核对，演示库恢复原样
    try {
      const n = await unbindAll(staff, memberId, '小程序自动化测试后解绑');
      if (bound) check('员工端口解绑', n >= 1);
      if (switched) await staff('PUT', '/api/admin/mp/rules', { enabled: false });
      const admin = await (await staff('GET', '/api/admin/mp')).json();
      check('收尾：小程序开关已关上', !!admin && !!admin.rules && admin.rules.enabled === false);
      const rows = await (await staff('GET', `/api/admin/mp/members/${memberId}/bindings`)).json();
      check('收尾：没有留下有效绑定', Array.isArray(rows) && rows.filter((x) => !x.unboundAt).length === 0);
    } finally {
      if (mp) await mp.close();
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} 项通过，${failed} 项没过；截图在 ${SHOTS}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('✗ 出错：', e && e.message ? e.message : e);
  process.exit(1);
});
