// 后台「电子菜单」（8.0.10，docs/EMENU.md 第 4.1 节）：设置、分类与供应时段、每个分类的各页（版面 + 放哪几道菜）、
// 菜品图文与规格、从价目表生成初稿。
//
// 加锁：
//   · 设置走规则锁（saveRuleSetting），带页面打开时的版本，别人先保存过拒绝（EMENU_CHANGED）；
//   · 分类自己的信息与它的各页共用一个版本号：修改、保存各页都只锁那个分类一行，版本号对不上拒绝；各页整批换（先删后建）；
//   · 菜品图文的修改只锁那道菜一行（带版本号），规格整批换；「一个价目项目只在一道菜里」靠唯一索引兜底；
//   · 新建分类、新建菜品不带操作编号：分类名、规格的唯一索引兜底，重复提交会被拒绝而不是建出两份；
//   · 生成初稿先取电子菜单的咨询锁、全部串行；图片按内容去重、不加锁。

import { z } from 'zod';
import { defaultTier, type TierPrice } from '@shared/catalog';
import {
  DEFAULT_EMENU_RULES,
  emenuNoteWorstCase,
  EMENU_LAYOUT_INFO,
  EMENU_LAYOUTS,
  EMENU_MAX_AVOID_OPTIONS,
  EMENU_MAX_FOOTER,
  EMENU_MAX_IDLE_MINUTES,
  EMENU_MAX_NOTE,
  EMENU_MAX_OPTION_LENGTH,
  EMENU_MAX_PAGES,
  EMENU_MAX_SERVE_OPTIONS,
  type EmenuAdmin,
  type EmenuCategoryAdmin,
  type EmenuDishAdmin,
  type EmenuItemOption,
  type EmenuLayout,
  type EmenuPageAdmin,
  type EmenuRules,
} from '@shared/emenu';
import { isForeignKeyViolation, isUniqueViolation, type Db, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { saveRuleSetting, sameJson } from '../../lib/rule-settings';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { loadDiningRules } from '../dining';
import { pricesColumn } from '../pricing';
import { emenuTables, loadEmenuRules } from './core';

const changed = (what: string) => conflict('EMENU_CHANGED', `${what}刚刚被别人改过，请点「重新载入」看最新的再改`);

const defaultPrice = (prices: TierPrice[]) => {
  const tier = defaultTier(prices);
  return prices.find((p) => p.tier === tier)?.price ?? prices[0]!.price;
};

// ───────────────────────── 读 ─────────────────────────

/** 设置的版本：内容的摘要（键的先后不影响） */
const rulesRev = (rules: EmenuRules) => hashRequest(Object.fromEntries(Object.keys(rules).sort().map((k) => [k, rules[k as keyof EmenuRules]])));

async function loadCategories(db: Db): Promise<EmenuCategoryAdmin[]> {
  const cats = await db<{ id: number; name: string; nameEn: string; startMinute: number | null; endMinute: number | null; sortOrder: number; active: boolean; version: number }[]>`
    SELECT id, name, name_en, start_minute, end_minute, sort_order, active, version FROM emenu_categories ORDER BY active DESC, sort_order, id`;
  const pages = await db<{ id: number; categoryId: number; layout: EmenuLayout; title: string; titleEn: string }[]>`
    SELECT id, category_id, layout, title, title_en FROM emenu_pages ORDER BY category_id, sort_no`;
  const slots = await db<{ pageId: number; slotNo: number; dishId: number }[]>`SELECT page_id, slot_no, dish_id FROM emenu_page_dishes ORDER BY page_id, slot_no`;
  return cats.map((c) => ({
    id: Number(c.id),
    name: c.name,
    nameEn: c.nameEn,
    window: c.startMinute === null || c.endMinute === null ? null : { start: c.startMinute, end: c.endMinute },
    sortOrder: c.sortOrder,
    active: c.active,
    version: c.version,
    pages: pages
      .filter((p) => Number(p.categoryId) === Number(c.id))
      .map((p): EmenuPageAdmin => {
        const mine = slots.filter((s) => Number(s.pageId) === Number(p.id));
        const dishIds: (number | null)[] = Array.from({ length: mine.reduce((m, s) => Math.max(m, s.slotNo + 1), 0) }, () => null);
        for (const s of mine) dishIds[s.slotNo] = Number(s.dishId);
        return { layout: p.layout, title: p.title, titleEn: p.titleEn, dishIds };
      }),
  }));
}

async function loadDishes(db: Db, categories: EmenuCategoryAdmin[]): Promise<EmenuDishAdmin[]> {
  const dishes = await db<Omit<EmenuDishAdmin, 'specs' | 'usedIn'>[]>`
    SELECT id, name, name_en, tagline, description, attrs, unit, image_id, detail_image_id, active, version FROM emenu_dishes ORDER BY active DESC, id`;
  const specs = await db<{ dishId: number; itemId: number; label: string; itemName: string; prices: TierPrice[]; orderable: boolean }[]>`
    SELECT sp.dish_id, sp.item_id, sp.label, i.name AS item_name, ${pricesColumn(db)} AS prices,
           (i.active AND NOT i.technician_required AND st.id IS NOT NULL) AS orderable
    FROM emenu_dish_specs sp JOIN service_items i ON i.id = sp.item_id LEFT JOIN kitchen_stations st ON st.id = i.station_id AND st.active
    ORDER BY sp.dish_id, sp.sort_no, sp.item_id`;
  const usedIn = new Map<number, Set<string>>();
  for (const c of categories) for (const p of c.pages) for (const id of p.dishIds) if (id !== null) usedIn.set(id, (usedIn.get(id) ?? new Set()).add(c.name));
  return dishes.map((d) => ({
    ...d,
    id: Number(d.id),
    imageId: d.imageId === null ? null : Number(d.imageId),
    detailImageId: d.detailImageId === null ? null : Number(d.detailImageId),
    specs: specs
      .filter((s) => Number(s.dishId) === Number(d.id))
      .map((s) => ({ itemId: Number(s.itemId), label: s.label, itemName: s.itemName, price: defaultPrice(s.prices), orderable: s.orderable })),
    usedIn: [...(usedIn.get(Number(d.id)) ?? [])],
  }));
}

/** 能放进电子菜单的价目项目：在售、挂在启用的出品档口上、不需要技师（与点单页的菜单同一个范围） */
async function loadItemOptions(db: Db): Promise<EmenuItemOption[]> {
  const rows = await db<{ id: number; name: string; category: string; prices: TierPrice[]; stationName: string; dishId: number | null }[]>`
    SELECT i.id, i.name, i.category, s.name AS station_name, ${pricesColumn(db)} AS prices,
           (SELECT sp.dish_id FROM emenu_dish_specs sp WHERE sp.item_id = i.id) AS dish_id
    FROM service_items i JOIN kitchen_stations s ON s.id = i.station_id AND s.active
    WHERE i.active AND NOT i.technician_required ORDER BY s.sort_order, s.id, i.sort_order, i.id`;
  return rows.map(({ prices, ...r }) => ({ ...r, id: Number(r.id), dishId: r.dishId === null ? null : Number(r.dishId), price: defaultPrice(prices) }));
}

export async function emenuAdmin(db: Db): Promise<EmenuAdmin> {
  const rules = await loadEmenuRules(db);
  const [meta] = await db<{ updatedAt: string; updatedBy: string | null }[]>`
    SELECT s.updated_at, st.display_name AS updated_by FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = 'emenu_rules'`;
  const categories = await loadCategories(db);
  const [counts] = await db<{ tablets: number; pins: number }[]>`
    SELECT (SELECT count(*) FROM staff WHERE role = 'tablet' AND active AND NOT system)::int AS tablets,
           (SELECT count(*) FROM staff_order_pins p JOIN staff s ON s.id = p.staff_id AND s.active)::int AS pins`;
  return {
    rules,
    rulesRev: rulesRev(rules),
    rulesUpdatedAt: meta?.updatedAt ? new Date(meta.updatedAt).toISOString() : null,
    rulesUpdatedBy: meta?.updatedBy ?? null,
    diningEnabled: (await loadDiningRules(db)).enabled,
    categories,
    dishes: await loadDishes(db, categories),
    items: await loadItemOptions(db),
    tables: await emenuTables(db),
    tabletAccounts: counts!.tablets,
    pinHolders: counts!.pins,
  };
}

// ───────────────────────── 设置 ─────────────────────────

const optionList = (label: string, max: number) =>
  z
    .array(
      z
        .string()
        .trim()
        .min(1, `${label}的选项不能为空`)
        .max(EMENU_MAX_OPTION_LENGTH, `${label}的一个选项最多 ${EMENU_MAX_OPTION_LENGTH} 个字`)
        .regex(/^[^，,]+$/, `${label}的选项里不要有逗号`),
    )
    .max(max, `${label}最多 ${max} 个选项`)
    .refine((list) => new Set(list).size === list.length, `${label}的选项有重复`);

const RulesInput = z.object({
  enabled: z.boolean(),
  coverImageId: z.number().int().positive().nullable(),
  footerText: z.string().trim().max(EMENU_MAX_FOOTER, `版权行最多 ${EMENU_MAX_FOOTER} 个字`),
  avoidOptions: optionList('忌口', EMENU_MAX_AVOID_OPTIONS),
  serveOptions: optionList('起菜方式', EMENU_MAX_SERVE_OPTIONS),
  idleMinutes: z.number('分钟数必须是整数').int('分钟数必须是整数').min(0, '不能小于 0').max(EMENU_MAX_IDLE_MINUTES, `最多 ${EMENU_MAX_IDLE_MINUTES} 分钟`),
  offHours: z.enum(['hide', 'show'], '请选择不在供应时段的分类怎么显示'),
});

/** 保存设置：只交改过的项；带页面打开时的版本，别人先保存过拒绝 */
export async function saveEmenuRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<EmenuAdmin> {
  const { rev } = parse(z.object({ rev: z.string('缺少版本，请重新载入').min(1) }).passthrough(), raw);
  const patch = parse(RulesInput.partial(), raw);
  await saveRuleSetting(
    deps.sql,
    'emenu_rules',
    loadEmenuRules,
    async (before, tx) => {
      if (rulesRev(before) !== rev) throw changed('设置');
      const next = parse(RulesInput, { ...DEFAULT_EMENU_RULES, ...before, ...patch });
      if (emenuNoteWorstCase(next.avoidOptions, next.serveOptions) > EMENU_MAX_NOTE) {
        throw unprocessable('REMARK_OPTIONS_TOO_LONG', `忌口与起菜方式的选项加起来太长了：全选上再写满自定义备注要放进 ${EMENU_MAX_NOTE} 个字里，请减少或缩短选项`);
      }
      if (next.coverImageId !== null) {
        const [img] = await tx<{ id: number }[]>`SELECT id FROM emenu_images WHERE id = ${next.coverImageId}`;
        if (!img) throw unprocessable('IMAGE_NOT_FOUND', '氛围大图不存在，请重新上传');
      }
      return next;
    },
    ctx,
  );
  return emenuAdmin(deps.sql);
}

// ───────────────────────── 分类与各页 ─────────────────────────

const minute = z.number('时间不对').int('时间不对').min(0, '时间不对').max(1439, '时间不对');
const CategoryFields = z.object({
  name: z.string('请填写分类名称').trim().min(1, '请填写分类名称').max(16, '分类名称最多 16 个字'),
  nameEn: z.string().trim().max(32, '英文名最多 32 个字').default(''),
  /** 供应时段（一天里的第几分钟）；null 为全天 */
  window: z
    .object({ start: minute, end: minute })
    .refine((w) => w.start !== w.end, '供应时段的开始与结束不能相同')
    .nullable()
    .default(null),
  sortOrder: z.number().int().min(-9999).max(9999).default(0),
  active: z.boolean().default(true),
});
const CategoryUpdate = CategoryFields.extend({ version: z.number('缺少版本号，请重新载入').int().positive() });

const nameTaken = (name: string) => conflict('CATEGORY_NAME_TAKEN', `已有分类「${name}」`);

export async function createEmenuCategory(deps: Deps, raw: unknown, ctx: OpContext): Promise<EmenuAdmin> {
  const c = parse(CategoryFields, raw);
  try {
    await deps.sql.begin(async (tx) => {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO emenu_categories (name, name_en, start_minute, end_minute, sort_order, active, created_by, updated_by)
        VALUES (${c.name}, ${c.nameEn}, ${c.window?.start ?? null}, ${c.window?.end ?? null}, ${c.sortOrder}, ${c.active}, ${ctx.actor.id}, ${ctx.actor.id})
        RETURNING id`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'emenu_saved', targetType: 'emenu_category', targetId: row!.id, detail: { summary: `新建电子菜单分类「${c.name}」` }, ip: ctx.ip });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'emenu_categories_name_uq')) throw nameTaken(c.name);
    throw error;
  }
  return emenuAdmin(deps.sql);
}

async function lockCategory(tx: Tx, id: number, version: number) {
  const [cur] = await tx<{ name: string; version: number }[]>`SELECT name, version FROM emenu_categories WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound('分类不存在');
  if (cur.version !== version) throw changed(`分类「${cur.name}」`);
  return cur;
}

export async function updateEmenuCategory(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<EmenuAdmin> {
  const c = parse(CategoryUpdate, raw);
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const cur = await lockCategory(tx, id, c.version);
      await tx`
        UPDATE emenu_categories SET name = ${c.name}, name_en = ${c.nameEn}, start_minute = ${c.window?.start ?? null}, end_minute = ${c.window?.end ?? null},
               sort_order = ${c.sortOrder}, active = ${c.active}, version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'emenu_saved',
        targetType: 'emenu_category',
        targetId: id,
        detail: { summary: `修改电子菜单分类「${cur.name}」${cur.name !== c.name ? ` → 「${c.name}」` : ''}${c.active ? '' : '（停用）'}` },
        ip: ctx.ip,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'emenu_categories_name_uq')) throw nameTaken(c.name);
    throw error;
  }
  return emenuAdmin(deps.sql);
}

const PagesInput = z.object({
  version: z.number('缺少版本号，请重新载入').int().positive(),
  pages: z
    .array(
      z.object({
        layout: z.enum(EMENU_LAYOUTS, '版面不对'),
        title: z.string().trim().max(8, '小标题最多 8 个字').default(''),
        titleEn: z.string().trim().max(24, '小标题的英文最多 24 个字').default(''),
        dishIds: z.array(z.number().int().positive().nullable()).max(10),
      }),
      '请至少排一页',
    )
    .max(EMENU_MAX_PAGES, `一个分类最多 ${EMENU_MAX_PAGES} 页`),
});

/** 保存一个分类的各页（整批换）：每页至少放一道菜、不超过这种版面的位置数，同一页里一道菜只放一次 */
export async function saveEmenuPages(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<EmenuAdmin> {
  const input = parse(PagesInput, raw);
  const pages = input.pages.map((p, i) => {
    const info = EMENU_LAYOUT_INFO[p.layout];
    // 末尾的空位去掉；中间的空位留着（版面上那一块空着）
    const dishIds = [...p.dishIds];
    while (dishIds.length && dishIds.at(-1) === null) dishIds.pop();
    const placed = dishIds.filter((d): d is number => d !== null);
    if (dishIds.length > info.slots) throw unprocessable('PAGE_TOO_MANY', `第 ${i + 1} 页「${info.label}」最多放 ${info.slots} 道菜`);
    if (placed.length === 0) throw unprocessable('PAGE_EMPTY', `第 ${i + 1} 页还没放菜；不要这一页请删掉`);
    if (new Set(placed).size !== placed.length) throw unprocessable('PAGE_DUPLICATE_DISH', `第 ${i + 1} 页里同一道菜放了两次`);
    return { ...p, title: info.titled ? p.title : '', titleEn: info.titled ? p.titleEn : '', dishIds };
  });
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const cur = await lockCategory(tx, id, input.version);
      await tx`DELETE FROM emenu_pages WHERE category_id = ${id}`;
      for (const [i, p] of pages.entries()) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO emenu_pages (category_id, sort_no, layout, title, title_en) VALUES (${id}, ${i}, ${p.layout}, ${p.title}, ${p.titleEn}) RETURNING id`;
        for (const [slot, dishId] of p.dishIds.entries()) {
          if (dishId !== null) await tx`INSERT INTO emenu_page_dishes (page_id, slot_no, dish_id) VALUES (${row!.id}, ${slot}, ${dishId})`;
        }
      }
      await tx`UPDATE emenu_categories SET version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now() WHERE id = ${id}`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'emenu_saved', targetType: 'emenu_category', targetId: id, detail: { summary: `保存电子菜单「${cur.name}」的版面：${pages.length} 页` }, ip: ctx.ip });
    });
  } catch (error) {
    if (isForeignKeyViolation(error)) throw unprocessable('DISH_NOT_FOUND', '有菜品不存在，请重新载入后再排');
    throw error;
  }
  return emenuAdmin(deps.sql);
}

// ───────────────────────── 菜品图文 ─────────────────────────

const imageId = z.number().int().positive().nullable().default(null);
const DishFields = z.object({
  name: z.string('请填写菜名').trim().min(1, '请填写菜名').max(32, '菜名最多 32 个字'),
  nameEn: z.string().trim().max(80, '英文名最多 80 个字').default(''),
  tagline: z.string().trim().max(40, '名称后的小字最多 40 个字').default(''),
  description: z.string().trim().max(200, '介绍最多 200 个字').default(''),
  attrs: z.array(z.string().trim().min(1, '属性行不能为空').max(24, '属性行最多 24 个字')).max(3, '属性行最多 3 行').default([]),
  unit: z.string().trim().min(1, '请填写单位').max(4, '单位最多 4 个字').default('份'),
  imageId,
  detailImageId: imageId,
  active: z.boolean().default(true),
  specs: z
    .array(
      z.object({
        itemId: z.number('请选择价目项目').int().positive('请选择价目项目'),
        label: z.string().trim().max(8, '规格名最多 8 个字').default(''),
      }),
      '请至少选一个价目项目',
    )
    .min(1, '请至少选一个价目项目')
    .max(6, '一道菜最多 6 个规格'),
});
const DishUpdate = DishFields.extend({ version: z.number('缺少版本号，请重新载入').int().positive() });
type DishData = z.output<typeof DishFields>;

function checkSpecs(d: DishData) {
  const ids = d.specs.map((s) => s.itemId);
  if (new Set(ids).size !== ids.length) throw unprocessable('SPEC_DUPLICATE', '同一个价目项目选了两次');
  if (d.specs.length > 1) {
    if (d.specs.some((s) => !s.label)) throw unprocessable('SPEC_LABEL_REQUIRED', '有几个规格时，每个规格都要写规格名（如大份、小份）');
    if (new Set(d.specs.map((s) => s.label)).size !== d.specs.length) throw unprocessable('SPEC_LABEL_DUPLICATE', '规格名有重复');
  }
}

async function writeSpecs(tx: Tx, dishId: number, d: DishData) {
  await tx`DELETE FROM emenu_dish_specs WHERE dish_id = ${dishId}`;
  for (const [i, s] of d.specs.entries()) {
    await tx`INSERT INTO emenu_dish_specs (dish_id, item_id, label, sort_no) VALUES (${dishId}, ${s.itemId}, ${d.specs.length > 1 ? s.label : ''}, ${i})`;
  }
}

/** 约束拦下时翻译成看得懂的提示：项目已经在别的菜里、项目或图片不存在 */
async function dishError(db: Db, error: unknown, d: DishData): Promise<unknown> {
  if (isUniqueViolation(error, 'emenu_dish_specs_item_uq')) {
    const [taken] = await db<{ itemName: string; dishName: string }[]>`
      SELECT i.name AS item_name, d.name AS dish_name FROM emenu_dish_specs sp JOIN service_items i ON i.id = sp.item_id JOIN emenu_dishes d ON d.id = sp.dish_id
      WHERE sp.item_id IN ${db(d.specs.map((s) => s.itemId))} LIMIT 1`;
    return conflict('ITEM_IN_OTHER_DISH', taken ? `价目项目「${taken.itemName}」已经在菜品「${taken.dishName}」里了，一个项目只能放进一道菜` : '有价目项目已经在别的菜品里了');
  }
  if (isForeignKeyViolation(error)) return unprocessable('DISH_REF_NOT_FOUND', '选的价目项目或图片不存在，请重新载入后再试');
  return error;
}

export async function createEmenuDish(deps: Deps, raw: unknown, ctx: OpContext): Promise<EmenuAdmin> {
  const d = parse(DishFields, raw);
  checkSpecs(d);
  try {
    await deps.sql.begin(async (tx) => {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO emenu_dishes (name, name_en, tagline, description, attrs, unit, image_id, detail_image_id, active, created_by, updated_by)
        VALUES (${d.name}, ${d.nameEn}, ${d.tagline}, ${d.description}, ${d.attrs}, ${d.unit}, ${d.imageId}, ${d.detailImageId}, ${d.active}, ${ctx.actor.id}, ${ctx.actor.id})
        RETURNING id`;
      await writeSpecs(tx, Number(row!.id), d);
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'emenu_saved', targetType: 'emenu_dish', targetId: row!.id, detail: { summary: `新建电子菜单菜品「${d.name}」` }, ip: ctx.ip });
    });
  } catch (error) {
    throw await dishError(deps.sql, error, d);
  }
  return emenuAdmin(deps.sql);
}

export async function updateEmenuDish(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<EmenuAdmin> {
  const d = parse(DishUpdate, raw);
  checkSpecs(d);
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [cur] = await tx<{ name: string; version: number }[]>`SELECT name, version FROM emenu_dishes WHERE id = ${id} FOR UPDATE`;
      if (!cur) throw notFound('菜品不存在');
      if (cur.version !== d.version) throw changed(`菜品「${cur.name}」`);
      await tx`
        UPDATE emenu_dishes SET name = ${d.name}, name_en = ${d.nameEn}, tagline = ${d.tagline}, description = ${d.description}, attrs = ${d.attrs}, unit = ${d.unit},
               image_id = ${d.imageId}, detail_image_id = ${d.detailImageId}, active = ${d.active}, version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
        WHERE id = ${id}`;
      await writeSpecs(tx, id, d);
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'emenu_saved', targetType: 'emenu_dish', targetId: id, detail: { summary: `修改电子菜单菜品「${cur.name}」${d.active ? '' : '（停用）'}` }, ip: ctx.ip });
    });
  } catch (error) {
    throw await dishError(deps.sql, error, d);
  }
  return emenuAdmin(deps.sql);
}

// ───────────────────────── 从价目表生成初稿 ─────────────────────────

/**
 * 还没进电子菜单的进厨房的菜，各建一道（展示名用项目名）；按价目表的分类归到同名的电子菜单分类（没有就建），
 * 新建的菜按 10 道一页排成「文字陈列」接在这个分类后面。已经有的菜、已经排好的页都不动，可以重复点。
 */
export async function generateEmenuDraft(deps: Deps, ctx: OpContext): Promise<EmenuAdmin & { draft: { dishes: number; categories: number; pages: number } }> {
  const draft = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtext('emenu_draft'))`;
    const items = (await loadItemOptions(tx)).filter((i) => i.dishId === null);
    const byCategory = new Map<string, EmenuItemOption[]>();
    for (const i of items) byCategory.set(i.category || '其他', [...(byCategory.get(i.category || '其他') ?? []), i]);
    let categories = 0;
    let pages = 0;
    for (const [name, list] of byCategory) {
      const dishIds: number[] = [];
      for (const item of list) {
        const [d] = await tx<{ id: number }[]>`
          INSERT INTO emenu_dishes (name, created_by, updated_by) VALUES (${item.name}, ${ctx.actor.id}, ${ctx.actor.id}) RETURNING id`;
        await tx`INSERT INTO emenu_dish_specs (dish_id, item_id) VALUES (${d!.id}, ${item.id})`;
        dishIds.push(Number(d!.id));
      }
      let [cat] = await tx<{ id: number }[]>`SELECT id FROM emenu_categories WHERE lower(btrim(name)) = lower(${name}) FOR UPDATE`;
      if (!cat) {
        const [last] = await tx<{ n: number }[]>`SELECT coalesce(max(sort_order), 0)::int AS n FROM emenu_categories`;
        [cat] = await tx<{ id: number }[]>`
          INSERT INTO emenu_categories (name, sort_order, created_by, updated_by) VALUES (${name}, ${last!.n + 10}, ${ctx.actor.id}, ${ctx.actor.id}) RETURNING id`;
        categories += 1;
      }
      const [next] = await tx<{ n: number }[]>`SELECT coalesce(max(sort_no) + 1, 0)::int AS n FROM emenu_pages WHERE category_id = ${cat!.id}`;
      const perPage = EMENU_LAYOUT_INFO.list_text.slots;
      for (let i = 0; i < dishIds.length; i += perPage) {
        const sortNo = next!.n + i / perPage;
        if (sortNo >= EMENU_MAX_PAGES) throw unprocessable('PAGE_LIMIT', `分类「${name}」的页数超过 ${EMENU_MAX_PAGES} 页了，请先整理这个分类再生成`);
        const [p] = await tx<{ id: number }[]>`
          INSERT INTO emenu_pages (category_id, sort_no, layout, title) VALUES (${cat!.id}, ${sortNo}, 'list_text', ${name.length <= 8 ? name : ''}) RETURNING id`;
        for (const [slot, dishId] of dishIds.slice(i, i + perPage).entries()) {
          await tx`INSERT INTO emenu_page_dishes (page_id, slot_no, dish_id) VALUES (${p!.id}, ${slot}, ${dishId})`;
        }
        pages += 1;
      }
      await tx`UPDATE emenu_categories SET version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now() WHERE id = ${cat!.id}`;
    }
    if (items.length) {
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'emenu_draft',
        targetType: 'emenu',
        detail: { summary: `从价目表生成电子菜单初稿：${items.length} 道菜、新建 ${categories} 个分类、${pages} 页`, dishes: items.length, categories, pages },
        ip: ctx.ip,
      });
    }
    return { dishes: items.length, categories, pages };
  });
  return { ...(await emenuAdmin(deps.sql)), draft };
}

/** 设置有没有改过（规则总表用）：与默认值比 */
export const emenuRulesChanged = (rules: EmenuRules) => !sameJson(rules, DEFAULT_EMENU_RULES);
