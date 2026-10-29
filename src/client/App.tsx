import { useEffect } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ApiError, onAuthError } from './lib/api';
import { qk, useSessionQuery } from './lib/queries';
import { SessionProvider } from './lib/session';
import { setDisplayTimeZone } from './lib/utils';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './components/Toast';
import { Spinner } from './components/ui';
import { LogoMark } from './components/Brand';
import { LoginPage } from './features/auth/LoginPage';
import { ChangePasswordPage } from './features/auth/ChangePasswordPage';
import { WorkbenchPage } from './features/workbench/WorkbenchPage';
import { FrontdeskPage } from './features/frontdesk/FrontdeskPage';
import { LedgerPage } from './features/ledger/LedgerPage';
import { SettlementPage } from './features/settlement/SettlementPage';
import { ShiftPage } from './features/shift/ShiftPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { AdminPage } from './features/admin/AdminPage';
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

/** 登录守卫：未登录跳转登录页；首次登录强制修改密码。bare 用于打印页：不带导航栏 */
function AuthGate({ bare = false }: { bare?: boolean }) {
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
  if (session.error || !session.data) {
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
      {bare ? (
        <Outlet />
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
    element: <AuthGate bare />,
    children: [
      { path: 'checkout/:id', element: <CheckoutPrintPage /> },
      { path: 'shift/:id', element: <ShiftPrintPage /> },
      { path: 'settlement/:date', element: <SettlementPrintPage /> },
    ],
  },
  {
    element: <AuthGate />,
    children: [
      { index: true, element: <Home /> },
      { path: 'frontdesk', element: <FrontdeskPage /> },
      { path: 'ledger', element: <LedgerPage /> },
      { path: 'settlement/:date?', element: <SettlementPage /> },
      { path: 'shift', element: <ShiftPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'admin/:tab?', element: <AdminPage /> },
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
