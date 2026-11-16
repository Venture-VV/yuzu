// 这台电脑上还有「结果待确认」时的提醒（8.1.3 WL12，照 Odoo POS「关班前先同步」）：交班前看一眼，只提醒、不拦。
import { Link } from 'react-router';
import { ERP_OP_TYPES } from '@shared/erp';
import { useErpPending } from '../lib/erpPending';
import { usePendingOps } from '../lib/pendingOps';
import { useFrontdeskPending } from '../features/frontdesk/pending';
import { Notice } from './ui';

export function useLocalPendingCount(): number {
  return usePendingOps().length + useFrontdeskPending().length + useErpPending(ERP_OP_TYPES).length;
}

export function LocalPendingNotice({ action, className }: { action: string; className?: string }) {
  const count = useLocalPendingCount();
  if (!count) return null;
  return (
    <Notice tone="warning" className={className} title={`这台电脑上还有 ${count} 笔「结果待确认」，先处理再${action}`} data-testid="local-pending-notice">
      提交时网络断了、超时，结果还不知道；查回、按原内容重提或确认作废以后，这几笔才算有结论（只提醒，不拦）。
      <Link to="/network" className="ml-1 font-semibold underline underline-offset-2">
        在「网络与同步」里看是哪几笔
      </Link>
    </Notice>
  );
}
