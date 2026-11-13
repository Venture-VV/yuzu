// Synthetic concierge enrollment only; uses the existing isolated CI demo environment.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { MemberInsights } from "../src/shared/concierge/insights-types";
import type { PraiseCenterData } from "../src/shared/concierge/praise-types";
async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#username", "linlan");
  await page.fill("#password", "yuzu2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible({
    timeout: 30000,
  });
}
async function insights(page: Page, params = ""): Promise<MemberInsights> {
  const response = await page.request.get("/api/concierge/member-insights" + (params ? "?" + params : ""));
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
function calendarDate(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
const moduleNav = (page: Page) => page.getByRole("navigation", { name: "管家业务模块", exact: true });
test("管家部嵌入企业后台并可从手机布局打开", async ({ page }) => {
  await login(page);
  // 管家部在门店主导航里（与前台、预约、会员并列）；Codex 最初放的后台地址跳过来
  await page.goto("/admin/concierge");
  await expect(page).toHaveURL(/\/concierge$/);
  await expect(
    page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "管家" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    // The dashboard heading includes today's date after its title.
    page.getByRole("heading", { level: 1, name: /^今日工作台/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "管家业务模块" }),
  ).toBeVisible();
  // 独立站留下的品牌字样不再出现；手机上底部的常用入口不盖住左边的主导航（头像那里是改密码、退出）
  await expect(page.getByText("TANGQI CONCIERGE")).toHaveCount(0);
  const bottom = page.getByRole("navigation", { name: "手机常用入口" });
  if (await bottom.isVisible()) {
    const rail = (await page.getByRole("navigation", { name: "主导航" }).boundingBox())!;
    const bar = (await bottom.boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 2,
    ),
  ).toBe(true);
});
test("前台会员建立服务档案，原生资料实时同步，历史核对只读", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "门店电脑", "变更流程只在门店电脑组执行");
  await login(page);
  const stamp = String(Date.now()).slice(-8), name = "E2E服务-" + stamp;
  const made = await page.request.post("/api/members", { data: { name, phone: "199" + stamp } });
  expect(made.status(), await made.text()).toBe(201);
  const native = await made.json();
  await page.goto("/concierge");
  await page.getByRole("button", { name: "建立服务档案", exact: true }).first().click();
  let dialog = page.getByRole("dialog", { name: "建立管家服务档案" });
  await dialog.getByRole("textbox", { name: "选择系统会员 *", exact: true }).fill(name);
  await dialog.locator(".native-member-option").filter({ hasText: name }).click();
  await expect(dialog.locator('input[name="name"]')).toHaveValue(name);
  await expect(dialog.locator('input[name="phone"]')).toHaveValue("199" + stamp);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: new RegExp(name) }).first().click();
  const member = page.locator(".member-drawer");
  await expect(member).toContainText(/会员档案 · \d{6}/);
  await expect(member.getByRole("button", { name: "新增人工核对记录", exact: true })).toHaveCount(0);
  await expect(member).toContainText("系统实时余额");
  // A synthetic historical record remains readable; the retired input is absent.
  const lookup = await page.request.get("/api/concierge/native-members?q=" + encodeURIComponent(name));
  const found = (await lookup.json()).members.find((m: any) => m.id === native.id);
  const historical = await page.request.post("/api/concierge/workspace", { data: {
    action: "saveBalance", requestId: randomUUID(), payload: { memberId: found.profiles[0].id,
      amount: "29999.99", checkedAt: new Date().toISOString(), source: "CI旧规则历史样例",
      note: "保留依据，不覆盖当前钱包", expectedBalanceId: null, uploadIds: [], receiptIds: [] }
  }});
  expect(historical.status(), await historical.text()).toBe(200);
  // An already-open drawer changes without page.reload() or pressing Sync.
  const edit = await page.request.put(`/api/members/${native.id}`, { data: { name: name + "新名", phone: "199" + stamp } });
  expect(edit.status(), await edit.text()).toBe(200);
  await expect(member.getByRole("heading", { name: name + "新名", exact: true })).toBeVisible({ timeout: 15000 });
  await member.getByRole("button", { name: "历史核对", exact: true }).click();
  await expect(member).toContainText("29,999.99");
});

// ── 8.0.15（docs/ORDERS_V8015.md 第 1 节）──
// 门店内网用 http://IP 打开时没有 crypto.randomUUID（只在 HTTPS / localhost 下有）；8.0.12 的管家部直接用了它，点「新增会员」没反应。
// 这里把这个接口拿掉来模拟内网 HTTP：点按钮 1 秒内出录入窗，提交后名单与「在册会员」数马上更新，代录预约、拍消费单同样打得开。
test("内网 HTTP（没有 crypto.randomUUID）：新增会员 1 秒内弹窗、提交后名单与在册数更新；代录预约、拍消费单打得开；没有相关报错", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "门店电脑", "变更流程只在门店电脑组执行");
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && /randomUUID|is not a function/i.test(m.text())) problems.push(m.text());
  });
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined, configurable: true, writable: true });
  });
  await login(page);
  await page.goto("/concierge");
  await expect(page.getByRole("heading", { level: 1, name: /^今日工作台/ })).toBeVisible();
  expect(await page.evaluate(() => typeof (crypto as { randomUUID?: unknown }).randomUUID)).toBe("undefined");
  const enrolledCard = page.locator(".stat-card", { hasText: "服务会员" });
  const enrolled = async () => Number(/(\d+)/.exec(await enrolledCard.locator(".stat-value").innerText())?.[1] ?? NaN);
  const before = await enrolled();
  expect(Number.isInteger(before)).toBe(true);

  // 前台先办理身份，再由管家建服务档案；内网没有randomUUID时仍能打开并保存。
  const name = "E2E内网会员-" + randomUUID().slice(0, 8);
  const phone = "139" + String(Date.now()).slice(-8);
  const made = await page.request.post("/api/members", { data: { name, phone } });
  expect(made.status(), await made.text()).toBe(201);
  await page.getByRole("button", { name: "建立服务档案", exact: true }).first().click();
  let dialog = page.getByRole("dialog", { name: "建立管家服务档案" });
  await expect(dialog).toBeVisible({ timeout: 1000 });
  await dialog.getByRole("textbox", { name: "选择系统会员 *", exact: true }).fill(name);
  await dialog.locator(".native-member-option").filter({ hasText: name }).click();
  await expect(dialog.locator('input[name="name"]')).toHaveValue(name);
  await expect(dialog.locator('input[name="phone"]')).toHaveValue(phone);
  await dialog.getByRole("textbox", { name: /备注/ }).fill("喜欢靠窗的位置");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  // 「在册会员」数加一；名单里马上有，点开档案里带着备注
  await expect.poll(enrolled).toBe(before + 1);
  await enrolledCard.click();
  await page.getByRole("button", { name: new RegExp(name) }).first().click();
  const member = page.getByRole("complementary", { name: name + "的会员档案" });
  await expect(member).toContainText(/会员档案 · \d{6}/);
  await member.getByText("基本档案", { exact: true }).click();
  await expect(member).toContainText("喜欢靠窗的位置");
  // 从档案里代录预约、拍消费单：都能直接关联到这位会员
  await member.getByRole("button", { name: "录预约", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "登记新预约" });
  await expect(dialog).toBeVisible({ timeout: 1000 });
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).not.toBeVisible();

  await page.locator(".drawer-scrim").click({ position: { x: 10, y: 10 } });
  await expect(member).not.toBeVisible();

  // 工作台上的三个入口：新增会员、代录预约、拍消费单
  await page.getByRole("navigation", { name: "管家业务模块" }).getByRole("button", { name: /工作台/ }).first().click();
  await page.locator(".quick-actions").getByRole("button", { name: /代录预约/ }).click();
  dialog = page.getByRole("dialog", { name: "登记新预约" });
  await expect(dialog).toBeVisible({ timeout: 1000 });
  await dialog.getByRole("button", { name: "关闭" }).click();
  await page.locator(".quick-actions").getByRole("button", { name: /拍消费单/ }).click();
  const capture = page.getByRole("dialog").last();
  await expect(capture).toBeVisible({ timeout: 1000 });
  await expect(capture).toContainText(/拍|凭证|小票/);
  expect(problems).toEqual([]);
});

// ── 主线整改（docs/HANDOFF_V8012.md）──
// 合成小票：用页面画一张（不是真实小票），当作拍到的照片
async function syntheticReceipt(page: Page, number: string): Promise<Buffer> {
  const draw = await page.context().browser()!.newPage({ viewport: { width: 720, height: 1100 }, deviceScaleFactor: 2 });
  try {
    await draw.setContent(`<body style="margin:0;background:#fff;font-family:'WenQuanYi Zen Hei','Noto Sans CJK SC',sans-serif;color:#000">
      <div style="padding:36px 44px;font-size:30px;line-height:1.7">
        <div style="text-align:center;font-size:38px;font-weight:bold">合成测试门店</div>
        <div style="text-align:center">结算单</div>
        <div>单号：${number}</div><div>时间：2026-11-12 10:24:32</div>
        <hr style="border:0;border-top:2px dashed #000">
        <div style="display:flex;justify-content:space-between"><span>项目</span><span>数量</span><span>金额</span></div>
        <div style="display:flex;justify-content:space-between"><span>精油按摩</span><span>1</span><span>298.00</span></div>
        <div style="display:flex;justify-content:space-between"><span>柠檬红茶</span><span>2</span><span>36.00</span></div>
        <div style="display:flex;justify-content:space-between"><span>水果拼盘</span><span>1</span><span>58.00</span></div>
        <hr style="border:0;border-top:2px dashed #000">
        <div style="display:flex;justify-content:space-between"><span>合计</span><span>392.00</span></div>
        <div style="display:flex;justify-content:space-between"><span>实付</span><span>392.00</span></div>
        <div>支付方式：微信支付 392.00</div>
      </div></body>`);
    return await draw.screenshot();
  } finally {
    await draw.close();
  }
}

test("只有管家职责的后勤账号：登录直接进管家部；手机上拍一张合成小票，在浏览器本机识别出单号与金额", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "门店电脑", "会写数据的流程只在门店电脑组执行（手机那一段另开手机尺寸的窗口）");
  test.setTimeout(240_000);
  await login(page);
  // 店主建一个后勤 + 管家职责的账号（用户名带这次的时间，跑完停用）
  const stamp = String(Date.now()).slice(-8);
  const made = await page.request.post("/api/staff", { data: { username: `e2egj${stamp}`, displayName: "E2E 管家", role: "backoffice", duties: ["concierge"], password: "E2e-guanjia-2026" } });
  expect(made.status(), await made.text()).toBe(201);
  const staff = (await made.json()) as { id: number; temporaryPassword: string };
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "zh-CN", timezoneId: "Asia/Shanghai", baseURL: testInfo.project.use.baseURL });
  try {
    const p = await phone.newPage();
    // 识别用到的脚本、语言模型、名称模型都从本站取，一个都不能缺（原来的构建把两份语言模型删了，打包后的系统识别不了）
    const ocr: { url: string; status: number; type: string }[] = [];
    p.on("response", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/concierge/ocr/")) ocr.push({ url: u.pathname, status: r.status(), type: r.headers()["content-type"] ?? "" });
    });
    await p.goto("/login");
    await p.fill("#username", `e2egj${stamp}`);
    await p.fill("#password", staff.temporaryPassword);
    await p.getByRole("button", { name: "登录", exact: true }).click();
    // 首次登录先换密码
    await expect(p.getByText("设置你的密码")).toBeVisible();
    const pw = p.locator("input[type=password]");
    await pw.nth(0).fill(staff.temporaryPassword);
    await pw.nth(1).fill("E2e-guanjia-2027");
    await pw.nth(2).fill("E2e-guanjia-2027");
    await p.getByRole("button", { name: "保存新密码" }).click();
    // 直接进管家部（不是会员工作台，也不是餐饮、客房）
    await expect(p).toHaveURL(/\/concierge$/, { timeout: 20_000 });
    await expect(p.getByRole("heading", { level: 1, name: /^今日工作台/ })).toBeVisible();
    // 管家在门店主导航里只看得到自己能用的页面：有「管家」，没有「后台」「会员」「流水」
    const nav = p.getByRole("navigation", { name: "主导航" });
    await expect(nav.getByRole("link", { name: "管家" })).toBeVisible();
    for (const hidden of ["后台", "会员", "流水", "前台"]) await expect(nav.getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
    // 后台进不去：回到管家部
    await p.goto("/admin");
    await expect(p).toHaveURL(/\/concierge$/);
    // 建一位管家会员（接口），再拍单
    const number = `E2E${stamp}`;
    const native = await page.request.post("/api/members", { data: { name: `E2E拍单-${stamp}`, phone: "198" + stamp } });
    expect(native.status(), await native.text()).toBe(201);
    const nativeId = (await native.json()).id;
    const member = await p.request.post("/api/concierge/workspace", { data: { action: "createMember", requestId: randomUUID(), payload: { nativeMemberId: nativeId, name: `E2E拍单-${stamp}`, phone: "", cardNo: `E2E-OCR-${stamp}`, ownerId: "", cardTier: "", preferences: "", source: "", joinedAt: "" } } });
    expect(member.status(), await member.text()).toBe(200);
    await p.reload();
    await p.getByRole("button", { name: /拍消费单/ }).first().click();
    await p.locator("input[type=file]").last().setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: await syntheticReceipt(p, number) });
    await p.getByRole("button", { name: "保存图片并识别" }).click();
    // 识别在浏览器里跑：出来的是「识别草稿」，单号、实付金额认得出（数字与字母最稳，中文名称不作断言）
    await expect(p.getByText(/识别草稿/).first()).toBeVisible({ timeout: 180_000 });
    const values = () => p.evaluate(() => [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".concierge-workspace input, .concierge-workspace textarea")].map((e) => e.value));
    await expect.poll(async () => (await values()).some((v) => v.includes(number)), { timeout: 30_000 }).toBe(true);
    expect((await values()).filter((v) => v === "392.00").length).toBeGreaterThan(0);
    // 资源：都取到了、没有被页面顶替；两份语言模型在
    expect(ocr.filter((r) => r.status !== 200)).toEqual([]);
    expect(ocr.filter((r) => r.type.startsWith("text/html"))).toEqual([]);
    for (const need of ["/concierge/ocr/worker.min.js", "/concierge/ocr/lang/chi_sim.traineddata.gz", "/concierge/ocr/lang/eng.traineddata.gz"]) expect(ocr.map((r) => r.url), need).toContain(need);
    // 原图已经存下：这张草稿在门店系统里（没确认，不动任何钱）
    const list = (await (await p.request.get(`/api/concierge/receipts?q=${number}`)).json()) as { receipts: { number: string; status: string }[] };
    expect(list.receipts.map((r) => r.number)).toContain(number);
    expect(list.receipts.every((r) => r.status !== "已确认")).toBe(true);
  } finally {
    await phone.close();
    await page.request.put(`/api/staff/${staff.id}`, { data: { displayName: "E2E 管家", role: "backoffice", duties: ["concierge"], active: false } });
  }
});


test("两位低余额会员均无人工核对记录时重点跟进不崩溃", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "门店电脑", "写入仅在电脑组");
  await login(page);
  const stamp=String(Date.now()).slice(-7);
  for (const [suffix,index] of [["甲",1],["乙",2]] as const) {
    const native=await page.request.post("/api/members",{data:{name:`低余额验收${suffix}${stamp}`,phone:`197${index}${stamp}`}});
    expect(native.status(),await native.text()).toBe(201);
    const saved=await page.request.post("/api/concierge/workspace",{data:{action:"createMember",requestId:randomUUID(),payload:{nativeMemberId:(await native.json()).id}}});
    expect(saved.status(),await saved.text()).toBe(200);
  }
  await page.goto("/concierge");
  await page.getByRole("button",{name:/低余额关注 \d+位/}).click();
  await expect(page.getByRole("heading",{name:"低余额关注名单",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:new RegExp(`低余额验收甲${stamp}`)})).toBeVisible();
  await expect(page.getByRole("button",{name:new RegExp(`低余额验收乙${stamp}`)})).toBeVisible();
});


test("会员情况仅保留四个未到访分类，无到访会员仍可从全名单查看且不自动建档", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "门店电脑", "写入仅在电脑组");
  await login(page);
  const stamp = String(Date.now()).slice(-8), name = "E2E从未到访-" + stamp;
  const made = await page.request.post("/api/members", { data: { name, phone: "196" + stamp } });
  expect(made.status(), await made.text()).toBe(201);
  const native = await made.json();
  await page.goto("/concierge");
  await page.getByRole("button", { name: "会员情况", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会员情况", exact: true })).toBeVisible();
  await expect(page.locator(".dormancy-card")).toHaveCount(4);
  await expect(page.getByRole("combobox", { name: "未到访时间筛选", exact: true }).locator('option[value="never"]')).toHaveCount(0);
  await moduleNav(page).getByRole("button", { name: "会员档案", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索系统会员", exact: true }).fill(name);
  await page.locator(".insights-list .member-cell").filter({ hasText: name }).click();
  const detail = page.getByRole("dialog", { name: "系统会员个人档案", exact: true });
  await expect(detail).toContainText(name);
  await expect(detail).toContainText("暂无到访记录");
  await expect(detail.getByRole("button", { name: "建立服务档案", exact: true })).toBeVisible();
  const lookup = await page.request.get("/api/concierge/native-members?q=" + encodeURIComponent(name));
  expect((await lookup.json()).members.find((m: any) => m.id === native.id).profiles).toEqual([]);
  await detail.getByRole("button", { name: "关闭系统会员详情", exact: true }).click();
  await moduleNav(page).getByRole("button", { name: "会员中心", exact: true }).click();
  await expect(page.locator(".member-grade-card")).toHaveCount(7);
  await expect(page.getByRole("combobox", { name: "会员档阶筛选", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "管家好评中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "管家好评中心", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "拍摄消费单", exact: true })).toHaveCount(0);
  await expect(page.getByText("上月好评榜", { exact: false }).first()).toBeVisible();
});

test("会员概览总人数、近期到访和沉睡人数均可下钻到实际名单", async ({ page }) => {
  await login(page);
  const recentData = await insights(page, "bucket=recent");
  // CI动态种子的前台入场记录是真实来源，充值或预约不冒充到访。
  const recent = recentData.members.find((member) => member.profiles.length === 0);
  expect(recent, "隔离CI动态演示库须有近期实际到访且未建管家档案的会员").toBeTruthy();
  await page.goto("/concierge");
  await moduleNav(page).getByRole("button", { name: "会员档案", exact: true }).click();
  for (const label of ["查看全部会员档阶", "查看近1个月到店会员", "查看新增会员趋势", "查看沉睡会员名单"])
    await expect(page.getByRole("button", { name: label, exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "查看全部会员档阶", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "会员中心", exact: true })).toBeVisible();
  await expect(page.locator(".member-grade-card")).toHaveCount(7);
  await moduleNav(page).getByRole("button", { name: "会员档案", exact: true }).click();

  await page.getByRole("button", { name: "查看近1个月到店会员", exact: true }).click();
  const recentDialog = page.getByRole("dialog", { name: "近1个月到店会员", exact: true });
  await expect(recentDialog).toBeVisible();
  await recentDialog.getByRole("button").filter({ hasText: recent!.memberNo }).first().click();
  const detail = page.getByRole("dialog", { name: "系统会员个人档案", exact: true });
  await expect(detail).toContainText(recent!.name);
  await expect(detail).toContainText(recent!.memberNo);
  await detail.getByRole("button", { name: "关闭系统会员详情", exact: true }).click();
  if (await recentDialog.isVisible()) await recentDialog.getByRole("button", { name: "关闭", exact: true }).click();

  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/concierge/member-insights" && url.searchParams.get("bucket") === "dormant";
  });
  await page.getByRole("button", { name: "查看沉睡会员名单", exact: true }).click();
  expect((await filtered).status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "会员情况", exact: true })).toBeVisible();
  const buckets = page.getByRole("combobox", { name: "未到访时间筛选", exact: true });
  await expect(buckets).toHaveValue("dormant");
  await expect(buckets.locator('option[value="never"]')).toHaveCount(0);
});

test("新增会员趋势按年展示12个月，并按原生创建月份下钻到新会员详情", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "门店电脑", "原生会员写入仅在电脑组");
  const stamp = String(Date.now()).slice(-8), name = "E2E趋势原生会员-" + stamp;
  await login(page);
  const made = await page.request.post("/api/members", { data: { name, phone: "195" + stamp } });
  expect(made.status(), await made.text()).toBe(201);
  const native = await made.json();
  const snapshot = await insights(page, "q=" + encodeURIComponent(name));
  const created = snapshot.members.find((member) => member.id === native.id)!;
  expect(created).toBeTruthy(); expect(created.profiles).toEqual([]);
  const createdMonth = calendarDate(created.createdAt, snapshot.timezone).slice(0, 7);
  const createdYear = Number(createdMonth.slice(0, 4)), monthNumber = Number(createdMonth.slice(5));
  const currentYear = Number(calendarDate(snapshot.serverTime, snapshot.timezone).slice(0, 4));
  const monthly = await insights(page, `q=${encodeURIComponent(name)}&createdMonth=${createdMonth}&trendYear=${createdYear}`);
  expect(monthly.members.map((member) => member.id)).toContain(native.id);
  expect(monthly.growth.months.find((month) => month.month === createdMonth)!.count).toBeGreaterThan(0);

  await page.goto("/concierge");
  await moduleNav(page).getByRole("button", { name: "会员档案", exact: true }).click();
  await page.getByRole("button", { name: "查看新增会员趋势", exact: true }).click();
  const trend = page.getByRole("dialog", { name: "新增会员趋势", exact: true });
  await expect(trend).toBeVisible();
  const monthsIn = (year: number) => trend.getByRole("button", { name: new RegExp(`^${year}年\\d+月，新增\\d+人$`) });
  await expect(monthsIn(currentYear)).toHaveCount(12);
  await trend.getByRole("button", { name: "上一年", exact: true }).click();
  await expect(monthsIn(currentYear - 1)).toHaveCount(12);
  await trend.getByRole("button", { name: "下一年", exact: true }).click();
  await expect(monthsIn(currentYear)).toHaveCount(12);
  let shownYear = currentYear;
  const chooseMonth = async (year: number, month: number) => {
    while (shownYear > year) { await trend.getByRole("button", { name: "上一年", exact: true }).click(); shownYear--; }
    while (shownYear < year) { await trend.getByRole("button", { name: "下一年", exact: true }).click(); shownYear++; }
    await trend.getByRole("button", { name: new RegExp(`^${year}年${month}月，新增\\d+人$`) }).click();
  };
  const memberList = trend.locator('[aria-label="新增会员名单"]');
  // 不造历史数据；同一个新会员在上个月名单必须不存在，切回其原生创建月才出现。
  const otherYear = monthNumber === 1 ? createdYear - 1 : createdYear, otherMonth = monthNumber === 1 ? 12 : monthNumber - 1;
  await chooseMonth(otherYear, otherMonth);
  await expect(memberList.getByRole("heading", { name: `${otherYear}年${otherMonth}月新增会员`, exact: true })).toBeVisible();
  await expect(memberList).not.toContainText(name);
  await chooseMonth(createdYear, monthNumber);
  await expect(memberList).toContainText(name);
  await memberList.getByRole("button").filter({ hasText: name }).first().click();
  const detail = page.getByRole("dialog", { name: "系统会员个人档案", exact: true });
  await expect(detail).toContainText(name);
  await expect(detail).toContainText(created.memberNo);
  const lookup = await page.request.get("/api/concierge/native-members?q=" + encodeURIComponent(name));
  expect((await lookup.json()).members.find((member: any) => member.id === native.id).profiles).toEqual([]);
});

test("本月好评数字打开当月有效名单，记录可进入原图并返回原名单", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "门店电脑", "合成好评与员工写入仅在电脑组");
  await login(page);
  const stamp = String(Date.now()).slice(-8), staffName = "E2E下钻管家-" + stamp;
  const made = await page.request.post("/api/staff", { data: { username: "e2epraise" + stamp, displayName: staffName, role: "backoffice", duties: ["concierge"], password: "E2e-praise-2026" } });
  expect(made.status(), await made.text()).toBe(201);
  const staff = await made.json(), recorded: string[] = [];
  const mutate = (action: string, payload: Record<string, unknown>) => page.request.post("/api/concierge/workspace", { data: { action, payload, requestId: randomUUID() } });
  try {
    const centerResponse = await page.request.get("/api/concierge/praise/center");
    expect(centerResponse.status(), await centerResponse.text()).toBe(200);
    const center: PraiseCenterData = await centerResponse.json();
    // 合成色块图片，仅验证私有原图链路；记录标明CI样例，不作为真实客人好评。
    const photo = await page.request.post("/api/concierge/uploads", { data: { files: [{ mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGO8sS2YgRTARJJqhlENxAEmItXBwagGYgDJoQQA8i4CAS68pTIAAAAASUVORK5CYII=" }] } });
    expect(photo.status(), await photo.text()).toBe(201);
    const uploadId = (await photo.json()).uploads[0].id;
    const payload = (content: string, occurredOn = center.today) => ({ staffId: String(staff.id), occurredOn, source: "隔离CI合成凭证", guestName: "合成客人" + stamp, content, uploadIds: [uploadId] });
    const activeContent = "本月有效好评-" + stamp, voidContent = "本月已撤销好评-" + stamp, previousContent = "上月好评不进本月-" + stamp;
    for (const content of [activeContent, voidContent]) {
      const result = await mutate("savePraise", payload(content));
      expect(result.status(), await result.text()).toBe(200); recorded.push((await result.json()).id);
    }
    const voided = await mutate("voidPraise", { id: recorded[1], version: 1, reason: "隔离CI撤销样例" });
    expect(voided.status(), await voided.text()).toBe(200);
    const lastMonth = new Date(`${center.month}-01T00:00:00Z`); lastMonth.setUTCDate(0);
    const old = await mutate("savePraise", payload(previousContent, lastMonth.toISOString().slice(0, 10)));
    expect(old.status(), await old.text()).toBe(200); recorded.push((await old.json()).id);

    await page.goto("/concierge");
    await moduleNav(page).getByRole("button", { name: "管家好评中心", exact: true }).click();
    const monthButton = page.getByRole("button", { name: "查看本月好评明细", exact: true });
    await expect(monthButton).toBeEnabled(); await monthButton.click();
    const monthDialog = page.getByRole("dialog", { name: "本月好评明细", exact: true });
    await expect(monthDialog).toBeVisible();
    await expect(monthDialog.locator('[aria-label="本月有效好评统计"]')).toContainText(`${Number(center.month.slice(0, 4))}年${Number(center.month.slice(5))}月`);
    await expect(monthDialog).toContainText(activeContent);
    await expect(monthDialog).not.toContainText(voidContent);
    await expect(monthDialog).not.toContainText(previousContent);
    await monthDialog.getByRole("button").filter({ hasText: activeContent }).click();
    const detail = page.getByRole("dialog", { name: "好评详情与原始凭证", exact: true });
    await expect(detail).toContainText(activeContent);
    const image = detail.getByRole("img", { name: "客人原始好评凭证第1页", exact: true });
    await expect(image).toHaveAttribute("src", `/api/concierge/uploads/${uploadId}`);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    const popup = page.waitForEvent("popup");
    await detail.getByRole("link", { name: "打开原图", exact: true }).click();
    const original = await popup;
    try { await expect(original).toHaveURL(new RegExp(`/api/concierge/uploads/${uploadId}$`)); await expect(original.getByRole("img")).toBeVisible(); }
    finally { await original.close(); }
    await detail.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(monthDialog).toBeVisible(); await expect(monthDialog).toContainText(activeContent);
  } finally {
    // 留可追溯撤销记录，避免后续用例将合成好评当作有效荣誉；不物理删除。
    for (const id of recorded) {
      const response = await page.request.get(`/api/concierge/praise/${id}`);
      expect(response.status(), await response.text()).toBe(200);
      const record = await response.json();
      if (record.status === "active") {
        const result = await mutate("voidPraise", { id, version: record.version, reason: "隔离CI下钻用例完成" });
        expect(result.status(), await result.text()).toBe(200);
      }
    }
    const stopped = await page.request.put(`/api/staff/${staff.id}`, { data: { displayName: staffName, role: "backoffice", duties: ["concierge"], active: false } });
    expect(stopped.status(), await stopped.text()).toBe(200);
  }
});

// 8.0.18 整合：哪一页写进地址（与后台的二级页签同一个规矩）
test("管家部的页写进地址：刷新留在原页、浏览器后退回上一页、直接打开某一页的地址", async ({ page }) => {
  await login(page);
  await page.goto("/concierge");
  await expect(page.getByRole("heading", { name: /今日工作台/ })).toBeVisible();
  await moduleNav(page).getByRole("button", { name: "会员中心", exact: true }).click();
  await expect(page).toHaveURL(/\/concierge\/tiers$/);
  await expect(page.getByRole("heading", { name: "会员中心", exact: true })).toBeVisible();
  await moduleNav(page).getByRole("button", { name: "管家好评中心", exact: true }).click();
  await expect(page).toHaveURL(/\/concierge\/praise$/);
  // 刷新不回工作台
  await page.reload();
  await expect(page.getByRole("heading", { name: "管家好评中心", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/concierge\/praise$/);
  // 后退回到会员中心
  await page.goBack();
  await expect(page).toHaveURL(/\/concierge\/tiers$/);
  await expect(page.getByRole("heading", { name: "会员中心", exact: true })).toBeVisible();
  // 直接打开地址；认不得的页回工作台
  await page.goto("/concierge/situation");
  await expect(page.getByRole("heading", { name: "会员情况", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.goto("/concierge/no-such-page");
  await expect(page.getByRole("heading", { name: /今日工作台/ })).toBeVisible({ timeout: 20_000 });
  // 门店主导航里「管家部」在各页都亮着
  await page.goto("/concierge/members");
  await expect(page.getByRole("heading", { name: "会员档案", exact: true })).toBeVisible({ timeout: 20_000 });
});
