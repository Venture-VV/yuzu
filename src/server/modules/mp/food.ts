// 小程序第三期 3c：扫码点餐（小程序线，docs/MP_PHASE3.md 第 3 节；MP32、MP33）。主线 v0.7.28 的 orderFoodFromMp 下单。
//   · 设置（settings 的 mp_food_rules，带版本号）：开关、小程序可点的菜（在进厨房的菜里勾），后台「微信小程序 → 扫码点餐」（权限 mp.food）；
//   · 桌码：71 + 桌台编号（6 位）+ 签名（10 位）。签名用门店系统的 MP_CODE_SECRET（与会员码同一个密钥，签的内容不同），网关不存；
//     码里只有桌台编号：桌台改名照样认，停用的不认。拍照带出店也没用——还要这位会员有在店手牌；
//   · 点餐页：开没开、能不能点（绑定了会员、会员卡能用、有在店手牌）、扫到的桌、可点的菜（今天的估清；只列这张手牌能点的男宾 / 女宾项目）；
//   · 下单在一个事务里：这个微信的点餐咨询锁（与确认作废串行）→ 作废登记 → 绑定锁（共享）→ 同一个编号重提返回第一次 → 绑定版本号 →
//     设置、会员卡、可点的菜、桌码 → 主线的入口（它自己的编号锁 → 来访 → 账单 → 估清 → 出品单）→ 记下这一单。
//     结果不确定时请门店系统确认作废这个编号（取同一把点餐锁）：已经下了回那一单；还没有就登记作废，之后原请求再到也不下；
//   · 「我的账单」：主线的 mpOpenBill（只给名称、份数、金额、出品状态）。
// 不动钱：挂在顾客自己的手牌账单上，结账照旧在前台；顾客自己不能退菜（MP33），退菜请服务员。

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  MP_FOOD_MAX_ITEMS,
  MP_FOOD_LINE_MAX_QUANTITY,
  MP_FOOD_MAX_LINES,
  MP_FOOD_NOTE_MAX,
  MP_FOOD_RULES_KEY,
  MP_TABLE_CODE,
  type MpFoodAbandonResult,
  type MpFoodAdminData,
  type MpFoodAdminOrder,
  type MpFoodBill,
  type MpFoodDish,
  type MpFoodLine,
  type MpFoodMenu,
  type MpFoodOrdered,
  type MpFoodRules,
} from '@shared/mp';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import type { Deps, OpContext } from '../../lib/context';
import { AppError, conflict, unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { diningMenu } from '../dining';
import { mpDiningTables, mpOpenBill, orderFoodFromMp } from '../mp-entries';
import { loadSettings } from '../settings';
import { bindingStateOf, lockOpenidShared } from './member';
import { mpToday } from './public';
import { loadFoodRules } from './rules';

// ───────────────────────── 桌码 ─────────────────────────

const TABLE_PREFIX = '71';
const MAX_TABLE_ID = 999_999;
const tableMac = (secret: string, tableId: number) =>
  (createHmac('sha256', secret).update(`mptable:v1:${tableId}`).digest().readBigUInt64BE(0) % 10_000_000_000n).toString().padStart(10, '0');

/** 桌码：71 + 桌台编号（6 位）+ 签名（10 位）；编号超过 6 位的桌台没有桌码 */
export function makeTableCode(secret: string, tableId: number): string | null {
  if (!Number.isInteger(tableId) || tableId < 1 || tableId > MAX_TABLE_ID) return null;
  return `${TABLE_PREFIX}${String(tableId).padStart(6, '0')}${tableMac(secret, tableId)}`;
}

/** 桌码对不对：对的回桌台编号，不对回 null */
export function tableIdOf(secret: string, code: string): number | null {
  if (!MP_TABLE_CODE.test(code)) return null;
  const id = Number(code.slice(2, 8));
  if (id < 1) return null;
  return timingSafeEqual(Buffer.from(tableMac(secret, id)), Buffer.from(code.slice(8))) ? id : null;
}

/** 扫到的桌码 → 启用中的桌台；不对时写原因 */
async function resolveTable(deps: Deps, db: Db, code: string): Promise<{ table: { code: string; name: string } | null; notice: string | null }> {
  const secret = deps.config.mp.codeSecret;
  if (!secret) return { table: null, notice: '门店系统还没配好桌码，这一单不写桌号，服务员按手牌送' };
  const id = tableIdOf(secret, code);
  if (id === null) return { table: null, notice: '这不是本店的桌码，请扫桌上的码' };
  const t = (await mpDiningTables(db)).find((x) => Number(x.id) === id);
  if (!t) return { table: null, notice: '这张桌现在不能扫码点餐，请服务员点单' };
  return { table: { code, name: t.name }, notice: null };
}

// ───────────────────────── 小工具 ─────────────────────────

/** 同一个微信的下单、确认作废串行 */
const lockFood = (tx: Tx, openid: string) => tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_food:${openid}`}))`;

interface FoodRow {
  id: number;
  clientKey: string;
  bindingId: number;
  memberId: number;
  visitId: number;
  tagCode: string;
  orderNo: string | null;
  deliverTo: string;
  total: number;
  lines: MpFoodLine[];
  createdAt: string;
}

const orderedView = (r: FoodRow, replayed: boolean): MpFoodOrdered => ({
  orderNo: r.orderNo,
  tagCode: r.tagCode,
  deliverTo: r.deliverTo,
  total: Number(r.total),
  lines: r.lines,
  createdAt: new Date(r.createdAt).toISOString(),
  replayed,
});

/** 会员卡能不能用来点（合并掉的、停用的不行） */
async function memberProblem(db: Db, memberId: number): Promise<string | null> {
  const [m] = await db<{ status: string; mergedIntoId: number | null }[]>`SELECT status, merged_into_id FROM members WHERE id = ${memberId}`;
  if (!m) return '会员不存在';
  if (m.mergedIntoId !== null) return '这张会员卡已合并，请到前台换绑';
  if (m.status !== 'active') return '会员卡已停用，请服务员点单';
  return null;
}

const NO_VISIT = '开了手牌才能点：请先到前台开手牌（手牌挂上你的会员卡），或请服务员点单';

/** 这位会员的在店手牌：牌号与男宾 / 女宾 */
async function openVisitOf(db: Db, memberId: number): Promise<{ tagCode: string; zone: string } | null> {
  const [v] = await db<{ tagCode: string; zone: string }[]>`
    SELECT h.code AS tag_code, v.zone FROM visits v JOIN hand_tags h ON h.id = v.tag_id
    WHERE v.member_id = ${memberId} AND v.status = 'open'`;
  return v ?? null;
}

/** 主线的拒绝写给顾客看 */
function friendlyFoodError(error: unknown): unknown {
  if (!(error instanceof AppError)) return error;
  const say = (code: string, message: string) => new AppError(error.status, code, message, error.details);
  switch (error.code) {
    case 'NO_OPEN_VISIT':
      return say('NO_OPEN_VISIT', NO_VISIT);
    case 'ITEM_GENDER':
      return say('ITEM_GENDER', error.message.replace('这位客人是', '你的手牌是'));
    case 'DISH_NOT_KITCHEN':
      return say('DISH_NOT_OPEN', error.message.replace('不是点单的菜，请到前台登记', '不能在小程序点，请服务员点单'));
    case 'VISIT_CHANGED':
      return say('VISIT_CHANGED', '你的手牌刚刚变过，这一单没有下，请刷新后再点');
    case 'BILL_CLOSED':
      return say('BILL_CLOSED', '手牌的账单已经结了，不能再点；请到前台咨询');
    case 'VISIT_CLOSED':
      return say('VISIT_CLOSED', '你的手牌刚刚结账了，不能再点；请到前台咨询');
    case 'MP_CLAIM_CONFLICT':
      return say('CLIENT_KEY_REUSED', '这一单的编号已经用过，请重新下单');
    default:
      return error;
  }
}

// ───────────────────────── 设置 ─────────────────────────

const RulesInput = z.object({
  enabled: z.boolean(),
  itemIds: z.array(z.number().int().positive(), '可点的菜不对').max(MP_FOOD_MAX_ITEMS, `最多勾 ${MP_FOOD_MAX_ITEMS} 道菜`),
  version: z.number().int().min(0).optional(),
});

export async function saveFoodRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<MpFoodRules> {
  const input = parse(RulesInput, raw);
  return saveRuleSetting(
    deps.sql,
    MP_FOOD_RULES_KEY,
    loadFoodRules,
    async (before) => {
      if (input.version !== undefined && input.version !== before.version) throw conflict('VERSION_CONFLICT', '扫码点餐的设置刚被别人改过，请刷新后再改');
      const itemIds = [...new Set(input.itemIds)].sort((a, b) => a - b);
      return { enabled: input.enabled, itemIds, version: before.version + 1 };
    },
    ctx,
  );
}

// ───────────────────────── 顾客 ─────────────────────────

const MenuQuery = z.object({ table: z.string().max(40).optional() });

export async function foodMenu(deps: Deps, openid: string, query: unknown): Promise<MpFoodMenu> {
  const { table: tableCode } = parse(MenuQuery, query);
  const [rules, state, menu, settings] = await Promise.all([loadFoodRules(deps.sql), bindingStateOf(deps.sql, openid), diningMenu(deps.sql, deps), loadSettings(deps.sql)]);
  // 一单最多几份、多少钱：按后台「经营规则 → 可调的数值」（N1，主线 8.0.7）；下单时门店系统照同一份设置核对。
  // 一道菜最多几份、最多几道菜：账单、点单记录能存的上限（下单请求的格式也按这个挡）
  const limits = { maxQuantity: settings.mpFoodMaxQuantity, maxTotal: settings.mpFoodMaxTotalCents, maxLineQuantity: MP_FOOD_LINE_MAX_QUANTITY, maxLines: MP_FOOD_MAX_LINES };
  const open = rules.enabled && menu.rules.enabled;
  if (!open) {
    return { open: false, canOrder: false, notice: '扫码点餐还没开放，请服务员点单', bindVersion: state.version, bound: state.binding !== null, tagCode: null, table: null, tableNotice: null, dishes: [], limits };
  }
  const allowed = new Set(rules.itemIds);
  let dishes = menu.dishes.filter((d) => allowed.has(d.id));
  const t = tableCode ? await resolveTable(deps, deps.sql, tableCode) : { table: null, notice: null };
  let notice: string | null = null;
  let tagCode: string | null = null;
  if (!state.binding) {
    notice = '绑定会员后才能自己点：请到「我的」绑定，或请服务员点单';
  } else {
    notice = await memberProblem(deps.sql, state.binding.memberId);
    if (!notice) {
      const visit = await openVisitOf(deps.sql, state.binding.memberId);
      if (!visit) {
        notice = NO_VISIT;
      } else {
        tagCode = visit.tagCode;
        // 只限男宾或女宾的项目：只列这张手牌能点的
        if (dishes.length) {
          const restricted = await deps.sql<{ id: number; gender: string }[]>`
            SELECT id, gender FROM service_items WHERE id IN ${deps.sql(dishes.map((d) => d.id))} AND gender IS NOT NULL`;
          const other = new Set(restricted.filter((r) => r.gender !== visit.zone).map((r) => Number(r.id)));
          dishes = dishes.filter((d) => !other.has(d.id));
        }
      }
    }
  }
  if (!notice && dishes.length === 0) notice = '小程序上暂时没有可点的菜，请服务员点单';
  const out: MpFoodDish[] = dishes.map((d) => ({ id: d.id, name: d.name, group: d.stationName, price: d.price, remaining: d.remaining }));
  return { open: true, canOrder: notice === null, notice, bindVersion: state.version, bound: state.binding !== null, tagCode, table: t.table, tableNotice: t.notice, dishes: out, limits };
}

const OrderInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  items: z
    .array(
      z.object({
        itemId: z.number('菜品不对').int('菜品不对').positive('菜品不对'),
        // 一道菜最多几份是账单明细能存的上限；一单一共的上限按设置在下单时核对（MP_ORDER_LIMIT）
        quantity: z.number('份数不对').int('份数不对').min(1, '份数至少为 1').max(MP_FOOD_LINE_MAX_QUANTITY, `一道菜一单最多 ${MP_FOOD_LINE_MAX_QUANTITY} 份，多的请服务员点`),
        note: z.string().trim().max(MP_FOOD_NOTE_MAX, `口味备注最多 ${MP_FOOD_NOTE_MAX} 字`).optional(),
      }),
      '请选择菜品',
    )
    .min(1, '请至少选一道菜')
    .max(MP_FOOD_MAX_LINES, `一单最多 ${MP_FOOD_MAX_LINES} 道菜，多的请服务员点`),
  /** 扫到的桌码（没扫不带） */
  table: z.string().regex(MP_TABLE_CODE, '桌码不对，请重新扫桌上的码').optional(),
  /** 小程序上看到的合计（分）：价格刚改过时拒绝（PRICE_CHANGED） */
  expectedTotal: z.number('请刷新后再下单').int().nonnegative(),
  bindVersion: z.number('请刷新后再下单').int().min(0),
});

export async function orderFood(deps: Deps, openid: string, raw: unknown): Promise<MpFoodOrdered> {
  const input = parse(OrderInput, raw);
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockFood(tx, openid);
      const [fenced] = await tx`SELECT 1 FROM mp_op_fences WHERE key = ${input.clientKey} AND op_type = 'mp_food' AND openid = ${openid}`;
      if (fenced) throw conflict('OP_ABANDONED', '这一单已经放弃，没有下；请重新下单');
      await lockOpenidShared(tx, openid);
      const state = await bindingStateOf(tx, openid);
      const [prev] = await tx<FoodRow[]>`SELECT * FROM mp_food_orders WHERE client_key = ${input.clientKey}`;
      if (prev) {
        // 同一个编号重提：只认下单的那条绑定
        if (!state.binding || Number(prev.bindingId) !== state.binding.id) throw conflict('CLIENT_KEY_REUSED', '这一单的编号已经用过，请重新下单');
        return orderedView(prev, true);
      }
      if (!state.binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
      if (state.version !== input.bindVersion) throw conflict('BIND_STALE', '会员绑定刚变过，这一单没有下，请刷新后再点');
      const rules = await loadFoodRules(tx);
      if (!rules.enabled) throw new AppError(403, 'MP_FOOD_DISABLED', '扫码点餐还没开放，请服务员点单');
      const memberId = state.binding.memberId;
      const problem = await memberProblem(tx, memberId);
      if (problem) throw unprocessable('MEMBER_UNAVAILABLE', problem);
      const allowed = new Set(rules.itemIds);
      const off = input.items.find((i) => !allowed.has(i.itemId));
      if (off) {
        const [it] = await tx<{ name: string }[]>`SELECT name FROM service_items WHERE id = ${off.itemId}`;
        throw unprocessable('DISH_NOT_OPEN', `「${it?.name ?? '这道菜'}」不能在小程序点，请服务员点单`);
      }
      let tableName: string | null = null;
      // 门店系统没配签名密钥时认不了桌码：照点餐页说的，不写桌号、服务员按手牌送（独立审查 3b/3c 的 P3）
      if (input.table && deps.config.mp.codeSecret) {
        const t = await resolveTable(deps, tx, input.table);
        if (!t.table) throw unprocessable('TABLE_CODE_INVALID', t.notice ?? '桌码不对，请重新扫桌上的码');
        tableName = t.table.name;
      }
      const r = await orderFoodFromMp(tx, deps, {
        memberId,
        items: input.items.map((i) => ({ itemId: i.itemId, quantity: i.quantity, ...(i.note ? { note: i.note } : {}) })),
        ...(tableName ? { tableCode: tableName } : {}),
        expectedTotal: input.expectedTotal,
        claimKey: input.clientKey,
      });
      const lines: MpFoodLine[] = r.lines.map((l) => ({ name: l.name, quantity: l.quantity, amount: l.amount, note: l.note }));
      const [row] = await tx<FoodRow[]>`
        INSERT INTO mp_food_orders (client_key, binding_id, member_id, visit_id, tag_code, order_no, deliver_to, total, lines)
        VALUES (${input.clientKey}, ${state.binding.id}, ${memberId}, ${r.visitId}, ${r.tagCode}, ${r.orderNo}, ${r.deliverTo}, ${r.total}, ${tx.json(lines as never)})
        RETURNING *`;
      return orderedView(row!, false);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'mp_food_orders_client_key_key')) throw conflict('CLIENT_KEY_REUSED', '这一单的编号已经用过，请重新下单');
    throw friendlyFoodError(error);
  }
}

const AbandonInput = z.object({ clientKey: z.uuid('操作编号不正确') });

/** 下单结果不确定时：已经下了返回那一单；还没有就登记作废（与下单取同一把点餐锁，作废以后原请求再到也不下） */
export async function abandonFoodOrder(deps: Deps, openid: string, raw: unknown): Promise<MpFoodAbandonResult> {
  const { clientKey } = parse(AbandonInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockFood(tx, openid);
    const [r] = await tx<(FoodRow & { openid: string | null })[]>`
      SELECT f.*, b.openid FROM mp_food_orders f JOIN mp_bindings b ON b.id = f.binding_id WHERE f.client_key = ${clientKey}`;
    if (r) {
      if (r.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这一单的编号已经用过，请重新下单');
      return { status: 'ordered' as const, ordered: orderedView(r, true) };
    }
    await tx`INSERT INTO mp_op_fences (key, op_type, openid) VALUES (${clientKey}, 'mp_food', ${openid}) ON CONFLICT (key, op_type) DO NOTHING`;
    const [fence] = await tx<{ openid: string }[]>`SELECT openid FROM mp_op_fences WHERE key = ${clientKey} AND op_type = 'mp_food'`;
    if (fence?.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这一单的编号已经用过，请重新下单');
    return { status: 'abandoned' as const };
  });
}

/** 「我的账单」：这位会员在店手牌的账单（结账照旧在前台） */
export async function foodBill(deps: Deps, openid: string): Promise<MpFoodBill> {
  const none = (notice: string): MpFoodBill => ({ open: false, notice, tagCode: null, checkedInAt: null, lines: [], total: 0 });
  const state = await bindingStateOf(deps.sql, openid);
  if (!state.binding) return none('请先绑定会员');
  const bill = await mpOpenBill(deps.sql, state.binding.memberId);
  if (!bill) return none('现在没有在店手牌：开了手牌、挂上你的会员卡以后，这里能看到点了什么');
  return {
    open: true,
    notice: null,
    tagCode: bill.tagCode,
    checkedInAt: bill.checkedInAt,
    lines: bill.lines.map((l) => ({ name: l.name, quantity: l.quantity, amount: l.amount, postedAt: l.postedAt, status: l.dishStatus })),
    total: bill.total,
  };
}

// ───────────────────────── 后台 ─────────────────────────

export async function foodAdminData(deps: Deps): Promise<MpFoodAdminData> {
  const [rules, menu, tables, today] = await Promise.all([loadFoodRules(deps.sql), diningMenu(deps.sql, deps), mpDiningTables(deps.sql), mpToday(deps.sql, deps.config.timezone)]);
  const open = new Set(rules.itemIds);
  const secret = deps.config.mp.codeSecret;
  const rows = await deps.sql<(FoodRow & { memberName: string })[]>`
    SELECT f.*, m.name AS member_name FROM mp_food_orders f JOIN members m ON m.id = f.member_id ORDER BY f.id DESC LIMIT 50`;
  // 今天（营业日）：按来访的营业日算（挂在今天开的手牌上的）
  const [t] = await deps.sql<{ orders: number; total: number }[]>`
    SELECT count(*)::int AS orders, coalesce(sum(f.total), 0)::bigint AS total
    FROM mp_food_orders f JOIN visits v ON v.id = f.visit_id WHERE v.business_date = ${today}`;
  const recent: MpFoodAdminOrder[] = rows.map((r) => ({
    id: Number(r.id),
    createdAt: new Date(r.createdAt).toISOString(),
    memberId: Number(r.memberId),
    memberName: r.memberName,
    tagCode: r.tagCode,
    orderNo: r.orderNo,
    deliverTo: r.deliverTo,
    total: Number(r.total),
    lines: r.lines,
  }));
  return {
    rules,
    diningEnabled: menu.rules.enabled,
    tableCodeReady: secret !== null,
    dishes: menu.dishes.map((d) => ({ id: d.id, name: d.name, group: d.stationName, price: d.price, remaining: d.remaining, open: open.has(d.id) })),
    tables: tables.map((x) => ({ id: Number(x.id), name: x.name, area: x.area, code: secret ? makeTableCode(secret, Number(x.id)) : null })),
    today: { orders: t?.orders ?? 0, total: Number(t?.total ?? 0) },
    recent,
  };
}
