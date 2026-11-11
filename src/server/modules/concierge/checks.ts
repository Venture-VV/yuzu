// 自检（8.0.12 主线整改）：管家部的记录与修订历史对得上。前台自检（frontdesk/checks.ts）里的一条，`check` 命令与页面自检都带上。
//   · 管家会员、业务记录的每一版都有一份修订快照：版本号是几，修订历史里就有 1…N 这几版、不多不少；
//   · 余额依据指向的照片、凭证都在，凭证确实是凭证；
//   · 同步版本号只有一行。
// 管家部不碰钱包、结账、库存，所以这里不核对金额，只核对「改过的都留了痕」。

import type { FrontdeskCheck } from '@shared/frontdesk';
import type { Db } from '../../db';

export async function conciergeCheck(db: Db): Promise<FrontdeskCheck> {
  const bad = await db<{ ref: string }[]>`
    SELECT ref FROM (
      SELECT '管家会员 ' || lpad(m.code::text, 6, '0') AS ref
      FROM concierge_members m
      WHERE (SELECT count(*) FROM concierge_revisions r WHERE r.object_type = 'member' AND r.object_id = m.id AND r.version BETWEEN 1 AND m.version) <> m.version
         OR EXISTS (SELECT 1 FROM concierge_revisions r WHERE r.object_type = 'member' AND r.object_id = m.id AND r.version > m.version)
      UNION ALL
      SELECT '管家记录（' || c.kind || '）' || c.id AS ref
      FROM concierge_records c
      WHERE (SELECT count(*) FROM concierge_revisions r WHERE r.object_type = c.kind AND r.object_id = c.id AND r.version BETWEEN 1 AND c.version) <> c.version
         OR EXISTS (SELECT 1 FROM concierge_revisions r WHERE r.object_type = c.kind AND r.object_id = c.id AND r.version > c.version)
      UNION ALL
      SELECT '余额依据 ' || e.id AS ref
      FROM concierge_balance_evidence e
      LEFT JOIN concierge_records b ON b.id = e.balance_id AND b.kind = 'balance'
      LEFT JOIN concierge_records r ON r.id = e.receipt_id AND r.kind = 'receipt'
      WHERE b.id IS NULL OR (e.receipt_id IS NOT NULL AND r.id IS NULL)
      UNION ALL
      SELECT '同步版本号' AS ref WHERE (SELECT count(*) FROM concierge_sync) <> 1
    ) x
    LIMIT 5`;
  const [t] = await db<{ members: number; records: number; revisions: number }[]>`
    SELECT (SELECT count(*)::int FROM concierge_members) AS members,
           (SELECT count(*)::int FROM concierge_records) AS records,
           (SELECT count(*)::int FROM concierge_revisions) AS revisions`;
  return {
    key: 'concierge_records',
    label: '管家部的记录与修订历史一致',
    ok: bad.length === 0,
    detail: bad.length
      ? `管家部有记录与修订历史对不上（如 ${bad.map((b) => b.ref).join('、')}）`
      : `管家会员 ${t!.members} 位、业务记录 ${t!.records} 条，每一版都有修订快照（共 ${t!.revisions} 份）；余额依据都指得到`,
  };
}
