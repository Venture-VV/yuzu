import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guard } from "../../auth/guard";
import { readSnapshot, type Db } from "../../db";
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
} from "./reads";
import { registerCustomerWriteRoutes } from "./writes";

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
        return readSnapshot(sql, (db) =>
          read(db, req.actor, config.timezone, req.query ?? {}, at),
        );
      },
    );
  };
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
      return readSnapshot(sql, (db) =>
        customerRecharge(db, req.actor, config.timezone, id, at),
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
      return readSnapshot(sql, (db) =>
        customerSettlement(db, req.actor, config.timezone, id, at, source),
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
      return readSnapshot(sql, (db) =>
        customerVisit(db, req.actor, config.timezone, id, at),
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
      return readSnapshot(sql, (db) =>
        customerMember(db, req.actor, config.timezone, id, req.query ?? {}, at),
      );
    },
  );
  registerCustomerWriteRoutes(app, { sql, config });
}
