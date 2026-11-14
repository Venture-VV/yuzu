// 发券（8.0.19，docs/IA_V8017.md 第 3.4 节，IA4 店主 2026-11-13）：批量发券、无记名券是当班会做的事，
// 从后台「券」挪到门店——会员工作台右上角的「发券」。卡片、接口、权限（coupon.manage）都是原来的；
// 券模板、发券规则、统计与使用率仍在后台「券」。

import { Link, Navigate } from 'react-router';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { ADMIN_SECTIONS } from '@shared/admin';
import { useCan } from '../../lib/session';
import { PageHeader } from '../../components/AppShell';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { SubPane, SubTabPage, type SubTab } from '../../components/SubNav';
import { CampaignsCard } from '../admin/CampaignsCard';
import { BatchesCard } from '../admin/CouponsSection';
import { useInvalidateCoupons } from './queries';

export const COUPON_ISSUE_PATH = '/coupon-issue';

// 标识沿用后台原来那两个页签的（自动化用例按它们找）
const TABS: readonly SubTab[] = [
  { key: 'campaigns', label: '批量发券', testId: 'coupon-tab-campaigns' },
  { key: 'batches', label: '无记名券', testId: 'coupon-tab-batches' },
];

/** 这一页上会留下「结果待确认」的三种：批量发券、生成无记名券、发券给会员 */
const PENDING_TYPES = ['coupon_campaign', 'coupon_batch', 'coupon_issue'] as const;

export function CouponIssuePage() {
  const can = useCan();
  const invalidate = useInvalidateCoupons();
  if (!can('coupon.manage')) return <Navigate to="/" replace />;
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回会员工作台">
              <ArrowLeft className="size-[18px]" />
            </Link>
            发券
          </span>
        }
        subtitle="圈一批会员发券、生成无记名纸质券；给某一位会员发券在他的会员详情里"
        actions={
          <Link
            to={ADMIN_SECTIONS.coupons.path}
            className="flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3.5 text-[13.5px] font-bold text-ink-2 hover:border-ink-3"
            data-testid="coupon-issue-admin-link"
          >
            <Settings2 className="size-4" />
            券模板与发券规则
          </Link>
        }
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] px-5 py-5 md:px-7" data-testid="coupon-issue">
          <SubTabPage tabs={TABS} base={COUPON_ISSUE_PATH} label="发券的页签">
            <div className="space-y-4">
              {/* 发券时断网：关掉对话框、刷新、重新登录后在这里查回、按原内容重新提交或作废 */}
              <ErpPendingPanel types={PENDING_TYPES} className="space-y-2" onFound={() => void invalidate()} />
              <SubPane tab="campaigns" lazy>
                <CampaignsCard />
              </SubPane>
              <SubPane tab="batches" lazy>
                <BatchesCard />
              </SubPane>
            </div>
          </SubTabPage>
        </div>
      </div>
    </>
  );
}
