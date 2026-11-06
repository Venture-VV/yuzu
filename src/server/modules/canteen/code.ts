// 员工食堂 · 饭卡码（docs/CANTEEN.md 第 5 节）：码钥匙的派生与服务端核验。
//
// 码钥匙 = HMAC(CANTEEN_CODE_SECRET, 员工编号 + code_epoch)：服务端不存、随时算得出；登录后交给这位员工的手机，
// 手机离线按 30 秒一个时间段签名生成饭卡码。停用、重新开通时 code_epoch 加一，旧手机上的码钥匙随之失效。

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  base32,
  CODE_ACCEPT_FUTURE_STEPS,
  CODE_ACCEPT_PAST_STEPS,
  CODE_MAC_LENGTH,
  codeMessage,
  codeStepOf,
  formatCanteenCode,
} from '@shared/canteen';

export function employeeCodeKey(secret: string, employeeId: number, epoch: number): Buffer {
  return createHmac('sha256', secret).update(`canteen-key:v1:${employeeId}:${epoch}`).digest();
}

export function codeMac(key: Buffer, step: number): string {
  return base32(createHmac('sha256', key).update(codeMessage(step)).digest(), CODE_MAC_LENGTH);
}

/** 服务端生成饭卡码（测试与合成数据用；手机上由柚子饭堂用 WebCrypto 算同一个） */
export function makeCanteenCode(secret: string, employeeId: number, epoch: number, atMs = Date.now()): string {
  const step = codeStepOf(atMs);
  return formatCanteenCode(employeeId, step, codeMac(employeeCodeKey(secret, employeeId, epoch), step));
}

/**
 * 按扫到的时间核对：时间段在前 90 秒到后 30 秒内、签名对得上（常量时间比较）。
 * 时间段太旧或太新回 expired；签名不对回 invalid（码被改过，或员工已重新开通、旧手机的码钥匙作废了）。
 */
export function checkCanteenCode(secret: string, employeeId: number, epoch: number, step: number, mac: string, atMs: number): 'ok' | 'expired' | 'invalid' {
  const now = codeStepOf(atMs);
  const expected = Buffer.from(codeMac(employeeCodeKey(secret, employeeId, epoch), step));
  const got = Buffer.from(mac);
  const signed = got.length === expected.length && timingSafeEqual(got, expected);
  if (!signed) return 'invalid';
  if (step < now - CODE_ACCEPT_PAST_STEPS || step > now + CODE_ACCEPT_FUTURE_STEPS) return 'expired';
  return 'ok';
}
