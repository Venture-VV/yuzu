import { useQuery } from '@tanstack/react-query';
import type {
  LegacyAudit,
  LegacyBrandLine,
  LegacyImport,
  LegacyLedgerLine,
  LegacyMaterialLine,
  LegacyOrderedLine,
  LegacyPaymentDay,
  LegacySource,
} from '@shared/legacy';
import { api } from '../../lib/api';

export interface LegacyRows {
  import: LegacyImport | null;
  ledger?: LegacyLedgerLine[];
  payments?: LegacyPaymentDay[];
  materials?: LegacyMaterialLine[];
  ordered?: LegacyOrderedLine[];
  brand?: LegacyBrandLine[];
}

export const useLegacyAudit = () => useQuery({ queryKey: ['legacy', 'audit'], queryFn: () => api.get<LegacyAudit>('/api/erp/legacy/audit') });
export const useLegacyImports = () => useQuery({ queryKey: ['legacy', 'imports'], queryFn: () => api.get<LegacyImport[]>('/api/erp/legacy/imports') });
export const useLegacyRows = (source: LegacySource, enabled = true) =>
  useQuery({ queryKey: ['legacy', 'rows', source], queryFn: () => api.get<LegacyRows>(`/api/erp/legacy/rows/${source}`), enabled });
