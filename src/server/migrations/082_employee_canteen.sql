-- 员工服务独立身份与食堂镜像；不新增 ERP 登录账号，也不与会员钱包关联。
CREATE SEQUENCE canteen_sync_revision;
CREATE TABLE canteen_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  department_id integer REFERENCES departments(id),
  version integer NOT NULL DEFAULT 1,
  roster_version bigint NOT NULL DEFAULT 0,
  synced_roster_version bigint NOT NULL DEFAULT -1,
  last_success_at timestamptz,
  last_error text,
  checkin_cursor bigint NOT NULL DEFAULT 0
);
INSERT INTO canteen_settings (singleton) VALUES (true);
CREATE TABLE canteen_employees (
  id uuid PRIMARY KEY,
  employee_no text NOT NULL UNIQUE CHECK (employee_no ~ '^[A-Z0-9_-]{2,32}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  department_id integer NOT NULL REFERENCES departments(id),
  role text NOT NULL CHECK (role IN ('employee','chef','manager')),
  active boolean NOT NULL DEFAULT true,
  password_hash text NOT NULL,
  credential_version uuid NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE canteen_operations (
  id uuid PRIMARY KEY,
  actor_id integer NOT NULL REFERENCES staff(id),
  kind text NOT NULL CHECK (kind IN ('employee_create','password_reset','menu')),
  request_hash text,
  abandoned boolean NOT NULL DEFAULT false,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE canteen_menus (
  id uuid PRIMARY KEY,
  menu_date date NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE canteen_checkins (
  id bigint PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  employee_id uuid NOT NULL,
  employee_no text NOT NULL,
  name text NOT NULL,
  department_name text NOT NULL,
  scanner_id uuid NOT NULL,
  scanner_name text NOT NULL,
  checked_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canteen_checkins_time_idx ON canteen_checkins(checked_at DESC);
