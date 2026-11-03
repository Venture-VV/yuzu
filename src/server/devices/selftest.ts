// 一键自检（v0.7.21，docs/HARDWARE.md 第 8 节）：不连数据库、不要真机，用模拟打印机与模拟桥把打印、状态、拔线与恢复、
// 发送中断、标签、读卡、扫码、协议错误、模拟键盘走一遍。命令行 device-selftest 与集成测试共用。

import { createWedgeRecognizer, parseBridgeMessage, type BridgeMessage } from '@shared/devices';
import { buildTestLabel, buildTestPage, encodeGb18030 } from './escpos';
import { startMockBridge } from './mock-bridge';
import { startMockPrinter } from './mock-printer';
import { probe, sendToPrinter } from './netprint';

export interface SelftestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const info = (code: string) => ({
  storeName: '自检门店',
  instanceLabel: '自检',
  production: false,
  version: 'selftest',
  device: { code, name: '自检打印机', area: '收银', model: 'MOCK', host: '127.0.0.1', port: 0 },
  paperWidth: 80 as const,
  printedAt: new Date().toISOString(),
  jobId: 0,
});

export async function runDeviceSelftest(log: (line: string) => void = () => {}): Promise<{ ok: boolean; checks: SelftestCheck[] }> {
  const checks: SelftestCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    log(`${ok ? '✓' : '✗'} ${name}：${detail}`);
  };

  const gb = encodeGb18030('中文');
  check('GB18030 编码', gb.join(',') === [0xd6, 0xd0, 0xce, 0xc4].join(','), `「中文」→ ${gb.map((b) => b.toString(16)).join(' ')}`);

  const printer = await startMockPrinter();
  const ep = { host: printer.host, port: printer.port };
  try {
    const sent = await sendToPrinter(ep, buildTestPage(info('PRN-SELF-01')), { timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 50));
    const text = printer.texts().at(-1) ?? '';
    check('网口打印测试页', sent.ok && text.includes('打印测试页') && text.includes('中文样张'), sent.ok ? `模拟打印机收到 ${printer.jobs.at(-1)?.length ?? 0} 字节，含中文样张` : `失败：${sent.errorCode}`);

    let p = await probe(ep, 'escpos');
    check('心跳：在线', p.reachable && p.code === null, p.reachable ? '连上、状态正常' : `连不上：${p.code}`);
    for (const [mode, want] of [
      ['paper_out', 'DEVICE_PAPER_OUT'],
      ['cover_open', 'DEVICE_COVER_OPEN'],
      ['fault', 'DEVICE_FAULT'],
    ] as const) {
      printer.setMode(mode);
      p = await probe(ep, 'escpos');
      check(`心跳：${mode}`, p.reachable && p.code === want, `状态 ${p.code ?? '正常'}`);
    }
    printer.setMode('silent');
    p = await probe(ep, 'escpos', 600);
    check('心跳：不回状态按在线', p.reachable && p.code === null, '连上但不回状态');
    printer.setMode('normal');

    await printer.stop();
    p = await probe(ep, 'escpos');
    check('拔线：连不上', !p.reachable, `错误码 ${p.code}`);
    const refused = await sendToPrinter(ep, Buffer.from('x'), { timeoutMs: 1000, retryDelayMs: 50 });
    check('拔线：打印失败、没开始发的重试 2 次', !refused.ok && refused.attempts === 3 && refused.errorCode === 'DEVICE_REFUSED', `${refused.errorCode}，共试 ${refused.attempts} 次`);
    await printer.start();
    p = await probe(ep, 'escpos');
    check('插回：恢复在线', p.reachable && p.code === null, '同一端口重新连上');

    printer.setMode('drop');
    const big = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const dropped = await sendToPrinter(ep, big, { timeoutMs: 3000 });
    check('发送到一半断开：不重发', !dropped.ok && dropped.errorCode === 'DEVICE_INTERRUPTED' && dropped.attempts === 1, `${dropped.errorCode}，共试 ${dropped.attempts} 次`);
    printer.setMode('normal');

    const label = await sendToPrinter(ep, buildTestLabel({ ...info('LBL-SELF-01'), labelLanguage: 'tspl', labelWidthMm: 40, labelHeightMm: 30 }), { timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 50));
    const labelText = printer.texts().at(-1) ?? '';
    check('标签机（TSPL）测试标签', label.ok && labelText.includes('SIZE 40 mm,30 mm') && labelText.includes('测试标签'), label.ok ? 'TSPL 指令与中文都到了' : `失败：${label.errorCode}`);
    printer.setMode('paper_out');
    p = await probe(ep, 'tspl');
    check('标签机心跳：缺纸', p.code === 'DEVICE_PAPER_OUT', `状态 ${p.code ?? '正常'}`);
  } finally {
    await printer.close();
  }

  const bridge = await startMockBridge({ terminal: 'TRM-SELF-01' });
  try {
    const messages: BridgeMessage[] = [];
    const errors: string[] = [];
    const ws = new WebSocket(bridge.url);
    ws.onmessage = (ev) => {
      const r = parseBridgeMessage(String(ev.data));
      if (r.ok) messages.push(r.message);
      else errors.push(r.reason);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('连不上模拟桥'));
    });
    const waitFor = async (pred: () => boolean, ms = 2000) => {
      const end = Date.now() + ms;
      while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      return pred();
    };
    check('桥：hello', await waitFor(() => messages.some((m) => m.type === 'hello')), `终端 ${bridge.terminal}，设备 ${bridge.devices.map((d) => d.key).join('、')}`);
    ws.send(JSON.stringify({ v: 1, type: 'ping' }));
    check('桥：ping / pong', await waitFor(() => messages.some((m) => m.type === 'pong')), '页面 ping，桥回 pong');
    bridge.sendCard('0012345678');
    check('桥：RC300 读卡', await waitFor(() => messages.some((m) => m.type === 'card' && m.cardNo === '0012345678')), '卡号 0012345678');
    bridge.sendScan('6901234567890');
    check('桥：小闪2 扫码', await waitFor(() => messages.some((m) => m.type === 'scan' && m.code === '6901234567890')), '条码 6901234567890');
    bridge.sendCard('04A1B2C3', 'nfc');
    check('桥：商米 NFC 读卡', await waitFor(() => messages.some((m) => m.type === 'card' && m.key === 'nfc')), '卡号 04A1B2C3');
    bridge.setDevice('rc300', 'offline', 'DEVICE_OFFLINE');
    check('桥：拔掉读卡器', await waitFor(() => messages.some((m) => m.type === 'status' && m.key === 'rc300' && m.status === 'offline')), 'rc300 离线');
    bridge.failRead('rc300');
    check('桥：读卡失败', await waitFor(() => messages.some((m) => m.type === 'error' && m.code === 'READ_FAILED')), 'READ_FAILED');
    bridge.sendRaw(JSON.stringify({ v: 2, type: 'card' }));
    check('桥：协议版本不符的报文不认', await waitFor(() => errors.length > 0), errors[0] ?? '没有收到错误');
    const closed = new Promise<boolean>((resolve) => {
      ws.onclose = () => resolve(true);
      setTimeout(() => resolve(false), 2000);
    });
    bridge.disconnectAll();
    check('桥：断开', await closed, '设备服务断开，页面收到关闭');
  } finally {
    await bridge.close();
  }

  const wedge = createWedgeRecognizer();
  let got: string | null = null;
  let t = 1000;
  for (const k of '6901234567890') got = wedge.feed(k, (t += 10)) ?? got;
  got = wedge.feed('Enter', (t += 10)) ?? got;
  let typed: string | null = null;
  for (const k of '1234') typed = wedge.feed(k, (t += 300)) ?? typed;
  typed = wedge.feed('Enter', (t += 300)) ?? typed;
  check('模拟键盘：扫码与人打字区分', got === '6901234567890' && typed === null, `扫码认出 ${got ?? '无'}，慢慢打的不认`);

  return { ok: checks.every((c) => c.ok), checks };
}
