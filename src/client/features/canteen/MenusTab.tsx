// 菜单（只看）：一周一张表，厨师和负责人在手机上的「柚子饭堂 → 厨房」里发布；这里看得到草稿、发布状态和赞数。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MEAL_EMOJI, MEAL_LABELS, type CanteenMenu } from '@shared/canteen';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { Badge, Button, Card, Skeleton } from '../../components/ui';
import { useOverview } from './CanteenPage';

const add = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function MenusTab() {
  const session = useSession();
  // 从昨天起看一周：过了零点还在开的那一餐记在前一天，昨天的菜收到几个赞也看得到
  const start = add(session.calendarToday, -1);
  const [from, setFrom] = useState(start);
  const to = add(from, 6);
  const overview = useOverview();
  const q = useQuery({ queryKey: ['canteen', 'menus', from], queryFn: () => api.get<CanteenMenu[]>(`/api/erp/canteen/menus?from=${from}&to=${to}`) });
  const meals = (overview.data?.settings.meals ?? []).filter((m) => m.enabled).map((m) => m.meal);
  const days = Array.from({ length: 7 }, (_, i) => add(from, i));
  return (
    <div className="space-y-4" data-testid="canteen-menus">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" icon={<ChevronLeft className="size-4" />} onClick={() => setFrom(add(from, -7))}>
          上一周
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setFrom(start)}>
          这一周
        </Button>
        <Button variant="secondary" size="sm" icon={<ChevronRight className="size-4" />} onClick={() => setFrom(add(from, 7))}>
          下一周
        </Button>
        <p className="ml-auto text-[12.5px] text-ink-3">菜单由厨师、食堂负责人在手机上的「柚子饭堂 → 厨房」里编辑和发布，这里只看。</p>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="border-b border-line text-left text-[12px] text-ink-3">
              <tr>
                <th className="w-24 px-4 py-2.5 font-semibold">日子</th>
                {meals.map((m) => (
                  <th key={m} className="px-3 py-2.5 font-semibold">
                    {MEAL_EMOJI[m]} {MEAL_LABELS[m]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line align-top">
              {days.map((d) => (
                <tr key={d} className={d === session.calendarToday ? 'bg-yuzu-tint/50' : ''}>
                  <td className="px-4 py-3">
                    <p className="font-semibold">{d.slice(5)}</p>
                    <p className="text-[12px] text-ink-3">周{WEEK[new Date(`${d}T00:00:00Z`).getUTCDay()]}</p>
                  </td>
                  {meals.map((m) => {
                    const menu = q.data?.find((x) => x.date === d && x.meal === m);
                    return (
                      <td key={m} className="px-3 py-3">
                        {!menu ? (
                          <span className="text-ink-4">还没写</span>
                        ) : (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5">
                              {menu.published ? <Badge tone="pine">已发布</Badge> : <Badge tone="neutral">草稿</Badge>}
                              <span className="truncate text-[11.5px] text-ink-3" title={formatDateTime(menu.updatedAt)}>
                                {menu.updatedByName}
                              </span>
                            </div>
                            <ul className="space-y-0.5">
                              {menu.dishes.map((dish) => (
                                <li key={dish.id} className="flex items-center gap-1">
                                  <span>{dish.emoji}</span>
                                  <span className="truncate">{dish.name}</span>
                                  {(menu.likes[dish.id] ?? 0) > 0 && <span className="ml-auto shrink-0 text-[11.5px] text-clay">❤️{menu.likes[dish.id]}</span>}
                                </li>
                              ))}
                            </ul>
                            {menu.note && <p className="text-[12px] text-ink-3">📝 {menu.note}</p>}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
