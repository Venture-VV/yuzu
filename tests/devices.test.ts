// 硬件连接（飞书需求 RQ-001，v0.7.21，docs/HARDWARE.md）：
//   · 设备登记：校验、编号大写、操作编号重提与冲突、版本号、停用；
//   · 心跳：模拟打印机在线、缺纸、拔线后超过 5 秒记离线、插回恢复；没填 IP 的「还没配好」；
//   · 打印任务：测试页与测试标签真的发到模拟打印机、同一编号只打一张、离线直接失败、不支持与没配好的拒绝、确认作废；
//   · 按采购清单导入（81 台）、对数、重复导入跳过；
//   · 终端替桥上报：状态、读卡事件去重、桥断开记离线、终端超时离线；权限；一键自检。
//   · Codex 预检（3efa3fe）：发完后打印机复位或不确认的记中断、不当成打出；停用、修改设备时排着的任务不发、不改投；
//     心跳按探测前的设置写回，探测期间设置改了的旧结果作废。

import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bridgeErrorEventValue, bridgeEventId, DEVICE_EVENT_VALUE_MAX, parseBridgeMessage, type Device, type DeviceJob, type DeviceOverview } from '../src/shared/devices';
import { checkDevicesOnce, waitForDeviceJobs } from '../src/server/modules/devices';
import { startMockPrinter, type MockPrinter } from '../src/server/devices/mock-printer';
import { sendToPrinter } from '../src/server/devices/netprint';
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
const getJob = async (id: number) => (await api(ctx.app, duty, 'GET', `/api/devices/jobs/${id}`)).body as DeviceJob;
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(ok(), what).toBe(true);
};

/** 收下打印内容后先不关连接的「打印机」：占住连接，测试放行（release）后才正常关 */
async function holdingPrinter() {
  const conns: { bytes: number; socket: net.Socket }[] = [];
  // 对方半关闭后不自动关回去（allowHalfOpen），这张就一直「发送中」
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const c = { bytes: 0, socket };
    conns.push(c);
    socket.on('data', (d) => (c.bytes += d.length));
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    conns,
    release: (i: number) => conns[i]?.socket.end(),
    close: () =>
      new Promise<void>((r) => {
        for (const c of conns) c.socket.destroy();
        server.close(() => r());
      }),
  };
}

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  am = await login(ctx.app, 'am');
  // 打印方式默认「本机打印」（8.0.7，店主 2026-11-10）：这里测服务器直连网口小票机
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { printMode: 'network' })).status).toBe(200);
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

  it('发完后打印机复位连接、或一直不确认收完：记中断、不重发、不当成打出，也不报在线（Codex 预检 3efa3fe P2）', async () => {
    const drop = await startMockPrinter({ mode: 'drop' });
    const hold = await holdingPrinter();
    try {
      // 一张测试页很快就写完；模拟打印机收下后复位连接、没打完
      const direct = await sendToPrinter({ host: drop.host, port: drop.port }, Buffer.from('一张很短的小票\n'), { retryDelayMs: 10 });
      expect(direct).toMatchObject({ ok: false, attempts: 1, errorCode: 'DEVICE_INTERRUPTED' });
      expect(drop.jobs).toHaveLength(0);
      // 写完了、打印机一直不关连接：到时记中断（可能已打出），不重发
      const silent = await sendToPrinter({ host: '127.0.0.1', port: hold.port }, Buffer.from('x'), { confirmTimeoutMs: 300, retryDelayMs: 10 });
      expect(silent).toMatchObject({ ok: false, attempts: 1, errorCode: 'DEVICE_INTERRUPTED' });
      expect(silent.errorMessage).toContain('没有确认收完');
      expect(hold.conns).toHaveLength(1);

      // 走打印任务：记失败、发了一次；设备不因为这张变「在线」
      const d = await create({ code: 'PRN-CX-01', name: '复位测试机', kind: 'printer', connection: 'network', host: drop.host, port: drop.port });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      const r = await job(d.body.id);
      await waitForDeviceJobs();
      expect(await getJob(r.body.id)).toMatchObject({ status: 'failed', attempts: 1, errorCode: 'DEVICE_INTERRUPTED' });
      expect(drop.jobs).toHaveLength(0);
      expect((await device('PRN-CX-01')).status).toBe('unknown');
      const v = (await device('PRN-CX-01')).version;
      await api(ctx.app, ctx.owner, 'POST', `/api/devices/${d.body.id}/enabled`, { enabled: false, expectedVersion: v });
    } finally {
      await drop.close();
      await hold.close();
    }
  });

  it('停用、修改设备：排着还没发的记失败、不发也不改投新地址；已经在发的照常发完（Codex 预检 3efa3fe P2）', async () => {
    const hold = await holdingPrinter();
    const other = await holdingPrinter();
    try {
      const d = await create({ code: 'PRN-CX-02', name: '排队测试机', kind: 'printer', connection: 'network', host: '127.0.0.1', port: hold.port });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      const id = d.body.id as number;

      // 第一张发出去、打印机占着连接；第二张只能排着
      const j1 = await job(id);
      await until(() => (hold.conns[0]?.bytes ?? 0) > 0, '第一张已经发到打印机');
      const j2 = await job(id);
      expect(j2.body.status).toBe('queued');
      // 停用：排着的第二张记失败
      const off = await api(ctx.app, ctx.owner, 'POST', `/api/devices/${id}/enabled`, { enabled: false, expectedVersion: (await device('PRN-CX-02')).version });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(await getJob(j2.body.id)).toMatchObject({ status: 'failed', errorCode: 'DEVICE_DISABLED', attempts: 0 });
      // 放行第一张：照常发完；第二张没有再连打印机
      hold.release(0);
      await waitForDeviceJobs();
      expect(await getJob(j1.body.id)).toMatchObject({ status: 'done', attempts: 1 });
      expect(await getJob(j2.body.id)).toMatchObject({ status: 'failed', errorCode: 'DEVICE_DISABLED' });
      expect(hold.conns).toHaveLength(1);

      // 重新启用；第三张占着连接时把地址改到另一台：排着的第四张记失败，不发到新地址
      const on = await api(ctx.app, ctx.owner, 'POST', `/api/devices/${id}/enabled`, { enabled: true, expectedVersion: (await device('PRN-CX-02')).version });
      expect(on.status).toBe(200);
      const j3 = await job(id);
      await until(() => (hold.conns[1]?.bytes ?? 0) > 0, '第三张已经发到打印机');
      const j4 = await job(id);
      expect(j4.body.status).toBe('queued');
      const cur = await device('PRN-CX-02');
      const moved = await api(ctx.app, ctx.owner, 'PUT', `/api/devices/${id}`, {
        name: cur.name,
        kind: cur.kind,
        area: cur.area,
        connection: cur.connection,
        host: '127.0.0.1',
        port: other.port,
        expectedVersion: cur.version,
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(await getJob(j4.body.id)).toMatchObject({ status: 'failed', errorCode: 'DEVICE_CHANGED', attempts: 0 });
      hold.release(1);
      await waitForDeviceJobs();
      expect(await getJob(j3.body.id)).toMatchObject({ status: 'done' });
      expect(other.conns).toHaveLength(0);
      // 第三张是按旧地址发的：发完不把改了地址的设备记成在线
      expect((await device('PRN-CX-02')).status).toBe('unknown');
      await api(ctx.app, ctx.owner, 'POST', `/api/devices/${id}/enabled`, { enabled: false, expectedVersion: (await device('PRN-CX-02')).version });
    } finally {
      await hold.close();
      await other.close();
    }
  });
});

describe('心跳与修改交错', () => {
  it('心跳占着连接时打印：等这次心跳放开连接再连，打得出来（同时只接一个连接、不回状态的打印机；Codex 自动审查 9ca8a95）', async () => {
    // 同时只接一个连接、不回状态查询的打印机：一次心跳要占满 1.5 秒，这期间来的连接直接断开
    let active: net.Socket | null = null;
    let refused = 0;
    const printed: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      if (active) {
        refused += 1;
        socket.destroy();
        return;
      }
      active = socket;
      const chunks: Buffer[] = [];
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => {
        const all = Buffer.concat(chunks);
        // 状态查询只有几个字节；打印内容才记成打出的一张
        if (all.length > 16) printed.push(all);
        socket.end();
      });
      socket.on('close', () => {
        if (active === socket) active = null;
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const d = await create({ code: 'PRN-CX-04', name: '单连接测试机', kind: 'printer', connection: 'network', host: '127.0.0.1', port });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      const round = checkDevicesOnce(ctx);
      await until(() => active !== null, '心跳已经连上、占着连接');
      const r = await job(d.body.id);
      expect(r.body.status).toBe('queued');
      await round;
      await waitForDeviceJobs();
      expect(await getJob(r.body.id)).toMatchObject({ status: 'done', attempts: 1, errorCode: null });
      expect(printed).toHaveLength(1);
      expect(refused).toBe(0);
      await api(ctx.app, ctx.owner, 'POST', `/api/devices/${d.body.id}/enabled`, { enabled: false, expectedVersion: (await device('PRN-CX-04')).version });
    } finally {
      await new Promise<void>((r) => {
        (active as net.Socket | null)?.destroy();
        server.close(() => r());
      });
    }
  });


  it('探测期间改了设置：旧地址的结果作废，不覆盖新设置的状态（Codex 预检 3efa3fe P3）', async () => {
    // 模拟打印机 1 秒后才回状态：探测还在等回复时，把地址清空
    const slow = await startMockPrinter({ delayMs: 1_000 });
    try {
      const d = await create({ code: 'PRN-CX-03', name: '慢回复测试机', kind: 'printer', connection: 'network', host: slow.host, port: slow.port });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      let probedAt = 0;
      const round = checkDevicesOnce(ctx).then(() => (probedAt = Date.now()));
      await new Promise((r) => setTimeout(r, 150));
      const cur = await device('PRN-CX-03');
      const cleared = await api(ctx.app, ctx.owner, 'PUT', `/api/devices/${cur.id}`, {
        name: cur.name,
        kind: cur.kind,
        area: cur.area,
        connection: cur.connection,
        host: null,
        port: null,
        expectedVersion: cur.version,
      });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      const clearedAt = Date.now();
      expect(cleared.body).toMatchObject({ host: null, port: null, status: 'unknown', version: cur.version + 1 });
      await round;
      // 修改在探测回来之前完成（这一轮确实交错了）；探测回来的「在线」作废
      expect(clearedAt).toBeLessThan(probedAt);
      expect(await device('PRN-CX-03')).toMatchObject({ host: null, port: null, status: 'unknown', version: cur.version + 1 });
      // 下一轮按新设置：没填 IP 的「还没配好」
      await checkDevicesOnce(ctx);
      expect(await device('PRN-CX-03')).toMatchObject({ status: 'unknown', statusCode: 'DEVICE_NOT_CONFIGURED' });
      await api(ctx.app, ctx.owner, 'POST', `/api/devices/${cur.id}/enabled`, { enabled: false, expectedVersion: (await device('PRN-CX-03')).version });
    } finally {
      await slow.close();
    }
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

  it('修改员工的事务还没提交时，店主账号的终端上报（带读卡事件）不被它挡住（8.0.19 W12）', async () => {
    // Codex 在 8.0.15 上遇到一次：两个页面都显示了读卡、不带事件的上报照常 200，带事件的那一次 10 秒没记到。
    // 一条能造成这个现象的路径：修改员工的事务把所有店主行 FOR UPDATE 锁住（保证至少留一位在职店主），
    // 这期间凡是要引用店主的写入（设备事件记经办人）都要等它提交。改成 FOR NO KEY UPDATE：改员工仍然互相串行，不再挡别的写入。
    const [target] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'am'`;
    const eventId = randomUUID();
    let put: Promise<{ status: number; body: unknown }> | null = null;
    let reported: { status: number; body: unknown } | null = null;
    let took = 0;
    await ctx.sql.begin(async (tx) => {
      // 先占住要改的那位员工一行：改员工的事务锁了店主行以后停在这里
      await tx`SELECT id FROM staff WHERE id = ${target!.id} FOR UPDATE`;
      put = api(ctx.app, ctx.owner, 'PUT', `/api/staff/${target!.id}`, { displayName: '客户经理', role: 'account_manager', duties: [], active: true });
      await expect
        .poll(async () => Number((await ctx.sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE staff SET display_name%' AND query NOT ILIKE '%pg_stat_activity%'`)[0]!.n), { timeout: 5_000 })
        .toBe(1);
      const started = Date.now();
      reported = await api(ctx.app, ctx.owner, 'POST', '/api/devices/bridge-report', {
        terminal: 'TRM-SY-01',
        bridge: { connected: true },
        devices: [{ key: 'rc300', status: 'online' }],
        events: [{ id: eventId, key: 'rc300', type: 'card', value: '0081901912', at: new Date().toISOString() }],
      });
      took = Date.now() - started;
    });
    expect(reported!.status, JSON.stringify(reported!.body)).toBe(200);
    expect(reported!.body).toMatchObject({ recorded: 1 });
    expect(took).toBeLessThan(2_000);
    expect((await put!).status).toBe(200);
    // 两个改员工的事务仍然互相串行：第二个等第一个提交（店主行的锁没有放松到可以同时改）
    const [owner] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'owner'`;
    let second: Promise<{ status: number; body: unknown }> | null = null;
    await ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM staff WHERE id = ${owner!.id} FOR NO KEY UPDATE`;
      second = api(ctx.app, ctx.owner, 'PUT', `/api/staff/${target!.id}`, { displayName: '客户经理', role: 'account_manager', duties: [], active: true });
      await expect
        .poll(async () => Number((await ctx.sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM staff WHERE role = ''owner''%' AND query NOT ILIKE '%pg_stat_activity%'`)[0]!.n), { timeout: 5_000 })
        .toBe(1);
    });
    expect((await second!).status).toBe(200);
  });

  it('桥报的错误码只认协议里的（__proto__ 之类不写进去）；拼上错误码的长说明截到上限，整份上报照常收下（Codex 自动审查 9ca8a95）', async () => {
    const report = (body: Record<string, unknown>) => api(ctx.app, ctx.clerk, 'POST', '/api/devices/bridge-report', body);
    // 对象继承来的属性名当错误码：状态照记，错误码不写（原来会把 __proto__ 写进去，设备页渲染出错）
    for (const code of ['__proto__', 'constructor', 'toString']) {
      const r = await report({ terminal: 'TRM-SY-01', bridge: { connected: true }, devices: [{ key: 'rc300', status: 'error', code }] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await device('RDR-SY-01')).toMatchObject({ status: 'error', statusCode: null });
    }
    // 说明 200 字的读卡失败：拼成「错误码：说明」后截到上限，这份上报（连同设备状态）照常收下
    const value = bridgeErrorEventValue('READ_FAILED', '读'.repeat(200));
    expect(value).toHaveLength(DEVICE_EVENT_VALUE_MAX);
    expect(value.startsWith('READ_FAILED：')).toBe(true);
    const r = await report({
      terminal: 'TRM-SY-01',
      bridge: { connected: true },
      devices: [{ key: 'rc300', status: 'online' }],
      events: [{ id: randomUUID(), key: 'rc300', type: 'error', value, at: new Date().toISOString() }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.recorded).toBe(1);
    expect(await device('RDR-SY-01')).toMatchObject({ status: 'online', statusCode: null });
  });

  it('桥发来的同一条报文：几个页面按内容算出同一个编号，只记一次；终端、设备键、类型、内容、时间不同的编号不同（Codex 自动审查 8a20a54）', async () => {
    const at = '2026-11-03T12:00:00.123Z';
    const msg = { terminal: 'TRM-SY-01', key: 'rc300', type: 'card' as const, value: '0099887766', at };
    const id = bridgeEventId(msg);
    expect(bridgeEventId({ ...msg })).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const others = [{ terminal: 'TRM-SY-02' }, { key: 'nfc' }, { type: 'scan' as const }, { value: '0099887767' }, { at: '2026-11-03T12:00:00.124Z' }].map((d) => bridgeEventId({ ...msg, ...d }));
    expect(new Set([id, ...others]).size).toBe(6);
    // 同一台终端开着两个页面，各报一次同一次读卡：只记一次
    const report = () =>
      api(ctx.app, ctx.clerk, 'POST', '/api/devices/bridge-report', {
        terminal: 'TRM-SY-01',
        bridge: { connected: true },
        devices: [{ key: 'rc300', status: 'online' }],
        events: [{ id, key: 'rc300', type: 'card', value: '0099887766', at }],
      });
    const first = await report();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.recorded).toBe(1);
    expect((await report()).body.recorded).toBe(0);
    const cards = (await api(ctx.app, ctx.owner, 'GET', '/api/devices/events?type=card')).body as { deviceCode: string; data: { value: string } }[];
    expect(cards.filter((e) => e.data.value === '0099887766').map((e) => e.deviceCode)).toEqual(['RDR-SY-01']);
    // 协议：错误报文带了桥的时间就留着（页面拿它算编号）；没带的照常认
    expect(parseBridgeMessage(JSON.stringify({ v: 1, type: 'error', key: 'rc300', code: 'READ_FAILED', message: '读卡失败', at }))).toMatchObject({ ok: true, message: { type: 'error', at } });
    const noAt = parseBridgeMessage(JSON.stringify({ v: 1, type: 'error', code: 'READ_FAILED', message: '读卡失败' }));
    expect(noAt.ok && 'at' in noAt.message).toBe(false);
  });
});

describe('一键自检', () => {
  it('device-selftest 全部通过（不连数据库、不要真机）', async () => {
    const r = await runDeviceSelftest();
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.length).toBeGreaterThanOrEqual(20);
  });
});
