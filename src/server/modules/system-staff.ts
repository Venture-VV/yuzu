// 系统账号「小程序」（v0.7.26 起）：线上收款入账、小程序领券（v0.7.27）、邀请好友与扫码点餐（v0.7.28）的经办人。
// 第一次用到时建：不能登录（停用、没有能对上的密码），员工名单里不显示。

import type { Db, Tx } from '../db';
import type { Actor } from '../lib/context';
import { AppError } from '../lib/errors';

export const SYSTEM_MP_USERNAME = 'system.mp';
const SYSTEM_MP_NAME = '小程序';

/** 系统账号「小程序」的编号（在调用方的事务里；没有就建） */
export async function systemStaffId(tx: Tx): Promise<number> {
  const [row] = await tx<{ id: number; system: boolean }[]>`SELECT id, system FROM staff WHERE username = ${SYSTEM_MP_USERNAME}`;
  if (row?.system) return row.id;
  if (!row) {
    const [made] = await tx<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash, active, must_change_password, system)
      VALUES (${SYSTEM_MP_USERNAME}, ${SYSTEM_MP_NAME}, 'clerk', 'system:no-login', false, false, true)
      ON CONFLICT (username) DO NOTHING RETURNING id`;
    if (made) return made.id;
    // 同时有另一笔在建：它提交以后再读
    const [again] = await tx<{ id: number; system: boolean }[]>`SELECT id, system FROM staff WHERE username = ${SYSTEM_MP_USERNAME}`;
    if (again?.system) return again.id;
  }
  throw new AppError(500, 'SYSTEM_ACCOUNT_TAKEN', `员工账号 ${SYSTEM_MP_USERNAME} 被占用了，小程序的入账与领券要用这个系统账号；请店主改掉那位员工的账号`);
}

/** 系统账号「小程序」当经办人（小程序线调主线入口时；没有岗位权限，只按入口自己的规则办） */
export async function systemActor(tx: Tx): Promise<Actor> {
  return {
    id: await systemStaffId(tx),
    username: SYSTEM_MP_USERNAME,
    displayName: SYSTEM_MP_NAME,
    role: 'clerk',
    duties: [],
    mustChangePassword: false,
    permissions: [],
  };
}

// ───────────────────────── 系统账号「赠品出库」（8.0.4） ─────────────────────────

export const SYSTEM_GIFT_USERNAME = 'system.gift';
const SYSTEM_GIFT_NAME = '赠品出库';

/** 系统账号「赠品出库」的编号（买一赠一券核销后自动开直接耗用单的经办人；没有就建，不能登录、员工名单里不显示） */
export async function systemGiftStaffId(db: Db): Promise<number> {
  const [row] = await db<{ id: number; system: boolean }[]>`SELECT id, system FROM staff WHERE username = ${SYSTEM_GIFT_USERNAME}`;
  if (row?.system) return row.id;
  if (!row) {
    const [made] = await db<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash, active, must_change_password, system)
      VALUES (${SYSTEM_GIFT_USERNAME}, ${SYSTEM_GIFT_NAME}, 'clerk', 'system:no-login', false, false, true)
      ON CONFLICT (username) DO NOTHING RETURNING id`;
    if (made) return made.id;
    const [again] = await db<{ id: number; system: boolean }[]>`SELECT id, system FROM staff WHERE username = ${SYSTEM_GIFT_USERNAME}`;
    if (again?.system) return again.id;
  }
  throw new AppError(500, 'SYSTEM_ACCOUNT_TAKEN', `员工账号 ${SYSTEM_GIFT_USERNAME} 被占用了，买一赠一的赠品出库要用这个系统账号；请店主改掉那位员工的账号`);
}

/**
 * 系统账号「赠品出库」当经办人：只给自动开「直接耗用」单、冲销它用——带库存职责（总仓的耗用）与成本核算（各部门小仓的耗用），
 * 不带其他岗位权限
 */
export async function systemGiftActor(db: Db): Promise<Actor> {
  return {
    id: await systemGiftStaffId(db),
    username: SYSTEM_GIFT_USERNAME,
    displayName: SYSTEM_GIFT_NAME,
    role: 'clerk',
    duties: ['stock', 'cost'],
    mustChangePassword: false,
  };
}
