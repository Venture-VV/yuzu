// 8.0.17 浏览器验收：ERP 采购流程图（docs/FLOW_V8017.md）。
//   · 用接口造出店主那张图上的两种情形：流程 A——需求通过、采购单已下、过了到货期还没到（到货验收标超期）；
//     流程 B——需求通过、发起了询价、只收到 1 家报价（停在询价比价）；
//   · 采购 → 流程进度：两张卡各停在对的环节、红条写超期几天；按「卡住或超期」「询价中」筛；点环节去那张单；
//   · 需求单、采购单详情里嵌着同一条流程（紧凑的一排，点环节看那一环、能去那张单）。
// 流程图是只读的；这条用例登记的需求单、采购单、询价单留在库里（不影响别的用例）。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。只在门店电脑尺寸执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}
async function post<T>(request: APIRequestContext, url: string, data: Record<string, unknown>): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** 门店的今天往前 n 天（门店时区 Asia/Shanghai） */
function daysAgo(n: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

interface Req {
  id: number;
  docNo: string;
  lines: { id: number }[];
}

test.describe('8.0.17 ERP 采购流程图', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('流程进度：流程 A 到货超期、流程 B 询价缺报价；筛选；点环节去单据；需求单与采购单详情里嵌着同一条流程', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, 'linlan');
    const api = page.request;
    const rules = await getJson<{ quoteThresholdCents: number; minQuotes: number; arrivalOverdueDays: number }>(api, '/api/inventory/purchase-rules');
    let depts = await getJson<{ id: number; name: string }[]>(api, '/api/inventory/departments');
    if (depts.length === 0) {
      await api.post('/api/inventory/departments', { data: { name: '采购部' } });
      depts = await getJson<{ id: number; name: string }[]>(api, '/api/inventory/departments');
    }
    const dept = depts[0]!;
    const mat = (await getJson<{ id: number; code: string; name: string }[]>(api, '/api/inventory/materials?all=1')).find((m) => m.code === 'M016')!;
    const suppliers = await getJson<{ id: number; code: string; name: string }[]>(api, '/api/inventory/suppliers?all=1');
    const supplier = suppliers.find((s) => s.code === 'S004')!;
    const newRequest = async (qty: number) => {
      const r = (await post<{ request: Req }>(api, '/api/erp/requests', { clientKey: randomUUID(), departmentId: dept.id, lines: [{ materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: qty * 1000, unit: '箱', refPriceCents: 900 }] })).request;
      await post(api, `/api/erp/requests/${r.id}/approve`, {});
      return r;
    };

    // 流程 A：1 箱 × ¥9（小于询价门槛），下单日写在「到货超期天数 + 3 天」以前 → 超期 3 天
    const reqA = await newRequest(1);
    let po = (
      await post<{ po: { id: number; docNo: string; status: string } }>(api, '/api/purchase-orders', {
        clientKey: randomUUID(),
        supplierId: supplier.id,
        orderDate: daysAgo(rules.arrivalOverdueDays + 3),
        action: 'submit',
        lines: [{ materialId: mat.id, purchaseQtyMilli: 1000, priceCents: 900, requestLineIds: [reqA.lines[0]!.id] }],
      })
    ).po;
    if (po.status === 'submitted') po = await post(api, `/api/purchase-orders/${po.id}/approve`, {});
    expect(po.status).toBe('approved');

    // 流程 B：发起询价，只登记 1 家报价
    const reqB = await newRequest(2);
    const ev = (await post<{ event: { id: number; docNo: string; lines: { id: number }[] } }>(api, '/api/purchase-sourcing', { clientKey: randomUUID(), title: `E2E 流程图 ${reqB.docNo}`, lines: [{ materialId: mat.id, purchaseQtyMilli: 2000, requestLineIds: [reqB.lines[0]!.id] }] })).event;
    await post(api, `/api/purchase-sourcing/${ev.id}/quotes`, { clientKey: randomUUID(), supplierId: supplier.id, payTerms: '月结 30 天', prices: [{ lineId: ev.lines[0]!.id, priceCents: 900 }] });

    // ① 采购 → 流程进度
    await page.goto('/purchasing');
    await page.getByTestId('flow-link').click();
    await expect(page).toHaveURL(/\/purchasing\/flow$/);
    await expect(page.getByTestId('flow-rules')).toContainText('按金额分流');
    const cardA = page.getByTestId(`flow-card-po-${po.id}`);
    await expect(cardA).toBeVisible();
    await expect(cardA).toHaveAttribute('data-stage', 'receive');
    await expect(cardA).toHaveAttribute('data-alert', 'true');
    await expect(cardA.getByTestId('flow-variant')).toHaveAttribute('data-variant', 'A');
    await expect(cardA.getByTestId('flow-node-request')).toHaveAttribute('data-state', 'done');
    await expect(cardA.getByTestId('flow-node-review')).toHaveAttribute('data-state', 'done');
    await expect(cardA.getByTestId('flow-node-order')).toContainText(`${po.docNo} 已下单`);
    const receive = cardA.getByTestId('flow-node-receive');
    await expect(receive).toHaveAttribute('data-state', 'current');
    await expect(receive).toHaveAttribute('data-alert', 'true');
    await expect(receive).toContainText('供应商送货中');
    await expect(receive).toContainText('超期 3 天');
    await expect(cardA.getByTestId('flow-node-pay')).toHaveAttribute('data-state', 'pending');
    // 流程 B：九个环节，停在询价比价（报价不够家数）；规则只要 1 家时报价已齐、停在定标
    const cardB = page.getByTestId(`flow-card-request-${reqB.id}`);
    await expect(cardB.getByTestId('flow-variant')).toHaveAttribute('data-variant', 'B');
    await expect(cardB.locator('[data-testid^="flow-node-"]')).toHaveCount(9);
    const stageB = rules.minQuotes > 1 ? 'sourcing' : 'award';
    await expect(cardB).toHaveAttribute('data-stage', stageB);
    await expect(cardB.getByTestId('flow-node-sourcing')).toContainText(rules.minQuotes > 1 ? `已收 1 / ${rules.minQuotes} 家报价` : '已收 1 家报价');
    await expect(cardB.getByTestId('flow-node-order')).toContainText('下单中标方');
    // 需求已经全部转成采购单的，由采购单那张卡代表
    await expect(page.getByTestId(`flow-card-request-${reqA.id}`)).toHaveCount(0);
    // 页面不横向滚动（环节多了在卡片里横向滑）
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // ② 筛选：卡住或超期只剩 A；按环节筛
    await page.getByTestId('flow-filter-alert').click();
    await expect(cardA).toBeVisible();
    await expect(cardB).toHaveCount(0);
    await page.getByTestId(`flow-filter-${stageB}`).click();
    await expect(cardB).toBeVisible();
    await expect(cardA).toHaveCount(0);
    await page.getByTestId('flow-filter-all').click();
    await expect(cardA).toBeVisible();

    // ③ 点环节去那张单：「部门提需求」→ 需求单详情，里面嵌着同一条流程（紧凑的一排，默认选中正在等的那一环）
    await cardA.getByTestId('flow-node-request').click();
    await expect(page).toHaveURL(new RegExp(`/erp/requests\\?request=${reqA.id}$`));
    const sheet = page.getByTestId('request-sheet');
    const panel = sheet.getByTestId('purchase-flow');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-stage', 'receive');
    await expect(panel.getByTestId('flow-track')).toHaveAttribute('data-density', 'compact');
    const picked = panel.getByTestId('flow-selected');
    await expect(picked).toHaveAttribute('data-node', 'receive');
    await expect(picked).toContainText('超期 3 天');
    // 点「采购下单」：下面换成这一环，能去采购单
    await panel.getByTestId('flow-node-order').click();
    await expect(picked).toHaveAttribute('data-node', 'order');
    await expect(picked).toContainText(`${po.docNo} 已下单`);
    await picked.getByTestId('flow-selected-open').click();
    await expect(page).toHaveURL(new RegExp(`/purchasing\\?po=${po.id}$`));
    // ④ 采购单详情里也是这一条；指向自己的环节不给「去看这张单」，别的给
    const poPanel = page.getByTestId('purchase-flow');
    await expect(poPanel).toBeVisible();
    await expect(poPanel.getByTestId('flow-selected')).toHaveAttribute('data-node', 'receive');
    await expect(poPanel.getByTestId('flow-selected-open')).toHaveCount(0);
    await poPanel.getByTestId('flow-node-request').click();
    await expect(poPanel.getByTestId('flow-selected')).toContainText('已提交');
    await expect(poPanel.getByTestId('flow-selected-open')).toBeVisible();
    await expect(poPanel.getByTestId('flow-all-link')).toBeVisible();

    // ⑤ 询价单详情里也嵌着
    await page.goto(`/purchasing/sourcing/${ev.id}`);
    await expect(page.getByTestId('sourcing-detail').getByTestId('purchase-flow')).toHaveAttribute('data-stage', stageB);
  });

  test('采购规则里有「流程图里一个环节等了几天标红」这一项（只读）', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/purchasing/rules');
    await expect(page.getByTestId('pr-stall')).toBeVisible();
    await expect(page.getByTestId('pr-stall')).toHaveValue(/^\d+$/);
  });
});
