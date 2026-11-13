// v0.7.14 空间台账浏览器验收（飞书需求 RQ-004 第一段）：后台「空间台账」导入区域清单、空间清单（备注写「推断」「近邻标签」的标为推断）
// → 只看没核对的 → 核对 → 加品牌名别名 → 「客房」里新建房间挂接空间（房号 = 编码）→ 导出；导入结果不明时查回、按原内容重新提交。
// 文件内容是合成样例、编码带时间戳（可重复执行）；结束时取消挂接、停用这次的「客房」空间与房间，免得之后新建房间被要求选空间。
// 依赖演示数据（仅独立演示库），账号店主 linlan，密码 yuzu2026。
import { expect, test, type Page } from '@playwright/test';
import type { RoomsAdmin } from '../src/shared/rooms';
import type { SpaceLedger } from '../src/shared/spaces';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

const getJson = async <T>(page: Page, url: string) => (await (await page.request.get(url)).json()) as T;
async function send<T = Record<string, unknown>>(page: Page, method: 'POST' | 'PUT', url: string, data: unknown): Promise<T> {
  const res = method === 'POST' ? await page.request.post(url, { data }) : await page.request.put(url, { data });
  expect(res.ok(), `${url} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** 选文件：CSV 文字直接塞给文件框 */
const chooseCsv = (page: Page, name: string, csv: string) =>
  page.getByTestId('space-import-file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(`﻿${csv}`, 'utf8') });

/** 结束时收尾：这次的客房房间取消挂接并停用，「客房」空间停用（台账里没有在用的客房时，新建房间不要求选空间） */
async function cleanup(page: Page, code: string) {
  const admin = await getJson<RoomsAdmin>(page, '/api/admin/rooms');
  const room = admin.rooms.find((r) => r.spaceCode === code);
  if (room) {
    await send(page, 'PUT', `/api/admin/rooms/rooms/${room.id}`, {
      roomNo: `X${code.slice(1)}`,
      floor: room.floor,
      roomTypeId: room.roomTypeId,
      sortOrder: room.sortOrder,
      active: false,
      spaceId: null,
      linkReason: 'E2E 结束清理',
    });
  }
  const ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  for (const s of ledger.spaces.filter((x) => x.code === code && x.active)) {
    await send(page, 'PUT', `/api/admin/spaces/${s.id}`, {
      floorId: s.floorId,
      zoneId: s.zoneId,
      businessType: s.businessType,
      capacity: s.capacity,
      areaCentiM2: s.areaCentiM2,
      displayName: s.displayName,
      nameEn: s.nameEn,
      sellable: s.sellable,
      sourceLabel: s.sourceLabel,
      note: s.note,
      active: false,
      version: s.version,
    });
  }
}

test.describe('空间台账（v0.7.14）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会写入台账的流程只在门店电脑尺寸执行一次');

  test('导入区域、空间 → 推断标出 → 核对 → 加品牌名 → 客房房间挂接空间（房号 = 编码）→ 导出', async ({ page }) => {
    const s = String(Date.now()).slice(-5);
    const [spa, back, foot, room] = [1, 2, 3, 4].map((n) => `E${s}${n}`) as [string, string, string, string];
    const zoneSpa = `E2E SPA 区 ${s}`;
    const zoneRoom = `E2E 客房区 ${s}`;
    await login(page, 'linlan');
    try {
      await page.goto('/admin/spaces');
      await expect(page.getByRole('heading', { name: '空间台账' })).toBeVisible();
      await page.getByTestId('subnav-import').click();

      // 区域清单
      await chooseCsv(page, `区域清单-${s}.csv`, ['楼层,区域名(中文),区域名(英文),备注', `L3,${zoneSpa},E2E SPA,合成样例`, `L3,${zoneRoom},E2E Rooms,`].join('\r\n'));
      await expect(page.getByTestId('space-import')).toContainText(`区域清单-${s}.csv`);
      await page.getByTestId('space-import-preview').click();
      await expect(page.getByTestId('space-import-result')).toContainText('新建 2 个区域');
      await page.getByTestId('space-import-apply').click();
      await expect(page.getByText('已新建 2 个区域')).toBeVisible();

      // 空间清单：踩背写「近邻标签」、足浴写「推断」，导入后标为推断
      await page.getByRole('radio', { name: '空间清单' }).click();
      const spacesCsv = [
        '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注,区域',
        `L3,E,${spa},SPA,1,E2E SPA 1人间,,E2E SPA ${spa},,${zoneSpa}`,
        `L3,E,${back},踩背,2,E2E 踩背 2人间,,E2E ${back},近邻标签 踩背2人间,`,
        `L3,E,${foot},足浴,4,E2E 足浴 4人间,,E2E ${foot},按品牌平面图推断,`,
        `L3,E,${room},客房,2,E2E 客房,,E2E 客房 ${room},,${zoneRoom}`,
      ].join('\r\n');
      await chooseCsv(page, `空间清单-${s}.csv`, spacesCsv);
      await expect(page.getByTestId('space-import')).toContainText(`空间清单-${s}.csv`);
      await page.getByTestId('space-import-preview').click();
      const result = page.getByTestId('space-import-result');
      await expect(result).toContainText('新建 4 个空间');
      await expect(result).toContainText('推断 2 个');
      // 写入时结果不明（响应丢了）：页面记下待确认，查回不到就按原内容重新提交，只写一次
      let dropped = false;
      await page.route('**/api/admin/spaces/imports', (r) => {
        if (dropped || r.request().method() !== 'POST') return r.fallback();
        dropped = true;
        return r.abort('connectionreset');
      });
      await page.getByTestId('space-import-apply').click();
      await expect(page.getByText('导入结果待确认', { exact: true })).toBeVisible();
      await page.unroute('**/api/admin/spaces/imports');
      const pending = page.getByTestId('erp-pending');
      await expect(pending).toContainText('空间台账导入结果待确认');
      await pending.getByTestId('erp-pending-resend').click();
      await expect(page.getByText('空间台账导入已登记')).toBeVisible();
      await expect(pending).toHaveCount(0);
      const ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
      expect(ledger.spaces.filter((x) => x.code.startsWith(`E${s}`)).map((x) => [x.code, x.verifyStatus])).toEqual([
        [spa, 'confirmed'],
        [back, 'inferred'],
        [foot, 'inferred'],
        [room, 'confirmed'],
      ]);

      // 只看没核对的 → 核对踩背那间
      await page.getByTestId('subnav-spaces').click();
      await page.getByTestId('spaces-show-unverified').click();
      await expect(page.getByTestId(`space-${back}`)).toBeVisible();
      await expect(page.getByTestId(`space-${foot}`)).toContainText('推断');
      await expect(page.getByTestId(`space-${spa}`)).toHaveCount(0);
      await page.getByTestId(`space-open-${back}`).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByTestId('space-verify-note').fill('E2E 店长现场按门牌核对');
      await dialog.getByTestId('space-verify-save').click();
      await expect(page.getByText(`${back} 改为已核对`)).toBeVisible();
      await expect(dialog.getByTestId('space-verify')).toContainText('E2E 店长现场按门牌核对');
      await dialog.getByText('关闭', { exact: true }).click();
      await expect(page.getByTestId(`space-${back}`)).toHaveCount(0);

      // 客房空间加品牌名（品牌图上可能几间同名）
      await page.getByRole('button', { name: '清除筛选' }).click();
      await page.getByTestId('spaces-search').fill(room);
      await page.getByTestId(`space-open-${room}`).click();
      await dialog.getByTestId('space-alias-input').fill('E2E 客房 C5');
      await dialog.getByTestId('space-alias-add').click();
      await expect(page.getByText('已加品牌名「E2E 客房 C5」')).toBeVisible();
      await expect(dialog.getByTestId('space-aliases')).toContainText('E2E 客房 C5');
      await dialog.getByText('关闭', { exact: true }).click();
      await expect(page.getByTestId(`space-${room}`)).toContainText('别名：E2E 客房 C5');

      // 「客房」里新建房间：选空间，房号就是编码
      let admin = await getJson<RoomsAdmin>(page, '/api/admin/rooms');
      if (!admin.types.some((t) => t.active)) admin = await send<RoomsAdmin>(page, 'POST', '/api/admin/rooms/types', { name: `E2E 空间房型 ${s}`, kind: 'daily', price: 20000 });
      const type = admin.types.find((t) => t.active)!;
      const target = admin.spaces.find((x) => x.code === room)!;
      expect(admin.spaceRequired).toBe(true);
      await page.goto('/admin/rooms/rooms');
      await page.getByTestId('rooms-room-new').click();
      const roomDialog = page.getByRole('dialog', { name: '新建房间' });
      await roomDialog.getByTestId('rooms-room-space').selectOption(String(target.id));
      await expect(roomDialog.getByTestId('rooms-room-no')).toHaveValue(room);
      await expect(roomDialog.getByTestId('rooms-room-no')).toBeDisabled();
      await roomDialog.getByTestId('rooms-room-type').selectOption(String(type.id));
      await roomDialog.getByTestId('rooms-room-save').click();
      await expect(page.getByText(`已新建房间「${room}」`)).toBeVisible();
      await expect(page.getByTestId(`rooms-room-${room}`)).toContainText(`空间 ${room}`);
      await expect(page.getByTestId(`rooms-room-${room}`)).toContainText('E2E 客房');

      // 导出：带别名与核对状态
      await page.goto('/admin/spaces');
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出空间清单' }).click()]);
      const path = await download.path();
      const text = (await import('node:fs')).readFileSync(path!, 'utf8');
      expect(text).toContain(`L3,${zoneRoom},${room},客房,2,,E2E 客房,,E2E 客房 ${room},E2E 客房 C5,是,已核对,,是`);
      expect(text).toContain(`L3,,${foot},足浴,4,,E2E 足浴 4人间,,E2E ${foot},,是,推断,按品牌平面图推断,是`);
    } finally {
      await cleanup(page, room);
    }
    expect((await getJson<RoomsAdmin>(page, '/api/admin/rooms')).spaces.some((x) => x.code === room && x.active)).toBe(false);
  });
});
