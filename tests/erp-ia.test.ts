// ERP 的信息架构（8.0.18，docs/IA_V8017.md 第 3.3 节）：导航分组、「ERP 设置」的页签、挪到后台的三个模块。
// 不碰数据库。
import { describe, expect, it } from 'vitest';
import { ADMIN_ENTRY_PERMISSIONS, ADMIN_GROUPS, ADMIN_SECTION_MODULES, ADMIN_SECTIONS, ADMIN_STANDALONE_SECTIONS } from '../src/shared/admin';
import { ERP_MODULE_KEYS, ERP_MODULES, ERP_NAV_GROUPS, ERP_SETTINGS_PATH, erpModuleOfApi, erpModuleOfPage } from '../src/shared/erp';
import type { Permission } from '../src/shared/permissions';
import { erpSettingsPath, erpSettingsTabs } from '../src/client/features/erp/settingsTabs';

describe('ERP 导航分组', () => {
  it('每个模块在且只在一个分组里', () => {
    const listed = ERP_NAV_GROUPS.flatMap((g) => g.modules);
    expect([...listed].sort()).toEqual([...ERP_MODULE_KEYS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('审批单列；应付货款归财务；合同单独一组；分组名与模块上记的一致', () => {
    const groupOf = (k: string) => ERP_NAV_GROUPS.find((g) => (g.modules as readonly string[]).includes(k))!;
    expect(groupOf('approvals').modules).toEqual(['approvals']);
    expect(groupOf('payables').title).toBe('财务');
    expect(groupOf('contracts').title).toBe('合同');
    expect(groupOf('inventory').modules).toEqual(['inventory', 'purchasing', 'requests', 'deptStock', 'assets']);
    for (const g of ERP_NAV_GROUPS) {
      for (const k of g.modules) {
        if (g.key === 'moved') expect(ERP_MODULES[k].group).toBe('后台');
        else expect(ERP_MODULES[k].group).toBe(g.title);
      }
    }
  });

  it('依赖的模块在注册表里排在前面（开关按注册顺序算一遍）', () => {
    for (const [i, k] of ERP_MODULE_KEYS.entries()) for (const r of ERP_MODULES[k].requires) expect(ERP_MODULE_KEYS.indexOf(r), `${k} 依赖 ${r}`).toBeLessThan(i);
  });
});

describe('挪到后台的三个模块', () => {
  it('入口在后台，旧页面地址与接口仍按模块认（开关与接口拦截照旧）', () => {
    expect(ERP_MODULES.canteen.path).toBe(ADMIN_SECTIONS.canteen.path);
    expect(ERP_MODULES.patrol.path).toBe(ADMIN_SECTIONS.patrol.path);
    expect(ERP_MODULES.revenue.path).toBe(`${ADMIN_SECTIONS.dashboard.path}/revenue`);
    expect(erpModuleOfPage('/erp/canteen')).toBe('canteen');
    expect(erpModuleOfPage('/erp/patrol')).toBe('patrol');
    expect(erpModuleOfPage('/erp/revenue')).toBe('revenue');
    expect(erpModuleOfApi('/api/erp/canteen/overview')).toBe('canteen');
    expect(erpModuleOfApi('/api/erp/patrol/day')).toBe('patrol');
    expect(erpModuleOfApi('/api/erp/revenue?from=2026-01-01')).toBe('revenue');
    // ERP 设置自己不属于任何模块（谁都关不掉它）
    expect(erpModuleOfPage(ERP_SETTINGS_PATH)).toBeNull();
    expect(erpModuleOfPage(`${ERP_SETTINGS_PATH}/purchase`)).toBeNull();
  });

  it('后台：员工食堂、安保巡场在「人员与行政」，跟着 ERP 模块开关走；只有这几项权限的也进得了后台', () => {
    const staff = ADMIN_GROUPS.find((g) => g.key === 'staff')!;
    expect(staff.title).toBe('人员与行政');
    expect(staff.items).toEqual(['staff', 'permissions', 'canteen', 'patrol']);
    expect(ADMIN_SECTION_MODULES).toEqual({ canteen: 'canteen', patrol: 'patrol' });
    expect(ADMIN_STANDALONE_SECTIONS).toEqual(['dashboard', 'canteen', 'patrol']);
    for (const p of ['canteen.manage', 'patrol.read', 'patrol.manage', 'erp.revenue'] as Permission[]) expect(ADMIN_ENTRY_PERMISSIONS, p).toContain(p);
    // 权限没变：还是原来那几项
    expect(ADMIN_SECTIONS.canteen.perms).toEqual(ERP_MODULES.canteen.perms);
    expect(ADMIN_SECTIONS.patrol.perms).toEqual(ERP_MODULES.patrol.perms);
    expect(ADMIN_SECTIONS.dashboard.perms).toContain('erp.revenue');
  });
});

describe('「ERP 设置」的页签', () => {
  const all = [...ERP_MODULE_KEYS];
  const can = (...perms: Permission[]) => (p: Permission) => perms.includes(p);

  it('店主：七个页签，顺序固定（开关 → 各模块的规则 → 其他数值）', () => {
    const owner = () => true;
    expect(erpSettingsTabs(owner, all).map((t) => t.key)).toEqual(['modules', 'purchase', 'inventory', 'approvals', 'payments', 'expenses', 'tunables']);
  });

  it('物资经办（只有查看库存）：只看得到采购规则；模块关着的页签不显示', () => {
    expect(erpSettingsTabs(can('inventory.read'), all).map((t) => t.key)).toEqual(['purchase']);
    expect(erpSettingsTabs(can('inventory.read'), all.filter((k) => k !== 'purchasing'))).toEqual([]);
    expect(erpSettingsTabs(() => true, ['inventory']).map((t) => t.key)).toEqual(['modules', 'inventory', 'tunables']);
  });

  it('对账付款：付款规则；审批人：审批规则与代理人；什么权限都没有：没有页签', () => {
    expect(erpSettingsTabs(can('payable.read'), all).map((t) => t.key)).toEqual(['payments']);
    expect(erpSettingsTabs(can('approval.act'), all).map((t) => t.key)).toEqual(['approvals']);
    expect(erpSettingsTabs(() => false, all)).toEqual([]);
  });

  it('页签的地址', () => {
    expect(erpSettingsPath('purchase')).toBe('/erp/settings/purchase');
    for (const t of erpSettingsTabs(() => true, all)) expect(t.hint.length).toBeGreaterThan(4);
  });
});
