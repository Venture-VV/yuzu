// 短信待发箱（8.0.4 批量发券的短信通知，docs/MEMBERSHIP_V804.md 第 6 节，HY08）。
//   · 批量发券在发券的事务里写待发箱（sms_outbox），这里每分钟发：先在短事务里认领（FOR UPDATE SKIP LOCKED、次数加一、写租约
//     claimed_until，迁移 095），事务外调短信接口，再记结果、清掉租约；租约内别的批次不认领这几条——每分钟的任务前一批没发完时
//     下一批会叠在一起跑（同一进程里也会），没有租约同一条会发两次（Codex 自动审查 8603568）；失败的下一分钟再试，最多 3 次，之后记「发送失败」；
//   · 通道在 .env 配（config.sms）：阿里云短信；mock 只给开发、测试；没配的不发，留在待发箱（页面导出名单手动发）。
//   · 进程在「发出去」与「记结果」之间断掉时，租约过期以后这一条会再发一次（少见；宁可重发，不漏发）。
// 密钥只从 config 读，不写日志、不进审计。

import { createHmac, randomUUID } from 'node:crypto';
import type { SmsConfig } from '../config';
import type { Sql } from '../db';
import { loadSettings } from './settings';

/** 短信发不出去最多试几次（HY08）：默认 3，8.0.7 起在「门店基本规则 → 可调的数值」里改（smsMaxAttempts） */
export const SMS_MAX_ATTEMPTS = 3;
/** 一条最多等多久（阿里云接口的超时） */
const SEND_TIMEOUT_MS = 10_000;

/** 阿里云 RPC 签名用的百分号编码：除了 A–Z a–z 0–9 - _ . ~ 都编码（encodeURIComponent 不编码的 ! ' ( ) * 也要编） */
export function aliyunEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 阿里云 RPC 签名（SignatureVersion 1.0，HMAC-SHA1）：返回签名与排好的查询串 */
export function aliyunSign(params: Record<string, string>, accessKeySecret: string): { signature: string; query: string } {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${aliyunEncode(k)}=${aliyunEncode(params[k]!)}`)
    .join('&');
  const stringToSign = `GET&${aliyunEncode('/')}&${aliyunEncode(query)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  return { signature, query };
}

/** 发一条（阿里云 SendSms）；成功返回回执编号，失败抛错（错误信息不带密钥） */
async function sendAliyun(cfg: SmsConfig, phone: string, templateParams: Record<string, unknown>): Promise<string> {
  const params: Record<string, string> = {
    AccessKeyId: cfg.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: 'cn-hangzhou',
    SignName: cfg.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: cfg.templateCoupon,
    TemplateParam: JSON.stringify(templateParams),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25',
  };
  const { signature, query } = aliyunSign(params, cfg.accessKeySecret);
  const res = await fetch(`${cfg.endpoint}?Signature=${aliyunEncode(signature)}&${query}`, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  const body = (await res.json().catch(() => null)) as { Code?: string; Message?: string; BizId?: string } | null;
  if (!res.ok || body?.Code !== 'OK') throw new Error(`阿里云短信：${body?.Code ?? res.status} ${body?.Message ?? ''}`.trim().slice(0, 250));
  return body.BizId ?? '';
}

/** 每分钟发一批待发的短信；返回这一次发出、失败的条数 */
export async function sendPendingSms(deps: { sql: Sql; config: { sms: SmsConfig } }, opts: { limit?: number; send?: typeof sendAliyun } = {}): Promise<{ sent: number; failed: number }> {
  const cfg = deps.config.sms;
  if (!cfg.provider) return { sent: 0, failed: 0 };
  const { sql } = deps;
  const limit = opts.limit ?? 30;
  // 租约：这一批最多发多久（每条最多等 10 秒）再多留 2 分钟；过了还没记结果的（进程断了）下一批再发
  const leaseSeconds = Math.ceil((limit * SEND_TIMEOUT_MS) / 1000) + 120;
  // 认领：在短事务里锁住没被认领（或租约已过）的待发短信，次数加一、写租约——提交以后别的批次（叠在一起的下一分钟、别的进程）
  // 不再认领这几条；之前进程断掉、次数已满、租约也过了的记失败
  const { smsMaxAttempts } = await loadSettings(sql);
  const rows = await sql.begin(async (tx) => {
    await tx`
      UPDATE sms_outbox SET status = 'failed', last_error = coalesce(last_error, '连续 ' || attempts || ' 次没有发出去'), claimed_until = NULL
      WHERE status = 'pending' AND attempts >= ${smsMaxAttempts} AND (claimed_until IS NULL OR claimed_until < now())`;
    const picked = await tx<{ id: number; phone: string; params: Record<string, unknown> }[]>`
      SELECT id, phone, params FROM sms_outbox
      WHERE status = 'pending' AND (claimed_until IS NULL OR claimed_until < now())
      ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (picked.length) {
      await tx`
        UPDATE sms_outbox SET attempts = attempts + 1, provider = ${cfg.provider}, claimed_until = now() + ${leaseSeconds} * interval '1 second'
        WHERE id IN ${tx(picked.map((p) => p.id))}`;
    }
    return picked;
  });
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const ref = cfg.provider === 'mock' ? `mock-${row.id}` : await (opts.send ?? sendAliyun)(cfg, row.phone, row.params);
      await sql`
        UPDATE sms_outbox SET status = 'sent', sent_at = now(), provider_ref = ${ref.slice(0, 64)}, last_error = NULL, claimed_until = NULL
        WHERE id = ${row.id} AND status = 'pending'`;
      sent += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await sql`
        UPDATE sms_outbox SET last_error = ${message}, claimed_until = NULL, status = CASE WHEN attempts >= ${smsMaxAttempts} THEN 'failed' ELSE 'pending' END
        WHERE id = ${row.id} AND status = 'pending'`;
      failed += 1;
    }
  }
  return { sent, failed };
}
