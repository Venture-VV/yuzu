// 「库管入库」页右上角的「导入出入库台账」「导出台账」「下载模板」（8.1.20，docs/ERP_V8120.md）。
// 单独一个文件：库管入库页不必连带加载导入页。

import { Link } from 'react-router';
import { Download, FileDown, FileUp } from 'lucide-react';
import { useCan, useSession } from '../../lib/session';

export const LEDGER_TEMPLATE_URL = '/api/inventory/ledger/template';
export const ledgerExportUrl = (month: string) => `/api/inventory/ledger/export?month=${month}`;

/** 「库管入库」页右上角：导入出入库台账、导出台账（这个月）、下载模板 */
export function LedgerActions() {
  const can = useCan();
  const session = useSession();
  if (!can('inventory.operate')) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="ledger-actions">
      <Link
        to="/inventory/direct/import"
        className="tap relative flex h-9 items-center gap-1.5 rounded-md bg-pine px-3 text-[13px] font-bold text-paper hover:bg-pine-hover"
        data-testid="ledger-import-link"
      >
        <FileUp className="size-4" />
        导入出入库台账
      </Link>
      <a
        href={ledgerExportUrl(session.calendarToday.slice(0, 7))}
        download
        className="tap relative flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3 hover:text-ink"
        data-testid="ledger-export-link"
      >
        <FileDown className="size-4" />
        导出台账
      </a>
      <a
        href={LEDGER_TEMPLATE_URL}
        download
        className="tap relative flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3 hover:text-ink"
        data-testid="ledger-template-link"
      >
        <Download className="size-4" />
        下载模板
      </a>
    </div>
  );
}
