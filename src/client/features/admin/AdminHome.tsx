// 后台首页：门店与版本、主数据数量、规则状态（多少还是默认、待确认）、最近的设置变动与各分区入口。

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowRight, History, ListChecks } from 'lucide-react';
import { ADMIN_SECTIONS, type AdminOverview, type AdminSection } from '@shared/admin';
import { INSTANCE_LABELS, versionText } from '@shared/instance';
import { ROLE_LABELS } from '@shared/labels';
import { ROLES } from '@shared/permissions';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { Card, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { AdminPage, useAdminSections } from './AdminShell';

const SECTION_HINTS: Partial<Record<AdminSection, string>> = {
  settings: '所有规则一张表：当前值、默认值、谁改的',
  rules: '营业日、扣款顺序、上限与时限、开班、库存规则',
  members: '自定义字段、渠道来源、会员等级与名称',
  coupons: '券模板、开卡 / 升级 / 生日 / 充值赠券规则、无记名券、统计',
  catalog: '充值套餐、消费项目与价目表、票种票价',
  tags: '手牌池、柜号导入、前台规则',
  technicians: '技师名册、选技师规则、需要技师的项目',
  dining: '餐饮开关、出品档口、菜品送到哪个档口',
  rooms: '客房开关、退房与押金规则、房型房价、房间',
  spaces: '楼层、区域、空间编码与别名，核对状态，导入导出',
  devices: '打印机、标签机、读卡器、扫码、终端的登记，按采购清单导入，打印任务与设备事件',
  staff: '账号、岗位、库存职责、重置密码',
  permissions: '各岗位能做什么，店主可以勾选调整',
  opening: '旧系统会员余额导入与作废',
  audit: '谁在什么时候做了什么',
};

export function AdminHome() {
  const session = useSession();
  const sections = useAdminSections();
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api.get<AdminOverview>('/api/admin/overview') });
  const d = q.data;
  return (
    <AdminPage section="home" description="规则设置与主数据集中在后台维护；前台只管当班的接待、收银与交班。">
      {q.isPending ? (
        <Skeleton className="h-72" />
      ) : q.error ? (
        <Notice tone="error" title={q.error.message} />
      ) : (
        d && (
          <div className="space-y-5" data-testid="admin-home">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="门店" value={d.store.name} sub={`${INSTANCE_LABELS[d.store.instance] ?? d.store.instance} · ${versionText(d.store.version, d.store.commit)}`} />
              <Stat
                label="营业"
                value={`营业日 ${String(d.store.businessDayStartHour).padStart(2, '0')}:00 切换`}
                sub={d.store.businessHours}
              />
              <Stat
                label="员工"
                value={`${d.counts.staffActive} 人在职`}
                sub={ROLES.filter((r) => d.counts.staffByRole[r]).map((r) => `${ROLE_LABELS[r]} ${d.counts.staffByRole[r]}`).join(' · ')}
              />
              <Stat label="会员" value={`${d.counts.members} 位`} sub={`近 24 小时新建 ${d.counts.membersNewToday} 位`} />
              <Stat
                label="价目与技师"
                value={`${d.counts.items} 个项目 · ${d.counts.tickets} 个票种`}
                sub={`充值套餐 ${d.counts.plans} 个 · 技师 ${d.counts.technicians.active} 人${d.counts.technicians.enabled ? '' : '（技师功能未开启）'}`}
              />
              <Stat
                label="手牌池"
                value={`${d.counts.tags.active} 张在用`}
                sub={`锁定 ${d.counts.tags.locked} 张${d.counts.tags.inactive ? ` · 停用 ${d.counts.tags.inactive} 张` : ''}`}
              />
              <Card className="p-4 sm:col-span-2" data-testid="admin-rule-status">
                <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
                  <ListChecks className="size-4" /> 规则
                </p>
                <p className="mt-1 text-[18px] font-bold text-ink">
                  共 {d.rules.total} 项 · 改过 {d.rules.changed} 项
                </p>
                <p className="mt-0.5 text-[12.5px] text-ink-3">
                  {session.rules.hidePendingMarks
                    ? '店主已签认经营规则，「待确认」标记已隐藏'
                    : `${d.rules.pending} 项仍是推荐的默认做法、待店主确认`}
                  {sections.includes('settings') && (
                    <>
                      {' · '}
                      <Link to="/admin/settings" className="font-semibold text-pine hover:underline">
                        打开规则总表
                      </Link>
                    </>
                  )}
                </p>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <Card className="p-5">
                <SectionTitle>后台分区</SectionTitle>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {sections
                    .filter((k) => k !== 'home')
                    .map((k) => (
                      <li key={k}>
                        <Link
                          to={ADMIN_SECTIONS[k].path}
                          className="group flex h-full items-start gap-2 rounded-lg border border-line bg-card p-3 transition-colors hover:border-pine/50 hover:bg-pine-tint/40"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-[14px] font-bold text-ink">{ADMIN_SECTIONS[k].label}</span>
                            <span className="block text-[12px] text-ink-3">{SECTION_HINTS[k]}</span>
                          </span>
                          <ArrowRight className="mt-0.5 size-4 text-ink-4 group-hover:text-pine" />
                        </Link>
                      </li>
                    ))}
                </ul>
              </Card>
              <Card className="p-5">
                <SectionTitle>
                  <span className="flex items-center gap-2">
                    <History className="size-4 text-pine" /> 最近的设置变动
                  </span>
                </SectionTitle>
                {d.recentChanges === null ? (
                  <p className="mt-2 text-[13px] text-ink-3">查看审计的岗位才能看到变动记录。</p>
                ) : d.recentChanges.length === 0 ? (
                  <p className="mt-2 text-[13px] text-ink-3">还没有人改过规则、价目或员工。</p>
                ) : (
                  <ul className="mt-2 divide-y divide-line/70 text-[13px]" data-testid="admin-recent">
                    {d.recentChanges.map((c, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-x-2 py-2">
                        <span className="num text-[12px] text-ink-3">{formatDateTime(c.at)}</span>
                        <span className="font-semibold">{c.staffName ?? '系统'}</span>
                        <span className="text-ink-2">{c.summary}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {d.recentChanges !== null && sections.includes('audit') && (
                  <Link to="/admin/audit" className="mt-2 inline-block text-[12.5px] font-semibold text-pine hover:underline">
                    全部操作审计 →
                  </Link>
                )}
              </Card>
            </div>
          </div>
        )
      )}
    </AdminPage>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-[12.5px] font-semibold text-ink-3">{label}</p>
      <p className="mt-1 truncate text-[17px] font-bold text-ink" title={value}>
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 truncate text-[12px] text-ink-3" title={sub}>
          {sub}
        </p>
      )}
    </Card>
  );
}
