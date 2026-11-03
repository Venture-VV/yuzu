// 硬件连接（飞书需求 RQ-001，v0.7.21，docs/HARDWARE.md）：
//   · 设备登记：校验、编号大写、操作编号重提与冲突、版本号、停用；
//   · 心跳：模拟打印机在线、缺纸、拔线后超过 5 秒记离线、插回恢复；没填 IP 的「还没配好」；
//   · 打印任务：测试页与测试标签真的发到模拟打印机、同一编号只打一张、离线直接失败、不支持与没配好的拒绝、确认作废；
//   · 按采购清单导入（81 台）、对数、重复导入跳过；
//   · 终端替桥上报：状态、读卡事件去重、桥断开记离线、终端超时离线；权限；一键自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Device, DeviceJob, DeviceOverview } from '../src/shared/devices';
import { checkDevicesOnce, waitForDeviceJobs } from '../src/server/modules/devices';
import { startMockPrinter, type MockPrinter } from '../src/server/devices/mock-printer';
import { runDeviceSelftest } from '../src/server/devices/selftest';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let am: string;
let printer: MockPrinter;
let label: MockPrinter;

const create = (body: Record<string, unknown>, cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', '/api/devices', { clientKey: randomUUID(), area: '收银', ...body });
const overview = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/devices/overview')).body as DeviceOverview;
const device = async (code: string) => (await overview()).devices.find((d) => d.code === code)!;
const job = (id: number, kind = 'test_page', cookie = duty, clientKey = randomUUID()) => api(ctx.app, cookie, 'POST', `/api/devices/${id}/jobs`, { clientKey, kind });
const later = (ms: number) => new Date(Date.now() + ms);

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  am = await login(ctx.app, 'am');
  printer = await startMockPrinter();
  label = await startMockPrinter();
});
afterAll(async () => {
  await waitForDeviceJobs();
  await printer?.close();
  await label?.close();
  await ctx?.close();
});

describe('设备登记', () => {
  it('新建：编号转大写、按种类整理字段；接法、所属设备不对拒绝；同一编号重提返回同一台', async () => {
    const key = randomUUID();
    const body = { clientKey: key, code: 'prn-sy-01', name: '收银小票机 1', kind: 'printer', brand: '爱普生', model: 'TM-T83III', area: '收银', connection: 'network', host: printer.host, port: printer.port };
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/devices', body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as Device;
    expect(d).toMatchObject({ code: 'PRN-SY-01', kind: 'printer', connection: 'network', port: printer.port, options: { paperWidth: 80 }, status: 'unknown', version: 1, bridgeKey: null });
    // 没收到结果再提交：同一台
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/devices', body)).body.id).toBe(d.id);
    // 同一编号、不同内容：拒绝
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/devices', { ...body, code: 'PRN-SY-09' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 编号重复
    expect((await create({ code: 'PRN-SY-01', name: '另一台', kind: 'printer', connection: 'network', host: '10.0.0.9' })).body.error.code).toBe('DEVICE_CODE_TAKEN');
    // 打印机不能「终端设备服务」
    expect((await create({ code: 'PRN-SY-02', name: 'x', kind: 'printer', connection: 'bridge' })).status).toBe(400);
    // IP 只能用字母数字与「.」「-」「:」
    expect((await create({ code: 'PRN-SY-02', name: 'x', kind: 'printer', connection: 'network', host: '10.0.0.1/24' })).status).toBe(400);
    // 读卡器要挂在终端下：挂在打印机下拒绝
    expect((await create({ code: 'RDR-SY-01', name: 'x', kind: 'card_reader', connection: 'bridge', hostDeviceCode: 'PRN-SY-01' })).status).toBe(400);
    // 只填 IP 不填端口：默认 9100
    const net = await create({ code: 'PRN-SY-03', name: '收银小票机 3', kind: 'printer', connection: 'network', host: '10.255.255.1' });
    expect(net.body).toMatchObject({ host: '10.255.255.1', port: 9100 });
  });

  it('修改带版本号；种类不能改；地址变了状态回到未知；停用', async () => {
    const d = await device('PRN-SY-03');
    const base = { name: d.name, kind: d.kind, area: d.area, connection: d.connection, host: d.host, port: d.port };
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/devices/${d.id}`, { ...base, expectedVersion: d.version + 5 })).body.error.code).toBe('VERSION_CONFLICT');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/devices/${d.id}`, { ...base, kind: 'label_printer', expectedVersion: d.version })).status).toBe(400);
    const r = await api(ctx.app, ctx.owner, 'PUT', `/api/devices/${d.id}`, { ...base, name: '收银小票机 3（备用）', note: '备用机', expectedVersion: d.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ name: '收银小票机 3（备用）', version: d.version + 1 });
    const off = await api(ctx.app, ctx.owner, 'POST', `/api/devices/${d.id}/enabled`, { enabled: false, expectedVersion: r.body.version });
    expect(off.body).toMatchObject({ enabled: false, status: 'unknown' });
    // 停用的不能打
    expect((await job(d.id)).body.error.code).toBe('DEVICE_DISABLED');
  });

  it('权限：店员能看、不能登记、不能测试打印；客户经理看不到', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/devices/overview')).status).toBe(200);
    expect((await create({ code: 'PRN-X-01', name: 'x', kind: 'printer', connection: 'network' }, ctx.clerk)).status).toBe(403);
    const d = await device('PRN-SY-01');
    expect((await job(d.id, 'test_page', ctx.clerk)).status).toBe(403);
    expect((await api(ctx.app, am, 'GET', '/api/devices/overview')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/devices/events')).status).toBe(403);
  });
});

describe('心跳与状态', () => {
  it('在线、缺纸、拔线超过 5 秒记离线、插回恢复；没填 IP 的「还没配好」', async () => {
    const noIp = await create({ code: 'PRN-HC-01', name: '后厨 1', kind: 'printer', area: '后厨', connection: 'network' });
    expect(noIp.status).toBe(200);
    await checkDevicesOnce(ctx);
    expect(await device('PRN-SY-01')).toMatchObject({ status: 'online', statusCode: null });
    expect(await device('PRN-HC-01')).toMatchObject({ status: 'unknown', statusCode: 'DEVICE_NOT_CONFIGURED' });

    printer.setMode('paper_out');
    await checkDevicesOnce(ctx);
    expect(await device('PRN-SY-01')).toMatchObject({ status: 'error', statusCode: 'DEVICE_PAPER_OUT' });
    printer.setMode('normal');
    await checkDevicesOnce(ctx);
    expect((await device('PRN-SY-01')).status).toBe('online');

    // 拔线：最近一次联系上不到 5 秒时保持在线（一次没连上不算），超过 5 秒记离线
    await printer.stop();
    await checkDevicesOnce(ctx);
    expect((await device('PRN-SY-01')).status).toBe('online');
    await checkDevicesOnce(ctx, later(6_000));
    expect(await device('PRN-SY-01')).toMatchObject({ status: 'offline', statusCode: 'DEVICE_REFUSED' });
    // 离线时提交打印：直接失败，不发
    const before = printer.jobs.length;
    const offline = await job((await device('PRN-SY-01')).id);
    expect(offline.body).toMatchObject({ status: 'failed', errorCode: 'DEVICE_OFFLINE' });
    expect(printer.jobs.length).toBe(before);

    await printer.start();
    await checkDevicesOnce(ctx);
    expect(await device('PRN-SY-01')).toMatchObject({ status: 'online', statusCode: null });
    const events = (await api(ctx.app, ctx.owner, 'GET', `/api/devices/events?deviceId=${(await device('PRN-SY-01')).id}&type=status`)).body as { data: { to: string } }[];
    expect(events.map((e) => e.data.to).slice(0, 4)).toEqual(['online', 'offline', 'online', 'error']);
  });
});

describe('打印任务', () => {
  it('测试页发到打印机，中文与门店名都到了；同一编号只打一张', async () => {
    const d = await device('PRN-SY-01');
    const key = randomUUID();
    const before = printer.jobs.length;
    const r = await job(d.id, 'test_page', duty, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as DeviceJob).status).toBe('queued');
    await waitForDeviceJobs();
    const done = (await api(ctx.app, ctx.clerk, 'GET', `/api/devices/jobs/${r.body.id}`)).body as DeviceJob;
    expect(done).toMatchObject({ status: 'done', attempts: 1, errorCode: null, deviceCode: 'PRN-SY-01', createdByName: '值班经理' });
    await new Promise((res) => setTimeout(res, 50));
    expect(printer.jobs.length).toBe(before + 1);
    const text = printer.texts().at(-1)!;
    expect(text).toContain('打印测试页');
    expect(text).toContain('PRN-SY-01');
    expect(text).toContain('中文样张');
    // 重提：同一个任务，不再打
    const again = await job(d.id, 'test_page', duty, key);
    expect(again.body.id).toBe(r.body.id);
    await waitForDeviceJobs();
    expect(printer.jobs.length).toBe(before + 1);
    // 同一编号换了设备：拒绝
    expect((await job((await device('PRN-HC-01')).id, 'test_page', duty, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('标签机打测试标签（TSPL）；读卡器不接打印；没填 IP 的拒绝', async () => {
    const l = await create({ code: 'LBL-HC-01', name: '后厨标签机', kind: 'label_printer', area: '后厨', connection: 'network', host: label.host, port: label.port, options: { labelLanguage: 'tspl', labelWidthMm: 40, labelHeightMm: 30 } });
    expect(l.status, JSON.stringify(l.body)).toBe(200);
    expect((await job(l.body.id, 'test_page')).body.error.code).toBe('DEVICE_UNSUPPORTED');
    const r = await job(l.body.id, 'label_test');
    expect(r.status).toBe(200);
    await waitForDeviceJobs();
    expect((await api(ctx.app, duty, 'GET', `/api/devices/jobs/${r.body.id}`)).body.status).toBe('done');
    await new Promise((res) => setTimeout(res, 50));
    expect(label.texts().at(-1)).toContain('SIZE 40 mm,30 mm');
    expect(label.texts().at(-1)).toContain('测试标签');
    expect((await job((await device('PRN-HC-01')).id)).body.error.code).toBe('DEVICE_NOT_CONFIGURED');
  });

  it('结果待确认：先确认作废，原请求晚到整笔拒绝；建好后查回能找到', async () => {
    const d = await device('PRN-SY-01');
    const key = randomUUID();
    const abandon = await api(ctx.app, duty, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'device_job', summary: '测试打印' });
    expect(abandon.body).toMatchObject({ found: false, abandoned: true });
    expect((await job(d.id, 'test_page', duty, key)).body.error.code).toBe('OP_ABANDONED');
    const key2 = randomUUID();
    const r = await job(d.id, 'test_page', duty, key2);
    await waitForDeviceJobs();
    expect((await api(ctx.app, duty, 'GET', `/api/erp/ops/${key2}?type=device_job`)).body).toEqual({ found: true, abandoned: false, refId: r.body.id });
    // 登记设备的编号同样能查回；店员不能查回、不能作废
    const dk = randomUUID();
    const nd = await api(ctx.app, ctx.owner, 'POST', '/api/devices', { clientKey: dk, code: 'SCN-SY-01', name: '收银扫码 1', kind: 'scanner', area: '收银', connection: 'keyboard' });
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${dk}?type=device_create`)).body).toEqual({ found: true, abandoned: false, refId: nd.body.id });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${randomUUID()}/abandon`, { type: 'device_job' })).status).toBe(403);
  });
});

describe('按采购清单导入与对数', () => {
  it('预览 81 台；写入后对数一致；再导入全部跳过', async () => {
    const preview = (await api(ctx.app, ctx.owner, 'GET', '/api/devices/import')).body as { create: { code: string }[]; skipped: string[]; total: number };
    expect(preview.total).toBe(81);
    // 前面手动登记的 PRN-SY-01、PRN-SY-03、PRN-HC-01、LBL-HC-01、SCN-SY-01 编号已有，跳过
    expect(preview.skipped.sort()).toEqual(['LBL-HC-01', 'PRN-HC-01', 'PRN-SY-01', 'PRN-SY-03', 'SCN-SY-01']);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/devices/import')).status).toBe(403);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/devices/import');
    expect(r.body).toEqual({ created: 76, skipped: 5 });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/devices/import')).body).toEqual({ created: 0, skipped: 81 });
    const o = await overview();
    const line = (key: string) => o.catalog.find((c) => c.key === key)!;
    expect(line('rc300')).toMatchObject({ purchased: 16, registered: 16 });
    expect(line('d3pro')).toMatchObject({ purchased: 8, registered: 8 });
    expect(line('g4')).toMatchObject({ purchased: 1, registered: 1 });
    // 手动登记的那几台没有挂采购清单：对数里不算
    expect(line('tmt83')).toMatchObject({ purchased: 14, registered: 12 });
    expect(o.catalog.reduce((s, c) => s + c.purchased, 0)).toBe(81);
    const rdr = o.devices.find((d) => d.code === 'RDR-JD-01')!;
    expect(rdr).toMatchObject({ kind: 'card_reader', connection: 'bridge', bridgeKey: 'rc300', area: '接待', catalogKey: 'rc300', hostDeviceId: null });
    await checkDevicesOnce(ctx);
    expect((await device('RDR-JD-01')).statusCode).toBe('DEVICE_NOT_CONFIGURED');
  });
});

describe('终端替桥上报', () => {
  it('终端与读卡器在线、读卡事件按编号去重；桥断开记离线；终端超时离线；没登记的终端 404', async () => {
    const rdr = await device('RDR-SY-01');
    const put = await api(ctx.app, ctx.owner, 'PUT', `/api/devices/${rdr.id}`, {
      name: rdr.name, kind: rdr.kind, area: rdr.area, connection: 'bridge', hostDeviceCode: 'TRM-SY-01', bridgeKey: 'rc300', expectedVersion: rdr.version,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const eventId = randomUUID();
    const report = (body: Record<string, unknown>, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', '/api/devices/bridge-report', body);
    const r = await report({
      terminal: 'trm-sy-01',
      bridge: { connected: true, version: '0.1.0' },
      devices: [{ key: 'rc300', status: 'online' }, { key: 'nfc', status: 'online' }],
      events: [
        { id: eventId, key: 'rc300', type: 'card', value: '0012345678', at: new Date().toISOString() },
        { id: randomUUID(), key: 'nfc', type: 'card', value: '04A1B2C3', at: new Date().toISOString() },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ terminal: { code: 'TRM-SY-01' }, matched: [{ key: 'rc300', code: 'RDR-SY-01' }], unknownKeys: ['nfc'], recorded: 2 });
    expect(await device('TRM-SY-01')).toMatchObject({ status: 'online' });
    expect(await device('RDR-SY-01')).toMatchObject({ status: 'online', statusCode: null });
    // 重发同一个事件：不记两次
    expect((await report({ terminal: 'TRM-SY-01', bridge: { connected: true }, devices: [{ key: 'rc300', status: 'online' }], events: [{ id: eventId, key: 'rc300', type: 'card', value: '0012345678', at: new Date().toISOString() }] })).body.recorded).toBe(0);
    const cards = (await api(ctx.app, ctx.owner, 'GET', '/api/devices/events?type=card')).body as { deviceCode: string; data: { value: string } }[];
    expect(cards.map((e) => `${e.deviceCode}:${e.data.value}`).sort()).toEqual(['RDR-SY-01:0012345678', 'TRM-SY-01:04A1B2C3']);
    // 读卡器拔掉（桥报离线）；桥没连上：挂在终端下的都记离线
    await report({ terminal: 'TRM-SY-01', bridge: { connected: true }, devices: [{ key: 'rc300', status: 'offline', code: 'DEVICE_OFFLINE' }] });
    expect(await device('RDR-SY-01')).toMatchObject({ status: 'offline', statusCode: 'DEVICE_OFFLINE' });
    await report({ terminal: 'TRM-SY-01', bridge: { connected: false } });
    expect(await device('RDR-SY-01')).toMatchObject({ status: 'offline', statusCode: 'BRIDGE_OFFLINE' });
    expect((await device('TRM-SY-01')).status).toBe('online');
    // 终端 5 秒没上报：离线
    await checkDevicesOnce(ctx, later(6_000));
    expect(await device('TRM-SY-01')).toMatchObject({ status: 'offline', statusCode: 'DEVICE_OFFLINE' });
    // 没登记的终端、客户经理（没有看设备状态）
    expect((await report({ terminal: 'TRM-NOPE-01', bridge: { connected: true } })).status).toBe(404);
    expect((await report({ terminal: 'TRM-SY-01', bridge: { connected: true } }, am)).status).toBe(403);
    // 报文不对：400
    expect((await report({ terminal: 'TRM-SY-01', bridge: { connected: true }, events: [{ id: 'x', key: 'rc300', type: 'card', value: '1', at: 'now' }] })).status).toBe(400);
  });
});

describe('一键自检', () => {
  it('device-selftest 全部通过（不连数据库、不要真机）', async () => {
    const r = await runDeviceSelftest();
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.length).toBeGreaterThanOrEqual(20);
  });
});
