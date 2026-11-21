import { useEffect, useSyncExternalStore } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ApiError, onAuthError, queryRetryDelay, shouldRetryQuery } from './lib/api';
import { qk, useSessionQuery } from './lib/queries';
import { SessionProvider } from './lib/session';
import { useApplyTheme } from './lib/theme';
import { setDisplayTimeZone } from './lib/utils';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NetworkBanner } from './components/NetworkBanner';
import { ToastProvider } from './components/Toast';
import { Button, Spinner } from './components/ui';
import { LogoMark } from './components/Brand';
import { LoginPage } from './features/auth/LoginPage';
// 网络与同步随首屏加载：断网时还要打得开（按需加载的页面那时可能下载不下来）
import { NetworkPage } from './features/network/NetworkPage';
import { ChangePasswordPage } from './features/auth/ChangePasswordPage';
import { ChoosePositionPage } from './features/auth/ChoosePositionPage';
import { WorkbenchPage } from './features/workbench/WorkbenchPage';
import { FrontdeskPage } from './features/frontdesk/FrontdeskPage';
import { DeskLayout } from './features/frontdesk/desk';
import { ADMIN_SECTIONS } from '@shared/admin';
import { adminRoutes } from './features/admin/AdminPage';
import { homeIsEmenu } from './lib/landing';
import { useCan, useOptionalSession } from './lib/session';
import { useErpAccess } from './features/erp/access';
import { lazyPage } from './lib/lazyPage';

// 会员工作台与前台随首屏加载；其余页面第一次打开时再下载（v0.7.22：收银台首屏更轻）
const CashierPage = lazyPage(() => import('./features/frontdesk/CashierPage').then((m) => m.CashierPage));
const ClockroomPage = lazyPage(() => import('./features/clockroom/ClockroomPage').then((m) => m.ClockroomPage));
const AnnouncerPage = lazyPage(() => import('./features/clockroom/AnnouncerPage').then((m) => m.AnnouncerPage));
const TechnicianAdminPage = lazyPage(() => import('./features/technicians/TechnicianAdminPage').then((m) => m.TechnicianAdminPage));
const DiningPage = lazyPage(() => import('./features/dining/DiningPage').then((m) => m.DiningPage));
const RoomCenterPage = lazyPage(() => import('./features/room-center/RoomCenterPage').then((m) => m.RoomCenterPage));
const BookingsPage = lazyPage(() => import('./features/bookings/BookingsPage').then((m) => m.BookingsPage));
const ParkingLogPage = lazyPage(() => import('./features/membership/ParkingLogCard').then((m) => m.ParkingLogPage));
const CouponIssuePage = lazyPage(() => import('./features/coupons/CouponIssuePage').then((m) => m.CouponIssuePage));
const ConciergePage = lazyPage(() => import('./features/concierge/ConciergePage').then((m) => m.ConciergePage));
const CustomerPage = lazyPage(() => import('./features/customer/CustomerPage').then((m) => m.CustomerPage));
const PlatformPage = lazyPage(() => import('./features/platform/PlatformPage').then((m) => m.PlatformPage));
const GuidePage = lazyPage(() => import('./features/guide/GuidePage').then((m) => m.GuidePage));
const GuideScreenPage = lazyPage(() => import('./features/guide/GuidePage').then((m) => m.GuideScreenPage));
const DevicesPage = lazyPage(() => import('./features/devices/DevicesPage').then((m) => m.DevicesPage));
// 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）：放在餐桌上的平板，没有导航
const EmenuPage = lazyPage(() => import('./features/emenu/EmenuPage').then((m) => m.EmenuPage));
// UI 工作台的编辑器（8.1.1）：整屏，只在打开时加载（平板不带编辑器）
const StudioPage = lazyPage(() => import('./features/studio/StudioPage').then((m) => m.StudioPage));
const PhonePreviewPage = lazyPage(() => import('./features/studio/PhonePreviewPage').then((m) => m.PhonePreviewPage));
const LedgerPage = lazyPage(() => import('./features/ledger/LedgerPage').then((m) => m.LedgerPage));
const SettlementPage = lazyPage(() => import('./features/settlement/SettlementPage').then((m) => m.SettlementPage));
const ShiftPage = lazyPage(() => import('./features/shift/ShiftPage').then((m) => m.ShiftPage));
const LookupPage = lazyPage(() => import('./features/membership/LookupPage').then((m) => m.LookupPage));
const AdminShell = lazyPage(() => import('./features/admin/AdminShell').then((m) => m.AdminShell));
const CheckoutPrintPage = lazyPage(() => import('./features/print/CheckoutPrintPage').then((m) => m.CheckoutPrintPage));
const ContractPrintPage = lazyPage(() => import('./features/print/ContractPrintPage').then((m) => m.ContractPrintPage));
const RefundPrintPage = lazyPage(() => import('./features/print/RefundPrintPage').then((m) => m.RefundPrintPage));
const SettlementPrintPage = lazyPage(() => import('./features/print/SettlementPrintPage').then((m) => m.SettlementPrintPage));
const CanteenCardsPrintPage = lazyPage(() => import('./features/canteen/CardsPrintPage').then((m) => m.CanteenCardsPrintPage));
const CanteenPosterPrintPage = lazyPage(() => import('./features/canteen/PosterPrintPage').then((m) => m.CanteenPosterPrintPage));
const PatrolCodesPrintPage = lazyPage(() => import('./features/patrol/CodesPrintPage').then((m) => m.PatrolCodesPrintPage));
const ShiftPrintPage = lazyPage(() => import('./features/print/ShiftPrintPage').then((m) => m.ShiftPrintPage));
// ERP 工作区
// 供应商在线对账确认（8.0.7 2.6）：供应商打开链接，不用登录
const ReconPublicPage = lazyPage(() => import('./features/payables/ReconPublicPage').then((m) => m.ReconPublicPage));
const SupplierPublicPage = lazyPage(() => import('./features/purchasing/SupplierPublicPage').then((m) => m.SupplierPublicPage));
const ErpShell = lazyPage(() => import('./features/erp/ErpShell').then((m) => m.ErpShell));
const ErpHome = lazyPage(() => import('./features/erp/ErpHome').then((m) => m.ErpHome));
const ErpSettingsPage = lazyPage(() => import('./features/erp/ErpSettingsPage').then((m) => m.ErpSettingsPage));
const ErpModulesMoved = lazyPage(() => import('./features/erp/ErpSettingsPage').then((m) => m.ErpModulesMoved));
const ExpensesPage = lazyPage(() => import('./features/expenses/ExpensesPage').then((m) => m.ExpensesPage));
const ClaimFormPage = lazyPage(() => import('./features/expenses/ClaimFormPage').then((m) => m.ClaimFormPage));
const PettyPage = lazyPage(() => import('./features/expenses/PettyPage').then((m) => m.PettyPage));
const PettyAccountsPage = lazyPage(() => import('./features/expenses/PettyAccountsPage').then((m) => m.PettyAccountsPage));
const BudgetsPage = lazyPage(() => import('./features/expenses/BudgetsPage').then((m) => m.BudgetsPage));
const AssetsPage = lazyPage(() => import('./features/assets/AssetsPage').then((m) => m.AssetsPage));
const LinenPage = lazyPage(() => import('./features/linen/LinenPage').then((m) => m.LinenPage));
const PettyPoolPage = lazyPage(() => import('./features/pool/PettyPoolPage').then((m) => m.PettyPoolPage));
const AssetLabelsPrintPage = lazyPage(() => import('./features/assets/AssetLabelsPrintPage').then((m) => m.AssetLabelsPrintPage));
const ReceivablesPage = lazyPage(() => import('./features/receivables/ReceivablesPage').then((m) => m.ReceivablesPage));
const InvoicesPage = lazyPage(() => import('./features/invoices/InvoicesPage').then((m) => m.InvoicesPage));
const SalesInvoicesPage = lazyPage(() => import('./features/sales-invoices/SalesInvoicesPage').then((m) => m.SalesInvoicesPage));
const BankPage = lazyPage(() => import('./features/bank/BankPage').then((m) => m.BankPage));
const RequestsPage = lazyPage(() => import('./features/requests/RequestsPage').then((m) => m.RequestsPage));
const RequestFormPage = lazyPage(() => import('./features/requests/RequestFormPage').then((m) => m.RequestFormPage));
const RequestSheetImportPage = lazyPage(() => import('./features/requests/RequestSheetImportPage').then((m) => m.RequestSheetImportPage));
const DeptStockPage = lazyPage(() => import('./features/dept-stock/DeptStockPage').then((m) => m.DeptStockPage));
const DeptDocFormPage = lazyPage(() => import('./features/dept-stock/DeptDocFormPage').then((m) => m.DeptDocFormPage));
const PurchaseLedgerPage = lazyPage(() => import('./features/purchase-ledger/PurchaseLedgerPage').then((m) => m.PurchaseLedgerPage));
const AuditPage = lazyPage(() => import('./features/purchase-ledger/AuditPage').then((m) => m.AuditPage));
const LegacyPage = lazyPage(() => import('./features/legacy/LegacyPage').then((m) => m.LegacyPage));
const ContractsPage = lazyPage(() => import('./features/contracts/ContractsPage').then((m) => m.ContractsPage));
const ContractDetailPage = lazyPage(() => import('./features/contracts/ContractDetailPage').then((m) => m.ContractDetailPage));
const ContractFormPage = lazyPage(() => import('./features/contracts/ContractFormPage').then((m) => m.ContractFormPage));
const PaymentsPage = lazyPage(() => import('./features/payments/PaymentsPage').then((m) => m.PaymentsPage));
const PaymentRequestPage = lazyPage(() => import('./features/payments/PaymentRequestPage').then((m) => m.PaymentRequestPage));
const PaymentRequestFormPage = lazyPage(() => import('./features/payments/PaymentRequestFormPage').then((m) => m.PaymentRequestFormPage));
const DocFormPage = lazyPage(() => import('./features/inventory/DocFormPage').then((m) => m.DocFormPage));
const InventoryPage = lazyPage(() => import('./features/inventory/InventoryPage').then((m) => m.InventoryPage));
const TodoPage = lazyPage(() => import('./features/inventory/TodoPage').then((m) => m.TodoPage));
const ApprovalsPage = lazyPage(() => import('./features/approvals/ApprovalsPage').then((m) => m.ApprovalsPage));
const PurchasingPage = lazyPage(() => import('./features/purchasing/PurchasingPage').then((m) => m.PurchasingPage));
const PoFormPage = lazyPage(() => import('./features/purchasing/PoFormPage').then((m) => m.PoFormPage));
const OrderedPage = lazyPage(() => import('./features/purchasing/OrderedPage').then((m) => m.OrderedPage));
const SuggestionsPage = lazyPage(() => import('./features/purchasing/SuggestionsPage').then((m) => m.SuggestionsPage));
const SourcingPage = lazyPage(() => import('./features/purchasing/SourcingPage').then((m) => m.SourcingPage));
const SourcingDetailPage = lazyPage(() => import('./features/purchasing/SourcingPage').then((m) => m.SourcingDetailPage));
const UrgentPage = lazyPage(() => import('./features/purchasing/UrgentPage').then((m) => m.UrgentPage));
const RequestImportPage = lazyPage(() => import('./features/purchasing/RequestImportPage').then((m) => m.RequestImportPage));
const ComparePage = lazyPage(() => import('./features/purchasing/ComparePage').then((m) => m.ComparePage));
const ScoresPage = lazyPage(() => import('./features/purchasing/ScoresPage').then((m) => m.ScoresPage));
const FlowPage = lazyPage(() => import('./features/purchasing/FlowPage').then((m) => m.FlowPage));
const UrgentDocFormPage = lazyPage(() => import('./features/inventory/DocFormPage').then((m) => m.UrgentDocFormPage));
const DirectDocFormPage = lazyPage(() => import('./features/inventory/DocFormPage').then((m) => m.DirectDocFormPage));
const LedgerImportPage = lazyPage(() => import('./features/inventory/LedgerImportPage').then((m) => m.LedgerImportPage));
const PayablesPage = lazyPage(() => import('./features/payables/PayablesPage').then((m) => m.PayablesPage));
const PaymentFormPage = lazyPage(() => import('./features/payables/PaymentFormPage').then((m) => m.PaymentFormPage));
const ImportPage = lazyPage(() => import('./features/payables/ImportPage').then((m) => m.ImportPage));
// 菜品管理的单独入口（8.1.15）：只有菜品权限、进不了餐饮的岗位用；别的人在餐饮的「菜品管理」页签里
const DishesPage = lazyPage(() => import('./features/dining/DishesPage').then((m) => m.DishesPage));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 明确的拒绝不再取；系统忙、太频繁、过载在请求里已经重发过，不再叠一层；其余最多 2 次，间隔带随机（8.1.3 WL5）
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

/** 登录守卫：未登录跳转登录页；首次登录强制修改密码。shell：app 为门店（带导航栏），admin 为管理后台，erp 为 ERP 工作区，bare 用于打印页 */
function AuthGate({ shell = 'app' }: { shell?: 'app' | 'admin' | 'erp' | 'bare' }) {
  const session = useSessionQuery();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  useEffect(
    () =>
      onAuthError((error) => {
        if (error.status === 401) {
          qc.clear();
          navigate('/login', { replace: true, state: { expired: true } });
        } else {
          void qc.invalidateQueries({ queryKey: qk.session });
        }
      }),
    [navigate, qc],
  );

  useEffect(() => {
    if (session.data) setDisplayTimeZone(session.data.timezone);
  }, [session.data]);

  if (session.isPending) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-paper">
        <LogoMark className="size-12 animate-pulse" />
        <Spinner />
      </div>
    );
  }
  // 只有 401 才是会话失效：服务器一时出错、断网时不跳登录页，已打开的页面与没提交的内容保留（PR #13 P2-2）
  const expired = session.error instanceof ApiError && session.error.status === 401;
  if (!session.data && session.error && !expired) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-paper px-6 text-center" data-testid="session-unavailable">
        <LogoMark className="size-12" />
        <p className="text-[16px] font-bold text-ink">暂时连不上服务器</p>
        <p className="max-w-sm text-[13px] text-ink-3">登录状态没有丢，稍后重试即可；一直连不上请联系值班经理。</p>
        <Button variant="primary" loading={session.isFetching} onClick={() => void session.refetch()}>
          重试
        </Button>
      </div>
    );
  }
  if (!session.data || expired) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (session.data.staff.mustChangePassword) {
    return (
      <SessionProvider value={session.data}>
        <ChangePasswordPage forced />
      </SessionProvider>
    );
  }
  // 老账号这一版以后第一次登录先选新岗位（8.1.18，GW7）
  if (session.data.staff.needsPosition) {
    return (
      <SessionProvider value={session.data}>
        <ChoosePositionPage />
      </SessionProvider>
    );
  }
  // 内容区出错只换掉内容区（8.1.3 WL7）：导航还能用，换页面自动重置；后台、ERP 的在各自的外壳里包
  return (
    <SessionProvider value={session.data}>
      {shell === 'bare' ? (
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      ) : shell === 'admin' ? (
        <AdminShell />
      ) : shell === 'erp' ? (
        <ErpShell />
      ) : (
        <AppShell>
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </AppShell>
      )}
    </SessionProvider>
  );
}

/** 首页：前台进入会员工作台；只用 ERP 的人（库存、采购、货款职责）直接进 ERP 的第一个模块；只管厨房的岗位进入餐饮，只管客房打扫的进入客房 */
function Home() {
  const can = useCan();
  const erp = useErpAccess();
  const session = useOptionalSession();
  const dining = session?.dining ?? false;
  if (can('member.read')) return <WorkbenchPage />;
  // 设计师（8.1.1）：只进工作台
  if (can('studio.edit') && !can('frontdesk.read')) return <Navigate to="/admin/studio" replace />;
  // 「点餐平板」账号（8.0.10）：只能打开点餐页，登录后直接进去
  if (homeIsEmenu(can)) return <Navigate to="/emenu" replace />;
  // 他店查询（v0.7.23）：另一家店的同事只能查会员档阶
  if (can('member.lookup')) return <Navigate to="/lookup" replace />;
  if (erp.landing) return <Navigate to={erp.landing} replace />;
  // 管家（8.0.12）：后勤岗位加了管家职责的，登录后直接进管家部。排在「点餐平板」「他店查询」「只用 ERP」之后——
  // 原来排在最前面：以后给别的岗位勾上管家部的查看权限，平板、库管、采购登录都会被带到管家部（整改）
  if (can('concierge.read')) return <Navigate to="/concierge" replace />;
  if (dining && (can('dining.kitchen') || can('dining.order'))) return <Navigate to="/dining" replace />;
  if (session?.rooms && (can('room.operate') || can('room.housekeep'))) return <Navigate to="/room-center" replace />;
  if (erp.canEnter) return <Navigate to="/erp" replace />;
  // 只有「看对客导览」的账号（门店大屏）：直接进大屏模式
  if (can('guide.view')) return <Navigate to="/guide/screen" replace />;
  return <Navigate to="/password" replace />;
}

/**
 * 原来的「客房」页（/rooms）8.1.16 起并进了房态中心（docs/ROOM_CENTER_V8115.md 第 7 节）：带上查询参数跳过去——
 * 房态看板 → 「客房」页签，派对房看板 → 派对房的页签，平面图 → 「视图 → 平面图」；预约到店（booking）、结果待确认（resume）照旧
 */
function RoomsMoved() {
  const { search } = useLocation();
  const next = new URLSearchParams(search);
  const view = next.get('view');
  next.delete('view');
  if (view === 'map') next.set('view', 'map');
  else if (!next.has('resume') && !next.has('booking')) next.set('tab', view === 'party' ? 'party' : 'hotel');
  const q = next.toString();
  return <Navigate to={`/room-center${q ? `?${q}` : ''}`} replace />;
}

/** 门店的旧地址 /dashboard、/dashboard/<页签>：看板 2026-11-10 起在后台「数据看板」，带上页签与查询参数跳过去 */
function DashboardMoved() {
  const { tab } = useParams();
  const { search } = useLocation();
  return <Navigate to={`${ADMIN_SECTIONS.dashboard.path}${tab ? `/${tab}` : ''}${search}`} replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  // 网络与同步（8.1.3 WL12）：不用登录也能打开——断网、登录页出问题时也要看得到
  { path: '/network', element: <NetworkPage /> },
  { path: '/r/:token', element: <ReconPublicPage /> },
  // 8.0.21 供应商门户：报价、订单确认、发货预告（不用登录）
  { path: '/s/:token', element: <SupplierPublicPage /> },
  {
    path: '/print',
    element: <AuthGate shell="bare" />,
    children: [
      { path: 'checkout/:id', element: <CheckoutPrintPage /> },
      { path: 'refund/:id', element: <RefundPrintPage /> },
      { path: 'shift/:id', element: <ShiftPrintPage /> },
      { path: 'settlement/:date', element: <SettlementPrintPage /> },
      // 员工食堂的开通卡片（A4）
      { path: 'canteen-cards/:ids', element: <CanteenCardsPrintPage /> },
      { path: 'canteen-poster', element: <CanteenPosterPrintPage /> },
      { path: 'patrol-codes/:ids', element: <PatrolCodesPrintPage /> },
      // 资产标签（8.0.7）
      { path: 'asset-labels/:ids', element: <AssetLabelsPrintPage /> },
      // 合同（8.0.21）：A4，打印或存为 PDF
      { path: 'contract/:id', element: <ContractPrintPage /> },
    ],
  },
  // 对客导览的大屏模式（v0.7.19）：没有导航与操作，适合门店大屏常开
  { path: '/guide/screen', element: <AuthGate shell="bare" />, children: [{ index: true, element: <GuideScreenPage /> }] },
  // 平板点餐页（8.0.10）：整页是设计师的电子菜单，没有门店系统的导航
  { path: '/emenu', element: <AuthGate shell="bare" />, children: [{ index: true, element: <EmenuPage /> }] },
  // UI 工作台的编辑器（8.1.1，docs/WORKBENCH_V811.md）：整屏的画布；后台「工作台」分区点进来
  { path: '/studio/:surface', element: <AuthGate shell="bare" />, children: [{ index: true, element: <StudioPage /> }] },
  // 手机界面（小程序、员工食堂）的预览（8.1.2）：按预览码画出当时的草稿，375 宽
  { path: '/studio-preview/:surface/:code', element: <AuthGate shell="bare" />, children: [{ index: true, element: <PhonePreviewPage /> }] },
  { path: '/admin/concierge', element: <Navigate to="/concierge" replace /> },
  { path: '/admin', element: <AuthGate shell="admin" />, children: adminRoutes },
  // ERP 工作区（v0.7.3）：首页、模块设置、营业数据，以及库存、采购、货款、待办（原来的地址不变，门店主导航里不再有）。
  // 页面属于哪个模块按注册表（@shared/erp）里的页面前缀认，模块关着时 ERP 外壳提示没有开启
  {
    path: '/erp',
    element: <AuthGate shell="erp" />,
    children: [
      { index: true, element: <ErpHome /> },
      // 8.0.18：ERP 的规则收成「ERP 设置」；模块设置、营业数据、员工食堂、安保巡场的旧地址跳到新位置（docs/IA_V8017.md 第 3.3 节）
      { path: 'settings/:tab?', element: <ErpSettingsPage /> },
      { path: 'modules', element: <ErpModulesMoved /> },
      { path: 'revenue', element: <Navigate to="/admin/dashboard/revenue" replace /> },
      { path: 'expenses', element: <ExpensesPage /> },
      { path: 'expenses/new', element: <ClaimFormPage /> },
      // 费用预算与进项发票台账（8.0.3）
      { path: 'expenses/budgets', element: <BudgetsPage /> },
      { path: 'invoices', element: <InvoicesPage /> },
      { path: 'sales-invoices', element: <SalesInvoicesPage /> },
      { path: 'bank', element: <BankPage /> },
      { path: 'receivables', element: <ReceivablesPage /> },
      { path: 'assets', element: <AssetsPage /> },
      // 布草洗涤（8.0.20）
      { path: 'linen', element: <LinenPage /> },
      // 零采备用金（8.1.9）
      { path: 'pool', element: <PettyPoolPage /> },
      { path: 'petty', element: <PettyPage /> },
      { path: 'petty/accounts', element: <PettyAccountsPage /> },
      { path: 'requests', element: <RequestsPage /> },
      { path: 'dept-stock', element: <DeptStockPage /> },
      { path: 'dept-stock/new/:type', element: <DeptDocFormPage /> },
      { path: 'dept-stock/docs/:id/edit', element: <DeptDocFormPage /> },
      { path: 'requests/new', element: <RequestFormPage mode="new" /> },
      { path: 'requests/import', element: <RequestSheetImportPage /> },
      { path: 'requests/:id/edit', element: <RequestFormPage mode="edit" /> },
      { path: 'ledger', element: <PurchaseLedgerPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'legacy', element: <LegacyPage /> },
      // 合同与法务审查（v0.7.31）
      { path: 'contracts', element: <ContractsPage /> },
      { path: 'contracts/new', element: <ContractFormPage mode="new" /> },
      { path: 'contracts/:id', element: <ContractDetailPage /> },
      { path: 'contracts/:id/edit', element: <ContractFormPage mode="edit" /> },
      { path: 'contracts/:id/change', element: <ContractFormPage mode="change" /> },
      { path: 'contracts/:id/changes/:changeId/edit', element: <ContractFormPage mode="change-edit" /> },
      // 付款流（v0.7.32）
      { path: 'payments', element: <PaymentsPage /> },
      { path: 'payments/requests/new', element: <PaymentRequestFormPage /> },
      { path: 'payments/requests/:id', element: <PaymentRequestPage /> },
      // 员工食堂 · 柚子饭堂（docs/CANTEEN.md）
      { path: 'canteen', element: <Navigate to="/admin/canteen" replace /> },
      { path: 'patrol', element: <Navigate to="/admin/patrol" replace /> },
      { path: '*', element: <Navigate to="/erp" replace /> },
    ],
  },
  {
    element: <AuthGate shell="erp" />,
    children: [
      // 库管入库与台账导入（8.1.9）
      { path: 'inventory/direct/new', element: <DirectDocFormPage /> },
      { path: 'inventory/direct/import', element: <LedgerImportPage /> },
      { path: 'inventory/direct/:id/edit', element: <DirectDocFormPage /> },
      { path: 'inventory/new/:type', element: <DocFormPage /> },
      { path: 'inventory/docs/:id/edit', element: <DocFormPage /> },
      { path: 'inventory/:tab?', element: <InventoryPage /> },
      { path: 'todo', element: <TodoPage /> },
      { path: 'approvals', element: <ApprovalsPage /> },
      { path: 'purchasing', element: <PurchasingPage /> },
      { path: 'purchasing/new', element: <PoFormPage mode="new" /> },
      { path: 'purchasing/ordered', element: <OrderedPage /> },
      { path: 'purchasing/flow', element: <FlowPage /> },
      { path: 'purchasing/suggestions', element: <SuggestionsPage /> },
      { path: 'purchasing/sourcing', element: <SourcingPage /> },
      { path: 'purchasing/sourcing/:id', element: <SourcingDetailPage /> },
      // 急采（8.0.1 采购组整改 05：由采购登记、按金额分级审批）
      { path: 'purchasing/urgent', element: <UrgentPage /> },
      { path: 'purchasing/urgent/new', element: <UrgentDocFormPage /> },
      { path: 'purchasing/urgent/:id/edit', element: <UrgentDocFormPage /> },
      // 采购规则（8.0.1 采购组整改 01：从 ERP「模块设置」挪过来）
      { path: 'purchasing/rules', element: <Navigate to="/erp/settings/purchase" replace /> },
      // 集采导入（8.0.1 采购组整改 06）
      { path: 'purchasing/import', element: <RequestImportPage /> },
      // 供应商比价看板（8.0.1 采购组整改 07）
      { path: 'purchasing/compare', element: <ComparePage /> },
      { path: 'purchasing/scores', element: <ScoresPage /> },
      { path: 'purchasing/:id/edit', element: <PoFormPage mode="edit" /> },
      { path: 'purchasing/:id/revise', element: <PoFormPage mode="revise" /> },
      { path: 'payables', element: <PayablesPage /> },
      { path: 'payables/pay', element: <PaymentFormPage /> },
      { path: 'payables/import', element: <ImportPage /> },
    ],
  },
  {
    element: <AuthGate />,
    children: [
      { index: true, element: <Home /> },
      // 8.1.15：原「前台」拆成发卡台（/frontdesk，地址沿用）与收银台（/cashier）；两个台共用一个补录纸质单的状态
      {
        element: <DeskLayout />,
        children: [
          { path: 'frontdesk', element: <FrontdeskPage /> },
          { path: 'cashier', element: <CashierPage /> },
        ],
      },
      { path: 'clockroom', element: <ClockroomPage /> },
      // 排位播报（8.2.0 P03）：独立页面；老地址跳过来并提示位置换了
      { path: 'announcer', element: <AnnouncerPage /> },
      { path: 'clockroom/announcer', element: <Navigate to="/announcer?moved=1" replace /> },
      { path: 'dining/:tab?', element: <DiningPage /> },
      { path: 'room-center', element: <RoomCenterPage /> },
      { path: 'rooms', element: <RoomsMoved /> },
      { path: 'bookings', element: <BookingsPage /> },
      // 发券（8.0.19，IA4）：批量发券、无记名券从后台「券」挪到门店，会员工作台右上角进
      { path: 'coupon-issue/:tab?', element: <CouponIssuePage /> },
      // 停车登记（8.0.19，IA4）：从后台「会员权益」最下面挪到门店
      { path: 'parking-log', element: <ParkingLogPage /> },
      // 管家部（8.0.12）：门店的工作页面；/admin/concierge 是 Codex 最初放的地址，留着跳过来
      // 8.0.18：哪一页写进地址（/concierge/members、/concierge/praise……），见 Workspace.tsx 的 VIEW_SLUG
      { path: 'concierge/:view?', element: <ConciergePage /> },
      { path: 'customer', element: <CustomerPage /> },
      { path: 'platform', element: <PlatformPage /> },
      { path: 'guide', element: <GuidePage /> },
      { path: 'devices', element: <DevicesPage /> },
      { path: 'ledger', element: <LedgerPage /> },
      { path: 'settlement/:date?', element: <SettlementPage /> },
      { path: 'shift', element: <ShiftPage /> },
      // 看板 2026-11-10 起在后台（「数据看板」）：门店的旧地址跳过去，页签与查询参数照带
      { path: 'dashboard/:tab?', element: <DashboardMoved /> },
      { path: 'lookup', element: <LookupPage /> },
      // 技师管理（8.1.15）：技师名册、组别、班次、休假四个页签
      { path: 'technicians/:tab?', element: <TechnicianAdminPage /> },
      { path: 'password', element: <ChangePasswordPage /> },
      { path: 'dishes', element: <DishesPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

/** 当前地址（网络提示条在路由外面，按地址决定缩成角落的小提示、打印页不显示） */
const useRouterPath = () =>
  useSyncExternalStore(
    (fn) => router.subscribe(fn),
    () => router.state.location.pathname,
  );

/** 深浅主题落到 <html> 上（8.1.15）：对客与出纸的页面一律浅色 */
function ThemeHost() {
  useApplyTheme(useRouterPath());
  return null;
}

function NetworkBannerHost() {
  const path = useRouterPath();
  return <NetworkBanner path={path} openNetwork={() => void router.navigate('/network')} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
        <NetworkBannerHost />
        <ThemeHost />
      </ToastProvider>
    </QueryClientProvider>
  );
}
