/** 本机合成食堂演示；只创建指定 c1_*_demo 与其配对员工库，绝不清库。 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app';
import { ensureInitialOwner } from '../src/server/bootstrap';
import type { AppConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { hashPassword } from '../src/server/auth/password';
import { syncCanteen } from '../src/server/modules/canteen/sync';
import { buildEmployeeApp } from '../src/employee/server/app';
import type { EmployeeConfig } from '../src/employee/server/config';
import { migrateEmployee } from '../src/employee/server/migrate';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOST = '127.0.0.1';
const ERP_PORT = 18961;
const EMPLOYEE_PORT = 18962;
const PASSWORD = 'Initial-test-2026';
// 仅限这个回环合成演示。正式入口不得使用此固定值。
const DEMO_SYNC_KEY = 'canteen-demo-only-2026-synthetic-local-key-9Q2x';
const OWNER = 'canteen_owner';
const clients: Sql[] = [];
const apps: FastifyInstance[] = [];
let stopping = false;

function targetDatabases() {
  const raw = process.env.CANTEEN_DEMO_DATABASE_URL;
  if (!raw) throw new Error('必须显式设置 CANTEEN_DEMO_DATABASE_URL，本脚本不读取 DATABASE_URL 或 .env');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('CANTEEN_DEMO_DATABASE_URL 格式不正确'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('演示数据库只能使用本机 loopback PostgreSQL');
  }
  // 不接受可覆写主机、数据库或连接选项的 query 参数。
  if (url.search || url.hash) throw new Error('演示数据库 URL 不得带查询参数或片段');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^c1_[a-z0-9_]+_demo$/.test(name) || name.length > 54) {
    throw new Error('演示库名必须为 c1_*_demo，且不超过 54 字符');
  }
  const employeeName = `${name}_employee`;
  const employeeUrl = new URL(url);
  employeeUrl.pathname = `/${employeeName}`;
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  return { name, employeeName, erpUrl: url.toString(), employeeUrl: employeeUrl.toString(), adminUrl: adminUrl.toString() };
}

async function requireFreePort(port: number) {
  await new Promise<void>((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`本机 ${port} 已被占用或无法监听，请保留现有服务并另行核对`)));
    probe.listen({ host: HOST, port, exclusive: true }, () => probe.close((error) => error ? reject(error) : resolvePort()));
  });
}

type DemoRole = 'erp' | 'employee';
const markerTable = (role: DemoRole) => role === 'erp' ? 'canteen_demo_marker' : 'employee_demo_marker';
async function inspectDatabase(sql: Sql, role: DemoRole, name: string, peer: string): Promise<boolean> {
  const tables = await sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  if (!tables.length) return false;
  const marker = markerTable(role);
  if (!tables.some((table) => table.tablename === marker)) throw new Error(`${name} 已有表但没有本演示标记，拒绝写入`);
  const rows = await sql<{ markerVersion: number; databaseName: string; peerDatabase: string; role: string }[]>`
    SELECT marker_version, database_name, peer_database, role FROM ${sql(marker)}`;
  if (rows.length !== 1 || rows[0]!.markerVersion !== 1 || rows[0]!.databaseName !== name || rows[0]!.peerDatabase !== peer || rows[0]!.role !== role) {
    throw new Error(`${name} 的演示标记与配对信息不符，拒绝写入`);
  }
  return true;
}

async function markEmptyDatabase(sql: Sql, role: DemoRole, name: string, peer: string) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('canteen-demo-initialize'))`;
    const existing = await tx`SELECT 1 FROM pg_tables WHERE schemaname = 'public' LIMIT 1`;
    if (existing.length) throw new Error(`${name} 检查后出现了其他表，拒绝覆盖`);
    const marker = markerTable(role);
    await tx`CREATE TABLE ${tx(marker)} (
      marker_version integer PRIMARY KEY CHECK (marker_version = 1), database_name text NOT NULL,
      peer_database text NOT NULL, role text NOT NULL, seeded boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await tx`INSERT INTO ${tx(marker)} (marker_version, database_name, peer_database, role)
      VALUES (1, ${name}, ${peer}, ${role})`;
  });
}

async function seedCanteen(sql: Sql, config: AppConfig) {
  await ensureInitialOwner(sql, config, (message) => console.log(message));
  await sql.begin(async (tx) => {
    const [marker] = await tx<{ seeded: boolean }[]>`SELECT seeded FROM canteen_demo_marker WHERE marker_version = 1 FOR UPDATE`;
    if (marker!.seeded) return;
    const [department] = await tx<{ id: number }[]>`INSERT INTO departments (name, active, sort_order)
      VALUES ('合成演示食堂', true, 999) RETURNING id`;
    await tx`UPDATE canteen_settings SET department_id = ${department!.id}, version = version + 1,
      roster_version = roster_version + 1 WHERE singleton`;
    await tx`INSERT INTO settings (key, value) VALUES ('erp_modules', ${tx.json({ canteen: true })})
      ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`;
    const passwordHash = await hashPassword(PASSWORD);
    const people = [
      { employeeNo: 'EMP001', name: '合成员工', role: 'employee' },
      { employeeNo: 'CHEF001', name: '合成厨师', role: 'chef' },
      { employeeNo: 'MGR001', name: '合成负责人', role: 'manager' },
    ];
    for (const person of people) {
      await tx`INSERT INTO canteen_employees
        (id, employee_no, name, department_id, role, password_hash, credential_version, must_change_password)
        VALUES (${randomUUID()}, ${person.employeeNo}, ${person.name}, ${department!.id}, ${person.role},
          ${passwordHash}, ${randomUUID()}, true)`;
    }
    await tx`UPDATE canteen_demo_marker SET seeded = true WHERE marker_version = 1`;
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  // 先停 ERP 的同步计时器，再停员工服务和各自的连接池。
  for (const app of [...apps].reverse()) await app.close().catch(() => {});
  for (const client of clients) await client.end({ timeout: 5 }).catch(() => {});
}

async function main() {
  const target = targetDatabases();
  const erpStatic = resolve(ROOT, 'dist/client');
  const employeeStatic = resolve(ROOT, 'dist/employee/client');
  if (!existsSync(resolve(erpStatic, 'index.html')) || !existsSync(resolve(employeeStatic, 'index.html'))) {
    throw new Error('缺少前端构建产物，请先运行 npm run build');
  }
  await requireFreePort(ERP_PORT);
  await requireFreePort(EMPLOYEE_PORT);
  const admin = createSql(target.adminUrl, { max: 1 });
  clients.push(admin);
  for (const name of [target.name, target.employeeName]) {
    const found = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (!found.length) {
      // 名字由上面的固定正则与后缀生成，并按 SQL 标识符引用。
      try { await admin`CREATE DATABASE ${admin(name)}`; }
      catch (error) { if ((error as { code?: string }).code !== '42P04') throw error; }
    }
  }
  await admin.end({ timeout: 5 });
  clients.splice(clients.indexOf(admin), 1);
  const erpSql = createSql(target.erpUrl);
  const employeeSql = createSql(target.employeeUrl);
  clients.push(erpSql, employeeSql);
  // 两边都验证后才写标记/迁移。任何既有未标记业务库都不得初始化。
  const erpExists = await inspectDatabase(erpSql, 'erp', target.name, target.employeeName);
  const employeeExists = await inspectDatabase(employeeSql, 'employee', target.employeeName, target.name);
  if (!erpExists) await markEmptyDatabase(erpSql, 'erp', target.name, target.employeeName);
  if (!employeeExists) await markEmptyDatabase(employeeSql, 'employee', target.employeeName, target.name);
  process.env.APP_ENV = 'development';
  process.env.YUZU_INSTANCE = 'demo';
  process.env.STATIC_DIR = erpStatic;
  const version = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  const commit = /^[0-9a-f]{40}$/.test(process.env.APP_COMMIT ?? '') ? process.env.APP_COMMIT! : '';
  const erpConfig: AppConfig = {
    env: 'development', instance: 'demo', host: HOST, port: ERP_PORT, databaseUrl: target.erpUrl,
    timezone: 'Asia/Shanghai', sessionTtlHours: 8, cookieSecure: false, logLevel: 'warn', version, commit,
    initOwner: { username: OWNER, password: PASSWORD, displayName: '合成演示店主' },
    mp: { port: null, host: HOST, gatewayKey: null, codeSecret: null },
    employeePortal: { url: `http://${HOST}:${EMPLOYEE_PORT}`, syncKey: DEMO_SYNC_KEY },
  };
  const employeeConfig: EmployeeConfig = {
    databaseUrl: target.employeeUrl, host: HOST, port: EMPLOYEE_PORT,
    syncKey: DEMO_SYNC_KEY, publicOrigin: `http://${HOST}:${EMPLOYEE_PORT}`,
    production: false, secureCookie: false, instance: 'demo', version, commit,
    staticRoot: employeeStatic, maxRosterAgeSeconds: 300,
  };
  await migrate(erpSql);
  await migrateEmployee(employeeSql);
  await seedCanteen(erpSql, erpConfig);
  const employeeApp = await buildEmployeeApp(employeeSql, employeeConfig);
  apps.push(employeeApp);
  await employeeApp.listen({ host: HOST, port: EMPLOYEE_PORT });
  const synced = await syncCanteen({ sql: erpSql, config: erpConfig });
  if (!synced.ok) throw new Error('演示食堂同步未执行；请核对该演示实例的模块设置');
  const erpApp = await buildApp(erpSql, erpConfig);
  apps.push(erpApp);
  await erpApp.listen({ host: HOST, port: ERP_PORT });
  console.log(`合成演示已启动（仅本机）\nERP：http://${HOST}:${ERP_PORT}/erp/canteen\n员工 Web App：http://${HOST}:${EMPLOYEE_PORT}/\nERP 账号：${OWNER}\n员工账号：EMP001 / CHEF001 / MGR001\n首次临时密码：${PASSWORD}\n首次登录需修改密码；重复启动保留已有密码、菜单与打卡数据。\n演示库：${target.name} + ${target.employeeName}\n进程 PID：${process.pid}；Ctrl+C 关闭本进程服务，不清除数据库。`);
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

void main().catch(async (error: unknown) => {
  // PostgreSQL 底层异常可能附连接信息；只展示预期的守卫说明，不打印 URL/凭据。
  const detail = error instanceof Error && error.name === 'Error' ? error.message : '数据库或服务启动失败，请检查独立数据库连接与权限';
  console.error(`食堂合成演示未启动：${detail}`);
  await shutdown();
  process.exitCode = 1;
});
