// 员工食堂 · 菜单与点赞（docs/CANTEEN.md 第 7 节）：厨师、负责人在手机上编辑与发布；员工只看已发布的、给菜点赞。
//
// 改菜单带版本号（两个人同时改，后保存的提示「菜单刚被别人改过」）；同一个操作编号重提返回同一个结果。
// 锁：只锁那一份菜单（新建靠「哪天哪餐」的唯一约束兜底）；点赞靠主键去重，不加锁。

import { z } from 'zod';
import {
  DISH_ID,
  DISH_TAGS,
  MEAL_LABELS,
  MEALS,
  MENU_LIMITS,
  suggestDishEmoji,
  type CanteenMenu,
  type Dish,
  type Meal,
} from '@shared/canteen';
import { businessDateOf } from '@shared/business-date';
import type { Db, Sql } from '../../db';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import type { CanteenSessionEmployee } from './portal-auth';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
/** 能编辑的日子：往前 7 天、往后 30 天（免得手滑改到很久以前的） */
const EDIT_BACK_DAYS = 7;
const EDIT_AHEAD_DAYS = 30;

const DishInput = z.object({
  id: z.string().regex(DISH_ID, '菜的编号不正确'),
  name: z.string('请写菜名').trim().min(1, '菜名不能空着').max(MENU_LIMITS.name, `菜名最多 ${MENU_LIMITS.name} 个字`),
  emoji: z.string().trim().max(16, '表情太长了').default(''),
  tags: z.array(z.enum(DISH_TAGS, '标签不正确')).max(DISH_TAGS.length).default([]),
});

const MenuInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  /** 打开编辑时的版本号；还没有这份菜单时为 0 */
  version: z.number().int().min(0, '版本号不正确'),
  dishes: z.array(DishInput).max(MENU_LIMITS.dishes, `一餐最多 ${MENU_LIMITS.dishes} 道菜`),
  note: z.string().trim().max(MENU_LIMITS.note, `备注最多 ${MENU_LIMITS.note} 个字`).default(''),
  published: z.boolean(),
});

interface MenuRow {
  id: number;
  date: string;
  meal: Meal;
  dishes: Dish[];
  note: string;
  published: boolean;
  version: number;
  updatedAt: string;
  updatedByName: string | null;
  lastClientKey: string | null;
}

const MENU_SELECT = (db: Db) => db`
  SELECT m.id, to_char(m.menu_date, 'YYYY-MM-DD') AS date, m.meal, m.dishes, m.note, m.published, m.version, m.updated_at,
         e.name AS updated_by_name, m.last_client_key
  FROM canteen_menus m LEFT JOIN canteen_employees e ON e.id = m.updated_by`;

/** 某段日子的菜单，带每道菜的赞数；viewer 给了就标出他点过赞的；drafts 为 false 时只要已发布的 */
export async function listMenus(db: Db, rawFrom: unknown, rawTo: unknown, opts: { drafts: boolean; viewerId?: number }): Promise<CanteenMenu[]> {
  const from = parse(DATE, rawFrom);
  const to = parse(DATE, rawTo);
  if (from > to) throw badRequest('开始日期不能晚于结束日期');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 62) throw badRequest('一次最多看 62 天的菜单');
  const menus = await db<MenuRow[]>`
    ${MENU_SELECT(db)} WHERE m.menu_date BETWEEN ${from} AND ${to} ${opts.drafts ? db`` : db`AND m.published`}
    ORDER BY m.menu_date, array_position(${MEALS as unknown as string[]}::text[], m.meal)`;
  if (!menus.length) return [];
  const ids = menus.map((m) => m.id);
  const likes = await db<{ menuId: number; dishId: string; n: number; mine: boolean }[]>`
    SELECT menu_id, dish_id, count(*)::int AS n, bool_or(employee_id = ${opts.viewerId ?? 0}) AS mine
    FROM canteen_likes WHERE menu_id = ANY(${ids}) GROUP BY menu_id, dish_id`;
  return menus.map((m) => toMenu(m, likes.filter((l) => l.menuId === m.id)));
}

function toMenu(m: MenuRow, likes: { dishId: string; n: number; mine: boolean }[]): CanteenMenu {
  const ids = new Set(m.dishes.map((d) => d.id));
  const mine = likes.filter((l) => l.mine && ids.has(l.dishId)).map((l) => l.dishId);
  return {
    id: m.id,
    date: m.date,
    meal: m.meal,
    dishes: m.dishes,
    note: m.note,
    published: m.published,
    version: m.version,
    updatedAt: m.updatedAt,
    updatedByName: m.updatedByName,
    likes: Object.fromEntries(likes.filter((l) => ids.has(l.dishId)).map((l) => [l.dishId, l.n])),
    myLikes: mine,
  };
}

const sameContent = (m: MenuRow, dishes: Dish[], note: string, published: boolean) =>
  JSON.stringify(m.dishes) === JSON.stringify(dishes) && m.note === note && m.published === published;

/** 保存（含发布、撤回发布）某天某餐的菜单 */
export async function saveMenu(sql: Sql, editor: CanteenSessionEmployee, rawDate: unknown, rawMeal: unknown, raw: unknown, timeZone: string): Promise<CanteenMenu> {
  const date = parse(DATE, rawDate);
  const meal = parse(z.enum(MEALS, '餐次不正确'), rawMeal);
  const input = parse(MenuInput, raw);
  const today = businessDateOf(new Date(), timeZone, 0);
  const offset = (Date.parse(date) - Date.parse(today)) / 86_400_000;
  if (offset < -EDIT_BACK_DAYS || offset > EDIT_AHEAD_DAYS) throw unprocessable('MENU_OUT_OF_RANGE', `只能编辑往前 ${EDIT_BACK_DAYS} 天到往后 ${EDIT_AHEAD_DAYS} 天的菜单`);
  if (new Set(input.dishes.map((d) => d.id)).size !== input.dishes.length) throw badRequest('菜的编号重复了');
  if (input.published && !input.dishes.length) throw unprocessable('MENU_EMPTY', `${MEAL_LABELS[meal]}还没有菜，加几道再发布吧`);
  const dishes: Dish[] = input.dishes.map((d) => ({ id: d.id, name: d.name, emoji: d.emoji || suggestDishEmoji(d.name), tags: [...new Set(d.tags)] }));

  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<MenuRow[]>`${MENU_SELECT(tx)} WHERE m.menu_date = ${date} AND m.meal = ${meal} FOR UPDATE OF m`;
    if (cur?.lastClientKey === input.clientKey) return withLikes(tx, cur.id, editor.id);
    if (!cur) {
      if (input.version !== 0) throw notFound('这份菜单已经不在了，刷新后再改');
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO canteen_menus (menu_date, meal, dishes, note, published, published_at, last_client_key, updated_by)
        VALUES (${date}, ${meal}, ${tx.json(dishes as never)}, ${input.note}, ${input.published},
                ${input.published ? new Date() : null}, ${input.clientKey}, ${editor.id})
        ON CONFLICT (menu_date, meal) DO NOTHING RETURNING id`;
      if (!row) throw conflict('MENU_CHANGED', '菜单刚被别人新建了：看过最新的再改');
      return withLikes(tx, row.id, editor.id);
    }
    if (cur.version !== input.version) {
      if (sameContent(cur, dishes, input.note, input.published)) return withLikes(tx, cur.id, editor.id);
      throw conflict('MENU_CHANGED', `菜单刚被${cur.updatedByName ?? '别人'}改过：看过最新的再改`, { version: cur.version });
    }
    await tx`
      UPDATE canteen_menus SET dishes = ${tx.json(dishes as never)}, note = ${input.note}, published = ${input.published},
             published_at = CASE WHEN ${input.published} AND NOT published THEN now() WHEN NOT ${input.published} THEN NULL ELSE published_at END,
             version = version + 1, last_client_key = ${input.clientKey}, updated_by = ${editor.id}, updated_at = now()
      WHERE id = ${cur.id}`;
    return withLikes(tx, cur.id, editor.id);
  });
}

async function withLikes(db: Db, menuId: number, viewerId: number): Promise<CanteenMenu> {
  const [m] = await db<MenuRow[]>`${MENU_SELECT(db)} WHERE m.id = ${menuId}`;
  const likes = await db<{ dishId: string; n: number; mine: boolean }[]>`
    SELECT dish_id, count(*)::int AS n, bool_or(employee_id = ${viewerId}) AS mine FROM canteen_likes WHERE menu_id = ${menuId} GROUP BY dish_id`;
  return toMenu(m!, likes);
}

const LikeInput = z.object({
  menuId: z.number().int().positive('菜单不正确'),
  dishId: z.string().regex(DISH_ID, '菜不正确'),
  liked: z.boolean(),
});

/** 点赞 / 取消：只能给已发布菜单里有的菜点；重复点不会多算 */
export async function likeDish(db: Db, me: CanteenSessionEmployee, raw: unknown): Promise<{ likes: number; liked: boolean }> {
  const input = parse(LikeInput, raw);
  const [m] = await db<{ published: boolean; dishes: Dish[] }[]>`SELECT published, dishes FROM canteen_menus WHERE id = ${input.menuId}`;
  if (!m || !m.published) throw notFound('这份菜单还没发布');
  if (!m.dishes.some((d) => d.id === input.dishId)) throw notFound('菜单里已经没有这道菜了');
  if (input.liked) {
    await db`INSERT INTO canteen_likes (menu_id, dish_id, employee_id) VALUES (${input.menuId}, ${input.dishId}, ${me.id}) ON CONFLICT DO NOTHING`;
  } else {
    await db`DELETE FROM canteen_likes WHERE menu_id = ${input.menuId} AND dish_id = ${input.dishId} AND employee_id = ${me.id}`;
  }
  const [r] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_likes WHERE menu_id = ${input.menuId} AND dish_id = ${input.dishId}`;
  return { likes: r!.n, liked: input.liked };
}

/** 这周（给定区间）赞最多的菜（管理后台概览） */
export async function topDishes(db: Db, from: string, to: string, limit = 5): Promise<{ date: string; meal: Meal; name: string; emoji: string; likes: number }[]> {
  return db<{ date: string; meal: Meal; name: string; emoji: string; likes: number }[]>`
    SELECT to_char(m.menu_date, 'YYYY-MM-DD') AS date, m.meal, d->>'name' AS name, d->>'emoji' AS emoji, count(l.*)::int AS likes
    FROM canteen_menus m
    CROSS JOIN LATERAL jsonb_array_elements(m.dishes) d
    JOIN canteen_likes l ON l.menu_id = m.id AND l.dish_id = d->>'id'
    WHERE m.menu_date BETWEEN ${from} AND ${to} AND m.published
    GROUP BY m.menu_date, m.meal, d->>'name', d->>'emoji'
    ORDER BY likes DESC, m.menu_date DESC LIMIT ${limit}`;
}
