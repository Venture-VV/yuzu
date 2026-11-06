import type { Sql } from '../../server/db';

/** 独立库初始化；绝不执行 ERP 迁移，也拒绝带有其他业务表的数据库。 */
export async function migrateEmployee(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('yuzu-employee-migrations'))`;
    const foreignTables = await tx`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      AND left(tablename, 9) <> 'employee_' LIMIT 1`;
    if (foreignTables.length) throw new Error('员工数据库含其他业务表，拒绝初始化；请使用独立空库');
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS employee_schema_migrations (
        version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS employee_sync_state (
        id integer PRIMARY KEY CHECK (id = 1), revision bigint NOT NULL DEFAULT 0,
        synced_at timestamptz, canteen_department_id integer
      );
      INSERT INTO employee_sync_state (id) VALUES (1) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS employee_roster (
        id text PRIMARY KEY, employee_no text NOT NULL UNIQUE, name text NOT NULL,
        department_id integer NOT NULL, department_name text NOT NULL,
        role text NOT NULL CHECK (role IN ('employee','chef','manager')),
        active boolean NOT NULL, must_change_password boolean NOT NULL,
        password_hash text NOT NULL, credential_version text NOT NULL,
        auth_version integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS employee_sessions (
        token_hash text PRIMARY KEY, employee_id text NOT NULL REFERENCES employee_roster(id),
        auth_version integer NOT NULL, expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS employee_sessions_owner ON employee_sessions(employee_id);
      CREATE TABLE IF NOT EXISTS employee_codes (
        token_hash text PRIMARY KEY, employee_id text NOT NULL REFERENCES employee_roster(id),
        auth_version integer NOT NULL, expires_at timestamptz NOT NULL,
        consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS employee_codes_owner ON employee_codes(employee_id);
      CREATE TABLE IF NOT EXISTS employee_menus (
        id text PRIMARY KEY, date date NOT NULL,
        meal text NOT NULL CHECK (meal IN ('breakfast','lunch','dinner')),
        title text NOT NULL, dishes jsonb NOT NULL, notes text NOT NULL,
        published boolean NOT NULL, version integer NOT NULL CHECK (version > 0),
        updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL,
        UNIQUE (date, meal)
      );
      CREATE TABLE IF NOT EXISTS employee_checkins (
        id bigserial PRIMARY KEY, request_id uuid NOT NULL UNIQUE,
        employee_id text NOT NULL REFERENCES employee_roster(id), employee_no text NOT NULL,
        name text NOT NULL, department_name text NOT NULL,
        scanner_id text NOT NULL REFERENCES employee_roster(id), scanner_name text NOT NULL,
        checked_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS employee_checkins_date ON employee_checkins(checked_at);
      CREATE TABLE IF NOT EXISTS employee_requests (
        scope text NOT NULL CHECK (scope IN ('menu','checkin')),
        request_id uuid PRIMARY KEY, actor_key text NOT NULL, fingerprint text,
        status text NOT NULL CHECK (status IN ('completed','abandoned')),
        result jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO employee_schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
    `);
  });
}
