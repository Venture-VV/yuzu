// 管理后台（v0.6.0）：后台首页、规则总表、岗位权限。
// 规则总表把散在各处的设置（门店与营业、储值、会员、前台、库存、岗位权限）列在一张表里：当前值、默认值、
// 是否改过、最近谁改的、去哪里改；只读，修改仍走各自的接口（每次修改都记审计）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADMIN_PERMISSIONS, type AdminOverview, type RolePermissionMatrix, type RuleEntry, type RuleGroup } from '@shared/admin';
import { PRINT_MODE_LABELS, type PrintMode } from '@shared/tunables';
import { describeBusinessHours } from '@shared/business-date';
import { SHIFT_MODE_LABELS } from '@shared/checkout';
import { DEFAULT_FRONTDESK_RULES, type FrontdeskRules } from '@shared/frontdesk';
import { APPROVAL_RULE_LABELS, type ApprovalRules } from '@shared/inventory';
import { DEDUCTION_RULE_LABELS, describeHours, ROLE_LABELS } from '@shared/labels';
import { DEFAULT_MEMBERSHIP_RULES, type MembershipRules } from '@shared/membership';
import { CALL_TYPE_LABELS, DEFAULT_TECHNICIAN_RULES } from '@shared/technicians';
import { AFTER_DESIGNATED_LABELS, AFTER_ROTATION_LABELS, DEFAULT_CLOCKROOM_RULES, DEFAULT_COMMISSION_RULES, describeCommissionBase } from '@shared/clockroom';
import { DEFAULT_DINING_RULES } from '@shared/dining';
import { DEFAULT_EMENU_RULES } from '@shared/emenu';
import { DEFAULT_ROOM_RULES } from '@shared/rooms';
import { formatYuan } from '@shared/money';
import { DEFAULT_PURCHASE_RULES, DEPT_CONFIRM_RULE_LABELS } from '@shared/purchasing';
import { DEFAULT_PAYMENT_RULES, payDaysLabel } from '@shared/payments';
import { DEFAULT_EXPENSE_RULES } from '@shared/expenses';
import { DEFAULT_CANTEEN_SETTINGS, mealWindowText } from '@shared/canteen';
import { PATROL_ROUND_DEFAULT_MINUTES } from '@shared/patrol';
import {
  ALL_PERMISSIONS,
  can,
  EDITABLE_ROLES,
  LOCKED_PERMISSIONS,
  overridesFrom,
  PERMISSION_LABELS,
  roleDefault,
  roleHas,
  ROLES,
  type Permission,
  type Role,
  type RoleOverrides,
} from '@shared/permissions';
import type { Db } from '../db';
import { loadPaymentRules, PAYMENT_RULES_KEY } from './payments/rules';
import { loadExpenseRules } from './expenses';
import { loadCanteenSettings } from './canteen/settings';
import { loadPatrolSettings } from './patrol/core';
import { guard, guardAny } from '../auth/guard';
import { loadRoleOverrides } from '../auth/role-permissions';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { badRequest } from '../lib/errors';
import { sameJson } from '../lib/rule-settings';
import { parse } from '../lib/validate';
import { loadFrontdeskRules } from './frontdesk/common';
import { loadMembershipRules } from './membership';
import {
  DEFAULT_APPROVAL_RULES,
  DEFAULT_APPROVAL_THRESHOLD_CENTS,
  DEFAULT_URGENT_CAP_CENTS,
  DEFAULT_USAGE_WINDOW_DAYS,
  DEFAULT_CYCLE_RULES,
  loadInventorySettings,
} from './inventory/common';
import { DEFAULT_SETTINGS, loadSettings, SETTINGS_KEYS } from './settings';
import { loadTechnicianRules } from './technicians';
import { loadClockroomRules } from './clockroom';
import { loadPurchaseRules } from './inventory/purchase-rules';
import { commissionSettings } from './commission';
import { loadDiningRules } from './dining';
import { loadEmenuRules } from './emenu/core';
import { loadRoomRules } from './rooms';
import { loadLocationRules } from './locations';
import { DEFAULT_LOCATION_RULES } from '@shared/locations';
import { loadUsageRules } from './usages';
import { loadBookingRules } from './bookings';
import { DEFAULT_BOOKING_RULES, type BookingRules } from '@shared/bookings';
import { DEFAULT_USAGE_RULES } from '@shared/usages';
import { loadGuideRules } from './guide';
import { DEFAULT_GUIDE_RULES } from '@shared/guide';
import { lockSettings } from '../lib/rule-settings';

// 存进 jsonb 的对象键会重新排序（例如会员规则的各档），比较前按键名排好
const same = sameJson;
const onOff = (v: boolean, on: string, off: string) => (v ? on : off);
const approvals = (r: ApprovalRules) => {
  const on = (Object.keys(APPROVAL_RULE_LABELS) as (keyof ApprovalRules)[]).filter((k) => r[k]).map((k) => APPROVAL_RULE_LABELS[k]);
  return on.length ? `${on.join('、')}（盘点调整固定需要）` : '只有盘点调整需要';
};
const overrideCount = (o: RoleOverrides) => Object.values(o).reduce((n, x) => n + (x?.add.length ?? 0) + (x?.remove.length ?? 0), 0);

interface Meta {
  updatedAt: string | null;
  updatedBy: string | null;
}

async function settingsMeta(db: Db): Promise<Map<string, Meta>> {
  const rows = await db<{ key: string; updatedAt: string; updatedBy: string | null }[]>`
    SELECT s.key, s.updated_at, st.display_name AS updated_by FROM settings s LEFT JOIN staff st ON st.id = s.updated_by`;
  // 迁移写入、调整的初始值没有修改人，按「系统默认」显示，不列修改时间
  return new Map(rows.filter((r) => r.updatedBy).map((r) => [r.key, { updatedAt: new Date(r.updatedAt).toISOString(), updatedBy: r.updatedBy }]));
}

/** 规则总表：各项设置的当前值与默认值；pending 为店主还没签认、先按推荐做的默认做法 */
export async function ruleCatalog(db: Db): Promise<RuleEntry[]> {
  const s = await loadSettings(db);
  const d = DEFAULT_SETTINGS;
  const fd = await loadFrontdeskRules(db);
  const fdd: FrontdeskRules = DEFAULT_FRONTDESK_RULES;
  const inv = await loadInventorySettings(db);
  const pr = await loadPurchaseRules(db);
  const tech = await loadTechnicianRules(db);
  const techd = DEFAULT_TECHNICIAN_RULES;
  const overrides = await loadRoleOverrides(db);
  const meta = await settingsMeta(db);
  const none: Meta = { updatedAt: null, updatedBy: null };
  const m = (key: string) => meta.get(key) ?? none;
  const k = SETTINGS_KEYS;
  const sk = (prop: (typeof k)[keyof typeof k]) => Object.keys(k).find((x) => k[x as keyof typeof k] === prop)!;

  const entries: RuleEntry[] = [];
  const add = (e: Omit<RuleEntry, 'isDefault' | 'updatedAt' | 'updatedBy'> & { current: unknown; dflt: unknown; metaKey: string }) => {
    const { current, dflt, metaKey, ...rest } = e;
    entries.push({ ...rest, isDefault: same(current, dflt), ...m(metaKey) });
  };
  const hours = (h: number) => `每天 ${String(h).padStart(2, '0')}:00`;
  const window = (h: number | null) => (h === null ? '不限' : `消费 / 结账后 ${describeHours(h)}内`);
  const days = (n: number | null) => (n === null ? '长期有效' : `${n} 天`);
  const channels = (list: typeof s.memberChannels) => {
    const on = list.filter((c) => c.active).map((c) => c.label);
    return `${on.join('、') || '没有启用的渠道'}${list.length > on.length ? `（另有 ${list.length - on.length} 个已停用）` : ''}`;
  };

  // ── 门店与营业 ──
  add({ key: 'store_name', group: 'store', label: '门店名称', value: s.storeName, defaultValue: d.storeName, pending: false, section: 'rules', current: s.storeName, dflt: d.storeName, metaKey: sk('storeName') });
  add({
    key: 'business_day_start_hour', group: 'store', label: '营业日切换时间', value: hours(s.businessDayStartHour), defaultValue: hours(d.businessDayStartHour),
    pending: true, section: 'rules', hint: '凌晨的业务记入前一个营业日', current: s.businessDayStartHour, dflt: d.businessDayStartHour, metaKey: sk('businessDayStartHour'),
  });
  add({
    key: 'business_hours', group: 'store', label: '营业时间', value: describeBusinessHours(s.businessHours), defaultValue: describeBusinessHours(d.businessHours),
    pending: true, section: 'rules', hint: '只用于显示与提醒', current: s.businessHours, dflt: d.businessHours, metaKey: sk('businessHours'),
  });
  add({
    key: 'hide_pending_marks', group: 'store', label: '「待确认」标记', value: onOff(s.hidePendingMarks, '隐藏（店主已签认）', '显示'), defaultValue: '显示',
    pending: false, section: 'rules', current: s.hidePendingMarks, dflt: d.hidePendingMarks, metaKey: sk('hidePendingMarks'),
  });
  // ── 储值与收款 ──
  add({
    key: 'deduction_rule', group: 'wallet', label: '本金与赠金的扣款顺序', value: DEDUCTION_RULE_LABELS[s.deductionRule].title, defaultValue: DEDUCTION_RULE_LABELS[d.deductionRule].title,
    pending: true, section: 'rules', current: s.deductionRule, dflt: d.deductionRule, metaKey: sk('deductionRule'),
  });
  add({
    key: 'max_recharge_cents', group: 'wallet', label: '单笔充值上限', value: formatYuan(s.maxRechargeCents), defaultValue: formatYuan(d.maxRechargeCents),
    pending: false, section: 'rules', hint: '超过需店主或店总当场授权', current: s.maxRechargeCents, dflt: d.maxRechargeCents, metaKey: sk('maxRechargeCents'),
  });
  add({
    key: 'max_consume_cents', group: 'wallet', label: '单笔消费上限', value: formatYuan(s.maxConsumeCents), defaultValue: formatYuan(d.maxConsumeCents),
    pending: false, section: 'rules', hint: '超过需店主或店总当场授权', current: s.maxConsumeCents, dflt: d.maxConsumeCents, metaKey: sk('maxConsumeCents'),
  });
  // 充值当日的储值消费比例（8.0.4 需求表 04，HY01）
  const spendPct = (p: number | null) => (p === null ? '不限' : `当天第一笔充值前的余额 + 当天充值实收 × ${p}%`);
  add({
    key: 'recharge_spend_pct', group: 'wallet', label: '充值当日的储值消费上限', value: spendPct(s.rechargeSpendPct), defaultValue: spendPct(d.rechargeSpendPct),
    pending: true, section: 'rules', hint: '超过的储值支付直接拒绝并显示剩余额度；没充值的日子不限', current: s.rechargeSpendPct, dflt: d.rechargeSpendPct, metaKey: sk('rechargeSpendPct'),
  });
  add({
    key: 'reversal_window_hours', group: 'wallet', label: '撤销与反结账时限', value: window(s.reversalWindowHours), defaultValue: window(d.reversalWindowHours),
    pending: false, section: 'rules', hint: '超过后只有店主可以', current: s.reversalWindowHours, dflt: d.reversalWindowHours, metaKey: sk('reversalWindowHours'),
  });
  add({
    key: 'require_open_shift', group: 'wallet', label: '收款前必须先开班', value: onOff(s.requireOpenShift, '必须先开班', '不要求'), defaultValue: '必须先开班',
    pending: false, section: 'rules', current: s.requireOpenShift, dflt: d.requireOpenShift, metaKey: sk('requireOpenShift'),
  });
  // 交班方式（v0.7.28 ⑨，N11 待确认）
  const drawers = (list: typeof s.cashDrawers) => list.filter((d) => d.active).map((d) => d.label).join('、') || '没有启用的钱箱';
  add({
    key: 'shift_mode', group: 'wallet', label: '交班方式', value: SHIFT_MODE_LABELS[s.shiftMode], defaultValue: SHIFT_MODE_LABELS[d.shiftMode],
    pending: true, section: 'rules', hint: '按钱箱交班：同一个钱箱的人在同一个班次上，交班时点这个钱箱的钱', current: s.shiftMode, dflt: d.shiftMode, metaKey: sk('shiftMode'),
  });
  add({
    key: 'cash_drawers', group: 'wallet', label: '钱箱', value: drawers(s.cashDrawers), defaultValue: drawers(d.cashDrawers),
    pending: true, section: 'rules', hint: '按钱箱交班时开班选钱箱', current: s.cashDrawers, dflt: d.cashDrawers, metaKey: sk('cashDrawers'),
  });
  add({
    key: 'custom_bonus_valid_days', group: 'wallet', label: '自定义赠金有效期', value: days(s.customBonusValidDays), defaultValue: days(d.customBonusValidDays),
    pending: true, section: 'rules', hint: '套餐的赠金有效期在「价目与套餐」里设置', current: s.customBonusValidDays, dflt: d.customBonusValidDays, metaKey: sk('customBonusValidDays'),
  });
  // ── 会员与渠道 ──
  add({ key: 'member_channels', group: 'members', label: '渠道来源', value: channels(s.memberChannels), defaultValue: channels(d.memberChannels), pending: true, section: 'members', current: s.memberChannels, dflt: d.memberChannels, metaKey: sk('memberChannels') });
  // 会员自定义字段 8.0.4 起改成会员标签（数据，不是规则；在「会员与渠道 → 会员标签」维护），不在规则总表里
  // ── 会员体系 v2（v0.7.23，后台「会员体系 → 会员规则」）──
  const mr = await loadMembershipRules(db);
  const mrd = DEFAULT_MEMBERSHIP_RULES;
  const ladder = (r: MembershipRules) => r.grades.slice(1).map((g, i) => `L${i + 1} ${g.name} ${formatYuan(g.thresholdCents)} / ${g.bonusBp / 100}%`).join('，');
  const cycle = (r: MembershipRules) => `周期 ${r.cycleDays} 天；享阶 ${r.enjoyPct}%、尊阶（保级）${r.honorPct}%；补充期 ${r.graceDays} 天`;
  const mins = (r: MembershipRules) => `首充 ${r.firstRechargeMinCents ? formatYuan(r.firstRechargeMinCents) : '不限'}，续充 ${r.topUpMinCents ? formatYuan(r.topUpMinCents) : '不限'}`;
  add({ key: 'membership_rules.grades', group: 'members', label: '档级：门槛 / 赠送比例', value: ladder(mr), defaultValue: ladder(mrd), pending: true, section: 'membership', hint: '按滚动 365 天累计充值升档', current: mr.grades, dflt: mrd.grades, metaKey: 'membership_rules' });
  add({ key: 'membership_rules.cycle', group: 'members', label: '阶位与会籍周期', value: cycle(mr), defaultValue: cycle(mrd), pending: true, section: 'membership', current: [mr.cycleDays, mr.enjoyPct, mr.honorPct, mr.graceDays], dflt: [mrd.cycleDays, mrd.enjoyPct, mrd.honorPct, mrd.graceDays], metaKey: 'membership_rules' });
  add({ key: 'membership_rules.minimum', group: 'members', label: '单笔最低充值', value: mins(mr), defaultValue: mins(mrd), pending: true, section: 'membership', hint: '建议续充改成 1,000 或不限（M4）', current: [mr.firstRechargeMinCents, mr.topUpMinCents], dflt: [mrd.firstRechargeMinCents, mrd.topUpMinCents], metaKey: 'membership_rules' });
  add({ key: 'membership_rules.reminderDays', group: 'members', label: '到期提醒', value: mr.reminderDays.map((d) => `${d} 天`).join('、'), defaultValue: mrd.reminderDays.map((d) => `${d} 天`).join('、'), pending: true, section: 'membership', current: mr.reminderDays, dflt: mrd.reminderDays, metaKey: 'membership_rules' });
  // 生日礼提前几天到账（8.0.4，HY13）；VIP 柜 8.0.4 起归「会员权益」，不在规则总表里
  const lead = (d: number) => (d === 0 ? '生日当天' : `生日前 ${d} 天`);
  add({ key: 'membership_rules.birthdayLeadDays', group: 'members', label: '生日礼到账', value: lead(mr.birthdayLeadDays), defaultValue: lead(mrd.birthdayLeadDays), pending: true, section: 'membership', hint: '发券规则的生日礼、权益清单的生日礼遇都按它', current: mr.birthdayLeadDays, dflt: mrd.birthdayLeadDays, metaKey: 'membership_rules' });
  // ── 前台与结账 ──
  add({
    key: 'frontdesk_rules.selfVoidMinutes', group: 'frontdesk', label: '店员自行更正时限', value: `${fd.selfVoidMinutes} 分钟`, defaultValue: `${fdd.selfVoidMinutes} 分钟`,
    pending: false, section: 'tags', hint: '超时或他人登记的由值班经理及以上处理', current: fd.selfVoidMinutes, dflt: fdd.selfVoidMinutes, metaKey: 'frontdesk_rules',
  });
  add({
    key: 'frontdesk_rules.lostTagFeeCents', group: 'frontdesk', label: '丢牌赔偿', value: fd.lostTagFeeCents ? formatYuan(fd.lostTagFeeCents) : '不收', defaultValue: formatYuan(fdd.lostTagFeeCents),
    pending: false, section: 'tags', current: fd.lostTagFeeCents, dflt: fdd.lostTagFeeCents, metaKey: 'frontdesk_rules',
  });
  add({
    key: 'frontdesk_rules.overtimeGraceMinutes', group: 'frontdesk', label: '门票跳档宽限', value: `${fd.overtimeGraceMinutes} 分钟`, defaultValue: `${fdd.overtimeGraceMinutes} 分钟`,
    pending: false, section: 'tags', hint: '12 小时分界点之后多少分钟内不跳档', current: fd.overtimeGraceMinutes, dflt: fdd.overtimeGraceMinutes, metaKey: 'frontdesk_rules',
  });
  // ── 技师（v0.7.0）──
  add({
    key: 'technician_rules.enabled', group: 'technicians', label: '技师功能', value: onOff(tech.enabled, '开启（挂需要技师的项目时选技师）', '关闭（与升级前一样）'),
    defaultValue: '关闭（与升级前一样）', pending: false, section: 'technicians', current: tech.enabled, dflt: techd.enabled, metaKey: 'technician_rules',
  });
  add({
    key: 'technician_rules.requireTechnician', group: 'technicians', label: '挂技师项目必须选技师', value: onOff(tech.requireTechnician, '必须选', '可以暂不指定'),
    defaultValue: '必须选', pending: true, section: 'technicians', current: tech.requireTechnician, dflt: techd.requireTechnician, metaKey: 'technician_rules',
  });
  add({
    key: 'technician_rules.tierByGrade', group: 'technicians', label: '价格跟技师等级', value: onOff(tech.tierByGrade, '按技师等级取价（标准 / 专业 / 优选）', '前台自选价格档'),
    defaultValue: '按技师等级取价（标准 / 专业 / 优选）', pending: true, section: 'technicians', hint: '只有一档价格的项目不分等级', current: tech.tierByGrade, dflt: techd.tierByGrade, metaKey: 'technician_rules',
  });
  add({
    key: 'technician_rules.defaultCallType', group: 'technicians', label: '默认上钟方式', value: CALL_TYPE_LABELS[tech.defaultCallType], defaultValue: CALL_TYPE_LABELS[techd.defaultCallType],
    pending: true, section: 'technicians', hint: '客人点名的改成点钟', current: tech.defaultCallType, dflt: techd.defaultCallType, metaKey: 'technician_rules',
  });
  // ── 钟房与提成（v0.7.1）──
  const cr = await loadClockroomRules(db);
  const crd = DEFAULT_CLOCKROOM_RULES;
  const rejectText = (r: typeof cr) => `${r.rejectKeepsPlace ? '回到原位' : '不回原位'}${r.rejectEndAfter ? `，连续 ${r.rejectEndAfter} 次排到队尾` : ''}`;
  add({ key: 'clockroom_rules.afterRotation', group: 'technicians', label: '轮钟排尾', value: AFTER_ROTATION_LABELS[cr.afterRotation], defaultValue: AFTER_ROTATION_LABELS[crd.afterRotation], pending: true, section: 'technicians', current: cr.afterRotation, dflt: crd.afterRotation, metaKey: 'clockroom_rules' });
  add({ key: 'clockroom_rules.afterDesignated', group: 'technicians', label: '点钟后的排位', value: AFTER_DESIGNATED_LABELS[cr.afterDesignated], defaultValue: AFTER_DESIGNATED_LABELS[crd.afterDesignated], pending: true, section: 'technicians', current: cr.afterDesignated, dflt: crd.afterDesignated, metaKey: 'clockroom_rules' });
  add({ key: 'clockroom_rules.reject', group: 'technicians', label: '被退钟、取消派钟', value: rejectText(cr), defaultValue: rejectText(crd), pending: true, section: 'technicians', current: [cr.rejectKeepsPlace, cr.rejectEndAfter], dflt: [crd.rejectKeepsPlace, crd.rejectEndAfter], metaKey: 'clockroom_rules' });
  add({ key: 'clockroom_rules.backToEnd', group: 'technicians', label: '休息回牌', value: onOff(cr.backToEnd, '排到队尾', '回到原位'), defaultValue: '排到队尾', pending: true, section: 'technicians', current: cr.backToEnd, dflt: crd.backToEnd, metaKey: 'clockroom_rules' });
  add({ key: 'clockroom_rules.skipNeedsReason', group: 'technicians', label: '轮钟跳过排第一的技师', value: onOff(cr.skipNeedsReason, '必须写原因（记钟房日志）', '不用写原因'), defaultValue: '必须写原因（记钟房日志）', pending: true, section: 'technicians', current: cr.skipNeedsReason, dflt: crd.skipNeedsReason, metaKey: 'clockroom_rules' });
  add({ key: 'clockroom_rules.extensionAsDesignated', group: 'technicians', label: '加钟', value: onOff(cr.extensionAsDesignated, '原技师继续，记为点钟', '原技师继续，按原上钟方式'), defaultValue: '原技师继续，记为点钟', pending: true, section: 'technicians', current: cr.extensionAsDesignated, dflt: crd.extensionAsDesignated, metaKey: 'clockroom_rules' });
  add({ key: 'clockroom_rules.minutes', group: 'technicians', label: '上钟计时', value: `没写时长的项目一钟 ${cr.defaultMinutes} 分钟；提前 ${cr.remindMinutes} 分钟提醒快到钟`, defaultValue: `没写时长的项目一钟 ${crd.defaultMinutes} 分钟；提前 ${crd.remindMinutes} 分钟提醒快到钟`, pending: true, section: 'technicians', current: [cr.defaultMinutes, cr.remindMinutes], dflt: [crd.defaultMinutes, crd.remindMinutes], metaKey: 'clockroom_rules' });
  const cs = await commissionSettings(db);
  const commissionText = (r: typeof cs.current.rules) => `${describeCommissionBase(r.base)}；点钟每钟另加 ${formatYuan(r.designatedBonus)}${Object.keys(r.items).length ? `；${Object.keys(r.items).length} 个项目单独设置` : ''}`;
  entries.push({
    key: 'commission_rules',
    group: 'technicians',
    label: '技师提成',
    value: commissionText(cs.current.rules),
    defaultValue: commissionText(DEFAULT_COMMISSION_RULES),
    isDefault: same(cs.current.rules, DEFAULT_COMMISSION_RULES),
    pending: true,
    section: 'technicians',
    hint: '按结账时刻的规则版本计算，改规则不影响已结的钟',
    updatedAt: cs.current.effectiveAt,
    updatedBy: cs.current.createdByName,
  });
  // ── 餐饮（S5 第一步）──
  const dn = await loadDiningRules(db);
  const dnd = DEFAULT_DINING_RULES;
  add({ key: 'dining_rules.enabled', group: 'dining', label: '餐饮功能', value: onOff(dn.enabled, '开启（点单、厨房出品屏、估清）', '关闭（与升级前一样）'), defaultValue: '关闭（与升级前一样）', pending: false, section: 'dining', current: dn.enabled, dflt: dnd.enabled, metaKey: 'dining_rules' });
  add({ key: 'dining_rules.trackServed', group: 'dining', label: '上菜确认', value: onOff(dn.trackServed, '出餐后服务员点「上菜」', '出餐即算上菜'), defaultValue: '出餐后服务员点「上菜」', pending: true, section: 'dining', current: dn.trackServed, dflt: dnd.trackServed, metaKey: 'dining_rules' });
  add({ key: 'dining_rules.warnMinutes', group: 'dining', label: '出品超时提醒', value: `下单 ${dn.warnMinutes} 分钟还没出餐标红`, defaultValue: `下单 ${dnd.warnMinutes} 分钟还没出餐标红`, pending: true, section: 'dining', current: dn.warnMinutes, dflt: dnd.warnMinutes, metaKey: 'dining_rules' });
  // ── 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）──
  const em = await loadEmenuRules(db);
  const emd = DEFAULT_EMENU_RULES;
  const idleText = (m: number) => (m === 0 ? '不自动回' : `${m} 分钟没人动回到起始页、清掉没下单的菜`);
  add({ key: 'emenu_rules.enabled', group: 'emenu', label: '平板点餐', value: onOff(em.enabled, '开启（餐桌平板翻菜单、下单）', '关闭（与升级前一样）'), defaultValue: '关闭（与升级前一样）', pending: false, section: 'emenu', current: em.enabled, dflt: emd.enabled, metaKey: 'emenu_rules' });
  const pinText = (on: boolean) => (on ? '要（下单、重新提交、作废都要服务员输 6 位点单密码）' : '不要（核对手牌与桌号后直接下单，经办人记平板的账号）');
  const sizeText = (v: string) => (v === 'design' ? '设计稿原样' : '放大');
  add({ key: 'emenu_rules.requirePin', group: 'emenu', label: '点单密码', value: pinText(em.requirePin), defaultValue: pinText(emd.requirePin), pending: true, section: 'emenu', current: em.requirePin, dflt: emd.requirePin, metaKey: 'emenu_rules' });
  add({ key: 'emenu_rules.textSize', group: 'emenu', label: '平板上字与按钮的大小', value: sizeText(em.textSize), defaultValue: sizeText(emd.textSize), pending: true, section: 'emenu', current: em.textSize, dflt: emd.textSize, metaKey: 'emenu_rules' });
  add({ key: 'emenu_rules.avoidOptions', group: 'emenu', label: '忌口选项', value: em.avoidOptions.join('、') || '没有', defaultValue: emd.avoidOptions.join('、'), pending: true, section: 'emenu', hint: '多选，写在这一单每道菜的口味备注上', current: em.avoidOptions, dflt: emd.avoidOptions, metaKey: 'emenu_rules' });
  add({ key: 'emenu_rules.serveOptions', group: 'emenu', label: '起菜方式', value: em.serveOptions.join('、') || '没有', defaultValue: emd.serveOptions.join('、'), pending: true, section: 'emenu', hint: '单选，可以不选', current: em.serveOptions, dflt: emd.serveOptions, metaKey: 'emenu_rules' });
  add({ key: 'emenu_rules.idleMinutes', group: 'emenu', label: '没人动多久回到起始页', value: idleText(em.idleMinutes), defaultValue: idleText(emd.idleMinutes), pending: true, section: 'emenu', current: em.idleMinutes, dflt: emd.idleMinutes, metaKey: 'emenu_rules' });
  add({ key: 'emenu_rules.offHours', group: 'emenu', label: '不在供应时段的分类', value: em.offHours === 'hide' ? '平板上不显示' : '显示但不能点', defaultValue: emd.offHours === 'hide' ? '平板上不显示' : '显示但不能点', pending: true, section: 'emenu', current: em.offHours, dflt: emd.offHours, metaKey: 'emenu_rules' });
  // ── 客房（S7，v0.7.4）──
  const rm = await loadRoomRules(db);
  const rmd = DEFAULT_ROOM_RULES;
  const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const lateText = (r: typeof rm) => `${clock(r.checkoutMinute)} 退房；${clock(r.checkoutMinute)}–${clock(r.lateFullMinute)} 加收半天，${clock(r.lateFullMinute)} 以后加收一晚`;
  add({ key: 'room_rules.enabled', group: 'rooms', label: '客房功能', value: onOff(rm.enabled, '开启（房态、入住、押金、夜审）', '关闭（与升级前一样）'), defaultValue: '关闭（与升级前一样）', pending: false, section: 'rooms', current: rm.enabled, dflt: rmd.enabled, metaKey: 'room_rules' });
  add({
    key: 'room_rules.checkout', group: 'rooms', label: '全天房退房时间', value: lateText(rm), defaultValue: lateText(rmd), pending: true, section: 'rooms',
    hint: '夜审也在加收一晚的时刻以后做', current: [rm.checkoutMinute, rm.lateFullMinute], dflt: [rmd.checkoutMinute, rmd.lateFullMinute], metaKey: 'room_rules',
  });
  add({ key: 'room_rules.hourlyGraceMinutes', group: 'rooms', label: '钟点房超时宽限', value: `${rm.hourlyGraceMinutes} 分钟`, defaultValue: `${rmd.hourlyGraceMinutes} 分钟`, pending: true, section: 'rooms', hint: '超过已付时段加宽限才按段补', current: rm.hourlyGraceMinutes, dflt: rmd.hourlyGraceMinutes, metaKey: 'room_rules' });
  add({ key: 'room_rules.defaultDeposit', group: 'rooms', label: '入住默认押金', value: rm.defaultDeposit ? `默认收 ${formatYuan(rm.defaultDeposit)}` : '默认不收', defaultValue: '默认不收', pending: true, section: 'rooms', hint: '住客都有手牌、离店前在前台结清；入住时可以改', current: rm.defaultDeposit, dflt: rmd.defaultDeposit, metaKey: 'room_rules' });
  // ── 预约（v0.7.28 ③，N4）──
  const bk = await loadBookingRules(db);
  const bkd = DEFAULT_BOOKING_RULES;
  const windowText = (r: BookingRules) => `${r.openTime}–${r.closeTime}，每 ${r.slotMinutes} 分钟一格，最远约 ${r.maxDaysAhead} 天后`;
  const mpText = (r: BookingRules) => `每人同时最多 ${r.mpMaxOpen} 个；开始前 ${r.confirmLeadMinutes} 分钟还没确认自动取消；开始前 ${r.mpCancelLeadMinutes} 分钟以前可以自己取消`;
  const noShowText = (r: BookingRules) =>
    `过了开始 ${r.noShowMinutes} 分钟没到店记爽约；${r.noShowWindowDays} 天内爽约 ${r.noShowLimit} 次${r.noShowBanDays ? `，之后 ${r.noShowBanDays} 天不能在小程序预约` : '，不限制'}`;
  const lengthText = (r: BookingRules) => `派对房等可约 ${r.spaceDurations.map((m) => `${m / 60} 小时`).join('、')}；技师项目没写时长按 ${r.defaultServiceMinutes} 分钟；客房电话预订保留到预计到店后 ${r.roomHoldMinutes} 分钟`;
  const pick = <K extends keyof BookingRules>(r: BookingRules, keys: K[]) => keys.map((x) => r[x]);
  const bookingEntry = (key: string, label: string, text: (r: BookingRules) => string, keys: (keyof BookingRules)[], hint?: string) =>
    add({ key: `booking_rules.${key}`, group: 'bookings', label, value: text(bk), defaultValue: text(bkd), pending: true, section: 'bookings', hint, current: pick(bk, keys), dflt: pick(bkd, keys), metaKey: 'booking_rules' });
  bookingEntry('window', '能约的时段', windowText, ['openTime', 'closeTime', 'slotMinutes', 'maxDaysAhead'], '前台、电话、小程序都按这个时段约');
  bookingEntry('mp', '小程序预约', mpText, ['mpMaxOpen', 'confirmLeadMinutes', 'mpCancelLeadMinutes'], '小程序的预约先「待确认」，前台确认');
  bookingEntry('noShow', '爽约', noShowText, ['noShowMinutes', 'noShowWindowDays', 'noShowLimit', 'noShowBanDays']);
  bookingEntry('lengths', '时长与保留', lengthText, ['spaceDurations', 'defaultServiceMinutes', 'roomHoldMinutes']);
  // ── 平面图收尾（v0.7.19）：开单即占用的业态 ──
  const ur = await loadUsageRules(db);
  const usageText = (types: string[]) => (types.length ? `${types.join('、')}：有开着的使用单算使用中` : '没有（派对房等只显示业态）');
  add({
    key: 'usage_rules.businessTypes', group: 'floormap', label: '开单即占用的业态', value: usageText(ur.businessTypes), defaultValue: usageText(DEFAULT_USAGE_RULES.businessTypes),
    pending: true, section: 'spaces', hint: '这些业态的房间不派技师，开单即「使用中」，结束、使用人结账或撤单后空闲', current: ur.businessTypes, dflt: DEFAULT_USAGE_RULES.businessTypes, metaKey: 'usage_rules',
  });
  const gr = await loadGuideRules(db);
  add({
    key: 'guide_rules.carouselSeconds', group: 'floormap', label: '对客导览大屏轮播', value: `每层停 ${gr.carouselSeconds} 秒`, defaultValue: `每层停 ${DEFAULT_GUIDE_RULES.carouselSeconds} 秒`,
    pending: true, section: 'spaces', hint: '门店大屏打开「对客导览 → 大屏模式」按楼层轮播', current: gr.carouselSeconds, dflt: DEFAULT_GUIDE_RULES.carouselSeconds, metaKey: 'guide_rules',
  });
  // ── 第一级实时位置（RQ-004，v0.7.17）──
  const lr = await loadLocationRules(db);
  const zoneNames = new Map(
    (await db<{ id: number; name: string }[]>`SELECT id, name FROM zones WHERE id IN ${db([lr.checkinZoneId ?? 0, lr.restZoneId ?? 0])}`).map((z) => [z.id, z.name]),
  );
  const zoneText = (r: typeof lr) =>
    `接待区：${r.checkinZoneId ? (zoneNames.get(r.checkinZoneId) ?? '已删除的区域') : '不推导'}；技师休息区：${r.restZoneId ? (zoneNames.get(r.restZoneId) ?? '已删除的区域') : '不推导（下钟后位置不明）'}`;
  add({ key: 'location_rules.enabled', group: 'locations', label: '实时位置', value: onOff(lr.enabled, '开启（刷卡与业务动作推导客人、技师在哪）', '关闭'), defaultValue: '关闭', pending: true, section: 'spaces', hint: '关着时不推导、刷卡上报拒绝；离店照样清掉已有的位置', current: lr.enabled, dflt: DEFAULT_LOCATION_RULES.enabled, metaKey: 'location_rules' });
  add({ key: 'location_rules.zones', group: 'locations', label: '接待区与技师休息区', value: zoneText(lr), defaultValue: zoneText(DEFAULT_LOCATION_RULES), pending: true, section: 'spaces', hint: '发手牌后客人在接待区；技师上牌、下钟后在休息区', current: [lr.checkinZoneId, lr.restZoneId], dflt: [null, null], metaKey: 'location_rules' });
  // ── 库存与采购 ──
  add({ key: 'inventory_scope_name', group: 'inventory', label: '库存范围', value: inv.scopeName, defaultValue: '后勤总库', pending: true, section: 'rules', href: '/erp/settings/inventory', current: inv.scopeName, dflt: '后勤总库', metaKey: 'inventory_scope_name' });
  // 迁移 002 写入的初始口径
  const basis = '含税到货价（模拟口径，待确认）';
  add({ key: 'inventory_price_basis', group: 'inventory', label: '价格口径', value: inv.priceBasis, defaultValue: basis, pending: true, section: 'rules', href: '/erp/settings/inventory', current: inv.priceBasis, dflt: basis, metaKey: 'inventory_price_basis' });
  add({
    key: 'inventory_urgent_cap_cents', group: 'inventory', label: '急采上限', value: `每张急采单不超过 ${formatYuan(inv.urgentCapCents)}`,
    defaultValue: `每张急采单不超过 ${formatYuan(DEFAULT_URGENT_CAP_CENTS)}`, pending: true, section: 'rules', href: '/erp/settings/inventory',
    hint: '8.0.1 起由采购在「采购 → 急采」登记，按金额分级审批后仓库验收、采购补单；上限就是「采购规则」里急采分级的最高一档，在那里改',
    current: inv.urgentCapCents, dflt: DEFAULT_URGENT_CAP_CENTS, metaKey: 'purchase_rules',
  });
  add({
    key: 'inventory_approval_rules', group: 'inventory', label: '需要负责人确认的单据', value: approvals(inv.approvalRules), defaultValue: approvals(DEFAULT_APPROVAL_RULES),
    pending: true, section: 'rules', href: '/erp/settings/inventory', current: inv.approvalRules, dflt: DEFAULT_APPROVAL_RULES, metaKey: 'inventory_approval_rules',
  });
  const threshold = (c: number) => (c > 0 ? `${formatYuan(c)} 以内不用负责人确认` : '全部要负责人确认');
  add({
    key: 'inventory_approval_threshold_cents', group: 'inventory', label: '免确认门槛', value: threshold(inv.approvalThresholdCents),
    defaultValue: threshold(DEFAULT_APPROVAL_THRESHOLD_CENTS), pending: true, section: 'rules', href: '/erp/settings/inventory',
    hint: '采购单、报损、退供应商、付款、期初在设为需要确认时，金额不超过门槛的提交即生效；总仓盘点调整照旧要确认',
    current: inv.approvalThresholdCents, dflt: DEFAULT_APPROVAL_THRESHOLD_CENTS, metaKey: 'inventory_approval_threshold_cents',
  });
  add({
    key: 'inventory_usage_window_days', group: 'inventory', label: '可用天数的用量统计', value: `按近 ${inv.usageWindowDays} 天的用量`,
    defaultValue: `按近 ${DEFAULT_USAGE_WINDOW_DAYS} 天的用量`, pending: true, section: 'rules', href: '/erp/settings/inventory',
    hint: '物料设了提醒天数时，可用天数 = 结存 ÷ 这段时间的日均用量，少于提醒天数就提醒',
    current: inv.usageWindowDays, dflt: DEFAULT_USAGE_WINDOW_DAYS, metaKey: 'inventory_usage_window_days',
  });
  // 称重与盘点、对账提醒（#14、#23，v0.7.13）：存成一条 inventory_cycle_rules
  const cyc = DEFAULT_CYCLE_RULES;
  add({
    key: 'inventory_cycle_rules.weighTolerancePct', group: 'inventory', label: '称重收货容差', value: `可以比采购单多 ${inv.weighTolerancePct}%`,
    defaultValue: `可以比采购单多 ${cyc.weighTolerancePct}%`, pending: true, section: 'rules', href: '/erp/settings/inventory',
    hint: '物料设为称重的，按实际称重收货，可以比采购单这一行的订购数量多出这么多；货款按实收重量算',
    current: inv.weighTolerancePct, dflt: cyc.weighTolerancePct, metaKey: 'inventory_cycle_rules',
  });
  const stText = (d: number, g: number) => `每月 ${d} 号起提醒，过 ${g} 天没盘完标红`;
  add({
    key: 'inventory_cycle_rules.stocktake', group: 'inventory', label: '每月盘点提醒', value: stText(inv.stocktakeDay, inv.stocktakeGraceDays),
    defaultValue: stText(cyc.stocktakeDay, cyc.stocktakeGraceDays), pending: true, section: 'rules', href: '/erp/settings/inventory',
    hint: '每个仓按「月初有结存的物料本月都在盘点单里盘到」算盘完；部门小仓的台面日耗品不用清点',
    current: [inv.stocktakeDay, inv.stocktakeGraceDays], dflt: [cyc.stocktakeDay, cyc.stocktakeGraceDays], metaKey: 'inventory_cycle_rules',
  });
  const rcText = (d: number, g: number, b: number) => `月结：每月 ${d} 号起提醒对上个月的账，过 ${g} 天标红；按批次：收货后 ${b} 天标红`;
  add({
    key: 'inventory_cycle_rules.recon', group: 'inventory', label: '供应商对账提醒', value: rcText(inv.monthlyReconDay, inv.monthlyReconGraceDays, inv.batchReconGraceDays),
    defaultValue: rcText(cyc.monthlyReconDay, cyc.monthlyReconGraceDays, cyc.batchReconGraceDays), pending: true, section: 'rules', href: '/erp/settings/inventory',
    hint: '挂账供应商在档案里选「月结」或「按批次」；对完账在「货款 → 对账」登记',
    current: [inv.monthlyReconDay, inv.monthlyReconGraceDays, inv.batchReconGraceDays],
    dflt: [cyc.monthlyReconDay, cyc.monthlyReconGraceDays, cyc.batchReconGraceDays], metaKey: 'inventory_cycle_rules',
  });
  // 采购规则（v0.7.29 ERP 采购五项，docs/ERP_PURCHASING.md）：存成一条 purchase_rules
  const prd = DEFAULT_PURCHASE_RULES;
  const channelText = (r: typeof pr) => r.channels.map((c) => (c.needsNote ? `${c.label}（写说明）` : c.label)).join('、');
  add({
    key: 'purchase_rules.channels', group: 'inventory', label: '采购途径', value: channelText(pr), defaultValue: channelText(prd), pending: true, section: 'rules', href: '/erp/settings/purchase',
    hint: '采购单、报销单记在哪买的；供应商档案可设默认途径。在「ERP 设置 → 采购规则」里改',
    current: pr.channels, dflt: prd.channels, metaKey: 'purchase_rules',
  });
  const quoteText = (r: typeof pr) => (r.quoteThresholdCents > 0 ? `${formatYuan(r.quoteThresholdCents)} 及以上要询价比价，至少 ${r.minQuotes} 家报价` : '不要求询价比价');
  add({
    key: 'purchase_rules.quotes', group: 'inventory', label: '询价比价门槛', value: quoteText(pr), defaultValue: quoteText(prd), pending: true, section: 'rules', href: '/erp/settings/purchase',
    hint: '合计到门槛的采购单第一次提交时要来自已定标的询价单；只有一家报价的标单一来源、由负责人定标；补单与改版不拦',
    current: [pr.quoteThresholdCents, pr.minQuotes], dflt: [prd.quoteThresholdCents, prd.minQuotes], metaKey: 'purchase_rules',
  });
  const replText = (r: typeof pr) => `可用天数少于 ${r.reorderDays} 天（物料设了提醒天数按物料的）就建议补，补到 ${r.targetDays} 天`;
  add({
    key: 'purchase_rules.replenish', group: 'inventory', label: '补货建议', value: replText(pr), defaultValue: replText(prd), pending: true, section: 'rules', href: '/erp/settings/purchase',
    hint: '只看总仓；在途（没到的采购单）算进去；按采购单位向上取整',
    current: [pr.reorderDays, pr.targetDays], dflt: [prd.reorderDays, prd.targetDays], metaKey: 'purchase_rules',
  });
  // 8.0.18 规则总表补全（docs/IA_V8017.md 第 3.3 节）：8.0.17 加的两项采购规则，付款、报销、员工食堂、安保巡场的规则原来不在总表里
  add({
    key: 'purchase_rules.deptConfirm', group: 'inventory', label: '部门主管确认', value: DEPT_CONFIRM_RULE_LABELS[pr.deptConfirm], defaultValue: DEPT_CONFIRM_RULE_LABELS[prd.deptConfirm],
    pending: true, section: 'rules', href: '/erp/settings/purchase', hint: '哪些需求单要部门主管先确认，采购才能审核通过；部门没设主管、提单人就是主管、店主提的不拦',
    current: pr.deptConfirm, dflt: prd.deptConfirm, metaKey: 'purchase_rules',
  });
  add({
    key: 'purchase_rules.flowStall', group: 'inventory', label: '流程图里一个环节等了几天标红', value: `${pr.flowStallDays} 天`, defaultValue: `${prd.flowStallDays} 天`,
    pending: true, section: 'rules', href: '/erp/settings/purchase', hint: '采购流程图；到货按预计到货日另算',
    current: pr.flowStallDays, dflt: prd.flowStallDays, metaKey: 'purchase_rules',
  });
  const pay = await loadPaymentRules(db);
  const payd = DEFAULT_PAYMENT_RULES;
  const payDaysText = (r: typeof pay) => payDaysLabel(r.payDays) || '没有固定付款日';
  add({
    key: 'payment_rules.payDays', group: 'erp', label: '固定付款日', value: payDaysText(pay), defaultValue: payDaysText(payd), pending: true, section: 'rules', href: '/erp/settings/payments',
    hint: '只是日子：新建付款申请默认取下一个付款日，流程图的付款环节按它提示',
    current: pay.payDays, dflt: payd.payDays, metaKey: PAYMENT_RULES_KEY,
  });
  const threeWayText = (r: typeof pay) => `差额不超过收货金额的 ${r.threeWayPctBp / 100}% 且不超过 ${formatYuan(r.threeWayCapCents)}`;
  add({
    key: 'payment_rules.threeWay', group: 'erp', label: '三单比对的容差', value: threeWayText(pay), defaultValue: threeWayText(payd), pending: true, section: 'rules', href: '/erp/settings/payments',
    hint: '采购单、收货、发票三个金额；超过的挂起、财务放行',
    current: [pay.threeWayPctBp, pay.threeWayCapCents], dflt: [payd.threeWayPctBp, payd.threeWayCapCents], metaKey: PAYMENT_RULES_KEY,
  });
  const contractGoodsText = (r: typeof pay) => (r.requireRequestForContractGoods ? '要先提付款申请' : '可以直接登记付款');
  add({
    key: 'payment_rules.contractGoods', group: 'erp', label: '挂合同的货款', value: contractGoodsText(pay), defaultValue: contractGoodsText(payd), pending: true, section: 'rules', href: '/erp/settings/payments',
    current: pay.requireRequestForContractGoods, dflt: payd.requireRequestForContractGoods, metaKey: PAYMENT_RULES_KEY,
  });
  const exp = await loadExpenseRules(db);
  const expd = DEFAULT_EXPENSE_RULES;
  add({
    key: 'expense_rules.threshold', group: 'erp', label: '报销要负责人确认的门槛', value: `单笔超过 ${formatYuan(exp.approvalThresholdCents)}`, defaultValue: `单笔超过 ${formatYuan(expd.approvalThresholdCents)}`,
    pending: true, section: 'rules', href: '/erp/settings/expenses',
    current: exp.approvalThresholdCents, dflt: expd.approvalThresholdCents, metaKey: 'expense_rules',
  });
  add({
    key: 'expense_rules.overdue', group: 'erp', label: '备用金多久没平账标红', value: `打款后超过 ${exp.overdueDays} 天`, defaultValue: `打款后超过 ${expd.overdueDays} 天`,
    pending: true, section: 'rules', href: '/erp/settings/expenses',
    current: exp.overdueDays, dflt: expd.overdueDays, metaKey: 'expense_rules',
  });
  // 人员与行政：员工食堂的开饭时间、安保巡场的间隔（页面在后台「人员与行政」，8.0.18）
  const canteen = await loadCanteenSettings(db);
  const mealsText = (list: typeof canteen.meals) => list.map(mealWindowText).join('、');
  add({
    key: 'canteen.meals', group: 'workplace', label: '开饭时间', value: mealsText(canteen.meals), defaultValue: mealsText(DEFAULT_CANTEEN_SETTINGS.meals), pending: false, section: 'canteen',
    hint: '员工食堂 → 设置；打卡按它算哪一餐',
    current: canteen.meals, dflt: DEFAULT_CANTEEN_SETTINGS.meals, metaKey: 'canteen',
  });
  const patrol = await loadPatrolSettings(db);
  add({
    key: 'patrol.round', group: 'workplace', label: '巡场间隔', value: `每 ${patrol.roundMinutes} 分钟一轮`, defaultValue: `每 ${PATROL_ROUND_DEFAULT_MINUTES} 分钟一轮`, pending: false, section: 'patrol',
    hint: '安保巡场 → 设置；同一个场所每轮只记一次',
    current: patrol.roundMinutes, dflt: PATROL_ROUND_DEFAULT_MINUTES, metaKey: 'patrol',
  });
  // ── 可调的数值（8.0.7 A1，店主 2026-11-10：有争议的规则不要写死；后台「门店基本规则 → 可调的数值」）──
  const tun = (key: keyof typeof k, group: RuleGroup, label: string, show: (v: never) => string, hint?: string) => {
    const prop = k[key] as keyof typeof s;
    add({
      key, group, label, value: show(s[prop] as never), defaultValue: show(d[prop] as never), pending: true, section: 'rules',
      // 属于 ERP 的数值（8.0.18）在「ERP 设置 → 其他数值」里改
      ...(group === 'erp' || group === 'inventory' ? { href: '/erp/settings/tunables' } : {}),
      ...(hint ? { hint } : {}), current: s[prop], dflt: d[prop], metaKey: key,
    });
  };
  const n = (unit: string) => (v: number) => `${v} ${unit}`;
  tun('approval_batch_max_cents', 'erp', '批量同意：每张不超过', (v: number) => formatYuan(v), 'A5；超过的要打开单独审');
  tun('approval_batch_max', 'erp', '批量同意：一次最多', n('张'), 'A5');
  tun('approval_overdue_hours', 'erp', '审批超时', (v: number) => `当前这一级等了超过 ${v} 小时`, 'A6；超时的排在最前');
  tun('delegation_max_days', 'erp', '代理人最长', n('天'), 'A7；含首尾');
  tun('urgent_escalate_days', 'erp', '急采待补单升级', (v: number) => `收货生效后超过 ${v} 天没补采购单`, 'A10；进负责人待办');
  tun('contract_remind_days', 'erp', '合同到期提醒', (v: number) => `结束日前 ${v} 天`, 'C11');
  tun('pdf_max_mb', 'inventory', 'PDF 每份最大', n('MB'), 'CG08；签约供应商合同、收货附件、发票附件');
  tun('receipt_attachments_max', 'inventory', '每张收货单最多附件', n('份'), 'CG11');
  tun('mp_food_max_quantity', 'dining', '扫码点餐一单最多', n('份'), 'N1');
  tun('mp_food_max_total_cents', 'dining', '扫码点餐一单最多金额', (v: number) => formatYuan(v), 'N1');
  tun('platform_backfill_days', 'frontdesk', '平台核销最早补到', (v: number) => `${v} 天前`, 'N6');
  tun('print_mode', 'frontdesk', '打印方式', (v: PrintMode) => PRINT_MODE_LABELS[v], '店主 2026-11-10：连接打印机由各自的电脑负责');
  tun('print_wait_minutes', 'frontdesk', '小票机断网时最多等', n('分钟'), 'N7；只在「服务器直连网口小票机」时用');
  tun('campaign_max_members', 'members', '批量发券一次最多', n('位会员'), 'HY07');
  tun('campaign_notice_days', 'members', '到账弹窗最多显示', n('天'), 'HY16');
  tun('sms_max_attempts', 'members', '短信最多试', n('次'), 'HY08');
  tun('count_card_sales', 'members', '次卡', (v: boolean) => (v ? '照常售卖' : '停售（已售的照常用、退）'), 'HY05');
  tun('finance_hides_marketing_cost', 'staff', '财务账号看营销成本', (v: boolean) => (v ? '有财务职责的看不到' : '按岗位权限给'), 'HY14');
  // 8.0.7 供应链收尾与应收（docs/ERP_V807.md 第 6 节）
  tun('supplier_approved_only', 'inventory', '采购单只能给已准入的供应商', (v: boolean) => (v ? '是（待准入、暂停的拒绝）' : '否（只提醒）'), 'V2');
  tun('license_remind_days', 'inventory', '供应商证照到期提醒', (v: number) => `到期前 ${v} 天`, 'V3');
  tun('supplier_watch_score', 'inventory', '供应商观察名单', (v: number) => `季度分数低于 ${v} 分`, 'V5；权重准时 40、合格 40、价格 20（V4）');
  tun('consumption_purposes', 'inventory', '部门耗用的用途', (v: string[]) => v.join('、'), 'V6');
  tun('slow_moving_days', 'inventory', '呆滞', (v: number) => `有结存、超过 ${v} 天没出库`, 'V7；只提醒（V8）');
  tun('acceptance_holds_payment', 'erp', '验收不合格挂起付款', (v: boolean) => (v ? '挂起，重新验收合格解除' : '不挂起'), 'V9');
  tun('recon_link_days', 'erp', '对账确认链接有效', n('天'), 'V10；供应商只能回一次');
  tun('ar_overdue_days', 'erp', '应收提醒', (v: number) => `超过 ${v} 天没回`, 'V14；协议单位挂账、平台回款');
  tun('expiry_remind_days', 'inventory', '批次临期提醒', (v: number) => `到期前 ${v} 天`, 'V18');
  tun('wecom_weekly_push', 'erp', '每周一推企业微信', (v: boolean) => (v ? '推送（机器人地址在服务器 .env）' : '不推'), 'V19、V20；每周一 9:00');
  // ── 岗位与权限 ──
  const changed = overrideCount(overrides);
  add({
    key: 'role_permissions', group: 'staff', label: '岗位权限', value: changed ? `在默认基础上调整了 ${changed} 处` : '按默认', defaultValue: '按默认',
    pending: true, section: 'permissions', hint: '店主一栏固定拥有全部权限', current: changed, dflt: 0, metaKey: 'role_permissions',
  });
  return entries;
}

const CHANGE_ACTIONS = [
  'settings_updated',
  'inventory_settings_updated',
  'plan_saved',
  'item_saved',
  'price_list_imported',
  'ticket_type_saved',
  'staff_created',
  'staff_updated',
  'hand_tags_created',
  'hand_tags_imported',
  'opening_imported',
  'opening_voided',
  'technician_saved',
  'items_technician_updated',
  'kitchen_station_saved',
  'items_station_updated',
  'room_type_saved',
  'room_saved',
  'space_saved',
  'space_zone_saved',
  'space_import',
  'location_reader_saved',
  'items_zone_updated',
];

const SETTING_LABELS: Record<string, string> = {
  storeName: '门店名称',
  deductionRule: '扣款顺序',
  businessDayStartHour: '营业日切换时间',
  maxRechargeCents: '单笔充值上限',
  maxConsumeCents: '单笔消费上限',
  rechargeSpendPct: '充值当日的储值消费上限',
  countCardSales: '次卡售卖',
  reversalWindowHours: '撤销与反结账时限',
  businessHours: '营业时间',
  customBonusValidDays: '自定义赠金有效期',
  requireOpenShift: '收款前必须先开班',
  shiftMode: '交班方式',
  cashDrawers: '钱箱',
  hidePendingMarks: '「待确认」标记',
  memberChannels: '渠道来源',
};

function describeChange(action: string, detail: Record<string, unknown>): string {
  const name = (detail.name ?? detail.displayName ?? detail.username) as string | undefined;
  switch (action) {
    case 'settings_updated': {
      if (detail.key === 'frontdesk_rules') return '修改了前台规则';
      if (detail.key === 'vip_locker_rules') return '修改了 VIP 柜设置（会员权益）';
      if (detail.key === 'role_permissions') return '调整了岗位权限';
      if (detail.key === 'technician_rules') return '修改了技师规则';
      if (detail.key === 'clockroom_rules') return '修改了钟房与轮钟规则';
      if (detail.key === 'commission_rules') return '修改了技师提成规则';
      if (detail.key === 'dining_rules') return '修改了餐饮规则';
      if (detail.key === 'room_rules') return '修改了客房规则';
      if (detail.key === 'location_rules') return '修改了实时位置的开关与区域';
      if (detail.key === 'usage_rules') return '修改了开单即占用的业态';
      if (detail.key === 'booking_rules') return '修改了预约规则';
      if (detail.key === 'guide_rules') return '修改了对客导览的设置';
      const after = (detail.after ?? {}) as Record<string, unknown>;
      const keys = Object.keys(after).map((x) => SETTING_LABELS[x] ?? x);
      return keys.length ? `修改了${keys.join('、')}` : '修改了经营规则';
    }
    case 'inventory_settings_updated':
      return '修改了库存与采购规则';
    case 'plan_saved':
      return `保存了充值套餐${name ? `「${name}」` : ''}`;
    case 'item_saved':
      return `保存了项目${name ? `「${name}」` : ''}`;
    case 'price_list_imported':
      return '导入了价目表';
    case 'ticket_type_saved':
      return `保存了票种${name ? `「${name}」` : ''}`;
    case 'staff_created':
      return `新建员工账号${name ? `「${name}」` : ''}`;
    case 'staff_updated':
      return `修改了员工账号${name ? `「${name}」` : ''}`;
    case 'hand_tags_created':
      return '按号段建了手牌';
    case 'hand_tags_imported':
      return '导入了柜号清单';
    case 'opening_imported':
      return '导入了期初余额';
    case 'opening_voided':
      return '作废了期初余额';
    case 'technician_saved':
      return typeof detail.summary === 'string' ? detail.summary : `保存了技师${name ? `「${name}」` : ''}`;
    case 'items_technician_updated':
      return '调整了需要技师的项目';
    case 'kitchen_station_saved':
      return typeof detail.summary === 'string' ? detail.summary : '保存了出品档口';
    case 'items_station_updated':
      return '调整了菜品的出品档口';
    case 'room_type_saved':
      return typeof detail.summary === 'string' ? detail.summary : '保存了房型';
    case 'room_saved':
      return typeof detail.summary === 'string' ? detail.summary : '保存了房间';
    case 'space_saved':
      return typeof detail.summary === 'string' ? detail.summary : '修改了空间台账';
    case 'space_zone_saved':
      return typeof detail.summary === 'string' ? detail.summary : '修改了楼层或区域';
    case 'space_import':
      return typeof detail.summary === 'string' ? detail.summary : '导入了空间台账';
    case 'location_reader_saved':
      return typeof detail.summary === 'string' ? detail.summary : '保存了刷卡点';
    case 'items_zone_updated':
      return '调整了项目所在区域（实时位置）';
    default:
      return action;
  }
}

export async function adminOverview(db: Db, deps: Deps, actor: Actor): Promise<AdminOverview> {
  const s = await loadSettings(db);
  const [c] = await db<
    { staffActive: number; members: number; membersNewToday: number; items: number; plans: number; tickets: number; tagsActive: number; tagsLocked: number; tagsInactive: number; techniciansActive: number }[]
  >`
    SELECT (SELECT count(*) FROM staff WHERE active)::int AS staff_active,
           (SELECT count(*) FROM members)::int AS members,
           (SELECT count(*) FROM members WHERE created_at >= now() - interval '1 day')::int AS members_new_today,
           (SELECT count(*) FROM service_items WHERE active)::int AS items,
           (SELECT count(*) FROM recharge_plans WHERE active)::int AS plans,
           (SELECT count(*) FROM ticket_types WHERE active)::int AS tickets,
           (SELECT count(*) FROM hand_tags WHERE active)::int AS tags_active,
           (SELECT count(*) FROM hand_tags WHERE active AND locked)::int AS tags_locked,
           (SELECT count(*) FROM hand_tags WHERE NOT active)::int AS tags_inactive,
           (SELECT count(*) FROM technicians WHERE active)::int AS technicians_active`;
  const byRole = await db<{ role: Role; n: number }[]>`SELECT role, count(*)::int AS n FROM staff WHERE active GROUP BY role`;
  const rules = await ruleCatalog(db);
  let recentChanges: AdminOverview['recentChanges'] = null;
  if (can(actor, 'audit.read')) {
    const rows = await db<{ createdAt: string; staffName: string | null; action: string; detail: Record<string, unknown> }[]>`
      SELECT a.created_at, s.display_name AS staff_name, a.action, a.detail
      FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id
      WHERE a.action IN ${db(CHANGE_ACTIONS)} ORDER BY a.id DESC LIMIT 8`;
    recentChanges = rows.map((r) => ({ at: new Date(r.createdAt).toISOString(), staffName: r.staffName, action: r.action, summary: describeChange(r.action, r.detail ?? {}) }));
  }
  return {
    store: {
      name: s.storeName,
      instance: deps.config.instance,
      version: deps.config.version,
      commit: deps.config.commit,
      timezone: deps.config.timezone,
      businessDayStartHour: s.businessDayStartHour,
      businessHours: describeBusinessHours(s.businessHours),
    },
    counts: {
      staffActive: c!.staffActive,
      staffByRole: Object.fromEntries(byRole.map((r) => [r.role, r.n])),
      members: c!.members,
      membersNewToday: c!.membersNewToday,
      items: c!.items,
      plans: c!.plans,
      tickets: c!.tickets,
      tags: { active: c!.tagsActive, locked: c!.tagsLocked, inactive: c!.tagsInactive },
      technicians: { active: c!.techniciansActive, enabled: (await loadTechnicianRules(db)).enabled },
    },
    rules: { total: rules.length, changed: rules.filter((r) => !r.isDefault).length, pending: rules.filter((r) => r.pending && r.isDefault).length },
    recentChanges,
  };
}

export async function permissionMatrix(db: Db): Promise<RolePermissionMatrix> {
  const overrides = await loadRoleOverrides(db);
  const [meta] = await db<{ updatedAt: string; updatedBy: string | null }[]>`
    SELECT s.updated_at, st.display_name AS updated_by FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = 'role_permissions'`;
  const staff = await db<{ role: Role; n: number }[]>`SELECT role, count(*)::int AS n FROM staff WHERE active GROUP BY role`;
  const per = (f: (r: Role, p: Permission) => boolean) => Object.fromEntries(ROLES.map((r) => [r, ALL_PERMISSIONS.filter((p) => f(r, p))])) as Record<Role, Permission[]>;
  return {
    overrides,
    effective: per((r, p) => roleHas(r, p, overrides)),
    defaults: per((r, p) => (r === 'owner' ? true : !LOCKED_PERMISSIONS.includes(p) && roleDefault(r, p))),
    updatedAt: meta ? new Date(meta.updatedAt).toISOString() : null,
    updatedBy: meta?.updatedBy ?? null,
    staffCount: Object.fromEntries(staff.map((x) => [x.role, x.n])),
  };
}

const PermissionInput = z.object({
  roles: z.partialRecord(z.enum(EDITABLE_ROLES), z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]], '有不认识的权限，请刷新页面后重试')).max(ALL_PERMISSIONS.length)),
});

export function registerAdminRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/admin/overview', { preHandler: guardAny(...ADMIN_PERMISSIONS) }, async (req) => adminOverview(sql, deps, req.actor));

  app.get('/api/admin/rules', { preHandler: guardAny('settings.manage', 'audit.read') }, async () => ruleCatalog(sql));

  app.get('/api/admin/permissions', { preHandler: guardAny('settings.manage', 'audit.read') }, async () => permissionMatrix(sql));

  // 提交各岗位应有的权限（只提交要改的岗位）；存为相对默认规则的增减，店主专属的权限不能授出
  app.put('/api/admin/permissions', { preHandler: guard('settings.manage') }, async (req) => {
    const { roles } = parse(PermissionInput, req.body);
    for (const [role, list] of Object.entries(roles)) {
      const locked = list?.find((p) => LOCKED_PERMISSIONS.includes(p));
      if (locked) throw badRequest(`「${PERMISSION_LABELS[locked]}」只属于店主，不能授给${ROLE_LABELS[role as Role]}`);
    }
    await sql.begin(async (tx) => {
      await lockSettings(tx);
      const before = await loadRoleOverrides(tx);
      const target = Object.fromEntries(
        EDITABLE_ROLES.map((r) => [r, roles[r] ?? ALL_PERMISSIONS.filter((p) => roleHas(r, p, before))]),
      ) as Record<(typeof EDITABLE_ROLES)[number], Permission[]>;
      const after = overridesFrom(target);
      await tx`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('role_permissions', ${tx.json(after as never)}, now(), ${req.actor.id})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'settings_updated',
        targetType: 'settings',
        detail: { key: 'role_permissions', before, after },
        ip: req.ip,
      });
    });
    return permissionMatrix(sql);
  });
}
