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
import { PoFormPage } from './features/purchasing/PoFormPage';
import { PurchasingPage } from './features/purchasing/PurchasingPage';
import { CheckoutPrintPage } from './features/print/CheckoutPrintPage';
import { SettlementPrintPage } from './features/print/SettlementPrintPage';
import { ShiftPrintPage } from './features/print/ShiftPrintPage';
import { useCan } from './lib/session';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

/** 登录守卫：未登录跳转登录页；首次登录强制修改密码。shell：app 为前台（带导航栏），admin 为管理后台，bare 用于打印页 */
function AuthGate({ shell = 'app' }: { shell?: 'app' | 'admin' | 'bare' }) {
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
      ) : (
        <AppShell>
          <Outlet />
        </AppShell>
      )}
    </SessionProvider>
  );
}

/** 首页：前台进入会员工作台；只有库存职责的后勤人员直接进入库存 */
function Home() {
  const can = useCan();
  if (can('member.read')) return <WorkbenchPage />;
  if (can('inventory.read')) return <Navigate to="/inventory" replace />;
  return <Navigate to="/password" replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/print',
    element: <AuthGate shell="bare" />,
    children: [
      { path: 'checkout/:id', element: <CheckoutPrintPage /> },
      { path: 'shift/:id', element: <ShiftPrintPage /> },
      { path: 'settlement/:date', element: <SettlementPrintPage /> },
    ],
  },
  { path: '/admin', element: <AuthGate shell="admin" />, children: adminRoutes },
  {
    element: <AuthGate />,
    children: [
      { index: true, element: <Home /> },
      { path: 'frontdesk', element: <FrontdeskPage /> },
      { path: 'ledger', element: <LedgerPage /> },
      { path: 'settlement/:date?', element: <SettlementPage /> },
      { path: 'shift', element: <ShiftPage /> },
      { path: 'dashboard/:tab?', element: <DashboardPage /> },
      { path: 'inventory/new/:type', element: <DocFormPage /> },
      { path: 'inventory/docs/:id/edit', element: <DocFormPage /> },
      { path: 'inventory/:tab?', element: <InventoryPage /> },
      { path: 'todo', element: <TodoPage /> },
      { path: 'purchasing', element: <PurchasingPage /> },
      { path: 'purchasing/new', element: <PoFormPage mode="new" /> },
      { path: 'purchasing/:id/edit', element: <PoFormPage mode="edit" /> },
      { path: 'purchasing/:id/revise', element: <PoFormPage mode="revise" /> },
      { path: 'payables', element: <PayablesPage /> },
      { path: 'payables/pay', element: <PaymentFormPage /> },
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
