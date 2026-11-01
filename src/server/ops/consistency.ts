// 一致性自检：会员（含营业口径）、库存、前台。cli check 与备份核验共用同一套。

import { businessDateOf } from '@shared/business-date';
import { readSnapshot, type Sql } from '../db';
import { frontdeskChecks } from '../modules/frontdesk/checks';
import { inventoryChecks } from '../modules/inventory/reports';
import { expenseChecks } from '../modules/expenses';
import { requestChecks } from '../modules/requests';
import { legacyChecks } from '../modules/legacy';
import { spaceChecks } from '../modules/spaces';
import { floorplanChecks } from '../modules/floorplans';
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
  const expenses = await readSnapshot(sql, expenseChecks);
  const requests = await readSnapshot(sql, requestChecks);
  const frontdesk = await readSnapshot(sql, frontdeskChecks);
  // 旧账只读表与导入记录一致（v0.7.10；旧账不进正式账，这里只核对只读表没被动过）
  const legacy = await readSnapshot(sql, legacyChecks);
  // 空间台账与客房挂接（v0.7.14）
  const spaces = await readSnapshot(sql, spaceChecks);
  // 底图批次与房间轮廓（v0.7.15）
  const floorplans = await readSnapshot(sql, floorplanChecks);
  return [...summary.checks, ...inventory, ...expenses, ...requests, ...frontdesk, legacy, ...spaces, ...floorplans].map(({ label, ok, detail }) => ({ label, ok, detail }));
}
