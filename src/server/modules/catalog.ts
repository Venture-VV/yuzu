// 充值套餐与消费项目。停用而不删除，保证历史单据可追溯。
//
// 消费项目（Batch 2.3，店主 2026-10-27 #8）：同一项目可设「标准 / 专业 / 优选」多档价格（service_item_prices），
// 另有时长、仅限某一性别、力道、精油、热疗、「超人气」等属性，属性不影响计价。
// service_items.price 始终等于默认档（标准 → 专业 → 优选中第一个提供的）的价格，保存项目时一并维护。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultTier, PRICE_TIERS, sortTiers, STRENGTHS, tierPrice, type TierPrice } from '@shared/catalog';
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
    note: z.string().trim().max(100, '说明最多 100 字').default(''),
    active: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  })
  .transform(({ price, prices, ...rest }) => ({
    ...rest,
    tiers: prices
      ? PRICE_TIERS.flatMap((tier) => (prices[tier] ? [{ tier, price: prices[tier]! }] : []))
      : price !== undefined
        ? [{ tier: 'standard' as const, price }]
        : [],
  }))
  .refine((v) => v.tiers.length > 0, '请至少填写一档价格');
type ItemData = z.output<typeof ItemInput>;

const ITEM_COLUMNS = (db: Db) => db`
  i.id, i.name, i.category, i.price, i.duration_minutes, i.gender, i.strength, i.essential_oil, i.heat_therapy, i.popular,
  i.note, i.active, i.sort_order, ${pricesColumn(db)} AS prices`;

export async function loadItems(db: Db, includeInactive = false): Promise<ServiceItem[]> {
  const rows = await db<ServiceItem[]>`
    SELECT ${ITEM_COLUMNS(db)} FROM service_items i
    ${includeInactive ? db`` : db`WHERE i.active`} ORDER BY i.active DESC, i.sort_order, i.id`;
  return rows.map((r) => ({ ...r, prices: sortTiers(r.prices) }));
}

export async function loadCatalog(db: Db, includeInactive = false): Promise<Catalog> {
  const plans = await db<RechargePlan[]>`
    SELECT id, name, pay_amount, bonus_amount, bonus_valid_days, note, active, sort_order FROM recharge_plans
    ${includeInactive ? db`` : db`WHERE active`} ORDER BY active DESC, sort_order, pay_amount, id`;
  return { plans, items: await loadItems(db, includeInactive) };
}

/** 写入项目与各档价格（调用方开事务）；默认档价格同步写入 service_items.price */
async function writeItem(tx: Tx, id: number | null, i: Omit<ItemData, 'tiers'> & { tiers: TierPrice[] }): Promise<number> {
  const price = tierPrice(i.tiers, defaultTier(i.tiers)!)!;
  let itemId = id;
  if (itemId === null) {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO service_items (name, category, price, duration_minutes, gender, strength, essential_oil, heat_therapy, popular,
                                 note, active, sort_order)
      VALUES (${i.name}, ${i.category}, ${price}, ${i.durationMinutes}, ${i.gender}, ${i.strength}, ${i.essentialOil},
              ${i.heatTherapy}, ${i.popular}, ${i.note}, ${i.active}, ${i.sortOrder})
      RETURNING id`;
    itemId = row!.id;
  } else {
    const rows = await tx`
      UPDATE service_items SET name = ${i.name}, category = ${i.category}, price = ${price}, duration_minutes = ${i.durationMinutes},
             gender = ${i.gender}, strength = ${i.strength}, essential_oil = ${i.essentialOil}, heat_therapy = ${i.heatTherapy},
             popular = ${i.popular}, note = ${i.note}, active = ${i.active}, sort_order = ${i.sortOrder}, updated_at = now()
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

const samePrices = (a: TierPrice[], b: TierPrice[]) =>
  a.length === b.length && sortTiers(a).every((p, k) => p.tier === sortTiers(b)[k]!.tier && p.price === sortTiers(b)[k]!.price);

/**
 * 按名称导入价目表：清单是项目与价格的准确描述。
 *   · 新名称 → 新建；已有名称 → 分类、时长、性别、各档价格、排序以清单为准，停用的恢复启用；
 *   · 属性（力道、精油、热疗、超人气、说明）清单里留空时保持现有设置；
 *   · 勾选 deactivateMissing 时停用清单外的项目；
 *   · 排序按清单顺序；同名项目不止一个时拒绝，请先在管理页改名或停用。
 */
export async function importPriceList(
  sql: Sql,
  raw: PriceListImportData,
  audit: { staffId: number | null; ip?: string; via: 'web' | 'cli' },
): Promise<PriceListImportReport> {
  const input = parse(PriceListImportInput, raw);
  const dupes = input.rows.map((r) => r.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (dupes.length) throw badRequest(`清单里项目重复：${[...new Set(dupes)].slice(0, 5).join('、')}`);
  return sql.begin(async (tx) => {
    // 先锁定全部项目（id 升序），与同时进行的项目编辑串行
    const existing = await tx<{ id: number }[]>`SELECT id FROM service_items ORDER BY id ${input.dryRun ? tx`` : tx`FOR UPDATE`}`;
    const items = existing.length ? await loadItems(tx, true) : [];
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
      await writeItem(tx, id, i);
      await writeAudit(tx, { staffId: req.actor.id, action: 'item_saved', targetType: 'item', targetId: id, detail: i, ip: req.ip });
    });
    return loadCatalog(sql, true);
  });

  // 价目表：内置清单（店主提供）与按清单导入（默认只预览）
  app.get('/api/items/price-lists', { preHandler: guard('catalog.manage') }, async () => BUILTIN_PRICE_LISTS);

  app.post('/api/items/import', { preHandler: guard('catalog.manage') }, async (req) =>
    importPriceList(sql, req.body as PriceListImportData, { staffId: req.actor.id, ip: req.ip, via: 'web' }),
  );
}
