// 批量发券（8.0.4 需求表 06，docs/MEMBERSHIP_V804.md 第 6 节，HY07、HY08、HY16）：按档级、标签圈一批会员发券，
// 通知两个开关——短信（进短信待发箱，sms.ts 每分钟发）、会员端弹窗（会员端提醒，member-notices.ts 给小程序读）。
//
//   · 新建（带操作编号，走「结果待确认」）：一个事务里定下名单（在用的会员：没停用、没合并），写发券单与名单；
//   · 发放：每批 200 位一个事务，锁发券单一行（同一张单同时只有一处在发）→ 模板（共享锁）→ 逐位核对（不锁会员一行，
//     与手动发券一样）→ 写发券记录（种类「批量发券」，去重键 campaign:<单>:m<会员>）、会员端提醒、短信待发；
//     名单里的人逐位记「已发」「跳过（原因）」。请求里发完；中途断了，每分钟的自动任务把没发完的接着发，同一个人不会发两次；
//   · 跳过：会员停用、合并了，档级不在模板限定的档级里，模板停用、过期了。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import {
  CAMPAIGN_CHUNK,
  DEFAULT_REMIND_DAYS,
  gradesText,
  ISSUED_NOTICE_DAYS,
  MAX_CAMPAIGN_MEMBERS,
  MAX_REMIND_DAYS,
  smsContent,
  type CampaignAudience,
  type CampaignPreview,
  type CouponCampaign,
  type CouponCampaignDetail,
  type SmsStatus,
} from '@shared/coupon-campaigns';
import { MAX_MANUAL_COUPONS } from '@shared/coupons';
import { shiftDate } from '@shared/labels';
import { tagLabel } from '@shared/member-tags';
import { gradeLabel, MAX_GRADE } from '@shared/membership';
import { guard } from '../auth/guard';
import { isUniqueViolation, type Db } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { listTemplates, lockTemplate, validRange, writeIssue, type LockedTemplate } from './coupons';
import { erpOpAbandoned } from './erp-ops';
import { loadMembershipRules } from './membership';
import { loadSettings } from './settings';

const AudienceInput = z.object({
  grades: z.array(z.number().int().min(0, '档级是 L0–L6').max(MAX_GRADE, '档级是 L0–L6')).max(MAX_GRADE + 1).default([]),
  tagIds: z.array(z.number().int().positive()).max(50, '一次最多选 50 个标签').default([]),
  tagMode: z.enum(['any', 'all']).default('any'),
});
const PreviewInput = z.object({ templateId: z.number('请选择券').int().positive('请选择券'), audience: AudienceInput });
const CreateInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  templateId: z.number('请选择券').int().positive('请选择券'),
  quantity: z.number('张数必须是整数').int('张数必须是整数').min(1, '至少 1 张').max(MAX_MANUAL_COUPONS, `每人最多 ${MAX_MANUAL_COUPONS} 张`),
  audience: AudienceInput,
  reason: z.string('请填写发券原因').trim().min(2, '请填写发券原因（至少 2 个字）').max(200, '原因最多 200 字'),
  notifySms: z.boolean('请选择是否发短信'),
  notifyPopup: z.boolean('请选择是否在会员端弹窗'),
  remindDays: z.number().int().min(1, '到期前至少 1 天').max(MAX_REMIND_DAYS, `到期前最多 ${MAX_REMIND_DAYS} 天`).default(DEFAULT_REMIND_DAYS),
});

const normalizeAudience = (a: z.infer<typeof AudienceInput>): CampaignAudience => ({
  grades: [...new Set(a.grades)].sort((x, y) => x - y),
  tagIds: [...new Set(a.tagIds)].sort((x, y) => x - y),
  tagMode: a.tagMode,
});

async function todayOf(db: Db, deps: Pick<Deps, 'config'>, at = new Date()) {
  return businessDateOf(at, deps.config.timezone, (await loadSettings(db)).businessDayStartHour);
}

/** 圈到的会员（在用的：没停用、没合并），按 id 升序 */
async function audienceMembers(db: Db, a: CampaignAudience): Promise<{ id: number; grade: number }[]> {
  const need = a.tagMode === 'all' ? a.tagIds.length : 1;
  const rows = await db<{ id: number; grade: number }[]>`
    SELECT m.id, m.grade FROM members m
    WHERE m.status = 'active' AND m.merged_into_id IS NULL
      AND (${a.grades.length === 0} OR m.grade IN ${db(a.grades.length ? a.grades : [-1])})
      AND (${a.tagIds.length === 0} OR (
        SELECT count(DISTINCT l.tag_id) FROM member_tag_links l WHERE l.member_id = m.id AND l.tag_id IN ${db(a.tagIds.length ? a.tagIds : [0])}) >= ${need})
    ORDER BY m.id`;
  return rows.map((r) => ({ id: Number(r.id), grade: r.grade }));
}

const levelOk = (t: Pick<LockedTemplate, 'levels'>, grade: number) => t.levels.length === 0 || t.levels.includes(grade);

export async function previewCampaign(deps: Pick<Deps, 'sql' | 'config'>, raw: unknown): Promise<CampaignPreview> {
  const input = parse(PreviewInput, raw);
  const { sql } = deps;
  const [t] = await sql<{ levels: number[] }[]>`SELECT levels FROM coupon_templates WHERE id = ${input.templateId}`;
  if (!t) throw notFound('券模板不存在');
  const template = (await lockTemplateReadOnly(sql, input.templateId))!;
  const members = await audienceMembers(sql, normalizeAudience(input.audience));
  const date = await todayOf(sql, deps);
  const rules = await loadMembershipRules(sql);
  const sampleIds = members.slice(0, 20).map((m) => m.id);
  const sample = sampleIds.length
    ? await sql<{ id: number; memberNo: string; name: string; grade: number; tier: number | null }[]>`
        SELECT id, member_no, name, grade, tier FROM members WHERE id IN ${sql(sampleIds)} ORDER BY id`
    : [];
  return {
    count: members.length,
    outOfLevel: members.filter((m) => !levelOk(template, m.grade)).length,
    sample: sample.map((m) => ({ id: Number(m.id), memberNo: m.memberNo, name: m.name, gradeLabel: gradeLabel(rules, m.grade, m.tier) })),
    validTo: validRange(template, date)?.to ?? null,
    tooMany: members.length > MAX_CAMPAIGN_MEMBERS,
  };
}

/** 只读读模板（预览用，不加锁） */
async function lockTemplateReadOnly(db: Db, id: number): Promise<LockedTemplate | null> {
  const [t] = await db<(LockedTemplate & { levels: number[] })[]>`
    SELECT id, name, kind, face_value, rate_percent, max_off, threshold, scope, scope_categories, scope_items, exchange_item_id, exchange_ticket_type_id,
           buy_item_id, validity, valid_from, valid_to, valid_days, levels, active
    FROM coupon_templates WHERE id = ${id}`;
  return t ? { ...t, levels: t.levels.map(Number) } : null;
}

interface CampaignRow {
  id: number;
  clientKey: string;
  templateId: number;
  quantity: number;
  audience: CampaignAudience & { tagNames: string[] };
  reason: string;
  notifySms: boolean;
  notifyPopup: boolean;
  remindDays: number | null;
}

/** 同一操作编号已有发券单：同一笔返回它，不同的拒绝 */
async function replayCampaign(db: Db, input: z.infer<typeof CreateInput>, audience: CampaignAudience): Promise<number | null> {
  const [c] = await db<CampaignRow[]>`
    SELECT id, client_key, template_id, quantity, audience, reason, notify_sms, notify_popup, remind_days FROM coupon_campaigns WHERE client_key = ${input.clientKey}`;
  if (!c) return null;
  const same =
    Number(c.templateId) === input.templateId &&
    c.quantity === input.quantity &&
    c.reason === input.reason &&
    c.notifySms === input.notifySms &&
    c.notifyPopup === input.notifyPopup &&
    (c.remindDays ?? null) === (input.notifyPopup ? input.remindDays : null) &&
    JSON.stringify([c.audience.grades, c.audience.tagIds, c.audience.tagMode]) === JSON.stringify([audience.grades, audience.tagIds, audience.tagMode]);
  if (!same) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次批量发券，请刷新页面后重新发起');
  return Number(c.id);
}

export async function createCampaign(deps: Deps, raw: unknown, ctx: OpContext): Promise<{ campaign: CouponCampaignDetail; replayed: boolean }> {
  const input = parse(CreateInput, raw);
  const audience = normalizeAudience(input.audience);
  const { sql } = deps;
  let id = await replayCampaign(sql, input, audience);
  let replayed = id !== null;
  if (id === null) {
    try {
      const made = await sql.begin(async (tx) => {
        await setTxTimeouts(tx);
        await assertNotFenced(tx, input.clientKey, 'coupon_campaign', erpOpAbandoned);
        const again = await replayCampaign(tx, input, audience);
        if (again !== null) return { id: again, replayed: true };
        const template = await lockTemplate(tx, input.templateId);
        if (!template) throw notFound('券模板不存在');
        if (!template.active) throw unprocessable('TEMPLATE_INACTIVE', `券「${template.name}」已停用，不能再发`);
        const at = ctx.at ?? new Date();
        const date = await todayOf(tx, deps, at);
        if (!validRange(template, date)) throw unprocessable('TEMPLATE_EXPIRED', `券模板「${template.name}」的有效期到 ${template.validTo} 已经过了，不能再发；请另建模板`);
        const members = await audienceMembers(tx, audience);
        if (members.length === 0) throw unprocessable('NO_MEMBERS', '按这个条件圈到的会员是 0 位，请换个条件');
        if (members.length > MAX_CAMPAIGN_MEMBERS) {
          throw unprocessable('TOO_MANY_MEMBERS', `圈到 ${members.length} 位，一次最多发 ${MAX_CAMPAIGN_MEMBERS} 位；请缩小范围、分几次发`, { count: members.length });
        }
        const tagNames = audience.tagIds.length
          ? (await tx<{ groupName: string; name: string }[]>`SELECT group_name, name FROM member_tags WHERE id IN ${tx(audience.tagIds)} ORDER BY id`).map(tagLabel)
          : [];
        const no = await nextDocNo(tx, 'coupon_campaign', 'PF', date);
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO coupon_campaigns (campaign_no, template_id, quantity, audience, reason, notify_sms, notify_popup, remind_days,
                                        status, targeted, client_key, created_by, created_at, business_date)
          VALUES (${no}, ${template.id}, ${input.quantity}, ${tx.json({ ...audience, tagNames } as never)}, ${input.reason}, ${input.notifySms}, ${input.notifyPopup},
                  ${input.notifyPopup ? input.remindDays : null}, 'issuing', ${members.length}, ${input.clientKey}, ${ctx.actor.id}, ${at}, ${date})
          RETURNING id`;
        await tx`
          INSERT INTO coupon_campaign_members (campaign_id, member_id)
          SELECT ${row!.id}, unnest(${members.map((m) => m.id)}::bigint[])`;
        await writeAudit(tx, {
          staffId: ctx.actor.id,
          action: 'coupon_campaign_created',
          targetType: 'coupon_campaign',
          targetId: row!.id,
          detail: { campaignNo: no, template: template.name, quantity: input.quantity, targeted: members.length, grades: audience.grades, tags: tagNames, sms: input.notifySms, popup: input.notifyPopup, reason: input.reason },
          ip: ctx.ip,
          businessDate: date,
        });
        return { id: Number(row!.id), replayed: false };
      });
      id = made.id;
      replayed = made.replayed;
    } catch (error) {
      // 同一编号并发提交：后到的撞上唯一约束，查回第一次的
      if (!isUniqueViolation(error, 'coupon_campaigns_client_key_key')) throw error;
      id = await replayCampaign(sql, input, audience);
      if (id === null) throw error;
      replayed = true;
    }
  }
  // 当场发完（重提的也接着发没发完的）；中途断了每分钟的自动任务接着发
  await processCampaign(deps, id);
  return { campaign: await getCampaign(sql, id), replayed };
}

/** 发一张发券单里还没发的（每批一个事务）；发完记「已发完」。返回这一次发出的人数 */
export async function processCampaign(deps: Pick<Deps, 'sql' | 'config'>, id: number): Promise<number> {
  const { sql } = deps;
  let issuedNow = 0;
  for (;;) {
    const step = await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [c] = await tx<(CampaignRow & { campaignNo: string; status: string; createdBy: number })[]>`
        SELECT id, campaign_no, template_id, quantity, reason, notify_sms, notify_popup, remind_days, status, created_by
        FROM coupon_campaigns WHERE id = ${id} FOR UPDATE`;
      if (!c || c.status === 'done') return { done: true, issued: 0 };
      const pending = await tx<{ memberId: number }[]>`
        SELECT member_id FROM coupon_campaign_members WHERE campaign_id = ${id} AND status = 'pending' ORDER BY member_id LIMIT ${CAMPAIGN_CHUNK}`;
      if (!pending.length) {
        await tx`UPDATE coupon_campaigns SET status = 'done', finished_at = now() WHERE id = ${id}`;
        const [n] = await tx<{ issued: number; skipped: number }[]>`
          SELECT count(*) FILTER (WHERE status = 'issued')::int AS issued, count(*) FILTER (WHERE status = 'skipped')::int AS skipped
          FROM coupon_campaign_members WHERE campaign_id = ${id}`;
        await writeAudit(tx, { staffId: null, action: 'coupon_campaign_finished', targetType: 'coupon_campaign', targetId: id, detail: { campaignNo: c.campaignNo, ...n } });
        return { done: true, issued: 0 };
      }
      const at = new Date();
      const date = await todayOf(tx, deps, at);
      const template = await lockTemplate(tx, Number(c.templateId));
      const range = template?.active ? validRange(template, date) : null;
      const settings = await loadSettings(tx);
      const ids = pending.map((p) => Number(p.memberId));
      const members = new Map(
        (await tx<{ id: number; phone: string; status: string; grade: number; mergedIntoId: number | null }[]>`
          SELECT id, phone, status, grade, merged_into_id FROM members WHERE id IN ${tx(ids)}`).map((m) => [Number(m.id), m]),
      );
      let issued = 0;
      for (const memberId of ids) {
        const m = members.get(memberId)!;
        const skip = !template?.active
          ? '券模板已停用'
          : !range
            ? '券模板的有效期已过'
            : m.mergedIntoId !== null
              ? '会员已合并到另一位'
              : m.status !== 'active'
                ? '会员已停用'
                : !levelOk(template, m.grade)
                  ? `档级 L${m.grade} 不在这张券限定的 ${template.levels.map((l) => `L${l}`).join('、')} 里`
                  : null;
        if (skip) {
          await tx`UPDATE coupon_campaign_members SET status = 'skipped', skip_reason = ${skip} WHERE campaign_id = ${id} AND member_id = ${memberId}`;
          continue;
        }
        const dedupeKey = `campaign:${id}:m${memberId}`;
        const done = await writeIssue(tx, {
          kind: 'campaign',
          template: template!,
          memberId,
          quantity: c.quantity,
          reason: c.reason,
          dedupeKey,
          staffId: c.createdBy,
          at,
          date,
          campaignId: id,
        });
        // 去重键已有（之前那次发到一半断了、这位已经写过）：取那条发券记录，提醒、短信当时已经一起写了
        const issueId = done ? done.issueId : Number((await tx<{ id: number }[]>`SELECT id FROM coupon_issues WHERE dedupe_key = ${dedupeKey}`)[0]!.id);
        await tx`UPDATE coupon_campaign_members SET status = 'issued', issue_id = ${issueId} WHERE campaign_id = ${id} AND member_id = ${memberId}`;
        issued += 1;
        if (!done) continue;
        if (c.notifyPopup) {
          const until = shiftDate(date, ISSUED_NOTICE_DAYS - 1) < range!.to ? shiftDate(date, ISSUED_NOTICE_DAYS - 1) : range!.to;
          await tx`
            INSERT INTO member_notices (member_id, kind, title, body, campaign_id, issue_id, show_from, show_until, dedupe_key)
            VALUES (${memberId}, 'coupon_issued', ${`收到 ${c.quantity} 张券`}, ${`「${template!.name}」×${c.quantity}，有效期至 ${range!.to}。到店出示会员码即可使用。`},
                    ${id}, ${issueId}, ${date}, ${until < date ? date : until}, ${`${dedupeKey}:issued`})
            ON CONFLICT (dedupe_key) DO NOTHING`;
          // 到期前 N 天再提醒一次（有效期比 N 天短的，到账那条就够了）
          const remindFrom = shiftDate(range!.to, -(c.remindDays ?? DEFAULT_REMIND_DAYS));
          if (remindFrom > date) {
            await tx`
              INSERT INTO member_notices (member_id, kind, title, body, campaign_id, issue_id, show_from, show_until, dedupe_key)
              VALUES (${memberId}, 'coupon_expiring', ${'券快到期了'}, ${`「${template!.name}」${range!.to} 到期，还没用的别忘了到店用。`},
                      ${id}, ${issueId}, ${remindFrom}, ${range!.to}, ${`${dedupeKey}:expiring`})
              ON CONFLICT (dedupe_key) DO NOTHING`;
          }
        }
        if (c.notifySms && /^1\d{10}$/.test(m.phone)) {
          await tx`
            INSERT INTO sms_outbox (member_id, phone, purpose, params, content, campaign_id, dedupe_key)
            VALUES (${memberId}, ${m.phone}, 'coupon_issued', ${tx.json({ count: String(c.quantity), coupon: template!.name, validTo: range!.to })},
                    ${smsContent(settings.storeName, c.quantity, template!.name, range!.to)}, ${id}, ${`${dedupeKey}:sms`})
            ON CONFLICT (dedupe_key) DO NOTHING`;
        }
      }
      return { done: false, issued };
    });
    issuedNow += step.issued;
    if (step.done) return issuedNow;
  }
}

/** 每分钟：之前没发完的发券单接着发（请求断了、进程重启） */
export async function resumeCampaigns(deps: Pick<Deps, 'sql' | 'config'>): Promise<number> {
  const rows = await deps.sql<{ id: number }[]>`
    SELECT id FROM coupon_campaigns WHERE status = 'issuing' AND created_at < now() - interval '1 minute' ORDER BY id LIMIT 20`;
  let n = 0;
  for (const r of rows) n += await processCampaign(deps, Number(r.id));
  return n;
}

// ───────────────────────── 查看 ─────────────────────────

const CAMPAIGN_SELECT = (db: Db) => db`
  SELECT c.id, c.campaign_no, c.template_id, t.name AS template_name, c.quantity, c.audience, c.reason, c.notify_sms, c.notify_popup, c.remind_days,
         c.status, c.targeted, c.business_date::text AS business_date, c.created_at, s.display_name AS created_by_name, c.finished_at,
         (SELECT count(*) FILTER (WHERE m.status = 'issued') FROM coupon_campaign_members m WHERE m.campaign_id = c.id)::int AS issued,
         (SELECT count(*) FILTER (WHERE m.status = 'skipped') FROM coupon_campaign_members m WHERE m.campaign_id = c.id)::int AS skipped,
         (SELECT count(*) FILTER (WHERE m.status = 'pending') FROM coupon_campaign_members m WHERE m.campaign_id = c.id)::int AS pending,
         (SELECT coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) FROM (SELECT o.status, count(*)::int AS n FROM sms_outbox o WHERE o.campaign_id = c.id GROUP BY o.status) x) AS sms,
         (SELECT count(*) FROM member_notices n WHERE n.campaign_id = c.id)::int AS notice_total,
         (SELECT count(*) FROM member_notices n WHERE n.campaign_id = c.id AND n.read_at IS NOT NULL)::int AS notice_read
  FROM coupon_campaigns c JOIN coupon_templates t ON t.id = c.template_id JOIN staff s ON s.id = c.created_by`;

type CampaignDbRow = Omit<CouponCampaign, 'sms' | 'notices' | 'audienceText' | 'templateSummary'> & {
  sms: Partial<Record<SmsStatus, number>>;
  noticeTotal: number;
  noticeRead: number;
};

function toCampaign(r: CampaignDbRow, summaries: Map<number, string>): CouponCampaign {
  const { noticeTotal, noticeRead, ...rest } = r;
  const a = r.audience;
  const tags = a.tagNames?.length ? ` · 标签：${a.tagNames.join('、')}${a.tagNames.length > 1 ? `（${a.tagMode === 'all' ? '同时都有' : '有其中一个'}）` : ''}` : '';
  return {
    ...rest,
    id: Number(r.id),
    templateId: Number(r.templateId),
    templateSummary: summaries.get(Number(r.templateId)) ?? '',
    audienceText: `${gradesText(a.grades)}${tags}`,
    sms: { pending: 0, sent: 0, failed: 0, cancelled: 0, ...r.sms },
    notices: { total: noticeTotal, read: noticeRead },
    createdAt: new Date(r.createdAt).toISOString(),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
  };
}

async function templateSummaries(db: Db): Promise<Map<number, string>> {
  return new Map((await listTemplates(db)).map((t) => [t.id, t.summary]));
}

export async function listCampaigns(db: Db): Promise<CouponCampaign[]> {
  const rows = await db<CampaignDbRow[]>`${CAMPAIGN_SELECT(db)} ORDER BY c.id DESC LIMIT 100`;
  const summaries = await templateSummaries(db);
  return rows.map((r) => toCampaign(r, summaries));
}

export async function getCampaign(db: Db, id: number, smsProvider: string | null = null): Promise<CouponCampaignDetail> {
  const [r] = await db<CampaignDbRow[]>`${CAMPAIGN_SELECT(db)} WHERE c.id = ${id}`;
  if (!r) throw notFound('发券单不存在');
  const skippedMembers = await db<{ memberId: number; memberNo: string; name: string; reason: string }[]>`
    SELECT m.member_id, mb.member_no, mb.name, m.skip_reason AS reason FROM coupon_campaign_members m JOIN members mb ON mb.id = m.member_id
    WHERE m.campaign_id = ${id} AND m.status = 'skipped' ORDER BY m.member_id LIMIT 500`;
  return { ...toCampaign(r, await templateSummaries(db)), skippedMembers: skippedMembers.map((s) => ({ ...s, memberId: Number(s.memberId) })), smsProvider };
}

export function registerCampaignRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.post('/api/coupons/campaigns/preview', { preHandler: guard('coupon.manage') }, async (req) => previewCampaign(deps, req.body));
  app.post('/api/coupons/campaigns', { preHandler: guard('coupon.manage') }, async (req, reply) => {
    const { campaign, replayed } = await createCampaign(deps, req.body, ctxOf(req));
    reply.code(replayed ? 200 : 201);
    return { ...campaign, smsProvider: deps.config.sms.provider, replayed };
  });
  app.get('/api/coupons/campaigns', { preHandler: guard('coupon.manage') }, async () => listCampaigns(sql));
  app.get('/api/coupons/campaigns/:id', { preHandler: guard('coupon.manage') }, async (req) => getCampaign(sql, parse(idParam, req.params).id, deps.config.sms.provider));
  // 待发、发送失败的短信导出来手动发（没配短信通道时）；导出留审计
  app.get('/api/coupons/campaigns/:id/sms.csv', { preHandler: guard('coupon.manage') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const c = await getCampaign(sql, id);
    const rows = await sql<{ phone: string; name: string; memberNo: string; content: string; status: SmsStatus; lastError: string | null }[]>`
      SELECT o.phone, m.name, m.member_no, o.content, o.status, o.last_error
      FROM sms_outbox o LEFT JOIN members m ON m.id = o.member_id
      WHERE o.campaign_id = ${id} AND o.status IN ('pending', 'failed') ORDER BY o.id`;
    await writeAudit(sql, { staffId: req.actor.id, action: 'sms_outbox_exported', targetType: 'coupon_campaign', targetId: id, detail: { campaignNo: c.campaignNo, count: rows.length }, ip: req.ip });
    const STATUS: Record<SmsStatus, string> = { pending: '待发', sent: '已发', failed: '发送失败', cancelled: '已取消' };
    return csvReply(
      reply,
      `${c.campaignNo}-待发短信.csv`,
      toCsv([['手机号', '姓名', '会员号', '短信内容', '状态', '失败原因'], ...rows.map((r) => [r.phone, r.name, r.memberNo, r.content, STATUS[r.status], r.lastError ?? ''])]),
    );
  });
}
