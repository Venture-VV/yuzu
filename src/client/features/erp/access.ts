import { ERP_MODULE_KEYS, ERP_MODULES } from '@shared/erp';
import { useCan, useSession } from '../../lib/session';
import { useStoreNav } from '../../components/storeNav';

/**
 * 当前账号在 ERP 里能用的模块（店主开着、依赖满足、有权限），能不能进 ERP、登录后落在哪一页，
 * 以及「返回门店」回到哪一页（门店那边没有能用的页面时 ERP 顶栏不显示「返回门店」）。
 */
export function useErpAccess() {
  const session = useSession();
  const can = useCan();
  // 对客导览不算门店的工作页面（所有岗位都能看，只用 ERP 的人不因此多出「返回门店」）
  const storeNav = useStoreNav().flat().filter((n) => !n.guestFacing);
  const modules = ERP_MODULE_KEYS.filter((k) => session.erpModules.includes(k) && ERP_MODULES[k].perms.some((p) => can(p)));
  const canSettings = can('settings.manage');
  return {
    modules,
    /** 能进 ERP：有能用的模块，或者是能改模块开关的店主 */
    canEnter: modules.length > 0 || canSettings,
    canSettings,
    /** 只用 ERP 的人登录后直接进第一个能用的模块 */
    landing: modules.length ? ERP_MODULES[modules[0]!].path : null,
    /**
     * 「返回门店」回到哪一页：门店首页（会员工作台）；没有会员权限的回到门店主导航里第一个能用的页面
     * （门店首页会把只用 ERP 的人送回 ERP，例如开了餐饮时管厨房的后勤要直接进餐饮）
     */
    storeHome: storeNav.find((n) => n.to === '/')?.to ?? storeNav[0]?.to ?? null,
  };
}
