import { ADMIN_PERMISSIONS } from '@shared/admin';
import { ERP_MODULE_KEYS, ERP_MODULES } from '@shared/erp';
import { useCan, useSession } from '../../lib/session';

/**
 * 当前账号在 ERP 里能用的模块（店主开着、依赖满足、有权限），能不能进 ERP、登录后落在哪一页，
 * 以及门店那边有没有能用的页面（决定 ERP 顶栏显不显示「返回门店」）。
 */
export function useErpAccess() {
  const session = useSession();
  const can = useCan();
  const modules = ERP_MODULE_KEYS.filter((k) => session.erpModules.includes(k) && ERP_MODULES[k].perms.some((p) => can(p)));
  const canSettings = can('settings.manage');
  const store =
    can('member.read') ||
    can('frontdesk.read') ||
    can('ledger.readToday') ||
    ADMIN_PERMISSIONS.some((p) => can(p)) ||
    (session.dining && (can('dining.order') || can('dining.kitchen'))) ||
    (session.technicians && can('technician.dispatch'));
  return {
    modules,
    /** 能进 ERP：有能用的模块，或者是能改模块开关的店主 */
    canEnter: modules.length > 0 || canSettings,
    canSettings,
    /** 只用 ERP 的人登录后直接进第一个能用的模块 */
    landing: modules.length ? ERP_MODULES[modules[0]!].path : null,
    /** 门店那边有能用的页面 */
    store,
  };
}
