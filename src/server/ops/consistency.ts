// 一致性自检：会员（含营业口径）、库存、前台。cli check 与备份核验共用同一套。

import { businessDateOf } from '@shared/business-date';
import { readSnapshot, type Sql } from '../db';
import { frontdeskChecks } from '../modules/frontdesk/checks';
import { inventoryChecks } from '../modules/inventory/reports';
import { computeSettlement } from '../modules/settlement';
import { loadSettings } from '../modules/settings';

export interface CheckLine {
  label: string;
  ok: boolean;
  detail: string;
}

export async function consistencyChecks(sql: Sql, timezone: string): Promise<CheckLine[]> {
  const settings = await loadSettings(sql);
  const today = businessDateOf(new Date(), timezone, settings.businessDayStartHour);
  const summary = await readSnapshot(sql, (tx) => computeSettlement(tx, today, today));
  const inventory = await readSnapshot(sql, inventoryChecks);
  const frontdesk = await readSnapshot(sql, frontdeskChecks);
  return [...summary.checks, ...inventory, ...frontdesk].map(({ label, ok, detail }) => ({ label, ok, detail }));
}
