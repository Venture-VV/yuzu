// Customer department UI uses native read models. These cases perform no financial writes.
import { expect, test, type Page } from "@playwright/test";
import type { CustomerOverview, CustomerBindingQueue, CustomerLowBalancePage, CustomerTargets, CustomerVisitPage } from "../src/shared/customer";
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
  await expect(page.getByRole("radio", { name: "整单消费与独立扣卡", exact: true })).toHaveAttribute("aria-checked", "true");
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
  await expect(page.getByRole("radio", { name: "充值原单与归属", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: new RegExp(`${String(hour).padStart(2, "0")}:00时段`) })).toBeVisible();
});
test("经理可发现维护绑定审核队列并打开原始会员", async ({ page }) => {
  await login(page);
  await openCustomer(page);
  await page.getByTestId("customer-tab-members").click();
  const response = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/customer/bindings");
  await page.getByRole("radio", { name: "绑定审核", exact: true }).click();
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
  await page.getByRole("radio", { name: "绑定审核", exact: true }).click();
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
    await page.waitForTimeout(3400);
    await expect(form.getByLabel("月目标（元）*", { exact: true })).toHaveValue("350000");
    await expect(form.getByLabel("本月组别", { exact: true })).toHaveValue("A组");
    await expect(form.getByLabel("原因 / 依据 *", { exact: true })).toHaveValue("只读验收草稿，不提交");
    page.once("dialog", (dialog) => dialog.accept());
    await form.getByRole("button", { name: "关闭", exact: true }).last().click();
  }
});
