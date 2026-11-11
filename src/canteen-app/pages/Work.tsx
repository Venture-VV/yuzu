// 工作台（8.0.9，docs/PATROL_V809.md 第 3.1 节）：柚子饭堂慢慢变成员工端平台——员工能用的应用都放在这里，按部门、角色显示。
// 巡场、巡场记录由门店系统按部门与名单告诉手机（CanteenMe.apps，每个请求当场核对）；食堂的几样按角色显示。

import type { ReactNode } from 'react';
import { canEditMenu, canScan, canUseMailbox, type CanteenMe } from '@shared/canteen';
import { IconCamera, IconChef, IconLetter, IconShield, IconTicket, IconWork } from '../doodles';
import { cn } from '../ui';

interface Tile {
  key: string;
  route: string;
  label: string;
  hint: string;
  icon: ReactNode;
  accent?: boolean;
}

export function workTiles(me: CanteenMe): Tile[] {
  const role = me.employee.role;
  const apps = me.apps ?? [];
  const tiles: Tile[] = [];
  if (apps.includes('patrol')) tiles.push({ key: 'patrol', route: 'patrol', label: '巡场', hint: '扫场所二维码打卡', icon: <IconShield size={34} fill="var(--color-yuzu)" />, accent: true });
  if (apps.includes('patrolLog')) tiles.push({ key: 'patrolLog', route: 'patrolLog', label: '巡场记录', hint: '每天谁几点巡了哪里', icon: <IconShield size={34} />, accent: !apps.includes('patrol') });
  if (canScan(role)) tiles.push({ key: 'scan', route: 'scan', label: '饭堂扫码', hint: '扫饭卡码打卡', icon: <IconCamera size={34} /> });
  if (canEditMenu(role)) tiles.push({ key: 'kitchen', route: 'kitchen', label: '厨房', hint: '编辑、发布菜单', icon: <IconChef size={34} /> });
  if (canUseMailbox(role)) tiles.push({ key: 'mailbox', route: 'mailbox', label: '柚子信箱', hint: '看大家说的话、回信', icon: <IconLetter size={34} /> });
  tiles.push({ key: 'code', route: 'code', label: '饭卡码', hint: '开饭时亮出来', icon: <IconTicket size={34} /> });
  tiles.push({ key: 'talk', route: 'talk', label: '跟柚子说', hint: '心愿和碎碎念', icon: <IconLetter size={34} fill="var(--color-yuzu)" /> });
  return tiles;
}

export function WorkPage({ me, go }: { me: CanteenMe; go: (route: string) => void }) {
  const tiles = workTiles(me);
  return (
    <div className="space-y-4" data-testid="work-page">
      <div>
        <h1 className="flex items-center gap-1.5 text-[24px] font-black tracking-tight">
          <IconWork size={28} fill="var(--color-yuzu)" /> 工作台
        </h1>
        <p className="mt-1 text-[14px] text-ink-3">你能用的都在这里，以后会有更多</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => go(t.route)}
            data-testid={`work-${t.key}`}
            className={cn(
              'sketch flex flex-col items-start gap-2 rounded-[var(--radius-card)] px-4 py-4 text-left shadow-[var(--shadow-sticker)] active:scale-[0.98]',
              t.accent ? 'bg-yuzu-soft' : 'bg-card',
            )}
          >
            <span className="text-wood-ink">{t.icon}</span>
            <span className="text-[17px] font-black">{t.label}</span>
            <span className="text-[12.5px] text-ink-3">{t.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
