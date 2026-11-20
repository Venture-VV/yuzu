// 前台「结果待确认」查回、作废走哪个地址（8.1.15，Codex 审查 f6327a4）：点单页的下单（挂账）走餐饮的地址——
// 下单只要「餐饮点单」，康美部没有前台权限；其余照旧走前台的。不要数据库。

import { describe, expect, it } from 'vitest';
import { opsPath } from '../src/client/features/frontdesk/pending';

describe('结果待确认的查回、作废地址', () => {
  it('点单页的下单走 /api/dining/ops；前台加项目、桌台点单、发牌照旧走 /api/frontdesk/ops', () => {
    expect(opsPath({ key: 'k1', type: 'bill_post', url: '/api/dining/orders' })).toBe('/api/dining/ops/k1');
    expect(opsPath({ key: 'k2', type: 'bill_post', url: '/api/frontdesk/visits/3/charges' })).toBe('/api/frontdesk/ops/k2');
    expect(opsPath({ key: 'k3', type: 'table_post', url: '/api/dining/tables/sessions/5/orders' })).toBe('/api/frontdesk/ops/k3');
    expect(opsPath({ key: 'k4', type: 'checkin', url: '/api/frontdesk/checkins' })).toBe('/api/frontdesk/ops/k4');
  });
});
