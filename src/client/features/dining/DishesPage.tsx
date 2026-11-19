// 菜品管理的单独入口（8.1.15，docs/DISHES_V8115.md 第 7 节，CP7）。
// 平时「菜品管理」是餐饮里的一个页签；只有菜品权限、进不了餐饮的岗位（没有点单、厨房出品屏、结账这些；少见）从主导航的「菜品」进到这里。
// 进得了餐饮的直接跳到餐饮里的那个页签，不留两个一样的页面。

import { Navigate } from 'react-router';
import { useCan, useSession } from '../../lib/session';
import { PageHeader } from '../../components/AppShell';
import { storePageOf } from '../../components/storeNav';
import { Notice } from '../../components/ui';
import { DishesTab } from './DishesTab';

export function DishesPage() {
  const session = useSession();
  const can = useCan();
  const dining = storePageOf('/dining');
  if (dining && (Array.isArray(dining.perm) ? dining.perm : [dining.perm]).some((p) => can(p))) return <Navigate to="/dining/dishes" replace />;
  return (
    <>
      <PageHeader title="菜品管理" subtitle="全部菜品在一张表里：新增、编辑、上下架、做法、加料、套餐、改价（留改价记录），Excel 导出与导入" />
      {session.dining ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <DishesTab />
        </div>
      ) : (
        <div className="p-8">
          <Notice tone="info" title="餐饮功能没有开启">
            店主在「后台 → 餐饮」开启餐饮功能后，这里维护菜品。
          </Notice>
        </div>
      )}
    </>
  );
}
