// 小程序第三期 3a：到期提醒（小程序线，docs/MP_PHASE3.md 第 1 节；MP28、MP29）。
//   · 设置（settings 的 mp_reminder_rules，带版本号）：开关、三种模板（模板编号、每个字段填什么），后台「微信小程序 → 到期提醒」
//     维护（权限 mp.reminder）；没填模板的那种提醒，小程序里不出现「提醒我」；
//   · 顾客：能设哪几种提醒、已经设了哪些（reminderOptions）；设一条提醒（consentReminder，顾客在微信的弹窗里同意以后）。
//     设提醒在一个事务里：这个微信的咨询锁（mp_reminder:<openid>）→ 绑定状态的共享锁（解绑拿排他的）→ 核对绑定版本号 →
//     同一个编号 → 核对模板与要提醒的东西 → 写同意。结果不确定时小程序原样重提（同一个编号返回同一条），不用确认作废：
//     晚到生效也是顾客自己要的提醒；
//   · 每分钟（planReminders）：到了那天、北京时间 10:00–20:00 之间，把到点的同意排成消息，消息的字段按那时的情况算；
//     那时已经不用提醒的（券用掉了、会籍续上了、解绑了）记「不发」与原因；网关取走以后过了期限没回报的记「结果不明」，
//     不再发第二次（一次同意只能发一条）；
//   · 网关（leaseReminders / reportReminders，只认网关密钥）：每 30 秒取一批排队的消息去发、发完回报。取的时候再核对一次
//     绑定与券。门店系统不连网关，门店断网时消息在门店等着，连上再发。
// 只读券、会员档阶（主线的 memberGradeInfo）与赠金批次，主线不用改。

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  MP_REMINDER_FIELD_KEY,
  MP_REMINDER_FIELDS_MAX,
  MP_REMINDER_LEAD_DAYS,
  MP_REMINDER_RULES_KEY,
  MP_REMINDER_SEND_HOURS,
  MP_REMINDER_SOURCES,
  MP_REMINDER_TEMPLATE_ID,
  MP_REMINDER_TEMPLATE_KINDS,
  mpReminderTemplateKind,
  type MpReminderAdminData,
  type MpReminderConsented,
  type MpReminderKind,
  type MpReminderLease,
  type MpReminderLeased,
  type MpReminderMessageAdmin,
  type MpReminderOptions,
  type MpReminderRules,
  type MpReminderSet,
  type MpReminderSource,
  type MpReminderStatus,
  type MpReminderTemplate,
  type MpReminderTemplateKind,
} from '@shared/mp';
import { businessDateOf, lastUsableDate } from '@shared/business-date';
import { shiftDate } from '@shared/labels';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import type { Deps, OpContext } from '../../lib/context';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { memberGradeInfo } from '../membership';
import { loadSettings } from '../settings';
import { bindingStateOf, lockOpenidShared } from './member';
import { loadMpRules, loadReminderRules } from './rules';

// ───────────────────────── 时间 ─────────────────────────

/** 北京时间的日期与钟点（发提醒按钟点：10:00–20:00，MP29） */
export function clockIn(at: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

const inSendHours = (hour: number) => hour >= MP_REMINDER_SEND_HOURS.from && hour < MP_REMINDER_SEND_HOURS.to;
const maxDate = (a: string, b: string) => (a > b ? a : b);

/** 「2026年11月20日」 */
function cnDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}
const yuanText = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

// ───────────────────────── 要提醒的东西 ─────────────────────────

/**
 * 这位会员还有剩、没作废的赠金，按最后能用的那个营业日分：赠金在到期那天营业日开始时作废，
 * 最后能用的是前一个营业日（与券的有效期到、会籍周期的最后一天同一个口径，给顾客看的都是这一天）
 */
async function bonusByLastDay(db: Db, memberId: number, timeZone: string, startHour: number, at: Date): Promise<Map<string, number>> {
  const lots = await db<{ remaining: number; expiresAt: string }[]>`
    SELECT remaining, expires_at FROM bonus_lots WHERE member_id = ${memberId} AND remaining > 0 AND expires_at IS NOT NULL AND expires_at > ${at}`;
  const by = new Map<string, number>();
  for (const l of lots) {
    const day = lastUsableDate(l.expiresAt, timeZone, startHour);
    by.set(day, (by.get(day) ?? 0) + Number(l.remaining));
  }
  return by;
}

/** 最早到期的那一天（最后能用的营业日）与那一天到期的赠金 */
async function earliestBonus(db: Db, memberId: number, timeZone: string, startHour: number, at: Date): Promise<{ amount: number; lastDay: string } | null> {
  const by = await bonusByLastDay(db, memberId, timeZone, startHour, at);
  const day = [...by.keys()].sort()[0];
  return day === undefined ? null : { amount: by.get(day)!, lastDay: day };
}

/** 保级还差多少储值消费（会员体系 v2：周期净储值消费到本档门槛的 60% 保级；补充期内从原周期第一天累计） */
const keepGap = (info: Awaited<ReturnType<typeof memberGradeInfo>>) => (info.targets ? Math.max(0, info.targets.honor - info.cycleSpendCents) : 0);

// ───────────────────────── 设置 ─────────────────────────

/** 每种模板能填的：券没有金额 */
const SOURCES_OF: Record<MpReminderTemplateKind, MpReminderSource[]> = {
  coupon: ['name', 'date', 'tip', 'store'],
  membership: MP_REMINDER_SOURCES,
  bonus: MP_REMINDER_SOURCES,
};

const TemplateInput = z
  .object({
    templateId: z.string().trim().regex(MP_REMINDER_TEMPLATE_ID, '模板编号不对：从微信公众平台「订阅消息 → 我的模板」复制'),
    fields: z
      .array(
        z.object({
          key: z.string().trim().regex(MP_REMINDER_FIELD_KEY, '字段名不对：照模板详情里的写，比如 thing1、date2'),
          source: z.enum(MP_REMINDER_SOURCES as [MpReminderSource, ...MpReminderSource[]], '请选择这个字段填什么'),
        }),
      )
      .min(1, '至少填一个字段')
      .max(MP_REMINDER_FIELDS_MAX, `最多 ${MP_REMINDER_FIELDS_MAX} 个字段`),
  })
  .nullable();

const RulesInput = z.object({
  enabled: z.boolean(),
  coupon: TemplateInput,
  membership: TemplateInput,
  bonus: TemplateInput,
  /** 打开时看到的版本号；不带的不核对（只给脚本用） */
  version: z.number().int().min(0).optional(),
});

export async function saveReminderRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<MpReminderRules> {
  const input = parse(RulesInput, raw);
  const ids: string[] = [];
  for (const kind of MP_REMINDER_TEMPLATE_KINDS) {
    const t = input[kind];
    if (!t) continue;
    ids.push(t.templateId);
    const keys = t.fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) throw badRequest('同一个字段名只能填一次');
    const bad = t.fields.find((f) => !SOURCES_OF[kind].includes(f.source));
    if (bad) throw badRequest(`${KIND_LABELS[kind]}的模板里，${bad.key} 不能填「${SOURCE_LABELS[bad.source]}」`);
  }
  if (new Set(ids).size !== ids.length) throw badRequest('三种提醒要用三个不同的模板');
  return saveRuleSetting(
    deps.sql,
    MP_REMINDER_RULES_KEY,
    loadReminderRules,
    async (before) => {
      if (input.version !== undefined && input.version !== before.version) throw conflict('VERSION_CONFLICT', '到期提醒的设置刚被别人改过，请刷新后再改');
      // 内容没变也加一：后台「放弃这次修改」靠它让原来那次请求的版本号对不上
      return { enabled: input.enabled, coupon: input.coupon, membership: input.membership, bonus: input.bonus, version: before.version + 1 };
    },
    ctx,
  );
}

const KIND_LABELS: Record<MpReminderTemplateKind, string> = { coupon: '券快到期', membership: '会籍快到期', bonus: '赠金快到期' };
const SOURCE_LABELS: Record<MpReminderSource, string> = { name: '名称', date: '到期日', amount: '金额', tip: '提示', store: '门店名' };

// ───────────────────────── 顾客：能设哪些、设一条 ─────────────────────────

interface ConsentRow {
  id: number;
  clientKey: string;
  openid: string;
  bindingId: number;
  memberId: number;
  kind: MpReminderKind;
  couponId: number | null;
  targetDate: string;
  templateId: string;
  dueDate: string;
  createdAt: string;
}

const consentView = (c: ConsentRow, replayed: boolean): MpReminderConsented => ({
  consentId: Number(c.id),
  kind: c.kind,
  targetDate: c.targetDate,
  dueDate: c.dueDate,
  replayed,
});

export async function reminderOptions(deps: Deps, openid: string): Promise<MpReminderOptions> {
  const tz = deps.config.timezone;
  const [rules, state] = await Promise.all([loadReminderRules(deps.sql), bindingStateOf(deps.sql, openid)]);
  const base = {
    bindVersion: state.version,
    leadDays: MP_REMINDER_LEAD_DAYS,
    sendHours: { from: MP_REMINDER_SEND_HOURS.from, to: MP_REMINDER_SEND_HOURS.to },
  };
  const none = { coupon: null, membership: null, bonus: null };
  if (!rules.enabled || !state.binding) return { open: false, ...base, templates: none, set: [], membership: null, bonus: null };
  const { id: bindingId, memberId } = state.binding;
  const [m] = await deps.sql<{ status: string; mergedIntoId: number | null }[]>`SELECT status, merged_into_id FROM members WHERE id = ${memberId}`;
  if (!m || m.status !== 'active' || m.mergedIntoId !== null) return { open: false, ...base, templates: none, set: [], membership: null, bonus: null };
  const { businessDayStartHour } = await loadSettings(deps.sql);
  const now = new Date();
  const today = businessDateOf(now, tz, businessDayStartHour);
  const [info, bonus, rows] = await Promise.all([
    memberGradeInfo(deps.sql, memberId, today),
    earliestBonus(deps.sql, memberId, tz, businessDayStartHour, now),
    deps.sql<{ kind: MpReminderKind; couponCode: string | null; targetDate: string; dueDate: string; templateId: string; status: MpReminderStatus | null }[]>`
      SELECT c.kind, cp.code AS coupon_code, c.target_date::text AS target_date, c.due_date::text AS due_date, c.template_id, msg.status
      FROM mp_reminder_consents c
      LEFT JOIN coupons cp ON cp.id = c.coupon_id
      LEFT JOIN mp_reminder_messages msg ON msg.consent_id = c.id
      WHERE c.binding_id = ${bindingId} AND c.target_date >= ${shiftDate(today, -1)}
      ORDER BY c.id DESC LIMIT 200`,
  ]);
  // 店主换了模板的：按旧模板同意的不会再发（排期时记不发），算「不用发了」，小程序里可以按新的模板再设
  const current = (k: MpReminderKind) => rules[mpReminderTemplateKind(k)]?.templateId ?? null;
  const set: MpReminderSet[] = rows.map((r) => ({
    kind: r.kind,
    couponCode: r.couponCode,
    targetDate: r.targetDate,
    dueDate: r.dueDate,
    state:
      r.status === 'sent'
        ? 'sent'
        : (r.status === null || r.status === 'queued' || r.status === 'leased') && r.templateId === current(r.kind)
          ? 'waiting'
          : 'done',
  }));
  return {
    open: true,
    ...base,
    templates: { coupon: rules.coupon?.templateId ?? null, membership: rules.membership?.templateId ?? null, bonus: rules.bonus?.templateId ?? null },
    set,
    membership: info.state.grade > 0 ? { cycleEnd: info.state.cycleEnd, inGrace: info.inGrace, label: info.label } : null,
    bonus,
  };
}

const ConsentInput = z
  .object({
    clientKey: z.uuid('操作编号不正确'),
    kind: z.enum(['coupon', 'membership', 'grace', 'bonus'], '提醒的种类不对'),
    couponCode: z.string().trim().regex(/^[2-9A-HJ-NP-Z]{12}$/, '券码不对').optional(),
    targetDate: z.iso.date('到期日不对').optional(),
    templateId: z.string().regex(MP_REMINDER_TEMPLATE_ID, '模板编号不对'),
    bindVersion: z.number('请刷新后再设提醒').int().min(0),
  })
  .refine((v) => (v.kind === 'coupon' ? v.couponCode !== undefined : v.targetDate !== undefined), { message: '要提醒哪一样没说清，请刷新后再点' });

/** 设一条提醒的咨询锁：同一个微信的设提醒串行（同一个编号同时重提只记一条） */
const lockReminderOpenid = (tx: Tx, openid: string) => tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_reminder:${openid}`}))`;

const gone = (message: string) => unprocessable('REMINDER_TARGET_GONE', message);
const changed = () => conflict('REMINDER_TARGET_CHANGED', '到期日刚变过，请刷新后再点');

/** 要提醒的东西此刻还在、到期日与页面上的一样：哪天到期、哪天发 */
async function resolveTarget(
  tx: Tx,
  deps: Deps,
  memberId: number,
  input: z.infer<typeof ConsentInput>,
  today: string,
  startHour: number,
): Promise<{ couponId: number | null; targetDate: string; dueDate: string }> {
  const tz = deps.config.timezone;
  if (input.kind === 'coupon') {
    const [c] = await tx<{ id: number; memberId: number | null; validTo: string; status: string }[]>`
      SELECT id, member_id, valid_to::text AS valid_to, status FROM coupons WHERE code = ${input.couponCode!}`;
    if (!c || Number(c.memberId) !== memberId) throw notFound('这张券不在你的会员卡上');
    if (c.status !== 'available') throw gone(c.status === 'used' ? '这张券已经用过了，不用提醒' : '这张券已经作废了，不用提醒');
    if (c.validTo < today) throw gone('这张券已经过期了');
    return { couponId: Number(c.id), targetDate: c.validTo, dueDate: maxDate(today, shiftDate(c.validTo, -MP_REMINDER_LEAD_DAYS.coupon)) };
  }
  if (input.kind === 'bonus') {
    const b = await earliestBonus(tx, memberId, tz, startHour, new Date());
    if (!b) throw gone('没有会到期的赠金');
    if (b.lastDay !== input.targetDate) throw changed();
    return { couponId: null, targetDate: b.lastDay, dueDate: maxDate(today, shiftDate(b.lastDay, -MP_REMINDER_LEAD_DAYS.bonus)) };
  }
  const info = await memberGradeInfo(tx, memberId, today);
  const cycleEnd = info.state.cycleEnd;
  if (info.state.grade === 0 || !cycleEnd) throw gone('现在的档级没有到期日');
  if (info.inGrace) throw gone(input.kind === 'grace' ? '已经在补充期里了' : '会籍已经到期、在补充期里了');
  if (cycleEnd !== input.targetDate) throw changed();
  if (cycleEnd < today) throw gone('会籍已经到期了');
  return input.kind === 'membership'
    ? { couponId: null, targetDate: cycleEnd, dueDate: maxDate(today, shiftDate(cycleEnd, -MP_REMINDER_LEAD_DAYS.membership)) }
    : // 进补充期当天：周期最后一天的下一天
      { couponId: null, targetDate: cycleEnd, dueDate: shiftDate(cycleEnd, 1) };
}

export async function consentReminder(deps: Deps, openid: string, raw: unknown): Promise<MpReminderConsented> {
  const input = parse(ConsentInput, raw);
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockReminderOpenid(tx, openid);
      // 这个微信绑定状态的共享锁（解绑拿排他的）：读到的有效绑定到写入、提交之前不会被解绑
      await lockOpenidShared(tx, openid);
      const state = await bindingStateOf(tx, openid);
      if (!state.binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
      // 点「提醒我」时看到的是哪一条绑定：之后解绑、换绑过的，这是之前的请求，不记（与充值建单、领券一样）
      if (state.version !== input.bindVersion) throw conflict('BIND_STALE', '会员绑定刚变过，这次没有设提醒，请刷新后再点');
      const { id: bindingId, memberId } = state.binding;
      const [prev] = await tx<ConsentRow[]>`
        SELECT id, client_key, openid, binding_id, member_id, kind, coupon_id, target_date::text AS target_date, template_id,
               due_date::text AS due_date, created_at
        FROM mp_reminder_consents WHERE client_key = ${input.clientKey}`;
      if (prev) {
        // 同一个编号重提：只认同一条绑定、同一种提醒
        if (prev.openid !== openid || Number(prev.bindingId) !== bindingId || prev.kind !== input.kind) {
          throw conflict('CLIENT_KEY_REUSED', '这次设提醒的编号已经用过，请重新点');
        }
        return consentView(prev, true);
      }
      const rules = await loadReminderRules(tx);
      if (!rules.enabled) throw new AppError(403, 'MP_REMINDER_DISABLED', '到期提醒还没开放');
      const tpl = rules[mpReminderTemplateKind(input.kind)];
      if (!tpl) throw unprocessable('REMINDER_UNAVAILABLE', '这种提醒现在不能设');
      // 顾客同意的是页面上那个模板：店主刚换了模板的，请顾客刷新、按新的模板再同意一次
      if (tpl.templateId !== input.templateId) throw conflict('TEMPLATE_CHANGED', '提醒的设置刚改过，请刷新后再点');
      const [m] = await tx<{ status: string; mergedIntoId: number | null }[]>`SELECT status, merged_into_id FROM members WHERE id = ${memberId}`;
      if (!m) throw notFound('会员不存在');
      if (m.mergedIntoId !== null) throw unprocessable('MEMBER_MERGED', '这张会员卡已合并，请到前台换绑');
      if (m.status !== 'active') throw unprocessable('MEMBER_FROZEN', '会员卡已停用，请到前台咨询');
      // 到期都按营业日算（券的有效期、会籍周期、赠金最后能用的一天）
      const { businessDayStartHour } = await loadSettings(tx);
      const today = businessDateOf(new Date(), deps.config.timezone, businessDayStartHour);
      const target = await resolveTarget(tx, deps, memberId, input, today, businessDayStartHour);
      // 这样东西已经设过这种提醒、还在等或已发出（同一个模板）：返回原来那条，微信那边多出来的一次同意不用。
      // 之前那条没发出、不用发了、或是按换掉的模板同意的：这次同意记新的一条（第几次加一）
      const [same] = await tx<(ConsentRow & { status: MpReminderStatus | null })[]>`
        SELECT c.id, c.client_key, c.openid, c.binding_id, c.member_id, c.kind, c.coupon_id, c.target_date::text AS target_date,
               c.template_id, c.due_date::text AS due_date, c.created_at, m.status
        FROM mp_reminder_consents c LEFT JOIN mp_reminder_messages m ON m.consent_id = c.id
        WHERE c.binding_id = ${bindingId} AND c.kind = ${input.kind} AND coalesce(c.coupon_id, 0) = ${target.couponId ?? 0}
          AND c.target_date = ${target.targetDate} AND c.template_id = ${input.templateId}
          AND (m.status IS NULL OR m.status IN ('queued', 'leased', 'sent'))
        ORDER BY c.id DESC LIMIT 1`;
      if (same) return consentView(same, true);
      const [next] = await tx<{ seq: number }[]>`
        SELECT coalesce(max(seq), 0)::int + 1 AS seq FROM mp_reminder_consents
        WHERE binding_id = ${bindingId} AND kind = ${input.kind} AND coalesce(coupon_id, 0) = ${target.couponId ?? 0} AND target_date = ${target.targetDate}`;
      const [row] = await tx<ConsentRow[]>`
        INSERT INTO mp_reminder_consents (client_key, openid, binding_id, member_id, kind, coupon_id, target_date, template_id, due_date, seq)
        VALUES (${input.clientKey}, ${openid}, ${bindingId}, ${memberId}, ${input.kind}, ${target.couponId}, ${target.targetDate},
                ${input.templateId}, ${target.dueDate}, ${next!.seq})
        RETURNING id, client_key, openid, binding_id, member_id, kind, coupon_id, target_date::text AS target_date, template_id,
                  due_date::text AS due_date, created_at`;
      return consentView(row!, false);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'mp_reminder_consents_client_key_key')) throw conflict('CLIENT_KEY_REUSED', '这次设提醒的编号已经用过，请重新点');
    throw error;
  }
}

// ───────────────────────── 每分钟：排期 ─────────────────────────

interface Built {
  page: string;
  data: Record<string, { value: string }>;
  /** 过了这一天（营业日）就不用发了：网关来取时再看一次 */
  validUntil: string;
}

/**
 * 字段按微信的格式写（不合格式的微信回 47003、整条发不出去）：thing 最多 20 个字（超了用「…」）；date 写成「2026年11月20日」；
 * time 写成那一天的 23:59；amount 写成「¥12.00」；number 只有数字；phrase 5 个以内的汉字；name 10 个以内的汉字（没有汉字时
 * 20 个以内的字母）；short_thing 5 个字；character_string 32 个以内的字母、数字、符号；letter 只有字母；symbol 5 个以内的符号
 */
export function formatField(key: string, value: { text: string; date?: string; cents?: number }): string {
  const kind = MP_REMINDER_FIELD_KEY.exec(key)?.[1] ?? 'thing';
  const take = (s: string, n: number) => [...s].slice(0, n).join('');
  const zh = (s: string) => s.replace(/[^\u4e00-\u9fff]/g, '');
  switch (kind) {
    case 'date':
      return value.date ? cnDate(value.date) : take(value.text, 20);
    case 'time':
      return value.date ? `${cnDate(value.date)} 23:59` : take(value.text, 20);
    case 'amount':
      return yuanText(value.cents ?? 0);
    case 'number':
      return ((value.cents ?? 0) / 100).toFixed(2);
    case 'phrase':
      return take(zh(value.text), 5) || '提醒';
    case 'name':
      return zh(value.text) ? take(zh(value.text), 10) : take(value.text.replace(/[^A-Za-z]/g, ''), 20) || '会员';
    case 'short_thing':
      return take(value.text, 5) || '提醒';
    case 'character_string':
      return take(value.text.replace(/[^\x21-\x7e]/g, ''), 32) || '-';
    case 'letter':
      return take(value.text.replace(/[^A-Za-z]/g, ''), 32) || 'A';
    case 'symbol':
      return take(value.text.replace(/[A-Za-z0-9\s\u4e00-\u9fff]/g, ''), 5) || '-';
    default:
      return [...value.text].length > 20 ? `${take(value.text, 19)}…` : value.text;
  }
}

const PAGES: Record<MpReminderKind, string> = { coupon: 'pages/coupons/index', membership: 'pages/me/index', grace: 'pages/me/index', bonus: 'pages/ledger/index' };

/** 这条同意此刻要不要发、发什么：要发的给消息的页面与字段，不用发的给原因 */
async function buildMessage(deps: Deps, rules: MpReminderRules, c: ConsentRow, today: string, at: Date, startHour: number): Promise<Built | { skip: string }> {
  const tz = deps.config.timezone;
  const tpl: MpReminderTemplate | null = rules[mpReminderTemplateKind(c.kind)];
  if (!tpl) return { skip: '这种提醒的模板已经拿掉了' };
  if (tpl.templateId !== c.templateId) return { skip: '顾客同意时的模板已经换掉了' };
  const [b] = await deps.sql<{ active: boolean; status: string; mergedIntoId: number | null }[]>`
    SELECT b.unbound_at IS NULL AS active, m.status, m.merged_into_id
    FROM mp_bindings b JOIN members m ON m.id = b.member_id WHERE b.id = ${c.bindingId}`;
  if (!b?.active) return { skip: '微信已经解绑' };
  if (b.mergedIntoId !== null) return { skip: '会员卡已经合并' };
  if (b.status !== 'active') return { skip: '会员卡已经停用' };
  let name = '';
  let date = c.targetDate;
  let cents: number | undefined;
  let tip = '';
  if (c.kind === 'coupon') {
    const [cp] = await deps.sql<{ status: string; validTo: string; name: string }[]>`
      SELECT c.status, c.valid_to::text AS valid_to, t.name FROM coupons c JOIN coupon_templates t ON t.id = c.template_id WHERE c.id = ${c.couponId}`;
    if (!cp) return { skip: '券不存在' };
    if (cp.status === 'used') return { skip: '券已经用过' };
    if (cp.status !== 'available') return { skip: '券已经作废' };
    if (cp.validTo < today) return { skip: '券已经过期' };
    name = cp.name;
    date = cp.validTo;
    tip = '到前台结账时出示会员码就能用';
  } else if (c.kind === 'bonus') {
    // 赠金的到期日是最后能用的那个营业日
    if (c.targetDate < today) return { skip: '赠金已经到期' };
    cents = (await bonusByLastDay(deps.sql, Number(c.memberId), tz, startHour, at)).get(c.targetDate) ?? 0;
    if (cents <= 0) return { skip: '那一天到期的赠金已经用完' };
    name = '赠金';
    tip = '到期前消费会先用快到期的赠金';
  } else {
    // 按发的那天推算（到期没处理的照规则推到那天：进补充期、保级或降档）
    const info = await memberGradeInfo(deps.sql, Number(c.memberId), today);
    if (info.state.grade === 0) return { skip: '已经没有会员档级' };
    if (c.kind === 'membership') {
      if (info.inGrace || info.state.cycleEnd !== c.targetDate) return { skip: '会籍已经续上或变过' };
      if (c.targetDate < today) return { skip: '会籍已经到期' };
      cents = keepGap(info);
      tip = cents > 0 ? `再消费${yuanText(cents)}可保级` : '本期的储值消费已够保级';
    } else {
      // 进补充期当天：周期最后一天过了、进了补充期才发；保级了、降档了的不发
      if (!info.inGrace || !info.state.graceUntil) return { skip: '没有进补充期（已保级或已调整）' };
      if (info.state.graceUntil < today) return { skip: '补充期已经过了' };
      date = info.state.graceUntil;
      cents = keepGap(info);
      tip = cents > 0 ? `补充期内再消费${yuanText(cents)}可保级` : '补充期内可以保级';
    }
    name = info.label;
  }
  const store = (await loadSettings(deps.sql)).storeName;
  const value = (source: MpReminderSource) =>
    source === 'name' ? { text: name } : source === 'date' ? { text: cnDate(date), date } : source === 'amount' ? { text: '', cents: cents ?? 0 } : source === 'tip' ? { text: tip } : { text: store };
  const data: Record<string, { value: string }> = {};
  for (const f of tpl.fields) data[f.key] = { value: formatField(f.key, value(f.source)) };
  return { page: PAGES[c.kind], data, validUntil: date };
}

/**
 * 网关取走以后多久没回报算「结果不明」。一批最多 20 条，网关遇到超时、连不上就停下这一批、剩下的报「再试」，
 * 快到期限时也不再开始发，所以 5 分钟够用
 */
const LEASE_MS = 5 * 60_000;
/** 排好以后多久还没发出去就不再发 */
const STALE_MS = 48 * 3_600_000;
/** 要再试的隔多久再给网关：第 n 次没发出去以后隔 n × 5 分钟（微信忙、频率限制过一会儿才好） */
const RETRY_STEP_MS = 5 * 60_000;

/** 这一刻的营业日、北京时间的钟点、营业日几点切换 */
async function nowOf(deps: Deps, at: Date): Promise<{ today: string; hour: number; startHour: number }> {
  const { businessDayStartHour } = await loadSettings(deps.sql);
  return { today: businessDateOf(at, deps.config.timezone, businessDayStartHour), hour: clockIn(at, deps.config.timezone).hour, startHour: businessDayStartHour };
}

/**
 * 每分钟：网关取走以后过了期限没回报的记「结果不明」；到了那天、10:00–20:00 之间，把到点的同意排成消息
 * （那时已经不用提醒的记「不发」）。日子都按营业日。一条出错不挡后面的，下一分钟再排它。
 */
export async function planReminders(
  deps: Deps,
  at: Date = new Date(),
  limit = 200,
): Promise<{ queued: number; skipped: number; unknown: number; errors: number }> {
  const lost = await deps.sql`
    UPDATE mp_reminder_messages SET status = 'unknown', reason = '网关取走以后没回报：可能已经发出，不再发第二次',
      lease_token = NULL, lease_batch = NULL, leased_until = NULL, finished_at = ${at}
    WHERE status = 'leased' AND leased_until < ${at}`;
  const rules = await loadReminderRules(deps.sql);
  const { today, hour, startHour } = await nowOf(deps, at);
  if (!rules.enabled || !inSendHours(hour)) return { queued: 0, skipped: 0, unknown: lost.count, errors: 0 };
  const due = await deps.sql<ConsentRow[]>`
    SELECT c.id, c.client_key, c.openid, c.binding_id, c.member_id, c.kind, c.coupon_id, c.target_date::text AS target_date,
           c.template_id, c.due_date::text AS due_date, c.created_at
    FROM mp_reminder_consents c
    WHERE c.due_date <= ${today} AND NOT EXISTS (SELECT 1 FROM mp_reminder_messages m WHERE m.consent_id = c.id)
    ORDER BY c.due_date, c.id LIMIT ${limit}`;
  let queued = 0;
  let skipped = 0;
  let errors = 0;
  for (const c of due) {
    try {
      const built = await buildMessage(deps, rules, c, today, at, startHour);
      if ('skip' in built) {
        const r = await deps.sql`
          INSERT INTO mp_reminder_messages (consent_id, status, reason, created_at, finished_at) VALUES (${c.id}, 'skipped', ${built.skip}, ${at}, ${at})
          ON CONFLICT (consent_id) DO NOTHING`;
        skipped += r.count;
      } else {
        const r = await deps.sql`
          INSERT INTO mp_reminder_messages (consent_id, status, page, data, valid_until, created_at)
          VALUES (${c.id}, 'queued', ${built.page}, ${deps.sql.json(built.data as never)}, ${built.validUntil}, ${at})
          ON CONFLICT (consent_id) DO NOTHING`;
        queued += r.count;
      }
    } catch {
      errors += 1;
    }
  }
  return { queued, skipped, unknown: lost.count, errors };
}

// ───────────────────────── 网关：取消息、回报 ─────────────────────────

/** 网关最近一次来取消息的时间（后台看网关在不在）：只在这个进程里记，重启后等网关下一次来 */
let lastLeaseAt: Date | null = null;

const LeaseInput = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  /** 网关这一批的批次号：上一次没收到回答（门店提交了、回答路上丢了）时带着同一个号再要，门店把那一批原样再给 */
  batchId: z.uuid().optional(),
});

interface LeasedRow {
  id: number;
  leaseToken: string;
  leasedUntil: string;
  page: string;
  data: Record<string, { value: string }>;
  openid: string;
  templateId: string;
}
const toLeased = (r: Pick<LeasedRow, 'id' | 'leaseToken' | 'page' | 'data' | 'openid' | 'templateId'>): MpReminderLeased => ({
  id: Number(r.id),
  leaseToken: r.leaseToken,
  openid: r.openid,
  templateId: r.templateId,
  page: r.page,
  data: r.data,
});

/**
 * 网关取一批排队的消息（要再试的到了时间才给）。取的时候再核对一次：解绑、合并、停用的，过了到期日的，排好以后两天没发出去的，
 * 券用掉、作废的，记「不发」。10:00–20:00 以外不给。leasedUntil 是这一批的期限：网关过了它就不要再开始发
 */
export async function leaseReminders(deps: Deps, raw: unknown, at: Date = new Date()): Promise<MpReminderLease> {
  const { limit, batchId } = parse(LeaseInput, raw ?? {});
  lastLeaseAt = at;
  const [rules, mpRules, now] = await Promise.all([loadReminderRules(deps.sql), loadMpRules(deps.sql), nowOf(deps, at)]);
  if (!rules.enabled || !mpRules.enabled || !inSendHours(now.hour)) return { messages: [], leasedUntil: null };
  const batch = batchId ?? randomUUID();
  let until = new Date(at.getTime() + LEASE_MS);
  const messages: MpReminderLeased[] = [];
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    if (batchId) {
      const again = await tx<LeasedRow[]>`
        SELECT m.id, m.lease_token, m.leased_until, m.page, m.data, c.openid, c.template_id
        FROM mp_reminder_messages m JOIN mp_reminder_consents c ON c.id = m.consent_id
        WHERE m.status = 'leased' AND m.lease_batch = ${batchId} AND m.leased_until > ${at}
        ORDER BY m.id`;
      if (again.length) {
        messages.push(...again.map(toLeased));
        until = new Date(again[0]!.leasedUntil);
        return;
      }
    }
    const rows = await tx<
      {
        id: number;
        page: string;
        data: Record<string, { value: string }>;
        validUntil: string;
        createdAt: string;
        openid: string;
        templateId: string;
        kind: MpReminderKind;
        bound: boolean;
        memberStatus: string;
        mergedIntoId: number | null;
        couponStatus: string | null;
      }[]
    >`
      SELECT m.id, m.page, m.data, m.valid_until::text AS valid_until, m.created_at, c.openid, c.template_id, c.kind,
             b.unbound_at IS NULL AS bound, mb.status AS member_status, mb.merged_into_id, cp.status AS coupon_status
      FROM mp_reminder_messages m
      JOIN mp_reminder_consents c ON c.id = m.consent_id
      JOIN mp_bindings b ON b.id = c.binding_id
      JOIN members mb ON mb.id = c.member_id
      LEFT JOIN coupons cp ON cp.id = c.coupon_id
      WHERE m.status = 'queued' AND (m.retry_after IS NULL OR m.retry_after <= ${at})
      ORDER BY m.id LIMIT ${limit}
      FOR UPDATE OF m SKIP LOCKED`;
    for (const r of rows) {
      const skip = !r.bound
        ? '微信已经解绑'
        : r.mergedIntoId !== null
          ? '会员卡已经合并'
          : r.memberStatus !== 'active'
            ? '会员卡已经停用'
            : r.validUntil < now.today
              ? '已经过了到期日'
              : at.getTime() - new Date(r.createdAt).getTime() > STALE_MS
                ? '排好以后两天没发出去（网关没来取或提醒关着），不再发'
                : r.kind === 'coupon' && r.couponStatus !== 'available'
                  ? r.couponStatus === 'used'
                    ? '券已经用过'
                    : '券已经作废'
                  : null;
      if (skip) {
        await tx`UPDATE mp_reminder_messages SET status = 'skipped', reason = ${skip}, retry_after = NULL, finished_at = ${at} WHERE id = ${r.id}`;
        continue;
      }
      const token = randomUUID();
      await tx`
        UPDATE mp_reminder_messages SET status = 'leased', lease_token = ${token}, lease_batch = ${batch}, leased_until = ${until},
          retry_after = NULL, attempts = attempts + 1
        WHERE id = ${r.id}`;
      messages.push(toLeased({ ...r, leaseToken: token }));
    }
  });
  return { messages, leasedUntil: messages.length ? until.toISOString() : null };
}

const ReportInput = z.object({
  results: z
    .array(
      z.object({
        id: z.number().int().positive(),
        leaseToken: z.uuid(),
        outcome: z.enum(['sent', 'failed', 'retry', 'unknown']),
        errcode: z.number().int().nullable().optional(),
        errmsg: z.string().max(500).nullable().optional(),
      }),
    )
    .max(50),
});

/** 最多发几次（要再试的） */
const MAX_ATTEMPTS = 3;

/** 网关回报发送结果：只认这一次取走用的凭据（过了期限、已经记了「结果不明」的不再改） */
export async function reportReminders(deps: Deps, raw: unknown, at: Date = new Date()): Promise<{ accepted: number }> {
  const { results } = parse(ReportInput, raw);
  let accepted = 0;
  for (const r of results) {
    const why = (r.errmsg ?? '').slice(0, 120);
    const code = r.errcode ?? null;
    const detail = code === null ? why : `${code}${why ? ` ${why}` : ''}`;
    const q =
      r.outcome === 'sent'
        ? deps.sql`
            UPDATE mp_reminder_messages SET status = 'sent', lease_token = NULL, lease_batch = NULL, leased_until = NULL, errcode = NULL, finished_at = ${at}
            WHERE id = ${r.id} AND status = 'leased' AND lease_token = ${r.leaseToken}`
        : r.outcome === 'failed'
          ? deps.sql`
              UPDATE mp_reminder_messages SET status = 'failed', reason = ${`微信没发出：${detail || '没有说明'}`.slice(0, 200)},
                lease_token = NULL, lease_batch = NULL, leased_until = NULL, errcode = ${code}, finished_at = ${at}
              WHERE id = ${r.id} AND status = 'leased' AND lease_token = ${r.leaseToken}`
          : r.outcome === 'unknown'
            ? deps.sql`
                UPDATE mp_reminder_messages SET status = 'unknown', reason = ${`发了没收到微信的回音，不再发${detail ? `（${detail}）` : ''}`.slice(0, 200)},
                  lease_token = NULL, lease_batch = NULL, leased_until = NULL, errcode = ${code}, finished_at = ${at}
                WHERE id = ${r.id} AND status = 'leased' AND lease_token = ${r.leaseToken}`
            : // 要再试的：没到次数回到排队、隔一会儿再给网关，到了次数记没发出
              deps.sql`
                UPDATE mp_reminder_messages SET
                  status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
                  reason = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN ${`试了 ${MAX_ATTEMPTS} 次没发出：${detail || '没有说明'}`.slice(0, 200)} ELSE reason END,
                  finished_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN ${at}::timestamptz ELSE NULL END,
                  retry_after = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN NULL ELSE ${at}::timestamptz + attempts * ${`${RETRY_STEP_MS / 60_000} minutes`}::interval END,
                  lease_token = NULL, lease_batch = NULL, leased_until = NULL, errcode = ${code}
                WHERE id = ${r.id} AND status = 'leased' AND lease_token = ${r.leaseToken}`;
    const done = await q;
    accepted += done.count;
  }
  return { accepted };
}

// ───────────────────────── 后台 ─────────────────────────

export async function reminderAdminData(deps: Deps): Promise<MpReminderAdminData> {
  const rules = await loadReminderRules(deps.sql);
  const { today } = await nowOf(deps, new Date());
  const [[c], counts, [w], recent] = await Promise.all([
    deps.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mp_reminder_consents WHERE created_at > now() - interval '30 days'`,
    deps.sql<{ status: MpReminderStatus; n: number }[]>`
      SELECT status, count(*)::int AS n FROM mp_reminder_messages WHERE created_at > now() - interval '30 days' GROUP BY status`,
    deps.sql<{ waiting: number; overdue: number }[]>`
      SELECT (count(*) FILTER (WHERE c.due_date > ${today}))::int AS waiting, (count(*) FILTER (WHERE c.due_date <= ${today}))::int AS overdue
      FROM mp_reminder_consents c WHERE NOT EXISTS (SELECT 1 FROM mp_reminder_messages m WHERE m.consent_id = c.id)`,
    deps.sql<(Omit<MpReminderMessageAdmin, 'createdAt' | 'finishedAt'> & { createdAt: string; finishedAt: string | null })[]>`
      SELECT m.id, c.kind, c.member_id, mb.name AS member_name, c.target_date::text AS target_date, c.due_date::text AS due_date,
             m.status, m.reason, m.errcode, m.attempts, m.created_at, m.finished_at
      FROM mp_reminder_messages m JOIN mp_reminder_consents c ON c.id = m.consent_id JOIN members mb ON mb.id = c.member_id
      ORDER BY m.id DESC LIMIT 50`,
  ]);
  return {
    rules,
    stats: { consents: c?.n ?? 0, byStatus: Object.fromEntries(counts.map((r) => [r.status, r.n])), waiting: w?.waiting ?? 0, overdue: w?.overdue ?? 0 },
    lastLeaseAt: lastLeaseAt ? lastLeaseAt.toISOString() : null,
    recent: recent.map((r) => ({
      ...r,
      memberId: Number(r.memberId),
      createdAt: new Date(r.createdAt).toISOString(),
      finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
    })),
  };
}
