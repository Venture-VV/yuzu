// 平板点餐页的「中 / EN」（8.0.13，docs/EMENU.md 第 11.1 节）：界面上的字两种语言各一份，菜品、分类的内容按语言取。
//
// 规则（PENDING_DECISIONS「8.0.13」EN2–EN7）：
//   · 切到英文：英文为主，中文菜名缩成下面一行小字；介绍、单位、规格、选项只显示英文；
//   · 没录英文的地方显示中文，不留空白；单位、规格、常见的忌口内置了英文（@shared/emenu），后台填了的以后台的为准；
//   · 给服务员看的几处（确认下单时门店系统的拒绝原因、「结果待确认」、退出登录）仍是中文，不在这份词表里；
//   · 进厨房的备注仍是中文选项：这里只管显示。
// 后台的版面预览也用这一份（不包 LangProvider 时是中文）。

import { createContext, useContext } from 'react';
import {
  EMENU_BLOCK_LABELS,
  EMENU_MAX_CUSTOM_NOTE,
  EMENU_MAX_GUESTS,
  EMENU_MAX_LINES,
  EMENU_PIN_LENGTH,
  emenuOptionEn,
  emenuSpecLabelEn,
  emenuUnitEn,
  type EmenuBlock,
  type EmenuDishView,
  type EmenuLang,
  type EmenuSpecView,
} from '@shared/emenu';

export type Lang = EmenuLang;

const LangContext = createContext<Lang>('zh');
export const LangProvider = LangContext.Provider;
export const useLang = (): Lang => useContext(LangContext);

// ───────────────────────── 界面上的字 ─────────────────────────

const ZH = {
  // 起始页与「输入信息」
  startAria: '开始点餐',
  fieldTag: '手牌',
  fieldTable: '桌号',
  fieldGuests: '人数',
  fieldPin: '密码',
  cancel: '取消',
  startOrdering: '开始点单',
  askHint: '手牌只输数字就行，例如 A8060 输 8060',
  needTag: '请输入手牌号',
  needTable: '请输入桌号',
  needGuests: `请输入人数（1–${EMENU_MAX_GUESTS}）`,
  needPin: `请服务员输入 ${EMENU_PIN_LENGTH} 位点单密码`,
  pickTag: '是哪一张手牌？',
  pickTable: '是哪一张桌？',
  network: '连不上门店系统，请稍后再试',
  keyClear: '清空',
  keyBack: '退格',
  // 顶栏
  search: '搜索',
  tagPill: '手牌',
  tagAria: (code: string) => `手牌 ${code}，点这里结束点餐`,
  orderAria: (count: number) => `订单（未下单 ${count} 份）`,
  orderPendingAria: '订单（有一单结果待确认）',
  langAria: '切换到英文',
  // 菜单
  addAria: (name: string) => `把${name}加进未下单`,
  close: '关闭',
  prevDish: '上一道',
  nextDish: '下一道',
  specSoldOut: '这个规格已售罄',
  specOff: '这个规格已下架',
  noMenuResting: '现在不在供餐时段',
  noMenuPreparing: '菜单还在准备',
  // 加菜的提示条
  pendingFirst: '上一单结果待确认，请先请服务员处理',
  dishBlocked: (name: string, why: string) => `「${name}」${why}`,
  specBlocked: (name: string, soldOut: boolean) => `「${name}」这个规格${soldOut ? '已售罄' : '已下架'}`,
  maxPerDish: '一道菜一单最多 99 份',
  onlyLeft: (name: string, n: number) => `「${name}」今天只剩 ${n} 份`,
  maxLines: `一单最多 ${EMENU_MAX_LINES} 行，请先下单再接着点`,
  added: (name: string, label: string) => `${name}${label ? `（${label}）` : ''} 加进未下单了`,
  // 搜索
  searchPlaceholder: '搜一搜想吃的菜',
  searchEmpty: '没有找到，换个字试试',
  // 订单抽屉
  tableLabel: '桌号：',
  tabCart: '未下单',
  tabOrdered: '已下单',
  cartEmpty: '还没有点菜',
  cartEmptyHint: '翻翻菜单，点菜旁边的加号',
  less: (name: string) => `${name}少一份`,
  more: (name: string) => `${name}多一份`,
  remark: '备注',
  remarkWith: (text: string) => `备注：${text}`,
  submit: '下单（请呼叫服务员）',
  cartNoteBefore: '这一单 ',
  cartNoteAfter: '，记在手牌上，离店时一起结',
  goneDish: '这道菜',
  goneProblem: '已经不在菜单上，请减掉',
  blockedProblem: (why: string) => `${why}，请减掉`,
  leftProblem: (n: number) => `今天只剩 ${n} 份，请减到 ${n} 份`,
  cartHasBlocked: '有菜现在点不了，请先减掉',
  orderedLoading: '正在取…',
  orderedFailed: '暂时取不到已下单的菜',
  orderedEmpty: '这张手牌还没有下过单',
  orderedTotal: '整单合计：',
  // 备注抽屉
  tabAvoid: '忌口',
  tabServe: '起菜方式',
  noOptions: '没有可选的项',
  customPlaceholder: `别的要求写在这里（最多 ${EMENU_MAX_CUSTOM_NOTE} 个字）`,
  customAria: '自定义备注',
  customOpen: '自定义备注',
  remarkDone: '备注完成',
  // 确认下单、下单成功、结束点餐
  placeOrder: '下单',
  placing: '正在下单…',
  endBody: (code: string): [string, string, string] => ['手牌 ', code, ' 的这次点餐到这里结束，回到起始页。'],
  endCart: (n: number) => `未下单的 ${n} 份菜会清掉；已经下单的不受影响。`,
  endNoCart: '已经下单的菜不受影响。',
  keepOrdering: '接着点',
  finish: '结束',
};

const EN: typeof ZH = {
  startAria: 'Start ordering',
  fieldTag: 'Tag',
  fieldTable: 'Table',
  fieldGuests: 'Guests',
  fieldPin: 'PIN',
  cancel: 'Cancel',
  startOrdering: 'Start ordering',
  askHint: 'Just the digits on your wristband tag — e.g. 8060 for A8060',
  needTag: 'Please enter your tag number',
  needTable: 'Please enter the table number',
  needGuests: `Please enter the number of guests (1–${EMENU_MAX_GUESTS})`,
  needPin: `Staff: please enter the ${EMENU_PIN_LENGTH}-digit order PIN`,
  pickTag: 'Which tag is yours?',
  pickTable: 'Which table?',
  network: 'Cannot reach the store system — please try again shortly',
  keyClear: 'Clear',
  keyBack: 'Backspace',
  search: 'Search',
  tagPill: 'Tag',
  tagAria: (code) => `Tag ${code} — tap to finish ordering`,
  orderAria: (count) => `Your order (${count} in cart)`,
  orderPendingAria: 'Your order (one order is being confirmed)',
  langAria: 'Switch to Chinese',
  addAria: (name) => `Add ${name}`,
  close: 'Close',
  prevDish: 'Previous dish',
  nextDish: 'Next dish',
  specSoldOut: 'This option is sold out',
  specOff: 'This option is unavailable',
  noMenuResting: 'KITCHEN IS RESTING NOW',
  noMenuPreparing: 'MENU IS ON THE WAY',
  pendingFirst: 'Your last order is still being confirmed — please ask our staff',
  dishBlocked: (name, why) => `${name}: ${why}`,
  specBlocked: (name, soldOut) => `${name}: this option is ${soldOut ? 'sold out' : 'unavailable'}`,
  maxPerDish: 'Up to 99 of one dish per order',
  onlyLeft: (name, n) => `${name}: only ${n} left today`,
  maxLines: `Up to ${EMENU_MAX_LINES} lines per order — please place this order first`,
  added: (name, label) => `${name}${label ? ` (${label})` : ''} added`,
  searchPlaceholder: 'Search dishes',
  searchEmpty: 'No matches — try another word',
  tableLabel: 'Table: ',
  tabCart: 'Cart',
  tabOrdered: 'Ordered',
  cartEmpty: 'Nothing here yet',
  cartEmptyHint: 'Browse the menu and tap + next to a dish',
  less: (name) => `One less ${name}`,
  more: (name) => `One more ${name}`,
  remark: 'Notes',
  remarkWith: (text) => `Notes: ${text}`,
  submit: 'Place order (please call our staff)',
  cartNoteBefore: 'This order ',
  cartNoteAfter: ' · charged to your tag, pay when you leave',
  goneDish: 'This dish',
  goneProblem: 'No longer on the menu — please remove',
  blockedProblem: (why) => `${why} — please remove`,
  leftProblem: (n) => `Only ${n} left today — please reduce to ${n}`,
  cartHasBlocked: 'Some dishes are unavailable — please remove them first',
  orderedLoading: 'Loading…',
  orderedFailed: 'Cannot load your orders right now',
  orderedEmpty: 'No orders on this tag yet',
  orderedTotal: 'Total: ',
  tabAvoid: 'Dietary',
  tabServe: 'Serving',
  noOptions: 'No options',
  customPlaceholder: `Anything else? (up to ${EMENU_MAX_CUSTOM_NOTE} characters)`,
  customAria: 'Add a note',
  customOpen: 'Add a note',
  remarkDone: 'Done',
  placeOrder: 'Place order',
  placing: 'Placing order…',
  endBody: (code) => ['This ends ordering for tag ', code, ' and returns to the start screen.'],
  endCart: (n) => `${n} item${n === 1 ? '' : 's'} in your cart will be cleared; placed orders are not affected.`,
  endNoCart: 'Placed orders are not affected.',
  keepOrdering: 'Keep ordering',
  finish: 'Finish',
};

export type Messages = typeof ZH;
export const messages = (lang: Lang): Messages => (lang === 'en' ? EN : ZH);
/** 这一页现在的语言的词表 */
export const useM = (): Messages => messages(useLang());

/**
 * 给客人看的出错提示按拒绝码换成英文（EN6：只有输入手牌、桌号这一步；服务员确认下单那一步的原因仍照门店系统给的中文）。
 * 没有对应英文的拒绝码返回 null：照门店系统给的显示。
 */
const GUEST_ERRORS_EN: Record<string, string> = {
  TAG_NOT_IN_STORE: 'No guest is checked in with this tag — please check the number',
  TABLE_NOT_FOUND: 'Table not found — please check the number',
  EMENU_DISABLED: 'Tablet ordering is not available right now — please ask our staff',
};
export const guestErrorEn = (code: string): string | null => GUEST_ERRORS_EN[code] ?? null;

// ───────────────────────── 菜品、分类的内容 ─────────────────────────

/** 一个名称的两行：main 是大的那一行；mainEn 为 true 时 main 是英文（用英文字体） */
export interface NamePair {
  main: string;
  sub: string;
  mainEn: boolean;
}

/** 中文、英文一对名称按语言排主次：切到英文而且有英文时英文为主、中文为辅；否则照原来（中文为主、英文小字） */
export function namePair(zh: string, en: string, lang: Lang): NamePair {
  return lang === 'en' && en.trim() ? { main: en, sub: zh, mainEn: true } : { main: zh, sub: en, mainEn: false };
}

type DishText = Pick<EmenuDishView, 'name' | 'nameEn' | 'tagline' | 'taglineEn' | 'description' | 'descriptionEn' | 'attrs' | 'attrsEn' | 'unit' | 'unitEn'>;

export const dishNames = (d: Pick<DishText, 'name' | 'nameEn'>, lang: Lang): NamePair => namePair(d.name, d.nameEn, lang);

/** 名称后的小字、介绍、属性行：切到英文而且录了英文的用英文，否则中文（en 说明取到的是不是英文，决定用哪种字体） */
export function dishTagline(d: Pick<DishText, 'tagline' | 'taglineEn'>, lang: Lang): { text: string; en: boolean } {
  return lang === 'en' && d.taglineEn.trim() ? { text: d.taglineEn, en: true } : { text: d.tagline, en: false };
}
export function dishDescription(d: Pick<DishText, 'description' | 'descriptionEn'>, lang: Lang): { text: string; en: boolean } {
  return lang === 'en' && d.descriptionEn.trim() ? { text: d.descriptionEn, en: true } : { text: d.description, en: false };
}
export function dishAttrs(d: Pick<DishText, 'attrs' | 'attrsEn'>, lang: Lang): { list: string[]; en: boolean } {
  return lang === 'en' && d.attrsEn.length > 0 ? { list: d.attrsEn, en: true } : { list: d.attrs, en: false };
}
/** 价格后面的单位：英文是后台填的 → 内置的（份 portion）→ 中文 */
export function dishUnit(d: Pick<DishText, 'unit' | 'unitEn'>, lang: Lang): { text: string; en: boolean } {
  if (lang !== 'en') return { text: d.unit, en: false };
  const text = emenuUnitEn(d.unit, d.unitEn);
  return { text, en: text !== d.unit };
}
export const specLabel = (s: Pick<EmenuSpecView, 'label' | 'labelEn'>, lang: Lang): string => (lang === 'en' ? emenuSpecLabelEn(s.label, s.labelEn) : s.label);
export const optionLabel = (option: string, lang: Lang, optionsEn: Readonly<Record<string, string>>): string => (lang === 'en' ? emenuOptionEn(option, optionsEn) : option);
/** 已售罄 / 已下架 / 当前时段不可售：两行，按语言排主次 */
export const blockLabel = (block: EmenuBlock, lang: Lang): NamePair => namePair(EMENU_BLOCK_LABELS[block].zh, EMENU_BLOCK_LABELS[block].en, lang);
