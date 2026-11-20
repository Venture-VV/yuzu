// 菜品导入（8.1.15，docs/DISHES_V8115.md 第 6 节）：Excel / CSV，先预览再生效，逐行写问题，整份有问题不写。
//
// 一行一道菜：有「编号」的按编号找，没有的按名称找，找不到就新建；已有的菜格子空着是不改，做法、加料、套餐内容、某一档价格写「无」是清掉。
// 预览就是把整份照生效的做法在事务里跑一遍、最后回滚——核对的规矩与单道保存完全是同一套（同一批函数、同一批约束与权限），
// 不会出现「预览说能导、生效时被拒绝」；每一行在一个保存点里做，有问题的记下原因、只回滚这一行，接着看下一行。
// 生效时带回预览的摘要（planHash）：预览以后菜品被别人改过、文件换过，算出来的不一样就拒绝，请重新预览。
// 摘要里带着要改的那几道菜的版本（8.1.16）：改过去又改回来也算改过，晚到的生效请求不会把别人刚定下的又改一遍。
//
// 加锁（docs/LOCKING.md 第 1 节）：操作编号的咨询锁 →「菜品维护」咨询锁 → 全部价目项目（id 升序，FOR NO KEY UPDATE，与价目表导入同一个顺序）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRICE_TIERS, type TierPrice } from '@shared/catalog';
import { DINING_OUTLET_LABELS, outletDef, slotKey, slotLabel, type DiningSlot } from '@shared/dining';
import {
  DISH_IMPORT_MAX_ROWS,
  DISH_OUTLET_PERMISSIONS,
  DISH_SHEET_CLEAR,
  DISH_TIER_COLUMNS,
  MAX_COMBO_ITEMS,
  MAX_DISH_ADDONS,
  MAX_DISH_CATEGORY,
  MAX_DISH_METHOD_GROUP_LENGTH,
  MAX_DISH_METHOD_GROUPS,
  MAX_DISH_METHOD_LENGTH,
  MAX_DISH_METHOD_PRICE,
  MAX_DISH_METHODS,
  MAX_DISH_NAME,
  MAX_PRICE_REASON,
  methodsCellText,
  outletNeedsGroup,
  parseMethodsCell,
  parseComboPart,
  parseSheetOutlet,
  parseSheetPrice,
  parseSheetStatus,
  partsText,
  priceChangeText,
  priceDiff,
  pricesText,
  splitSheetList,
  type DishImportChange,
  type DishImportIssue,
  type DishImportPreview,
  type DishImportResult,
  type DishMethodGroup,
  type DishMethodOption,
} from '@shared/dishes';
import type { Tx } from '../db';
import { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { AppError, badRequest, conflict, unprocessable } from '../lib/errors';
import { hashRequest } from '../lib/idempotency';
import { readSheet, type Sheet } from '../lib/sheet-read';
import { setTxTimeouts } from '../lib/tx';
import { parse } from '../lib/validate';
import { changeDishPriceTx, createDishTx, isDishState, lockDishLedger, readItems, runDishOp, setDishActiveTx, slotOfState, updateDishTx, type DishFieldsData, type ItemState } from './dishes';

const FileInput = z
  .object({
    fileName: z.string('请选择文件').trim().min(1, '请选择文件').max(200, '文件名太长'),
    csv: z.string().max(3_000_000, '文件太大').optional(),
    xlsxBase64: z.string().max(6_000_000, '文件太大').optional(),
  })
  .refine((f) => (f.csv === undefined) !== (f.xlsxBase64 === undefined), '请选择一个 CSV 或 Excel 文件');
const ApplyInput = FileInput.extend({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  planHash: z.string('请先预览').regex(/^[0-9a-f]{64}$/, '请先预览'),
  /** 改价原因：这份表里有改价时必填 */
  reason: z.string().trim().max(MAX_PRICE_REASON, `原因最多 ${MAX_PRICE_REASON} 个字`).default(''),
});

const norm = (s: string) => s.trim().toLowerCase();

/** 一行想要的样子：undefined 的项不改 */
interface RowPlan {
  row: number;
  name: string;
  target: ItemState | null;
  problems: string[];
  category?: string;
  slot?: DiningSlot;
  stationId?: number;
  prices?: TierPrice[];
  active?: boolean;
  /** 做法（8.1.17 带分组、加价、必选；「做法」一格的写法见 methodsCellText） */
  methods?: MethodSet;
  addonNames?: string[];
  comboParts?: { name: string; quantity: number }[];
  /** 这一行新建 / 修改以后是哪道菜 */
  itemId?: number;
  /** 加料、套餐内容按菜名找到的那几道（预览摘要里带上它们的版本） */
  refIds?: number[];
  fields: string[];
  created: boolean;
  priceChanged: boolean;
}

interface MethodSet {
  options: DishMethodOption[];
  groups: DishMethodGroup[];
}

/** 一道菜的做法按「做法」一格的写法（比较有没有变、写预览） */
const methodsTextOf = (f: Pick<DishFieldsData, 'methods' | 'methodGroups'>) =>
  methodsCellText(
    f.methods.map((m) => (typeof m === 'string' ? { name: m, group: '', price: 0 } : m)),
    f.methodGroups ?? [],
  );

interface Kids {
  methods: MethodSet;
  addons: number[];
  combo: { itemId: number; quantity: number }[];
}

async function runImport(tx: Tx, ctx: OpContext, sheet: Sheet, reason: string): Promise<Omit<DishImportPreview, 'fileName'>> {
  if (!sheet.header.includes('名称')) throw unprocessable('IMPORT_FILE_INVALID', '文件里没有「名称」这一列：请用「导出全部」的表，或照模板的列名写');
  if (sheet.rows.length === 0) throw unprocessable('IMPORT_EMPTY', '文件里没有菜品（只有表头）');
  if (sheet.rows.length > DISH_IMPORT_MAX_ROWS) throw unprocessable('IMPORT_TOO_LARGE', `一次最多导入 ${DISH_IMPORT_MAX_ROWS} 道，这份有 ${sheet.rows.length} 行，请分几份`);
  const col = (name: string) => sheet.header.indexOf(name);
  const cell = (r: Sheet['rows'][number], name: string) => (col(name) < 0 ? '' : (r.cells[col(name)] ?? '').trim());

  // 全部价目项目按 id 升序锁住（与价目表导入同一个顺序；这一步以后的单道核对不会再等锁）
  const allIds = (await tx<{ id: number }[]>`SELECT id FROM service_items ORDER BY id FOR NO KEY UPDATE`).map((r) => r.id);
  const items = await readItems(tx, allIds);
  const stations = await tx<{ id: number; name: string }[]>`SELECT id, name FROM kitchen_stations`;
  const stationByName = new Map(stations.map((s) => [norm(s.name), s]));
  const stationName = (id: number) => stations.find((s) => s.id === id)?.name ?? '';
  // 现在的做法、加料、套餐内容（比较有没有变）
  const kids = new Map<number, Kids>();
  const kidsOf = (id: number) => {
    let k = kids.get(id);
    if (!k) kids.set(id, (k = { methods: { options: [], groups: [] }, addons: [], combo: [] }));
    return k;
  };
  for (const m of await tx<{ itemId: number; name: string; groupName: string | null; price: number }[]>`
    SELECT item_id, name, group_name, price FROM dish_methods ORDER BY item_id, sort_no, name`)
    kidsOf(m.itemId).methods.options.push({ name: m.name, group: m.groupName ?? '', price: m.price });
  for (const g of await tx<{ itemId: number; name: string; required: boolean }[]>`SELECT item_id, name, required FROM dish_method_groups ORDER BY item_id, sort_no, name`)
    kidsOf(g.itemId).methods.groups.push({ name: g.name, required: g.required });
  for (const a of await tx<{ itemId: number; addonItemId: number }[]>`SELECT item_id, addon_item_id FROM dish_addons ORDER BY item_id, sort_no, addon_item_id`)
    kidsOf(a.itemId).addons.push(a.addonItemId);
  for (const c of await tx<{ comboItemId: number; itemId: number; quantity: number }[]>`
    SELECT combo_item_id, item_id, quantity FROM dish_combo_items ORDER BY combo_item_id, sort_no, item_id`)
    kidsOf(c.comboItemId).combo.push({ itemId: c.itemId, quantity: c.quantity });

  // 按名称找：菜品（能当加料、放进套餐、按名称对上行）与不是菜品的价目项目（同名的不能再新建）
  const byName = new Map<string, ItemState[]>();
  for (const it of items.values()) byName.set(norm(it.name), [...(byName.get(norm(it.name)) ?? []), it]);
  /** 菜名 → 编号（随新建、改名更新）：加料、套餐内容按它找 */
  const dishIndex = new Map<string, number[]>();
  const indexAdd = (name: string, id: number) => dishIndex.set(norm(name), [...(dishIndex.get(norm(name)) ?? []), id]);
  const indexDrop = (name: string, id: number) =>
    dishIndex.set(
      norm(name),
      (dishIndex.get(norm(name)) ?? []).filter((x) => x !== id),
    );
  for (const it of items.values()) if (isDishState(it)) indexAdd(it.name, it.id);
  const nameNow = new Map<number, string>([...items.values()].map((it) => [it.id, it.name]));

  // ── 第 0 步：逐行读成「想要的样子」 ──
  const seenTarget = new Map<number, number>();
  const seenNew = new Map<string, number>();
  const plans: RowPlan[] = sheet.rows.map((r) => {
    const p: RowPlan = { row: r.row, name: cell(r, '名称'), target: null, problems: [], fields: [], created: false, priceChanged: false };
    const bad = (message: string) => p.problems.push(message);
    if (!p.name) bad('名称为空');
    else if (p.name.length > MAX_DISH_NAME) bad(`名称超过 ${MAX_DISH_NAME} 个字`);

    // 找到哪道菜
    const idText = cell(r, '编号');
    if (idText) {
      const it = /^[0-9]+$/.test(idText) ? items.get(Number(idText)) : undefined;
      if (!it || !isDishState(it)) bad(`编号 ${idText} 不是菜品（新菜的编号请留空）`);
      else p.target = it;
    } else if (p.name) {
      const same = byName.get(norm(p.name)) ?? [];
      const dishes = same.filter(isDishState);
      if (dishes.length === 1) p.target = dishes[0]!;
      else if (dishes.length > 1) bad(`有 ${dishes.length} 道菜都叫「${p.name}」，请在「编号」一列写明是哪一道`);
      else if (same.length > 0) bad(`价目里已有「${p.name}」，但它不是菜品（没挂出品档口或需要技师）；要当菜品卖，先在后台「餐饮」里给它挂上出品档口`);
    }
    if (p.target) {
      const before = seenTarget.get(p.target.id);
      if (before !== undefined) bad(`与第 ${before} 行是同一道菜`);
      else seenTarget.set(p.target.id, r.row);
    } else if (p.name && p.problems.length === 0) {
      const before = seenNew.get(norm(p.name));
      if (before !== undefined) bad(`与第 ${before} 行重名`);
      else seenNew.set(norm(p.name), r.row);
    }
    // 这一行是哪道菜都没认出来（名称为空、编号不对、重名……）：后面只看写了的格子对不对，不再按新菜要求必填的几项
    const isNew = !p.target && p.problems.length === 0;
    const known = p.target !== null || isNew;

    const category = cell(r, '分类');
    if (category.length > MAX_DISH_CATEGORY) bad(`分类超过 ${MAX_DISH_CATEGORY} 个字`);
    else if (category) p.category = category;

    // 出品口与小类一起看
    const outletText = cell(r, '出品口');
    const groupText = cell(r, '小类');
    const current = p.target ? slotOfState(p.target) : null;
    if (outletText || groupText) {
      const outlet = outletText ? parseSheetOutlet(outletText) : (current?.outlet ?? null);
      if (outletText && !outlet) bad(`出品口「${outletText}」不认识（写餐厅、水吧或果吧）`);
      else if (!outlet) bad('新菜只写了小类，没写出品口');
      else if (!outletNeedsGroup(outlet)) {
        if (groupText) bad(`${DINING_OUTLET_LABELS[outlet]}不分小类，小类请留空`);
        else p.slot = { outlet, group: '' };
      } else {
        const group = groupText || (current?.outlet === outlet ? current.group : '');
        if (!group) bad(`${DINING_OUTLET_LABELS[outlet]}要写小类（${outletDef(outlet).groups.join('、')}）`);
        else if (!outletDef(outlet).groups.includes(group)) bad(`${DINING_OUTLET_LABELS[outlet]}没有「${group}」这个小类（有 ${outletDef(outlet).groups.join('、')}）`);
        else p.slot = { outlet, group };
      }
    } else if (isNew) bad('新菜要写出品口（餐厅、水吧或果吧）');

    const stationText = cell(r, '档口');
    if (stationText) {
      const st = stationByName.get(norm(stationText));
      if (!st) bad(`档口「${stationText}」不存在（先在后台「餐饮 → 出品档口与菜品」里建）`);
      else p.stationId = st.id;
    } else if (isNew) bad('新菜要写档口');

    // 价格：空着不改，「无」去掉这一档
    let prices: TierPrice[] = p.target ? [...p.target.prices] : [];
    let priceTouched = false;
    for (const tier of PRICE_TIERS) {
      const text = cell(r, DISH_TIER_COLUMNS[tier]);
      if (!text) continue;
      priceTouched = true;
      prices = prices.filter((x) => x.tier !== tier);
      if (text === DISH_SHEET_CLEAR) continue;
      const price = parseSheetPrice(text);
      if (price === null) bad(`${DISH_TIER_COLUMNS[tier]}「${text}」不是有效的金额（写元，最多两位小数）`);
      else prices.push({ tier, price });
    }
    prices = PRICE_TIERS.flatMap((tier) => prices.filter((x) => x.tier === tier));
    if (prices.length === 0 && known) bad(isNew ? '新菜至少要写一档价格' : '不能把价格全去掉（至少留一档）');
    else if (priceTouched || isNew) p.prices = prices;

    const status = parseSheetStatus(cell(r, '状态'));
    if (status === null) bad(`状态「${cell(r, '状态')}」不认识（写上架或下架）`);
    else if (status !== undefined) p.active = status;

    const methodsText = cell(r, '做法');
    if (methodsText) {
      // 8.1.17：分组的写「辣度（必选）：微辣、中辣+2」，几段用「；」隔开；只写名字的（8.1.15 的导出）照样认
      const parsed = methodsText === DISH_SHEET_CLEAR ? { options: [], groups: [] } : parseMethodsCell(methodsText);
      if ('error' in parsed) bad(`做法：${parsed.error}`);
      else {
        const long = parsed.options.find((m) => m.name.length > MAX_DISH_METHOD_LENGTH || /[\s+＋:：]/.test(m.name));
        const longGroup = parsed.groups.find((g) => g.name.length > MAX_DISH_METHOD_GROUP_LENGTH || /\s/.test(g.name));
        const pricey = parsed.options.find((m) => m.price > MAX_DISH_METHOD_PRICE);
        if (long) bad(`做法「${long.name}」太长或带了空格（一种做法最多 ${MAX_DISH_METHOD_LENGTH} 个字）`);
        else if (longGroup) bad(`做法的组「${longGroup.name}」太长或带了空格（组名最多 ${MAX_DISH_METHOD_GROUP_LENGTH} 个字）`);
        else if (pricey) bad(`做法「${pricey.name}」最多加价 ¥${MAX_DISH_METHOD_PRICE / 100}`);
        else if (parsed.options.length > MAX_DISH_METHODS) bad(`做法最多 ${MAX_DISH_METHODS} 种`);
        else if (parsed.groups.length > MAX_DISH_METHOD_GROUPS) bad(`做法最多分 ${MAX_DISH_METHOD_GROUPS} 组`);
        else p.methods = parsed;
      }
    }
    const addonsText = cell(r, '加料');
    if (addonsText) {
      const list = addonsText === DISH_SHEET_CLEAR ? [] : splitSheetList(addonsText);
      if (list.length > MAX_DISH_ADDONS) bad(`加料最多 ${MAX_DISH_ADDONS} 种`);
      else p.addonNames = list;
    }
    const comboText = cell(r, '套餐内容');
    if (comboText) {
      const parts = comboText === DISH_SHEET_CLEAR ? [] : splitSheetList(comboText).map((t) => ({ text: t, part: parseComboPart(t) }));
      const wrong = parts.find((x) => !x.part);
      if (wrong) bad(`套餐内容「${wrong.text}」看不懂（写「菜名×份数」，份数 1–99）`);
      else if (parts.length > MAX_COMBO_ITEMS) bad(`一个套餐最多含 ${MAX_COMBO_ITEMS} 样`);
      else if (new Set(parts.map((x) => norm(x.part!.name))).size !== parts.length) bad('套餐内容里同一道菜写了两次');
      else p.comboParts = parts.map((x) => x.part!);
    }
    return p;
  });

  /** 一行的写入放在保存点里：被拒绝（规矩、权限）的记下原因、只回滚这一行；别的错误照旧抛出 */
  const attempt = async (p: RowPlan, fn: (sp: Tx) => Promise<void>) => {
    try {
      await tx.savepoint((sp) => fn(sp));
      return true;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      p.problems.push(error.message);
      return false;
    }
  };
  /** 每道菜现在的样子（随这次导入的写入更新）：第二步改加料、套餐内容时别的项照它带 */
  const fieldsNow = new Map<number, DishFieldsData>();
  const fieldsOf = (it: ItemState): DishFieldsData => {
    const k = kidsOf(it.id);
    return {
      name: it.name,
      category: it.category,
      slot: slotKey(slotOfState(it)),
      stationId: it.stationId!,
      imageId: it.dishImageId,
      methods: k.methods.options.map((m) => ({ ...m })),
      methodGroups: k.methods.groups.map((g) => ({ ...g })),
      addons: [...k.addons],
      combo: k.combo.map((c) => ({ ...c })),
    };
  };

  // ── 第 1 步：新建；已有的改名称、分类、出品口、档口、做法、价格、上下架 ──
  for (const p of plans) {
    if (p.problems.length) continue;
    if (!p.target) {
      const f: DishFieldsData = {
        name: p.name,
        category: p.category ?? '',
        slot: slotKey(p.slot!),
        stationId: p.stationId!,
        imageId: null,
        methods: p.methods?.options ?? [],
        methodGroups: p.methods?.groups ?? [],
        addons: [],
        combo: [],
      };
      const active = p.active ?? true;
      const ok = await attempt(p, async (sp) => {
        p.itemId = await createDishTx(sp, ctx, { ...f, prices: p.prices!, active }, { reason: '导入新建', source: 'import' });
      });
      if (!ok) continue;
      p.created = true;
      p.fields.push(`${slotLabel(p.slot!)} · ${stationName(p.stationId!)} · ${pricesText(p.prices!)}${active ? '' : ' · 下架'}${f.methods.length ? ` · 做法 ${methodsTextOf(f)}` : ''}`);
      fieldsNow.set(p.itemId!, f);
      indexAdd(p.name, p.itemId!);
      nameNow.set(p.itemId!, p.name);
      continue;
    }
    const cur = p.target;
    p.itemId = cur.id;
    const base = fieldsOf(cur);
    const next: DishFieldsData = {
      ...base,
      name: p.name,
      category: p.category ?? base.category,
      slot: p.slot ? slotKey(p.slot) : base.slot,
      stationId: p.stationId ?? base.stationId,
      methods: p.methods?.options ?? base.methods,
      methodGroups: p.methods?.groups ?? base.methodGroups,
    };
    const basicChanged = next.name !== base.name || next.category !== base.category || next.slot !== base.slot || next.stationId !== base.stationId || methodsTextOf(next) !== methodsTextOf(base);
    const diff = p.prices ? priceDiff(cur.prices, p.prices) : [];
    const activeChanged = p.active !== undefined && p.active !== cur.active;
    if (!basicChanged && diff.length === 0 && !activeChanged) {
      fieldsNow.set(cur.id, base);
      continue;
    }
    const fields: string[] = [];
    const ok = await attempt(p, async (sp) => {
      if (basicChanged) for (const c of await updateDishTx(sp, ctx, cur.id, next)) fields.push(`${c.label} ${c.before} → ${c.after}`);
      if (diff.length) {
        const r = await changeDishPriceTx(sp, ctx, cur.id, p.prices!, { reason, source: 'import' });
        fields.push(...r.diff.map(priceChangeText));
      }
      if (activeChanged && (await setDishActiveTx(sp, ctx, cur.id, p.active!)).changed) fields.push(p.active ? '下架 → 上架' : '上架 → 下架');
    });
    if (!ok) continue;
    p.fields.push(...fields);
    p.priceChanged = diff.length > 0;
    fieldsNow.set(cur.id, next);
    if (next.name !== base.name) {
      indexDrop(base.name, cur.id);
      indexAdd(next.name, cur.id);
      nameNow.set(cur.id, next.name);
    }
  }

  // ── 第 2 步：加料、套餐内容（按菜名找，这份表里新建的也能用） ──
  for (const p of plans) {
    if (p.problems.length || p.itemId === undefined || (p.addonNames === undefined && p.comboParts === undefined)) continue;
    const id = p.itemId;
    const resolve = (name: string, what: string): number | null => {
      const hit = dishIndex.get(norm(name)) ?? [];
      if (hit.length === 1) return hit[0]!;
      p.problems.push(hit.length === 0 ? `${what}里的「${name}」不是菜品（先在这份表里或菜品管理里建好）` : `${what}里的「${name}」有 ${hit.length} 道同名的菜，分不清是哪一道`);
      return null;
    };
    const base = fieldsNow.get(id)!;
    const addons = p.addonNames?.map((n) => resolve(n, '加料'));
    const combo = p.comboParts?.map((c) => ({ itemId: resolve(c.name, '套餐内容'), quantity: c.quantity }));
    p.refIds = [...(addons ?? []), ...(combo ?? []).map((c) => c.itemId)].filter((x): x is number => x !== null);
    if (p.problems.length) continue;
    const next: DishFieldsData = {
      ...base,
      addons: (addons as number[] | undefined) ?? base.addons,
      combo: (combo as { itemId: number; quantity: number }[] | undefined) ?? base.combo,
    };
    if (new Set(next.addons).size !== next.addons.length) {
      p.problems.push('加料里同一道菜写了两次');
      continue;
    }
    const same = next.addons.join(',') === base.addons.join(',') && next.combo.map((c) => `${c.itemId}×${c.quantity}`).join(',') === base.combo.map((c) => `${c.itemId}×${c.quantity}`).join(',');
    if (same) continue;
    const fields: string[] = [];
    const ok = await attempt(p, async (sp) => {
      for (const c of await updateDishTx(sp, ctx, id, next)) fields.push(`${c.label} ${c.before} → ${c.after}`);
    });
    if (!ok) continue;
    // 新建的那一行：加料、套餐内容接在「新建」那一句后面
    if (p.created) {
      if (next.addons.length) p.fields.push(`加料 ${next.addons.map((a) => nameNow.get(a)).join('、')}`);
      if (next.combo.length) p.fields.push(`套餐内容 ${partsText(next.combo.map((c) => ({ name: nameNow.get(c.itemId) ?? '', quantity: c.quantity })))}`);
    } else p.fields.push(...fields);
    fieldsNow.set(id, next);
  }

  const issues: DishImportIssue[] = plans.flatMap((p) => p.problems.map((message) => ({ row: p.row, message })));
  const changes: DishImportChange[] = plans
    .filter((p) => p.problems.length === 0 && p.fields.length > 0)
    .map((p) => ({ row: p.row, name: p.name, action: p.created ? ('create' as const) : ('update' as const), fields: p.fields }));
  const createCount = changes.filter((c) => c.action === 'create').length;
  const updateCount = changes.length - createCount;
  // 摘要带上要改的那几道菜（与它们按菜名找到的加料、套餐内容）开始时的版本（8.1.16，Codex 审查 d12390f 的 P1）：
  // 预览以后它们被改过——哪怕又改回了原样——摘要就不一样，晚到的生效请求被拒绝（IMPORT_CHANGED），不会把别人刚定下的又改一遍
  const revs = [...new Set(plans.filter((p) => p.problems.length === 0 && p.fields.length > 0).flatMap((p) => [...(p.target ? [p.target.id] : []), ...(p.refIds ?? [])]))]
    .filter((id) => items.has(id))
    .sort((a, b) => a - b)
    .map((id) => `${id}:${items.get(id)!.rev}`);
  return {
    rowCount: plans.length,
    createCount,
    updateCount,
    unchangedCount: plans.filter((p) => p.problems.length === 0 && p.fields.length === 0).length,
    priceChangeCount: plans.filter((p) => p.problems.length === 0 && p.priceChanged).length,
    issues,
    changes,
    planHash: hashRequest({ changes, rowCount: plans.length, revs }),
  };
}

/** 回滚用：预览把整份跑一遍以后抛它，事务回滚，结果带出来 */
class PreviewDone extends Error {
  constructor(readonly result: Omit<DishImportPreview, 'fileName'>) {
    super('preview');
  }
}

/** 预览：照生效的做法跑一遍再回滚，什么都不写 */
export async function previewDishImport(deps: Deps, raw: unknown, ctx: OpContext): Promise<DishImportPreview> {
  const f = parse(FileInput, raw);
  const sheet = readSheet(f);
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockDishLedger(tx);
      throw new PreviewDone(await runImport(tx, ctx, sheet, '（预览）'));
    });
  } catch (error) {
    if (error instanceof PreviewDone) return { fileName: f.fileName, ...error.result };
    throw error;
  }
  throw new Error('菜品导入预览没有结果');
}

/** 生效：整份在一个事务里；有一行有问题就整份不写；与预览时算出来的不一样（菜品被改过、文件换过）拒绝 */
export async function applyDishImport(deps: Deps, raw: unknown, ctx: OpContext): Promise<DishImportResult> {
  const { clientKey: key, ...f } = parse(ApplyInput, raw);
  const run = await runDishOp<Omit<DishImportResult, 'replayed'>>(deps, { key, opType: 'import', requestHash: hashRequest(f), staffId: ctx.actor.id }, async (tx) => {
    const r = await runImport(tx, ctx, readSheet(f), f.reason || '菜品导入');
    if (r.issues.length) {
      throw unprocessable(
        'IMPORT_INVALID',
        `有 ${r.issues.length} 处要先改好才能导入：${r.issues
          .slice(0, 3)
          .map((i) => `第 ${i.row} 行 ${i.message}`)
          .join('；')}`,
        { issues: r.issues },
      );
    }
    if (r.planHash !== f.planHash) throw conflict('IMPORT_CHANGED', '预览以后菜品有变化（或文件换过），请重新预览再生效');
    if (r.changes.length === 0) throw unprocessable('IMPORT_NOTHING', '这份表和现在的菜品一样，没有要改的');
    if (r.priceChangeCount > 0 && f.reason.length < 2) throw badRequest('这份表里有改价，请填写改价原因（至少 2 个字）');
    const result = { created: r.createCount, updated: r.updateCount, unchanged: r.unchangedCount, priceChanges: r.priceChangeCount };
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'dishes_imported',
      targetType: 'item',
      detail: {
        fileName: f.fileName,
        ...result,
        reason: f.reason,
        changes: r.changes.slice(0, 50),
        summary: `导入菜品（${f.fileName}）：新建 ${r.createCount} 道、修改 ${r.updateCount} 道${r.priceChangeCount ? `（其中改价 ${r.priceChangeCount} 道：${f.reason}）` : ''}`.slice(0, 500),
      },
      ip: ctx.ip,
    });
    return { itemId: null, result };
  });
  return { ...run.result, replayed: run.replayed };
}

export function registerDishImportRoutes(app: FastifyInstance, deps: Deps) {
  // 导入会新建、会改菜：要有三个出品口里任一项维护权限才进得来；每一行再按那道菜的出品口核对，改价、新建的还要「定价与改价」
  const manage = guardAny(...Object.values(DISH_OUTLET_PERMISSIONS));
  const bodyLimit = 8_000_000;
  app.post('/api/dining/dishes/import/preview', { preHandler: manage, bodyLimit }, async (req) => previewDishImport(deps, req.body, ctxOf(req)));
  app.post('/api/dining/dishes/import', { preHandler: manage, bodyLimit }, async (req) => applyDishImport(deps, req.body, ctxOf(req)));
}
