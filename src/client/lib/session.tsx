import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_DICTIONARIES, type DictionaryKey } from '@shared/custom-fields';
import type { Permission } from '@shared/permissions';
import type { SessionInfo } from '@shared/types';

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({ value, children }: { value: SessionInfo; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** 登录前（登录页等）为 null；只用于登录前后都会出现的组件 */
export function useOptionalSession(): SessionInfo | null {
  return useContext(SessionContext);
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

/** 快捷原因（8.0.21 数据字典，后台「数据字典与字段」维护）；原因照旧存文字，页面上仍然可以手填 */
export function useReasons(key: DictionaryKey): readonly string[] {
  const s = useContext(SessionContext);
  return s?.rules.dictionaries?.[key] ?? DEFAULT_DICTIONARIES[key];
}
