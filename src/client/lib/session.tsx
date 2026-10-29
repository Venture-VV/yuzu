import { createContext, useContext, type ReactNode } from 'react';
import type { Permission } from '@shared/permissions';
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

/** 权限以服务端计算的结果为准（岗位 + 职责） */
export function useCan() {
  const s = useSession();
  return (p: Permission) => s.permissions.includes(p);
}
