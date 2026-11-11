// 管理后台的路由（v0.6.0）：/admin 下各分区；旧的「管理」页的 /admin/<分区> 地址不变。

import type { RouteObject } from 'react-router';
import { Navigate } from 'react-router';
import { lazyPage } from '../../lib/lazyPage';

// 各分区第一次打开时再下载（v0.7.22）；门店前台用不到这些代码
const AdminHome = lazyPage(() => import('./AdminHome').then((m) => m.AdminHome));
const AdminPage = lazyPage(() => import('./AdminShell').then((m) => m.AdminPage));
const AuditTab = lazyPage(() => import('./AuditTab').then((m) => m.AuditTab));
const CatalogTab = lazyPage(() => import('./CatalogTab').then((m) => m.CatalogTab));
const CouponsSection = lazyPage(() => import('./CouponsSection').then((m) => m.CouponsSection));
// 数据看板（店主 2026-11-10：门店主导航的「看板」整合到后台）
const DashboardPage = lazyPage(() => import('../dashboard/DashboardPage').then((m) => m.DashboardPage));
const DevicesSection = lazyPage(() => import('./DevicesSection').then((m) => m.DevicesSection));
const DiningSection = lazyPage(() => import('./DiningSection').then((m) => m.DiningSection));
// 电子菜单（8.0.10，docs/EMENU.md）：餐桌平板上的菜单在这里排
const EmenuAdminSection = lazyPage(() => import('../emenu/EmenuAdminSection').then((m) => m.EmenuAdminSection));
const MembersSection = lazyPage(() => import('./MembersSection').then((m) => m.MembersSection));
// 微信小程序（小程序线）
const MpAdminSection = lazyPage(() => import('../mp/MpAdminSection').then((m) => m.MpAdminSection));
const MembershipRulesSection = lazyPage(() => import('../membership/RulesSection').then((m) => m.MembershipRulesSection));
const BenefitsSection = lazyPage(() => import('../membership/BenefitsSection').then((m) => m.BenefitsSection));
const OpeningTab = lazyPage(() => import('./OpeningTab').then((m) => m.OpeningTab));
const PermissionsSection = lazyPage(() => import('./PermissionsSection').then((m) => m.PermissionsSection));
const RoomsSection = lazyPage(() => import('./RoomsSection').then((m) => m.RoomsSection));
const BookingsSection = lazyPage(() => import('./BookingsSection').then((m) => m.BookingsSection));
const RuleCatalog = lazyPage(() => import('./RuleCatalog').then((m) => m.RuleCatalog));
const RulesTab = lazyPage(() => import('./RulesTab').then((m) => m.RulesTab));
const SpacesSection = lazyPage(() => import('./SpacesSection').then((m) => m.SpacesSection));
const StaffTab = lazyPage(() => import('./StaffTab').then((m) => m.StaffTab));
const TagsTab = lazyPage(() => import('./TagsTab').then((m) => m.TagsTab));
const TechniciansSection = lazyPage(() => import('./TechniciansSection').then((m) => m.TechniciansSection));

const ConciergePage = lazyPage(() => import('../concierge/ConciergePage').then(m => m.ConciergePage));

export const adminRoutes: RouteObject[] = [
  { path: 'concierge', element: <ConciergePage /> },
  { index: true, element: <AdminHome /> },
  { path: 'dashboard/:tab?', element: <DashboardPage /> },
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
  { path: 'membership', element: <MembershipRulesSection /> },
  { path: 'benefits', element: <BenefitsSection /> },
  // VIP 柜 8.0.4 起归「会员权益」：旧入口（会员规则、手牌与前台）的「去设置」都跳到这里
  { path: 'vip-lockers', element: <Navigate to="/admin/benefits?view=vip" replace /> },
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
  { path: 'emenu', element: <EmenuAdminSection /> },
  { path: 'rooms', element: <RoomsSection /> },
  { path: 'bookings', element: <BookingsSection /> },
  { path: 'spaces', element: <SpacesSection /> },
  { path: 'devices', element: <DevicesSection /> },
  { path: 'mp', element: <MpAdminSection /> },
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
      <AdminPage section="opening" description="旧系统（EBC）会员余额导入为期初，与控制总数比对；导入错误时整批作废。旧系统逐笔流水只读导入，会员详情里看。">
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
