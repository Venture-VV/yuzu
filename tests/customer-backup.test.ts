// Real pg_dump/pg_restore, using only the isolated TEST_DATABASE_URL and a new scratch test database.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { businessDateOf } from "../src/shared/business-date";
import { createSql, type Sql } from "../src/server/db";
import { createStaff } from "../src/server/modules/staff";
import { loadSettings } from "../src/server/modules/settings";
import { customerChecks } from "../src/server/modules/customer/checks";
import { createBackup, type BackupManifest } from "../src/server/ops/backup";
import { consistencyChecks } from "../src/server/ops/consistency";
import {
  computeFingerprint,
  diffFingerprints,
} from "../src/server/ops/fingerprint";
import {
  api,
  consumeBody,
  createMember,
  login,
  PASSWORD,
  rechargeBody,
  setup,
  type TestContext,
} from "./helpers";
import { assertTestDbName } from "./test-db";

let ctx: TestContext;
let dir: string;
const customerTables = [
  ["customer_bindings", "member_id"],
  ["customer_binding_requests", "id"],
  ["customer_binding_events", "id"],
  ["customer_service_notes", "id"],
  ["customer_recharge_credits", "id"],
  ["customer_credit_events", "id"],
  ["customer_month_targets", "id"],
  ["customer_target_versions", "id"],
] as const;

/** Fixed, trusted table names only. Compare every persisted field, not just record counts. */
async function customerSnapshot(sql: Sql) {
  const rows: Record<string, unknown> = {};
  for (const [table, order] of customerTables)
    rows[table] = await sql.unsafe(`SELECT * FROM ${table} ORDER BY ${order}`);
  return JSON.stringify(rows);
}
async function walletSnapshot(sql: Sql) {
  return JSON.stringify({
    members:
      await sql`SELECT id,member_no,principal_balance,bonus_balance,grade,tier FROM members ORDER BY id`,
    ledger: await sql`SELECT * FROM ledger_entries ORDER BY id`,
    recharges: await sql`SELECT * FROM recharges ORDER BY id`,
    consumptions: await sql`SELECT * FROM consumptions ORDER BY id`,
    bonusLots: await sql`SELECT * FROM bonus_lots ORDER BY id`,
  });
}
beforeAll(async () => {
  ctx = await setup();
  assertTestDbName(ctx.config.databaseUrl);
  dir = await mkdtemp(join(tmpdir(), "yuzu-customer-backup-"));
});
afterAll(async () => {
  await ctx?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("restores service, approved binding, confirmed sale and target revisions with identical fingerprints and unchanged native money", async () => {
  const managerId = await createStaff(ctx.sql, {
    username: "backup_customer",
    displayName: "合成备份客户经理",
    role: "account_manager",
    password: PASSWORD,
    mustChangePassword: false,
  });
  const manager = await login(ctx.app, "backup_customer");
  const member = await createMember(ctx, "合成客户部备份会员", "19900008301");
  await ctx.sql`UPDATE members SET is_synthetic=true WHERE id=${member.id}`;
  const write = async (
    path: string,
    payload: Record<string, unknown>,
    cookie = ctx.owner,
  ) => {
    const result = await api(ctx.app, cookie, "POST", "/api/customer/" + path, {
      requestKey: randomUUID(),
      ...payload,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body as { id: number };
  };
  const request = await write(
    "bindings/requests",
    {
      memberId: member.id,
      toStaffId: managerId,
      expectedVersion: 0,
      reason: "合成备份维护申请",
    },
    manager,
  );
  await write(`bindings/requests/${request.id}/review`, {
    expectedVersion: 1,
    decision: "approve",
    reason: "合成备份批准绑定",
  });
  const recharge = await api(
    ctx.app,
    ctx.owner,
    "POST",
    "/api/recharges",
    rechargeBody(member.id, 100000),
  );
  expect(recharge.status, JSON.stringify(recharge.body)).toBe(200);
  const consume = await api(
    ctx.app,
    ctx.owner,
    "POST",
    "/api/consumptions",
    consumeBody(member.id, 2500),
  );
  expect(consume.status, JSON.stringify(consume.body)).toBe(200);
  await write(
    "notes",
    {
      memberId: member.id,
      kind: "maintenance",
      occurredAt: new Date().toISOString(),
      outcome: "合成回访已完成",
      content: "备份恢复必须保留的合成服务原文",
      feedback: "客人明确为虚拟样例",
      nextContactOn: null,
    },
    manager,
  );
  const claim = await write(
    "credits/claim",
    {
      rechargeId: recharge.body.recharge.id,
      sellerId: managerId,
      firstKind: "first",
      ownerDepartment: "customer",
      expectedVersion: 0,
      reason: "合成备份实际成交归属",
    },
    manager,
  );
  await write(`credits/${claim.id}/review`, {
    expectedVersion: 1,
    decision: "verify",
    reason: "合成备份核定成交",
  });
  const settings = await loadSettings(ctx.sql);
  const month = businessDateOf(
    new Date(),
    ctx.config.timezone,
    settings.businessDayStartHour,
  ).slice(0, 7);
  await write("targets", {
    month,
    staffId: null,
    amountCents: 300000,
    expectedVersion: 0,
    reason: "合成备份部门目标",
  });
  await write("targets", {
    month,
    staffId: managerId,
    amountCents: 100000,
    expectedVersion: 0,
    reason: "合成备份个人目标初版",
  });
  await write("targets", {
    month,
    staffId: managerId,
    amountCents: 120000,
    expectedVersion: 1,
    reason: "合成备份个人目标第二版",
  });

  const expectedRows: Record<string, number> = {
    customer_bindings: 1,
    customer_binding_requests: 1,
    customer_binding_events: 1,
    customer_service_notes: 1,
    customer_recharge_credits: 1,
    customer_credit_events: 2,
    customer_month_targets: 2,
    customer_target_versions: 3,
  };
  const originalRecords = await customerSnapshot(ctx.sql);
  const originalWallet = await walletSnapshot(ctx.sql);
  const originalFingerprint = await computeFingerprint(ctx.sql);
  for (const [table] of customerTables)
    expect(
      originalFingerprint.tables.find((t) => t.name === table)?.rows,
      table,
    ).toBe(expectedRows[table]);
  const [balance] =
    await ctx.sql`SELECT principal_balance,bonus_balance FROM members WHERE id=${member.id}`;
  expect(balance).toEqual({ principalBalance: 97500, bonusBalance: 0 });
  expect((await customerChecks(ctx.sql)).every((c) => c.ok)).toBe(true);

  const manifest = await createBackup(ctx.config, dir, "customer");
  expect(manifest.verified, manifest.verifyError).toBe(true);
  expect(manifest.checks?.failed).toEqual([]);
  expect(manifest.fingerprintDigest).toBe(originalFingerprint.digest);
  const persisted = JSON.parse(
    await readFile(join(dir, manifest.file + ".json"), "utf8"),
  ) as BackupManifest;
  expect(persisted.sha256).toBe(manifest.sha256);
  for (const [table] of customerTables)
    expect(
      persisted.fingerprint?.tables.find((t) => t.name === table)?.rows,
      table,
    ).toBe(expectedRows[table]);

  // Restore this exact archive again into an explicitly named test database for per-record assertions.
  const scratchName =
    "yuzu_customer_restore_test_" +
    randomUUID().replaceAll("-", "").slice(0, 12);
  const scratchUrl = new URL(ctx.config.databaseUrl);
  scratchUrl.pathname = "/" + scratchName;
  assertTestDbName(scratchUrl.toString());
  await ctx.sql.unsafe(`CREATE DATABASE "${scratchName}"`);
  const restored = createSql(scratchUrl.toString(), { max: 3 });
  try {
    // Credentials stay in the process environment, never in command arguments or test output.
    await promisify(execFile)(
      "pg_restore",
      [
        "--no-owner",
        "--exit-on-error",
        "--dbname",
        scratchName,
        join(dir, manifest.file),
      ],
      {
        env: {
          ...process.env,
          PGHOST: scratchUrl.hostname,
          PGPORT: scratchUrl.port || "5432",
          PGUSER: decodeURIComponent(scratchUrl.username),
          PGPASSWORD: decodeURIComponent(scratchUrl.password),
          PGDATABASE: scratchName,
        },
      },
    );
    expect(await customerSnapshot(restored)).toBe(originalRecords);
    expect(await walletSnapshot(restored)).toBe(originalWallet);
    const fingerprint = await computeFingerprint(restored);
    expect(diffFingerprints(originalFingerprint, fingerprint)).toEqual([]);
    expect(fingerprint.digest).toBe(manifest.fingerprintDigest);
    const checks = await consistencyChecks(restored, ctx.config.timezone);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.some((c) => c.label.startsWith("客户部") && c.ok)).toBe(true);
    const [binding] =
      await restored`SELECT maintainer_staff_id,version FROM customer_bindings WHERE member_id=${member.id}`;
    expect(binding).toEqual({ maintainerStaffId: managerId, version: 1 });
    const [credit] =
      await restored`SELECT status,version,seller_staff_id FROM customer_recharge_credits WHERE id=${claim.id}`;
    expect(credit).toEqual({
      status: "verified",
      version: 2,
      sellerStaffId: managerId,
    });
    const versions =
      await restored`SELECT version,snapshot->>'targetCents' AS amount FROM customer_target_versions
      WHERE target_id=(SELECT id FROM customer_month_targets WHERE staff_id=${managerId}) ORDER BY version`;
    expect(versions).toEqual([
      { version: 1, amount: "100000" },
      { version: 2, amount: "120000" },
    ]);
  } finally {
    await restored.end({ timeout: 5 });
    await ctx.sql.unsafe(
      `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`,
    );
  }
  expect(await walletSnapshot(ctx.sql)).toBe(originalWallet);
  expect(await customerSnapshot(ctx.sql)).toBe(originalRecords);
  expect((await computeFingerprint(ctx.sql)).digest).toBe(
    originalFingerprint.digest,
  );
  expect(
    await ctx.sql`SELECT datname FROM pg_database WHERE datname=${scratchName}`,
  ).toEqual([]);
}, 120000);
