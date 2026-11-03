// 会员体系 v2 第二期（v0.7.24，docs/BENEFITS.md）：本店权益自动发放。
//
//   · 权益清单：一键导入本店权益清单（编号已有的跳过，全部是草稿）；店主、店总逐项修改（带版本号）、发布、暂缓；不能删除；
//   · 券类：每天营业日开始后的自动任务给够格的会员发本期（本月、本年）还没发够的券，有效到本期最后一天；
//     档阶变化（充值升档、消费升阶、保级、手动调整、上线与期初导入定档）与新会员建档时在同一事务里当场补发差额；
//   · 事件礼：首笔充值、升档、升阶、保级、生日月、节日自动发券，每项去重；
//   · 服务类：会员详情列出「本月可享」，设了次数的由服务的同事登记使用、到上限拒绝；登记错的作废（写原因）。
// 发放记录只追加（去重键唯一），每条对应一条发券记录（种类「会员权益」），已经发出的券不随权益的修改变化。
// 锁：自动发放在调用方已经锁住的会员一行之后，对券模板加共享锁（与改模板串行），不锁权益（读已发布的）；
//     登记使用：操作编号的咨询锁（与「确认作废」串行）→ 会员一行 → 权益一行（共享锁）；作废使用只锁那条登记；
//     修改、发布、暂缓只锁权益一行（带版本号）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import {
  BENEFIT_CATALOG,
  BENEFIT_CATEGORIES,
  BENEFIT_CATEGORY_LABELS,
  BENEFIT_EVENT_LABELS,
  BENEFIT_EVENTS,
  BENEFIT_PERIODS,
  BENEFIT_STATUS_LABELS,
  benefitEligible,
  benefitQuantity,
  DISCOUNT_TARGET_LABELS,
  DISCOUNT_TARGETS,
  discountDaysText,
  FESTIVAL_WINDOW_DAYS,
  MAX_DISCOUNT_RATE,
  MAX_EXTENSION_MINUTES,
  minutesText,
  MIN_DISCOUNT_RATE,
  MIN_EXTENSION_MINUTES,
  rateText,
  MAX_BENEFIT_COUPONS,
  MAX_BENEFIT_LIMIT,
  MAX_FESTIVAL_DATES,
  parseStart,
  periodEnd,
  periodKey,
  startLabel,
  stateRank,
  type Benefit,
  type BenefitCatalog,
  type BenefitCategory,
  type BenefitEvent,
  type BenefitGrantReason,
  type BenefitGrantRow,
  type BenefitJobRun,
  type BenefitPeriod,
  type BenefitStatus,
  type BenefitSummary,
  type BenefitUseRow,
  type DiscountTarget,
  type MemberBenefitItem,
  type MemberBenefits,
  type TierQuantity,
} from '@shared/benefits';
import { asGrade, gradeLabel, MAX_GRADE, type GradeEventKind, type GradeState, type Tier } from '@shared/membership';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import { guard } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Sql, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { idParam, parse } from '../lib/validate';
import { sameJson } from '../lib/rule-settings';
import { setTxTimeouts } from '../lib/tx';
import { issueBenefitCoupons, listTemplates } from './coupons';
import { erpOpAbandoned } from './erp-ops';
import { loadMembershipRules, projectedGrade, settleMemberDue } from './membership';
import { benefitState } from './member-trials';
import { GIFT_BENEFIT_CODE } from '@shared/trials';
import { loadSettings } from './settings';

// ───────────────────────── 读权益 ─────────────────────────

interface BenefitDef {
  id: number;
  code: string;
  name: string;
  category: BenefitCategory;
  startGrade: number | null;
  startTier: number | null;
  period: BenefitPeriod;
  quantity: number | null;
  tierQuantities: TierQuantity[];
  templateId: number | null;
  events: BenefitEvent[];
  festivalDates: string[];
  discountTarget: DiscountTarget | null;
  weekdays: number[];
  monthDays: number[];
  content: string;
  conditions: string;
  status: BenefitStatus;
  version: number;
  sortOrder: number;
}

const DEF_COLUMNS = (db: Db) => db`
  b.id, b.code, b.name, b.category, b.start_grade, b.start_tier, b.period, b.quantity, b.tier_quantities, b.template_id, b.events,
  b.festival_dates::text[] AS festival_dates, b.discount_target, b.weekdays::int[] AS weekdays, b.month_days::int[] AS month_days,
  b.content, b.conditions, b.status, b.version, b.sort_order`;

/** 已发布的券类、事件礼（自动发放用；不加锁，读已提交的） */
async function publishedForGrants(db: Db): Promise<BenefitDef[]> {
  return db<BenefitDef[]>`
    SELECT ${DEF_COLUMNS(db)} FROM benefits b
    WHERE b.status = 'published' AND b.category IN ('coupon', 'event') AND b.template_id IS NOT NULL
    ORDER BY b.sort_order, b.id`;
}

/**
 * 权益清单的版本指纹（每天的自动任务据此判断要不要再跑一次）：每项权益的编号与版本，加上权益用到的券模板的编号与版本——
 * 有人修改、发布、暂缓、导入权益，或停用、启用、改了用到的券模板（例如跑的时候模板停着、发不出，之后又启用），同一天都会再跑
 * （Codex 自动审查 1648cd0）。取摘要的前 52 位（JS 数字能精确表示）；用指纹不用版本合计，两处改动不会互相抵消
 */
async function catalogStamp(db: Db): Promise<number> {
  const [r] = await db<{ stamp: number }[]>`
    SELECT ('x' || substr(md5(
             coalesce((SELECT string_agg(id || ':' || version, ',' ORDER BY id) FROM benefits), '') || '|' ||
             coalesce((SELECT string_agg(t.id || ':' || t.version, ',' ORDER BY t.id) FROM coupon_templates t
                       WHERE t.id IN (SELECT template_id FROM benefits WHERE template_id IS NOT NULL)), '')
           ), 1, 13))::bit(52)::bigint AS stamp`;
  return Number(r!.stamp);
}

// ───────────────────────── 发放 ─────────────────────────

interface Grantee {
  memberId: number;
  grade: number;
  tier: number | null;
  birthday: string | null;
  /** 营业日 */
  date: string;
  staffId: number | null;
  at: Date;
}

const eventText = (eventKey: string) => {
  const [kind, rest] = eventKey.split(':');
  if (kind === 'first') return '首笔充值';
  if (kind === 'birthday') return `${rest} 年生日月`;
  if (kind === 'festival') return `节日 ${rest}`;
  return BENEFIT_EVENT_LABELS[kind as BenefitEvent] ?? kind!;
};

/** 发一次：发券记录（种类「会员权益」）+ 发放记录；去重键已有、模板停用或过期的不发，返回发了几张 */
async function grant(
  tx: Tx,
  b: BenefitDef,
  g: Grantee,
  o: { reason: BenefitGrantReason; quantity: number; periodKey: string | null; target: number | null; eventKey: string | null; dedupeKey: string },
): Promise<number> {
  const periodic = o.reason !== 'event';
  const issued = await issueBenefitCoupons(tx, {
    templateId: b.templateId!,
    memberId: g.memberId,
    quantity: o.quantity,
    level: g.grade,
    reason: `会员权益 ${b.code} ${b.name}（${periodic ? o.periodKey : eventText(o.eventKey!)}）`,
    dedupeKey: o.dedupeKey,
    staffId: g.staffId,
    at: g.at,
    date: g.date,
    periodEnd: periodic ? periodEnd(b.period as 'month' | 'year', g.date) : null,
  });
  if (!issued) return 0;
  await tx`
    INSERT INTO benefit_grants (benefit_id, benefit_version, member_id, reason, period_key, target, event_key, quantity, coupon_issue_id,
                                grade, tier, business_date, dedupe_key, staff_id, created_at)
    VALUES (${b.id}, ${b.version}, ${g.memberId}, ${o.reason}, ${o.periodKey}, ${o.target}, ${o.eventKey}, ${o.quantity}, ${issued.issueId},
            ${g.grade}, ${g.grade === 0 ? null : (g.tier ?? 0)}, ${g.date}, ${o.dedupeKey}, ${g.staffId}, ${g.at})`;
  return o.quantity;
}

/**
 * 券类：本期（本月、本年）还没发够的补上——应得 = 按会员现在的档阶取的张数，已发 = 本期发过的合计；降档不收回。
 * 去重键带「发完以后的应得累计」，几个进程同时发也只发一次
 */
async function topUpPeriodic(tx: Tx, g: Grantee, reason: 'monthly' | 'top_up', benefits: BenefitDef[]): Promise<number> {
  const list = benefits.filter((b) => b.category === 'coupon' && (b.period === 'month' || b.period === 'year') && benefitEligible(b, g.grade, g.tier));
  if (!list.length) return 0;
  const keys = [periodKey('month', g.date)!, periodKey('year', g.date)!];
  const rows = await tx<{ benefitId: number; periodKey: string; n: number }[]>`
    SELECT benefit_id, period_key, sum(quantity)::int AS n FROM benefit_grants
    WHERE member_id = ${g.memberId} AND reason <> 'event' AND period_key IN ${tx(keys)} AND benefit_id IN ${tx(list.map((b) => b.id))}
    GROUP BY benefit_id, period_key`;
  let total = 0;
  for (const b of list) {
    const pk = periodKey(b.period, g.date)!;
    const target = Math.min(MAX_BENEFIT_COUPONS, benefitQuantity(b, g.grade, g.tier) ?? 0);
    const granted = rows.find((r) => Number(r.benefitId) === b.id && r.periodKey === pk)?.n ?? 0;
    if (target <= granted) continue;
    total += await grant(tx, b, g, {
      reason,
      quantity: target - granted,
      periodKey: pk,
      target,
      eventKey: null,
      dedupeKey: `benefit:${b.id}:${g.memberId}:${pk}:q${target}`,
    });
  }
  return total;
}

/** 事件礼：这个事件的、会员够格的每一项各发一次（事件键去重） */
async function grantEvent(tx: Tx, g: Grantee, event: BenefitEvent, eventKey: string, benefits: BenefitDef[]): Promise<number> {
  let total = 0;
  for (const b of benefits) {
    if (b.category !== 'event' || !b.events.includes(event) || !benefitEligible(b, g.grade, g.tier)) continue;
    const quantity = Math.min(MAX_BENEFIT_COUPONS, benefitQuantity(b, g.grade, g.tier) ?? 0);
    if (quantity < 1) continue;
    total += await grant(tx, b, g, { reason: 'event', quantity, periodKey: null, target: null, eventKey, dedupeKey: `benefit:${b.id}:${g.memberId}:${eventKey}` });
  }
  return total;
}

/** 生日礼：生日在营业日这个月的、够格的，每年一次 */
async function grantBirthday(tx: Tx, g: Grantee, benefits: BenefitDef[]): Promise<number> {
  if (!g.birthday || g.birthday.slice(5, 7) !== g.date.slice(5, 7)) return 0;
  return grantEvent(tx, g, 'birthday', `birthday:${g.date.slice(0, 4)}`, benefits);
}

/** 节日关怀：设置的日期当天起 7 天内（应用停机也不漏），每个日期一次 */
async function grantFestivals(tx: Tx, g: Grantee, benefits: BenefitDef[]): Promise<number> {
  let total = 0;
  for (const b of benefits) {
    if (b.category !== 'event' || !b.events.includes('festival')) continue;
    for (const d of b.festivalDates) {
      if (!festivalOpen(d, g.date)) continue;
      total += await grantEvent(tx, g, 'festival', `festival:${d}`, [b]);
    }
  }
  return total;
}

const festivalOpen = (festival: string, date: string) => festival <= date && date <= shiftDate(festival, FESTIVAL_WINDOW_DAYS - 1);

/**
 * 会员一行（调用方已锁）：在册的才发。
 * settled：要求到期已经处理——周期或补充期已经结束、还没按规则处理的会员档阶还是旧的（到期处理出错、锁等超时，或还没轮到），
 * 不按它发；等到期处理完由 onDueSettled 按处理完的状态发（Codex 自动审查 32d3f31）。档阶变化、到期处理调用时状态都是处理过的
 */
async function granteeOf(tx: Tx, memberId: number, date: string, staffId: number | null, opts: { settled?: boolean } = {}): Promise<Grantee | null> {
  const [m] = await tx<{ grade: number; tier: number | null; birthday: string | null; status: string; cycleEnd: string | null; graceUntil: string | null }[]>`
    SELECT grade, tier, birthday, status, cycle_end, grace_until FROM members WHERE id = ${memberId}`;
  if (!m || m.status !== 'active') return null;
  if (opts.settled && m.grade > 0 && (m.graceUntil ?? m.cycleEnd ?? date) < date) return null;
  return { memberId, grade: m.grade, tier: m.tier, birthday: m.birthday, date, staffId, at: new Date() };
}

/**
 * 会员现在该有的：本期券类补齐、生日月的生日礼、节日当周的节日关怀。每天的自动发放与档阶变化、建档、改生日、到期处理完时都按这一套——
 * 自动发放当天跑完以后不再翻会员，之后才够格的当场补，不会错过只剩当天的节日（Codex 自动审查 32d3f31）
 */
async function grantDue(tx: Tx, g: Grantee, reason: 'monthly' | 'top_up', benefits: BenefitDef[]): Promise<number> {
  return (await topUpPeriodic(tx, g, reason, benefits)) + (await grantBirthday(tx, g, benefits)) + (await grantFestivals(tx, g, benefits));
}

const EVENT_OF_KIND: Partial<Record<GradeEventKind, BenefitEvent>> = { recharge_up: 'grade_up', spend_up: 'tier_up', retain: 'retain', grace_retain: 'retain' };

/**
 * 档阶变化之后（会员一行已锁，membership.ts 记状态变化的同一事务）：充值升档发升级礼（升档）、消费升阶发升级礼（升阶）、
 * 到期保级与补充期内保级发保级礼（每次状态变化各一次）；再按新档阶补现在该有的（grantDue：本期券类差额、生日礼、节日关怀）。
 * 手动调整、上线与期初导入定档不发升级礼；降档不收回。
 *
 * deferPeriodic：停机后补跑到期、一次连走几步时（例如补充期开始、接着降档），中间那几步只发事件礼（保级礼按那次保级），
 * 其余留到最后一步之后按处理完的状态补（onDueSettled）：中间的档阶早就过去了，按它发的券降档后也收不回
 * （Codex 自动审查 98806a3）
 */
export async function onGradeChanged(
  tx: Tx,
  o: { memberId: number; kind: GradeEventKind; eventId: number; date: string; to: GradeState; staffId: number | null; deferPeriodic?: boolean },
) {
  const benefits = await publishedForGrants(tx);
  if (!benefits.length) return;
  const g = await granteeOf(tx, o.memberId, o.date, o.staffId);
  if (!g) return;
  const event = EVENT_OF_KIND[o.kind];
  if (event) await grantEvent(tx, g, event, `${event}:e${o.eventId}`, benefits);
  if (!o.deferPeriodic) await grantDue(tx, g, 'top_up', benefits);
}

/** 补跑的到期处理走完以后（会员一行已锁）：按处理完的状态补现在该有的 */
export async function onDueSettled(tx: Tx, memberId: number, date: string) {
  const benefits = await publishedForGrants(tx);
  if (!benefits.length) return;
  const g = await granteeOf(tx, memberId, date, null);
  if (g) await grantDue(tx, g, 'top_up', benefits);
}

/** 上线定档、期初导入定档之后（会员已按 id 升序锁住）：定了档的补现在该有的 */
export async function onMembersGraded(tx: Tx, memberIds: number[], date: string, staffId: number | null) {
  if (!memberIds.length) return;
  const benefits = await publishedForGrants(tx);
  if (!benefits.length) return;
  for (const id of [...memberIds].sort((a, b) => a - b)) {
    const g = await granteeOf(tx, id, date, staffId);
    if (g) await grantDue(tx, g, 'top_up', benefits);
  }
}

/** 充值入账之后（钱包的事务里，会员已锁、升档已记）：首笔充值发首充礼（按充完以后的档阶） */
export async function onRecharge(tx: Tx, o: { memberId: number; first: boolean; date: string; staffId: number }) {
  if (!o.first) return;
  const benefits = await publishedForGrants(tx);
  if (!benefits.some((b) => b.category === 'event' && b.events.includes('first_recharge'))) return;
  const g = await granteeOf(tx, o.memberId, o.date, o.staffId);
  if (g) await grantEvent(tx, g, 'first_recharge', 'first', benefits);
}

/**
 * 新会员建档、修改会员时改了生日（建档、修改的事务里，会员一行刚建或已锁）：补现在该有的（「L0·会员」起点的本期券类、生日月的生日礼、节日关怀）。
 * 改生日也要当场看：每天的自动发放当天跑完以后不再翻会员，月底最后一天补填的生日会错过（Codex 自动审查 98806a3）。
 * 到期还没处理的会员不按旧档阶发，等到期处理完再发
 */
export async function onMemberSaved(tx: Tx, deps: Pick<Deps, 'config'>, memberId: number, ctx: OpContext) {
  const benefits = await publishedForGrants(tx);
  if (!benefits.length) return;
  const at = ctx.at ?? new Date();
  const date = businessDateOf(at, deps.config.timezone, (await loadSettings(tx)).businessDayStartHour);
  const g = await granteeOf(tx, memberId, date, ctx.actor.id, { settled: true });
  if (g) await grantDue(tx, g, 'top_up', benefits);
}

// ───────────────────────── 每天的自动任务 ─────────────────────────

/** 一次翻多少位会员 */
const DAILY_PAGE = 500;

/**
 * 会员权益的自动发放：营业日开始后，给在册会员发本期还没发够的券类、生日月的生日礼、节日当周的节日关怀（一位一个事务、锁会员一行）。
 * 应用每分钟调用一次：今天已经跑完、没出错、之后也没人改过权益清单时什么都不做；有人修改、发布、暂缓了，同一天再跑一次
 * （今天才发布的月度券当天就发）。每页先在事务外算出谁还缺，只给缺的会员开事务；运行记录一个营业日一条，同一天多次累加
 */
export async function runBenefitsDaily(deps: Pick<Deps, 'sql' | 'config'>, now = new Date(), opts: { pageSize?: number } = {}): Promise<BenefitJobRun | null> {
  const { sql } = deps;
  const pageSize = opts.pageSize ?? DAILY_PAGE;
  const settings = await loadSettings(sql);
  const today = businessDateOf(now, deps.config.timezone, settings.businessDayStartHour);
  // 先读清单的版本合计、再读已发布的：这之后的修改会让合计变，下一次再跑
  const stamp = await catalogStamp(sql);
  const [run] = await sql<{ finishedAt: string | null; error: string | null; catalogStamp: number | null }[]>`
    SELECT finished_at, error, catalog_stamp FROM membership_job_runs WHERE job = 'benefits' AND business_date = ${today}`;
  if (run && run.finishedAt && !run.error && run.catalogStamp !== null && Number(run.catalogStamp) === stamp) return null;
  await sql`
    INSERT INTO membership_job_runs (job, business_date, catalog_stamp) VALUES ('benefits', ${today}, ${stamp})
    ON CONFLICT (job, business_date) DO UPDATE SET started_at = now(), finished_at = NULL, error = NULL, catalog_stamp = ${stamp}`;
  const benefits = await publishedForGrants(sql);
  const counts = { processed: 0, coupons: 0 };
  let error: string | null = null;
  if (benefits.length) {
    for (let after = 0; ; ) {
      const page = await sql<{ id: number; grade: number; tier: number | null; birthday: string | null }[]>`
        SELECT id, grade, tier, birthday FROM members WHERE status = 'active' AND id > ${after} ORDER BY id LIMIT ${pageSize}`;
      if (!page.length) break;
      after = Number(page[page.length - 1]!.id);
      for (const id of await needingGrants(sql, page, benefits, today)) {
        try {
          const n = await sql.begin(async (tx) => {
            await setTxTimeouts(tx);
            await tx`SELECT id FROM members WHERE id = ${id} FOR UPDATE`;
            // 到期还没处理的（到期处理这一位出错、锁等超时）跳过：处理完由 onDueSettled 按新的档阶发（命令行补跑同样）
            const g = await granteeOf(tx, id, today, null, { settled: true });
            if (!g) return 0;
            const issued = await grantDue(tx, g, 'monthly', benefits);
            if (issued) {
              await writeAudit(tx, { staffId: null, action: 'benefit_granted', targetType: 'member', targetId: id, detail: { coupons: issued }, businessDate: today });
            }
            return issued;
          });
          if (n) {
            counts.processed += 1;
            counts.coupons += n;
          }
        } catch (e) {
          error ??= `会员 #${id}：${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
        }
      }
      if (page.length < pageSize) break;
    }
  }
  const [saved] = await sql<BenefitJobRun[]>`
    UPDATE membership_job_runs
       SET processed = processed + ${counts.processed}, coupons = coupons + ${counts.coupons}, finished_at = now(), error = ${error}
     WHERE job = 'benefits' AND business_date = ${today}
    RETURNING business_date, started_at, finished_at, processed, coupons, error`;
  return saved ?? null;
}

/** 这一页里还缺券的会员（事务外、只读；进了事务再按最新的状态核对一遍） */
async function needingGrants(db: Db, page: { id: number; grade: number; tier: number | null; birthday: string | null }[], benefits: BenefitDef[], today: string): Promise<number[]> {
  const ids = page.map((m) => Number(m.id));
  const keys = [periodKey('month', today)!, periodKey('year', today)!];
  const periodic = await db<{ memberId: number; benefitId: number; periodKey: string; n: number }[]>`
    SELECT member_id, benefit_id, period_key, sum(quantity)::int AS n FROM benefit_grants
    WHERE member_id IN ${db(ids)} AND reason <> 'event' AND period_key IN ${db(keys)}
    GROUP BY member_id, benefit_id, period_key`;
  const eventKeys = [`birthday:${today.slice(0, 4)}`];
  for (const b of benefits) if (b.events.includes('festival')) for (const d of b.festivalDates) if (festivalOpen(d, today)) eventKeys.push(`festival:${d}`);
  const events = await db<{ memberId: number; benefitId: number; eventKey: string }[]>`
    SELECT member_id, benefit_id, event_key FROM benefit_grants WHERE member_id IN ${db(ids)} AND event_key IN ${db(eventKeys)}`;
  const granted = new Map(periodic.map((r) => [`${r.memberId}:${r.benefitId}:${r.periodKey}`, r.n]));
  const got = new Set(events.map((r) => `${r.memberId}:${r.benefitId}:${r.eventKey}`));
  return page
    .filter((m) =>
      benefits.some((b) => {
        if (!benefitEligible(b, m.grade, m.tier)) return false;
        if (b.category === 'coupon') {
          const pk = periodKey(b.period, today)!;
          return Math.min(MAX_BENEFIT_COUPONS, benefitQuantity(b, m.grade, m.tier) ?? 0) > (granted.get(`${m.id}:${b.id}:${pk}`) ?? 0);
        }
        if (b.events.includes('birthday') && m.birthday && m.birthday.slice(5, 7) === today.slice(5, 7) && !got.has(`${m.id}:${b.id}:birthday:${today.slice(0, 4)}`)) return true;
        return b.events.includes('festival') && b.festivalDates.some((d) => festivalOpen(d, today) && !got.has(`${m.id}:${b.id}:festival:${d}`));
      }),
    )
    .map((m) => Number(m.id));
}

// ───────────────────────── 权益清单：导入、修改、发布 ─────────────────────────

/** 导入预览：清单里编号还没有的会新建 */
export async function catalogImportPreview(db: Db): Promise<{ total: number; create: (typeof BENEFIT_CATALOG)[number][]; skipped: string[] }> {
  const existing = new Set((await db<{ code: string }[]>`SELECT code FROM benefits`).map((r) => r.code));
  return {
    total: BENEFIT_CATALOG.length,
    create: BENEFIT_CATALOG.filter((e) => !existing.has(e.code)),
    skipped: BENEFIT_CATALOG.filter((e) => existing.has(e.code)).map((e) => e.code),
  };
}

/** 导入本店权益清单（编号已有的跳过，导入后全部是草稿，文档写明暂缓的为暂缓）；staffId 为空 = 命令行导入 */
export async function importCatalog(sql: Sql, staffId: number | null, ip?: string): Promise<{ created: number; skipped: number }> {
  return sql.begin(async (tx) => {
    let created = 0;
    for (const [i, e] of BENEFIT_CATALOG.entries()) {
      const start = parseStart(e.start);
      // 折扣类按会员文档预填的折扣（v0.7.25，M44；仍是草稿）
      const rows = await tx`
        INSERT INTO benefits (code, name, category, start_grade, start_tier, period, quantity, tier_quantities, discount_target, events, content,
                              conditions, status, sort_order, created_by, updated_by)
        VALUES (${e.code}, ${e.name}, ${e.category}, ${start?.grade ?? null}, ${start?.tier ?? null}, ${e.period}, ${e.quantity},
                ${tx.json((e.discount?.tierQuantities ?? []) as unknown as Parameters<typeof tx.json>[0])}, ${e.discount?.target ?? null}, ${e.events}::text[], ${e.content}, ${e.conditions},
                ${e.status}, ${(i + 1) * 10}, ${staffId}, ${staffId})
        ON CONFLICT (code) DO NOTHING RETURNING id`;
      created += rows.length;
    }
    await writeAudit(tx, { staffId, action: 'benefits_imported', targetType: 'benefit', detail: { created, skipped: BENEFIT_CATALOG.length - created }, ip });
    return { created, skipped: BENEFIT_CATALOG.length - created };
  });
}

const gradeField = z.number('请选择档级').int().min(0, '档级是 L0–L6').max(MAX_GRADE, '档级是 L0–L6');
const tierField = z.number('请选择阶位').int().min(0, '阶位是初、享、尊').max(2, '阶位是初、享、尊').nullable();

const BenefitInput = z.object({
  expectedVersion: z.number('缺少版本号，请刷新后重试').int().min(1),
  name: z.string('请填写名称').trim().min(1, '请填写名称').max(40, '名称最多 40 个字'),
  category: z.enum(BENEFIT_CATEGORIES, '请选择类别'),
  startGrade: gradeField.nullable(),
  startTier: tierField,
  period: z.enum(BENEFIT_PERIODS, '请选择周期'),
  // 浴票延迟的分钟数最多 240，其余类别最多 99（按类别在 normalize 里核对）
  quantity: z.number('数量要是整数').int('数量要是整数').min(1, '数量至少 1').max(MAX_EXTENSION_MINUTES, `数量最多 ${MAX_EXTENSION_MINUTES}`).nullable(),
  tierQuantities: z
    .array(z.object({ grade: gradeField, tier: tierField, quantity: z.number('数量要是整数').int().min(1, '数量至少 1').max(MAX_EXTENSION_MINUTES, `数量最多 ${MAX_EXTENSION_MINUTES}`) }))
    .max(18, '各档阶数量最多 18 行')
    .default([]),
  templateId: z.number().int().positive().nullable().default(null),
  events: z.array(z.enum(BENEFIT_EVENTS, '事件不正确')).max(BENEFIT_EVENTS.length).default([]),
  festivalDates: z.array(z.string().regex(ISO_DATE, '节日日期格式应为 YYYY-MM-DD')).max(MAX_FESTIVAL_DATES, `节日最多 ${MAX_FESTIVAL_DATES} 个`).default([]),
  // 折扣类（v0.7.25）：打哪些明细、每周几（1 = 周一）、每月几号；空 = 每天
  discountTarget: z.enum(DISCOUNT_TARGETS, '请选择打哪些明细').nullable().default(null),
  weekdays: z.array(z.number('星期不正确').int().min(1, '星期不正确').max(7, '星期不正确')).max(7).default([]),
  monthDays: z.array(z.number('日期不正确').int().min(1, '每月几号是 1–31').max(31, '每月几号是 1–31')).max(31).default([]),
  content: z.string().trim().max(500, '内容最多 500 字').default(''),
  conditions: z.string().trim().max(500, '使用条件最多 500 字').default(''),
});
type BenefitInputData = z.output<typeof BenefitInput>;

type Normalized = Omit<BenefitInputData, 'expectedVersion'>;

/** 按类别只留下用得到的字段（与数据库约束一致），并核对数量、各档阶、事件 */
function normalize(input: BenefitInputData): Normalized {
  const { expectedVersion: _v, ...b } = input;
  const issue = (message: string, field: string) => badRequest(message, { field });
  if (b.startGrade !== null && (b.startGrade === 0) !== (b.startTier === null)) throw issue('L0 是所有会员（不分阶），L1–L6 请选择初、享、尊', 'startTier');
  const couponLike = b.category === 'coupon' || b.category === 'event';
  const out: Normalized = { ...b };
  if (b.category === 'coupon') {
    if (b.period !== 'month' && b.period !== 'year') throw issue('券类请选择每月或每年发', 'period');
    out.events = [];
    out.festivalDates = [];
  } else if (b.category === 'event') {
    out.period = 'none';
    if (!b.events.includes('festival')) out.festivalDates = [];
  } else {
    out.templateId = null;
    out.events = [];
    out.festivalDates = [];
  }
  if (b.category === 'service') {
    if (b.period === 'none') {
      out.quantity = null;
      out.tierQuantities = [];
    } else if (b.quantity === null) {
      throw issue(`设了${b.period === 'day' ? '每天' : b.period === 'month' ? '每月' : '每年'}就要填几次（不限次请选「不计次」）`, 'quantity');
    }
  }
  if (b.category === 'info') {
    out.period = 'none';
    out.quantity = null;
    out.tierQuantities = [];
  }
  // 浴票延迟（v0.7.25 续）：起点与各档阶的分钟数（1–240），不计次；别的类别数量最多 99
  if (b.category === 'extension') {
    out.period = 'none';
    const bad = (q: number) => q < MIN_EXTENSION_MINUTES || q > MAX_EXTENSION_MINUTES;
    if (b.quantity !== null && bad(b.quantity)) throw issue(`浴票延迟填分钟数：${MIN_EXTENSION_MINUTES}–${MAX_EXTENSION_MINUTES}`, 'quantity');
    if (b.tierQuantities.some((q) => bad(q.quantity))) throw issue(`各档阶的浴票延迟填分钟数：${MIN_EXTENSION_MINUTES}–${MAX_EXTENSION_MINUTES}`, 'tierQuantities');
  } else {
    if (b.quantity !== null && b.quantity > MAX_BENEFIT_LIMIT) throw issue(`数量最多 ${MAX_BENEFIT_LIMIT}`, 'quantity');
    if (b.tierQuantities.some((q) => q.quantity > MAX_BENEFIT_LIMIT)) throw issue(`各档阶数量最多 ${MAX_BENEFIT_LIMIT}`, 'tierQuantities');
  }
  // 折扣类：「付几成」在数量与各档阶表里（10–99），打哪些明细、每周几、每月几号；别的类别没有这几项
  if (b.category === 'discount') {
    out.period = 'none';
    const bad = (q: number) => q < MIN_DISCOUNT_RATE || q > MAX_DISCOUNT_RATE;
    if (b.quantity !== null && bad(b.quantity)) throw issue(`折扣填「付几成」：${MIN_DISCOUNT_RATE}–${MAX_DISCOUNT_RATE}（75 = 7.5 折）`, 'quantity');
    if (b.tierQuantities.some((q) => bad(q.quantity))) throw issue(`各档阶的折扣填「付几成」：${MIN_DISCOUNT_RATE}–${MAX_DISCOUNT_RATE}（75 = 7.5 折）`, 'tierQuantities');
    out.weekdays = [...new Set(b.weekdays)].sort((x, y) => x - y);
    out.monthDays = [...new Set(b.monthDays)].sort((x, y) => x - y);
  } else {
    out.discountTarget = null;
    out.weekdays = [];
    out.monthDays = [];
  }
  if (couponLike && b.quantity !== null && b.quantity > MAX_BENEFIT_COUPONS) throw issue(`券每期（每次）最多 ${MAX_BENEFIT_COUPONS} 张`, 'quantity');
  // 各档阶数量：每行一个状态（L0 不分阶），不重复，按从低到高排；起点以下的行没有意义
  const rows = out.tierQuantities.map((t) => ({ grade: asGrade(t.grade), tier: t.grade === 0 ? null : ((t.tier ?? 0) as Tier), quantity: t.quantity }));
  const ranks = rows.map((t) => stateRank(t.grade, t.tier));
  if (new Set(ranks).size !== ranks.length) throw issue('各档阶数量里有重复的档阶', 'tierQuantities');
  if (couponLike && rows.some((t) => t.quantity > MAX_BENEFIT_COUPONS)) throw issue(`券每期（每次）最多 ${MAX_BENEFIT_COUPONS} 张`, 'tierQuantities');
  if (b.startGrade !== null && rows.some((t) => stateRank(t.grade, t.tier) <= stateRank(b.startGrade!, b.startTier))) {
    throw issue('各档阶数量要高于配置起点（起点的数量填在「数量」里）', 'tierQuantities');
  }
  out.tierQuantities = rows.sort((x, y) => stateRank(x.grade, x.tier) - stateRank(y.grade, y.tier));
  out.festivalDates = [...new Set(out.festivalDates)].sort();
  out.events = BENEFIT_EVENTS.filter((e) => out.events.includes(e));
  return out;
}

/** 能不能发布：返回问题清单（空 = 能） */
async function publishProblems(db: Db, b: Normalized, today: string): Promise<string[]> {
  const problems: string[] = [];
  if (b.startGrade === null) problems.push('请先设配置起点');
  if (b.category === 'discount') {
    if (b.discountTarget === null) problems.push('请选择打哪些明细（客房房费、门票、整张账单）');
    if (b.quantity === null) problems.push('请填写起点的折扣（付几成，75 = 7.5 折）');
  }
  if (b.category === 'coupon' || b.category === 'event') {
    if (b.quantity === null) problems.push(b.category === 'coupon' ? '请填写每期几张' : '请填写每次几张');
    if (b.category === 'event' && b.events.length === 0) problems.push('请选择什么时候发（首笔充值、升档、升阶、保级、生日月、节日）');
    if (b.category === 'event' && b.events.includes('festival') && b.festivalDates.length === 0) problems.push('节日关怀请填写节日的日期');
    if (b.templateId === null) problems.push('请选择发哪张券（券模板）');
    else {
      const [t] = await db<{ name: string; active: boolean; validity: string; validTo: string | null }[]>`
        SELECT name, active, validity, valid_to FROM coupon_templates WHERE id = ${b.templateId}`;
      if (!t) problems.push('选的券模板不存在，请刷新后重选');
      else if (!t.active) problems.push(`券模板「${t.name}」已停用`);
      else if (t.validity === 'fixed' && t.validTo! < today) problems.push(`券模板「${t.name}」的有效期到 ${t.validTo} 已经过了`);
    }
  }
  if (b.category === 'service' && b.period !== 'none' && b.quantity === null) problems.push('请填写每期几次');
  if (b.category === 'extension' && b.quantity === null) problems.push('请填写起点多给几分钟不跳档（浴票延迟）');
  return problems;
}

const today = async (db: Db, timezone: string, at = new Date()) => businessDateOf(at, timezone, (await loadSettings(db)).businessDayStartHour);

const CATALOG_SELECT = (db: Db, from: string, to: string) => db`
  SELECT ${DEF_COLUMNS(db)}, b.updated_at, b.published_at, s.display_name AS updated_by_name,
         t.name AS template_name, t.active AS template_active,
         (SELECT coalesce(sum(g.quantity), 0)::int FROM benefit_grants g WHERE g.benefit_id = b.id AND g.business_date BETWEEN ${from} AND ${to}) AS month_coupons,
         (SELECT count(DISTINCT g.member_id)::int FROM benefit_grants g WHERE g.benefit_id = b.id AND g.business_date BETWEEN ${from} AND ${to}) AS month_members,
         (SELECT coalesce(sum(u.quantity), 0)::int FROM benefit_uses u
           WHERE u.benefit_id = b.id AND u.status = 'active' AND u.business_date BETWEEN ${from} AND ${to}) AS month_uses
  FROM benefits b LEFT JOIN staff s ON s.id = b.updated_by LEFT JOIN coupon_templates t ON t.id = b.template_id`;

type CatalogRow = BenefitDef & {
  updatedAt: string;
  publishedAt: string | null;
  updatedByName: string | null;
  templateName: string | null;
  templateActive: boolean | null;
  monthCoupons: number;
  monthMembers: number;
  monthUses: number;
};

function toBenefit(r: CatalogRow, summaries: Map<number, string>): Benefit {
  return {
    id: Number(r.id),
    code: r.code,
    name: r.name,
    category: r.category,
    startGrade: r.startGrade === null ? null : asGrade(r.startGrade),
    startTier: r.startTier as Tier | null,
    startLabel: startLabel(r.startGrade, r.startTier),
    period: r.period,
    quantity: r.quantity,
    tierQuantities: r.tierQuantities,
    templateId: r.templateId === null ? null : Number(r.templateId),
    templateName: r.templateName,
    templateActive: r.templateActive,
    templateSummary: r.templateId === null ? null : (summaries.get(Number(r.templateId)) ?? null),
    events: r.events,
    festivalDates: r.festivalDates,
    discountTarget: r.discountTarget,
    weekdays: r.weekdays,
    monthDays: r.monthDays,
    content: r.content,
    conditions: r.conditions,
    status: r.status,
    version: r.version,
    updatedAt: new Date(r.updatedAt).toISOString(),
    updatedByName: r.updatedByName,
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    month: { coupons: r.monthCoupons, members: r.monthMembers, uses: r.monthUses },
  };
}

const monthOf = (date: string) => ({ from: `${date.slice(0, 7)}-01`, to: date });

async function getBenefit(db: Db, id: number, date: string): Promise<Benefit> {
  const { from, to } = monthOf(date);
  const [r] = await db<CatalogRow[]>`${CATALOG_SELECT(db, from, to)} WHERE b.id = ${id}`;
  if (!r) throw notFound('权益不存在');
  const summaries = new Map((await listTemplates(db)).map((t) => [t.id, t.summary]));
  return toBenefit(r, summaries);
}

const JOB_COLUMNS = (db: Db) => db`business_date, started_at, finished_at, processed, coupons, error`;

/** 后台「会员权益」整页 */
export async function benefitCatalog(db: Db, date: string): Promise<BenefitCatalog> {
  const { from, to } = monthOf(date);
  const rows = await db<CatalogRow[]>`${CATALOG_SELECT(db, from, to)} ORDER BY b.sort_order, b.id`;
  const templates = await listTemplates(db);
  const summaries = new Map(templates.map((t) => [t.id, t.summary]));
  const items = rows.map((r) => toBenefit(r, summaries));
  const codes = new Set(items.map((b) => b.code));
  const warnings: string[] = [];
  // M34：与「发券规则」里的升级礼、生日礼会各发一份
  const [rules] = await db<{ levelUp: number; birthday: number }[]>`
    SELECT count(*) FILTER (WHERE kind = 'level_up')::int AS level_up, count(*) FILTER (WHERE kind = 'birthday')::int AS birthday
    FROM coupon_rules WHERE active`;
  const published = items.filter((b) => b.status === 'published');
  if (rules!.levelUp && published.some((b) => b.category === 'event' && b.events.includes('grade_up'))) {
    warnings.push(`「券与会员权益 → 发券规则」里还有 ${rules!.levelUp} 条启用的升级礼，这里的升级礼也已发布：升档时会各发一份，请停用其中一边`);
  }
  if (rules!.birthday && published.some((b) => b.category === 'event' && b.events.includes('birthday'))) {
    warnings.push(`「券与会员权益 → 发券规则」里还有 ${rules!.birthday} 条启用的生日礼，这里的生日礼也已发布：生日月会各发一份，请停用其中一边`);
  }
  const usable = new Map(templates.map((t) => [t.id, t]));
  for (const b of published) {
    if (b.templateId === null) continue;
    const t = usable.get(b.templateId);
    if (!t?.active) warnings.push(`「${b.code} ${b.name}」用的券模板「${b.templateName ?? ''}」已停用，不会发券；请换一张券或暂缓这一项`);
    else if (t.validity === 'fixed' && t.validTo! < date) warnings.push(`「${b.code} ${b.name}」用的券模板「${t.name}」有效期到 ${t.validTo}，已经过了，不会发券`);
  }
  const [job] = await db<BenefitJobRun[]>`SELECT ${JOB_COLUMNS(db)} FROM membership_job_runs WHERE job = 'benefits' ORDER BY business_date DESC LIMIT 1`;
  return {
    today: date,
    month: { from, to },
    items,
    importable: BENEFIT_CATALOG.filter((e) => !codes.has(e.code)).length,
    warnings,
    templates: templates
      .filter((t) => t.active && !(t.validity === 'fixed' && t.validTo! < date))
      .map((t) => ({ id: t.id, name: t.name, summary: t.summary, validity: t.validity === 'fixed' ? `${t.validFrom} 至 ${t.validTo}` : `发券当天起 ${t.validDays} 天` })),
    job: job ?? null,
  };
}

const VersionInput = z.object({ expectedVersion: z.number('缺少版本号，请刷新后重试').int().min(1) });

async function lockBenefit(tx: Tx, id: number, expectedVersion: number): Promise<BenefitDef> {
  const [cur] = await tx<BenefitDef[]>`SELECT ${DEF_COLUMNS(tx)} FROM benefits b WHERE b.id = ${id} FOR UPDATE`;
  if (!cur) throw notFound('权益不存在');
  if (cur.version !== expectedVersion) throw conflict('BENEFIT_CHANGED', `「${cur.code} ${cur.name}」刚被别人改过，页面已换成最新的，请核对后重新修改`, { version: cur.version });
  return cur;
}

const FIELDS = [
  'name', 'category', 'startGrade', 'startTier', 'period', 'quantity', 'tierQuantities', 'templateId', 'events', 'festivalDates',
  'discountTarget', 'weekdays', 'monthDays', 'content', 'conditions',
] as const;

/** 改一项（带版本号，对不上拒绝）；已发布的改完还要能发布。已经发出的券、登记的使用不变 */
export async function updateBenefit(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<Benefit> {
  const input = parse(BenefitInput, raw);
  const b = normalize(input);
  const date = await today(deps.sql, deps.config.timezone, ctx.at);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const cur = await lockBenefit(tx, id, input.expectedVersion);
    if (b.templateId !== null && !(await tx`SELECT 1 FROM coupon_templates WHERE id = ${b.templateId}`).length) {
      throw badRequest('选的券模板不存在，请刷新后重选', { field: 'templateId' });
    }
    if (cur.status === 'published') {
      const problems = await publishProblems(tx, b, date);
      if (problems.length) throw unprocessable('BENEFIT_NOT_PUBLISHABLE', `这一项已发布，改完要还能发布：${problems.join('；')}（不再提供请先暂缓）`, { problems });
    }
    const before: Record<string, unknown> = { ...cur };
    // 各档阶数量存成 jsonb，读回来的键顺序不同：按键排序后比
    const changed = FIELDS.filter((k) => !sameJson(before[k], b[k]));
    if (!changed.length) return;
    await tx`
      UPDATE benefits SET name = ${b.name}, category = ${b.category}, start_grade = ${b.startGrade}, start_tier = ${b.startTier}, period = ${b.period},
             quantity = ${b.quantity}, tier_quantities = ${tx.json(b.tierQuantities)}, template_id = ${b.templateId}, events = ${b.events}::text[],
             festival_dates = ${b.festivalDates}::date[], discount_target = ${b.discountTarget}, weekdays = ${b.weekdays}::smallint[],
             month_days = ${b.monthDays}::smallint[], content = ${b.content}, conditions = ${b.conditions},
             version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'benefit_saved',
      targetType: 'benefit',
      targetId: id,
      detail: { code: cur.code, changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, b[k]])) },
      ip: ctx.ip,
      businessDate: date,
    });
  });
  return getBenefit(deps.sql, id, date);
}

const StatusInput = VersionInput.extend({ status: z.enum(['published', 'paused'], '状态不正确') });

/** 发布（草稿、暂缓 → 已发布，要能发布）或暂缓（→ 暂缓：以后不再发、不能登记，已发的券照常可用） */
export async function setBenefitStatus(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<Benefit> {
  const input = parse(StatusInput, raw);
  const date = await today(deps.sql, deps.config.timezone, ctx.at);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const cur = await lockBenefit(tx, id, input.expectedVersion);
    if (cur.status === input.status) return;
    if (input.status === 'published') {
      const problems = await publishProblems(tx, cur, date);
      if (problems.length) throw unprocessable('BENEFIT_NOT_PUBLISHABLE', `「${cur.code} ${cur.name}」还不能发布：${problems.join('；')}`, { problems });
    }
    await tx`
      UPDATE benefits SET status = ${input.status}, version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now(),
             published_at = ${input.status === 'published' ? tx`now()` : tx`published_at`}
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'benefit_status',
      targetType: 'benefit',
      targetId: id,
      detail: { code: cur.code, from: BENEFIT_STATUS_LABELS[cur.status], to: BENEFIT_STATUS_LABELS[input.status] },
      ip: ctx.ip,
      businessDate: date,
    });
  });
  return getBenefit(deps.sql, id, date);
}

// ───────────────────────── 会员的「本月可享」与使用登记 ─────────────────────────

const GRANT_SELECT = (db: Db) => db`
  SELECT g.id, g.benefit_id, b.code AS benefit_code, b.name AS benefit_name, g.reason, g.period_key, g.event_key, g.quantity, i.issue_no,
         g.business_date, g.created_at
  FROM benefit_grants g JOIN benefits b ON b.id = g.benefit_id JOIN coupon_issues i ON i.id = g.coupon_issue_id`;

const USE_SELECT = (db: Db) => db`
  SELECT u.id, u.benefit_id, b.code AS benefit_code, b.name AS benefit_name, u.quantity, u.period_key, u.limit_at, u.note, u.staff_id,
         s.display_name AS staff_name, u.business_date, u.created_at, u.status, u.void_reason, v.display_name AS voided_by_name
  FROM benefit_uses u JOIN benefits b ON b.id = u.benefit_id JOIN staff s ON s.id = u.staff_id LEFT JOIN staff v ON v.id = u.voided_by`;

const toUse = (r: BenefitUseRow): BenefitUseRow => ({
  ...r,
  id: Number(r.id),
  benefitId: Number(r.benefitId),
  staffId: Number(r.staffId),
  createdAt: new Date(r.createdAt).toISOString(),
});

/** 会员详情「本月可享」：现在够格的已发布权益、本期发了几张 / 用了几次、还没够格的、最近的发放与登记 */
export async function memberBenefits(db: Db, memberId: number, date: string): Promise<MemberBenefits> {
  // 按推算到今天的档阶列（与等级卡一样）：到期还没处理的不按应该已经降掉的档阶列，登记时也按处理完的判断
  const own = await projectedGrade(db, memberId, date);
  if (!own) throw notFound('会员不存在');
  // 临时身份（v0.7.25，M51）：服务类、折扣类、制度说明按自己的与临时身份的取高的；券类、事件礼只按自己的（临时身份不发券）
  const m = await benefitState(db, memberId, own, date);
  const rules = await loadMembershipRules(db);
  const defs = await db<(BenefitDef & { templateName: string | null })[]>`
    SELECT ${DEF_COLUMNS(db)}, t.name AS template_name FROM benefits b LEFT JOIN coupon_templates t ON t.id = b.template_id
    WHERE b.status = 'published' ORDER BY b.sort_order, b.id`;
  const grants = await db<{ benefitId: number; reason: BenefitGrantReason; periodKey: string | null; quantity: number; businessDate: string; available: number }[]>`
    SELECT g.benefit_id, g.reason, g.period_key, g.quantity, g.business_date,
           (SELECT count(*)::int FROM coupons c WHERE c.issue_id = g.coupon_issue_id AND c.status = 'available'
              AND c.valid_from <= ${date} AND c.valid_to >= ${date}) AS available
    FROM benefit_grants g WHERE g.member_id = ${memberId}`;
  // 设了次数的按这一期数；不计次的数本月登记了几次
  const uses = await db<{ benefitId: number; periodKey: string | null; n: number; monthN: number }[]>`
    SELECT benefit_id, period_key, sum(quantity)::int AS n,
           coalesce(sum(quantity) FILTER (WHERE business_date >= ${`${date.slice(0, 7)}-01`}), 0)::int AS month_n
    FROM benefit_uses WHERE member_id = ${memberId} AND status = 'active' GROUP BY 1, 2`;
  const items: MemberBenefitItem[] = [];
  const upcoming: MemberBenefits['upcoming'] = [];
  for (const b of defs) {
    const id = Number(b.id);
    const st = b.category === 'coupon' || b.category === 'event' ? own : m;
    if (!benefitEligible(b, st.grade, st.tier)) {
      if (b.startGrade !== null) upcoming.push({ benefitId: id, code: b.code, name: b.name, category: b.category, startLabel: startLabel(b.startGrade, b.startTier) });
      continue;
    }
    const mine = grants.filter((g) => Number(g.benefitId) === id);
    const pk = b.category === 'service' && b.period === 'none' ? null : b.category === 'event' ? null : periodKey(b.period, date);
    const quantity = b.category === 'service' && b.period === 'none' ? null : benefitQuantity(b, st.grade, st.tier);
    const inPeriod = b.category === 'coupon' ? mine.filter((g) => g.reason !== 'event' && g.periodKey === pk) : mine;
    items.push({
      benefitId: id,
      code: b.code,
      name: b.name,
      category: b.category,
      period: b.period,
      startLabel: startLabel(b.startGrade, b.startTier),
      content: b.content,
      conditions: b.conditions,
      quantity: b.category === 'info' ? null : quantity,
      periodKey: b.category === 'coupon' || (b.category === 'service' && b.period !== 'none') ? pk : null,
      granted: b.category === 'event' ? mine.length : inPeriod.reduce((s, g) => s + g.quantity, 0),
      available: mine.reduce((s, g) => s + g.available, 0),
      used:
        b.category !== 'service'
          ? 0
          : pk === null
            ? uses.filter((u) => Number(u.benefitId) === id && u.periodKey === null).reduce((s, u) => s + u.monthN, 0)
            : (uses.find((u) => Number(u.benefitId) === id && u.periodKey === pk)?.n ?? 0),
      lastGrantDate: mine.length ? mine.map((g) => g.businessDate).sort().at(-1)! : null,
      templateName: b.templateName,
      events: b.events,
      discount:
        b.category === 'discount' && quantity !== null && b.discountTarget
          ? { rate: quantity, text: `结账时自动 · ${rateText(quantity)} · ${DISCOUNT_TARGET_LABELS[b.discountTarget]} · ${discountDaysText(b.weekdays, b.monthDays)}` }
          : null,
      extension: b.category === 'extension' && quantity !== null ? { minutes: quantity, text: `结账时自动 · 门票多 ${minutesText(quantity)}不跳档` } : null,
    });
  }
  upcoming.sort((x, y) => {
    const a = defs.find((d) => Number(d.id) === x.benefitId)!;
    const b = defs.find((d) => Number(d.id) === y.benefitId)!;
    return stateRank(a.startGrade!, a.startTier) - stateRank(b.startGrade!, b.startTier);
  });
  const recentGrants = await db<BenefitGrantRow[]>`${GRANT_SELECT(db)} WHERE g.member_id = ${memberId} ORDER BY g.id DESC LIMIT 30`;
  const recentUses = await db<BenefitUseRow[]>`${USE_SELECT(db)} WHERE u.member_id = ${memberId} ORDER BY u.id DESC LIMIT 30`;
  return {
    memberId,
    today: date,
    month: date.slice(0, 7),
    state: { grade: asGrade(m.grade), tier: m.tier as Tier | null, label: gradeLabel(rules, m.grade, m.tier) },
    items,
    upcoming: upcoming.slice(0, 8),
    grants: recentGrants.map((g) => ({ ...g, id: Number(g.id), benefitId: Number(g.benefitId), createdAt: new Date(g.createdAt).toISOString() })),
    uses: recentUses.map(toUse),
  };
}

const UseInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  benefitId: z.number('请选择权益').int().positive('请选择权益'),
  quantity: z.number('次数要是整数').int('次数要是整数').min(1, '至少 1 次').max(MAX_BENEFIT_LIMIT, `一次最多 ${MAX_BENEFIT_LIMIT} 次`).default(1),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
});

async function getUse(db: Db, id: number): Promise<BenefitUseRow> {
  const [r] = await db<BenefitUseRow[]>`${USE_SELECT(db)} WHERE u.id = ${id}`;
  if (!r) throw notFound('使用登记不存在');
  return toUse(r);
}

/**
 * 登记一次服务类权益的使用：已发布、会员够格；设了次数的本期（今天、本月、本年）已用 + 这次不超过上限（按会员现在的档阶），
 * 超过拒绝（BENEFIT_LIMIT）。同一编号重提返回原来那条；结果待确认时可以「确认作废」，之后原请求晚到也不生效
 */
export async function registerBenefitUse(deps: Deps, memberId: number, raw: unknown, ctx: OpContext): Promise<{ use: BenefitUseRow; replayed: boolean }> {
  const input = parse(UseInput, raw);
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; memberId: number; benefitId: number; quantity: number; note: string }[]>`
      SELECT id, member_id, benefit_id, quantity, note FROM benefit_uses WHERE client_key = ${input.clientKey}`;
    if (!p) return null;
    if (Number(p.memberId) !== memberId || Number(p.benefitId) !== input.benefitId || p.quantity !== input.quantity || p.note !== input.note) {
      throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次登记，请刷新页面后重新登记');
    }
    return Number(p.id);
  };
  const date = await today(deps.sql, deps.config.timezone, ctx.at);
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 先取操作编号的咨询锁、核对没有被「确认作废」（与作废串行）
      await assertNotFenced(tx, input.clientKey, 'benefit_use', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const [locked] = await tx<{ status: string }[]>`SELECT status FROM members WHERE id = ${memberId} FOR UPDATE`;
      if (!locked) throw notFound('会员不存在');
      if (locked.status !== 'active') throw unprocessable('MEMBER_FROZEN', '该会员已停用，不能登记权益使用');
      // 到期没处理的（到期处理这一位出错、锁等超时）先按规则处理掉，再按处理完的档阶判断够不够格、上限几次（Codex 自动审查 825e248）
      const m = (await settleMemberDue(tx, memberId, date))!;
      const [b] = await tx<BenefitDef[]>`SELECT ${DEF_COLUMNS(tx)} FROM benefits b WHERE b.id = ${input.benefitId} FOR SHARE`;
      if (!b) throw notFound('权益不存在');
      if (b.status !== 'published') throw unprocessable('BENEFIT_UNAVAILABLE', `「${b.code} ${b.name}」${b.status === 'paused' ? '已暂缓' : '还没发布'}，不能登记`);
      if (b.category !== 'service') {
        const why = b.category === 'coupon' || b.category === 'event' ? '发的券在结账时用' : b.category === 'discount' || b.category === 'extension' ? '结账时自动算' : '只在清单里显示';
        throw unprocessable('BENEFIT_NOT_SERVICE', `「${b.name}」是${BENEFIT_CATEGORY_LABELS[b.category]}，不用登记：${why}`);
      }
      // 赠送会籍（v0.7.25）：在会员详情的「邀请体验 / 赠送会籍」里赠送，同时登记一次使用；不单独登记（否则占了次数却没有给对方会籍）
      if (b.code === GIFT_BENEFIT_CODE) {
        throw unprocessable('BENEFIT_VIA_TRIAL', `「${b.name}」请在会员详情的「邀请体验 / 赠送会籍」里赠送（同时登记一次使用），不在这里单独登记`);
      }
      const rules = await loadMembershipRules(tx);
      // 临时身份（v0.7.25，M51）：服务类按自己的与临时身份的取高的
      const st = await benefitState(tx, memberId, m, date);
      if (!benefitEligible(b, st.grade, st.tier)) {
        throw unprocessable('BENEFIT_NOT_ELIGIBLE', `这位会员现在是「${gradeLabel(rules, st.grade, st.tier)}」${st.trial ? '（含体验中的）' : ''}，「${b.name}」从「${startLabel(b.startGrade, b.startTier)}」起才能享`);
      }
      const limit = b.period === 'none' ? null : benefitQuantity(b, st.grade, st.tier);
      const pk = limit === null ? null : periodKey(b.period, date);
      if (limit !== null) {
        const [used] = await tx<{ n: number }[]>`
          SELECT coalesce(sum(quantity), 0)::int AS n FROM benefit_uses
          WHERE member_id = ${memberId} AND benefit_id = ${b.id} AND period_key = ${pk} AND status = 'active'`;
        if (used!.n + input.quantity > limit) {
          const span = b.period === 'day' ? '今天' : b.period === 'month' ? '本月' : '今年';
          throw unprocessable('BENEFIT_LIMIT', `「${b.name}」${span}已用 ${used!.n} 次，上限 ${limit} 次${used!.n < limit ? `，最多还能登记 ${limit - used!.n} 次` : '，已经用完'}`, {
            used: used!.n,
            limit,
          });
        }
      }
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO benefit_uses (benefit_id, member_id, business_date, period_key, quantity, limit_at, note, staff_id, client_key)
        VALUES (${b.id}, ${memberId}, ${date}, ${pk}, ${input.quantity}, ${limit}, ${input.note}, ${ctx.actor.id}, ${input.clientKey})
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'benefit_used',
        targetType: 'member',
        targetId: memberId,
        detail: { useId: row!.id, code: b.code, name: b.name, quantity: input.quantity, period: pk, limit, note: input.note || undefined },
        ip: ctx.ip,
        businessDate: date,
      });
      return { id: Number(row!.id), replayed: false };
    });
    return { use: await getUse(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    // 同一编号并发提交：后到的一笔撞上唯一约束，按原来那条返回
    if (isUniqueViolation(error, 'benefit_uses_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { use: await getUse(deps.sql, id), replayed: true };
    }
    throw error;
  }
}

const VoidInput = z.object({ reason: z.string('请填写作废原因').trim().min(2, '请填写作废原因（至少 2 个字）').max(200, '原因最多 200 字') });

/** 作废登记错的使用（写原因）：本人当天登记的自己能作废，其余要「维护会员权益」的权限；已作废的原样返回 */
export async function voidBenefitUse(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<BenefitUseRow> {
  const { reason } = parse(VoidInput, raw);
  const date = await today(deps.sql, deps.config.timezone, ctx.at);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [u] = await tx<{ status: string; staffId: number; businessDate: string; memberId: number; benefitId: number; quantity: number }[]>`
      SELECT status, staff_id, business_date, member_id, benefit_id, quantity FROM benefit_uses WHERE id = ${id} FOR UPDATE`;
    if (!u) throw notFound('使用登记不存在');
    if (u.status === 'voided') return;
    // 赠送会籍时记的（v0.7.25）：在受邀会员的详情里撤销那次赠送，一并作废这条登记（只作废登记会留下没有占次数的会籍）
    const [trial] = await tx<{ memberId: number }[]>`SELECT member_id FROM member_trials WHERE benefit_use_id = ${id}`;
    if (trial) throw unprocessable('USE_OF_TRIAL', '这条登记是赠送会籍时记的：请在受邀会员的详情里撤销那次赠送（会一并作废这条登记）', { memberId: Number(trial.memberId) });
    if ((Number(u.staffId) !== ctx.actor.id || u.businessDate !== date) && !can(ctx.actor, 'benefit.publish')) {
      throw forbidden('只能作废自己今天登记的；其他的请店主或店总作废');
    }
    await tx`UPDATE benefit_uses SET status = 'voided', voided_by = ${ctx.actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'benefit_use_voided',
      targetType: 'member',
      targetId: Number(u.memberId),
      detail: { useId: id, benefitId: Number(u.benefitId), quantity: u.quantity, reason },
      ip: ctx.ip,
      businessDate: date,
    });
  });
  return getUse(deps.sql, id);
}

// ───────────────────────── 看板汇总 ─────────────────────────

/** 看板「会员体系」：本月权益发放与使用 */
export async function benefitSummary(db: Db, date: string): Promise<BenefitSummary> {
  const { from, to } = monthOf(date);
  const [g] = await db<{ coupons: number; members: number; monthly: number; topUp: number; event: number }[]>`
    SELECT coalesce(sum(quantity), 0)::int AS coupons, count(DISTINCT member_id)::int AS members,
           coalesce(sum(quantity) FILTER (WHERE reason = 'monthly'), 0)::int AS monthly,
           coalesce(sum(quantity) FILTER (WHERE reason = 'top_up'), 0)::int AS top_up,
           coalesce(sum(quantity) FILTER (WHERE reason = 'event'), 0)::int AS event
    FROM benefit_grants WHERE business_date BETWEEN ${from} AND ${to}`;
  const [u] = await db<{ uses: number; members: number }[]>`
    SELECT coalesce(sum(quantity), 0)::int AS uses, count(DISTINCT member_id)::int AS members
    FROM benefit_uses WHERE status = 'active' AND business_date BETWEEN ${from} AND ${to}`;
  const rows = await db<CatalogRow[]>`${CATALOG_SELECT(db, from, to)} ORDER BY b.sort_order, b.id`;
  const [job] = await db<BenefitJobRun[]>`SELECT ${JOB_COLUMNS(db)} FROM membership_job_runs WHERE job = 'benefits' ORDER BY business_date DESC LIMIT 1`;
  // 会员折扣（v0.7.25）：本月结账、没有反结账的
  const [md] = await db<{ count: number; amount: number; members: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(p.amount), 0)::bigint AS amount, count(DISTINCT p.discount_member_id)::int AS members
    FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    WHERE p.method = 'member_discount' AND c.status = 'completed' AND c.business_date BETWEEN ${from} AND ${to}`;
  return {
    memberDiscount: md!,
    from,
    to,
    published: rows.filter((r) => r.status === 'published').length,
    coupons: g!.coupons,
    members: g!.members,
    byReason: { monthly: g!.monthly, top_up: g!.topUp, event: g!.event },
    uses: u!.uses,
    useMembers: u!.members,
    rows: rows
      .filter((r) => r.monthCoupons || r.monthUses)
      .map((r) => ({ benefitId: Number(r.id), code: r.code, name: r.name, category: r.category, coupons: r.monthCoupons, members: r.monthMembers, uses: r.monthUses })),
    job: job ?? null,
  };
}

// ───────────────────────── 自检 ─────────────────────────

/**
 * 会员权益自检（cli check、备份核验）：① 发放记录与发券记录一致（会员、张数、种类，券的张数）；
 * ② 同一会员、同一项、同一期发的张数合计 = 这一期最大的应得累计（不超发）；③ 登记使用不超过登记时的上限；
 * ④ 最近一次自动发放跑完、没有出错
 */
export async function benefitChecks(db: Db): Promise<{ label: string; ok: boolean; detail: string }[]> {
  const [link] = await db<{ n: number; grants: number }[]>`
    SELECT (SELECT count(*) FROM benefit_grants g JOIN coupon_issues i ON i.id = g.coupon_issue_id
             WHERE i.kind <> 'benefit' OR i.member_id IS DISTINCT FROM g.member_id OR i.quantity <> g.quantity
                OR i.dedupe_key IS DISTINCT FROM g.dedupe_key)::int
           + (SELECT count(*) FROM coupon_issues i WHERE i.kind = 'benefit' AND NOT EXISTS (SELECT 1 FROM benefit_grants g WHERE g.coupon_issue_id = i.id))::int AS n,
           (SELECT count(*)::int FROM benefit_grants) AS grants`;
  const [over] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM benefit_grants WHERE reason <> 'event'
      GROUP BY benefit_id, member_id, period_key HAVING sum(quantity) <> max(target)) x`;
  const [uses] = await db<{ n: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE limit_at IS NOT NULL AND running > limit_at)::int AS n, count(*)::int AS total
    FROM (SELECT limit_at, sum(quantity) OVER (PARTITION BY member_id, benefit_id, period_key ORDER BY id) AS running
          FROM benefit_uses WHERE status = 'active') x`;
  const [last] = await db<{ businessDate: string; finishedAt: string | null; error: string | null }[]>`
    SELECT business_date, finished_at, error FROM membership_job_runs WHERE job = 'benefits' ORDER BY business_date DESC LIMIT 1`;
  const jobOk = !last || (!!last.finishedAt && !last.error);
  // 会员折扣（v0.7.25）：每笔对应一项折扣类权益，记了版本与折扣、有适用明细；一张结账单最多一笔，不与券抵扣、「优惠 / 免单」同在
  const [md] = await db<{ n: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE b.id IS NULL OR b.category <> 'discount' OR p.benefit_version > b.version
                              OR p.coupon_lines IS NULL OR cardinality(p.coupon_lines) = 0
                              OR EXISTS (SELECT 1 FROM checkout_payments o WHERE o.checkout_id = p.checkout_id AND o.id <> p.id
                                         AND o.method IN ('discount', 'store_coupon', 'member_discount')))::int AS n,
           count(*)::int AS total
    FROM checkout_payments p LEFT JOIN benefits b ON b.id = p.benefit_id WHERE p.method = 'member_discount'`;
  return [
    {
      label: '会员权益发放记录与发券记录一致',
      ok: link!.n === 0,
      detail: link!.n ? `${link!.n} 条发放记录与发券记录对不上` : `${link!.grants} 条发放记录都对得上发券记录`,
    },
    {
      label: '会员权益每期发放不超过应得',
      ok: over!.n === 0,
      detail: over!.n ? `${over!.n} 处同一会员、同一项、同一期发的张数与应得不符` : '每位会员每项每期发的张数都等于应得',
    },
    {
      label: '会员权益登记使用不超过次数',
      ok: uses!.n === 0,
      detail: uses!.n ? `${uses!.n} 条登记超过了当时的上限` : `${uses!.total} 条有效登记都没有超过上限`,
    },
    {
      label: '会员折扣：对应折扣类权益、一单一种、不与券和优惠同用',
      ok: md!.n === 0,
      detail: md!.n ? `${md!.n} 笔会员折扣对不上（不是折扣类、没有适用明细，或与券、优惠同在一张结账单）` : `${md!.total} 笔会员折扣都对得上`,
    },
    {
      label: '会员权益自动发放（每天的自动任务）',
      ok: jobOk,
      detail: !last
        ? '还没有运行记录'
        : !last.finishedAt
          ? `${last.businessDate} 的自动发放没有跑完`
          : last.error
            ? `${last.businessDate} 的自动发放出错：${last.error}`
            : `最近一次 ${last.businessDate}，跑完没有出错`,
    },
  ];
}

// ───────────────────────── 接口 ─────────────────────────

export function registerBenefitRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const todayNow = () => today(sql, deps.config.timezone);

  app.get('/api/benefits', { preHandler: guard('benefit.publish') }, async () => {
    const date = await todayNow();
    return readSnapshot(sql, (tx) => benefitCatalog(tx, date));
  });

  app.post('/api/benefits/import', { preHandler: guard('benefit.publish') }, async (req) => importCatalog(sql, req.actor.id, req.ip));

  app.put('/api/benefits/:id', { preHandler: guard('benefit.publish') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return updateBenefit(deps, id, req.body, ctxOf(req));
  });

  app.post('/api/benefits/:id/status', { preHandler: guard('benefit.publish') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return setBenefitStatus(deps, id, req.body, ctxOf(req));
  });

  app.get('/api/benefits/summary', { preHandler: guard() }, async (req) => {
    if (!can(req.actor, 'member.retention') && !can(req.actor, 'benefit.publish')) throw forbidden();
    const date = await todayNow();
    return readSnapshot(sql, (tx) => benefitSummary(tx, date));
  });

  app.get('/api/members/:id/benefits', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const date = await todayNow();
    return readSnapshot(sql, (tx) => memberBenefits(tx, id, date));
  });

  app.post('/api/members/:id/benefit-uses', { preHandler: guard('benefit.use') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const result = await registerBenefitUse(deps, id, req.body, ctxOf(req));
    if (!result.replayed) reply.code(201);
    return result;
  });

  app.post('/api/benefit-uses/:id/void', { preHandler: guard('benefit.use') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidBenefitUse(deps, id, req.body, ctxOf(req));
  });
}
