// 后台「会员体系」（8.0.19，docs/IA_V8017.md 第 3.2 节，IA5 店主 2026-11-13）：原来的三个分区——会员规则、会员权益、
// 渠道与标签（更早叫「会员与渠道」）——合成一个，三个页签，写进地址（/admin/membership/benefits）。
// 每个页签还是原来那一页的内容、原来的权限：会员规则 member.rules、会员权益 benefit.publish、渠道与标签 settings.manage；
// 没权限的页签不显示。旧地址 /admin/benefits（含 ?view=）、/admin/members、/admin/vip-lockers 跳过来（features/admin/AdminPage）。

import { Navigate } from 'react-router';
import type { Permission } from '@shared/permissions';
import { useCan } from '../../lib/session';
import { SubPane } from '../../components/SubNav';
import { AdminPage } from '../admin/AdminShell';
import { MembersBody } from '../admin/MembersSection';
import { BenefitsBody } from './BenefitsSection';
import { MembershipRulesBody } from './RulesSection';

/** 顺序：规则 → 清单（权益）→ 渠道与标签 */
export const MEMBERSHIP_TABS: readonly { key: 'rules' | 'benefits' | 'channels'; label: string; perm: Permission }[] = [
  { key: 'rules', label: '会员规则', perm: 'member.rules' },
  { key: 'benefits', label: '会员权益', perm: 'benefit.publish' },
  { key: 'channels', label: '渠道与标签', perm: 'settings.manage' },
];

export function MembershipSection() {
  const can = useCan();
  const tabs = MEMBERSHIP_TABS.filter((t) => can(t.perm));
  if (tabs.length === 0) return <Navigate to="/admin" replace />;
  const has = (key: string) => tabs.some((t) => t.key === key);
  return (
    <AdminPage section="membership" wide tabs={tabs.map((t) => ({ key: t.key, label: t.label }))} description="档级与会籍的规则、本店权益清单、渠道来源与会员标签。每个页签各自保存，只影响以后的充值、消费与建档。">
      {has('rules') && (
        <SubPane tab="rules" lazy>
          <MembershipRulesBody />
        </SubPane>
      )}
      {has('benefits') && (
        <SubPane tab="benefits" lazy>
          <BenefitsBody />
        </SubPane>
      )}
      {has('channels') && (
        <SubPane tab="channels" lazy>
          <MembersBody />
        </SubPane>
      )}
    </AdminPage>
  );
}
