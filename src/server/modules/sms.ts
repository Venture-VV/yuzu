// 短信待发箱（8.0.4 批量发券的短信通知，docs/MEMBERSHIP_V804.md 第 6 节，HY08）。
//   · 批量发券在发券的事务里写待发箱（sms_outbox），这里每分钟发：先在短事务里认领（FOR UPDATE SKIP LOCKED、次数加一），
//     事务外调短信接口，再记结果；失败的下一分钟再试，最多 3 次，之后记「发送失败」；
//   · 通道在 .env 配（config.sms）：阿里云短信；mock 只给开发、测试；没配的不发，留在待发箱（页面导出名单手动发）。
//   · 进程在「发出去」与「记结果」之间断掉时，这一条下一分钟会再发一次（少见；宁可重发，不漏发）。
// 密钥只从 config 读，不写日志、不进审计。

import { createHmac, randomUUID } from 'node:crypto';
import type { SmsConfig } from '../config';
import type { Sql } from '../db';

export const SMS_MAX_ATTEMPTS = 3;

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
  const res = await fetch(`${cfg.endpoint}?Signature=${aliyunEncode(signature)}&${query}`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json().catch(() => null)) as { Code?: string; Message?: string; BizId?: string } | null;
  if (!res.ok || body?.Code !== 'OK') throw new Error(`阿里云短信：${body?.Code ?? res.status} ${body?.Message ?? ''}`.trim().slice(0, 250));
  return body.BizId ?? '';
}

/** 每分钟发一批待发的短信；返回这一次发出、失败的条数 */
export async function sendPendingSms(deps: { sql: Sql; config: { sms: SmsConfig } }, opts: { limit?: number; send?: typeof sendAliyun } = {}): Promise<{ sent: number; failed: number }> {
  const cfg = deps.config.sms;
  if (!cfg.provider) return { sent: 0, failed: 0 };
  const { sql } = deps;
  // 认领：在短事务里锁住、次数加一（几个进程同时跑互不重复）；之前进程断掉、次数已满的记失败
  const rows = await sql.begin(async (tx) => {
    await tx`
      UPDATE sms_outbox SET status = 'failed', last_error = coalesce(last_error, '连续 ' || attempts || ' 次没有发出去')
      WHERE status = 'pending' AND attempts >= ${SMS_MAX_ATTEMPTS}`;
    const picked = await tx<{ id: number; phone: string; params: Record<string, unknown> }[]>`
      SELECT id, phone, params FROM sms_outbox WHERE status = 'pending' ORDER BY id LIMIT ${opts.limit ?? 30} FOR UPDATE SKIP LOCKED`;
    if (picked.length) await tx`UPDATE sms_outbox SET attempts = attempts + 1, provider = ${cfg.provider} WHERE id IN ${tx(picked.map((p) => p.id))}`;
    return picked;
  });
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const ref = cfg.provider === 'mock' ? `mock-${row.id}` : await (opts.send ?? sendAliyun)(cfg, row.phone, row.params);
      await sql`
        UPDATE sms_outbox SET status = 'sent', sent_at = now(), provider_ref = ${ref.slice(0, 64)}, last_error = NULL
        WHERE id = ${row.id} AND status = 'pending'`;
      sent += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await sql`
        UPDATE sms_outbox SET last_error = ${message}, status = CASE WHEN attempts >= ${SMS_MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END
        WHERE id = ${row.id} AND status = 'pending'`;
      failed += 1;
    }
  }
  return { sent, failed };
}
