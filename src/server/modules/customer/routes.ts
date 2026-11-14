import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can } from "@shared/permissions";
import { maskPhone } from "@shared/labels";
import { guard } from "../../auth/guard";
import { readSnapshot, type Db, type Sql, type Tx } from "../../db";
import type { Actor, Deps } from "../../lib/context";
import { idParam, parse } from "../../lib/validate";
import {
  customerOverview,
  customerRecharges,
  customerRecharge,
  customerSettlements,
  customerSettlement,
  customerVisits,
  customerVisit,
  customerMembers,
  customerMember,
  customerTargets,
  customerBindings,
  customerLowBalances,
  customerPerformance,
  customerRevision,
} from "./reads";
import { registerCustomerWriteRoutes } from "./writes";

/**
 * 没有「查找与查看会员」权限的账号（自定义岗位只给了客户部权限的）：接口返回的会员手机号打码，
 * 和管家部同一条规则（concierge/native-links 的 maskUnservedPhone）；仍然可以按手机号查找。
 * 客户部的读取结果里手机号只出现在会员对象的 phone 上，这里统一处理，免得哪个新加的读取漏掉。
 */
/**
 * 客户部的读取都在只读快照里做，并关掉这一个事务的 JIT：这些统计查询的估算成本高、实际只动几百到几千行，
 * 默认配置下会触发 JIT，编译比查询本身慢好几倍（大库实测：结算列表 660 → 110 毫秒，低余额 450 → 77 毫秒）。做法同管家部的同步指纹。
 */
function readNoJit<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return readSnapshot(sql, async (tx) => {
    await tx`SET LOCAL jit = off`;
    return fn(tx);
  });
}
export function maskCustomerPhones<T>(value: T, actor: Actor): T {
  if (can(actor, "member.read")) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        out[k] = k === "phone" && typeof x === "string" ? maskPhone(x) : walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export function registerCustomerRoutes(
  app: FastifyInstance,
  { sql, config }: Deps,
) {
  const list = (
    path: string,
    read: (
      db: Db,
      actor: Actor,
      timezone: string,
      query: unknown,
      at: Date,
    ) => Promise<unknown>,
  ) => {
    app.get(
      "/api/customer/" + path,
      { preHandler: guard("customer.read") },
      async (req, reply) => {
        reply.header("Cache-Control", "private, no-store");
        const at = new Date();
        return maskCustomerPhones(
          await readNoJit(sql, (db) =>
            read(db, req.actor, config.timezone, req.query ?? {}, at),
          ),
          req.actor,
        );
      },
    );
  };
  // 每个开着的客户部页面每 3 秒来一次，必须便宜：只取几个主键上的最大编号与开着的账单的合计（见 customerRevision）；
  // 与其他读取一样关掉这一个事务的 JIT（readNoJit）
  app.get(
    "/api/customer/revision",
    { preHandler: guard("customer.read") },
    async (_req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      return readNoJit(sql, async (tx) => ({ revision: await customerRevision(tx, config.timezone) }));
    },
  );
  list("overview", customerOverview);
  list("recharges", customerRecharges);
  list("settlements", customerSettlements);
  list("visits", customerVisits);
  list("members", customerMembers);
  list("targets", customerTargets);
  list("bindings", customerBindings);
  list("low-balances", customerLowBalances);
  list("performance", customerPerformance);
  app.get(
    "/api/customer/recharges/:id",
    { preHandler: guard("customer.read") },
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const { id } = parse(idParam, req.params),
        at = new Date();
      return maskCustomerPhones(
        await readNoJit(sql, (db) =>
          customerRecharge(db, req.actor, config.timezone, id, at),
        ),
        req.actor,
      );
    },
  );
  app.get(
    "/api/customer/settlements/:id",
    { preHandler: guard("customer.read") },
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const { id } = parse(idParam, req.params),
        at = new Date();
      const { source } = parse(
        z.object({
          source: z.enum(["checkout", "consumption"]).default("checkout"),
        }),
        req.query ?? {},
      );
      return maskCustomerPhones(
        await readNoJit(sql, (db) =>
          customerSettlement(db, req.actor, config.timezone, id, at, source),
        ),
        req.actor,
      );
    },
  );
  app.get(
    "/api/customer/visits/:id",
    { preHandler: guard("customer.read") },
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const { id } = parse(idParam, req.params),
        at = new Date();
      return maskCustomerPhones(
        await readNoJit(sql, (db) =>
          customerVisit(db, req.actor, config.timezone, id, at),
        ),
        req.actor,
      );
    },
  );
  app.get(
    "/api/customer/members/:id",
    { preHandler: guard("customer.read") },
    async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const { id } = parse(idParam, req.params),
        at = new Date();
      return maskCustomerPhones(
        await readNoJit(sql, (db) =>
          customerMember(db, req.actor, config.timezone, id, req.query ?? {}, at),
        ),
        req.actor,
      );
    },
  );
  registerCustomerWriteRoutes(app, { sql, config });
}
