import { useState } from 'react';
import { useAudit } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { DateNav } from '../../components/DateNav';
import { EmptyState } from '../../components/EmptyState';
import { Badge, Card, Skeleton } from '../../components/ui';

const ACTION_LABELS: Record<string, { label: string; tone: 'neutral' | 'pine' | 'clay' | 'lake' | 'yuzu' | 'ember' }> = {
  login: { label: '登录', tone: 'neutral' },
  login_failed: { label: '登录失败', tone: 'clay' },
  auth_granted: { label: '当场授权', tone: 'ember' },
  auth_failed: { label: '授权失败', tone: 'clay' },
  logout: { label: '退出', tone: 'neutral' },
  password_changed: { label: '修改密码', tone: 'neutral' },
  staff_created: { label: '添加员工', tone: 'pine' },
  staff_updated: { label: '修改员工', tone: 'pine' },
  staff_password_reset: { label: '重置密码', tone: 'ember' },
  position_chosen: { label: '自选新岗位', tone: 'pine' },
  member_created: { label: '新建会员', tone: 'lake' },
  member_updated: { label: '修改会员', tone: 'lake' },
  recharge_created: { label: '充值', tone: 'lake' },
  consumption_created: { label: '消费', tone: 'yuzu' },
  consumption_reversed: { label: '撤销', tone: 'clay' },
  consume_rejected: { label: '余额不足', tone: 'yuzu' },
  duplicate_blocked: { label: '重复提交', tone: 'ember' },
  operation_abandoned: { label: '作废待确认记账', tone: 'ember' },
  settlement_closed: { label: '确认日结', tone: 'pine' },
  settings_updated: { label: '修改规则', tone: 'ember' },
  store_saved: { label: '门店档案', tone: 'ember' },
  entity_saved: { label: '公司主体', tone: 'ember' },
  staff_stores_saved: { label: '员工挂门店', tone: 'ember' },
  store_switched: { label: '换门店', tone: 'neutral' },
  canteen_employee: { label: '员工食堂名单', tone: 'pine' },
  plan_saved: { label: '保存套餐', tone: 'neutral' },
  item_saved: { label: '保存项目', tone: 'neutral' },
  export: { label: '导出', tone: 'neutral' },
  opening_imported: { label: '导入期初余额', tone: 'ember' },
  member_history_imported: { label: '导入旧系统流水', tone: 'ember' },
  member_history_voided: { label: '作废旧系统流水', tone: 'clay' },
  opening_voided: { label: '作废期初', tone: 'clay' },
  frontdesk_checkin: { label: '接待发牌', tone: 'pine' },
  frontdesk_swap: { label: '换牌', tone: 'lake' },
  frontdesk_group: { label: '同行绑牌', tone: 'lake' },
  frontdesk_cancel: { label: '撤销来访', tone: 'clay' },
  frontdesk_post: { label: '手牌挂账', tone: 'yuzu' },
  emenu_order: { label: '平板点餐下单', tone: 'yuzu' },
  // 管家部（8.0.12）：建档、余额核对、凭证、预约接待、交班、名称核准、导出等都记在这一类，详情里的「label」写着具体是哪一样
  concierge_record: { label: '管家部记录', tone: 'pine' },
  concierge_upload: { label: '管家部上传凭证照片', tone: 'lake' },
  emenu_saved: { label: '电子菜单', tone: 'neutral' },
  emenu_draft: { label: '电子菜单初稿', tone: 'neutral' },
  order_pin_set: { label: '生成点单密码', tone: 'ember' },
  order_pin_cleared: { label: '收回点单密码', tone: 'ember' },
  order_pin_failed: { label: '点单密码不对', tone: 'clay' },
  frontdesk_void: { label: '作废明细', tone: 'clay' },
  frontdesk_abandon: { label: '作废待确认操作', tone: 'ember' },
  frontdesk_ticket: { label: '改票种', tone: 'lake' },
  frontdesk_checkout: { label: '结账', tone: 'pine' },
  frontdesk_checkout_void: { label: '反结账', tone: 'clay' },
  ticket_type_saved: { label: '保存票种', tone: 'neutral' },
  shift_started: { label: '开班', tone: 'lake' },
  shift_closed: { label: '交班', tone: 'pine' },
  shift_joined: { label: '加入钱箱', tone: 'lake' },
  shift_left: { label: '离开钱箱', tone: 'neutral' },
  hand_tags_created: { label: '建手牌', tone: 'neutral' },
  hand_tags_imported: { label: '导入柜号清单', tone: 'ember' },
  hand_tag_locked: { label: '锁定手牌', tone: 'ember' },
  hand_tag_unlocked: { label: '解锁手牌', tone: 'neutral' },
  hand_tag_updated: { label: '修改手牌', tone: 'neutral' },
  technician_saved: { label: '保存技师', tone: 'neutral' },
  items_technician_updated: { label: '调整需要技师的项目', tone: 'neutral' },
  member_refund: { label: '退储值', tone: 'clay' },
  recharge_online: { label: '线上充值', tone: 'lake' },
  member_status_changed: { label: '停用 / 启用会员', tone: 'ember' },
  member_phone_changed: { label: '改会员手机号', tone: 'ember' },
  member_merged: { label: '合并会员', tone: 'ember' },
  // 8.1.15 前台（块 A）：芯片号、黑名单、发牌前风控、发牌后的异常处置
  hand_tag_card: { label: '手牌绑 / 解绑芯片号', tone: 'neutral' },
  blacklist_added: { label: '加入黑名单', tone: 'clay' },
  blacklist_lifted: { label: '解除黑名单', tone: 'lake' },
  checkin_blocked: { label: '发牌被黑名单拦下', tone: 'clay' },
  visit_incident: { label: '异常处置', tone: 'yuzu' },
  incident_assigned: { label: '异常待办指派', tone: 'lake' },
  incident_resolved: { label: '异常待办处理结果', tone: 'pine' },
  // 8.1.15 块 B（docs/DINING_V8115.md）：桌台动作
  table_clear: { label: '清台', tone: 'neutral' },
  table_maintenance: { label: '桌台维修', tone: 'clay' },
  table_restore: { label: '桌台恢复', tone: 'pine' },
  table_merge: { label: '并台', tone: 'lake' },
  table_split: { label: '拆台', tone: 'lake' },
  // 菜品管理（8.1.15，docs/DISHES_V8115.md）
  dish_saved: { label: '保存菜品', tone: 'neutral' },
  dish_active_set: { label: '菜品上下架', tone: 'neutral' },
  dish_price_changed: { label: '菜品改价', tone: 'ember' },
  dishes_imported: { label: '导入菜品', tone: 'ember' },
  // 8.1.15 房态中心
  room_center_register: { label: '房态中心 · 登记', tone: 'lake' },
  room_center_extend: { label: '房态中心 · 续钟', tone: 'lake' },
  room_center_move: { label: '房态中心 · 换房', tone: 'yuzu' },
  room_center_checkout: { label: '房态中心 · 退房', tone: 'pine' },
  room_center_merge: { label: '房态中心 · 并房 / 拆并', tone: 'yuzu' },
  room_center_state: { label: '房态中心 · 改房态', tone: 'ember' },
  room_category: { label: '房态中心 · 房型', tone: 'pine' },
  // 8.1.15 技师管理
  technician_group: { label: '技师组别', tone: 'neutral' },
  technician_shift: { label: '技师班次', tone: 'neutral' },
  technician_schedule: { label: '技师排班', tone: 'neutral' },
  technician_leave: { label: '技师休假', tone: 'ember' },
  clock_announcer: { label: '叫号播报终端', tone: 'neutral' },
  // 会员实体卡（v0.7.28）与押金、退卡（8.1.15）
  member_card_issued: { label: '发卡 / 补卡', tone: 'lake' },
  member_card_lost: { label: '挂失会员卡', tone: 'ember' },
  member_card_deposit: { label: '会员卡押金', tone: 'pine' },
  member_card_returned: { label: '退卡', tone: 'clay' },
  // 8.1.16 菜品维护结果待确认时确认作废
  dish_op_abandoned: { label: '作废菜品操作', tone: 'clay' },
  // 8.1.17 第二家店改本店价（BW-11）
  store_price_changed: { label: '改本店价', tone: 'ember' },
  dishes_sorted: { label: '菜品排序', tone: 'neutral' },
  dishes_active_bulk: { label: '菜品批量上下架', tone: 'neutral' },
  dish_deleted: { label: '删除菜品', tone: 'clay' },
  dish_restored: { label: '恢复菜品', tone: 'neutral' },
};

function describe(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof detail.docNo === 'string') parts.push(detail.docNo);
  if (typeof detail.visitNo === 'string') parts.push(detail.visitNo);
  if (Array.isArray(detail.tags)) parts.push(`手牌 ${detail.tags.join('、')}`);
  if (typeof detail.from === 'string' && typeof detail.to === 'string') parts.push(`${detail.from} → ${detail.to}`);
  if (typeof detail.code === 'string') parts.push(`手牌 ${detail.code}`);
  if (typeof detail.username === 'string') parts.push(`账号 ${detail.username}`);
  // 当场授权：授权人与授权的柜
  if (typeof detail.approverName === 'string') parts.push(`授权人 ${detail.approverName}`);
  const scope = detail.scope as { tags?: { code: string }[]; kind?: 'recharge' | 'consume'; amount?: number } | undefined;
  if (Array.isArray(scope?.tags)) parts.push(`VIP 柜 ${scope.tags.map((t) => t.code).join('、')}`);
  if (scope?.kind && typeof scope.amount === 'number') parts.push(`超过单笔上限的${scope.kind === 'recharge' ? '充值' : '消费'} ¥${(scope.amount / 100).toFixed(2)}`);
  if (typeof detail.overLimitApproverName === 'string') parts.push(`超限由${detail.overLimitApproverName}当场授权`);
  const vip = detail.vipOverride as { approverName?: string } | undefined;
  if (vip?.approverName) parts.push(`VIP 柜由${vip.approverName}当场授权`);
  if (typeof detail.lostFee === 'number') parts.push(`丢牌赔偿 ¥${(detail.lostFee / 100).toFixed(2)}`);
  if (typeof detail.total === 'number' && typeof detail.created === 'number') {
    parts.push(`清单 ${detail.total} 个：新建 ${detail.created} · 更新 ${detail.updated ?? 0} · 停用 ${detail.deactivated ?? 0}`);
  }
  if (typeof detail.name === 'string') parts.push(detail.name);
  if (typeof detail.reason === 'string') parts.push(detail.reason);
  if (typeof detail.note === 'string' && detail.note) parts.push(detail.note);
  if (typeof detail.summary === 'string' && detail.summary) parts.push(detail.summary);
  if (detail.via === 'cli') parts.push('命令行');
  return parts.join(' · ');
}

/** 操作审计：按自然日查看登录、余额操作、配置变更 */
export function AuditTab() {
  const session = useSession();
  const [date, setDate] = useState(session.today);
  const audit = useAudit(date);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateNav value={date} today={session.today} onChange={setDate} />
        <p className="text-[12.5px] text-ink-3">审计记录只追加、不可修改，按自然日显示最近 200 条。</p>
      </div>
      <Card>
        {audit.isPending ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (audit.data ?? []).length === 0 ? (
          <EmptyState art="calm" title="这一天没有操作记录" />
        ) : (
          <ul className="divide-y divide-line/70">
            {audit.data!.map((a) => {
              const meta = ACTION_LABELS[a.action] ?? { label: a.action, tone: 'neutral' as const };
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                  <span className="num w-24 shrink-0 text-ink-3">{formatDateTime(a.createdAt)}</span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <span className="font-semibold">{a.staffName ?? '系统'}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">{describe(a.detail)}</span>
                  {a.ip && <span className="num text-[12px] text-ink-4">{a.ip}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
