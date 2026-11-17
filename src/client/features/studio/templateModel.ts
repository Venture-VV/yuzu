// UI 工作台里改卡片模板（8.1.2，GZ13）用的那一页：菜单里用这种版式的真实一页（空位用示例菜补上，每一块都看得到），
// 菜单里还没有这种版式的页时整页用示例菜。示例菜只在编辑器里出现，平板上是后台「电子菜单」排的菜。

import { EMENU_LAYOUT_INFO, type EmenuDishView, type EmenuLayout, type EmenuMenu, type EmenuPageView } from '@shared/emenu';
import type { StudioDishState } from '@shared/studio';
import { flatPages, type FlatEmenuPage } from './emenuBlocks';

const SAMPLE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['招牌小炒', 'Signature Stir-fry'],
  ['时令鲜蔬', 'Seasonal Greens'],
  ['养生炖汤', 'Slow-cooked Soup'],
  ['手作点心', 'Handmade Dim Sum'],
  ['爽口凉菜', 'Cold Appetizer'],
  ['汤崎拉面', 'House Ramen'],
  ['甜品', 'Dessert'],
  ['水果拼盘', 'Fruit Platter'],
  ['热茶', 'Hot Tea'],
  ['小食', 'Snack'],
];

/** 示例菜的图：一只盘子的示意（餐品图暖色、特写图浅色），看得出售罄等压在图上的样子 */
const sampleImage = (from: string, to: string, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600' viewBox='0 0 600 600'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/></linearGradient></defs><rect width='600' height='600' fill='url(#g)'/><circle cx='300' cy='320' r='170' fill='#f6f1e8' opacity='0.92'/><circle cx='300' cy='320' r='118' fill='#c99a6b' opacity='0.85'/><circle cx='262' cy='292' r='30' fill='#7d9a5b' opacity='0.85'/><text x='300' y='96' font-size='32' text-anchor='middle' fill='#ffffff' opacity='0.85' font-family='sans-serif'>${label}</text></svg>`,
  )}`;
const SAMPLE_IMAGE = sampleImage('#d8c3a5', '#8a6a4a', '示例图');
const SAMPLE_DETAIL = sampleImage('#efe6d8', '#c2ab8c', '示例特写');

/** 第 i 道示例菜（编号用负数，不会与真的菜撞） */
export function sampleDish(i: number): EmenuDishView {
  const [name, nameEn] = SAMPLE_NAMES[i % SAMPLE_NAMES.length]!;
  return {
    id: -1 - i,
    name,
    nameEn,
    tagline: '',
    description: '示例菜的介绍：食材、做法、口味写在这里，长一点的介绍会占两三行。平板上换成后台排的菜。',
    attrs: ['示例'],
    unit: '份',
    taglineEn: '',
    descriptionEn: 'Sample description: ingredients, method and taste. On the tablet this is the real dish from the menu.',
    attrsEn: ['Sample'],
    unitEn: 'serving',
    imageUrl: SAMPLE_IMAGE,
    detailUrl: SAMPLE_DETAIL,
    specs: [{ itemId: -1 - i, label: '', labelEn: '', price: 3800 + i * 600, state: 'ok', remaining: null }],
  };
}

/** 菜单里用这种版式的页 */
export const pagesWithLayout = (menu: EmenuMenu | null, layout: EmenuLayout): FlatEmenuPage[] => flatPages(menu).filter((p) => p.page.layout === layout);

export interface TemplatePage {
  page: EmenuPageView;
  categoryName: string;
  categoryNameEn: string;
  /** 是不是菜单里的真实一页（不是的话整页是示例菜） */
  real: boolean;
  /** 补了几道示例菜 */
  filled: number;
}

/** 画布上画哪一页：which 是第几页（菜单里用这种版式的页里数），-1 或没有这种页时用示例页 */
export function templatePage(menu: EmenuMenu | null, layout: EmenuLayout, which: number): TemplatePage {
  const n = EMENU_LAYOUT_INFO[layout].slots;
  const at = which >= 0 ? pagesWithLayout(menu, layout)[which] : undefined;
  let filled = 0;
  const dishes = Array.from({ length: n }, (_, i) => {
    const d = at?.page.dishes[i];
    if (d) return d;
    filled += 1;
    return sampleDish(i);
  });
  if (!at) return { page: { layout, title: '示例小标题', titleEn: 'SAMPLE', dishes }, categoryName: '示例分类', categoryNameEn: 'Sample', real: false, filled };
  return { page: { ...at.page, dishes }, categoryName: at.category.name, categoryNameEn: at.category.nameEn, real: true, filled };
}

/** 画布上看一种状态（售罄、已下架）：这一页的菜都换成这种状态；当前时段不可售由页面的「不在时段」表示（见 TemplateCanvas） */
export function pageInState(page: EmenuPageView, state: StudioDishState | null): EmenuPageView {
  if (!state || state === 'closed') return page;
  const spec = state === 'sold_out' ? 'sold_out' : 'off';
  return { ...page, dishes: page.dishes.map((d) => (d ? { ...d, specs: d.specs.map((x) => ({ ...x, state: spec })) } : d)) };
}

/** 顶栏（8.1.6）画布下面垫的那一页：菜单里的第一页（看得到真的分类名排在顶栏里），菜单里还没有页时用示例页 */
export function headerPage(menu: EmenuMenu | null): TemplatePage {
  const first = flatPages(menu)[0];
  if (!first) return templatePage(menu, 'duo_row', -1);
  return { page: first.page, categoryName: first.category.name, categoryNameEn: first.category.nameEn, real: true, filled: 0 };
}
