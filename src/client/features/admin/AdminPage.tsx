// 管理后台的路由（v0.6.0）：/admin 下各分区；旧的「管理」页的 /admin/<分区> 地址不变。

import type { RouteObject } from 'react-router';
import { Navigate } from 'react-router';
import { AdminHome } from './AdminHome';
import { AdminPage } from './AdminShell';
import { AuditTab } from './AuditTab';
import { CatalogTab } from './CatalogTab';
import { CouponsSection } from './CouponsSection';
import { DevicesSection } from './DevicesSection';
import { DiningSection } from './DiningSection';
import { MembersSection } from './MembersSection';
import { OpeningTab } from './OpeningTab';
import { PermissionsSection } from './PermissionsSection';
import { RoomsSection } from './RoomsSection';
import { RuleCatalog } from './RuleCatalog';
import { RulesTab } from './RulesTab';
import { SpacesSection } from './SpacesSection';
import { StaffTab } from './StaffTab';
import { TagsTab } from './TagsTab';
import { TechniciansSection } from './TechniciansSection';

export const adminRoutes: RouteObject[] = [
  { index: true, element: <AdminHome /> },
  { path: 'settings', element: <RuleCatalog /> },
  {
    path: 'rules',
    element: (
      <AdminPage section="rules" description="营业日与营业时间、扣款顺序、单笔上限、撤销时限、收款前开班、库存与采购。修改只影响之后的业务。">
        <RulesTab />
      </AdminPage>
    ),
  },
  { path: 'members', element: <MembersSection /> },
  { path: 'coupons', element: <CouponsSection /> },
  {
    path: 'catalog',
    element: (
      <AdminPage section="catalog" description="充值套餐、消费项目（多档价格）与价目表导入、门票票种与票价。">
        <CatalogTab />
      </AdminPage>
    ),
  },
  {
    path: 'tags',
    element: (
      <AdminPage section="tags" description="手牌池（分区、VIP 柜、锁定与停用）、柜号清单导入、前台规则。">
        <TagsTab />
      </AdminPage>
    ),
  },
  { path: 'technicians', element: <TechniciansSection /> },
  { path: 'dining', element: <DiningSection /> },
  { path: 'rooms', element: <RoomsSection /> },
  { path: 'spaces', element: <SpacesSection /> },
  { path: 'devices', element: <DevicesSection /> },
  {
    path: 'staff',
    element: (
      <AdminPage section="staff" description="员工账号、岗位与库存职责、重置密码；岗位能做什么见「岗位权限」。">
        <StaffTab />
      </AdminPage>
    ),
  },
  { path: 'permissions', element: <PermissionsSection /> },
  {
    path: 'opening',
    element: (
      <AdminPage section="opening" description="旧系统（EBC）会员余额导入为期初，与控制总数比对；导入错误时整批作废。">
        <OpeningTab />
      </AdminPage>
    ),
  },
  {
    path: 'audit',
    element: (
      <AdminPage section="audit" wide description="登录、授权、规则与价目变动、会员与收银操作的记录。">
        <AuditTab />
      </AdminPage>
    ),
  },
  { path: '*', element: <Navigate to="/admin" replace /> },
];
