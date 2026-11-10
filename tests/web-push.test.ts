// 网页推送（src/server/lib/web-push.ts，docs/CANTEEN.md 第 19 节）：不连数据库。
//   · 加密与 RFC 8291 附录 A 的例子逐字节一致；随机钥匙加密的，按手机那一边的算法解得开；
//   · VAPID 签名：ES256、aud 是推送服务的来源、12 小时有效，公钥验得过；
//   · 推送地址只认几家浏览器推送服务的 https 地址（防 SSRF），开发、测试才认本机 http；
//   · 发送：201 算送到；404 / 410 算订阅没了；超时、跳转都不跟，出错信息里不带推送地址。

import { createPublicKey, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptPushPayload, generateVapidKeys, pushEndpointProblem, pushKeysProblem, sendWebPush, vapidAuthorization } from '../src/server/lib/web-push';
import { decryptPush, fakePhone } from './push-helpers';

const b64 = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

describe('内容加密（RFC 8291）', () => {
  it('与 RFC 8291 附录 A 的例子逐字节一致', () => {
    const body = encryptPushPayload(Buffer.from('When I grow up, I want to be a watermelon'), 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', {
      salt: b64('DGv6ra1nlYgDCS1FRnbzlw'),
      asPrivate: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    });
    expect(body.toString('base64url')).toBe(
      b64(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
           mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
           pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`).toString('base64url'),
    );
    // 手机那一边（RFC 的接收方私钥）解得开
    const ua = b64('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
    expect(decryptPush(body, ua, b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), b64('BTBZMqHH6r4Tts7J_aSIgg'))).toBe(
      'When I grow up, I want to be a watermelon',
    );
  });

  it('每次随机的发送方钥匙与 salt：中文、表情都解得开，两次加密结果不一样', () => {
    const phone = fakePhone();
    const text = JSON.stringify({ title: '柚子喊你吃午饭啦 🍱', body: '小林，肚子咕咕叫了吧？' });
    const a = encryptPushPayload(Buffer.from(text), phone.p256dh, phone.auth);
    const b = encryptPushPayload(Buffer.from(text), phone.p256dh, phone.auth);
    expect(a.equals(b)).toBe(false);
    expect(phone.open(a)).toBe(text);
    expect(phone.open(b)).toBe(text);
  });

  it('手机给的钥匙：长度、开头、是不是曲线上的点都要对', () => {
    const phone = fakePhone();
    expect(pushKeysProblem(phone.p256dh, phone.auth)).toBeNull();
    expect(pushKeysProblem(`${phone.p256dh}=`, phone.auth)).toBeNull();
    expect(pushKeysProblem(phone.p256dh.slice(0, 40), phone.auth)).not.toBeNull();
    expect(pushKeysProblem(phone.p256dh, 'c2hvcnQ')).not.toBeNull();
    expect(pushKeysProblem(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), phone.auth)).not.toBeNull();
    expect(pushKeysProblem('not base64!', phone.auth)).not.toBeNull();
    expect(pushKeysProblem(123, phone.auth)).not.toBeNull();
  });
});

describe('VAPID 签名（RFC 8292）', () => {
  it('ES256 的 JWT：aud 是推送服务的来源，12 小时有效，公钥验得过；k 是公钥', () => {
    const keys = generateVapidKeys();
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
    const now = Date.UTC(2026, 10, 10, 3, 0, 0);
    const header = vapidAuthorization('https://web.push.apple.com', keys, 'https://staff.example.com', now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m).not.toBeNull();
    expect(JSON.parse(Buffer.from(m[1]!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(m[2]!, 'base64url').toString())).toEqual({ aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 3600, sub: 'https://staff.example.com' });
    expect(m[4]).toBe(keys.publicKey);
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    const sig = Buffer.from(m[3]!, 'base64url');
    expect(sig).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });
});

describe('推送地址只认浏览器的推送服务（防 SSRF）', () => {
  it('认谷歌、苹果、Mozilla、微软的 https 地址', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc:APA91b',
      'https://android.googleapis.com/gcm/send/abc',
      'https://web.push.apple.com/QGuQyavXutnMH8DG2T1lyE',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://wns2-sg2p.notify.windows.com/w/?token=BQYAAAB',
    ]) {
      expect(pushEndpointProblem(ok), ok).toBeNull();
    }
  });

  it('不认 http、IP、内网、别的主机、带端口或账号的、长得像的', () => {
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://127.0.0.1/push',
      'https://10.0.0.5/push',
      'https://100.100.100.200/latest/meta-data',
      'https://localhost/push',
      'https://example.com/push',
      'https://fcm.googleapis.com.evil.example/push',
      'https://evilpush.apple.com.example.net/x',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pass@fcm.googleapis.com/fcm/send/abc',
      'https://web.push.apple.com/abc#frag',
      'ftp://web.push.apple.com/abc',
      'not a url',
      '',
      `https://web.push.apple.com/${'a'.repeat(2100)}`,
    ]) {
      expect(pushEndpointProblem(bad), bad).not.toBeNull();
    }
    expect(pushEndpointProblem(42)).not.toBeNull();
  });

  it('本机的 http 只有开发、测试打开时才认', () => {
    expect(pushEndpointProblem('http://127.0.0.1:9999/push/a')).not.toBeNull();
    expect(pushEndpointProblem('http://127.0.0.1:9999/push/a', { allowLocal: true })).toBeNull();
    expect(pushEndpointProblem('http://localhost:9999/push/a', { allowLocal: true })).toBeNull();
    expect(pushEndpointProblem('http://192.168.1.20:9999/push/a', { allowLocal: true })).not.toBeNull();
  });
});

describe('发送', () => {
  let server: Server;
  let base: string;
  const got: { url: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
  let reply: { status: number; delayMs?: number; location?: string } = { status: 201 };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        got.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        const send = () => {
          if (reply.location) res.setHeader('location', reply.location);
          res.writeHead(reply.status).end('push service says hi');
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs);
        else send();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('201：送到；带 TTL、Urgency、Topic、aes128gcm 与 VAPID，内容手机解得开', async () => {
    const phone = fakePhone();
    const keys = generateVapidKeys();
    reply = { status: 201 };
    got.length = 0;
    const r = await sendWebPush({ endpoint: `${base}/push/one`, ...phone }, '{"title":"柚子喊你吃午饭啦"}', keys, 'mailto:canteen@example.com', {
      ttl: 1800,
      urgency: 'high',
      topic: 'meal-lunch',
      allowLocal: true,
    });
    expect(r).toEqual({ ok: true, status: 201 });
    expect(got).toHaveLength(1);
    const h = got[0]!.headers;
    expect(got[0]!.url).toBe('/push/one');
    expect(h.ttl).toBe('1800');
    expect(h.urgency).toBe('high');
    expect(h.topic).toBe('meal-lunch');
    expect(h['content-encoding']).toBe('aes128gcm');
    expect(String(h.authorization)).toMatch(new RegExp(`^vapid t=[^.]+\\.[^.]+\\.[^,]+, k=${keys.publicKey}$`));
    const claims = JSON.parse(Buffer.from(String(h.authorization).split('.')[1]!, 'base64url').toString());
    expect(claims.aud).toBe(base);
    expect(phone.open(got[0]!.body)).toBe('{"title":"柚子喊你吃午饭啦"}');
  });

  it('410 / 404：订阅没了；其余出错照实说、不带推送地址；不跟跳转', async () => {
    const phone = fakePhone();
    const keys = generateVapidKeys();
    const send = (path: string) => sendWebPush({ endpoint: `${base}${path}`, ...phone }, '{}', keys, 'mailto:a@example.com', { ttl: 60, allowLocal: true, timeoutMs: 2000 });
    reply = { status: 410 };
    const gone = await send('/push/secret-410');
    expect(gone).toMatchObject({ ok: false, gone: true, status: 410 });
    reply = { status: 404 };
    expect(await send('/push/secret-404')).toMatchObject({ ok: false, gone: true, status: 404 });
    reply = { status: 403 };
    const denied = await send('/push/secret-403');
    expect(denied).toMatchObject({ ok: false, gone: false, status: 403 });
    reply = { status: 302, location: `${base}/elsewhere` };
    got.length = 0;
    const moved = await send('/push/secret-302');
    expect(moved).toMatchObject({ ok: false, gone: false, status: 302 });
    expect(got.map((g) => g.url)).toEqual(['/push/secret-302']);
    reply = { status: 500 };
    expect(await send('/push/secret-500')).toMatchObject({ ok: false, gone: false, status: 500 });
    for (const r of [gone, denied, moved]) expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('推送服务不回：按超时算没送到；地址不认的不发、算订阅没了', async () => {
    const phone = fakePhone();
    const keys = generateVapidKeys();
    reply = { status: 201, delayMs: 1500 };
    const slow = await sendWebPush({ endpoint: `${base}/push/slow`, ...phone }, '{}', keys, 'mailto:a@example.com', { ttl: 60, allowLocal: true, timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, gone: false, status: null });
    expect((slow as { error: string }).error).toContain('超时');
    got.length = 0;
    const local = await sendWebPush({ endpoint: `${base}/push/x`, ...phone }, '{}', keys, 'mailto:a@example.com', { ttl: 60 });
    expect(local).toMatchObject({ ok: false, gone: true, status: null });
    expect(got).toHaveLength(0);
    const badKeys = await sendWebPush({ endpoint: `${base}/push/x`, p256dh: 'AAAA', auth: phone.auth }, '{}', keys, 'mailto:a@example.com', { ttl: 60, allowLocal: true });
    expect(badKeys).toMatchObject({ ok: false, gone: true });
    expect(got).toHaveLength(0);
  });
});
