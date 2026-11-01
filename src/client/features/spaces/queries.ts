// 空间台账（RQ-004 第一段，v0.7.14）：台账与导入记录。台账改了以后客房后台（挂接用的空间列表）一起刷新。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SpaceImportRecord, SpaceLedger } from '@shared/spaces';
import { api } from '../../lib/api';

export const spacesKey = ['admin', 'spaces'] as const;
export const spaceImportsKey = ['admin', 'spaces', 'imports'] as const;

export const useSpaceLedger = () => useQuery({ queryKey: spacesKey, queryFn: () => api.get<SpaceLedger>('/api/admin/spaces') });

export const useSpaceImports = () => useQuery({ queryKey: spaceImportsKey, queryFn: () => api.get<SpaceImportRecord[]>('/api/admin/spaces/imports') });

/** 写入后：台账、导入记录、客房后台与房态（房号、显示名）一起刷新 */
export function useInvalidateSpaces() {
  const qc = useQueryClient();
  return async (ledger?: SpaceLedger) => {
    if (ledger) qc.setQueryData(spacesKey, ledger);
    await Promise.all([
      qc.invalidateQueries({ queryKey: spacesKey, refetchType: ledger ? 'none' : 'active' }),
      qc.invalidateQueries({ queryKey: spaceImportsKey }),
      qc.invalidateQueries({ queryKey: ['admin', 'rooms'] }),
      qc.invalidateQueries({ queryKey: ['rooms'] }),
    ]);
  };
}
