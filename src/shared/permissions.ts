// 岗位与职责权限（默认规则，待店主确认）。
// 所有接口与页面都从这里判断权限。
//
// 岗位决定会员业务权限；库存与采购权限来自可叠加的「职责」，一人可兼任多项。
// 增加库存职责不会带来会员钱包、充值撤销或全店财务查看权限。
// 「值班经理」「店总」为 2026-10-27 店主答复新增的内置岗位（#29）；「客户经理」为 v0.6.0 新增（储值会员的开发与维护），默认权限待确认。
// v0.6.0 起店主可以在管理后台按岗位增减权限（存为相对默认的增减，settings.role_permissions）：
// 店主一栏固定拥有全部权限；LOCKED_PERMISSIONS 只属于店主，不能授给其他岗位；库存职责的权限不在后台调整。
// v0.7.0 新增「维护技师名册」「看技师业绩」，默认值待确认。
// v0.7.3 ERP 独立工作区：库存、采购、货款的权限归入「ERP」一组；新增「ERP：看营业数据（只读）」，
// 默认店主与店总（职责不带：增加库存职责仍不会带来全店财务查看权限）。
// v0.7.17 新增「看实时位置」「上报位置」（第一级实时位置），默认值待确认。
// v0.7.19 新增「看对客导览」（区域导览图与大屏轮播，没有经营数据），默认所有岗位，待确认。
// v0.7.20 新增「开退款单」（离店后部分退款）与券的三项权限（维护券模板与规则、发券给会员、作废券），默认值待确认。
// v0.7.21 新增设备的三项权限（看设备状态、测试打印、维护设备；飞书需求 RQ-001），默认值待确认。
// v0.7.28 新增「打印单据到小票机」（业务单据网口打印与断网打印队列，N7），默认前台岗位，待确认。
// v0.7.23 会员体系 v2 第一期：新增「修改会员规则」「手动调整会员档阶」「看会员体系看板与到期提醒」「他店查询」，
// 以及岗位「他店查询」（另一家店的同事只读查会员档阶，docs/MEMBERSHIP.md 第 8、11 节），默认值待确认。
// v0.7.24 会员体系 v2 第二期：新增「维护会员权益」（导入本店权益清单、修改、发布、暂缓）与「登记权益使用」（docs/BENEFITS.md），默认值待确认。
// 2026-11-03 微信小程序（小程序线）新增「维护小程序内容」「解绑会员的微信」（MP7，docs/MINIPROGRAM.md 第 5 节）；
// 店主 11-03 已定：维护小程序内容只给店主、店总（客户经理不给）。
// v0.7.30 审批中心：新增「审批中心：审批」「审批中心：维护审批规则」（docs/APPROVALS.md，默认值待确认）。
// v0.7.31 合同与法务审查：新职责「法务」（单独一组），新增「查看合同」「维护合同」（docs/CONTRACTS.md C4、C12，待确认）。
// 8.0.4 会员体系整改：新增「营销成本测算」（docs/MEMBERSHIP_V804.md 第 10 节，HY14）：默认店主、店总；
// 与财务隔离——有财务职责（对账付款、成本核算）的账号一律没有，后台岗位权限加了也不生效（店主除外，FINANCE_EXCLUDED）。
// 8.0.10 点餐系统 · 平板电子菜单（docs/EMENU.md，DC1、DC16 待确认）：新岗位「点餐平板」（放在餐桌上的平板登录用，只能打开点餐页），
// 新增「打开平板点餐」「维护电子菜单」。平板上确认下单的服务员照旧要「餐饮点单」+「前台挂账」（凭点单密码认人）。
// 8.1.1 UI 工作台（docs/WORKBENCH_V811.md 第 6 节）：新岗位「设计师」（只进工作台），新增「工作台：编辑」「工作台：发布」；
// 店主 2026-11-15 定设计师可以发布（GZ3）：两项默认给店主与设计师，别的岗位要的在后台「岗位权限」里加。
// 8.1.15《浴族系统需求汇总》块 A（docs/FRONTDESK_RISK_V8115.md，FK1 待确认）：新增「维护黑名单」与「前台风控的当场授权」，默认值班经理及以上。
// 8.1.15《浴族系统需求汇总》块 B（docs/DINING_V8115.md，ZT 待确认）：新增「在餐厅 / 水吧 / 果吧下单」三项（原来有「餐饮点单」的岗位三项都有）、
// 新职责「康美部」（默认有「餐饮点单」与水吧、果吧两项，没有餐厅；不和别的职责分组互斥）。
// 8.1.15 菜品管理（docs/DISHES_V8115.md，CP6、CP7 待确认）：新增「菜品管理：维护餐厅 / 水吧 / 果吧的菜品」三项与「定价与改价」一项，
// 默认店主、店总；厨房主管、水吧主管要维护自己那一处的，在后台「岗位权限」里加。
// 8.1.17 退菜按出品口（docs/FRONTDESK_V8117.md 第 2 节，BW4 待确认）：新增「退菜：餐厅 / 水吧 / 果吧」三项——原来能退菜（有「前台挂账」）的岗位三项都有，
// 康美部默认有水吧、果吧两项（康美部自己退菜）；餐饮的菜按这道菜所在的出品口核对，别的明细照旧要「前台挂账」。
// 8.1.18 组织架构与岗位（docs/POSITIONS_V8118.md，GW1–GW9）：新建账号改成「部门 → 岗位（负责人 / 员工）」，
// 权限按岗位模板（src/shared/positions.ts）算；员工档案里有岗位（position）的按岗位，没有的（还没重新选岗的老账号、
// 点餐平板 / 他店查询 / 设计师这几种专用账号）照旧按下面的旧岗位规则。新增「管理本部门员工账号」（staff.dept）。

import { applyAdjust, positionDefaults, type PermissionAdjust, type PositionKey, type PositionOverrides } from './positions';

export const ROLES = ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk', 'backoffice', 'other_store', 'tablet', 'designer'] as const;
export type Role = (typeof ROLES)[number];

export const DUTIES = ['stock', 'purchase', 'payable', 'approve', 'cost', 'request', 'legal', 'concierge', 'concierge_manager', 'kangmei'] as const;
export type Duty = (typeof DUTIES)[number];

/**
 * 分岗不兼任（#17 后半句，v0.7.12）：职责分五组，一名员工的职责只能在一组里；财务组内对账付款、成本核算可以同时有。
 * 店主不受限制。后台保存员工时校验；已有跨组的员工不自动改，后台员工页提示（不进自检）。
 */
export const DUTY_GROUPS: { key: 'stock' | 'purchase' | 'department' | 'finance' | 'approve' | 'legal' | 'concierge'; label: string; duties: readonly Duty[] }[] = [
  { key: 'stock', label: '仓库', duties: ['stock'] },
  { key: 'purchase', label: '采购', duties: ['purchase'] },
  { key: 'department', label: '部门', duties: ['request'] },
  { key: 'finance', label: '财务（含成本）', duties: ['payable', 'cost'] },
  { key: 'approve', label: '负责人', duties: ['approve'] },
  // 法务（v0.7.31，C4）：合同审查的法务那一级，不和别的职责兼任
  { key: 'legal', label: '法务', duties: ['legal'] },
  { key: 'concierge', label: '管家部', duties: ['concierge', 'concierge_manager'] },
];

/** 职责跨组时返回涉及的组名（如「仓库、采购」），不跨组返回 null；店主不受限制 */
export function dutyConflict(role: Role, duties: readonly Duty[]): string | null {
  if (role === 'owner') return null;
  const groups = DUTY_GROUPS.filter((g) => g.duties.some((d) => duties.includes(d)));
  return groups.length > 1 ? groups.map((g) => g.label).join('、') : null;
}

export interface PermissionSubject {
  role: Role;
  duties?: readonly Duty[];
  /** 已按后台的岗位权限算好的权限（登录会话、授权人都带）；没有时按默认规则判断 */
  permissions?: readonly Permission[];
}

interface Rule {
  roles: readonly Role[];
  duties?: readonly Duty[];
}

export const PERMISSIONS = {
  'customer.read': { roles: ['owner', 'store_manager', 'account_manager'] },
  'customer.operate': { roles: ['owner', 'store_manager', 'account_manager'] },
  'customer.manage': { roles: ['owner', 'store_manager'] },
  'concierge.read': { roles: ['owner', 'store_manager'], duties: ['concierge', 'concierge_manager'] },
  'concierge.operate': { roles: ['owner', 'store_manager'], duties: ['concierge', 'concierge_manager'] },
  'concierge.manage': { roles: ['owner', 'store_manager'], duties: ['concierge_manager'] },
  'concierge.export': { roles: ['owner', 'store_manager'], duties: ['concierge_manager'] },
  // ── 会员与储值 ──
  'member.read': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  'member.write': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  'recharge.create': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  /** 不按档级比例、手动填写赠金（会员体系 v2 起赠金按充值后所在档的比例自动算） */
  'recharge.customBonus': { roles: ['owner', 'store_manager'] },
  'consume.create': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 不在项目列表里的手动金额 */
  'consume.customAmount': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  'consume.reverse': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 当前营业日的流水与日结汇总 */
  'ledger.readToday': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  /** 历史营业日的流水与日结 */
  'ledger.readHistory': { roles: ['owner', 'store_manager', 'duty_manager'] },
  'ledger.export': { roles: ['owner', 'store_manager', 'duty_manager'] },
  'settlement.close': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 导入旧系统（EBC）的会员余额作为期初，作废导入错误的期初 */
  'wallet.opening': { roles: ['owner'] },
  // ── 会员体系（v0.7.23，docs/MEMBERSHIP.md 第 11 节，默认值待确认）──
  /** 修改会员规则：档名、充值门槛、赠送比例、享 / 尊阶比例、会籍周期与补充期、首充 / 续充最低、到期提醒、VIP 柜对应 */
  'member.rules': { roles: ['owner', 'store_manager'] },
  /** 手动调整会员档阶（写原因，留记录） */
  'member.adjust': { roles: ['owner'] },
  // 会员体系收尾（v0.7.26）：退储值（店员及以上发起，店主或店总当场授权）、停用 / 启用、改手机号、合并
  'member.refund': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  'member.status': { roles: ['owner', 'store_manager'] },
  'member.phone': { roles: ['owner', 'store_manager', 'duty_manager'] },
  'member.merge': { roles: ['owner', 'store_manager'] },
  /** 次卡（v0.7.28，N5 待确认）：售卡是收款，前台岗位都能做（与充值一样）；退卡退钱，店主、店总、值班经理 */
  'countcard.sell': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  'countcard.refund': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 会员实体卡（v0.7.28，N8 待确认：前台岗位与客户经理）：发卡、挂失、补卡 */
  'member.card': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  /** 平台核销补录（v0.7.28，N6 待确认）：前台岗位都能补登记；作废要值班经理以上；平台打款与对账店主、店总 */
  'platform.redeem': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  'platform.void': { roles: ['owner', 'store_manager', 'duty_manager'] },
  'platform.settle': { roles: ['owner', 'store_manager'] },
  /** 看会员体系看板、到期提醒名单与补充期名单（客户经理按名单联系客人） */
  'member.retention': { roles: ['owner', 'store_manager', 'account_manager'] },
  /** 他店查询：按手机号或会员号查一位会员的档阶与会籍（只读，不含余额与流水） */
  'member.lookup': { roles: ['other_store'] },
  // ── 会员权益（v0.7.24，docs/BENEFITS.md，默认值待确认）──
  /** 维护会员权益：导入本店权益清单，改起点、数量、券模板，发布、暂缓；作废别人登记的使用 */
  'benefit.publish': { roles: ['owner', 'store_manager'] },
  /** 登记服务类权益的使用（会员详情「本月可享」），作废自己当天登记错的 */
  'benefit.use': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk'] },
  // ── 前台手牌与共同账单 ──
  /** 查看在店手牌状态板与手牌账单 */
  'frontdesk.read': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 接待发牌、同行绑牌、挂账、换牌、锁定异常手牌；本人刚登记的明细可在规定时间内自行作废 */
  'frontdesk.operate': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 作废他人或超时的明细、撤销他人或超时开的牌 */
  'frontdesk.correct': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 维护手牌池：批量建牌、改分区、解锁、停用 */
  'frontdesk.tags': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 结账收款（单牌或同行合并）、登记团购券；用会员储值支付还需要「登记消费扣款」 */
  'frontdesk.checkout': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 反结账：撤销一张结账单，账单恢复为在店未结（待确认：默认值班经理及以上） */
  'frontdesk.checkoutVoid': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 按纸质应急单上的实际时间补录接待、挂账与结账（R1.9，待确认：默认值班经理及以上；收银员不能，避免把时间往前填少收门票） */
  'frontdesk.backfill': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 开退款单：结账后按项部分退款、作废当班登记错的退款单（v0.7.20，飞书 RQ-006，待确认：默认值班经理及以上；超过撤销时限只有店主） */
  'frontdesk.refund': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 结账时挂账到协议单位（8.0.7 A3，V12 待确认：店主、店总、值班经理） */
  'frontdesk.onAccount': { roles: ['owner', 'store_manager', 'duty_manager'] },
  // ── 券与会员权益（v0.7.20，飞书 RQ-006；docs/COUPONS.md，默认值待确认）──
  /** 维护券模板、发券规则（开卡礼、升级礼、生日礼、充值赠券），生成与导出无记名纸质券、按批次作废没用的 */
  'coupon.manage': { roles: ['owner', 'store_manager'] },
  /** 手动发券给会员 */
  'coupon.issue': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager'] },
  /** 作废会员没用过的券（含已过期的） */
  'coupon.void': { roles: ['owner', 'store_manager'] },
  // ── 库存与采购 ──
  /** 查看库存数量、物料档案与库存单据 */
  'inventory.read': { roles: ['owner'], duties: ['stock', 'purchase', 'payable', 'approve', 'cost'] },
  /** 期初录入、收货、领用、退回、直接耗用、报损申请、盘点录入 */
  // 8.0.20 成本核算（docs/ERP_V8020.md 第 1 节）：库存金额、耗用成本、项目毛利、用料的理论成本
  'inventory.cost': { roles: ['owner', 'store_manager'], duties: ['cost', 'payable', 'approve'] },
  'inventory.operate': { roles: ['owner'], duties: ['stock'] },
  /** 物料、供应商、部门档案 */
  'inventory.master': { roles: ['owner'], duties: ['purchase'] },
  /** 采购单 */
  'purchase.manage': { roles: ['owner'], duties: ['purchase'] },
  /** 采购规则（途径、询价门槛、截单、急采分级审批……）：8.0.1 采购组整改 01（CG01），默认只有店主，可在岗位权限里下放给采购 */
  'purchase.rules': { roles: ['owner'] },
  /** 退供应商申请（仓库或采购均可发起） */
  'supplierReturn.create': { roles: ['owner'], duties: ['stock', 'purchase'] },
  /** 登记供应商对退货的答复（同意 → 退货生效；不同意 → 撤回），采购与供应商沟通（#20，v0.7.12） */
  'supplierReturn.answer': { roles: ['owner'], duties: ['purchase'] },
  /** 查看供应商货款、付款与对账 */
  // 成本核算要冲销付款、期初未付（#21，v0.7.11），能看货款
  'payable.read': { roles: ['owner'], duties: ['purchase', 'payable', 'approve', 'cost'] },
  /** 期初未付、付款登记 */
  'payable.manage': { roles: ['owner'], duties: ['payable'] },
  /** 负责人确认：采购、报损、盘点调整、退货、付款、期初（v0.7.11 起冲销按 #21 分工，见下面两项） */
  'inventory.approve': { roles: ['owner'], duties: ['approve'] },
  /** 冲销库存单据（#21：仓库或财务成本岗；只限当月，v0.7.11） */
  'inventory.void': { roles: ['owner'], duties: ['stock', 'cost'] },
  /** 冲销付款、期初未付、费用报销、备用金单据（#21：账务冲销由财务负责；只限当月，v0.7.11） */
  'finance.void': { roles: ['owner'], duties: ['payable', 'cost'] },
  /** 本部门小仓：签收领料、登记急采与补单、耗用、报损、盘点（v0.7.11，只限员工档案里的所属部门） */
  'deptStock.operate': { roles: ['owner'], duties: ['request'] },
  /** 部门小仓（所有部门）：查看结存、盘点、登记耗用（#17：每月 1 号财务到部门盘点，v0.7.11） */
  'deptStock.audit': { roles: ['owner'], duties: ['cost'] },
  'inventory.export': { roles: ['owner'], duties: ['payable', 'approve'] },
  /** ERP 营业数据（只读）：每天的营业收入、收款与部门构成、日结情况（v0.7.3，待确认：默认店主与店总） */
  'erp.revenue': { roles: ['owner', 'store_manager'] },
  /** 员工食堂 · 柚子饭堂（docs/CANTEEN.md，K1，待确认：默认店主与店总）：员工名单、开通卡片、用餐记录、设置 */
  'canteen.manage': { roles: ['owner', 'store_manager'] },
  /** 安保巡场（8.0.9，docs/PATROL_V809.md，XC3 待确认：默认店主与店总）：看每天的巡场清单、巡场记录与导出 */
  'patrol.read': { roles: ['owner', 'store_manager'] },
  /** 安保巡场：场所与二维码（新增、换码、停用、打印）、设置（巡场部门、手机上能看记录的人）、作废记录 */
  'patrol.manage': { roles: ['owner', 'store_manager'] },
  // ── 费用报销与备用金（v0.7.7，飞书需求 RQ-005；D10：按现有的岗位 + 职责，见 docs/EXPENSES.md）──
  /** 查看费用报销、备用金与每日平账（物资经办、采购经办、负责人只读） */
  'expense.read': { roles: ['owner'], duties: ['stock', 'purchase', 'payable', 'cost', 'approve'] },
  /** 登记费用报销（发票、税点、科目） */
  'expense.manage': { roles: ['owner'], duties: ['cost'] },
  /** 登记备用金打款、退回、补付 */
  'petty.manage': { roles: ['owner'], duties: ['payable', 'cost'] },
  /** 确认超门槛的报销（v0.7.11 起冲销归「finance.void」） */
  'expense.approve': { roles: ['owner'], duties: ['approve'] },
  /** 导出报销明细与每日平账 */
  'expense.export': { roles: ['owner'], duties: ['payable', 'cost', 'approve'] },
  // ── 部门采购需求单（v0.7.8，飞书需求 RQ-005 第二步；见 docs/REQUISITIONS.md）──
  /** 提部门需求单、改与撤回自己的单（只限员工档案里的所属部门） */
  'request.create': { roles: ['owner'], duties: ['request'] },
  /** 审核需求单、转采购单（看全部部门的需求单） */
  'request.review': { roles: ['owner'], duties: ['purchase', 'approve'] },
  /** 核库（8.1.10，CK8–CK14）：看待核库的需求单与所需物品的总仓结存，有货的转领用、提议替代品、转采购 */
  'request.stock': { roles: ['owner'], duties: ['stock'] },
  // ── 审批中心（v0.7.30，docs/APPROVALS.md，默认值待确认）──
  /**
   * 用审批中心审批：待我审批、批量同意、设自己的代理人。能不能审某一张单还要看审批规则（岗位组或指定的人）；
   * 默认店主、店总，负责人（负责人确认）与财务（对账付款、成本核算）职责
   */
  'approval.act': { roles: ['owner', 'store_manager'], duties: ['approve', 'payable', 'cost', 'legal'] },
  /** 维护审批规则（单据类型 × 金额 × 部门 → 审批链），给别人设代理人（默认店主） */
  'approval.rules': { roles: ['owner'] },
  // ── 合同与法务审查（v0.7.31，docs/CONTRACTS.md C12，默认值待确认）──
  /** 查看合同台账、详情、提交记录与审查意见、扫描件 */
  'contract.read': { roles: ['owner', 'store_manager'], duties: ['purchase', 'payable', 'cost', 'approve', 'legal'] },
  /** 起草、修改、提交、撤回、作废、终止合同，登记签署、用印申请、归档、变更单、上传扫描件 */
  'contract.manage': { roles: ['owner', 'store_manager'], duties: ['purchase', 'legal'] },
  // ── 付款流（v0.7.32，docs/PAYMENTS.md P10，默认值待确认）──
  /** 发起付款申请（从合同的付款节点或没挂合同的应付）、修改与撤回自己的申请；看付款申请（审批走审批中心，登记付款要「登记期初未付、付款……」） */
  'payment.request': { roles: ['owner', 'store_manager'], duties: ['purchase', 'payable'] },
  // ── 费用预算与进项发票台账（8.0.3，docs/BUDGET_INVOICES.md BI05、BI12，默认值待确认）──
  /** 设定部门 × 费用科目的月度额度（看预算与占用：能看费用报销的人都能看） */
  'budget.manage': { roles: ['owner'] },
  /** 进项发票台账：直接登记发票、标认证与所属期、上传照片、作废（三单里分到采购单的发票照旧在付款页登记） */
  'invoice.manage': { roles: ['owner'], duties: ['payable', 'cost'] },
  /** 开票（8.0.21，CW14）：处理客人的开票申请——登记已开、交给服务商开、驳回、作废（店主；对账付款） */
  'invoice.issue': { roles: ['owner'], duties: ['payable'] },
  // ── 8.0.7 ERP P2（docs/ERP_V807.md，默认值待确认）──
  /** 应收与挂账：看协议单位、挂账、回款、平台回款与账龄（店主、店总；对账付款、成本核算） */
  'ar.read': { roles: ['owner', 'store_manager'], duties: ['payable', 'cost'] },
  /** 维护协议单位、登记与冲销回款（店主；对账付款） */
  'ar.manage': { roles: ['owner'], duties: ['payable'] },
  /** 资产与易耗：看资产卡片与盘点（店主、店总；仓库、成本核算、负责人） */
  'asset.read': { roles: ['owner', 'store_manager'], duties: ['stock', 'cost', 'approve'] },
  // 8.0.20 布草洗涤（docs/ERP_V8020.md 第 4 节）
  'linen.read': { roles: ['owner', 'store_manager'], duties: ['stock', 'cost', 'payable', 'approve'] },
  'linen.manage': { roles: ['owner', 'store_manager'], duties: ['stock'] },
  // 8.1.9 零采备用金（docs/ERP_V819.md 第 2.4 节，BJ1）：供应链（采购）专用；财务登记报销时只看得到已提交报销的申用，看不到面板
  'pool.read': { roles: ['owner'], duties: ['purchase'] },
  'pool.manage': { roles: ['owner'], duties: ['purchase'] },
  // 8.1.9 签赠（docs/GIFTS_V819.md 第 2.5 节，SZ2–SZ4）：台账、发放、能被选作授权人、维护知识库与配置
  'gift.read': { roles: ['owner', 'store_manager', 'account_manager'], duties: ['concierge', 'concierge_manager'] },
  'gift.issue': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager'], duties: ['concierge', 'concierge_manager'] },
  'gift.authorize': { roles: ['owner', 'store_manager', 'duty_manager'], duties: ['concierge_manager'] },
  'gift.manage': { roles: ['owner', 'store_manager'] },
  /** 资产建卡、调拨、改状态、报废、扫码盘点（店主；仓库、成本核算） */
  'asset.manage': { roles: ['owner'], duties: ['stock', 'cost'] },
  // ── 管理 ──
  // ── 当场授权（主管在弹窗里输入自己的账号密码确认）──
  /** 授权超过单笔上限的充值 / 消费 */
  'auth.overLimit': { roles: ['owner', 'store_manager'] },
  // 退储值、改会员手机号的当场授权（v0.7.26，M69、M77）
  'auth.memberRefund': { roles: ['owner', 'store_manager'] },
  'auth.memberPhone': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 授权散客或等级不够的会员使用 VIP 柜（经营规则开启后才可用） */
  'auth.vipOverride': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 授权结账的「优惠 / 免单」、降低票种与免票（R1.2，店主 2026-10-29 签认） */
  'auth.discount': { roles: ['owner', 'store_manager', 'duty_manager'] },
  'staff.manage': { roles: ['owner'] },
  /** 管理本部门员工账号（8.1.18，GW6）：负责人新建、编辑、停用本部门的「员工」岗位账号，重置密码；不能改岗位权限 */
  'staff.dept': { roles: ['owner'] },
  'catalog.manage': { roles: ['owner', 'store_manager'] },
  /** 技师名册：新建、编辑、停用技师（v0.7.0，待确认：默认店主与店总） */
  'technician.manage': { roles: ['owner', 'store_manager'] },
  /** 钟房：上牌、派钟、上钟、下钟、加钟、退钟（v0.7.1，待确认：前台岗位都能做；派钟、加钟、退钟还要能挂账） */
  'technician.dispatch': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /**
   * 排位播报（8.2.0 P03，回测 4-1）：「技师 → 排位播报」页——看排位、手动叫号、由本机播报（音量、静音、重播、播报记录）。
   * 与钟房分开授：排位员可以只有这一项；默认有钟房的岗位都有
   */
  'technician.announce': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 餐饮点单：按手牌给在店客人点菜（挂账）、催单、上菜（S5 第一步，待确认：前台岗位都能做；下单还要能挂账） */
  'dining.order': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'], duties: ['kangmei'] },
  /** 厨房出品屏：开始做、出餐、沽清（S5 第一步，待确认：前台岗位与后勤人员；厨房可以用后勤账号） */
  'dining.kitchen': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk', 'backoffice'] },
  /**
   * 打开平板点餐（8.0.10，DC16 待确认：能点单的前台岗位与「点餐平板」）：看电子菜单、按手牌找在店客人、看这张手牌点过的菜；
   * 下单另要一位有「餐饮点单」+「前台挂账」的员工输点单密码确认
   */
  'emenu.view': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk', 'tablet'] },
  /** 维护电子菜单（8.0.10，DC16 待确认：店主、店总，与管理价目同一批人）：分类与供应时段、版面、菜品图文与图片、设置 */
  'emenu.manage': { roles: ['owner', 'store_manager'] },
  /** UI 工作台：改草稿、传素材、预览（8.1.1，GZ3：店主、设计师）。看得到菜单内容（菜名、图片、价格），看不到会员、账、经营数据 */
  'studio.edit': { roles: ['owner', 'designer'] },
  /** UI 工作台：发布、回滚（8.1.1，店主 2026-11-15 定设计师可以发布，GZ3）；都记审计 */
  'studio.publish': { roles: ['owner', 'designer'] },
  /** 客房：入住、续住、换房、退房、收退押金、撤销入住、夜审（S7，v0.7.4，待确认：前台岗位都能做） */
  'room.operate': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 预约（v0.7.28，待确认：前台岗位都能做）：预约技师、派对房、客房电话预订；确认、改时间、到店、取消、记爽约 */
  'booking.manage': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 客房：打扫、维修（房态）（S7，v0.7.4，待确认：前台岗位与后勤人员；客房服务员可以用后勤账号） */
  'room.housekeep': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk', 'backoffice'] },
  /** 实时位置（v0.7.17，待确认：前台岗位）：平面图上的在场人员、区域人数、轨迹；只显示手牌号与技师，不显示会员姓名、手机号 */
  'location.view': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 上报位置（v0.7.17，待确认：店主、店总）：后台模拟刷卡；RQ-001 的设备桥用只有这项权限的账号登录上报 */
  'location.report': { roles: ['owner', 'store_manager'] },
  /** 对客导览（v0.7.19，待确认：所有岗位）：区域色块、中英双语、设施图标的导览图与大屏轮播；不显示房号、房态、人员，没有经营数据 */
  'guide.view': { roles: ['owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk', 'backoffice'] },
  /**
   * 看设备状态（v0.7.21，待确认：前台岗位）：门店主导航「设备」一屏看全部设备；开着页面的终端替桥上报状态也用这项。
   * 后勤默认没有：只用 ERP 的后勤照旧没有「返回门店」（v0.7.3 验收 E2）；库房要上报扫码枪时在「岗位权限」给后勤加上
   */
  'device.view': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /** 测试打印（v0.7.21，待确认：值班经理及以上） */
  'device.test': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 维护设备（v0.7.21，待确认：店主、店总）：设备登记、按采购清单导入、启用停用 */
  'device.manage': { roles: ['owner', 'store_manager'] },
  /**
   * 打印单据到小票机（v0.7.28，N7 待确认：前台岗位）：结账单、退款单、交班表、日结单直接打到网口小票机，断网时排队、恢复后补打；
   * 还要能看那张单据（与浏览器打印同一套权限）
   */
  'print.network': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  /**
   * 维护小程序内容（小程序线，MP7，待确认：店主、店总）：门店信息、首页轮播、项目介绍、对顾客开放的开关。
   * 原定也给客户经理，但客户经理不进后台（v0.6.0），先不给；要给客户经理须先让他们能进后台只看这一项（MP7 待店主定）
   */
  'mp.content': { roles: ['owner', 'store_manager'] },
  /** 解绑会员的微信（小程序线，MP6、MP7，待确认：值班经理及以上）：换手机号、换微信时在前台解绑，写原因、记经办人 */
  'mp.unbind': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 线上充值（小程序线第二期 2a，MP_RECHARGE.md，待确认：店主、店总）：设置（开关、可充套餐、限额），处理「已付款待处理」的单子 */
  'mp.recharge': { roles: ['owner', 'store_manager'] },
  /** 领券中心（小程序线第二期 2c，MP_COUPONS.md，MP27 待确认：店主、店总，与维护券模板同一批人）：哪些券可领、领取限制、停领 */
  'mp.coupon': { roles: ['owner', 'store_manager'] },
  /** 到期提醒（小程序线第三期 3a，MP_PHASE3.md 第 1 节，待确认：店主、店总）：开关、三种订阅消息模板 */
  'mp.reminder': { roles: ['owner', 'store_manager'] },
  /** 邀请好友（小程序线第三期 3b，MP_PHASE3.md 第 2 节，待确认：店主、店总）：开关、看邀请记录 */
  'mp.invite': { roles: ['owner', 'store_manager'] },
  'mp.food': { roles: ['owner', 'store_manager'] },
  'mp.booking': { roles: ['owner', 'store_manager'] },
  'settings.manage': { roles: ['owner'] },
  'audit.read': { roles: ['owner', 'store_manager'] },
  // ── 数据看板（v0.6.0；当日看板仍按「查看当日流水与日结」）──
  /** 经营总览：任选时段的营业额、客流、客单价、收款与部门构成、环比（总经理看） */
  'report.executive': { roles: ['owner', 'store_manager'] },
  /** 会员总览：储值余额、新增与渠道、活跃与沉睡、等级分布、赠金到期（客户经理看） */
  'report.members': { roles: ['owner', 'store_manager', 'account_manager'] },
  /** 技师业绩：任选时段每位技师的钟数、点钟 / 轮钟与金额（v0.7.0，待确认：默认值班经理及以上） */
  'report.technicians': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /** 技师提成：按提成规则算出的每位技师提成与明细导出（v0.7.1，待确认：默认店主与店总） */
  'report.commission': { roles: ['owner', 'store_manager'] },
  /** 营销成本测算（8.0.4，HY14）：券、赠金、会员折扣、服务类权益的实核成本；有财务职责的账号一律没有（见 FINANCE_EXCLUDED） */
  'marketing.cost': { roles: ['owner', 'store_manager'] },
  // ── 前台风控（8.1.15《浴族系统需求汇总》块 A，docs/FRONTDESK_RISK_V8115.md，FK1 待确认：值班经理及以上）──
  /** 黑名单：把会员或手机号加入黑名单、解除，看黑名单清单 */
  'frontdesk.blacklist': { roles: ['owner', 'store_manager', 'duty_manager'] },
  /**
   * 前台风控的当场授权：名下有没处理完的「未结离店」的会员发牌、超时加收；
   * 有这一项的人自己加收不用另请授权，「未结离店」的待办也由有这一项的人写处理结果
   */
  'auth.checkinRisk': { roles: ['owner', 'store_manager', 'duty_manager'] },
  // 8.1.15 块 B（docs/DINING_V8115.md 第 4 节）：按出品口下单，点单页只显示有权限的出品口，服务端逐行核对；默认与「餐饮点单」同一批岗位，康美部没有餐厅。
  // 8.1.17（BW3，docs/DISHES_V8117.md 第 5 节）：平板电子菜单也按出品口核对，「点餐平板」默认三处都有；店里去掉哪一处，平板上那一处的菜就点不了
  'dining.orderRestaurant': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk', 'tablet'] },
  'dining.orderWater': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk', 'tablet'], duties: ['kangmei'] },
  'dining.orderFruit': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk', 'tablet'], duties: ['kangmei'] },
  /**
   * 菜品管理（8.1.15，docs/DISHES_V8115.md，CP6、CP7 待确认：店主、店总）：维护权限按出品口分三项——新增、编辑、上下架、做法、加料、套餐、图片；
   * 没有某个出品口权限的看得到、改不了。有任一项（或改价）就看得到餐饮里的「菜品管理」
   */
  'dish.restaurant': { roles: ['owner', 'store_manager'] },
  'dish.water': { roles: ['owner', 'store_manager'] },
  'dish.fruit': { roles: ['owner', 'store_manager'] },
  /** 菜品定价与改价（8.1.15）：单独一项，新建时定价、以后改价都要它，并且要有这道菜所在出品口的维护权限；每次改价写改价记录 */
  'dish.price': { roles: ['owner', 'store_manager'] },
  // 8.1.17 退菜按出品口（BW-4）：餐饮的菜退菜时按这道菜所在的出品口核对；默认与「前台挂账」同一批岗位，康美部有水吧、果吧
  'dining.voidRestaurant': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'] },
  'dining.voidWater': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'], duties: ['kangmei'] },
  'dining.voidFruit': { roles: ['owner', 'store_manager', 'duty_manager', 'clerk'], duties: ['kangmei'] },
} as const satisfies Record<string, Rule>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** 只属于店主、不能在后台授给其他岗位的权限：管理员工账号、修改经营规则（含岗位权限本身）、导入期初余额 */
export const LOCKED_PERMISSIONS: readonly Permission[] = ['staff.manage', 'settings.manage', 'wallet.opening'];

/**
 * 与财务隔离的权限（8.0.4，HY14）：有这些职责的账号一律没有，后台岗位权限加了也不生效；店主不受限制。
 * 营销成本是经营测算，不进财务凭证与报表，财务账号看不到测算明细（需求表 11）。
 */
export const FINANCE_EXCLUDED: Partial<Record<Permission, readonly Duty[]>> = { 'marketing.cost': ['payable', 'cost'] };

/**
 * 这位账号的职责把这项权限挡掉了（与财务隔离）。financeExclusion 是经营规则「有财务职责的账号看不到营销成本」
 * （HY14，默认开；8.0.7 起在「门店基本规则 → 可调的数值」里改，关掉以后按岗位权限给）
 */
export function excludedByDuty(subject: Pick<PermissionSubject, 'role' | 'duties'>, permission: Permission, financeExclusion = true): boolean {
  if (subject.role === 'owner' || !financeExclusion) return false;
  return !!FINANCE_EXCLUDED[permission]?.some((d) => subject.duties?.includes(d));
}

/** 可以在后台调整权限的岗位（店主固定拥有全部权限） */
export const EDITABLE_ROLES = ROLES.filter((r): r is Exclude<Role, 'owner'> => r !== 'owner');
export type EditableRole = (typeof EDITABLE_ROLES)[number];

/** 后台对岗位权限的调整：相对默认规则增加、去掉的权限（以后新增的权限仍按默认，不会被旧的调整挡住） */
export type RoleOverrides = Partial<Record<EditableRole, { add: Permission[]; remove: Permission[] }>>;

/** 默认规则下岗位本身（不含职责）是否有这项权限 */
export function roleDefault(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as Rule).roles.includes(role);
}

/** 按后台调整后，岗位本身（不含职责）是否有这项权限 */
export function roleHas(role: Role, permission: Permission, overrides?: RoleOverrides | null): boolean {
  if (role === 'owner') return true;
  if (LOCKED_PERMISSIONS.includes(permission)) return false;
  const o = overrides?.[role];
  if (o?.remove.includes(permission)) return false;
  if (o?.add.includes(permission)) return true;
  return roleDefault(role, permission);
}

/** 岗位权限（按后台调整）与职责权限（固定）的并集 */
/** 旧岗位的调整与新岗位的调整（会话、授权人、审批人算权限都用它） */
export interface PermissionOverrides {
  roles: RoleOverrides;
  positions: PositionOverrides;
  /**
   * 岗位的建议权限（8.2.0 P04：存在库里的「分部门岗位职权配置」，position_suggestions）。给了这个岗位的就按它，
   * 没给（库里还没有这张表、或没有这个岗位）按代码里的岗位模板 positionDefaults（与库里的初始数据一致）
   */
  suggested?: Partial<Record<PositionKey, readonly Permission[]>>;
}

/** 算权限要的员工资料：岗位（position）必须给出（没有就是 null），免得漏了新岗位按旧岗位算 */
export interface PermissionsOfSubject {
  role: Role;
  duties?: readonly Duty[];
  position: PositionKey | null;
  /** 员工档案里的个人微调（8.1.18，GW8） */
  adjust?: PermissionAdjust | null;
}

/** 只给旧岗位的调整（RoleOverrides）时当作没有新岗位的调整 */
function normalizeOverrides(overrides: PermissionOverrides | RoleOverrides | null | undefined): PermissionOverrides | null {
  if (!overrides) return null;
  return 'positions' in overrides && 'roles' in overrides ? (overrides as PermissionOverrides) : { roles: overrides as RoleOverrides, positions: {} };
}

/** 岗位的建议权限：库里的（P04）优先，没有按代码里的模板 */
export function suggestedOf(position: PositionKey, overrides?: Pick<PermissionOverrides, 'suggested'> | null): Permission[] {
  if (position === 'president') return [...ALL_PERMISSIONS];
  const fromDb = overrides?.suggested?.[position];
  return fromDb ? ALL_PERMISSIONS.filter((p) => fromDb.includes(p)) : positionDefaults(position, ALL_PERMISSIONS);
}

export function permissionsOf(subject: PermissionsOfSubject, rawOverrides?: PermissionOverrides | RoleOverrides | null, opts: { financeExclusion?: boolean } = {}): Permission[] {
  const finance = opts.financeExclusion ?? true;
  const overrides = normalizeOverrides(rawOverrides);
  if (subject.position === 'president' || (!subject.position && subject.role === 'owner')) return [...ALL_PERMISSIONS];
  if (subject.position) {
    // 新岗位：岗位模板 → 后台按岗位的增减 → 个人微调；店主专属的权限（LOCKED_PERMISSIONS）只有总裁有
    const base = applyAdjust(suggestedOf(subject.position, overrides), overrides?.positions[subject.position], LOCKED_PERMISSIONS);
    const mine = applyAdjust(base, subject.adjust, LOCKED_PERMISSIONS);
    return ALL_PERMISSIONS.filter((p) => mine.has(p) && !LOCKED_PERMISSIONS.includes(p) && !excludedByDuty(subject, p, finance));
  }
  const legacy = ALL_PERMISSIONS.filter(
    (p) => !excludedByDuty(subject, p, finance) && (roleHas(subject.role, p, overrides?.roles) || !!(PERMISSIONS[p] as Rule).duties?.some((d) => subject.duties?.includes(d))),
  );
  if (!subject.adjust) return legacy;
  const mine = applyAdjust(legacy, subject.adjust, LOCKED_PERMISSIONS);
  return ALL_PERMISSIONS.filter((p) => mine.has(p) && !excludedByDuty(subject, p, finance));
}

export function can(subject: PermissionSubject, permission: Permission): boolean {
  if (subject.permissions) return subject.permissions.includes(permission);
  if (excludedByDuty(subject, permission)) return false;
  const rule = PERMISSIONS[permission] as Rule;
  if (rule.roles.includes(subject.role)) return true;
  return !!rule.duties?.some((d) => subject.duties?.includes(d));
}

/** 把后台提交的「各岗位应有的权限」换算成相对默认的增减；店主专属的权限不能授出 */
export function overridesFrom(target: Partial<Record<EditableRole, readonly Permission[]>>): RoleOverrides {
  const out: RoleOverrides = {};
  for (const role of EDITABLE_ROLES) {
    const want = target[role];
    if (!want) continue;
    const add = ALL_PERMISSIONS.filter((p) => want.includes(p) && !roleDefault(role, p) && !LOCKED_PERMISSIONS.includes(p));
    const remove = ALL_PERMISSIONS.filter((p) => !want.includes(p) && roleDefault(role, p));
    if (add.length || remove.length) out[role] = { add, remove };
  }
  return out;
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  'customer.read': '客户部：查看同源经营、会员及本人业绩',
  'customer.operate': '客户部：记录服务、申请绑定与成交归属',
  'customer.manage': '客户部：核验归属、审批绑定与维护目标',
  'concierge.read': '管家部：查看服务档案、协调预约与凭证；会员中心能看到全店会员的档阶、余额与到访（没有「查找与查看会员」的，未建服务档案的会员手机号打码）',
  'concierge.operate': '管家部：建档、拍单、人工余额核对、服务与交班',
  'concierge.manage': '管家部：经理监管、名称核准、已确认凭证更正',
  'concierge.export': '管家部：业务与原图导出',
  'member.read': '查找与查看会员',
  'member.write': '新建与编辑会员',
  'recharge.create': '确认充值入账',
  'recharge.customBonus': '自定义赠金（不按档级比例）',
  'consume.create': '登记消费扣款',
  'consume.customAmount': '手动输入消费金额',
  'consume.reverse': '撤销消费（整单）',
  'ledger.readToday': '查看当日流水与日结',
  'ledger.readHistory': '查看历史营业日',
  'ledger.export': '导出流水与日结',
  'settlement.close': '确认日结',
  'wallet.opening': '导入旧系统会员余额（期初）、旧系统逐笔流水，与作废',
  'member.rules': '修改会员规则（档级门槛、赠送比例、周期）',
  'member.adjust': '手动调整会员档阶（写原因）',
  'member.refund': '退储值（要店主或店总当场授权）',
  'member.status': '停用、启用会员（写原因）',
  'member.phone': '改会员手机号（不用授权；没有这一项的要当场授权）',
  'member.merge': '合并会员（同一个人的两份档案，写原因）',
  'countcard.sell': '售次卡（现金类收款，记到当班）',
  'countcard.refund': '退次卡（退剩下的次数，按售价折算）',
  'member.card': '会员实体卡：发卡、挂失、补卡',
  'platform.redeem': '平台核销补登记（已在平台 App 核销、没有结账的券）',
  'platform.void': '作废平台核销补登记',
  'platform.settle': '平台打款登记与对账',
  'member.retention': '看会员体系看板与到期提醒名单',
  'member.lookup': '他店查询（按手机号查会员档阶，只读）',
  'benefit.publish': '维护会员权益（导入清单、修改、发布、暂缓）',
  'benefit.use': '登记会员权益使用（服务类，数次数）',
  'frontdesk.read': '查看在店手牌与手牌账单',
  'frontdesk.operate': '接待发牌、同行绑牌、挂账、换牌',
  'frontdesk.correct': '作废他人或超时明细、撤销来访',
  'frontdesk.tags': '维护手牌池（建牌、解锁、停用）',
  'frontdesk.checkout': '结账收款、登记团购券',
  'frontdesk.checkoutVoid': '反结账（撤销结账单）',
  'frontdesk.backfill': '按实际时间补录纸质单',
  'frontdesk.refund': '开退款单（离店后部分退款）与作废当班的退款单',
  'frontdesk.onAccount': '结账时挂账到协议单位',
  'coupon.manage': '维护券模板、发券规则与无记名券',
  'coupon.issue': '发券给会员',
  'coupon.void': '作废会员没用过的券',
  'inventory.read': '查看库存与物资单据',
  'inventory.cost': '看成本：库存金额、耗用成本、项目毛利',
  'inventory.operate': '期初、收货、领料、退回、耗用、报损、盘点录入（总仓）',
  'inventory.master': '维护物料、供应商、部门档案',
  'purchase.manage': '编制与提交采购单',
  'purchase.rules': '维护采购规则（截单、急采分级审批、询价门槛……）',
  'supplierReturn.create': '发起退供应商',
  'supplierReturn.answer': '登记供应商对退货的答复',
  'payable.read': '查看供应商货款与对账',
  'payable.manage': '登记期初未付、付款、核销与供应商退款',
  'inventory.approve': '负责人确认（采购、报损、盘点调整、退货、付款）',
  'inventory.void': '冲销库存单据（只限当月）',
  'finance.void': '冲销付款、期初未付、报销与备用金（只限当月）',
  'deptStock.operate': '本部门小仓：签收领料、急采与补单、耗用、报损、盘点',
  'deptStock.audit': '部门小仓（所有部门）：查看、盘点、登记耗用',
  'inventory.export': '导出库存与对账',
  'erp.revenue': 'ERP：看营业数据（只读）',
  'canteen.manage': '员工食堂：名单、开通卡片、用餐记录与设置',
  'patrol.read': '安保巡场：看巡场清单、记录与导出',
  'patrol.manage': '安保巡场：场所与二维码、设置、作废记录',
  'expense.read': '查看费用报销、备用金与每日平账',
  'expense.manage': '登记费用报销（发票、税点、科目）',
  'petty.manage': '登记备用金打款、退回、补付',
  'expense.approve': '确认超门槛的报销',
  'expense.export': '导出报销明细与每日平账',
  'request.create': '提部门采购需求单（只限本部门）',
  'request.review': '审核需求单、转采购单',
  'request.stock': '需求单核库（有货的转领用、提议替代品）',
  'approval.act': '审批中心：审批（按审批规则）、批量同意、设自己的代理人',
  'approval.rules': '审批中心：维护审批规则、给别人设代理人',
  'contract.read': '合同：查看台账、详情、审查意见与扫描件',
  'contract.manage': '合同：起草、提交、签署、用印申请、归档、变更、终止',
  'payment.request': '付款：发起付款申请、修改与撤回',
  'budget.manage': '设定费用预算（部门 × 费用科目的月度额度）',
  'invoice.manage': '管理进项发票（台账里登记、标认证、上传照片、作废）',
  'invoice.issue': '开票：处理客人的开票申请（登记已开、交给服务商开、驳回、作废）',
  'ar.read': '应收与挂账：看协议单位、挂账、回款、平台回款与账龄',
  'ar.manage': '应收与挂账：维护协议单位、登记与冲销回款',
  'asset.read': '资产与易耗：看资产卡片与盘点',
  'linen.read': '布草洗涤：看布草数量、单据与洗涤费对账',
  'linen.manage': '布草洗涤：维护品类，开送洗、收回、新增、报废单',
  'pool.read': '零采备用金：看面板与申用台账、导出',
  'pool.manage': '零采备用金：申用、提交 / 撤回报销、更新补单、作废申用',
  'gift.read': '签赠：看签赠台账（明细、按授权人、按个人、占比）',
  'gift.issue': '签赠：给会员发放签赠券（要选授权人）',
  'gift.authorize': '签赠：能被选作签赠的授权人',
  'gift.manage': '签赠：维护签赠知识库（签赠券类型）与配置',
  'asset.manage': '资产与易耗：建卡、调拨、改状态、报废、扫码盘点',
  'auth.overLimit': '当场授权超过单笔上限的充值 / 消费',
  'auth.memberRefund': '当场授权退储值',
  'auth.memberPhone': '当场授权改会员手机号',
  'auth.vipOverride': '当场授权散客或低等级会员使用 VIP 柜',
  'auth.discount': '当场授权优惠 / 免单、降低票种与免票',
  'staff.manage': '管理员工账号',
  'staff.dept': '管理本部门员工账号（新建、编辑、停用本部门的员工岗位）',
  'catalog.manage': '管理充值套餐与消费项目',
  'technician.manage': '维护技师名册',
  'technician.dispatch': '钟房派钟、上下钟、加钟、退钟、上牌',
  'technician.announce': '排位播报：看排位、手动叫号、由本机播报',
  'dining.order': '餐饮点单、催单、上菜',
  'dining.kitchen': '厨房出品屏：开始做、出餐、沽清',
  'emenu.view': '打开平板点餐（电子菜单；下单要服务员输点单密码）',
  'emenu.manage': '维护电子菜单（分类、版面、菜品图文、设置）',
  'room.operate': '客房入住、续住、换房、退房、押金、夜审',
  'booking.manage': '预约：新建、确认、改时间、到店、取消、记爽约',
  'room.housekeep': '客房打扫、维修（房态）',
  'location.view': '看实时位置（平面图上的在场人员与轨迹）',
  'location.report': '上报位置（模拟刷卡、设备桥）',
  'guide.view': '看对客导览（区域导览图、门店大屏轮播）',
  'device.view': '看设备状态（一屏看全部设备、终端上报）',
  'device.test': '测试打印（打印机、标签机）',
  'device.manage': '维护设备（登记、按采购清单导入、启用停用）',
  'print.network': '打印单据到小票机（结账单、退款单、交班表、日结单；断网时排队，恢复后补打）',
  'mp.content': '维护小程序内容（门店信息、首页轮播、项目介绍、开关）',
  'mp.unbind': '解绑会员的微信（换手机号、换微信）',
  'mp.recharge': '小程序线上充值：设置，处理已付款没能自动入账的单子',
  'mp.coupon': '小程序领券中心：哪些券可领、每人限领几张、停领',
  'mp.reminder': '小程序到期提醒：开关、订阅消息模板',
  'mp.invite': '小程序邀请好友：开关、看邀请记录',
  'mp.food': '小程序扫码点餐：开关、可点的菜、打印桌码、看点单记录',
  'mp.booking': '小程序预约：开关、可约的项目与房间、看小程序的预约',
  'settings.manage': '修改经营规则设置',
  'audit.read': '查看操作审计',
  'report.executive': '看经营总览（任选时段、环比）',
  'report.members': '看会员总览（储值、新增、活跃、等级）',
  'report.technicians': '看技师业绩（钟数、点钟 / 轮钟、金额）',
  'report.commission': '看技师提成与导出提成明细',
  'marketing.cost': '营销成本测算（券、赠金、会员折扣的实核成本；有财务职责的账号不生效）',
  'studio.edit': 'UI 工作台：改版面草稿、传素材、预览',
  'studio.publish': 'UI 工作台：发布、回滚版面（平板马上换成新样子）',
  'frontdesk.blacklist': '维护黑名单（加入、解除、看清单）',
  'auth.checkinRisk': '当场授权未结离店的会员发牌、超时加收；处理未结离店的待办',
  'dining.orderRestaurant': '点单：在餐厅下单',
  'dining.orderWater': '点单：在水吧下单',
  'dining.orderFruit': '点单：在果吧下单',
  'dish.restaurant': '菜品管理：维护餐厅的菜品（新增、编辑、上下架、做法、加料、套餐）',
  'dish.water': '菜品管理：维护水吧的菜品（新增、编辑、上下架、做法、加料、套餐）',
  'dish.fruit': '菜品管理：维护果吧的菜品（新增、编辑、上下架、做法、加料、套餐）',
  'dish.price': '菜品管理：定价与改价（还要有那个出品口的维护权限；每次改价留记录）',
  'dining.voidRestaurant': '退菜：餐厅的菜',
  'dining.voidWater': '退菜：水吧的菜',
  'dining.voidFruit': '退菜：果吧的菜',
};

export const PERMISSION_GROUPS: { title: string; items: Permission[] }[] = [
  { title: '客户部', items: ['customer.read', 'customer.operate', 'customer.manage'] },
  { title: '管家部', items: ['concierge.read', 'concierge.operate', 'concierge.manage', 'concierge.export'] },
  {
    title: '会员与储值',
    items: [
      'member.read',
      'member.write',
      'recharge.create',
      'recharge.customBonus',
      'consume.create',
      'consume.customAmount',
      'consume.reverse',
      'ledger.readToday',
      'ledger.readHistory',
      'ledger.export',
      'settlement.close',
      'wallet.opening',
    ],
  },
  {
    title: '前台手牌与账单',
    items: [
      'frontdesk.read',
      'frontdesk.operate',
      'frontdesk.correct',
      'frontdesk.tags',
      'frontdesk.checkout',
      'frontdesk.checkoutVoid',
      'frontdesk.refund',
      'frontdesk.onAccount',
      'frontdesk.backfill',
      'technician.dispatch',
      'technician.announce',
      'dining.order',
      'dining.kitchen',
      'emenu.view',
      'room.operate',
      'room.housekeep',
      'booking.manage',
      'platform.redeem',
      'platform.void',
      'platform.settle',
      'location.view',
      'location.report',
      'guide.view',
    ],
  },
  {
    title: '会员体系',
    items: [
      'member.rules',
      'member.adjust',
      'member.retention',
      'member.lookup',
      'benefit.publish',
      'benefit.use',
      'member.refund',
      'member.status',
      'member.phone',
      'member.merge',
      'countcard.sell',
      'countcard.refund',
      'member.card',
    ],
  },
  { title: '券与会员权益', items: ['coupon.manage', 'coupon.issue', 'coupon.void'] },
  { title: '签赠', items: ['gift.read', 'gift.issue', 'gift.authorize', 'gift.manage'] },
  { title: '设备', items: ['device.view', 'device.test', 'device.manage', 'print.network'] },
  { title: '微信小程序', items: ['mp.content', 'mp.unbind', 'mp.recharge', 'mp.coupon', 'mp.reminder', 'mp.invite', 'mp.food', 'mp.booking'] },
  {
    title: 'ERP（库存、采购、货款、费用、营业数据）',
    items: [
      'inventory.read',
      'inventory.cost',
      'inventory.operate',
      'inventory.master',
      'purchase.manage',
      'purchase.rules',
      'supplierReturn.create',
      'supplierReturn.answer',
      'payable.read',
      'payable.manage',
      'inventory.approve',
      'inventory.void',
      'inventory.export',
      'deptStock.operate',
      'deptStock.audit',
      'expense.read',
      'expense.manage',
      'petty.manage',
      'expense.approve',
      'finance.void',
      'expense.export',
      'request.create',
      'request.review',
      'request.stock',
      'erp.revenue',
      'approval.act',
      'approval.rules',
      'contract.read',
      'contract.manage',
      'payment.request',
      'budget.manage',
      'invoice.manage',
      'invoice.issue',
      'ar.read',
      'ar.manage',
      'asset.read',
      'asset.manage',
      'linen.read',
      'linen.manage',
      'pool.read',
      'pool.manage',
    ],
  },
  { title: '员工工作台', items: ['canteen.manage', 'patrol.read', 'patrol.manage'] },
  { title: '当场授权', items: ['auth.overLimit', 'auth.vipOverride', 'auth.discount', 'auth.memberRefund', 'auth.memberPhone'] },
  { title: '数据看板', items: ['report.executive', 'report.members', 'report.technicians', 'report.commission', 'marketing.cost'] },
  { title: '管理后台', items: ['staff.manage', 'staff.dept', 'catalog.manage', 'emenu.manage', 'technician.manage', 'settings.manage', 'audit.read'] },
  { title: 'UI 工作台', items: ['studio.edit', 'studio.publish'] },
  { title: '前台风控', items: ['frontdesk.blacklist', 'auth.checkinRisk'] },
  { title: '餐饮：按出品口下单', items: ['dining.orderRestaurant', 'dining.orderWater', 'dining.orderFruit'] },
  { title: '菜品管理', items: ['dish.restaurant', 'dish.water', 'dish.fruit', 'dish.price'] },
  { title: '餐饮：按出品口退菜', items: ['dining.voidRestaurant', 'dining.voidWater', 'dining.voidFruit'] },
];
