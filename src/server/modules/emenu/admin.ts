// 后台「电子菜单」（8.0.10，docs/EMENU.md 第 4.1 节）：设置、分类与供应时段、每个分类的各页（版面 + 放哪几道菜）、
// 菜品图文与规格、从价目表生成初稿。
//
// 加锁：
//   · 设置走规则锁（saveRuleSetting），带页面打开时的版本，别人先保存过拒绝（EMENU_CHANGED）；
//   · 分类自己的信息与它的各页共用一个版本号：修改、保存各页都只锁那个分类一行，版本号对不上拒绝；各页整批换（先删后建）；
//   · 菜品图文的修改只锁那道菜一行（带版本号），规格整批换；「一个价目项目只在一道菜里」靠唯一索引兜底；
//   · 新建分类、新建菜品不带操作编号：分类名、规格的唯一索引兜底，重复提交会被拒绝而不是建出两份；
//   · 生成初稿先取电子菜单的咨询锁、全部串行；图片按内容去重、不加锁；
//   · 导入英文对照表（8.0.13）：一个事务里按菜品编号升序锁菜品一行，只改有变化的、版本号加一；同样的内容再导一次什么都不改。

import { z } from 'zod';
import { defaultTier, type TierPrice } from '@shared/catalog';
import {
  DEFAULT_EMENU_RULES,
  emenuNoteWorstCase,
  EMENU_LAYOUT_INFO,
  EMENU_LAYOUTS,
  EMENU_ATTR_EN_MAX,
  EMENU_ATTR_SEPARATOR,
  EMENU_ENGLISH_COLUMNS,
  EMENU_ENGLISH_MAX_ROWS,
  emenuSheetCellOut,
  EMENU_MAX_AVOID_OPTIONS,
  EMENU_MAX_FOOTER,
  EMENU_MAX_IDLE_MINUTES,
  EMENU_MAX_NOTE,
  EMENU_MAX_OPTION_EN,
  EMENU_MAX_OPTION_LENGTH,
  EMENU_MAX_PAGES,
  EMENU_MAX_SERVE_OPTIONS,
  type EmenuAdmin,
  type EmenuCategoryAdmin,
  type EmenuDishAdmin,
  type EmenuEnglishResult,
  type EmenuItemOption,
  type EmenuLayout,
  type EmenuPageAdmin,
  type EmenuRules,
} from '@shared/emenu';
import { isForeignKeyViolation, isUniqueViolation, type Db, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { toCsv } from '../../lib/csv';
import { hashRequest } from '../../lib/idempotency';
import { saveRuleSetting } from '../../lib/rule-settings';
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
    SELECT id, name, name_en, tagline, description, attrs, unit, tagline_en, description_en, attrs_en, unit_en, image_id, detail_image_id, active, version
    FROM emenu_dishes ORDER BY active DESC, id`;
  const specs = await db<{ dishId: number; itemId: number; label: string; labelEn: string; itemName: string; prices: TierPrice[]; orderable: boolean }[]>`
    SELECT sp.dish_id, sp.item_id, sp.label, sp.label_en, i.name AS item_name, ${pricesColumn(db)} AS prices,
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
      .map((s) => ({ itemId: Number(s.itemId), label: s.label, labelEn: s.labelEn, itemName: s.itemName, price: defaultPrice(s.prices), orderable: s.orderable })),
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
  langSwitch: z.boolean(),
  optionsEn: z.record(z.string().max(EMENU_MAX_OPTION_LENGTH), z.string().trim().max(EMENU_MAX_OPTION_EN, `选项的英文最多 ${EMENU_MAX_OPTION_EN} 个字符`)),
  motion: z.boolean(),
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
      const merged = parse(RulesInput, { ...DEFAULT_EMENU_RULES, ...before, ...patch });
      // 选项的英文只留现在还有的选项、填了字的（删掉的选项的英文跟着去掉）
      const options = new Set([...merged.avoidOptions, ...merged.serveOptions]);
      const next = { ...merged, optionsEn: Object.fromEntries(Object.entries(merged.optionsEn).filter(([k, v]) => options.has(k) && v)) };
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
  taglineEn: z.string().trim().max(80, '小字的英文最多 80 个字符').default(''),
  descriptionEn: z.string().trim().max(400, '英文介绍最多 400 个字符').default(''),
  attrsEn: z.array(z.string().trim().min(1, '属性行的英文不能有空行').max(EMENU_ATTR_EN_MAX, `属性行的英文每行最多 ${EMENU_ATTR_EN_MAX} 个字符`)).max(3, '属性行的英文最多 3 行').default([]),
  unitEn: z.string().trim().max(12, '单位的英文最多 12 个字符').default(''),
  imageId,
  detailImageId: imageId,
  active: z.boolean().default(true),
  specs: z
    .array(
      z.object({
        itemId: z.number('请选择价目项目').int().positive('请选择价目项目'),
        label: z.string().trim().max(8, '规格名最多 8 个字').default(''),
        labelEn: z.string().trim().max(16, '规格的英文最多 16 个字符').default(''),
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
    await tx`INSERT INTO emenu_dish_specs (dish_id, item_id, label, label_en, sort_no) VALUES (${dishId}, ${s.itemId}, ${d.specs.length > 1 ? s.label : ''}, ${d.specs.length > 1 ? s.labelEn : ''}, ${i})`;
  }
}

/** 约束拦下时翻译成看得懂的提示：项目已经在别的菜里、项目或图片不存在 */
async function dishError(db: Db, error: unknown, d: DishData, selfId: number | null): Promise<unknown> {
  if (isUniqueViolation(error, 'emenu_dish_specs_item_uq')) {
    // 找占着这个项目的别的菜（正在改的这道菜自己的规格不算）
    const [taken] = await db<{ itemName: string; dishName: string }[]>`
      SELECT i.name AS item_name, d.name AS dish_name FROM emenu_dish_specs sp JOIN service_items i ON i.id = sp.item_id JOIN emenu_dishes d ON d.id = sp.dish_id
      WHERE sp.item_id IN ${db(d.specs.map((s) => s.itemId))} AND sp.dish_id <> ${selfId ?? 0} ORDER BY sp.item_id LIMIT 1`;
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
        INSERT INTO emenu_dishes (name, name_en, tagline, description, attrs, unit, tagline_en, description_en, attrs_en, unit_en, image_id, detail_image_id, active, created_by, updated_by)
        VALUES (${d.name}, ${d.nameEn}, ${d.tagline}, ${d.description}, ${d.attrs}, ${d.unit}, ${d.taglineEn}, ${d.descriptionEn}, ${d.attrsEn}, ${d.unitEn},
                ${d.imageId}, ${d.detailImageId}, ${d.active}, ${ctx.actor.id}, ${ctx.actor.id})
        RETURNING id`;
      await writeSpecs(tx, Number(row!.id), d);
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'emenu_saved', targetType: 'emenu_dish', targetId: row!.id, detail: { summary: `新建电子菜单菜品「${d.name}」` }, ip: ctx.ip });
    });
  } catch (error) {
    throw await dishError(deps.sql, error, d, null);
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
               tagline_en = ${d.taglineEn}, description_en = ${d.descriptionEn}, attrs_en = ${d.attrsEn}, unit_en = ${d.unitEn},
               image_id = ${d.imageId}, detail_image_id = ${d.detailImageId}, active = ${d.active}, version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
        WHERE id = ${id}`;
      await writeSpecs(tx, id, d);
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'emenu_saved', targetType: 'emenu_dish', targetId: id, detail: { summary: `修改电子菜单菜品「${cur.name}」${d.active ? '' : '（停用）'}` }, ip: ctx.ip });
    });
  } catch (error) {
    throw await dishError(deps.sql, error, d, id);
  }
  return emenuAdmin(deps.sql);
}

// ───────────────────────── 英文对照表（8.0.13） ─────────────────────────

/** 导出：每道菜一行，中文各列给翻译的人看、英文各列填好再导入（列名见 EMENU_ENGLISH_COLUMNS） */
export async function emenuEnglishCsv(db: Db): Promise<string> {
  const dishes = await db<{ id: number; name: string; nameEn: string; tagline: string; taglineEn: string; description: string; descriptionEn: string; attrs: string[]; attrsEn: string[]; unit: string; unitEn: string }[]>`
    SELECT id, name, name_en, tagline, tagline_en, description, description_en, attrs, attrs_en, unit, unit_en FROM emenu_dishes ORDER BY active DESC, id`;
  return toCsv([
    [...EMENU_ENGLISH_COLUMNS],
    // 文字各列过一遍 emenuSheetCellOut：防表格公式的单引号读回来时能原样去掉（见 @shared/emenu）
    ...dishes.map((d) => [
      Number(d.id),
      ...[d.name, d.nameEn, d.tagline, d.taglineEn, d.description, d.descriptionEn, d.attrs.join(EMENU_ATTR_SEPARATOR), d.attrsEn.join(EMENU_ATTR_SEPARATOR), d.unit, d.unitEn].map(emenuSheetCellOut),
    ]),
  ]);
}

const englishText = (max: number, label: string) => z.string().trim().max(max, `${label}最多 ${max} 个字符`).optional();
const EnglishInput = z.object({
  rows: z
    .array(
      z.object({
        id: z.number('编号不对').int('编号不对').positive('编号不对'),
        nameEn: englishText(80, '英文名'),
        taglineEn: englishText(80, '小字的英文'),
        descriptionEn: englishText(400, '英文介绍'),
        attrsEn: z.array(z.string().trim().min(1).max(EMENU_ATTR_EN_MAX, `属性行的英文每条最多 ${EMENU_ATTR_EN_MAX} 个字符`)).max(3, '属性行的英文最多 3 条').optional(),
        unitEn: englishText(12, '单位的英文'),
      }),
      '没有要导入的内容',
    )
    .min(1, '没有要导入的内容')
    .max(EMENU_ENGLISH_MAX_ROWS, `一次最多导入 ${EMENU_ENGLISH_MAX_ROWS} 行`),
});

/**
 * 导入英文对照表：只更新英文各列、只认给了字的项（空着的不动原来的英文）；编号对不上的跳过、在结果里列出。
 * 一个事务里按编号升序锁菜品一行；有变化的版本号加一（开着的修改菜品窗口再保存会被拒绝、要重新载入）。
 */
export async function importEmenuEnglish(deps: Deps, raw: unknown, ctx: OpContext): Promise<EmenuAdmin & { english: EmenuEnglishResult }> {
  const { rows } = parse(EnglishInput, raw);
  const ids = rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw unprocessable('ENGLISH_DUPLICATE_ID', '同一个编号出现了两次，请检查文件');
  const english = await deps.sql.begin(async (tx): Promise<EmenuEnglishResult> => {
    await setTxTimeouts(tx);
    const current = await tx<{ id: number; nameEn: string; taglineEn: string; descriptionEn: string; attrsEn: string[]; unitEn: string }[]>`
      SELECT id, name_en, tagline_en, description_en, attrs_en, unit_en FROM emenu_dishes WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
    const byId = new Map(current.map((c) => [Number(c.id), c]));
    let updated = 0;
    for (const r of [...rows].sort((a, b) => a.id - b.id)) {
      const cur = byId.get(r.id);
      if (!cur) continue;
      const next = {
        nameEn: r.nameEn || cur.nameEn,
        taglineEn: r.taglineEn || cur.taglineEn,
        descriptionEn: r.descriptionEn || cur.descriptionEn,
        attrsEn: r.attrsEn?.length ? r.attrsEn : cur.attrsEn,
        unitEn: r.unitEn || cur.unitEn,
      };
      if (next.nameEn === cur.nameEn && next.taglineEn === cur.taglineEn && next.descriptionEn === cur.descriptionEn && next.unitEn === cur.unitEn && JSON.stringify(next.attrsEn) === JSON.stringify(cur.attrsEn)) continue;
      await tx`
        UPDATE emenu_dishes SET name_en = ${next.nameEn}, tagline_en = ${next.taglineEn}, description_en = ${next.descriptionEn}, attrs_en = ${next.attrsEn}, unit_en = ${next.unitEn},
               version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
        WHERE id = ${r.id}`;
      updated += 1;
    }
    const missing = ids.filter((id) => !byId.has(id)).sort((a, b) => a - b);
    if (updated > 0) {
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'emenu_saved',
        targetType: 'emenu',
        detail: { summary: `导入电子菜单的英文对照表：更新 ${updated} 道菜${missing.length ? `，${missing.length} 个编号对不上` : ''}`, updated, missing: missing.slice(0, 50) },
        ip: ctx.ip,
      });
    }
    return { updated, unchanged: current.length - updated, missing };
  });
  return { ...(await emenuAdmin(deps.sql)), english };
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
  }).catch((error: unknown) => {
    // 生成的时候别人正好把同一个项目放进了菜品、或新建了同名的分类：整批不写，请他再点一次（只补还没有的）
    if (isUniqueViolation(error)) throw changed('电子菜单');
    throw error;
  });
  return { ...(await emenuAdmin(deps.sql)), draft };
}
