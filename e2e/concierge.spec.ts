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
  await page.goto("/admin/concierge");
  await expect(
    page.getByRole("heading", { name: "今日工作台", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "管家业务模块" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "退出企业账号", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 2,
    ),
  ).toBe(true);
});
test("管家仅卡号建档与人工余额留痕，不要求建立企业钱包", async ({
  page,
  viewport,
}) => {
  test.skip(
    (viewport?.width ?? 0) < 1280,
    "变更流程在电脑尺寸执行；其余视口仅执行布局冒烟",
  );
  await login(page);
  await page.goto("/admin/concierge");
  await page
    .getByRole("button", { name: "新增会员", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog", { name: "新建会员档案" });
  const name = "E2E管家会员-" + randomUUID().slice(0, 8);
  await dialog
    .getByRole("textbox", { name: "客户称呼 *", exact: true })
    .fill(name);
  await dialog
    .getByRole("textbox", { name: "收银会员卡号", exact: true })
    .fill("CI-CONCIERGE-" + randomUUID());
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  const member = page.getByRole("complementary", { name: name + "的会员档案" });
  await expect(member).toContainText(/会员档案 · \d{6}/);
  await member.getByRole("button", { name: "核对余额", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "核对会员余额" });
  await dialog
    .getByRole("textbox", { name: /收银核实后总余额/ })
    .fill("29999.99");
  await dialog
    .getByRole("textbox", { name: /核对依据/ })
    .fill("CI合成数据人工核对，不写收银钱包");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(member).toContainText("29,999.99");
});
