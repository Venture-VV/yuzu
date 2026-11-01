// 管理后台（v0.6.0）：后台首页、规则总表、岗位权限。
// 规则总表把散在各处的设置（门店与营业、储值、会员、前台、库存、岗位权限）列在一张表里：当前值、默认值、
// 是否改过、最近谁改的、去哪里改；只读，修改仍走各自的接口（每次修改都记审计）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADMIN_PERMISSIONS, type AdminOverview, type RolePermissionMatrix, type RuleEntry } from '@shared/admin';
import { describeBusinessHours } from '@shared/business-date';
import { DEFAULT_FRONTDESK_RULES, VIP_LEVEL_BASIS_LABELS, type FrontdeskRules } from '@shared/frontdesk';
import { APPROVAL_RULE_LABELS, type ApprovalRules } from '@shared/inventory';
import { DEDUCTION_RULE_LABELS, describeHours, ROLE_LABELS } from '@shared/labels';
import { levelName } from '@shared/members';
import { CALL_TYPE_LABELS, DEFAULT_TECHNICIAN_RULES } from '@shared/technicians';
import { AFTER_DESIGNATED_LABELS, AFTER_ROTATION_LABELS, DEFAULT_CLOCKROOM_RULES, DEFAULT_COMMISSION_RULES, describeCommissionBase } from '@shared/clockroom';
import { DEFAULT_DINING_RULES } from '@shared/dining';
import { DEFAULT_ROOM_RULES } from '@shared/rooms';
import { formatYuan } from '@shared/money';
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
import { guard, guardAny } from '../auth/guard';
import { loadRoleOverrides } from '../auth/role-permissions';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { badRequest } from '../lib/errors';
import { parse } from '../lib/validate';
import { loadFrontdeskRules } from './frontdesk/common';
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
import { commissionSettings } from './commission';
import { loadDiningRules } from './dining';
import { loadRoomRules } from './rooms';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const onOff = (v: boolean, on: string, off: string) => (v ? on : off);
const yuanList = (cents: number[]) => cents.map((c, i) => `第 ${i + 1} 级 ≥ ${formatYuan(c)}`).join('，');
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
  const fields = (list: typeof s.memberFields) => (list.length ? `${list.length} 个（启用 ${list.filter((f) => f.active).length} 个）：${list.map((f) => f.label).join('、')}` : '没有自定义字段');
  const channels = (list: typeof s.memberChannels) => {
    const on = list.filter((c) => c.active).map((c) => c.label);
    return `${on.join('、') || '没有启用的渠道'}${list.length > on.length ? `（另有 ${list.length - on.length} 个已停用）` : ''}`;
  };
  const names = (r: FrontdeskRules) => r.vipLevelThresholds.map((_, i) => levelName(i + 1, r.vipLevelNames)).join('、');

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
  add({
    key: 'reversal_window_hours', group: 'wallet', label: '撤销与反结账时限', value: window(s.reversalWindowHours), defaultValue: window(d.reversalWindowHours),
    pending: false, section: 'rules', hint: '超过后只有店主可以', current: s.reversalWindowHours, dflt: d.reversalWindowHours, metaKey: sk('reversalWindowHours'),
  });
  add({
    key: 'require_open_shift', group: 'wallet', label: '收款前必须先开班', value: onOff(s.requireOpenShift, '必须先开班', '不要求'), defaultValue: '必须先开班',
    pending: false, section: 'rules', current: s.requireOpenShift, dflt: d.requireOpenShift, metaKey: sk('requireOpenShift'),
  });
  add({
    key: 'custom_bonus_valid_days', group: 'wallet', label: '自定义赠金有效期', value: days(s.customBonusValidDays), defaultValue: days(d.customBonusValidDays),
    pending: true, section: 'rules', hint: '套餐的赠金有效期在「价目与套餐」里设置', current: s.customBonusValidDays, dflt: d.customBonusValidDays, metaKey: sk('customBonusValidDays'),
  });
  // ── 会员与渠道 ──
  add({ key: 'member_channels', group: 'members', label: '渠道来源', value: channels(s.memberChannels), defaultValue: channels(d.memberChannels), pending: true, section: 'members', current: s.memberChannels, dflt: d.memberChannels, metaKey: sk('memberChannels') });
  add({ key: 'member_fields', group: 'members', label: '会员自定义字段', value: fields(s.memberFields), defaultValue: fields(d.memberFields), pending: false, section: 'members', current: s.memberFields, dflt: d.memberFields, metaKey: sk('memberFields') });
  add({
    key: 'frontdesk_rules.vipLevelBasis', group: 'members', label: '会员等级口径', value: VIP_LEVEL_BASIS_LABELS[fd.vipLevelBasis], defaultValue: VIP_LEVEL_BASIS_LABELS[fdd.vipLevelBasis],
    pending: true, section: 'members', hint: 'VIP 柜也按它核对', current: fd.vipLevelBasis, dflt: fdd.vipLevelBasis, metaKey: 'frontdesk_rules',
  });
  add({
    key: 'frontdesk_rules.vipLevelThresholds', group: 'members', label: '各级门槛', value: yuanList(fd.vipLevelThresholds), defaultValue: yuanList(fdd.vipLevelThresholds),
    pending: true, section: 'members', current: fd.vipLevelThresholds, dflt: fdd.vipLevelThresholds, metaKey: 'frontdesk_rules',
  });
  add({ key: 'frontdesk_rules.vipLevelNames', group: 'members', label: '各级名称', value: names(fd), defaultValue: names(fdd), pending: true, section: 'members', current: names(fd), dflt: names({ ...fdd, vipLevelThresholds: fd.vipLevelThresholds }), metaKey: 'frontdesk_rules' });
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
  add({
    key: 'frontdesk_rules.vipOverrideEnabled', group: 'frontdesk', label: '当场授权使用 VIP 柜', value: onOff(fd.vipOverrideEnabled, '允许（值班经理及以上授权）', '不允许'), defaultValue: '不允许',
    pending: true, section: 'tags', current: fd.vipOverrideEnabled, dflt: fdd.vipOverrideEnabled, metaKey: 'frontdesk_rules',
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
  // ── 库存与采购 ──
  add({ key: 'inventory_scope_name', group: 'inventory', label: '库存范围', value: inv.scopeName, defaultValue: '后勤总库', pending: true, section: 'rules', current: inv.scopeName, dflt: '后勤总库', metaKey: 'inventory_scope_name' });
  // 迁移 002 写入的初始口径
  const basis = '含税到货价（模拟口径，待确认）';
  add({ key: 'inventory_price_basis', group: 'inventory', label: '价格口径', value: inv.priceBasis, defaultValue: basis, pending: true, section: 'rules', current: inv.priceBasis, dflt: basis, metaKey: 'inventory_price_basis' });
  add({
    key: 'inventory_urgent_cap_cents', group: 'inventory', label: '急采上限', value: `每张急采单不超过 ${formatYuan(inv.urgentCapCents)}`,
    defaultValue: `每张急采单不超过 ${formatYuan(DEFAULT_URGENT_CAP_CENTS)}`, pending: true, section: 'rules',
    hint: '没有采购单的收货只能登记急采：进部门小仓，仓库验收后生效，部门补采购单', current: inv.urgentCapCents, dflt: DEFAULT_URGENT_CAP_CENTS, metaKey: 'inventory_urgent_cap_cents',
  });
  add({
    key: 'inventory_approval_rules', group: 'inventory', label: '需要负责人确认的单据', value: approvals(inv.approvalRules), defaultValue: approvals(DEFAULT_APPROVAL_RULES),
    pending: true, section: 'rules', current: inv.approvalRules, dflt: DEFAULT_APPROVAL_RULES, metaKey: 'inventory_approval_rules',
  });
  const threshold = (c: number) => (c > 0 ? `${formatYuan(c)} 以内不用负责人确认` : '全部要负责人确认');
  add({
    key: 'inventory_approval_threshold_cents', group: 'inventory', label: '免确认门槛', value: threshold(inv.approvalThresholdCents),
    defaultValue: threshold(DEFAULT_APPROVAL_THRESHOLD_CENTS), pending: true, section: 'rules',
    hint: '采购单、报损、退供应商、付款、期初在设为需要确认时，金额不超过门槛的提交即生效；总仓盘点调整照旧要确认',
    current: inv.approvalThresholdCents, dflt: DEFAULT_APPROVAL_THRESHOLD_CENTS, metaKey: 'inventory_approval_threshold_cents',
  });
  add({
    key: 'inventory_usage_window_days', group: 'inventory', label: '可用天数的用量统计', value: `按近 ${inv.usageWindowDays} 天的用量`,
    defaultValue: `按近 ${DEFAULT_USAGE_WINDOW_DAYS} 天的用量`, pending: true, section: 'rules',
    hint: '物料设了提醒天数时，可用天数 = 结存 ÷ 这段时间的日均用量，少于提醒天数就提醒',
    current: inv.usageWindowDays, dflt: DEFAULT_USAGE_WINDOW_DAYS, metaKey: 'inventory_usage_window_days',
  });
  // 称重与盘点、对账提醒（#14、#23，v0.7.13）：存成一条 inventory_cycle_rules
  const cyc = DEFAULT_CYCLE_RULES;
  add({
    key: 'inventory_cycle_rules.weighTolerancePct', group: 'inventory', label: '称重收货容差', value: `可以比采购单多 ${inv.weighTolerancePct}%`,
    defaultValue: `可以比采购单多 ${cyc.weighTolerancePct}%`, pending: true, section: 'rules',
    hint: '物料设为称重的，按实际称重收货，可以比采购单这一行的订购数量多出这么多；货款按实收重量算',
    current: inv.weighTolerancePct, dflt: cyc.weighTolerancePct, metaKey: 'inventory_cycle_rules',
  });
  const stText = (d: number, g: number) => `每月 ${d} 号起提醒，过 ${g} 天没盘完标红`;
  add({
    key: 'inventory_cycle_rules.stocktake', group: 'inventory', label: '每月盘点提醒', value: stText(inv.stocktakeDay, inv.stocktakeGraceDays),
    defaultValue: stText(cyc.stocktakeDay, cyc.stocktakeGraceDays), pending: true, section: 'rules',
    hint: '每个仓按「月初有结存的物料本月都在盘点单里盘到」算盘完；部门小仓的台面日耗品不用清点',
    current: [inv.stocktakeDay, inv.stocktakeGraceDays], dflt: [cyc.stocktakeDay, cyc.stocktakeGraceDays], metaKey: 'inventory_cycle_rules',
  });
  const rcText = (d: number, g: number, b: number) => `月结：每月 ${d} 号起提醒对上个月的账，过 ${g} 天标红；按批次：收货后 ${b} 天标红`;
  add({
    key: 'inventory_cycle_rules.recon', group: 'inventory', label: '供应商对账提醒', value: rcText(inv.monthlyReconDay, inv.monthlyReconGraceDays, inv.batchReconGraceDays),
    defaultValue: rcText(cyc.monthlyReconDay, cyc.monthlyReconGraceDays, cyc.batchReconGraceDays), pending: true, section: 'rules',
    hint: '挂账供应商在档案里选「月结」或「按批次」；对完账在「货款 → 对账」登记',
    current: [inv.monthlyReconDay, inv.monthlyReconGraceDays, inv.batchReconGraceDays],
    dflt: [cyc.monthlyReconDay, cyc.monthlyReconGraceDays, cyc.batchReconGraceDays], metaKey: 'inventory_cycle_rules',
  });
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
];

const SETTING_LABELS: Record<string, string> = {
  storeName: '门店名称',
  deductionRule: '扣款顺序',
  businessDayStartHour: '营业日切换时间',
  maxRechargeCents: '单笔充值上限',
  maxConsumeCents: '单笔消费上限',
  reversalWindowHours: '撤销与反结账时限',
  businessHours: '营业时间',
  memberFields: '会员自定义字段',
  customBonusValidDays: '自定义赠金有效期',
  requireOpenShift: '收款前必须先开班',
  hidePendingMarks: '「待确认」标记',
  memberChannels: '渠道来源',
};

function describeChange(action: string, detail: Record<string, unknown>): string {
  const name = (detail.name ?? detail.displayName ?? detail.username) as string | undefined;
  switch (action) {
    case 'settings_updated': {
      if (detail.key === 'frontdesk_rules') return '修改了前台规则与会员等级';
      if (detail.key === 'role_permissions') return '调整了岗位权限';
      if (detail.key === 'technician_rules') return '修改了技师规则';
      if (detail.key === 'clockroom_rules') return '修改了钟房与轮钟规则';
      if (detail.key === 'commission_rules') return '修改了技师提成规则';
      if (detail.key === 'dining_rules') return '修改了餐饮规则';
      if (detail.key === 'room_rules') return '修改了客房规则';
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
      await tx`SELECT pg_advisory_xact_lock(hashtext('settings'))`;
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
