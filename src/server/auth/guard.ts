import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { can, type Permission } from '@shared/permissions';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import type { Actor } from '../lib/context';

declare module 'fastify' {
  interface FastifyRequest {
    /** 已登录员工；由 app.ts 中的 onRequest 钩子解析会话后写入 */
    actor: Actor;
    hasSession: boolean;
  }
}

/**
 * 路由权限守卫：未登录 → 401；首次登录未改密码 → 只放行改密码；无权限 → 403。
 * 不传权限时只要求登录。
 */
export function guard(...permissions: Permission[]): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.hasSession) throw unauthorized();
    if (req.actor.mustChangePassword) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '首次登录请先修改密码');
    }
    for (const p of permissions) {
      if (!can(req.actor, p)) throw forbidden();
    }
  };
}

/** 只要求已登录（允许尚未修改初始密码的员工访问）。 */
export const sessionOnly: preHandlerAsyncHookHandler = async (req) => {
  if (!req.hasSession) throw unauthorized();
};

/** 有其中任一权限即可（后台各分区、看板各页按岗位开放） */
export function guardAny(...permissions: Permission[]): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.hasSession) throw unauthorized();
    if (req.actor.mustChangePassword) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '首次登录请先修改密码');
    }
    if (!permissions.some((p) => can(req.actor, p))) throw forbidden();
  };
}
