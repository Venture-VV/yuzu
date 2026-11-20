// 充值套餐与消费项目。停用而不删除，保证历史单据可追溯。
//
// 消费项目（Batch 2.3，店主 2026-10-27 #8）：同一项目可设「标准 / 专业 / 优选」多档价格（service_item_prices），
// 另有时长、仅限某一性别、力道、精油、热疗、「超人气」等属性，属性不影响计价。
// service_items.price 始终等于默认档（标准 → 专业 → 优选中第一个提供的）的价格，保存项目时一并维护。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultTier, isCareItem, PRICE_TIERS, sortTiers, STRENGTHS, tierPrice, type PriceTier, type TierPrice } from '@shared/catalog';
import { PRICE_LIST_MAX_ROWS, type BuiltinPriceList, type PriceListImportReport } from '@shared/price-list-import';
import type { Catalog, RechargePlan, ServiceItem } from '@shared/types';
import type { Db, Sql, Tx } from '../db';
import { guard } from '../auth/guard';
import { TANGQI_PRICE_LIST_CSV, TANGQI_PRICE_LIST_TITLE } from '../demo/price-list-tangqi-2026-10-27';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { cents, idParam, parse, positiveCents } from '../lib/validate';
import { pricesColumn } from './pricing';
import { currentStoreId, DEFAULT_STORE_ID } from '../lib/store-context';
import { dishIdsAmong, dishPriceState, recordPriceChanges, recordStorePriceChange } from './dish-prices';
import { MAX_STORE_PRICE_REASON } from '@shared/frontdesk-v8117';
import { formatYuan } from '@shared/money';

const PlanInput = z.object({
  name: z.string().trim().min(1, '请填写套餐名称').max(32, '名称最多 32 个字'),
  payAmount: positiveCents('实收金额'),
  bonusAmount: cents('赠金'),
  /** 赠金有效期（天，店主 #2）；null 为长期有效；编辑时不带则保持原值 */
  bonusValidDays: z.number().int('赠金有效期按整天填写').min(1, '赠金有效期至少 1 天').max(3650, '赠金有效期最多 3650 天').nullable().optional(),
  note: z.string().trim().max(100).default(''),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const tierPriceInput = positiveCents('价格').nullable().optional();
const genderInput = z.enum(['male', 'female'], '性别限定应为男宾或女宾').nullable();
const durationInput = z.number().int().min(1, '时长至少 1 分钟').max(1440, '时长最多 1440 分钟').nullable();

const ItemInput = z
  .object({
    name: z.string().trim().min(1, '请填写项目名称').max(32, '名称最多 32 个字'),
    category: z.string().trim().max(16, '分类最多 16 个字').default(''),
    /** 只有一个价格的写法：记为「标准」档 */
    price: positiveCents('价格').optional(),
    /** 各档价格；某一档不提供时为 null 或不填 */
    prices: z.object({ standard: tierPriceInput, professional: tierPriceInput, premium: tierPriceInput }).optional(),
    durationMinutes: durationInput.default(null),
    gender: genderInput.default(null),
    strength: z.enum(STRENGTHS, '力道应为轻柔、适中或强劲').nullable().default(null),
    essentialOil: z.boolean().default(false),
    heatTherapy: z.boolean().default(false),
    popular: z.boolean().default(false),
    /** 需要技师（v0.7.0）；不带时新建为否、编辑时保持原值（旧页面不带这一项） */
    technicianRequired: z.boolean().optional(),
    note: z.string().trim().max(100, '说明最多 100 字').default(''),
    active: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  })
  .transform(({ price, prices, ...rest }) => ({
    ...rest,
    tiers: prices ? PRICE_TIERS.flatMap((tier) => (prices[tier] ? [{ tier, price: prices[tier]! }] : [])) : price !== undefined ? [{ tier: 'standard' as const, price }] : [],
  }))
  .refine((v) => v.tiers.length > 0, '请至少填写一档价格');
type ItemData = z.output<typeof ItemInput>;

const ITEM_COLUMNS = (db: Db, base = false) => db`
  i.id, i.name, i.category, i.price, i.duration_minutes, i.gender, i.strength, i.essential_oil, i.heat_therapy, i.popular,
  i.technician_required, i.note, i.active, i.sort_order, ${pricesColumn(db, { base })} AS prices`;

/** base：全公司的价目（后台维护价目表用）；不给时第二家店按本店价（前台挂账、点单用，8.0.22） */
export async function loadItems(db: Db, includeInactive = false, base = false): Promise<ServiceItem[]> {
  const rows = await db<ServiceItem[]>`
    SELECT ${ITEM_COLUMNS(db, base)} FROM service_items i
    ${includeInactive ? db`` : db`WHERE i.active`} ORDER BY i.active DESC, i.sort_order, i.id`;
  return rows.map((r) => ({ ...r, prices: sortTiers(r.prices) }));
}

export async function loadCatalog(db: Db, includeInactive = false, base = includeInactive): Promise<Catalog> {
  const plans = await db<RechargePlan[]>`
    SELECT id, name, pay_amount, bonus_amount, bonus_valid_days, note, active, sort_order FROM recharge_plans
    ${includeInactive ? db`` : db`WHERE active`} ORDER BY active DESC, sort_order, pay_amount, id`;
  return { plans, items: await loadItems(db, includeInactive, base) };
}

/** 写入项目与各档价格（调用方开事务）；默认档价格同步写入 service_items.price */
async function writeItem(tx: Tx, id: number | null, i: Omit<ItemData, 'tiers'> & { tiers: TierPrice[] }): Promise<number> {
  const price = tierPrice(i.tiers, defaultTier(i.tiers)!)!;
  let itemId = id;
  if (itemId === null) {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO service_items (name, category, price, duration_minutes, gender, strength, essential_oil, heat_therapy, popular,
                                 technician_required, note, active, sort_order)
      VALUES (${i.name}, ${i.category}, ${price}, ${i.durationMinutes}, ${i.gender}, ${i.strength}, ${i.essentialOil},
              ${i.heatTherapy}, ${i.popular}, ${i.technicianRequired ?? isCareItem(i.category, i.name)}, ${i.note}, ${i.active}, ${i.sortOrder})
      RETURNING id`;
    itemId = row!.id;
  } else {
    const rows = await tx`
      UPDATE service_items SET name = ${i.name}, category = ${i.category}, price = ${price}, duration_minutes = ${i.durationMinutes},
             gender = ${i.gender}, strength = ${i.strength}, essential_oil = ${i.essentialOil}, heat_therapy = ${i.heatTherapy},
             popular = ${i.popular}, ${i.technicianRequired === undefined ? tx`` : tx`technician_required = ${i.technicianRequired},`}
             note = ${i.note}, active = ${i.active}, sort_order = ${i.sortOrder}, updated_at = now()
      WHERE id = ${itemId} RETURNING id`;
    if (rows.length === 0) throw notFound('项目不存在');
    await tx`DELETE FROM service_item_prices WHERE item_id = ${itemId}`;
  }
  await tx`
    INSERT INTO service_item_prices (item_id, tier, price)
    SELECT ${itemId}, unnest(${i.tiers.map((t) => t.tier)}::text[]), unnest(${i.tiers.map((t) => t.price)}::bigint[])`;
  return itemId;
}

// ───────────────────────── 价目表导入 ─────────────────────────

export const PriceListImportInput = z.object({
  rows: z
    .array(
      z.object({
        category: z.string().trim().max(16, '分类最多 16 个字'),
        name: z.string().trim().min(1, '项目名称为空').max(32, '名称最多 32 个字'),
        durationMinutes: durationInput,
        gender: genderInput,
        prices: z
          .array(z.object({ tier: z.enum(PRICE_TIERS), price: positiveCents('价格') }))
          .min(1, '每个项目至少要有一档价格')
          .max(3)
          .refine((p) => new Set(p.map((x) => x.tier)).size === p.length, '同一档价格重复'),
        strength: z.enum(STRENGTHS).nullable().optional(),
        essentialOil: z.boolean().optional(),
        heatTherapy: z.boolean().optional(),
        popular: z.boolean().optional(),
        note: z.string().trim().max(100).optional(),
      }),
    )
    .min(1, '清单里没有项目')
    .max(PRICE_LIST_MAX_ROWS, `一次最多导入 ${PRICE_LIST_MAX_ROWS} 个项目`),
  /** 同时停用不在清单里的项目 */
  deactivateMissing: z.boolean().default(false),
  /** 只预览，不写入 */
  dryRun: z.boolean().default(true),
});
export type PriceListImportData = z.input<typeof PriceListImportInput>;

const samePrices = (a: TierPrice[], b: TierPrice[]) => a.length === b.length && sortTiers(a).every((p, k) => p.tier === sortTiers(b)[k]!.tier && p.price === sortTiers(b)[k]!.price);

/**
 * 按名称导入价目表：清单是项目与价格的准确描述。
 *   · 新名称 → 新建；已有名称 → 分类、时长、性别、各档价格、排序以清单为准，停用的恢复启用；
 *   · 属性（力道、精油、热疗、超人气、说明）清单里留空时保持现有设置；
 *   · 勾选 deactivateMissing 时停用清单外的项目；
 *   · 排序按清单顺序；同名项目不止一个时拒绝，请先在管理页改名或停用。
 */
export async function importPriceList(sql: Sql, raw: PriceListImportData, audit: { staffId: number | null; ip?: string; via: 'web' | 'cli' }): Promise<PriceListImportReport> {
  const input = parse(PriceListImportInput, raw);
  const dupes = input.rows.map((r) => r.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (dupes.length) throw badRequest(`清单里项目重复：${[...new Set(dupes)].slice(0, 5).join('、')}`);
  return sql.begin(async (tx) => {
    // 先锁定全部项目（id 升序），与同时进行的项目编辑串行
    const existing = await tx<{ id: number }[]>`SELECT id FROM service_items ORDER BY id ${input.dryRun ? tx`` : tx`FOR UPDATE`}`;
    const items = existing.length ? await loadItems(tx, true, true) : [];
    const byName = new Map<string, ServiceItem[]>();
    for (const it of items) byName.set(it.name, [...(byName.get(it.name) ?? []), it]);

    const create: { row: (typeof input.rows)[number]; sortOrder: number }[] = [];
    const update: { item: ServiceItem; row: (typeof input.rows)[number]; sortOrder: number }[] = [];
    let unchanged = 0;
    input.rows.forEach((row, index) => {
      const sortOrder = index + 1;
      const matches = byName.get(row.name) ?? [];
      const active = matches.filter((m) => m.active);
      if (active.length > 1 || (active.length === 0 && matches.length > 1)) {
        throw conflict('ITEM_AMBIGUOUS', `已有 ${matches.length} 个名为「${row.name}」的项目，请先在管理页改名或停用其中一个再导入`);
      }
      const item = active[0] ?? matches[0];
      if (!item) {
        create.push({ row, sortOrder });
        return;
      }
      const same =
        item.active &&
        item.category === row.category &&
        item.durationMinutes === row.durationMinutes &&
        item.gender === row.gender &&
        item.sortOrder === sortOrder &&
        samePrices(item.prices, row.prices) &&
        (row.strength === undefined || item.strength === row.strength) &&
        (row.essentialOil === undefined || item.essentialOil === row.essentialOil) &&
        (row.heatTherapy === undefined || item.heatTherapy === row.heatTherapy) &&
        (row.popular === undefined || item.popular === row.popular) &&
        (row.note === undefined || item.note === row.note);
      if (same) unchanged += 1;
      else update.push({ item, row, sortOrder });
    });
    const listed = new Set(input.rows.map((r) => r.name));
    const deactivate = input.deactivateMissing ? items.filter((i) => i.active && !listed.has(i.name)) : [];

    if (!input.dryRun) {
      // 菜品的改价进改价记录（8.1.15 菜品管理，docs/DISHES_V8115.md 第 4 节）：按清单改到菜品价格的，每一档记一条
      const dishes = await dishIdsAmong(
        tx,
        update.map((u) => u.item.id),
      );
      for (const { item, row } of update) {
        if (!dishes.has(item.id)) continue;
        await recordPriceChanges(tx, { itemId: item.id, itemName: item.name, before: item.prices, after: row.prices, reason: '按价目表导入', source: 'price_list', staffId: audit.staffId });
      }
      for (const { row, sortOrder } of create) {
        await writeItem(tx, null, {
          name: row.name,
          category: row.category,
          tiers: row.prices,
          durationMinutes: row.durationMinutes,
          gender: row.gender,
          strength: row.strength ?? null,
          essentialOil: row.essentialOil ?? false,
          heatTherapy: row.heatTherapy ?? false,
          popular: row.popular ?? false,
          note: row.note ?? '',
          active: true,
          sortOrder,
        });
      }
      for (const { item, row, sortOrder } of update) {
        await writeItem(tx, item.id, {
          name: row.name,
          category: row.category,
          tiers: row.prices,
          durationMinutes: row.durationMinutes,
          gender: row.gender,
          strength: row.strength === undefined ? item.strength : row.strength,
          essentialOil: row.essentialOil ?? item.essentialOil,
          heatTherapy: row.heatTherapy ?? item.heatTherapy,
          popular: row.popular ?? item.popular,
          note: row.note ?? item.note,
          active: true,
          sortOrder,
        });
      }
      if (deactivate.length) {
        await tx`UPDATE service_items SET active = false, updated_at = now() WHERE id IN ${tx(deactivate.map((d) => d.id))}`;
      }
    }

    const groups = new Map<string, number>();
    for (const r of input.rows) groups.set(r.category || '其他', (groups.get(r.category || '其他') ?? 0) + 1);
    const report: PriceListImportReport = {
      dryRun: input.dryRun,
      total: input.rows.length,
      created: create.length,
      updated: update.length,
      unchanged,
      deactivated: deactivate.length,
      samples: {
        created: create.slice(0, 20).map((c) => c.row.name),
        updated: update.slice(0, 20).map((u) => u.row.name),
        deactivated: deactivate.slice(0, 20).map((d) => d.name),
      },
      groups: [...groups].map(([category, count]) => ({ category, count })),
    };
    if (!input.dryRun) {
      await writeAudit(tx, {
        staffId: audit.staffId,
        action: 'price_list_imported',
        targetType: 'item',
        detail: {
          via: audit.via,
          total: report.total,
          created: report.created,
          updated: report.updated,
          unchanged: report.unchanged,
          deactivated: report.deactivated,
          deactivateMissing: input.deactivateMissing,
        },
        ip: audit.ip,
      });
    }
    return report;
  });
}

export const BUILTIN_PRICE_LISTS: BuiltinPriceList[] = [{ key: 'tangqi-2026-10-27', title: TANGQI_PRICE_LIST_TITLE, csv: TANGQI_PRICE_LIST_CSV }];

export function registerCatalogRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/catalog', { preHandler: guard('member.read') }, async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    return loadCatalog(sql, all);
  });

  app.post('/api/plans', { preHandler: guard('catalog.manage') }, async (req) => {
    const p = parse(PlanInput, req.body);
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO recharge_plans (name, pay_amount, bonus_amount, bonus_valid_days, note, active, sort_order)
      VALUES (${p.name}, ${p.payAmount}, ${p.bonusAmount}, ${p.bonusValidDays ?? null}, ${p.note}, ${p.active}, ${p.sortOrder}) RETURNING id`;
    await writeAudit(sql, { staffId: req.actor.id, action: 'plan_saved', targetType: 'plan', targetId: row!.id, detail: p, ip: req.ip });
    return loadCatalog(sql, true);
  });

  app.put('/api/plans/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const p = parse(PlanInput, req.body);
    const rows = await sql`
      UPDATE recharge_plans SET name = ${p.name}, pay_amount = ${p.payAmount}, bonus_amount = ${p.bonusAmount},
             ${p.bonusValidDays === undefined ? sql`` : sql`bonus_valid_days = ${p.bonusValidDays},`}
             note = ${p.note}, active = ${p.active}, sort_order = ${p.sortOrder}, updated_at = now()
      WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('套餐不存在');
    await writeAudit(sql, { staffId: req.actor.id, action: 'plan_saved', targetType: 'plan', targetId: id, detail: p, ip: req.ip });
    return loadCatalog(sql, true);
  });

  app.post('/api/items', { preHandler: guard('catalog.manage') }, async (req) => {
    const i = parse(ItemInput, req.body);
    await sql.begin(async (tx) => {
      const id = await writeItem(tx, null, i);
      await writeAudit(tx, { staffId: req.actor.id, action: 'item_saved', targetType: 'item', targetId: id, detail: i, ip: req.ip });
    });
    return loadCatalog(sql, true);
  });

  app.put('/api/items/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const i = parse(ItemInput, req.body);
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM service_items WHERE id = ${id} FOR UPDATE`;
      // 菜品的改价进改价记录（8.1.15 菜品管理）：这道是菜品、价格有变化的，每一档记一条
      const before = await dishPriceState(tx, id);
      await writeItem(tx, id, i);
      if (before) await recordPriceChanges(tx, { itemId: id, itemName: before.name, before: before.prices, after: i.tiers, reason: '在后台价目里修改', source: 'catalog', staffId: req.actor.id });
      await writeAudit(tx, { staffId: req.actor.id, action: 'item_saved', targetType: 'item', targetId: id, detail: i, ip: req.ip });
    });
    return loadCatalog(sql, true);
  });

  // 本店价（8.0.22，价目按店覆盖）：第二家店里打开时，每个项目每一档的全公司价与本店价；本店不用
  app.get('/api/admin/catalog/store-prices', { preHandler: guard('catalog.manage') }, async () => {
    const storeId = currentStoreId();
    if (storeId === DEFAULT_STORE_ID) throw badRequest('本店用全公司的价目表；本店价在第二家店里设');
    return sql<{ itemId: number; name: string; category: string; active: boolean; tier: PriceTier; price: number; storePrice: number | null }[]>`
      SELECT i.id AS item_id, i.name, i.category, i.active, p.tier, p.price, sp.price AS store_price
      FROM service_items i JOIN service_item_prices p ON p.item_id = i.id
      LEFT JOIN service_item_store_prices sp ON sp.item_id = i.id AND sp.tier = p.tier AND sp.store_id = ${storeId}
      ORDER BY i.active DESC, i.sort_order, i.id, p.tier`.then((rows) =>
      rows.map((r) => ({ ...r, itemId: Number(r.itemId), price: Number(r.price), storePrice: r.storePrice === null ? null : Number(r.storePrice) })),
    );
  });

  // 改本店价（8.1.17 BW-11，docs/FRONTDESK_V8117.md 第 6 节）：权限照旧，另要写原因（与菜品改价一样）；菜品的改价写进改价记录（门店、改前改后、谁、原因）。
  // 锁：这个价目项目一行（FOR NO KEY UPDATE，与菜品维护、后台价目同一批行）→ 本店价一行 → 改价记录，在锁里读改前的本店价与全公司价。
  // 改成的价与现在一样的什么都不做（照样回 ok：上一次的回复丢了再点一次不会多记一条）；带了打开时看到的价（expected）而别人刚改过的拒绝
  app.put('/api/admin/catalog/store-prices', { preHandler: guard('catalog.manage') }, async (req) => {
    const storeId = currentStoreId();
    if (storeId === DEFAULT_STORE_ID) throw badRequest('本店用全公司的价目表；本店价在第二家店里设');
    const input = parse(
      z.object({
        itemId: z.number().int().positive(),
        tier: z.enum(['standard', 'professional', 'premium']),
        // null：取消本店价，按全公司的
        price: z.number().int().positive().max(100_000_000).nullable(),
        // 打开时看到的本店价（null = 同全公司）；不带不核对
        expected: z.number().int().positive().nullable().optional(),
        reason: z.string('请填写改价的原因').trim().min(2, '请填写改价的原因（至少 2 个字）').max(MAX_STORE_PRICE_REASON, `原因最多 ${MAX_STORE_PRICE_REASON} 字`),
      }),
      req.body,
    );
    return sql.begin(async (tx) => {
      const [item] = await tx<{ name: string }[]>`SELECT name FROM service_items WHERE id = ${input.itemId} FOR NO KEY UPDATE`;
      const [p] = await tx<{ price: number }[]>`SELECT price FROM service_item_prices WHERE item_id = ${input.itemId} AND tier = ${input.tier}`;
      if (!item || !p) throw notFound('这个项目没有这一档价格');
      const [cur] = await tx<{ price: number }[]>`
        SELECT price FROM service_item_store_prices WHERE store_id = ${storeId} AND item_id = ${input.itemId} AND tier = ${input.tier} FOR UPDATE`;
      const before = cur ? Number(cur.price) : null;
      if (before === input.price) return { ok: true, changed: false };
      if (input.expected !== undefined && input.expected !== before) {
        throw conflict('STORE_PRICE_STALE', `「${item.name}」的本店价刚刚被改过（现在是${before === null ? '同全公司' : ` ${formatYuan(before)}`}），请刷新后再改`);
      }
      if (input.price === null) await tx`DELETE FROM service_item_store_prices WHERE store_id = ${storeId} AND item_id = ${input.itemId} AND tier = ${input.tier}`;
      else
        await tx`
          INSERT INTO service_item_store_prices (store_id, item_id, tier, price, updated_by) VALUES (${storeId}, ${input.itemId}, ${input.tier}, ${input.price}, ${req.actor.id})
          ON CONFLICT (store_id, item_id, tier) DO UPDATE SET price = EXCLUDED.price, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      const recorded = await recordStorePriceChange(tx, {
        storeId,
        itemId: input.itemId,
        itemName: item.name,
        tier: input.tier,
        oldPrice: before,
        newPrice: input.price,
        basePrice: Number(p.price),
        reason: input.reason,
        staffId: req.actor.id,
      });
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'store_price_changed',
        targetType: 'item',
        targetId: input.itemId,
        detail: { name: item.name, tier: input.tier, before, after: input.price, basePrice: Number(p.price), reason: input.reason, dish: recorded },
        ip: req.ip,
      });
      return { ok: true, changed: true };
    });
  });

  // 价目表：内置清单（店主提供）与按清单导入（默认只预览）
  app.get('/api/items/price-lists', { preHandler: guard('catalog.manage') }, async () => BUILTIN_PRICE_LISTS);

  app.post('/api/items/import', { preHandler: guard('catalog.manage') }, async (req) => importPriceList(sql, req.body as PriceListImportData, { staffId: req.actor.id, ip: req.ip, via: 'web' }));
}
