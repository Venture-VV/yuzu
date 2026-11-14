// Customer department UI uses native read models. These cases perform no financial writes.
import { expect, test, type Page } from "@playwright/test";
import type { CustomerOverview, CustomerBindingQueue, CustomerLowBalancePage, CustomerMemberDetail, CustomerTargets, CustomerVisitDetail, CustomerVisitPage } from "../src/shared/customer";
import type { SessionInfo } from "../src/shared/types";
async function login(page: Page) {
  await page.goto("/login");
  await page.locator("#username").fill("linlan");
  await page.locator("#password").fill("yuzu2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "主导航", exact: true })).toBeVisible({ timeout: 30_000 });
}
async function openCustomer(page: Page) {
  await page.goto("/customer");
  await expect(page.getByTestId("customer-workbench")).toBeVisible();
  await expect(page.getByRole("button", { name: "查看今日已结消费详情", exact: true })).toBeVisible();
}
test("客户部总览数字与小时键盘下钻沿用真实查询条件", async ({ page }) => {
  await login(page);
  await openCustomer(page);
  const response = await page.request.get("/api/customer/overview");
  expect(response.status(), await response.text()).toBe(200);
  const overview: CustomerOverview = await response.json();
  await page.getByRole("button", { name: "查看今日已结消费详情", exact: true }).click();
  await expect(page.getByRole("link", { name: "整单消费与独立扣卡", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("消费原单 · 结账与独立扣卡", { exact: true })).toBeVisible();
  await page.getByTestId("customer-tab-overview").click();
  const firstHour = page.getByRole("group", { name: "每小时时段明细", exact: true }).getByRole("button").first();
  const hour = overview.hourly[0]!.hour;
  const requested = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.pathname === "/api/customer/recharges" && url.searchParams.get("hour") === String(hour);
  });
  await firstHour.focus();
  await firstHour.press("Enter");
  expect((await requested).status()).toBe(200);
  await expect(page.getByRole("link", { name: "充值原单与归属", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: new RegExp(`${String(hour).padStart(2, "0")}:00时段`) })).toBeVisible();
});
test("入场小时下钻按入场营业日查询并可刷新和恢复普通跨日跟进", async ({ page }) => {
  await login(page);
  await openCustomer(page);
  const response = await page.request.get("/api/customer/overview");
  expect(response.status(), await response.text()).toBe(200);
  const overview: CustomerOverview = await response.json();
  const index = Math.max(0, overview.hourly.findIndex((item) => item.visitCount > 0));
  const bucket = overview.hourly[index]!;
  await page.getByRole("radio", { name: "入场人数", exact: true }).click();
  const isArrivalResponse = (res: import("@playwright/test").Response) => {
    const url = new URL(res.url());
    return url.pathname === "/api/customer/visits" && url.searchParams.get("visitScope") === "arrivals" && url.searchParams.get("day") === overview.day && url.searchParams.get("hour") === String(bucket.hour);
  };
  const requested = page.waitForResponse(isArrivalResponse);
  await page.getByRole("group", { name: "每小时时段明细", exact: true }).getByRole("button").nth(index).press("Enter");
  const arrivalResponse = await requested;
  expect(arrivalResponse.status(), await arrivalResponse.text()).toBe(200);
  const arrivals: CustomerVisitPage = await arrivalResponse.json();
  expect(arrivals.filteredTotal).toBe(bucket.visitCount);
  expect(arrivals.rows.every((row) => row.businessDate === overview.day && row.status !== "cancelled")).toBe(true);
  const bookmark = page.url();
  await expect(page.getByRole("button", { name: `入场营业日：${overview.day} · 恢复普通跟进 ×`, exact: true })).toBeVisible();
  await expect(page.getByText("全店实时总量，含跨日在店；与下方入场明细范围不同", { exact: true })).toBeVisible();
  const reloaded = page.waitForResponse(isArrivalResponse);
  await page.reload();
  expect((await reloaded).status()).toBe(200);
  await expect(page).toHaveURL(bookmark);
  await expect(page.getByRole("button", { name: new RegExp(`${String(bucket.hour).padStart(2, "0")}:00时段`) })).toBeVisible();
  const isWorkbenchRequest = (request: import("@playwright/test").Request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/customer/visits" && !url.searchParams.has("visitScope") && !url.searchParams.has("hour");
  };
  const normal = page.waitForRequest(isWorkbenchRequest);
  await page.getByRole("button", { name: `入场营业日：${overview.day} · 恢复普通跟进 ×`, exact: true }).click();
  await normal;
  expect(new URL(page.url()).searchParams.has("visitScope")).toBe(false);
  await expect(page.getByText("与前台一致，包含跨日未离店手牌", { exact: true })).toBeVisible();
  await page.goto(bookmark);
  await expect(page.getByRole("button", { name: /入场营业日：.*恢复普通跟进/ })).toBeVisible();
  const mainEntry = page.waitForRequest(isWorkbenchRequest);
  await page.getByTestId("customer-tab-visits").click();
  await mainEntry;
  await expect(page.getByRole("button", { name: /入场营业日：.*恢复普通跟进/ })).toHaveCount(0);
  await page.goto(bookmark);
  await page.getByTestId("customer-tab-overview").click();
  const currentGuests = page.waitForRequest(isWorkbenchRequest);
  await page.getByRole("button", { name: "查看当前在店手牌详情", exact: true }).click();
  await currentGuests;
  await expect(page.getByRole("button", { name: /入场营业日：.*恢复普通跟进/ })).toHaveCount(0);
});
test("经理可发现维护绑定审核队列并打开原始会员", async ({ page }) => {
  await login(page);
  await openCustomer(page);
  await page.getByTestId("customer-tab-members").click();
  const response = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/customer/bindings");
  await page.getByRole("link", { name: "绑定审核", exact: true }).click();
  const queueResponse = await response;
  expect(queueResponse.status(), await queueResponse.text()).toBe(200);
  const queue: CustomerBindingQueue = await queueResponse.json();
  await expect(page.getByText("会员维护绑定审核", { exact: true })).toBeVisible();
  if (queue.rows.length) {
    const row = queue.rows[0]!;
    await page.getByRole("button", { name: `${row.member.name} · ${row.member.memberNo}`, exact: true }).first().click();
    await expect(page.getByRole("dialog", { name: "会员档案与维护时间轴", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText(row.member.memberNo);
  } else await expect(page.getByText("当前状态下暂无绑定申请。", { exact: true })).toBeVisible();
});
test("当日经营子页地址在刷新、收藏直达和后退时保留消费流程", async ({ page }) => {
  await login(page);
  await page.goto("/customer?tab=daily");
  const dailyTabs = page.getByRole("navigation", { name: "当日经营明细类别", exact: true });
  await expect(dailyTabs.getByRole("link", { name: "充值原单与归属", exact: true })).toHaveAttribute("aria-current", "page");
  await dailyTabs.getByRole("link", { name: "整单消费与独立扣卡", exact: true }).click();
  await expect(page).toHaveURL(/tab=daily.*daily=settlement/);
  const bookmark = page.url();
  await expect(page.getByText("消费原单 · 结账与独立扣卡", { exact: true })).toBeVisible();
  await page.reload();
  await expect(dailyTabs.getByRole("link", { name: "整单消费与独立扣卡", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("消费原单 · 结账与独立扣卡", { exact: true })).toBeVisible();
  await dailyTabs.getByRole("link", { name: "充值原单与归属", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "搜索充值原单", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(bookmark);
  await expect(page.getByText("消费原单 · 结账与独立扣卡", { exact: true })).toBeVisible();
  await page.getByTestId("customer-tab-overview").click();
  await page.goto(bookmark);
  await expect(dailyTabs.getByRole("link", { name: "整单消费与独立扣卡", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("消费原单 · 结账与独立扣卡", { exact: true })).toBeVisible();
});
test("会员绑定子页地址在刷新、收藏直达和后退时保留审核队列", async ({ page }) => {
  await login(page);
  await page.goto("/customer?tab=members");
  const memberTabs = page.getByRole("navigation", { name: "会员绑定工作区", exact: true });
  await expect(memberTabs.getByRole("link", { name: "会员名单", exact: true })).toHaveAttribute("aria-current", "page");
  await memberTabs.getByRole("link", { name: "绑定审核", exact: true }).click();
  await expect(page).toHaveURL(/tab=members.*member=bindings/);
  const bookmark = page.url();
  await expect(page.getByText("会员维护绑定审核", { exact: true })).toBeVisible();
  await page.reload();
  await expect(memberTabs.getByRole("link", { name: "绑定审核", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("会员维护绑定审核", { exact: true })).toBeVisible();
  await memberTabs.getByRole("link", { name: "会员名单", exact: true }).click();
  await expect(page.getByText("会员档案与维护关系", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(bookmark);
  await expect(page.getByText("会员维护绑定审核", { exact: true })).toBeVisible();
  await page.getByTestId("customer-tab-overview").click();
  await page.goto(bookmark);
  await expect(memberTabs.getByRole("link", { name: "绑定审核", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("会员维护绑定审核", { exact: true })).toBeVisible();
});
test("个人权限深链不挂载绑定审核且地址参数不能放宽充值范围", async ({ page }) => {
  await login(page);
  // Exercise the UI with the same capabilities returned to an account manager. API authorization
  // and seller filtering are covered against real account-manager sessions in customer-reads.test.ts.
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const session: SessionInfo = await response.json();
    session.permissions = session.permissions.filter((permission) => permission !== "customer.manage");
    await route.fulfill({ response, json: session });
  });
  await page.route("**/api/customer/overview*", async (route) => {
    const response = await route.fetch();
    const overview: CustomerOverview = await response.json();
    overview.capabilities = { ...overview.capabilities, manage: false, scope: "self" };
    await route.fulfill({ response, json: overview });
  });
  let bindingRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/customer/bindings") bindingRequests += 1; });
  await page.goto("/customer?tab=members&member=bindings");
  await expect(page.getByText("会员档案与维护关系", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "绑定审核", exact: true })).toHaveCount(0);
  await expect(page.getByText("会员维护绑定审核", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("会员档案与维护关系", { exact: true })).toBeVisible();
  expect(bindingRequests).toBe(0);
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/customer/recharges");
  await page.goto("/customer?tab=daily&daily=recharge&managerId=999999&scope=all");
  const query = new URL((await requested).url()).searchParams;
  expect(query.has("managerId")).toBe(false);
  expect(query.has("scope")).toBe(false);
  await expect(page.getByRole("textbox", { name: "搜索充值原单", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "客户经理筛选", exact: true })).toHaveCount(0);
});
test("原生资金及历史项权限收回时保留客户服务并明确说明受限范围", async ({ page }) => {
  await login(page);
  // These capability stubs exercise UI gates only; real revoked-role access and SQL
  // non-disclosure are verified in customer-financial-permissions.test.ts.
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const session: SessionInfo = await response.json();
    session.permissions = session.permissions.filter((permission) => !["customer.manage", "member.read", "ledger.readToday", "ledger.readHistory", "frontdesk.read"].includes(permission));
    await route.fulfill({ response, json: session });
  });
  await page.route("**/api/customer/overview*", async (route) => {
    const response = await route.fetch();
    const overview: CustomerOverview = await response.json();
    overview.capabilities = { ...overview.capabilities, manage: false, scope: "self", financialReadToday: false, financialReadHistory: false, financialScope: "self", memberFinancialTimeline: false };
    await route.fulfill({ response, json: overview });
  });
  let financialRequests = 0;
  await page.route("**/api/customer/settlements**", async (route) => {
    financialRequests += 1;
    await route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN", message: "UI门控未生效" } } });
  });
  await page.route("**/api/customer/members/*", async (route) => {
    const response = await route.fetch();
    const member: CustomerMemberDetail = await response.json();
    member.capabilities = { ...member.capabilities, financialReadToday: false, financialReadHistory: false, financialScope: "self", memberFinancialTimeline: false };
    member.timeline = []; member.timelineHasMore = false;
    await route.fulfill({ response, json: member });
  });
  await page.route("**/api/customer/visits/*", async (route) => {
    const response = await route.fetch();
    const visit: CustomerVisitDetail = await response.json();
    visit.visit.status = "settled"; visit.linesReadable = false; visit.lines = [];
    await route.fulfill({ response, json: visit });
  });
  await page.goto("/customer?tab=daily&daily=settlement");
  await expect(page.getByText("消费原单按账号权限查看", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "搜索结账单 / 扣卡单 / 会员", exact: true })).toHaveCount(0);
  await page.getByTestId("customer-tab-overview").click();
  await page.getByRole("button", { name: "查看今日已结消费详情", exact: true }).click();
  await expect(page.getByText("消费原单按账号权限查看", { exact: true })).toBeVisible();
  expect(financialRequests).toBe(0);
  await page.getByTestId("customer-tab-members").click();
  await page.getByRole("button", { name: "查看档案", exact: true }).first().click();
  const member = page.getByRole("dialog", { name: "会员档案与维护时间轴", exact: true });
  await expect(member.getByText("这个账号看不了会员的资金记录", { exact: true })).toBeVisible();
  await expect(member.getByText("系统实时可用余额", { exact: true })).toBeVisible();
  await expect(member.getByText("会员维护事实", { exact: true })).toBeVisible();
  await expect(member.getByRole("combobox", { name: "会员资金类别", exact: true })).toHaveCount(0);
  await expect(member.getByText("当前条件下暂无资金记录。", { exact: true })).toHaveCount(0);
  await member.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.getByTestId("customer-tab-visits").click();
  await page.getByRole("button", { name: "明细 / 跟进", exact: true }).first().click();
  const visit = page.getByRole("dialog", { name: "手牌消费与服务跟进", exact: true });
  await expect(visit.getByText("历史消费项目按账号权限查看", { exact: true })).toBeVisible();
  await expect(visit.getByText("接待与服务跟进", { exact: true })).toBeVisible();
  await expect(visit.getByText("消费项目（来自前台，只读）", { exact: true })).toHaveCount(0);
  expect(financialRequests).toBe(0);
});
test("会员资金时间轴原单入口同时遵守金融权限与服务端可读编号", async ({ page }) => {
  await login(page);
  let financialAllowed = false;
  await page.route("**/api/customer/members/*", async (route) => {
    const response = await route.fetch();
    const member: CustomerMemberDetail = await response.json();
    member.capabilities = { ...member.capabilities, memberFinancialTimeline: true, financialReadToday: financialAllowed, financialReadHistory: false, financialScope: "self" };
    // Deliberately retain an ID while the capability is false to verify the UI's
    // own gate; once allowed, also cover a checkout link without a consumption ID.
    member.timeline = [{ id: -1, type: "consume", docNo: "UI-PERMISSION-CHECK", occurredAt: member.serverTime, businessDate: member.businessDate, principalDeltaCents: -100, bonusDeltaCents: 0, operatorName: "UI合成经办", rechargeId: null, consumptionId: null, checkoutId: 1 }];
    member.timelineHasMore = false;
    await route.fulfill({ response, json: member });
  });
  await page.goto("/customer?tab=members");
  await page.getByRole("button", { name: "查看档案", exact: true }).first().click();
  const member = page.getByRole("dialog", { name: "会员档案与维护时间轴", exact: true });
  await expect(member.getByText(/UI-PERMISSION-CHECK/)).toBeVisible();
  await expect(member.getByRole("button", { name: "查看实际消费原单", exact: true })).toHaveCount(0);
  await member.getByRole("button", { name: "关闭详情", exact: true }).click();
  financialAllowed = true;
  await page.getByRole("button", { name: "查看档案", exact: true }).first().click();
  await expect(member.getByRole("button", { name: "查看实际消费原单", exact: true })).toBeVisible();
});
test("无客户部权限时客户端隐藏入口且不读取客户部数据", async ({ page }) => {
  await login(page);
  let customerRequests = 0;
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const session: SessionInfo = await response.json();
    session.permissions = session.permissions.filter((permission) => !permission.startsWith("customer."));
    await route.fulfill({ response, json: session });
  });
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/customer/")) customerRequests += 1; });
  await page.goto("/customer");
  await expect(page).not.toHaveURL(/\/customer/);
  await expect(page.getByTestId("customer-workbench")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "客户部", exact: true })).toHaveCount(0);
  expect(customerRequests).toBe(0);
});
test("390px客户部六模块与横向表格局部滚动不会撑宽页面", async ({ page }, info) => {
  test.skip(info.project.name !== "门店电脑", "固定390px只跑一次");
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await openCustomer(page);
  for (const tab of ["overview", "visits", "daily", "targets", "lowBalances", "members"]) {
    await page.getByTestId(`customer-tab-${tab}`).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  }
  await page.getByRole("link", { name: "绑定审核", exact: true }).click();
  await expect(page.getByText("会员维护绑定审核", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
});

test("手牌金额和在离店筛选读取原生手牌，会员显示会员号与实时档阶", async ({ page }) => {
  await login(page);
  await openCustomer(page);
  const initial = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/customer/visits");
  await page.getByTestId("customer-tab-visits").click();
  const native: CustomerVisitPage = await (await initial).json();
  await expect(page.getByText("所列手牌消费", { exact: true })).toHaveCount(0);
  await expect(page.getByText("与前台一致，包含跨日未离店手牌", { exact: true })).toBeVisible();
  const memberVisit = native.rows.find((row) => row.member);
  if (memberVisit?.member) {
    const row = page.locator(".customer-visit-table tbody tr").filter({ hasText: memberVisit.visitNo });
    await expect(row).toContainText(memberVisit.member.memberNo);
    await expect(row).toContainText(memberVisit.member.gradeLabel);
  }
  const amountResponse = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.pathname === "/api/customer/visits" && url.searchParams.get("amountBand") === "lt1k";
  });
  await page.getByRole("combobox", { name: "手牌消费区间", exact: true }).selectOption("lt1k");
  const filtered: CustomerVisitPage = await (await amountResponse).json();
  expect(filtered.rows.every((row) => row.amountCents < 100000)).toBe(true);
  expect(filtered.totals.inStoreCount).toBe(native.totals.inStoreCount);
  const leftResponse = page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.pathname === "/api/customer/visits" && url.searchParams.get("status") === "left";
  });
  await page.getByRole("combobox", { name: "客户部记录状态", exact: true }).selectOption("left");
  const left: CustomerVisitPage = await (await leftResponse).json();
  expect(left.rows.every((row) => row.status !== "open")).toBe(true);
});

test("低余额关注严格使用本金加可用赠金并可打开个人档案", async ({ page }) => {
  await login(page);
  await openCustomer(page);
  const response = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/customer/low-balances");
  await page.getByTestId("customer-tab-lowBalances").click();
  const low: CustomerLowBalancePage = await (await response).json();
  expect(low.thresholdCents).toBe(3000000);
  expect(low.rows.every((member) => member.principalCents + member.bonusCents === member.totalCents && member.totalCents < low.thresholdCents)).toBe(true);
  await expect(page.getByText("低余额关注名单", { exact: true })).toBeVisible();
  if (low.rows.length) {
    await page.locator(".customer-member-table tbody tr").first().getByRole("button", { name: "查看档案", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "会员档案与维护时间轴", exact: true });
    await expect(dialog).toContainText(low.rows[0]!.memberNo);
    await expect(dialog.getByRole("button", { name: /办理充值/ })).toHaveCount(0);
  }
});

test("部门目标卡和员工金额打开原单明细，三秒同步保留目标草稿", async ({ page }) => {
  await login(page);
  await openCustomer(page);
  await expect(page.getByRole("button", { name: "办理充值", exact: true })).toHaveCount(0);
  const response = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/customer/targets");
  await page.getByTestId("customer-tab-targets").click();
  const targets: CustomerTargets = await (await response).json();
  const card = page.getByRole("button", { name: "查看本月已核 / 部门目标详情", exact: true });
  await expect(card).toBeVisible();
  await card.click();
  const performance = page.getByRole("dialog", { name: "本月部门已核业绩", exact: true });
  await expect(performance).toBeVisible();
  if (targets.capabilities.manage) await expect(performance.getByText("业绩原单与退款冲减", { exact: true })).toBeVisible();
  else await expect(performance.getByText("原单明细按账号权限查看", { exact: true })).toBeVisible();
  await performance.getByRole("button", { name: "关闭业绩详情", exact: true }).click();
  if (targets.rows.length) {
    await page.locator(".customer-ranking-table tbody tr").first().getByRole("button", { name: targets.rows[0]!.manager.name, exact: true }).click();
    await expect(page.getByRole("dialog", { name: `${targets.rows[0]!.manager.name}本月已核业绩`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭业绩详情", exact: true }).click();
  }
  if (targets.capabilities.manage && targets.rows.length) {
    await page.getByRole("button", { name: "目标 / 分组", exact: true }).first().click();
    const form = page.getByRole("dialog", { name: "维护月度经营目标", exact: true });
    await form.getByLabel("月目标（元）*", { exact: true }).fill("350000");
    await form.getByLabel("本月组别", { exact: true }).selectOption("A组");
    await form.getByLabel("原因 / 依据 *", { exact: true }).fill("只读验收草稿，不提交");
    await page.goBack();
    await expect(page.getByTestId("customer-tab-overview")).toHaveAttribute("aria-current", "page");
    await expect(form.getByLabel("原因 / 依据 *", { exact: true })).toHaveValue("只读验收草稿，不提交");
    await page.goForward();
    await expect(page.getByTestId("customer-tab-targets")).toHaveAttribute("aria-current", "page");
    await page.waitForTimeout(3400);
    await expect(form.getByLabel("月目标（元）*", { exact: true })).toHaveValue("350000");
    await expect(form.getByLabel("本月组别", { exact: true })).toHaveValue("A组");
    await expect(form.getByLabel("原因 / 依据 *", { exact: true })).toHaveValue("只读验收草稿，不提交");
    page.once("dialog", (dialog) => dialog.accept());
    await form.getByRole("button", { name: "关闭", exact: true }).last().click();
  }
});

test("店主申请维护绑定时下拉里选得到本人，其余是在岗的客户经理", async ({ page }) => {
  // Codex 2026-11-14（d0040b7）：名单只列客户经理和已经有目标、有成交的人，店主、店总第一次把会员记在自己名下时选不到自己。
  // 只打开表单核对选项，不提交。
  await login(page);
  await openCustomer(page);
  const session: SessionInfo = await (await page.request.get("/api/auth/me")).json();
  const members = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/customer/members");
  await page.getByTestId("customer-tab-members").click();
  await members;
  const rows = page.getByRole("button", { name: "查看档案", exact: true });
  test.skip((await rows.count()) === 0, "演示库里没有会员");
  await rows.first().click();
  const profile = page.getByRole("dialog", { name: "会员档案与维护时间轴", exact: true });
  const apply = profile.getByRole("button", { name: "申请绑定 / 换绑", exact: true });
  await expect(profile.getByText("会员维护事实", { exact: true })).toBeVisible();
  test.skip((await apply.count()) === 0, "第一位会员已停用，不能申请绑定");
  await apply.click();
  const form = page.getByRole("dialog", { name: "申请维护绑定 / 换绑", exact: true });
  const select = form.getByLabel("拟绑定维护人 *");
  await expect(select).toBeEnabled();
  const options = await select.locator("option").evaluateAll((nodes) => nodes.map((node) => ({ value: (node as HTMLOptionElement).value, text: node.textContent ?? "" })));
  const self = options.filter((option) => option.value === String(session.staff.id));
  expect(self, JSON.stringify(options)).toHaveLength(1);
  expect(self[0]!.text).toContain(session.staff.displayName);
  await select.selectOption(String(session.staff.id));
  await expect(select).toHaveValue(String(session.staff.id));
  await form.getByRole("button", { name: "关闭", exact: true }).first().click();
});
