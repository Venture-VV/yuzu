import { useEffect } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useNavigate, useParams } from 'react-router';
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
import { ADMIN_SECTIONS } from '@shared/admin';
import { adminRoutes } from './features/admin/AdminPage';
import { useCan, useOptionalSession } from './lib/session';
import { useErpAccess } from './features/erp/access';
import { lazyPage } from './lib/lazyPage';

// 会员工作台与前台随首屏加载；其余页面第一次打开时再下载（v0.7.22：收银台首屏更轻）
const ClockroomPage = lazyPage(() => import('./features/clockroom/ClockroomPage').then((m) => m.ClockroomPage));
const DiningPage = lazyPage(() => import('./features/dining/DiningPage').then((m) => m.DiningPage));
const RoomsPage = lazyPage(() => import('./features/rooms/RoomsPage').then((m) => m.RoomsPage));
const BookingsPage = lazyPage(() => import('./features/bookings/BookingsPage').then((m) => m.BookingsPage));
const ConciergePage = lazyPage(() => import('./features/concierge/ConciergePage').then((m) => m.ConciergePage));
const PlatformPage = lazyPage(() => import('./features/platform/PlatformPage').then((m) => m.PlatformPage));
const GuidePage = lazyPage(() => import('./features/guide/GuidePage').then((m) => m.GuidePage));
const GuideScreenPage = lazyPage(() => import('./features/guide/GuidePage').then((m) => m.GuideScreenPage));
const DevicesPage = lazyPage(() => import('./features/devices/DevicesPage').then((m) => m.DevicesPage));
// 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）：放在餐桌上的平板，没有导航
const EmenuPage = lazyPage(() => import('./features/emenu/EmenuPage').then((m) => m.EmenuPage));
const LedgerPage = lazyPage(() => import('./features/ledger/LedgerPage').then((m) => m.LedgerPage));
const SettlementPage = lazyPage(() => import('./features/settlement/SettlementPage').then((m) => m.SettlementPage));
const ShiftPage = lazyPage(() => import('./features/shift/ShiftPage').then((m) => m.ShiftPage));
const LookupPage = lazyPage(() => import('./features/membership/LookupPage').then((m) => m.LookupPage));
const AdminShell = lazyPage(() => import('./features/admin/AdminShell').then((m) => m.AdminShell));
const CheckoutPrintPage = lazyPage(() => import('./features/print/CheckoutPrintPage').then((m) => m.CheckoutPrintPage));
const RefundPrintPage = lazyPage(() => import('./features/print/RefundPrintPage').then((m) => m.RefundPrintPage));
const SettlementPrintPage = lazyPage(() => import('./features/print/SettlementPrintPage').then((m) => m.SettlementPrintPage));
const CanteenCardsPrintPage = lazyPage(() => import('./features/canteen/CardsPrintPage').then((m) => m.CanteenCardsPrintPage));
const CanteenPosterPrintPage = lazyPage(() => import('./features/canteen/PosterPrintPage').then((m) => m.CanteenPosterPrintPage));
const PatrolCodesPrintPage = lazyPage(() => import('./features/patrol/CodesPrintPage').then((m) => m.PatrolCodesPrintPage));
const ShiftPrintPage = lazyPage(() => import('./features/print/ShiftPrintPage').then((m) => m.ShiftPrintPage));
// ERP 工作区
// 供应商在线对账确认（8.0.7 2.6）：供应商打开链接，不用登录
const ReconPublicPage = lazyPage(() => import('./features/payables/ReconPublicPage').then((m) => m.ReconPublicPage));
const ErpShell = lazyPage(() => import('./features/erp/ErpShell').then((m) => m.ErpShell));
const ErpHome = lazyPage(() => import('./features/erp/ErpHome').then((m) => m.ErpHome));
const ErpModulesPage = lazyPage(() => import('./features/erp/ErpModulesPage').then((m) => m.ErpModulesPage));
const RevenuePage = lazyPage(() => import('./features/erp/RevenuePage').then((m) => m.RevenuePage));
const ExpensesPage = lazyPage(() => import('./features/expenses/ExpensesPage').then((m) => m.ExpensesPage));
const ClaimFormPage = lazyPage(() => import('./features/expenses/ClaimFormPage').then((m) => m.ClaimFormPage));
const PettyPage = lazyPage(() => import('./features/expenses/PettyPage').then((m) => m.PettyPage));
const PettyAccountsPage = lazyPage(() => import('./features/expenses/PettyAccountsPage').then((m) => m.PettyAccountsPage));
const BudgetsPage = lazyPage(() => import('./features/expenses/BudgetsPage').then((m) => m.BudgetsPage));
const AssetsPage = lazyPage(() => import('./features/assets/AssetsPage').then((m) => m.AssetsPage));
const AssetLabelsPrintPage = lazyPage(() => import('./features/assets/AssetLabelsPrintPage').then((m) => m.AssetLabelsPrintPage));
const ReceivablesPage = lazyPage(() => import('./features/receivables/ReceivablesPage').then((m) => m.ReceivablesPage));
const InvoicesPage = lazyPage(() => import('./features/invoices/InvoicesPage').then((m) => m.InvoicesPage));
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
const CanteenPage = lazyPage(() => import('./features/canteen/CanteenPage').then((m) => m.CanteenPage));
const PatrolPage = lazyPage(() => import('./features/patrol/PatrolPage').then((m) => m.PatrolPage));
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
const ScoresPage = lazyPage(() => import('./features/purchasing/ScoresPage').then((m) => m.ScoresPage));
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
  // 「点餐平板」账号（8.0.10）：只能打开点餐页，登录后直接进去
  if (can('emenu.view') && !can('frontdesk.read')) return <Navigate to="/emenu" replace />;
  // 他店查询（v0.7.23）：另一家店的同事只能查会员档阶
  if (can('member.lookup')) return <Navigate to="/lookup" replace />;
  if (erp.landing) return <Navigate to={erp.landing} replace />;
  // 管家（8.0.12）：后勤岗位加了管家职责的，登录后直接进管家部。排在「点餐平板」「他店查询」「只用 ERP」之后——
  // 原来排在最前面：以后给别的岗位勾上管家部的查看权限，平板、库管、采购登录都会被带到管家部（整改）
  if (can('concierge.read')) return <Navigate to="/concierge" replace />;
  if (dining && (can('dining.kitchen') || can('dining.order'))) return <Navigate to="/dining" replace />;
  if (session?.rooms && (can('room.operate') || can('room.housekeep'))) return <Navigate to="/rooms" replace />;
  if (erp.canEnter) return <Navigate to="/erp" replace />;
  // 只有「看对客导览」的账号（门店大屏）：直接进大屏模式
  if (can('guide.view')) return <Navigate to="/guide/screen" replace />;
  return <Navigate to="/password" replace />;
}

/** 门店的旧地址 /dashboard、/dashboard/<页签>：看板 2026-11-10 起在后台「数据看板」，带上页签与查询参数跳过去 */
function DashboardMoved() {
  const { tab } = useParams();
  const { search } = useLocation();
  return <Navigate to={`${ADMIN_SECTIONS.dashboard.path}${tab ? `/${tab}` : ''}${search}`} replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/r/:token', element: <ReconPublicPage /> },
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
    ],
  },
  // 对客导览的大屏模式（v0.7.19）：没有导航与操作，适合门店大屏常开
  { path: '/guide/screen', element: <AuthGate shell="bare" />, children: [{ index: true, element: <GuideScreenPage /> }] },
  // 平板点餐页（8.0.10）：整页是设计师的电子菜单，没有门店系统的导航
  { path: '/emenu', element: <AuthGate shell="bare" />, children: [{ index: true, element: <EmenuPage /> }] },
  { path: '/admin/concierge', element: <Navigate to="/concierge" replace /> },
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
      { path: 'receivables', element: <ReceivablesPage /> },
      { path: 'assets', element: <AssetsPage /> },
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
      { path: 'canteen', element: <CanteenPage /> },
      { path: 'patrol', element: <PatrolPage /> },
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
      { path: 'frontdesk', element: <FrontdeskPage /> },
      { path: 'clockroom', element: <ClockroomPage /> },
      { path: 'dining/:tab?', element: <DiningPage /> },
      { path: 'rooms', element: <RoomsPage /> },
      { path: 'bookings', element: <BookingsPage /> },
      // 管家部（8.0.12）：门店的工作页面；/admin/concierge 是 Codex 最初放的地址，留着跳过来
      { path: 'concierge', element: <ConciergePage /> },
      { path: 'platform', element: <PlatformPage /> },
      { path: 'guide', element: <GuidePage /> },
      { path: 'devices', element: <DevicesPage /> },
      { path: 'ledger', element: <LedgerPage /> },
      { path: 'settlement/:date?', element: <SettlementPage /> },
      { path: 'shift', element: <ShiftPage /> },
      // 看板 2026-11-10 起在后台（「数据看板」）：门店的旧地址跳过去，页签与查询参数照带
      { path: 'dashboard/:tab?', element: <DashboardMoved /> },
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
