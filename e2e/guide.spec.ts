// v0.7.19 对客导览浏览器验收（飞书需求 RQ-004 第四段，docs/FLOORPLAN_FINISH.md 第 2 节）。
//   ① 门店电脑（写数据，只跑一次）：在用底图换成带设施文字的合成样例 → 后台「空间台账 → 对客导览」按底图识别图标、
//      给区域设导览分类 → 导览页：区域色块、中英文区域名、图标与图例，不显示房号 → 大屏模式按设定秒数轮播楼层、Esc 退出。
//   ② 各尺寸与门店大屏 1920×1080（只读，接口用合成数据代替）：导览页与大屏模式不出现横向滚动，图与图例都在。
// 依赖演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。全部是合成数据。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { FloorplanDetail } from '../src/shared/floorplans';
import type { GuideAdmin, GuideData } from '../src/shared/guide';
import type { SpaceLedger } from '../src/shared/spaces';
import { floorplanSampleDxf } from '../src/server/demo/floorplan-sample';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}
async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}
async function send<T = unknown>(page: Page, method: 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}
const csvOf = (file: string) => readFileSync(new URL(`../docs/data/${file}`, import.meta.url), 'utf8').replace(/^﻿/, '');
const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

/** 店主：样例台账（区域挂上）、带设施文字的样例底图在用 */
async function prepare(page: Page) {
  let ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  if (!ledger.zones.some((z) => z.name === '样例SPA区')) {
    await send(page, 'post', '/api/admin/spaces/imports', { kind: 'zones', fileName: 'space-zones-sample.csv', csv: csvOf('space-zones-sample.csv'), encoding: 'UTF-8', clientKey: randomUUID() });
  }
  if (!ledger.spaces.some((s) => s.code === 'T301')) {
    await send(page, 'post', '/api/admin/spaces/imports', { kind: 'spaces', fileName: 'space-ledger-sample.csv', csv: csvOf('space-ledger-sample.csv'), encoding: 'UTF-8', clientKey: randomUUID() });
  }
  ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  const zoneId = (name: string) => ledger.zones.find((z) => z.name === name)!.id;
  for (const [zone, codes] of [
    ['样例SPA区', ['T301', 'T302', 'V312']],
    ['样例派对区', ['X201']],
  ] as const) {
    const spaces = ledger.spaces.filter((s) => (codes as readonly string[]).includes(s.code) && s.zoneId === null).map((s) => ({ id: s.id, version: s.version }));
    if (spaces.length) await send(page, 'post', '/api/admin/spaces/bulk-zone', { spaces, zoneId: zoneId(zone) });
  }
  // 在用底图换成带设施文字的样例（每次带时间戳，摘要不同）
  const dxf = Buffer.from(`999\nE2E 对客导览 ${Date.now()}\n${floorplanSampleDxf(1, { facilities: true })}`, 'utf8');
  const up = await send<FloorplanDetail>(page, 'post', '/api/admin/floorplans', {
    fileName: 'E2E 对客导览样例.dxf',
    contentBase64: dxf.toString('base64'),
    sourceKind: 'other',
    sourceNote: 'E2E 对客导览',
    receivedOn: new Date().toISOString().slice(0, 10),
  });
  await expect.poll(async () => (await getJson<FloorplanDetail>(page, `/api/admin/floorplans/${up.batch.id}`)).batch.status, { timeout: 60_000 }).toBe('ready');
  const plans = await getJson<{ activeId: number | null; activationSeq: number }>(page, '/api/admin/floorplans');
  await send(page, 'post', `/api/admin/floorplans/${up.batch.id}/activate`, { expectedActiveId: plans.activeId, expectedSeq: plans.activationSeq, reason: 'E2E 对客导览' });
}

test.describe('v0.7.19 对客导览', () => {
  test('后台识别图标、设区域分类 → 导览页区域色块与图例、不显示房号 → 大屏轮播楼层', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑尺寸执行一次');
    test.setTimeout(180_000);
    await login(page, 'linlan');
    await prepare(page);
    const before = await getJson<GuideAdmin>(page, '/api/admin/guide');
    try {
      // ① 后台：按在用底图识别图标；样例派对区设成动区
      await page.goto('/admin/spaces');
      await page.getByRole('radio', { name: '对客导览' }).click();
      const card = page.getByTestId('guide-admin');
      await expect(card).toBeVisible();
      await card.getByTestId('guide-detect').click();
      await expect(page.getByText(/按在用底图认出 6 个设施/)).toBeVisible();
      const party = before.zones.find((z) => z.name === '样例派对区')!;
      const row = card.getByTestId(`guide-zone-row-${party.id}`);
      await row.getByRole('radio', { name: '动区' }).click();
      await expect(row.getByRole('radio', { name: '动区' })).toHaveAttribute('aria-checked', 'true');
      // 楼层切到 L3：图标列表里有卫生间（自动识别）
      const markers = card.getByTestId('guide-markers');
      await markers.getByRole('radio', { name: 'L3 三层平面图' }).click();
      await expect(markers).toContainText('卫生间');
      await expect(markers).toContainText('自动识别');

      // ② 前台看导览页：二层先显示（楼层按编码排），派对区是动区色块；有前台、出入口、电梯图标；不显示房号
      await page.request.post('/api/auth/logout');
      await login(page, 'xiaozhou');
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '导览' }).click();
      await expect(page).toHaveURL(/\/guide$/);
      await expect(page.getByRole('radiogroup', { name: '楼层' }).getByRole('radio', { name: 'L2 二层平面图' })).toHaveAttribute('aria-checked', 'true');
      const map = page.getByTestId('guide-map-L2');
      await expect(map.getByTestId(`guide-zone-${party.id}`)).toHaveAttribute('data-kind', 'active');
      for (const k of ['reception', 'entrance', 'elevator']) await expect(map.getByTestId(`guide-marker-${k}`)).toHaveCount(1);
      const legend = page.getByTestId('guide-legend');
      await expect(legend).toContainText('样例派对区');
      await expect(legend).toContainText('Sample Party');
      await expect(legend).toContainText('前台');
      await expect(page.getByTestId('guide-page')).not.toContainText('X201');
      // 底图是去掉文字的那份
      const href = await map.locator('image').getAttribute('href');
      const svg = await page.request.get(href!);
      expect(svg.headers()['content-type']).toContain('image/svg+xml');
      expect(await svg.text()).not.toContain('员工更衣');
      await page.getByRole('radiogroup', { name: '楼层' }).getByRole('radio', { name: 'L3 三层平面图' }).click();
      await expect(page.getByTestId('guide-map-L3').getByTestId('guide-marker-toilet')).toHaveCount(1);
      await noHorizontalScroll(page);

      // ③ 大屏模式：轮播秒数改成 5 秒（店主），两层轮流显示；Esc 退回导览页
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      await send(page, 'put', '/api/admin/guide/rules', { carouselSeconds: 5 });
      await page.goto('/guide');
      await page.getByTestId('guide-screen').click();
      await expect(page).toHaveURL(/\/guide\/screen$/);
      const screen = page.getByTestId('guide-screen-page');
      await expect(screen).toHaveAttribute('data-floor', 'L2');
      await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
      await expect(screen).toHaveAttribute('data-floor', 'L3', { timeout: 9_000 });
      await expect(page.getByTestId('guide-screen-title')).toContainText('L3');
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/\/guide$/);
    } finally {
      // 收尾：轮播秒数改回、派对区改回原来的分类
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      await send(page, 'put', '/api/admin/guide/rules', { carouselSeconds: before.rules.carouselSeconds });
      const cur = (await getJson<GuideAdmin>(page, '/api/admin/guide')).zones.find((z) => z.name === '样例派对区');
      const was = before.zones.find((z) => z.name === '样例派对区');
      if (cur && was && (cur.kind !== was.kind || cur.color !== was.color)) await send(page, 'put', `/api/admin/guide/zones/${cur.id}`, { kind: was.kind, color: was.color, version: cur.version });
    }
  });

  // ── 只读：合成数据代替接口，各尺寸与门店大屏都不出现横向滚动 ──
  const W = 3000;
  const H = 1500;
  const fake: GuideData = {
    storeName: '浴族 · 合成门店',
    batchId: 900201,
    carouselSeconds: 300,
    floors: [
      { code: 'L1', title: '一层', width: W, height: H, svgUrl: '/api/guide/floors/L1/svg?b=900201' },
      { code: 'L2', title: '二层', width: W, height: H, svgUrl: '/api/guide/floors/L2/svg?b=900201' },
    ],
    zones: [
      { id: 1, floorCode: 'L1', name: '合成水区', nameEn: 'Sample Pool', kind: 'active', color: '#f4ad85', polygons: [[[100, 100], [1400, 100], [1400, 1400], [100, 1400]]], labelAt: [750, 750], area: 1300 * 1300 },
      { id: 2, floorCode: 'L1', name: '合成休息区', nameEn: 'Sample Lounge', kind: 'quiet', color: '#9fc4e6', polygons: [[[1600, 100], [2900, 100], [2900, 1400], [1600, 1400]]], labelAt: [2250, 750], area: 1300 * 1300 },
      { id: 3, floorCode: 'L2', name: '合成大堂', nameEn: '', kind: 'public', color: '#ebe4d6', polygons: [[[100, 100], [2900, 100], [2900, 1400], [100, 1400]]], labelAt: [1500, 750], area: 2800 * 1300 },
    ],
    markers: [
      { id: 1, floorCode: 'L1', kind: 'toilet', x: 1500, y: 200, label: '卫生间', labelEn: 'Restroom' },
      { id: 2, floorCode: 'L1', kind: 'elevator', x: 1500, y: 1300, label: '电梯', labelEn: 'Elevator' },
      // 后台改过文字的图标：图上图标下写出来，图例单独一项（Codex 复审 0cf0505）
      { id: 4, floorCode: 'L1', kind: 'elevator', x: 2800, y: 1300, label: 'VIP 电梯', labelEn: 'VIP Lift' },
      { id: 3, floorCode: 'L2', kind: 'reception', x: 400, y: 400, label: '前台', labelEn: 'Reception' },
    ],
  };
  const mock = async (page: Page) => {
    await page.route('**/api/guide', (route: Route) => route.fulfill({ json: fake }));
    await page.route('**/api/guide/floors/*/svg*', (route: Route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="#333" stroke-width="12"/></svg>` }),
    );
  };

  test('导览页与大屏模式：各尺寸不横向滚动，图、图例都在', async ({ page }) => {
    await login(page, 'xiaozhou');
    await mock(page);
    await page.goto('/guide');
    await expect(page.getByTestId('guide-map-L1')).toBeVisible();
    await expect(page.getByTestId('guide-legend')).toContainText('合成水区');
    await expect(page.getByTestId('guide-legend')).toContainText('Restroom');
    // 改过文字的图标：图上只有它写出文字（默认文字的不写，图例里有）；图例里默认的「电梯」与「VIP 电梯」各一项
    await expect(page.getByTestId('guide-map-L1').getByTestId('guide-marker-label')).toHaveText(['VIP 电梯']);
    await expect(page.getByTestId('guide-legend')).toContainText('VIP Lift');
    await expect(page.getByTestId('guide-legend')).toContainText('Elevator');
    await noHorizontalScroll(page);
    await page.goto('/guide/screen');
    await expect(page.getByTestId('guide-screen-page')).toHaveAttribute('data-floor', 'L1');
    await expect(page.getByTestId('guide-map-L1')).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('门店大屏 1920×1080：大屏模式铺满一屏，楼层按钮可以手动切换', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '大屏尺寸只在门店电脑这一组跑一次');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await login(page, 'xiaozhou');
    await mock(page);
    await page.goto('/guide/screen');
    const screen = page.getByTestId('guide-screen-page');
    await expect(screen).toHaveAttribute('data-floor', 'L1');
    const box = await page.getByTestId('guide-map-L1').boundingBox();
    expect(box!.width).toBeGreaterThan(1500);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(1);
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'L2', exact: true }).click();
    await expect(screen).toHaveAttribute('data-floor', 'L2');
    await expect(page.getByTestId('guide-screen-title')).toContainText('L2 二层');
  });
});
