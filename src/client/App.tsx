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
import { ClockroomPage } from './features/clockroom/ClockroomPage';
import { DiningPage } from './features/dining/DiningPage';
import { RoomsPage } from './features/rooms/RoomsPage';
import { GuidePage, GuideScreenPage } from './features/guide/GuidePage';
import { LedgerPage } from './features/ledger/LedgerPage';
import { SettlementPage } from './features/settlement/SettlementPage';
import { ShiftPage } from './features/shift/ShiftPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { adminRoutes } from './features/admin/AdminPage';
import { AdminShell } from './features/admin/AdminShell';
import { DocFormPage } from './features/inventory/DocFormPage';
import { InventoryPage } from './features/inventory/InventoryPage';
import { TodoPage } from './features/inventory/TodoPage';
import { PayablesPage } from './features/payables/PayablesPage';
import { PaymentFormPage } from './features/payables/PaymentFormPage';
import { ImportPage } from './features/payables/ImportPage';
import { OrderedPage } from './features/purchasing/OrderedPage';
import { PoFormPage } from './features/purchasing/PoFormPage';
import { PurchasingPage } from './features/purchasing/PurchasingPage';
import { CheckoutPrintPage } from './features/print/CheckoutPrintPage';
import { RefundPrintPage } from './features/print/RefundPrintPage';
import { SettlementPrintPage } from './features/print/SettlementPrintPage';
import { ShiftPrintPage } from './features/print/ShiftPrintPage';
import { useCan, useOptionalSession } from './lib/session';
import { useErpAccess } from './features/erp/access';
import { ErpHome } from './features/erp/ErpHome';
import { ErpModulesPage } from './features/erp/ErpModulesPage';
import { ErpShell } from './features/erp/ErpShell';
import { RevenuePage } from './features/erp/RevenuePage';
import { ClaimFormPage } from './features/expenses/ClaimFormPage';
import { ExpensesPage } from './features/expenses/ExpensesPage';
import { PettyPage } from './features/expenses/PettyPage';
import { AuditPage } from './features/purchase-ledger/AuditPage';
import { LegacyPage } from './features/legacy/LegacyPage';
import { PurchaseLedgerPage } from './features/purchase-ledger/PurchaseLedgerPage';
import { RequestFormPage } from './features/requests/RequestFormPage';
import { RequestsPage } from './features/requests/RequestsPage';
import { DeptDocFormPage } from './features/dept-stock/DeptDocFormPage';
import { DeptStockPage } from './features/dept-stock/DeptStockPage';

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
      { path: 'petty', element: <PettyPage /> },
      { path: 'requests', element: <RequestsPage /> },
      { path: 'dept-stock', element: <DeptStockPage /> },
      { path: 'dept-stock/new/:type', element: <DeptDocFormPage /> },
      { path: 'dept-stock/docs/:id/edit', element: <DeptDocFormPage /> },
      { path: 'requests/new', element: <RequestFormPage mode="new" /> },
      { path: 'requests/:id/edit', element: <RequestFormPage mode="edit" /> },
      { path: 'ledger', element: <PurchaseLedgerPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'legacy', element: <LegacyPage /> },
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
      { path: 'purchasing', element: <PurchasingPage /> },
      { path: 'purchasing/new', element: <PoFormPage mode="new" /> },
      { path: 'purchasing/ordered', element: <OrderedPage /> },
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
      { path: 'guide', element: <GuidePage /> },
      { path: 'ledger', element: <LedgerPage /> },
      { path: 'settlement/:date?', element: <SettlementPage /> },
      { path: 'shift', element: <ShiftPage /> },
      { path: 'dashboard/:tab?', element: <DashboardPage /> },
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
