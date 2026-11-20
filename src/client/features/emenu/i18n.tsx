// 平板点餐页的「中 / EN」（8.0.13，docs/EMENU.md 第 11.1 节）：界面上的字两种语言各一份，菜品、分类的内容按语言取。
//
// 规则（PENDING_DECISIONS「8.0.13」EN2–EN7）：
//   · 切到英文：英文为主，中文菜名缩成下面一行小字；介绍、单位、规格、选项只显示英文；
//   · 没录英文的地方显示中文，不留空白；单位、规格、常见的忌口内置了英文（@shared/emenu），后台填了的以后台的为准；
//   · 给服务员看的几处（确认下单时门店系统的拒绝原因、「结果待确认」、退出登录）8.1.6 起也有英文（QZ6）：切到英文时英文在上、
//     中文小字在下一行（服务员也看得懂），用 bothText 拼；门店系统的拒绝按拒绝码给英文（errorEn）；
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
  periodSwitched: (name: string) => `已到${name}时段，菜单已换成${name}`,
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
  // 服务员那一步：确认下单、结果待确认、没有下成、退出登录（8.1.6，QZ6：切到英文时英文在上、这里的中文在下）
  otherPending: '这台平板上还有一单结果待确认，请先处理完再下新的一单',
  storeFailed: '这台平板存不了「结果待确认」的记录（存储空间满了或被禁用），为了不重复下单，这一单没有提交。请换一台平板，或请服务员在点单页下单。',
  stillPending: (reason: string) => `${reason}（原来那一单仍待确认）`,
  retryRefused: (reason: string) => `重新提交被拒绝（${reason}），但原来那一单会不会生效还不确定`,
  serverTrouble: '门店系统出了点问题',
  unsure: (reason: string) => `${reason}，这一单有没有下成暂时不确定`,
  abandoned: '原来那一单已作废，没有下成；要点的话请重新开始点单',
  checkMiss: (pin: boolean) => `暂时没有查到已经下单，原来的请求可能还在路上。可以${pin ? '输点单密码' : ''}重新提交（不会重复），或者作废后重填。`,
  checkFailed: (reason: string) => `还是确认不了：${reason}`,
  abandonUnfinished: '作废没有完成，原来那一单仍待确认',
  abandonFailed: (reason: string) => `作废没有完成，原来那一单仍待确认：${reason}`,
  notPlaced: (reason: string) => `这一单没有下成：${reason}。菜还在「未下单」里，可以改了再下单。`,
  refused: '门店系统拒绝了',
  gotIt: '知道了',
  previewOnly: '这是工作台的预览：不能下单',
  pinStep: `这一步要服务员输入 ${EMENU_PIN_LENGTH} 位点单密码`,
  thisOrder: '这一单',
  pendingAmount: (n: number, total: string) => `${n} 份 ¥${total}`,
  checkResult: '查回结果',
  resubmit: '重新提交',
  abandon: '作废重填',
  pendingHintPin: '刚才那一单没有收到门店系统的答复。请服务员处理：先查回；查不到就输密码重新提交（不会重复下单），或作废后重填。',
  pendingHint: '请先点「查回结果」；查不到就点「重新提交」（不会重复下单），或「作废重填」后改了再下。',
  notNow: '先不处理',
  // 返回 / 退出（8.1.15，TC1–TC10）：左下角的键、退出界面
  leaveKeyExit: '退出',
  leaveKeyBack: '返回',
  leaveKeyPreview: '退出预览',
  leaveStay: '留在这里',
  leaveEnd: '结束点餐 · 回到起始页',
  leaveEndNote: (code: string, n: number) => (n > 0 ? `手牌 ${code}：没下单的 ${n} 份会清掉，已经下单的不受影响` : `手牌 ${code}：已经下单的不受影响`),
  leaveHome: '返回工作台',
  signOutFull: '退出登录',
  leaveHolding: '继续按住…',
  leaveHoldSub: '按住 1.5 秒',
  leaveHoldHint: '这两个键要按住约 1.5 秒才生效（免得误触）',
  leaveStaffNote: '返回工作台：回到门店系统；退出登录：换一个账号。都要按住',
  leaveStaffNoteDevice: '退出这台平板登录的账号，回到登录页；要重新登录才能点餐。要按住',
  leaveWarnCart: (n: number) => `还有 ${n} 份没下单，离开后清掉`,
  leaveWarnPending: '有一单结果待确认：记在这台平板上，回来以后先处理它',
  leaveWho: (name: string) => `现在登录的是：${name}`,
  leaveGoing: '正在离开…',
  leavePreviewBody: '这是工作台的预览（草稿，不能下单）。退出预览回到工作台。',
  leaveKeepPreview: '接着看',
  leaveConfirm: '确认离开',
  leavePinHint: '后台开着「点单密码」：离开菜单要一位点单的同事输入点单密码。',
  // 读屏的说明：翻页圆点、数字键
  prevCategory: '上一个分类',
  nextCategory: '下一个分类',
  pageNo: (n: number) => `第 ${n} 页`,
  keyDot: '点',
  // 打开菜单、没有菜单、没有开启
  opening: '正在打开菜单…',
  cannotReach: '连不上门店系统',
  tryAgain: '再试一次',
  menuNotSet: '请店主在「后台 → 电子菜单」里排好分类与版面',
  emenuOff: '平板点餐没有开启',
  // 8.1.17（BW9）：选做法、加料（docs/DISHES_V8117.md 第 5 节）；这台平板点不了的出品口（BW3）
  optionsTitle: '做法',
  optionsRequired: '必选',
  optionsPickOne: '选一种',
  optionsAny: '可多选',
  optionsMore: '其他做法',
  optionsAddons: '加料',
  optionsMissing: (group: string) => `请先选「${group}」`,
  optionsAdd: '加入未下单',
  optionsLess: (name: string) => `${name} 少一份`,
  optionsMoreOne: (name: string) => `${name} 多一份`,
  addonOfLine: (name: string) => `配 ${name}`,
  specUnavailable: '这个规格请找服务员点',
  // 8.1.17（BW7）：套餐里可换的一样
  optionsSwap: (name: string) => `套餐里的${name}`,
  optionsSwapNote: '可换 · 选一种',
  optionsAsIs: '不换',
  optionsSwapGone: (name: string) => `${name}今天没有了，请换一种`,
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
  periodSwitched: (name) => `Now serving ${name}`,
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
  otherPending: 'Another order on this tablet is still unconfirmed — please resolve it first',
  storeFailed: 'This tablet cannot keep a record of the order (storage full or blocked), so it was not sent to avoid a duplicate. Please use another tablet or ask our staff.',
  stillPending: (reason) => `${reason} (the earlier order is still unconfirmed)`,
  retryRefused: (reason) => `Resubmitting was refused (${reason}), but the earlier order may still go through`,
  serverTrouble: 'The store system ran into a problem',
  unsure: (reason) => `${reason} — not sure yet whether this order went through`,
  abandoned: 'The earlier order was cancelled and not placed — start again to order',
  checkMiss: (pin) => `No placed order found yet; the request may still be on its way. Resubmit${pin ? ' with the PIN' : ''} (no duplicate), or cancel and redo.`,
  checkFailed: (reason) => `Still cannot confirm: ${reason}`,
  abandonUnfinished: 'Cancelling did not finish — the earlier order is still unconfirmed',
  abandonFailed: (reason) => `Cancelling did not finish — the earlier order is still unconfirmed: ${reason}`,
  notPlaced: (reason) => `This order was not placed: ${reason}. Your dishes are still in the cart — adjust and order again.`,
  refused: 'Refused by the store system',
  gotIt: 'OK',
  previewOnly: 'Workbench preview — ordering is off',
  pinStep: `Staff: please enter the ${EMENU_PIN_LENGTH}-digit order PIN`,
  thisOrder: 'Order',
  pendingAmount: (n, total) => `${n} item${n === 1 ? '' : 's'} · ¥${total}`,
  checkResult: 'Check result',
  resubmit: 'Resubmit',
  abandon: 'Cancel & redo',
  pendingHintPin: 'No reply from the store system. Staff: check first; if not found, resubmit with the PIN (no duplicate) or cancel & redo.',
  pendingHint: 'Tap “Check result” first; if not found, tap “Resubmit” (no duplicate) or “Cancel & redo” to change it.',
  notNow: 'Not now',
  leaveKeyExit: 'Exit',
  leaveKeyBack: 'Back',
  leaveKeyPreview: 'Leave preview',
  leaveStay: 'Stay here',
  leaveEnd: 'Finish ordering · back to start',
  leaveEndNote: (code, n) => (n > 0 ? `Tag ${code}: ${n} item${n === 1 ? '' : 's'} in the cart will be cleared; placed orders are not affected` : `Tag ${code}: placed orders are not affected`),
  leaveHome: 'Back to workspace',
  signOutFull: 'Sign out',
  leaveHolding: 'Keep holding…',
  leaveHoldSub: 'HOLD 1.5 S',
  leaveHoldHint: 'Press and hold for about 1.5 seconds (to avoid accidental taps)',
  leaveStaffNote: 'Back to workspace: return to the store system. Sign out: switch account. Press and hold',
  leaveStaffNoteDevice: 'Signs this tablet out and returns to the sign-in page; ordering needs a new sign-in. Press and hold',
  leaveWarnCart: (n) => `${n} item${n === 1 ? '' : 's'} not ordered yet — cleared when you leave`,
  leaveWarnPending: 'One order is not confirmed yet: it stays on this tablet — handle it first when you are back',
  leaveWho: (name) => `Signed in as: ${name}`,
  leaveGoing: 'Leaving…',
  leavePreviewBody: 'This is a workspace preview (a draft; ordering is off). Leaving returns to the workspace.',
  leaveKeepPreview: 'Keep looking',
  leaveConfirm: 'Confirm',
  leavePinHint: 'Order PIN is on: a staff member must enter their order PIN to leave the menu.',
  prevCategory: 'Previous category',
  nextCategory: 'Next category',
  pageNo: (n) => `Page ${n}`,
  keyDot: 'Decimal point',
  opening: 'Opening the menu…',
  cannotReach: 'Cannot reach the store system',
  tryAgain: 'Try again',
  menuNotSet: 'The menu is not ready yet — please ask our staff',
  emenuOff: 'Tablet ordering is off',
  optionsTitle: 'Options',
  optionsRequired: 'Required',
  optionsPickOne: 'Choose one',
  optionsAny: 'Any',
  optionsMore: 'More',
  optionsAddons: 'Add-ons',
  optionsMissing: (group) => `Please choose: ${group}`,
  optionsAdd: 'Add to Order',
  optionsLess: (name) => `One less ${name}`,
  optionsMoreOne: (name) => `One more ${name}`,
  addonOfLine: (name) => `With ${name}`,
  specUnavailable: 'Please ask staff for this size',
  optionsSwap: (name) => `${name} in the set`,
  optionsSwapNote: 'Swap · Choose one',
  optionsAsIs: 'Keep',
  optionsSwapGone: (name) => `${name} is sold out today — please choose a swap`,
};

export type Messages = typeof ZH;
export const messages = (lang: Lang): Messages => (lang === 'en' ? EN : ZH);
/** 这一页现在的语言的词表 */
export const useM = (): Messages => messages(useLang());

/**
 * 门店系统的拒绝码 → 英文（8.1.6，QZ6；8.0.13 起只有输入手牌、桌号那一步的三种）。
 * 输入手牌、桌号那一步给客人看（只显示英文）；服务员确认下单、结果待确认那一步英文在上、门店系统原来的中文在下（bothText）。
 * 没有对应英文的拒绝码返回 null：客人那一步照门店系统给的中文显示，服务员那一步英文写「门店系统拒绝了」、下面是原来的中文。
 */
const ERRORS_EN: Record<string, string> = {
  TAG_NOT_IN_STORE: 'No guest is checked in with this tag — please check the number',
  TAG_AMBIGUOUS: 'More than one tag has these digits — please pick one',
  TAG_CHANGED: 'This guest is now on a different tag — please start again from the first screen',
  TABLE_NOT_FOUND: 'Table not found — please check the number',
  TABLE_AMBIGUOUS: 'More than one table has this number — please pick one',
  EMENU_DISABLED: 'Tablet ordering is not available right now — please ask our staff',
  EMENU_CHANGED: 'The menu has just changed — please check and order again',
  DISH_SOLD_OUT: 'A dish has just sold out — please change it',
  DISH_NOT_AVAILABLE_NOW: 'A dish is not served at this time — please remove it',
  DISH_NOT_ON_MENU: 'A dish is no longer on the menu — please remove it',
  DISH_CHANGED: 'A dish has just changed — please check and order again',
  DISH_NOT_KITCHEN: 'A dish cannot be ordered here — please ask our staff',
  // 8.1.17：做法、加料、出品口
  DISH_METHOD_REQUIRED: 'A dish needs an option chosen — please choose it',
  DISH_METHOD_GROUP: 'Only one option can be chosen in a group — please choose again',
  DISH_METHOD_INVALID: 'A dish option has just changed — please choose again',
  DISH_ADDON_INVALID: 'An add-on has just changed — please choose again',
  DISH_NOTE_TOO_LONG: 'The options and note are too long — please choose fewer',
  DISH_SWAP_INVALID: 'A swap in a set has just changed — please choose again',
  OUTLET_FORBIDDEN: 'A dish cannot be ordered on this tablet — please ask our staff',
  PRICE_CHANGED: 'Prices have just changed — please check the total and confirm again',
  VISIT_CLOSED: 'This tag has already checked out',
  VISIT_CHANGED: 'This tag has just been given to another guest — please order again',
  VISIT_NOT_FOUND: 'This visit was not found — please start again',
  BILL_CLOSED: 'The bill on this tag is already closed',
  ITEM_GENDER: 'A dish is only for the other area — please ask our staff',
  REMARK_TOO_LONG: 'The note is too long — please shorten it',
  REMARK_OPTION_INVALID: 'The note options have just changed — please choose them again',
  REMARK_OPTIONS_TOO_LONG: 'Too many note options — please choose fewer',
  PIN_INVALID: 'Wrong order PIN',
  PIN_LOCKED: 'Too many wrong PINs — please wait a while and try again',
  PIN_NOT_FOR_TABLET: 'This PIN cannot be used on the tablet',
  PIN_NO_PERMISSION: 'This staff member cannot place tablet orders',
  STAFF_INACTIVE: 'This staff account is disabled',
  IDEMPOTENCY_CONFLICT: 'This order number was used for something else — please order again',
  OP_ABANDONED: 'This order was cancelled',
  OFFLINE: 'Cannot reach the store system — nothing was sent; please try again',
  BUSY: 'The store system is busy — please try again shortly',
  RATE_LIMITED: 'Too many requests — please try again shortly',
  OVERLOADED: 'The store system is busy — please try again shortly',
  UNAUTHORIZED: 'This tablet is signed out — please ask our staff to sign in again',
  FORBIDDEN: 'This tablet account cannot do this — please ask our staff',
  BAD_REQUEST: 'Please check what was entered',
};
export const errorEn = (code: string): string | null => ERRORS_EN[code] ?? null;
/** 请求没有明确的答复（断网、超时、服务器出错）时的英文：中文照 lib/api 的 UncertainError */
export const uncertainEn = (reason: 'timeout' | 'network' | 'server' | 'offline'): string =>
  reason === 'timeout'
    ? 'The store system did not answer in time'
    : reason === 'network'
      ? 'The connection was interrupted'
      : reason === 'offline'
        ? 'Cannot reach the store system — nothing was sent'
        : 'The store system ran into a problem';
/** 输入手牌、桌号那一步（给客人看）：有英文的换成英文 */
export const guestErrorEn = errorEn;

/** 一段两种语言都备好的字（8.1.6）：服务员那一步切到英文时两行都显示 */
export interface Both {
  zh: string;
  en: string;
}
/** 用两份词表各取一次（pick 里按语言取别的字，例如拒绝原因） */
export const both = (pick: (m: Messages, lang: Lang) => string): Both => ({ zh: pick(ZH, 'zh'), en: pick(EN, 'en') });
/** 显示用：中文时只有中文；英文时「英文\n中文」——显示的地方（BiText）把第二行排成小一号的一行 */
export const bothText = (t: Both, lang: Lang): string => (lang === 'en' && t.en !== t.zh ? `${t.en}\n${t.zh}` : t.zh);

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

/**
 * 菜品的英文名用衬线展示体（8.1.14，品牌部《工作台需求汇总 1.2》第 1 条，PENDING_DECISIONS.md PC1；样式表的 .em-en-display；
 * 8.1.19 起是授权的品牌英文字体 ABC Arizona Flare，没放授权文件时是 Playfair Display，PD1）。
 * 英文是手录的还是用翻译工具翻好经「英文对照表」导入的都一样走这里：
 * 只包住名字那几个字——名字后面的小字、份数、规格照旧用原来的字体
 */
export function EnName({ children }: { children: string }) {
  return <span className="em-en-display">{children}</span>;
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
