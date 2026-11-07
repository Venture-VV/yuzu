// 注册海报（A4，docs/CANTEEN.md 第 14 节）：贴在饭堂门口、员工休息室——柚子、一句话、大大的注册二维码和三步。
// 地址 /print/canteen-poster。不要注册口令（店主 2026-11-07）：二维码就是员工入口地址，换了地址才要重新打印。

import { useQuery } from '@tanstack/react-query';
import type { CanteenRegistration } from '@shared/canteen';
import { api, errorMessage } from '../../lib/api';
import { Mascot } from '../../../canteen-app/Mascot';
import { QrCode } from '../../../canteen-app/QrCode';
import { PrintFrame } from '../print/PrintFrame';

export function CanteenPosterPrintPage() {
  const reg = useQuery({ queryKey: ['canteen', 'registration'], queryFn: () => api.get<CanteenRegistration>('/api/erp/canteen/registration') });
  const r = reg.data;
  const error = reg.error
    ? errorMessage(reg.error)
    : r && !r.link
        ? '还没填员工入口地址：在「员工食堂 → 设置」里填好再打印'
        : r && !r.enabled
          ? '自己登记关着：在「员工食堂 → 设置」里打开再打印'
          : null;
  return (
    <PrintFrame title="柚子饭堂 · 注册海报" ready={reg.isSuccess} error={error} paper="a4">
      {r?.link && (
        <div className="flex h-[265mm] flex-col items-center text-center" data-testid="canteen-poster">
          <p className="mt-[6mm] text-[13px] font-semibold tracking-[0.3em] text-[#555]">汤崎 · 员工食堂 · YUZU CANTEEN</p>
          <h1 className="mt-[4mm] text-[44px] leading-tight font-black">柚子饭堂开张啦！</h1>
          <p className="mt-[2mm] text-[17px]">扫码登记，开饭时亮出饭卡码就能吃饭</p>
          <div className="mt-[8mm] flex items-end gap-[8mm]">
            <Mascot pose="point" mood="wink" still className="h-[72mm] w-auto" />
            <div className="flex flex-col items-center">
              <QrCode text={r.link} className="size-[78mm]" color="#000" eye="#000" label="注册二维码" />
              <p className="mt-[3mm] text-[12px] text-[#555]">手机相机扫一扫</p>
            </div>
          </div>
          <p className="mt-[8mm] text-[13px] text-[#555]">没扫码也行：手机浏览器打开下面的地址，点「新同事登记」</p>
          <p className="text-[18px] font-bold break-all">{r.link}</p>
          <ol className="mt-[8mm] grid w-full grid-cols-3 gap-[5mm] text-left text-[14px] leading-snug">
            <li className="rounded-[4mm] border-2 border-black p-[4mm]">
              <b className="text-[22px]">①</b>
              <br />
              手机扫上面的码，看柚子打个招呼
            </li>
            <li className="rounded-[4mm] border-2 border-black p-[4mm]">
              <b className="text-[22px]">②</b>
              <br />
              填用户名、手机号、密码，账号就开好了
            </li>
            <li className="rounded-[4mm] border-2 border-black p-[4mm]">
              <b className="text-[22px]">③</b>
              <br />
              添加到桌面，开饭时点「饭卡码」给负责人扫
            </li>
          </ol>
          <p className="mt-auto text-[11px] text-[#777]">忘了密码请找管理员「重新开通」。</p>
        </div>
      )}
    </PrintFrame>
  );
}
