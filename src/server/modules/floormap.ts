// 房态图（飞书需求 RQ-004 第三段，v0.7.16，见 docs/ROOMMAP.md）：只读接口。
//   · 楼层与房间轮廓：在用的底图（floorplans.ts 的 GET /api/floorplans/active，页面只取一次，换了一批再取）；
//   · 客房的房态：「客房」房态看板（rooms.ts 的 GET /api/rooms），与看板同一个口径；
//   · 这里给空间台账里的空间（着色、点开看信息）与记了房间、还没结束的钟单（技师房的空闲、服务中），页面每 5 秒取一次。
// 谁能看：看得到「客房」的岗位（客房入住、客房打扫、收银）；只显示手牌号与技师，不显示会员姓名、手机号。

import type { FastifyInstance } from 'fastify';
import type { FloorMapData, FloorMapSession, FloorMapSpace } from '@shared/floormap';
import type { Db } from '../db';
import { guardAny } from '../auth/guard';
import type { Deps } from '../lib/context';

export async function floorMapData(db: Db): Promise<FloorMapData> {
  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  const [batch] = await db<{ id: number }[]>`SELECT id FROM floorplan_batches WHERE status = 'active'`;
  const spaces = await db<FloorMapSpace[]>`
    SELECT sp.id, sp.code, f.code AS floor_code, f.name AS floor_name, sp.zone_id, z.name AS zone_name, sp.business_type, sp.capacity, sp.area_centi_m2,
           sp.display_name, sp.sellable, sp.active,
           coalesce((SELECT array_agg(a.alias ORDER BY a.id) FROM space_aliases a WHERE a.space_id = sp.id AND a.active), '{}') AS aliases,
           (SELECT r.id FROM rooms r WHERE r.space_id = sp.id) AS room_id
    FROM spaces sp JOIN floors f ON f.id = sp.floor_id LEFT JOIN zones z ON z.id = sp.zone_id
    ORDER BY f.sort_order, f.code, sp.code`;
  const sessions = await db<(Omit<FloorMapSession, 'plannedEnd'> & { startedAt: string | null; createdAt: string })[]>`
    SELECT s.id, s.session_no, s.space_id, t.tech_no, t.name AS tech_name, h.code AS tag_code, i.name AS item_name, s.clocks, s.minutes, s.status,
           s.created_at, s.started_at
    FROM technician_sessions s JOIN visits v ON v.id = s.visit_id JOIN technicians t ON t.id = s.technician_id
    JOIN hand_tags h ON h.id = v.tag_id JOIN service_items i ON i.id = s.item_id
    WHERE s.space_id IS NOT NULL AND s.status IN ('waiting', 'serving') AND v.status = 'open'
    ORDER BY s.space_id, (s.status = 'serving') DESC, coalesce(s.started_at, s.created_at), s.id`;
  return {
    serverTime: new Date(now!.now).toISOString(),
    floorplanBatchId: batch?.id ?? null,
    spaces,
    sessions: sessions.map((s) => ({
      ...s,
      createdAt: new Date(s.createdAt).toISOString(),
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      plannedEnd: s.startedAt ? new Date(new Date(s.startedAt).getTime() + s.minutes * 60_000).toISOString() : null,
    })),
  };
}

export function registerFloorMapRoutes(app: FastifyInstance, deps: Deps) {
  // 与「客房」页（房态看板）同一组岗位
  const read = guardAny('room.operate', 'room.housekeep', 'frontdesk.checkout');
  app.get('/api/floormap', { preHandler: read }, async () => floorMapData(deps.sql));
}
