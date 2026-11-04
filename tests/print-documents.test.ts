// v0.7.28 ⑥（docs/SCHEDULE_FINISH.md 第 7 节，N7）：业务单据打到小票机与断网打印队列（硬件 v0.2）。全部是合成数据，打印机是模拟的。
//   · 结账单、交班表、日结单、退款单打到模拟打印机：内容（中文、金额的「￥」）、同一编号只打一张、换了单据拒绝；
//   · 权限：要「打印单据到小票机」且能看那张单据（交班表只能打自己的、历史营业日要相应权限）；
//   · 断网打印队列：离线时直接排队（测试页照旧直接失败），插回后心跳恢复在线、自动补打并注明补打；还没开始发就连不上的也排队；
//     等太久不再打；取消（只能取消自己的）；停用打印机时等恢复的记失败；
//   · 结果待确认：确认作废后原请求晚到整笔拒绝，查回能找到。

import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceJob } from '../src/shared/devices';
import type { PrintPrinter } from '../src/shared/print';
import { startMockPrinter, type MockPrinter } from '../src/server/devices/mock-printer';
import { checkDevicesOnce, resumeWaitingJobs, waitForDeviceJobs } from '../src/server/modules/devices';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let am: string;
let printer: MockPrinter;
let prnId: number;
let today: string;
let checkoutId: number;
let checkoutNo: string;

const later = (ms: number) => new Date(Date.now() + ms);
const printDoc = (doc: Record<string, unknown>, cookie = ctx.clerk, deviceId = prnId, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/print/jobs', { clientKey, deviceId, doc });
const getJob = async (id: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/print/jobs/${id}`)).body as DeviceJob;
const lastText = () => printer.texts().at(-1) ?? '';
/** 一个没人听的本机端口（连上去被拒） */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
const deviceOf = async (id: number) => ((await api(ctx.app, ctx.owner, 'GET', '/api/devices')).body as { id: number; version: number; status: string }[]).find((d) => d.id === id)!;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  am = await login(ctx.app, 'am');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  printer = await startMockPrinter();
  const d = await api(ctx.app, ctx.owner, 'POST', '/api/devices', { clientKey: randomUUID(), code: 'PRN-SY-09', name: '收银小票机', kind: 'printer', area: '收银', connection: 'network', host: printer.host, port: printer.port });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  prnId = d.body.id;
  await checkDevicesOnce(ctx);
  // 店员、值班经理开班；一张现金结账单
  expect((await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 10000 })).status).toBe(200);
  expect((await api(ctx.app, duty, 'POST', '/api/shifts', { openingCash: 10000 })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'Q', from: 1, to: 5, width: 3, zone: 'male' })).status).toBe(200);
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'Q001', zone: 'male' }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const visitId = v.body.visits[0].id as number;
  const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const c = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: pre.totalAmount,
    payments: [{ method: 'cash', amount: pre.totalAmount }],
  });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  checkoutId = c.body.id;
  checkoutNo = c.body.checkoutNo;
});
afterAll(async () => {
  await waitForDeviceJobs();
  await printer?.close();
  await ctx?.close();
});

describe('业务单据打到小票机', () => {
  it('结账单：内容与浏览器打印同一份（金额用「￥」）；同一编号只打一张；换了单据拒绝', async () => {
    const printers = (await api(ctx.app, ctx.clerk, 'GET', '/api/print/printers')).body as PrintPrinter[];
    expect(printers).toEqual([expect.objectContaining({ code: 'PRN-SY-09', status: 'online', paperWidth: 80, waiting: 0 })]);
    const key = randomUUID();
    const before = printer.jobs.length;
    const r = await printDoc({ type: 'checkout', id: checkoutId }, ctx.clerk, prnId, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ kind: 'checkout_slip', docLabel: `结账单 ${checkoutNo}`, createdByName: '测试店员' });
    await waitForDeviceJobs();
    expect(await getJob(r.body.id)).toMatchObject({ status: 'done', attempts: 1, errorCode: null, firstWaitedAt: null });
    await new Promise((res) => setTimeout(res, 50));
    expect(printer.jobs.length).toBe(before + 1);
    const text = lastText();
    for (const s of ['结 账 单', checkoutNo, '手牌 Q001', '应收合计', '￥', '收款', '客人签字', '出单', '测试店员']) expect(text, s).toContain(s);
    expect(text).not.toContain('?');
    // 重提：同一个任务、不再打；同一编号换了单据：拒绝
    expect((await printDoc({ type: 'checkout', id: checkoutId }, ctx.clerk, prnId, key)).body.id).toBe(r.body.id);
    await waitForDeviceJobs();
    expect(printer.jobs.length).toBe(before + 1);
    expect((await printDoc({ type: 'settlement', date: today }, ctx.clerk, prnId, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('交班表、日结单、退款单；权限：要「打印单据到小票机」且能看那张单据', async () => {
    const mine = (await api(ctx.app, ctx.clerk, 'GET', '/api/shifts/current')).body.shift;
    const dutyShift = (await api(ctx.app, duty, 'GET', '/api/shifts/current')).body.shift;
    const s = await printDoc({ type: 'shift', id: mine.id });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    await waitForDeviceJobs();
    expect((await getJob(s.body.id)).status).toBe('done');
    expect(lastText()).toContain('交班表（预览）');
    expect(lastText()).toContain('应有现金');
    // 别人的交班表：店员不能打；值班经理（能看历史营业日）能打
    expect((await printDoc({ type: 'shift', id: dutyShift.id })).status).toBe(403);
    expect((await printDoc({ type: 'shift', id: mine.id }, duty)).status).toBe(200);
    // 日结单（80mm 汇总）
    const st = await printDoc({ type: 'settlement', date: today });
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    await waitForDeviceJobs();
    const text = lastText();
    for (const x of ['日 结 单', `营业日 ${today}`, '营业口径', '净营业额', '实收合计', '会员储值', '√']) expect(text, x).toContain(x);
    // 历史营业日：店员不能
    expect((await printDoc({ type: 'settlement', date: '2026-01-01' })).status).toBe(403);
    // 退款单：值班经理退 1 元现金（只退钱），打退款单
    const o = (await api(ctx.app, duty, 'GET', `/api/frontdesk/checkouts/${checkoutId}/refund-options`)).body;
    const item = o.items[0];
    const rf = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutId}/refunds`, {
      clientKey: randomUUID(),
      reason: '客人投诉服务',
      items: [{ category: item.category, name: item.name, quantity: 0, amount: 100 }],
      payments: [{ method: 'cash', amount: 100 }],
    });
    expect(rf.status, JSON.stringify(rf.body)).toBe(201);
    const rp = await printDoc({ type: 'refund', id: rf.body.id }, duty);
    expect(rp.status, JSON.stringify(rp.body)).toBe(200);
    await waitForDeviceJobs();
    expect(lastText()).toContain('退 款 单');
    expect(lastText()).toContain(rf.body.refundNo);
    // 没有「打印单据到小票机」的岗位（客户经理）：看不到打印机，也打不了
    expect((await api(ctx.app, am, 'GET', '/api/print/printers')).status).toBe(403);
    expect((await printDoc({ type: 'checkout', id: checkoutId }, am)).status).toBe(403);
    // 只能打到小票打印机
    const scanner = await api(ctx.app, ctx.owner, 'POST', '/api/devices', { clientKey: randomUUID(), code: 'SCN-SY-09', name: '扫码', kind: 'scanner', area: '收银', connection: 'keyboard' });
    expect((await printDoc({ type: 'checkout', id: checkoutId }, ctx.clerk, scanner.body.id)).body.error.code).toBe('DEVICE_UNSUPPORTED');
  });
});

describe('断网打印队列', () => {
  it('离线时直接排队（测试页照旧直接失败）；插回后自动补打、注明补打', async () => {
    await printer.stop();
    await checkDevicesOnce(ctx, later(6_000));
    expect((await deviceOf(prnId)).status).toBe('offline');
    const r = await printDoc({ type: 'checkout', id: checkoutId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // 在等什么：心跳记下的离线原因（模拟打印机关了端口：连接被拒）
    expect(r.body).toMatchObject({ status: 'waiting', waitCode: 'DEVICE_REFUSED' });
    expect(r.body.firstWaitedAt).toBeTruthy();
    const test = await api(ctx.app, duty, 'POST', `/api/devices/${prnId}/jobs`, { clientKey: randomUUID(), kind: 'test_page' });
    expect(test.body).toMatchObject({ status: 'failed', errorCode: 'DEVICE_OFFLINE' });
    // 还离线：不补打；打印机列表与队列里看得到
    expect(await resumeWaitingJobs(ctx)).toEqual({ resumed: 0, expired: 0 });
    expect(((await api(ctx.app, ctx.clerk, 'GET', '/api/print/printers')).body as PrintPrinter[])[0]).toMatchObject({ status: 'offline', waiting: 1 });
    expect(((await api(ctx.app, ctx.clerk, 'GET', '/api/print/queue')).body as DeviceJob[]).map((j) => j.id)).toEqual([r.body.id]);
    // 插回：心跳恢复在线，等它的单子改回排队、补打
    const before = printer.jobs.length;
    await printer.start();
    await checkDevicesOnce(ctx);
    expect(await resumeWaitingJobs(ctx)).toEqual({ resumed: 1, expired: 0 });
    await waitForDeviceJobs();
    expect(await getJob(r.body.id)).toMatchObject({ status: 'done', waitCode: 'DEVICE_REFUSED' });
    await new Promise((res) => setTimeout(res, 50));
    expect(printer.jobs.length).toBe(before + 1);
    expect(lastText()).toContain('打印机恢复后补打');
    expect(lastText()).toContain(checkoutNo);
  });

  it('还没开始发就连不上的也排队（不算失败）；等超过 30 分钟不再打', async () => {
    const d = await api(ctx.app, ctx.owner, 'POST', '/api/devices', { clientKey: randomUUID(), code: 'PRN-SY-10', name: '收银小票机 2', kind: 'printer', area: '收银', connection: 'network', host: '127.0.0.1', port: await closedPort() });
    expect(d.status).toBe(200);
    // 状态还是「未知」（还没心跳过）：照常排队去发，连不上（被拒）三次后进「等打印机恢复」
    const r = await printDoc({ type: 'checkout', id: checkoutId }, ctx.clerk, d.body.id);
    expect(r.body.status).toBe('queued');
    await waitForDeviceJobs();
    expect(await getJob(r.body.id)).toMatchObject({ status: 'waiting', waitCode: 'DEVICE_REFUSED', attempts: 3, errorCode: null });
    // 30 分钟内不过期；过了不再打
    expect((await resumeWaitingJobs(ctx, { now: later(10 * 60_000) })).expired).toBe(0);
    expect((await resumeWaitingJobs(ctx, { now: later(31 * 60_000) })).expired).toBe(1);
    expect(await getJob(r.body.id)).toMatchObject({ status: 'failed', errorCode: 'DEVICE_WAIT_EXPIRED' });
    const dev = await deviceOf(d.body.id);
    await api(ctx.app, ctx.owner, 'POST', `/api/devices/${d.body.id}/enabled`, { enabled: false, expectedVersion: dev.version });
  });

  it('取消：只能取消自己的（维护设备的人能取消全部）；停用打印机时等恢复的记失败；取消的不补打', async () => {
    await printer.stop();
    await checkDevicesOnce(ctx, later(6_000));
    const a = await printDoc({ type: 'checkout', id: checkoutId });
    expect(a.body.status).toBe('waiting');
    expect((await api(ctx.app, duty, 'POST', `/api/print/jobs/${a.body.id}/cancel`, {})).status).toBe(403);
    const c = await api(ctx.app, ctx.clerk, 'POST', `/api/print/jobs/${a.body.id}/cancel`, {});
    expect(c.body).toMatchObject({ status: 'canceled', canceledByName: '测试店员' });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/print/jobs/${a.body.id}/cancel`, {})).body.error.code).toBe('JOB_NOT_CANCELABLE');
    // 店主（维护设备）能取消别人的
    const b = await printDoc({ type: 'checkout', id: checkoutId });
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/print/jobs/${b.body.id}/cancel`, {})).body.status).toBe('canceled');
    // 停用：等恢复的记失败；启用回来
    const w = await printDoc({ type: 'settlement', date: today });
    expect(w.body.status).toBe('waiting');
    let dev = await deviceOf(prnId);
    await api(ctx.app, ctx.owner, 'POST', `/api/devices/${prnId}/enabled`, { enabled: false, expectedVersion: dev.version });
    expect(await getJob(w.body.id)).toMatchObject({ status: 'failed', errorCode: 'DEVICE_DISABLED' });
    dev = await deviceOf(prnId);
    await api(ctx.app, ctx.owner, 'POST', `/api/devices/${prnId}/enabled`, { enabled: true, expectedVersion: dev.version });
    // 插回：取消的、停用时记失败的都不补打
    const before = printer.jobs.length;
    await printer.start();
    await checkDevicesOnce(ctx);
    expect((await resumeWaitingJobs(ctx)).resumed).toBe(0);
    await waitForDeviceJobs();
    expect(printer.jobs.length).toBe(before);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/print/queue')).body).toEqual([]);
  });

  it('结果待确认：确认作废后原请求晚到整笔拒绝；建好后查回能找到', async () => {
    const key = randomUUID();
    const ab = await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'doc_print', summary: '结账单 → 收银小票机' });
    expect(ab.body).toMatchObject({ found: false, abandoned: true });
    expect((await printDoc({ type: 'checkout', id: checkoutId }, ctx.clerk, prnId, key)).body.error.code).toBe('OP_ABANDONED');
    const key2 = randomUUID();
    const r = await printDoc({ type: 'checkout', id: checkoutId }, ctx.clerk, prnId, key2);
    await waitForDeviceJobs();
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${key2}?type=doc_print`)).body).toEqual({ found: true, abandoned: false, refId: r.body.id });
    expect((await api(ctx.app, am, 'POST', `/api/erp/ops/${randomUUID()}/abandon`, { type: 'doc_print' })).status).toBe(403);
  });
});
