// 巡场二维码（A4，8.0.9，docs/PATROL_V809.md 第 4 节）：一页 6 张，每张印场所名称、位置说明与二维码，剪开贴到场所里。
// 一页的高度要放得进 A4 去掉上下 12mm 页边距以后的 273mm（这里用 265mm，与员工食堂海报一样；Codex 审查 ae12728），
// 只在页与页之间分页（最后一页后面再分页会多出一张白纸）。
// 地址 /print/patrol-codes/all（全部启用的场所）或 /print/patrol-codes/3,5,8（选中的）。二维码里是「员工入口地址 + #patrol=场所码」：
// 用柚子饭堂「工作台 → 巡场」扫，或者手机相机、微信直接扫都行。换过码的场所要重新打印。

import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { patrolLink, type PatrolPointsAdmin } from '@shared/patrol';
import { api, errorMessage } from '../../lib/api';
import { QrCode } from '../../../canteen-app/QrCode';
import { PrintFrame } from '../print/PrintFrame';

export function PatrolCodesPrintPage() {
  const { ids } = useParams();
  const list = useQuery({ queryKey: ['patrol', 'points'], queryFn: () => api.get<PatrolPointsAdmin>('/api/erp/patrol/points') });
  const wanted = ids === 'all' ? null : new Set((ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0));
  const points = (list.data?.points ?? []).filter((p) => p.active && (!wanted || wanted.has(p.id)));
  const portal = list.data?.portalUrl ?? '';
  const error = list.error
    ? errorMessage(list.error)
    : list.data && !portal
      ? '还没填员工入口地址：在「员工食堂 → 设置」里填好再打印'
      : list.data && points.length === 0
        ? '没有要打印的场所（停用的不打印）'
        : null;
  const pages: (typeof points)[] = [];
  for (let i = 0; i < points.length; i += 6) pages.push(points.slice(i, i + 6));
  return (
    <PrintFrame title="安保巡场 · 场所二维码" ready={list.isSuccess} error={error} paper="a4">
      {pages.map((page, i) => (
        <div key={i} className="grid h-[265mm] grid-cols-2 grid-rows-3 gap-[4mm] [&:not(:last-child)]:break-after-page" data-testid="patrol-codes-page">
          {page.map((p) => (
            <div key={p.id} className="flex flex-col items-center justify-center rounded-[4mm] border-2 border-dashed border-[#999] p-[4mm] text-center" data-testid={`patrol-code-${p.name}`}>
              <p className="text-[10px] font-semibold tracking-[0.25em] text-[#666]">安保巡场 · 扫码打卡</p>
              <p className="mt-[1.5mm] text-[22px] leading-tight font-black">{p.name}</p>
              {p.area && <p className="text-[12px] text-[#444]">{p.area}</p>}
              <QrCode text={patrolLink(portal, p.token)} className="mt-[2mm] size-[48mm]" color="#000" eye="#000" label={`${p.name} 的巡场二维码`} />
              <p className="mt-[1.5mm] text-[10px] text-[#666]">柚子饭堂「工作台 → 巡场」扫码，或手机相机直接扫</p>
            </div>
          ))}
        </div>
      ))}
    </PrintFrame>
  );
}
