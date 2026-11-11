// 点单密码（8.0.10，docs/EMENU.md 第 3.7 节，DC2）：服务员在平板上确认下单用的 6 位数字。
//
//   · 系统生成、当场显示一次（不让自己挑：撞上别人的时候等于告诉他别人的密码）；店主在后台「员工账号」给人生成、重置、收回，
//     本人登录后也能在「修改密码」页自己重新生成；
//   · 只凭密码认人：库里另存前三位（slot，系统生成时保证不重复），按它找到那位员工，再核对整个密码的 scrypt 摘要；
//   · 输错限次与登录、当场授权共用同一份计数（auth/lockout.ts）：按「这台平板登录的账号 + 来源地址」记，15 分钟内错 5 次锁 5 分钟；
//   · 6 位数字只有一百万种，库泄露后怎么存都能很快试出来，防护在线上：要先登录平板账号、输错限次、每次确认都记审计。
// 加锁：生成、重置、收回先取这位员工的点单密码咨询锁（同一位员工的几次串行）；前三位撞了靠唯一约束兜底、换一个再试。

import { randomInt } from 'node:crypto';
import { EMENU_PIN_LENGTH, type OrderPinStatus } from '@shared/emenu';
import { can, type Duty, type Role } from '@shared/permissions';
import { isUniqueViolation, type Db } from '../../db';
import { checkLock, clearFailures, lockMinutesLeft, recordFailure } from '../../auth/lockout';
import { hashPassword, verifyPassword } from '../../auth/password';
import { subjectOf } from '../../auth/role-permissions';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps, OpContext } from '../../lib/context';
import { AppError, notFound } from '../../lib/errors';

const PIN_PATTERN = new RegExp(`^[0-9]{${EMENU_PIN_LENGTH}}$`);

/** 太好猜的不发：六位一样（000000）、连着的（123456、654321、012345……） */
function trivial(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const steps = [...pin].slice(1).map((c, i) => (Number(c) - Number(pin[i]) + 10) % 10);
  return steps.every((s) => s === 1) || steps.every((s) => s === 9);
}

function randomPin(): string {
  for (;;) {
    const pin = String(randomInt(0, 10 ** EMENU_PIN_LENGTH)).padStart(EMENU_PIN_LENGTH, '0');
    if (!trivial(pin)) return pin;
  }
}

export async function orderPinStatus(db: Db, staffId: number): Promise<OrderPinStatus> {
  const [row] = await db<{ setAt: string }[]>`SELECT set_at FROM staff_order_pins WHERE staff_id = ${staffId}`;
  return { has: !!row, setAt: row ? new Date(row.setAt).toISOString() : null };
}

/**
 * 给一位员工生成（或重置）点单密码，返回这一次的密码（只在这里出现一次，库里只有摘要）。
 * 停用的、系统账号不能生成；「点餐平板」账号不是人，也不发。
 */
export async function setOrderPin(deps: Deps, staffId: number, ctx: OpContext): Promise<{ pin: string; setAt: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const pin = randomPin();
    const hash = await hashPassword(pin);
    try {
      const setAt = await deps.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`order_pin:${staffId}`}))`;
        const [s] = await tx<{ active: boolean; system: boolean; role: Role; displayName: string }[]>`
          SELECT active, system, role, display_name FROM staff WHERE id = ${staffId}`;
        if (!s || s.system) throw notFound('员工不存在');
        if (!s.active) throw new AppError(422, 'STAFF_INACTIVE', '这位员工已停用，不能生成点单密码');
        if (s.role === 'tablet') throw new AppError(422, 'PIN_NOT_FOR_TABLET', '「点餐平板」是设备账号，不用点单密码；请给点单的同事生成');
        // 前三位已经有人在用：换一个再试（不告诉调用方是谁的）
        const [taken] = await tx<{ staffId: number }[]>`SELECT staff_id FROM staff_order_pins WHERE slot = ${pin.slice(0, 3)} AND staff_id <> ${staffId}`;
        if (taken) return null;
        const [row] = await tx<{ setAt: string }[]>`
          INSERT INTO staff_order_pins (staff_id, slot, pin_hash, set_by, set_at) VALUES (${staffId}, ${pin.slice(0, 3)}, ${hash}, ${ctx.actor.id}, now())
          ON CONFLICT (staff_id) DO UPDATE SET slot = EXCLUDED.slot, pin_hash = EXCLUDED.pin_hash, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
          RETURNING set_at`;
        await writeAudit(tx, {
          staffId: ctx.actor.id,
          action: 'order_pin_set',
          targetType: 'staff',
          targetId: staffId,
          detail: { summary: `${ctx.actor.id === staffId ? '自己重新生成' : `给${s.displayName}生成`}点单密码` },
          ip: ctx.ip,
        });
        return new Date(row!.setAt).toISOString();
      });
      if (setAt) return { pin, setAt };
    } catch (error) {
      // 两个人同时生成、前三位正好一样：唯一约束拦下后面那个，换一个再试
      if (!isUniqueViolation(error, 'staff_order_pins_slot_key')) throw error;
    }
  }
  throw new AppError(503, 'PIN_SLOTS_FULL', '点单密码暂时生成不出来，请稍后再试');
}

/** 收回一位员工的点单密码（之后这个密码不能再确认下单）；本来就没有的照样算成功 */
export async function clearOrderPin(deps: Deps, staffId: number, ctx: OpContext): Promise<void> {
  await deps.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`order_pin:${staffId}`}))`;
    const [s] = await tx<{ system: boolean; displayName: string }[]>`SELECT system, display_name FROM staff WHERE id = ${staffId}`;
    if (!s || s.system) throw notFound('员工不存在');
    const gone = await tx`DELETE FROM staff_order_pins WHERE staff_id = ${staffId} RETURNING staff_id`;
    if (gone.length) {
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'order_pin_cleared', targetType: 'staff', targetId: staffId, detail: { summary: `收回${s.displayName}的点单密码` }, ip: ctx.ip });
    }
  });
}

// 没有这个前三位时也算一次摘要，响应时间与「有这个人但密码不对」差不多
let dummyHash: Promise<string> | null = null;

interface PinStaff {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  duties: Duty[] | null;
  active: boolean;
}

async function findByPin(db: Db, pin: string): Promise<PinStaff | null> {
  const [row] = await db<(PinStaff & { pinHash: string })[]>`
    SELECT s.id, s.username, s.display_name, s.role, s.duties, s.active, p.pin_hash
    FROM staff_order_pins p JOIN staff s ON s.id = p.staff_id WHERE p.slot = ${pin.slice(0, 3)} AND NOT s.system`;
  if (!row) {
    dummyHash ??= hashPassword('yuzu-order-pin-dummy');
    await verifyPassword(pin, await dummyHash);
    return null;
  }
  const { pinHash, ...staff } = row;
  return (await verifyPassword(pin, pinHash)) ? staff : null;
}

/**
 * 平板上输的点单密码 → 确认下单的那位服务员（按后台调整后的岗位权限算好权限）。
 * 密码不对、员工已停用：记一次失败（PIN_INVALID，403——不用 401，免得把平板的登录踢掉）；这台平板错太多次：PIN_LOCKED（429）；
 * 密码对、但没有「餐饮点单」+「前台挂账」：PIN_NO_PERMISSION（403，不算输错）。
 * device：这台平板登录的账号；source：来源地址。
 */
export async function resolveWaiter(deps: Deps, pin: unknown, device: Actor, source: string): Promise<Actor> {
  const name = `order-pin#${device.id}`;
  const locked = lockMinutesLeft(name, source);
  if (locked !== null) throw new AppError(429, 'PIN_LOCKED', `点单密码输错的次数太多，请 ${locked} 分钟后再试`, { minutes: locked });
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) throw new AppError(400, 'BAD_REQUEST', `请输入 ${EMENU_PIN_LENGTH} 位点单密码`, { field: 'pin' });
  const staff = await findByPin(deps.sql, pin);
  if (!staff || !staff.active) {
    recordFailure(name, source);
    await writeAudit(deps.sql, { staffId: device.id, action: 'order_pin_failed', detail: { reason: staff ? 'inactive' : 'bad_pin' }, ip: source });
    // 这一次正好到上限：直接告诉他锁了多久
    const now = lockMinutesLeft(name, source);
    if (now !== null) throw new AppError(429, 'PIN_LOCKED', `点单密码输错的次数太多，请 ${now} 分钟后再试`, { minutes: now });
    throw new AppError(403, 'PIN_INVALID', '点单密码不正确');
  }
  // 与登录共用的检查都过了才清计数；checkLock 留给来源被拦的情形（lockMinutesLeft 已经看过，这里再走一遍只为与登录同一套）
  checkLock(name, source);
  clearFailures(name, source);
  const subject = await subjectOf(deps.sql, staff);
  const actor: Actor = {
    id: staff.id,
    username: staff.username,
    displayName: staff.displayName,
    role: staff.role,
    duties: staff.duties ?? [],
    mustChangePassword: false,
    permissions: subject.permissions,
  };
  if (!can(actor, 'dining.order') || !can(actor, 'frontdesk.operate')) {
    throw new AppError(403, 'PIN_NO_PERMISSION', `${staff.displayName}没有点单权限（要「餐饮点单」与「前台挂账」），请换一位同事确认`);
  }
  return actor;
}
