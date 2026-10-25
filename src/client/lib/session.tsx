import { createContext, useContext, type ReactNode } from 'react';
import { can as canRole, type Permission } from '@shared/permissions';
import type { SessionInfo } from '@shared/types';

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({ value, children }: { value: SessionInfo; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionInfo {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession 需在登录后使用');
  return s;
}

export function useCan() {
  const s = useSession();
  return (p: Permission) => canRole(s.staff.role, p);
}
