// 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）：设置、图片、平板上看到的菜单、按手牌找客人、下单、结果待确认的查回与作废。
//
// 钱只在账单明细里：平板下单就是给客人挂账，与点单页、小程序扫码点餐同一条路径（frontdesk/bills.ts 的 postChargesTx，
// 同一个事务里扣沽清、建出品单、写操作编号），这里另写一行点餐单（emenu_orders：桌号、人数、备注、确认的服务员、哪台平板）。
// 经办人是输点单密码的那位服务员（emenu/pins.ts），不是平板登录的账号。
//
// 加锁：点单密码在事务外核对（不加锁）；事务里与点单页下单同一套——来访 → 账单 → 沽清 → 出品单，之后写点餐单一行；
// 写操作编号前照旧与「确认作废」串行（业务类型 bill_post）。读电子菜单的分类、版面、菜品都不加锁。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defaultTier, type TierPrice } from '@shared/catalog';
import { DINING_OUTLET_KEYS, diningSlotOf, MAX_BILL_LINE_QUANTITY, MAX_TABLE_NAME, type DiningOutlet } from '@shared/dining';
import { OUTLET_ORDER_PERMISSIONS } from '@shared/dining-v8115';
import { can } from '@shared/permissions';
import {
  composeEmenuNote,
  DEFAULT_EMENU_RULES,
  emenuImageUrl,
  EMENU_MAX_CUSTOM_NOTE,
  EMENU_MAX_GUESTS,
  EMENU_MAX_LINES,
  EMENU_MAX_NOTE,
  EMENU_MAX_OPTION_LENGTH,
  matchByDigits,
  matchTable,
  minutesToNextChange,
  minuteOfDay,
  normalizePeriods,
  periodAt,
  periodsCover,
  periodWindow,
  sortPeriods,
  windowOpen,
  type EmenuPeriodKey,
  type EmenuCategoryView,
  type EmenuDishView,
  type EmenuGuest,
  type EmenuLaterDish,
  type EmenuLayout,
  type EmenuMenu,
  type EmenuOpLookup,
  type EmenuOrderResult,
  type EmenuPageView,
  type EmenuRules,
  type EmenuComboSwapPart,
  type EmenuSpecOptions,
  type EmenuSpecState,
  type EmenuWindow,
} from '@shared/emenu';
import { normalizeTagCode } from '@shared/frontdesk';
import { MAX_IMAGE_BYTES } from '@shared/requests';
import type { Db, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { isFenced } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { parse, positiveCents } from '../../lib/validate';
import { loadDiningRules } from '../dining';
import { assertOrderOutlets } from '../dining-order-v8115';
import { DishLineFields } from '../dish-lines';
import { comboRemainingOf, dishOptionsOf } from '../dish-options';
import { postChargesTx } from '../frontdesk/bills';
import { assertOpen, businessDate, lockVisits, runIdempotent } from '../frontdesk/common';
import { abandonFrontdeskOp } from '../frontdesk/visits';
import { pricesColumn } from '../pricing';
import { resolveWaiter } from './pins';
import { settingRow } from '../../lib/store-settings';
import { currentStoreId } from '../../lib/store-context';
import { studioPublishedRef } from '../studio/published';

// ───────────────────────── 设置 ─────────────────────────

export async function loadEmenuRules(db: Db): Promise<EmenuRules> {
  const row = await settingRow<Partial<EmenuRules>>(db, 'emenu_rules');
  const rules = { ...DEFAULT_EMENU_RULES, ...row?.value };
  // 早中晚时段（8.1.5）：8.1.5 以前存的设置里没有这一项，用默认；按早中晚排好
  return { ...rules, periods: normalizePeriods(rules.periods) };
}

/** 平板点餐现在能不能用：自己的开关与餐饮功能都开着 */
export async function emenuEnabled(db: Db): Promise<boolean> {
  return (await loadEmenuRules(db)).enabled && (await loadDiningRules(db)).enabled;
}

const disabledError = () => unprocessable('EMENU_DISABLED', '平板点餐没有开启，请店主在「后台 → 电子菜单 → 设置」里打开（还要开着餐饮功能）');

// ───────────────────────── 图片 ─────────────────────────

const ImageInput = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp'], '只能上传 JPEG、PNG、WebP 图片'),
  data: z.string('图片内容为空').min(16, '图片内容为空').max(1_500_000, '图片太大'),
});

/** 按文件头认图片格式（与采购单、小程序图片同样的认法） */
function sniff(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** 存一张图片（上传前浏览器已压缩）：同一张图只存一份，返回它的编号 */
export async function saveEmenuImage(db: Db, raw: unknown, actor: Actor): Promise<{ id: number; url: string }> {
  const input = parse(ImageInput, raw);
  const buf = Buffer.from(input.data, 'base64');
  if (buf.length === 0) throw badRequest('图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw unprocessable('IMAGE_TOO_LARGE', '图片压缩后仍超过 1 MB，请换一张或裁小一点');
  const kind = sniff(buf);
  if (!kind || kind !== input.mime) throw unprocessable('IMAGE_INVALID', '文件不是有效的 JPEG、PNG 或 WebP 图片');
  const sha = createHash('sha256').update(buf).digest('hex');
  const [row] = await db<{ id: number }[]>`
    INSERT INTO emenu_images (sha256, mime, data, size_bytes, created_by) VALUES (${sha}, ${kind}, ${buf}, ${buf.length}, ${actor.id})
    ON CONFLICT (sha256) DO NOTHING RETURNING id`;
  const id = Number(row?.id ?? (await db<{ id: number }[]>`SELECT id FROM emenu_images WHERE sha256 = ${sha}`)[0]!.id);
  return { id, url: emenuImageUrl(id)! };
}

export async function emenuImage(db: Db, id: number): Promise<{ mime: string; data: Buffer }> {
  const [img] = await db<{ mime: string; data: Buffer }[]>`SELECT mime, data FROM emenu_images WHERE id = ${id}`;
  if (!img) throw notFound('图片不存在');
  return img;
}

// ───────────────────────── 平板上看到的菜单 ─────────────────────────

const windowOf = (start: number | null, end: number | null): EmenuWindow | null => (start === null || end === null ? null : { start, end });

interface DishRow {
  id: number;
  name: string;
  nameEn: string;
  tagline: string;
  description: string;
  attrs: string[];
  unit: string;
  taglineEn: string;
  descriptionEn: string;
  attrsEn: string[];
  unitEn: string;
  imageId: number | null;
  detailImageId: number | null;
  active: boolean;
}

interface SpecRow {
  dishId: number;
  itemId: number;
  label: string;
  labelEn: string;
  itemActive: boolean;
  technicianRequired: boolean;
  inKitchen: boolean;
  prices: TierPrice[];
  remaining: number | null;
  /** 出品口（8.1.17：这台平板的岗位能不能在这一处下单） */
  category: string;
  diningOutlet: string | null;
  diningGroup: string;
  stationName: string | null;
}

/** 一个价目项目在哪个出品口（后台没设的按默认归，与点单页同一个口径） */
const outletOf = (r: Pick<SpecRow, 'category' | 'diningOutlet' | 'diningGroup' | 'stationName'>): DiningOutlet =>
  diningSlotOf({ outlet: r.diningOutlet, group: r.diningGroup, category: r.category, stationName: r.stationName }).outlet;

/**
 * 这台平板能在哪几处下单（8.1.17 BW3）：打开平板点餐的账号（「点餐平板」岗位，或在平板上登录的员工）按自己的三项下单权限；
 * 后台预览、工作台看菜单的不限（null）
 */
export const tabletOutlets = (actor: Actor | null | undefined): DiningOutlet[] | null =>
  actor && can(actor, 'emenu.view') ? DINING_OUTLET_KEYS.filter((o) => can(actor, OUTLET_ORDER_PERMISSIONS[o])) : null;

const defaultPrice = (prices: TierPrice[]) => {
  const tier = defaultTier(prices);
  return prices.find((p) => p.tier === tier)?.price ?? prices[0]!.price;
};

/**
 * 这几道菜在平板上的样子：图文、每个规格的价格（默认价格档）与现在能不能点。
 * 已下架：菜品图文停用、价目项目停用、不挂在启用的出品档口上、改成了需要技师，或餐饮功能关着；已售罄：今天的沽清为 0；
 * 请找服务员点（8.1.17）：allowed 给了的，这道菜的出品口不在里面（这台平板的岗位不能在那一处下单）。
 * 8.1.17（BW9）：有做法、加料的规格带上做法（分组、加价、必选）与加料（各自的价、能不能点）
 */
export async function dishViews(db: Db, dishIds: number[], today: string, diningOn: boolean, allowed: readonly DiningOutlet[] | null = null): Promise<Map<number, EmenuDishView>> {
  const ids = [...new Set(dishIds)];
  if (ids.length === 0) return new Map();
  const dishes = await db<DishRow[]>`
    SELECT id, name, name_en, tagline, description, attrs, unit, tagline_en, description_en, attrs_en, unit_en, image_id, detail_image_id, active
    FROM emenu_dishes WHERE id IN ${db(ids)}`;
  const specs = await db<SpecRow[]>`
    SELECT sp.dish_id, sp.item_id, sp.label, sp.label_en, i.active AS item_active, i.technician_required, (st.id IS NOT NULL) AS in_kitchen, ${pricesColumn(db)} AS prices,
           (SELECT dl.remaining FROM dish_limits dl WHERE dl.item_id = i.id AND dl.business_date = ${today}) AS remaining,
           i.category, i.dining_outlet, i.dining_group, st.name AS station_name
    FROM emenu_dish_specs sp JOIN service_items i ON i.id = sp.item_id LEFT JOIN kitchen_stations st ON st.id = i.station_id AND st.active
    WHERE sp.dish_id IN ${db(ids)} ORDER BY sp.dish_id, sp.sort_no, sp.item_id`;
  const options = await specOptions(
    db,
    specs.map((s) => Number(s.itemId)),
    today,
    allowed,
  );
  // 套餐（8.1.17 BW7）：今天还能卖几份按子项里最少的（与点单页的菜单同一个算法）
  const comboLeft = await comboRemainingOf(
    db,
    [...options].filter(([, o]) => o.comboIds).map(([id]) => id),
    today,
  );
  const out = new Map<number, EmenuDishView>();
  for (const d of dishes) {
    out.set(Number(d.id), {
      id: Number(d.id),
      name: d.name,
      nameEn: d.nameEn,
      tagline: d.tagline,
      description: d.description,
      attrs: d.attrs,
      unit: d.unit,
      taglineEn: d.taglineEn,
      descriptionEn: d.descriptionEn,
      attrsEn: d.attrsEn,
      unitEn: d.unitEn,
      imageUrl: emenuImageUrl(d.imageId),
      detailUrl: emenuImageUrl(d.detailImageId),
      specs: specs
        .filter((s) => Number(s.dishId) === Number(d.id))
        .map((s) => {
          const off = !diningOn || !d.active || !s.itemActive || s.technicianRequired || !s.inKitchen;
          const left = comboLeft.get(Number(s.itemId)) ?? null;
          const remaining = left === null ? s.remaining : s.remaining === null ? left : Math.min(s.remaining, left);
          const state: EmenuSpecState = off ? 'off' : allowed && !allowed.includes(outletOf(s)) ? 'unavailable' : remaining === 0 ? 'sold_out' : 'ok';
          const o = options.get(Number(s.itemId))?.view;
          return { itemId: Number(s.itemId), label: s.label, labelEn: s.labelEn, price: defaultPrice(s.prices), state, remaining, ...(o ? { options: o } : {}) };
        }),
    });
  }
  return out;
}

/**
 * 规格的做法与加料（8.1.17 BW9）：做法照菜品管理里设的（分组、加价、必选）；加料只列现在能点的（在售、挂在启用的档口上），
 * 带上各自的价（默认档）、今天的沽清与这台平板能不能点（出品口）。没有做法、加料的规格不在返回里
 */
async function specOptions(db: Db, itemIds: number[], today: string, allowed: readonly DiningOutlet[] | null): Promise<Map<number, { view: EmenuSpecOptions | null; comboIds: boolean }>> {
  const sets = await dishOptionsOf(db, itemIds);
  const addonIds = [...new Set([...sets.values()].flatMap((o) => o.addons.map((a) => a.id)))];
  // 套餐可换的子项（8.1.17 BW7）：原来的与能换成的今天的沽清（不够一份套餐的算售罄）
  const swapIds = [...new Set([...sets.values()].flatMap((o) => o.combo.filter((p) => p.swaps?.length).flatMap((p) => [p.itemId, ...p.swaps!.map((w) => w.itemId)])))];
  const limits = new Map(
    swapIds.length
      ? (await db<{ itemId: number; remaining: number }[]>`SELECT item_id, remaining FROM dish_limits WHERE item_id IN ${db(swapIds)} AND business_date = ${today}`).map((r) => [
          Number(r.itemId),
          r.remaining,
        ])
      : [],
  );
  const short = (itemId: number, perCombo: number) => (limits.get(itemId) ?? Infinity) < perCombo;
  const addonRows = addonIds.length
    ? await db<{ id: number; remaining: number | null; category: string; diningOutlet: string | null; diningGroup: string; stationName: string | null }[]>`
        SELECT i.id, (SELECT dl.remaining FROM dish_limits dl WHERE dl.item_id = i.id AND dl.business_date = ${today}) AS remaining,
               i.category, i.dining_outlet, i.dining_group, s.name AS station_name
        FROM service_items i LEFT JOIN kitchen_stations s ON s.id = i.station_id WHERE i.id IN ${db(addonIds)}`
    : [];
  const out = new Map<number, { view: EmenuSpecOptions | null; comboIds: boolean }>();
  for (const [itemId, o] of sets) {
    const swaps = o.combo
      .filter((p) => p.swaps?.length)
      .map(
        (p): EmenuComboSwapPart => ({
          itemId: p.itemId,
          name: p.name,
          quantity: p.quantity,
          state: short(p.itemId, p.quantity) ? 'sold_out' : 'ok',
          choices: p.swaps!.map((w) => ({ itemId: w.itemId, name: w.name, priceDiff: w.priceDiff, state: !w.available ? 'off' : short(w.itemId, p.quantity) ? 'sold_out' : 'ok' })),
        }),
      );
    const comboIds = o.combo.length > 0;
    if (o.methods.length === 0 && o.addons.length === 0 && swaps.length === 0) {
      if (comboIds) out.set(itemId, { view: null, comboIds });
      continue;
    }
    out.set(itemId, {
      comboIds,
      view: {
        methods: o.methods,
        groups: o.groups,
        addons: o.addons.map((a) => {
          const r = addonRows.find((x) => Number(x.id) === a.id);
          const state: EmenuSpecState = r && allowed && !allowed.includes(outletOf(r)) ? 'unavailable' : r?.remaining === 0 ? 'sold_out' : 'ok';
          return { itemId: a.id, name: a.name, price: a.price, state, remaining: r?.remaining ?? null };
        }),
        ...(swaps.length ? { swaps } : {}),
      },
    });
  }
  return out;
}

export async function emenuTables(db: Db): Promise<{ name: string; area: string }[]> {
  return db<{ name: string; area: string }[]>`SELECT name, area FROM dining_tables WHERE active AND store_id = ${currentStoreId()} ORDER BY sort_order, id`;
}

/**
 * 工作台按某一段看菜单（8.1.5，PP8）：早餐 / 午餐 / 晚餐只显示那一段的分类（分类另外限定的时间不算），all 全部分类都显示；
 * 不给是现在（与平板一样）
 */
export type EmenuMenuView = EmenuPeriodKey | 'all';

/**
 * 平板上的菜单：设置、现在显示的分类与各页、每道菜的状态、桌台。每 15 秒取一次，价格、沽清、上下架、版面都跟得上；
 * 时段交界（8.1.5）与分类另外限定时间的起止由 nextChangeAt 告诉平板，到点马上再取。
 */
export async function emenuMenu(db: Db, deps: Deps, view?: EmenuMenuView, actor?: Actor): Promise<EmenuMenu> {
  const now = new Date();
  const today = await businessDate(db, deps, now);
  const rules = await loadEmenuRules(db);
  const diningOn = (await loadDiningRules(db)).enabled;
  const minute = minuteOfDay(now, deps.config.timezone);
  const cats = await db<{ id: number; name: string; nameEn: string; periods: string[]; startMinute: number | null; endMinute: number | null }[]>`
    SELECT id, name, name_en, periods, start_minute, end_minute FROM emenu_categories WHERE active ORDER BY sort_order, id`;
  const pages = await db<{ id: number; categoryId: number; layout: EmenuLayout; title: string; titleEn: string }[]>`
    SELECT p.id, p.category_id, p.layout, p.title, p.title_en FROM emenu_pages p JOIN emenu_categories c ON c.id = p.category_id AND c.active
    ORDER BY p.category_id, p.sort_no`;
  const slots = pages.length
    ? await db<{ pageId: number; slotNo: number; dishId: number }[]>`
        SELECT page_id, slot_no, dish_id FROM emenu_page_dishes WHERE page_id IN ${db(pages.map((p) => p.id))} ORDER BY page_id, slot_no`
    : [];
  const dishes = await dishViews(
    db,
    slots.map((s) => Number(s.dishId)),
    today,
    diningOn,
    tabletOutlets(actor),
  );

  // 现在是哪一段：工作台按某一段看时是那一段，看全部时没有
  const nowPeriod = periodAt(rules.periods, minute);
  const viewPeriod = view === 'all' ? null : view ? rules.periods.find((p) => p.key === view)! : nowPeriod;
  const categories: EmenuCategoryView[] = [];
  const later: EmenuMenu['later'] = [];
  for (const c of cats) {
    const window = windowOf(c.startMinute, c.endMinute);
    const periods = sortPeriods(c.periods);
    // 在这一段（或全天）并且在另外限定的时间里；工作台按某一段看时不算另外限定的时间，看全部时都算开着
    const open = viewPeriod === null ? true : periodsCover(periods, viewPeriod.key) && (view ? true : windowOpen(window, minute));
    const mine = pages.filter((p) => Number(p.categoryId) === Number(c.id));
    // 一页都没排的分类不显示（后台还在编）
    if (mine.length === 0) continue;
    if (!open && rules.offHours === 'hide') {
      // 这一类里的菜：「未下单」里还有的照旧显示菜名、规格与价格（刷新页面以后也一样），标「当前时段不可售」
      const laterDishes = new Map<number, EmenuLaterDish>();
      for (const p of mine)
        for (const sl of slots) {
          const d = Number(sl.pageId) === Number(p.id) ? dishes.get(Number(sl.dishId)) : undefined;
          if (!d || laterDishes.has(d.id)) continue;
          laterDishes.set(d.id, {
            id: d.id,
            name: d.name,
            nameEn: d.nameEn,
            tagline: d.tagline,
            taglineEn: d.taglineEn,
            specs: d.specs.map((sp) => ({ itemId: sp.itemId, label: sp.label, labelEn: sp.labelEn, price: sp.price, state: sp.state })),
          });
        }
      later.push({ name: c.name, nameEn: c.nameEn, periods, window, dishes: [...laterDishes.values()] });
      continue;
    }
    const views: EmenuPageView[] = mine.map((p) => {
      const mineSlots = slots.filter((s) => Number(s.pageId) === Number(p.id));
      const size = mineSlots.reduce((m, s) => Math.max(m, s.slotNo + 1), 0);
      const list: (EmenuDishView | null)[] = Array.from({ length: size }, () => null);
      for (const s of mineSlots) list[s.slotNo] = dishes.get(Number(s.dishId)) ?? null;
      return { layout: p.layout, title: p.title, titleEn: p.titleEn, dishes: list };
    });
    categories.push({ id: Number(c.id), name: c.name, nameEn: c.nameEn, periods, window, open, pages: views });
  }
  // 下一次可能有分类开、关：到那一分钟的 0 秒（平板到点再取）
  const next = view
    ? null
    : new Date(
        Math.floor(now.getTime() / 60_000) * 60_000 +
          minutesToNextChange(
            minute,
            rules.periods,
            cats.map((c) => windowOf(c.startMinute, c.endMinute)),
          ) *
            60_000,
      );
  return {
    serverTime: now.toISOString(),
    businessDate: today,
    enabled: rules.enabled && diningOn,
    period: viewPeriod ? { ...viewPeriod, end: periodWindow(rules.periods, viewPeriod.key).end } : null,
    nextChangeAt: next ? next.toISOString() : null,
    rules: {
      footerText: rules.footerText,
      avoidOptions: rules.avoidOptions,
      serveOptions: rules.serveOptions,
      idleMinutes: rules.idleMinutes,
      offHours: rules.offHours,
      langSwitch: rules.langSwitch,
      optionsEn: rules.optionsEn,
      motion: rules.motion,
      requirePin: rules.requirePin,
      textSize: rules.textSize,
      periods: rules.periods,
      coverUrl: emenuImageUrl(rules.coverImageId),
    },
    categories,
    later,
    studio: await studioPublishedRef(db, 'emenu'),
    tables: await emenuTables(db),
  };
}

// ───────────────────────── 按手牌找客人、已下单 ─────────────────────────

/** 这次来访在平板上看到的：手牌号、有效的餐饮明细与合计（不含会员姓名、手机号、余额与别的消费） */
export async function emenuGuestOf(db: Db, visitId: number): Promise<EmenuGuest> {
  const [v] = await db<{ id: number; billId: number; tagCode: string }[]>`
    SELECT v.id, v.bill_id, h.code AS tag_code FROM visits v JOIN hand_tags h ON h.id = v.tag_id WHERE v.id = ${visitId}`;
  if (!v) throw notFound('来访不存在');
  const ordered = await db<{ lineId: number; itemId: number | null; name: string; nameEn: string; quantity: number; amount: number }[]>`
    SELECT l.id AS line_id, l.item_id, l.name, coalesce(d.name_en, '') AS name_en, l.quantity, l.amount
    FROM bill_lines l LEFT JOIN emenu_dish_specs sp ON sp.item_id = l.item_id LEFT JOIN emenu_dishes d ON d.id = sp.dish_id
    WHERE l.bill_id = ${v.billId} AND l.source = 'dining' AND l.status = 'active' ORDER BY l.id`;
  const lines = ordered.map((l) => ({ ...l, lineId: Number(l.lineId), itemId: l.itemId === null ? null : Number(l.itemId), amount: Number(l.amount) }));
  return { visitId: Number(v.id), tagCode: v.tagCode, ordered: lines, orderedTotal: lines.reduce((s, l) => s + l.amount, 0) };
}

const TagInput = z.object({ tag: z.string('请输入手牌号').trim().min(1, '请输入手牌号').max(16, '手牌号太长') });

/**
 * 按输入的手牌找在店客人（DC4）：键盘只有数字，输入全是数字时与牌号的数字部分相同也算（8060 → A8060）。
 * 对不上：TAG_NOT_IN_STORE；数字对得上几张在店的牌：TAG_AMBIGUOUS（带候选，页面让客人点选）
 */
export async function emenuGuest(db: Db, raw: unknown): Promise<EmenuGuest> {
  if (!(await emenuEnabled(db))) throw disabledError();
  const { tag } = parse(TagInput, raw);
  const q = normalizeTagCode(tag);
  if (!/^[A-Z0-9]+$/.test(q)) throw badRequest('手牌号只有字母与数字', { field: 'tag' });
  const open = await db<{ visitId: number; code: string }[]>`
    SELECT v.id AS visit_id, h.code FROM visits v JOIN hand_tags h ON h.id = v.tag_id WHERE v.status = 'open' ORDER BY h.code`;
  const hits = matchByDigits(open, q);
  if (hits.length === 0) throw new AppError(404, 'TAG_NOT_IN_STORE', `手牌 ${q} 现在没有在店客人，请核对牌号`);
  if (hits.length > 1) {
    throw conflict('TAG_AMBIGUOUS', `有 ${hits.length} 张在店的手牌数字是 ${q}，请点选是哪一张`, { candidates: hits.map((h) => h.code) });
  }
  return emenuGuestOf(db, Number(hits[0]!.visitId));
}

// ───────────────────────── 下单 ─────────────────────────

const OrderInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请重新下单'),
  visitId: z.number('请先输入手牌').int().positive('请先输入手牌'),
  tagCode: z.string('请先输入手牌').trim().min(1, '请先输入手牌').max(16),
  tableName: z.string().trim().max(MAX_TABLE_NAME, `桌号最多 ${MAX_TABLE_NAME} 个字`).default(''),
  guests: z.number('请填写人数').int('人数是整数').min(1, '人数至少 1 位').max(EMENU_MAX_GUESTS, `人数最多 ${EMENU_MAX_GUESTS} 位`),
  lines: z
    .array(
      z.object({
        itemId: z.number('菜品编号不对').int().positive('菜品编号不对'),
        quantity: z.number('份数不对').int('份数不对').min(1, '份数至少为 1').max(MAX_BILL_LINE_QUANTITY, `一道菜一单最多 ${MAX_BILL_LINE_QUANTITY} 份`),
        /** 8.1.17（BW9）：选的做法、加料挂在哪一行主菜上；都不带的与以前的请求一样 */
        ...DishLineFields,
      }),
      '请先点菜',
    )
    .min(1, '请先点菜')
    .max(EMENU_MAX_LINES, `一单最多 ${EMENU_MAX_LINES} 行，多的请分两次下单`),
  avoid: z.array(z.string().trim().min(1).max(EMENU_MAX_OPTION_LENGTH)).max(12).default([]),
  serve: z.string().trim().min(1).max(EMENU_MAX_OPTION_LENGTH).nullable().default(null),
  customNote: z.string().trim().max(EMENU_MAX_CUSTOM_NOTE, `自定义备注最多 ${EMENU_MAX_CUSTOM_NOTE} 个字`).default(''),
  expectedTotal: positiveCents('本次合计'),
});

/** 桌号（DC5）：建了桌台的只能填建过的（返回桌台的名称）；一张都没建时照输入的记 */
async function resolveTable(db: Db, input: string): Promise<string> {
  const tables = await emenuTables(db);
  if (!input) throw badRequest('请填写桌号', { field: 'tableName' });
  if (tables.length === 0) return input;
  const hits = matchTable(tables, input);
  if (hits.length === 0) throw unprocessable('TABLE_NOT_FOUND', `没有「${input}」这张桌，请核对桌号`);
  if (hits.length > 1) throw conflict('TABLE_AMBIGUOUS', `有 ${hits.length} 张桌的号码是 ${input}，请点选是哪一张`, { candidates: hits.map((t) => t.name) });
  return hits[0]!.name;
}

/** 平板上核对桌号（开始点单时）：返回桌台的名称 */
export async function checkEmenuTable(db: Db, raw: unknown): Promise<{ tableName: string }> {
  if (!(await emenuEnabled(db))) throw disabledError();
  const { table } = parse(z.object({ table: z.string('请填写桌号').trim().min(1, '请填写桌号').max(MAX_TABLE_NAME, `桌号最多 ${MAX_TABLE_NAME} 个字`) }), raw);
  return { tableName: await resolveTable(db, table) };
}

/**
 * 这几个价目项目现在能不能在平板上点：要在电子菜单上（是一道启用的菜的规格、这道菜排在启用的分类的某一页上），
 * 而且所在的分类里至少有一个现在供应——在现在这一段（8.1.5，没勾时段的是全天）并且在另外限定的时间里
 * （DC9、PP3：页面可能还没刷新，门店系统按下单这一刻再核对一次）
 */
async function assertOnMenuNow(tx: Tx, itemIds: number[], minute: number, periods: EmenuRules['periods']) {
  const now = periodAt(periods, minute).key;
  const rows = await tx<{ itemId: number; name: string; dishActive: boolean | null; windows: { start: number | null; end: number | null; periods: string[] }[] | null }[]>`
    SELECT i.id AS item_id, i.name, d.active AS dish_active,
           (SELECT json_agg(json_build_object('start', c.start_minute, 'end', c.end_minute, 'periods', c.periods))
            FROM emenu_categories c
            WHERE c.active AND EXISTS (SELECT 1 FROM emenu_pages p JOIN emenu_page_dishes pd ON pd.page_id = p.id WHERE p.category_id = c.id AND pd.dish_id = d.id)) AS windows
    FROM service_items i LEFT JOIN emenu_dish_specs sp ON sp.item_id = i.id LEFT JOIN emenu_dishes d ON d.id = sp.dish_id
    WHERE i.id IN ${tx(itemIds)}`;
  for (const id of itemIds) {
    const r = rows.find((x) => Number(x.itemId) === id);
    if (!r) throw unprocessable('DISH_NOT_ON_MENU', '有菜不在电子菜单上，请刷新后重新点');
    if (!r.dishActive || !r.windows?.length) throw unprocessable('DISH_NOT_ON_MENU', `「${r.name}」不在电子菜单上，请从菜单里重新点`, { itemId: id });
    if (!r.windows.some((w) => periodsCover(w.periods, now) && windowOpen(windowOf(w.start, w.end), minute))) {
      throw unprocessable('DISH_NOT_AVAILABLE_NOW', `「${r.name}」现在不在供应时段，请从未下单里去掉`, { itemId: id });
    }
  }
}

async function orderByKey(db: Db, key: string): Promise<Omit<EmenuOrderResult, 'replayed'> | null> {
  const [o] = await db<{ visitId: number; orderNo: string | null; tableName: string; guests: number; total: number; quantity: number; waiterName: string }[]>`
    SELECT o.visit_id, o.order_no, o.table_name, o.guests, o.total, o.quantity, s.display_name AS waiter_name
    FROM emenu_orders o JOIN staff s ON s.id = o.waiter_id WHERE o.client_key = ${key}`;
  if (!o) return null;
  return {
    orderNo: o.orderNo,
    tableName: o.tableName,
    guests: o.guests,
    total: Number(o.total),
    quantity: o.quantity,
    waiterName: o.waiterName,
    guest: await emenuGuestOf(db, Number(o.visitId)),
  };
}

/**
 * 平板下单：服务员输点单密码确认 → 菜挂到这张手牌的账单上、进厨房（出品单写送到哪张桌、整单备注）。
 * device 是平板登录的账号（要「打开平板点餐」）；经办人是点单密码对应的服务员（要「餐饮点单」+「前台挂账」）。
 * 同一个操作编号只生效一次：原样重提返回第一次的结果（重提也要输对点单密码）。
 */
export async function placeEmenuOrder(deps: Deps, raw: unknown, device: Actor, source: string): Promise<EmenuOrderResult> {
  const input = parse(OrderInput, raw);
  const rules = await loadEmenuRules(deps.sql);
  if (!rules.enabled || !(await loadDiningRules(deps.sql)).enabled) throw disabledError();
  const itemIds = input.lines.map((l) => l.itemId);
  // 同一道菜、同一个规格、同样的做法、配在同一道菜上的合成一行（8.1.17 起做法不同的、加料配的主菜不同的另起一行）
  const lineKeys = input.lines.map(
    (l) =>
      `${l.itemId}|${[...(l.methods ?? [])].sort().join(',')}|${l.addonOf ?? ''}|${(l.swaps ?? [])
        .map((w) => `${w.from}>${w.to}`)
        .sort()
        .join(',')}`,
  );
  if (new Set(lineKeys).size !== lineKeys.length) throw badRequest('同一道菜同一个规格请合成一行');
  if (input.avoid.some((a) => !rules.avoidOptions.includes(a)) || (input.serve !== null && !rules.serveOptions.includes(input.serve))) {
    throw unprocessable('REMARK_OPTION_INVALID', '备注的选项刚刚改过，请重新选一下备注');
  }
  const avoid = rules.avoidOptions.filter((a) => input.avoid.includes(a));
  const note = composeEmenuNote(avoid, input.serve, input.customNote);
  if (note.length > EMENU_MAX_NOTE) throw unprocessable('REMARK_TOO_LONG', `备注太长了（最多 ${EMENU_MAX_NOTE} 个字），请少选几项或写短一点`);

  // 点单密码在事务外核对：密码不对、锁了、没有权限都在这里拒绝，不碰账单。
  // 后台没开「点单密码」（8.0.15 起默认不开）：不核对，经办人记这台平板登录的账号
  const waiter = await orderOperator(deps, rules, raw, device, source);

  const { clientKey: key, ...payload } = input;
  const tagCode = normalizeTagCode(input.tagCode);
  const requestHash = hashRequest({ emenu: 1, ...payload, tagCode, avoid });
  const { replayed } = await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) => {
    const at = new Date();
    // 来访：锁住以后核对还在店、还是页面上那张牌（客人换过牌、这张牌换了人都拒绝）
    const visit = (await lockVisits(tx, [input.visitId])).get(input.visitId)!;
    assertOpen(visit);
    const [tag] = await tx<{ code: string }[]>`SELECT code FROM hand_tags WHERE id = ${visit.tagId}`;
    if (normalizeTagCode(tag!.code) !== tagCode) {
      throw conflict('TAG_CHANGED', `这位客人现在用的是手牌 ${tag!.code}，不是 ${tagCode}，请回到起始页重新输入手牌`);
    }
    const tableName = await resolveTable(tx, input.tableName);
    // 加料（8.1.17）不一定排在电子菜单上：按主菜配的加料核对（postChargesTx 里），这里只核对菜单上点的那几道
    await assertOnMenuNow(
      tx,
      input.lines.filter((l) => l.addonOf === undefined).map((l) => l.itemId),
      minuteOfDay(at, deps.config.timezone),
      rules.periods,
    );
    // 8.1.17（BW3）：按出品口核对下单权限，与点单页同一个函数——这台平板的岗位（「点餐平板」默认三处都有）；
    // 开着「点单密码」时输密码确认的服务员是经办人，也要能在那一处下单（与他在点单页下单一样）
    await assertTabletOutlets(tx, device, itemIds, 'tablet');
    if (waiter.id !== device.id) await assertTabletOutlets(tx, waiter, itemIds, 'waiter');
    const posted = await postChargesTx(
      tx,
      deps,
      input.visitId,
      {
        clientKey: key,
        lines: input.lines.map((l) => ({
          itemId: l.itemId,
          quantity: l.quantity,
          note: note || undefined,
          tier: undefined,
          technicianId: undefined,
          callType: undefined,
          methods: l.methods,
          addonOf: l.addonOf,
          swaps: l.swaps,
        })),
        customLines: [],
        expectedTotal: input.expectedTotal,
        backfill: undefined,
      },
      { key, requestHash, backfill: null, deliverTo: tableName },
      { actor: waiter, ip: source, at },
      { dining: { onlyKitchen: true } },
    );
    const date = await businessDate(tx, deps, at);
    const quantity = posted.lines.reduce((s, l) => s + l.quantity, 0);
    await tx`
      INSERT INTO emenu_orders (client_key, visit_id, tag_code, table_name, guests, avoid, serve, custom_note, note, order_no, total, line_count, quantity,
                                waiter_id, device_staff_id, business_date, created_at)
      VALUES (${key}, ${visit.id}, ${tag!.code}, ${tableName}, ${input.guests}, ${avoid}, ${input.serve ?? ''}, ${input.customNote}, ${note}, ${posted.orderNo},
              ${posted.total}, ${posted.lines.length}, ${quantity}, ${waiter.id}, ${device.id}, ${date}, ${at})`;
    await writeAudit(tx, {
      staffId: waiter.id,
      action: 'emenu_order',
      targetType: 'visit',
      targetId: visit.id,
      detail: {
        summary: `平板点餐：手牌 ${tag!.code}、桌 ${tableName}、${input.guests} 人，${quantity} 份 ¥${(posted.total / 100).toFixed(2)}${note ? `（${note}）` : ''}`,
        visitNo: visit.visitNo,
        orderNo: posted.orderNo,
        deviceStaffId: device.id,
        deviceUsername: device.username,
        ...(rules.requirePin ? {} : { noPin: true }),
      },
      ip: source,
      businessDate: date,
    });
    return visit.id;
  });
  const order = await orderByKey(deps.sql, key);
  // 编号是点单页（不是平板）用过的：内容摘要对不上时 runIdempotent 已经拒绝；走到这里一定有点餐单
  if (!order) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的业务，请重新下单');
  return { ...order, replayed };
}

/** 平板下单按出品口核对（assertOrderOutlets，与点单页同一个函数），拒绝时说清楚是这台平板还是输密码的服务员 */
async function assertTabletOutlets(tx: Tx, actor: Actor, itemIds: number[], who: 'tablet' | 'waiter') {
  try {
    await assertOrderOutlets(tx, actor, itemIds);
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== 'OUTLET_FORBIDDEN') throw e;
    const items = (e.details?.items as string[] | undefined) ?? [];
    throw new AppError(
      403,
      'OUTLET_FORBIDDEN',
      who === 'tablet'
        ? `这台平板不能点${items.map((n) => `「${n}」`).join('')}（这一处没给「点餐平板」开下单权限），请从未下单里去掉，或请服务员在点单页点`
        : `${actor.displayName}不能在这一处下单（${items.map((n) => `「${n}」`).join('')}），请换一位有权限的同事输密码`,
      e.details,
    );
  }
}

/**
 * 这一单记谁经办：开着「点单密码」时是输密码的那位服务员（密码不对、锁了、没有点单权限在这里拒绝）；
 * 没开时是这台平板登录的账号（请求里带了密码也不看）。
 */
async function orderOperator(deps: Deps, rules: Pick<EmenuRules, 'requirePin'>, raw: unknown, device: Actor, source: string): Promise<Actor> {
  if (!rules.requirePin) return device;
  return resolveWaiter(deps, (raw as { pin?: unknown } | null)?.pin, device, source);
}

const KeyParam = z.object({ key: z.uuid('操作编号格式不正确') });

/** 结果待确认时按操作编号查回（只读）：查到就是已经下单；查不到只代表此刻没有已提交的结果 */
export async function emenuOpLookup(db: Db, rawParams: unknown): Promise<EmenuOpLookup> {
  const { key } = parse(KeyParam, rawParams);
  const order = await orderByKey(db, key);
  if (order) return { found: true, order: { ...order, replayed: true } };
  return { found: false, abandoned: await isFenced(db, key, ['bill_post']) };
}

/**
 * 确认作废一笔结果待确认的下单（要点单密码）：登记作废后，原请求即使迟到也不会生效；原请求其实已经生效时返回它的结果、不作废。
 * 与前台的「确认作废」同一套（操作编号的咨询锁，业务类型 bill_post），经办人是输密码的服务员。
 */
export async function abandonEmenuOrder(deps: Deps, rawParams: unknown, raw: unknown, device: Actor, source: string): Promise<EmenuOpLookup> {
  const { key } = parse(KeyParam, rawParams);
  const waiter = await orderOperator(deps, await loadEmenuRules(deps.sql), raw, device, source);
  const result = await abandonFrontdeskOp(deps, key, 'bill_post', { actor: waiter, ip: source });
  if (!result.found) return { found: false, abandoned: result.abandoned };
  const order = await orderByKey(deps.sql, key);
  if (!order) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号属于前台的另一笔挂账，不能在平板上作废');
  return { found: true, order: { ...order, replayed: true } };
}
