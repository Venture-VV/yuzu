// 员工食堂 · 店里局域网（K18）与柚子的声音（K19）里不碰数据库的几样：
// 手机上纯 JS 算饭卡码（局域网 http 打开时浏览器不给 WebCrypto）与服务端 node:crypto 逐字节一致；局域网地址的认法；挑中文朗读的声音。

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { codeStepOf, fromBase64Url, isLanHost, signCanteenCode } from '../src/shared/canteen';
import { hmacSha256, sha256 } from '../src/shared/hmac-sha256';
import { employeeCodeKey, makeCanteenCode } from '../src/server/modules/canteen/code';
import { pickVoice } from '../src/canteen-app/voice';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const text = (s: string) => new TextEncoder().encode(s);

describe('纯 JS 的 SHA-256 与 HMAC-SHA256', () => {
  it('SHA-256 的标准例子（空串、abc、跨两块的 448 位）', () => {
    expect(hex(sha256(text('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(text('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('RFC 4231 的 HMAC-SHA256 例子（含比一块长的钥匙）', () => {
    const cases: [string, Uint8Array, string][] = [
      ['0b'.repeat(20), text('Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
      [hex(text('Jefe')), text('what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
      ['aa'.repeat(20), bytes('dd'.repeat(50)), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
      ['aa'.repeat(131), text('Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
    ];
    for (const [key, msg, mac] of cases) expect(hex(hmacSha256(bytes(key), msg))).toBe(mac);
  });

  it('随机的钥匙与内容（0–300 字节，跨过 55、56、64 的补位边界）都与 node:crypto 一样', () => {
    for (let len = 0; len <= 300; len++) {
      const key = randomBytes(1 + (len % 90));
      const msg = randomBytes(len);
      expect(hex(sha256(msg)), `sha256 ${len}`).toBe(createHash('sha256').update(msg).digest('hex'));
      expect(hex(hmacSha256(key, msg)), `hmac ${len}`).toBe(createHmac('sha256', key).update(msg).digest('hex'));
    }
  });
});

describe('手机上生成的饭卡码与服务端一致', () => {
  const secret = 'lan-test-secret-0123456789abcdef-0123456789';

  it('码钥匙的 base64url 解得回来', () => {
    for (let i = 0; i < 50; i++) {
      const raw = randomBytes(i);
      expect(hex(fromBase64Url(raw.toString('base64url')))).toBe(raw.toString('hex'));
    }
    expect(() => fromBase64Url('不是码钥匙')).toThrow();
  });

  it('不同员工、码钥匙版本、时间：手机算的码就是服务端算的码', () => {
    const t0 = Date.parse('2026-11-07T12:00:00+08:00');
    for (let id = 1; id <= 40; id++) {
      for (const epoch of [0, 1, 7]) {
        const at = t0 + id * 37_000 + epoch * 1_000;
        const key = employeeCodeKey(secret, id, epoch).toString('base64url');
        const phone = signCanteenCode(key, id, at);
        expect(phone.step).toBe(codeStepOf(at));
        expect(phone.text).toBe(makeCanteenCode(secret, id, epoch, at));
      }
    }
  });
});

describe('店里局域网的地址（K18）', () => {
  it('本机、私网 IP、Tailscale 的 100.64–127、.local/.lan 等算局域网', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.8', '172.16.5.1', '172.31.255.254', '192.168.1.20', '100.64.0.1', '100.101.102.103', 'yuzu.local', 'canteen.lan', 'pos.home.arpa', 'yuzu.internal', 'YUZU.LOCAL.'])
      expect(isLanHost(h), h).toBe(true);
  });
  it('公网地址、域名、不合法的 IP 不算', () => {
    for (const h of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '100.63.255.255', '100.128.0.1', 'staff.example.com', 'local', '192.168.1.256', '192.0.2.2', ''])
      expect(isLanHost(h), h).toBe(false);
  });
});

describe('柚子的声音挑哪一个（K19）', () => {
  const v = (name: string, lang: string, localService = true) => ({ name, lang, localService });
  it('普通话的女声优先，本机的优先；台湾国语、粤语垫后', () => {
    expect(pickVoice([v('Samantha', 'en-US'), v('Sinji', 'zh-HK'), v('Meijia', 'zh-TW'), v('Tingting', 'zh-CN')])?.name).toBe('Tingting');
    expect(pickVoice([v('Microsoft Kangkang - Chinese (Simplified, PRC)', 'zh-CN'), v('Microsoft Huihui - Chinese (Simplified, PRC)', 'zh-CN')])?.name).toContain('Huihui');
    expect(pickVoice([v('Google 普通话（中国大陆）', 'zh_CN', false), v('cmn-cn-x-ccc-local', 'cmn-Hans-CN')])?.name).toBe('cmn-cn-x-ccc-local');
    expect(pickVoice([v('Sinji', 'zh-HK'), v('Meijia', 'zh-TW')])?.name).toBe('Meijia');
  });
  it('没有中文的声音就不念', () => {
    expect(pickVoice([v('Samantha', 'en-US'), v('Kyoko', 'ja-JP')])).toBeNull();
    expect(pickVoice([])).toBeNull();
  });
});
