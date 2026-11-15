// UI 工作台里改卡片模板（8.1.2，GZ13）用的那一页：菜单里用这种版式的真实一页（空位用示例菜补上，每一块都看得到），
// 菜单里还没有这种版式的页时整页用示例菜。示例菜只在编辑器里出现，平板上是后台「电子菜单」排的菜。

import { EMENU_LAYOUT_INFO, type EmenuDishView, type EmenuLayout, type EmenuMenu, type EmenuPageView } from '@shared/emenu';
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
    imageUrl: null,
    detailUrl: null,
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
