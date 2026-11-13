// Synthetic concierge enrollment only; uses the existing isolated CI demo environment.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#username", "linlan");
  await page.fill("#password", "yuzu2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible({
    timeout: 30000,
  });
}
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


test("会员情况按真实到访分类，未纳入者可查看但不会自动建服务档案", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "门店电脑", "写入仅在电脑组");
  await login(page);
  const stamp = String(Date.now()).slice(-8), name = "E2E从未到访-" + stamp;
  const made = await page.request.post("/api/members", { data: { name, phone: "196" + stamp } });
  expect(made.status(), await made.text()).toBe(201);
  const native = await made.json();
  await page.goto("/concierge");
  await page.getByRole("button", { name: "会员情况", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会员情况", exact: true })).toBeVisible();
  await expect(page.locator(".dormancy-card")).toHaveCount(5);
  await page.locator(".dormancy-card").filter({ hasText: "从未到访" }).click();
  await page.getByRole("textbox", { name: "搜索系统会员", exact: true }).fill(name);
  await page.locator(".insights-list .member-cell").filter({ hasText: name }).click();
  const detail = page.getByRole("dialog", { name: "系统会员个人档案", exact: true });
  await expect(detail).toContainText(name);
  await expect(detail).toContainText("从未到访");
  await expect(detail.getByRole("button", { name: "建立服务档案", exact: true })).toBeVisible();
  const lookup = await page.request.get("/api/concierge/native-members?q=" + encodeURIComponent(name));
  expect((await lookup.json()).members.find((m: any) => m.id === native.id).profiles).toEqual([]);
  await detail.getByRole("button", { name: "关闭系统会员详情", exact: true }).click();
  await page.getByRole("button", { name: "客户分层", exact: true }).click();
  await expect(page.locator(".member-grade-card")).toHaveCount(7);
  await expect(page.getByRole("combobox", { name: "会员档阶筛选", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "管家好评中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "管家好评中心", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "拍摄消费单", exact: true })).toHaveCount(0);
  await expect(page.getByText("上月好评榜", { exact: false }).first()).toBeVisible();
});
