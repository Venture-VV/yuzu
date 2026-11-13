// 后台的信息架构（8.0.17，docs/IA_V8017.md）：一级分组与分区的对应、二级页签的写法。静态核对，不连数据库。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_GROUPS, ADMIN_SECTIONS, type AdminSection } from '../src/shared/admin';

const ADMIN_DIR = join(__dirname, '..', 'src', 'client', 'features', 'admin');
const routes = readFileSync(join(ADMIN_DIR, 'AdminPage.tsx'), 'utf8');

describe('后台的一级分组', () => {
  it('每个分区在且只在一个分组里（8.0.16 以前「设备」漏在侧栏外面）', () => {
    const placed = ADMIN_GROUPS.flatMap((g) => g.items);
    expect([...placed].sort()).toEqual((Object.keys(ADMIN_SECTIONS) as AdminSection[]).sort());
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed).toContain('devices');
  });

  it('7 个分组，名称与顺序固定；规则中心里是规则总表与门店基本规则', () => {
    expect(ADMIN_GROUPS.map((g) => g.title)).toEqual(['概览', '规则中心', '会员与营销', '营业项目', '场地、设备与线上', '人员与权限', '数据与审计']);
    expect(ADMIN_GROUPS.find((g) => g.key === 'rules')!.items).toEqual(['settings', 'rules']);
    expect(new Set(ADMIN_GROUPS.map((g) => g.key)).size).toBe(ADMIN_GROUPS.length);
  });

  it('改过名的分区：路径不变（旧链接照旧能用）', () => {
    expect(ADMIN_SECTIONS.rules).toMatchObject({ path: '/admin/rules', label: '门店基本规则' });
    expect(ADMIN_SECTIONS.members).toMatchObject({ path: '/admin/members', label: '渠道与标签' });
    expect(ADMIN_SECTIONS.coupons).toMatchObject({ path: '/admin/coupons', label: '券' });
    expect(ADMIN_SECTIONS.opening).toMatchObject({ path: '/admin/opening', label: '期初与旧账' });
  });

  it('侧栏不再自己写一份分组', () => {
    const shell = readFileSync(join(ADMIN_DIR, 'AdminShell.tsx'), 'utf8');
    expect(shell).toContain('ADMIN_GROUPS');
    expect(shell).not.toMatch(/const GROUPS\b/);
  });
});

describe('二级页签', () => {
  /** 用了 SubPane 的分区组件：文件 → 里面写的页签 */
  const files = readdirSync(ADMIN_DIR).filter((f) => f.endsWith('.tsx'));
  const withPanes = files
    .map((f) => ({ f, text: readFileSync(join(ADMIN_DIR, f), 'utf8') }))
    .filter((x) => /<SubPane tab="/.test(x.text));

  it('拆了页签的 8 个分区', () => {
    expect(withPanes.map((x) => x.f).sort()).toEqual(['CatalogTab.tsx', 'DevicesSection.tsx', 'DiningSection.tsx', 'OpeningTab.tsx', 'RoomsSection.tsx', 'RulesTab.tsx', 'TagsTab.tsx', 'TechniciansSection.tsx']);
  });

  it('每个页面里：写了的页签都有内容，有内容的页签都写了；页签的名字只用小写字母、数字、短横线', () => {
    for (const { f, text } of withPanes) {
      const panes = [...new Set([...text.matchAll(/<SubPane tab="([^"]+)"/g)].map((m) => m[1]!))].sort();
      // 页签的定义只有 key 与 label 两项（别的带 key 的清单都不止这两项）
      const tabs = [...new Set([...text.matchAll(/\{ key: '([^']+)', label: '[^']*' \}/g)].map((m) => m[1]!))].sort();
      expect(tabs, f).toEqual(panes);
      for (const k of tabs) expect(k, f).toMatch(/^[a-z0-9-]+$/);
      expect(tabs.length, f).toBeGreaterThanOrEqual(2);
    }
  });

  it('有页签的分区，路由写成 `<分区>/:tab?`（页签写进地址）', () => {
    for (const section of ['rules', 'catalog', 'tags', 'technicians', 'dining', 'rooms', 'devices', 'opening']) {
      expect(routes, section).toContain(`path: '${section}/:tab?'`);
    }
  });

  it('规则类的页签排在最前面（规则 → 清单 → 导入与工具）', () => {
    const first = (f: string) => /\{ key: '([^']+)', label: '[^']*' \}/.exec(readFileSync(join(ADMIN_DIR, f), 'utf8'))![1];
    expect(first('TechniciansSection.tsx')).toBe('rules');
    expect(first('DiningSection.tsx')).toBe('rules');
    expect(first('RoomsSection.tsx')).toBe('rules');
    // 导入与工具排在最后
    for (const f of ['CatalogTab.tsx', 'DevicesSection.tsx']) {
      const keys = [...readFileSync(join(ADMIN_DIR, f), 'utf8').matchAll(/\{ key: '([^']+)', label: '[^']*' \}/g)].map((m) => m[1]);
      expect(keys.at(-1), f).toBe('import');
    }
  });
});
