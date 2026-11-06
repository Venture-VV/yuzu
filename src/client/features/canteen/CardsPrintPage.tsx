// 开通卡片（A4，一页 8 张，沿虚线剪开）：柚柚、姓名、工号、扫码开通的二维码与 8 位开通码。
// 地址 /print/canteen-cards/all（全部没开通的）或 /print/canteen-cards/12,13。

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { displayActivationCode, type ActivationCard, type CanteenSettings } from '@shared/canteen';
import { api, errorMessage } from '../../lib/api';
import { Mascot } from '../../../canteen-app/Mascot';
import { QrCode } from '../../../canteen-app/QrCode';
import { PrintFrame } from '../print/PrintFrame';

const expiry = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日前有效`;
};

export function CanteenCardsPrintPage() {
  const { ids = 'all' } = useParams();
  const cards = useQuery({
    queryKey: ['canteen', 'cards', ids],
    queryFn: () => api.get<ActivationCard[]>(`/api/erp/canteen/activation-cards${ids === 'all' ? '' : `?ids=${encodeURIComponent(ids)}`}`),
  });
  const settings = useQuery({ queryKey: ['canteen', 'settings'], queryFn: () => api.get<CanteenSettings>('/api/erp/canteen/settings') });
  const ready = cards.isSuccess && settings.isSuccess;
  const error = cards.error || settings.error ? errorMessage(cards.error ?? settings.error) : cards.data?.length === 0 ? '没有要打印的开通卡片（都开通了，或开通码过期了：在名单里点「重新开通」）' : null;
  const portal = settings.data?.portalUrl ?? '';
  return (
    <PrintFrame title="柚子饭堂 · 开通卡片" ready={ready} error={error} paper="a4">
      <div className="grid grid-cols-2 gap-0" data-testid="canteen-cards">
        {cards.data?.map((c) => (
          <div key={c.employeeId} className="flex h-[66mm] break-inside-avoid flex-col border border-dashed border-[#bbb] p-[5mm]" data-testid="canteen-card">
            <div className="flex items-center gap-[2mm]">
              <Mascot className="size-[11mm]" />
              <div>
                <p className="text-[15px] leading-tight font-bold">柚子饭堂 · 开通卡</p>
                <p className="text-[10px] text-[#555]">员工食堂：看菜单、给菜点赞、开饭时亮码</p>
              </div>
            </div>
            <div className="mt-[3mm] flex flex-1 items-center gap-[4mm]">
              {portal ? (
                <QrCode text={`${portal}/#join=${c.code}`} className="size-[27mm] shrink-0" color="#000" eye="#000" label="扫码开通" />
              ) : (
                <div className="flex size-[27mm] shrink-0 items-center justify-center border border-[#999] text-center text-[9px] text-[#555]">管理员还没填员工入口地址</div>
              )}
              <div className="min-w-0">
                <p className="text-[19px] leading-tight font-bold">{c.name}</p>
                <p className="mt-[1mm] text-[11px]">
                  工号 {c.empNo}
                  {c.department && ` · ${c.department}`}
                </p>
                <p className="mt-[2mm] text-[9.5px] text-[#555]">开通码</p>
                <p className="font-mono text-[20px] leading-tight font-bold tracking-[0.12em]">{displayActivationCode(c.code)}</p>
                <p className="text-[9.5px] text-[#555]">{expiry(c.expiresAt)}</p>
              </div>
            </div>
            <p className="mt-[2mm] text-[10px] leading-snug">① 手机相机扫左边的码 ② 设一个自己的密码 ③ 添加到桌面，开饭时亮出饭卡码 🍚</p>
          </div>
        ))}
      </div>
    </PrintFrame>
  );
}
