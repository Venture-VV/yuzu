// 网页推送（Web Push：RFC 8030 推送协议、RFC 8291 内容加密、RFC 8292 VAPID 签名）：给员工手机上的柚子饭堂发通知。
//
// 只用 Node 自带的 crypto，不另加依赖；加密按 RFC 8291 附录 A 的例子逐字节核对过（tests/web-push.test.ts）。
//   · 推送地址是员工手机交上来的：只认几家浏览器推送服务的 https 地址（谷歌 FCM、苹果、Mozilla、微软 WNS），
//     不认 IP、不认别的主机、不跟随跳转——免得被拿来让门店系统去访问内网（SSRF）。开发、测试另认本机的 http（模拟推送服务）。
//   · 推送地址相当于这台手机的收件凭证：不写日志，出错原因里不带地址。

import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

/** 这个实例的推送钥匙（P-256）：公钥是未压缩的点（65 字节），私钥 32 字节，都是 base64url */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** 一台手机的订阅（浏览器 PushSubscription 的 endpoint 与 keys） */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  /** 推送服务最多替这条消息等多久（秒）：手机关机、没网，过了就不送了 */
  ttl: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** 同一个 topic 还没送到的旧消息会被新的替换（字母、数字、- 和 _，最多 32 个） */
  topic?: string;
  timeoutMs?: number;
  /** 开发、测试：认本机的 http 地址（模拟推送服务） */
  allowLocal?: boolean;
}

export type PushOutcome =
  | { ok: true; status: number }
  /** gone：这个订阅没了（推送服务回 404 / 410，或地址、钥匙不对），以后不再发 */
  | { ok: false; gone: boolean; status: number | null; error: string };

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const B64U = /^[A-Za-z0-9_-]+={0,2}$/;
/** base64url（可以带 =）解成字节；格式不对返回 null */
function fromB64u(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !B64U.test(text)) return null;
  return Buffer.from(text.replace(/=+$/, ''), 'base64url');
}
const pad32 = (key: Buffer) => (key.length >= 32 ? key : Buffer.concat([Buffer.alloc(32 - key.length), key]));

/** 生成一副推送钥匙（每个实例一副，第一次用到时生成） */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(pad32(ecdh.getPrivateKey())) };
}

/** 浏览器交上来的钥匙：p256dh 是曲线上的点（65 字节、0x04 开头），auth 16 字节；不对返回问题 */
export function pushKeysProblem(p256dh: unknown, auth: unknown): string | null {
  const pub = fromB64u(p256dh);
  const secret = fromB64u(auth);
  if (!pub || pub.length !== 65 || pub[0] !== 4 || !secret || secret.length !== 16) return '这台手机给的推送钥匙不对';
  try {
    // 不在曲线上的点算不出共享密钥
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub);
  } catch {
    return '这台手机给的推送钥匙不对';
  }
  return null;
}

/**
 * 认的推送服务（主机名，小写）：谷歌 FCM（Chrome、Edge 安卓版、三星浏览器）、苹果（iPhone、Mac 的 Safari）、
 * Mozilla（Firefox）、微软 WNS（Windows 上的 Edge）。别的主机一律不发。
 */
const PUSH_SERVICE_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 推送地址能不能发：只认上面几家推送服务的 https 地址（默认端口、不带账号密码）；不对返回问题 */
export function pushEndpointProblem(endpoint: unknown, opts: { allowLocal?: boolean } = {}): string | null {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 2048) return '推送地址不对';
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return '推送地址不对';
  }
  if (url.username || url.password || url.hash) return '推送地址不对';
  if (opts.allowLocal && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return null;
  if (url.protocol !== 'https:' || url.port !== '') return '推送地址要是 https 的';
  const host = url.hostname.toLowerCase();
  if (!PUSH_SERVICE_HOSTS.some((re) => re.test(host))) return '这个浏览器的推送服务柚子还不认识';
  return null;
}

/**
 * 内容加密（RFC 8291，aes128gcm）：与这台手机的公钥做 ECDH，再用 auth 派生内容密钥；整条消息一个记录（记录大小 4096）。
 * fixed 只给测试用（固定 salt 与发送方私钥，按 RFC 附录 A 核对）。
 */
export function encryptPushPayload(plaintext: Uint8Array, p256dh: string, auth: string, fixed?: { salt: Buffer; asPrivate: Buffer }): Buffer {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (!uaPublic || uaPublic.length !== 65 || !authSecret || authSecret.length !== 16) throw new Error('推送钥匙不对');
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = fixed?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 最后一个（也是唯一一个）记录：内容后面加分隔字节 0x02，不再补零
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

/** VAPID（RFC 8292）：给这个推送服务（aud = 推送地址的来源）签一个 12 小时有效的 JWT */
export function vapidAuthorization(audience: string, keys: VapidKeys, subject: string, nowMs = Date.now()): string {
  const pub = fromB64u(keys.publicKey);
  if (!pub || pub.length !== 65) throw new Error('推送钥匙不对');
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey.replace(/=+$/, ''), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey.replace(/=+$/, '')}`;
}

function describeStatus(status: number): string {
  if (status === 400) return '推送服务说请求格式不对（400）';
  if (status === 401 || status === 403) return `推送服务不认门店系统的签名（${status}）`;
  if (status === 413) return '通知内容太长（413）';
  if (status === 429) return '推送服务说发得太频繁，稍后再试（429）';
  if (status >= 500) return `推送服务暂时出错（${status}）`;
  if (status >= 300 && status < 400) return `推送服务要求跳转，没有跟过去（${status}）`;
  return `推送服务没收下（${status}）`;
}

/** 发一条：加密、签名、POST 到推送地址；不抛错，结果写在返回值里（地址不进错误信息） */
export async function sendWebPush(target: PushTarget, payload: string, keys: VapidKeys, subject: string, opts: PushOptions): Promise<PushOutcome> {
  const problem = pushEndpointProblem(target.endpoint, { allowLocal: opts.allowLocal });
  if (problem) return { ok: false, gone: true, status: null, error: problem };
  const url = new URL(target.endpoint);
  let body: Buffer;
  try {
    body = encryptPushPayload(Buffer.from(payload, 'utf8'), target.p256dh, target.auth);
  } catch {
    return { ok: false, gone: true, status: null, error: '这台手机的推送钥匙不对' };
  }
  // 推送服务只收 4096 字节以内的消息
  if (body.length > 4096) return { ok: false, gone: false, status: null, error: '通知内容太长' };
  const headers: Record<string, string> = {
    TTL: String(Math.max(0, Math.floor(opts.ttl))),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: vapidAuthorization(url.origin, keys, subject),
  };
  if (opts.urgency) headers.Urgency = opts.urgency;
  if (opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.Topic = opts.topic;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, gone: false, status: null, error: timeout ? '推送服务没有回应（超时）' : '连不上推送服务' };
  }
  // 回的内容不看（推送服务的出错说明可能很长），丢掉
  await res.body?.cancel().catch(() => undefined);
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
  if (res.status === 404 || res.status === 410) return { ok: false, gone: true, status: res.status, error: `这台手机的订阅没了：关了通知、清了浏览器数据或删了桌面上的柚子（${res.status}）` };
  return { ok: false, gone: false, status: res.status, error: describeStatus(res.status) };
}
