// 每月盘点提醒（#23，v0.7.13）：从盘点日起到月底，列出还没盘完的仓（月初有结存的物料本月盘到了几种）

import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, ClipboardCheck } from 'lucide-react';
import type { StocktakeProgress, StocktakeReminders } from '@shared/cycles';
import { Notice } from '../../components/ui';

const md = (date: string) => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;

export function StocktakeNotice({
  data,
  linkFor,
  className,
}: {
  data: StocktakeReminders | undefined;
  /** 「去盘点」的地址；没有权限登记的仓返回 null */
  linkFor?: (w: StocktakeProgress) => string | null;
  className?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (!data || !data.active) return null;
  const pending = data.warehouses.filter((w) => !w.done);
  if (pending.length === 0) return null;
  const month = Number(data.month.slice(5, 7));
  const title =
    data.warehouses.length === 1 ? `${month} 月盘点：${pending[0]!.warehouseName}还没盘完` : `${month} 月盘点：还有 ${pending.length} 个仓没盘完`;
  return (
    <Notice tone={data.overdue ? 'error' : 'warning'} icon={<ClipboardCheck className="size-5" />} title={data.overdue ? `${title}（已过 ${md(data.dueDate)}）` : title} className={className}>
      <p>
        每月 {Number(data.startDate.slice(8, 10))} 号起盘点，{md(data.dueDate)}起标红。月初有结存的物料都在本月的盘点单里盘到才算盘完（盘点单提交或生效都算）；台面日耗品不用清点。
      </p>
      <ul className="mt-2 space-y-1.5" data-testid="stocktake-reminders">
        {pending.map((w) => {
          const link = linkFor?.(w) ?? null;
          const more = w.required - w.counted - w.missing.length;
          return (
            <li key={w.warehouseId}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-bold">{w.warehouseName}</span>
                <span className="num">
                  已盘 {w.counted} / {w.required} 种
                </span>
                <button type="button" className="text-[12.5px] font-semibold underline underline-offset-2" onClick={() => setOpen(open === w.warehouseId ? null : w.warehouseId)}>
                  {open === w.warehouseId ? '收起' : '还没盘的'}
                </button>
                {link && (
                  <Link to={link} className="flex items-center gap-1 text-[12.5px] font-bold underline underline-offset-2">
                    去盘点 <ArrowRight className="size-3.5" />
                  </Link>
                )}
              </div>
              {open === w.warehouseId && (
                <p className="mt-0.5 text-[12.5px]">
                  {w.missing.map((m) => m.name).join('、')}
                  {more > 0 && ` 等 ${w.required - w.counted} 种`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Notice>
  );
}
