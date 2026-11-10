import { useEffect } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ApiError, onAuthError } from './lib/api';
import { qk, useSessionQuery } from './lib/queries';
import { SessionProvider } from './lib/session';
import { setDisplayTimeZone } from './lib/utils';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './components/Toast';
import { Button, Spinner } from './components/ui';
import { LogoMark } from './components/Brand';
import { LoginPage } from './features/auth/LoginPage';
import { ChangePasswordPage } from './features/auth/ChangePasswordPage';
import { WorkbenchPage } from './features/workbench/WorkbenchPage';
import { FrontdeskPage } from './features/frontdesk/FrontdeskPage';
import { adminRoutes } from './features/admin/AdminPage';
import { useCan, useOptionalSession } from './lib/session';
import { useErpAccess } from './features/erp/access';
import { lazyPage } from './lib/lazyPage';

// 会员工作台与前台随首屏加载；其余页面第一次打开时再下载（v0.7.22：收银台首屏更轻）
const ClockroomPage = lazyPage(() => import('./features/clockroom/ClockroomPage').then((m) => m.ClockroomPage));
const DiningPage = lazyPage(() => import('./features/dining/DiningPage').then((m) => m.DiningPage));
const RoomsPage = lazyPage(() => import('./features/rooms/RoomsPage').then((m) => m.RoomsPage));
const BookingsPage = lazyPage(() => import('./features/bookings/BookingsPage').then((m) => m.BookingsPage));
const PlatformPage = lazyPage(() => import('./features/platform/PlatformPage').then((m) => m.PlatformPage));
const GuidePage = lazyPage(() => import('./features/guide/GuidePage').then((m) => m.GuidePage));
const GuideScreenPage = lazyPage(() => import('./features/guide/GuidePage').then((m) => m.GuideScreenPage));
const DevicesPage = lazyPage(() => import('./features/devices/DevicesPage').then((m) => m.DevicesPage));
const LedgerPage = lazyPage(() => import('./features/ledger/LedgerPage').then((m) => m.LedgerPage));
const SettlementPage = lazyPage(() => import('./features/settlement/SettlementPage').then((m) => m.SettlementPage));
const ShiftPage = lazyPage(() => import('./features/shift/ShiftPage').then((m) => m.ShiftPage));
const DashboardPage = lazyPage(() => import('./features/dashboard/DashboardPage').then((m) => m.DashboardPage));
const LookupPage = lazyPage(() => import('./features/membership/LookupPage').then((m) => m.LookupPage));
const AdminShell = lazyPage(() => import('./features/admin/AdminShell').then((m) => m.AdminShell));
const CheckoutPrintPage = lazyPage(() => import('./features/print/CheckoutPrintPage').then((m) => m.CheckoutPrintPage));
const RefundPrintPage = lazyPage(() => import('./features/print/RefundPrintPage').then((m) => m.RefundPrintPage));
const SettlementPrintPage = lazyPage(() => import('./features/print/SettlementPrintPage').then((m) => m.SettlementPrintPage));
const CanteenCardsPrintPage = lazyPage(() => import('./features/canteen/CardsPrintPage').then((m) => m.CanteenCardsPrintPage));
const CanteenPosterPrintPage = lazyPage(() => import('./features/canteen/PosterPrintPage').then((m) => m.CanteenPosterPrintPage));
const ShiftPrintPage = lazyPage(() => import('./features/print/ShiftPrintPage').then((m) => m.ShiftPrintPage));
// ERP 工作区
const ErpShell = lazyPage(() => import('./features/erp/ErpShell').then((m) => m.ErpShell));
const ErpHome = lazyPage(() => import('./features/erp/ErpHome').then((m) => m.ErpHome));
const ErpModulesPage = lazyPage(() => import('./features/erp/ErpModulesPage').then((m) => m.ErpModulesPage));
const RevenuePage = lazyPage(() => import('./features/erp/RevenuePage').then((m) => m.RevenuePage));
const ExpensesPage = lazyPage(() => import('./features/expenses/ExpensesPage').then((m) => m.ExpensesPage));
const ClaimFormPage = lazyPage(() => import('./features/expenses/ClaimFormPage').then((m) => m.ClaimFormPage));
const PettyPage = lazyPage(() => import('./features/expenses/PettyPage').then((m) => m.PettyPage));
const PettyAccountsPage = lazyPage(() => import('./features/expenses/PettyAccountsPage').then((m) => m.PettyAccountsPage));
const BudgetsPage = lazyPage(() => import('./features/expenses/BudgetsPage').then((m) => m.BudgetsPage));
const InvoicesPage = lazyPage(() => import('./features/invoices/InvoicesPage').then((m) => m.InvoicesPage));
const RequestsPage = lazyPage(() => import('./features/requests/RequestsPage').then((m) => m.RequestsPage));
const RequestFormPage = lazyPage(() => import('./features/requests/RequestFormPage').then((m) => m.RequestFormPage));
const DeptStockPage = lazyPage(() => import('./features/dept-stock/DeptStockPage').then((m) => m.DeptStockPage));
const DeptDocFormPage = lazyPage(() => import('./features/dept-stock/DeptDocFormPage').then((m) => m.DeptDocFormPage));
const PurchaseLedgerPage = lazyPage(() => import('./features/purchase-ledger/PurchaseLedgerPage').then((m) => m.PurchaseLedgerPage));
const AuditPage = lazyPage(() => import('./features/purchase-ledger/AuditPage').then((m) => m.AuditPage));
const LegacyPage = lazyPage(() => import('./features/legacy/LegacyPage').then((m) => m.LegacyPage));
const ContractsPage = lazyPage(() => import('./features/contracts/ContractsPage').then((m) => m.ContractsPage));
const ContractDetailPage = lazyPage(() => import('./features/contracts/ContractDetailPage').then((m) => m.ContractDetailPage));
const ContractFormPage = lazyPage(() => import('./features/contracts/ContractFormPage').then((m) => m.ContractFormPage));
const PaymentsPage = lazyPage(() => import('./features/payments/PaymentsPage').then((m) => m.PaymentsPage));
const CanteenPage = lazyPage(() => import('./features/canteen/CanteenPage').then((m) => m.CanteenPage));
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
const PurchaseRulesPage = lazyPage(() => import('./features/purchasing/PurchaseRulesPage').then((m) => m.PurchaseRulesPage));
const RequestImportPage = lazyPage(() => import('./features/purchasing/RequestImportPage').then((m) => m.RequestImportPage));
const ComparePage = lazyPage(() => import('./features/purchasing/ComparePage').then((m) => m.ComparePage));
const UrgentDocFormPage = lazyPage(() => import('./features/inventory/DocFormPage').then((m) => m.UrgentDocFormPage));
const PayablesPage = lazyPage(() => import('./features/payables/PayablesPage').then((m) => m.PayablesPage));
const PaymentFormPage = lazyPage(() => import('./features/payables/PaymentFormPage').then((m) => m.PaymentFormPage));
const ImportPage = lazyPage(() => import('./features/payables/ImportPage').then((m) => m.ImportPage));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
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
  return (
    <SessionProvider value={session.data}>
      {shell === 'bare' ? (
        <Outlet />
      ) : shell === 'admin' ? (
        <AdminShell />
      ) : shell === 'erp' ? (
        <ErpShell />
      ) : (
        <AppShell>
          <Outlet />
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
  // 他店查询（v0.7.23）：另一家店的同事只能查会员档阶
  if (can('member.lookup')) return <Navigate to="/lookup" replace />;
  if (erp.landing) return <Navigate to={erp.landing} replace />;
  if (dining && (can('dining.kitchen') || can('dining.order'))) return <Navigate to="/dining" replace />;
  if (session?.rooms && (can('room.operate') || can('room.housekeep'))) return <Navigate to="/rooms" replace />;
  if (erp.canEnter) return <Navigate to="/erp" replace />;
  // 只有「看对客导览」的账号（门店大屏）：直接进大屏模式
  if (can('guide.view')) return <Navigate to="/guide/screen" replace />;
  return <Navigate to="/password" replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
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
    ],
  },
  // 对客导览的大屏模式（v0.7.19）：没有导航与操作，适合门店大屏常开
  { path: '/guide/screen', element: <AuthGate shell="bare" />, children: [{ index: true, element: <GuideScreenPage /> }] },
  { path: '/admin', element: <AuthGate shell="admin" />, children: adminRoutes },
  // ERP 工作区（v0.7.3）：首页、模块设置、营业数据，以及库存、采购、货款、待办（原来的地址不变，门店主导航里不再有）。
  // 页面属于哪个模块按注册表（@shared/erp）里的页面前缀认，模块关着时 ERP 外壳提示没有开启
  {
    path: '/erp',
    element: <AuthGate shell="erp" />,
    children: [
      { index: true, element: <ErpHome /> },
      { path: 'modules', element: <ErpModulesPage /> },
      { path: 'revenue', element: <RevenuePage /> },
      { path: 'expenses', element: <ExpensesPage /> },
      { path: 'expenses/new', element: <ClaimFormPage /> },
      // 费用预算与进项发票台账（8.0.3）
      { path: 'expenses/budgets', element: <BudgetsPage /> },
      { path: 'invoices', element: <InvoicesPage /> },
      { path: 'petty', element: <PettyPage /> },
      { path: 'petty/accounts', element: <PettyAccountsPage /> },
      { path: 'requests', element: <RequestsPage /> },
      { path: 'dept-stock', element: <DeptStockPage /> },
      { path: 'dept-stock/new/:type', element: <DeptDocFormPage /> },
      { path: 'dept-stock/docs/:id/edit', element: <DeptDocFormPage /> },
      { path: 'requests/new', element: <RequestFormPage mode="new" /> },
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
      { path: 'canteen', element: <CanteenPage /> },
      { path: '*', element: <Navigate to="/erp" replace /> },
    ],
  },
  {
    element: <AuthGate shell="erp" />,
    children: [
      { path: 'inventory/new/:type', element: <DocFormPage /> },
      { path: 'inventory/docs/:id/edit', element: <DocFormPage /> },
      { path: 'inventory/:tab?', element: <InventoryPage /> },
      { path: 'todo', element: <TodoPage /> },
      { path: 'approvals', element: <ApprovalsPage /> },
      { path: 'purchasing', element: <PurchasingPage /> },
      { path: 'purchasing/new', element: <PoFormPage mode="new" /> },
      { path: 'purchasing/ordered', element: <OrderedPage /> },
      { path: 'purchasing/suggestions', element: <SuggestionsPage /> },
      { path: 'purchasing/sourcing', element: <SourcingPage /> },
      { path: 'purchasing/sourcing/:id', element: <SourcingDetailPage /> },
      // 急采（8.0.1 采购组整改 05：由采购登记、按金额分级审批）
      { path: 'purchasing/urgent', element: <UrgentPage /> },
      { path: 'purchasing/urgent/new', element: <UrgentDocFormPage /> },
      { path: 'purchasing/urgent/:id/edit', element: <UrgentDocFormPage /> },
      // 采购规则（8.0.1 采购组整改 01：从 ERP「模块设置」挪过来）
      { path: 'purchasing/rules', element: <PurchaseRulesPage /> },
      // 集采导入（8.0.1 采购组整改 06）
      { path: 'purchasing/import', element: <RequestImportPage /> },
      // 供应商比价看板（8.0.1 采购组整改 07）
      { path: 'purchasing/compare', element: <ComparePage /> },
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
      { path: 'frontdesk', element: <FrontdeskPage /> },
      { path: 'clockroom', element: <ClockroomPage /> },
      { path: 'dining/:tab?', element: <DiningPage /> },
      { path: 'rooms', element: <RoomsPage /> },
      { path: 'bookings', element: <BookingsPage /> },
      { path: 'platform', element: <PlatformPage /> },
      { path: 'guide', element: <GuidePage /> },
      { path: 'devices', element: <DevicesPage /> },
      { path: 'ledger', element: <LedgerPage /> },
      { path: 'settlement/:date?', element: <SettlementPage /> },
      { path: 'shift', element: <ShiftPage /> },
      { path: 'dashboard/:tab?', element: <DashboardPage /> },
      { path: 'lookup', element: <LookupPage /> },
      { path: 'password', element: <ChangePasswordPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
