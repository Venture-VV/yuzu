// 网页推送的测试工具（tests/web-push.test.ts、tests/canteen-reminders.test.ts 共用）：假手机（自己的钥匙，解得开推送）、
// 本机的模拟推送服务（记下收到的每一条，可以按地址回不同的状态码）。

import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 手机那一边：用自己的私钥与 auth 解开（RFC 8291 第 3.4 节反过来）；记录大小不是 4096 或格式不对时抛错 */
export function decryptPush(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  if (rs !== 4096) throw new Error(`记录大小不对：${rs}`);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  const end = padded.lastIndexOf(2);
  if (end < 0) throw new Error('没有结尾的分隔字节');
  return padded.subarray(0, end).toString('utf8');
}

/** 一台假手机：自己的钥匙（像浏览器的 PushSubscription.keys），open 解开发给它的推送 */
export function fakePhone() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    open: (body: Buffer) => decryptPush(body, ecdh.getPrivateKey(), ecdh.getPublicKey(), auth),
  };
}

export interface PushHit {
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** 本机的模拟推送服务：statusFor 按路径决定回什么（默认 201） */
export async function mockPushService(): Promise<{
  base: string;
  hits: PushHit[];
  statusFor: Map<string, number>;
  close: () => Promise<void>;
}> {
  const hits: PushHit[] = [];
  const statusFor = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '';
      hits.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(statusFor.get(path) ?? 201).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    hits,
    statusFor,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
