// 资产标签（8.0.7 ERP P2 3.2）：二维码就是资产编号；A4 一页三列，贴在资产上，扫码盘点时扫它。

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { ASSET_CATEGORY_LABELS, type AssetCard } from '@shared/assets';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { QrCode } from '../../../canteen-app/QrCode';
import { PrintFrame } from '../print/PrintFrame';

export function AssetLabelsPrintPage() {
  const { ids = '' } = useParams();
  const session = useSession();
  const wanted = [...new Set(ids.split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  // 按编号直接取这几张（不从列表里筛：列表最多 1,000 张，老卡片会漏掉）；按选的先后排
  const cards = useQuery({
    queryKey: ['erp', 'assets', 'labels', wanted.join(',')],
    queryFn: () => api.get<AssetCard[]>(`/api/erp/assets?ids=${wanted.join(',')}`),
    enabled: wanted.length > 0,
  });
  const byId = new Map((cards.data ?? []).map((c) => [c.id, c]));
  const list = wanted.map((id) => byId.get(id)).filter((c): c is AssetCard => !!c);
  const error = cards.error
    ? errorMessage(cards.error)
    : wanted.length === 0 || (cards.isSuccess && list.length === 0)
      ? '没有要打印的资产标签'
      : cards.isSuccess && list.length < wanted.length
        ? `选的 ${wanted.length} 张里有 ${wanted.length - list.length} 张找不到，请回资产页重新选`
        : null;
  return (
    <PrintFrame title="资产标签" ready={cards.isSuccess} error={error} paper="a4">
      <div className="grid grid-cols-3 gap-0" data-testid="asset-labels">
        {list.map((c) => (
          <div key={c.id} className="flex h-[38mm] break-inside-avoid items-center gap-[3mm] border border-dashed border-[#bbb] p-[3mm]" data-testid="asset-label">
            <QrCode text={c.assetNo} className="size-[28mm] shrink-0" color="#000" eye="#000" label={c.assetNo} />
            <div className="min-w-0">
              <p className="text-[9px] text-[#555]">{session.storeName} · 资产标签</p>
              <p className="font-mono text-[12px] leading-tight font-bold">{c.assetNo}</p>
              <p className="mt-[1mm] line-clamp-2 text-[11px] leading-tight font-bold">{c.name}</p>
              <p className="mt-[1mm] text-[9px] text-[#555]">
                {ASSET_CATEGORY_LABELS[c.category]}
                {c.departmentName ? ` · ${c.departmentName}` : ''}
              </p>
              <p className="text-[9px] text-[#555]">取得 {c.acquiredOn}</p>
            </div>
          </div>
        ))}
      </div>
    </PrintFrame>
  );
}
