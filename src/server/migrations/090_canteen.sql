-- 员工食堂 · 柚子饭堂（docs/CANTEEN.md，店主 2026-11-06）：员工名单与员工端会话、菜单与点赞、打卡。
-- 只建自己的表、不改已有的表。员工账号与系统账号（staff）分开：员工账号只能登录柚子饭堂（员工端口），没有 ERP 权限。
-- 设置存在 settings 的 canteen 一项（没存时按默认，见 src/shared/canteen.ts）。

-- 员工名单：只由管理员在 yuzu 后台维护
CREATE TABLE canteen_employees (
  id                    bigserial PRIMARY KEY,
  -- 工号：大写字母、数字与短横线，1–16 位（保存时转大写）
  emp_no                text NOT NULL UNIQUE CHECK (emp_no ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 16),
  -- 部门（普通员工可以不填；厨师、负责人必须是设置里的食堂部门，由服务端核对）
  department_id         bigint REFERENCES departments (id),
  role                  text NOT NULL DEFAULT 'staff' CHECK (role IN ('staff', 'cook', 'manager')),
  avatar                text NOT NULL CHECK (char_length(avatar) BETWEEN 1 AND 8),
  active                boolean NOT NULL DEFAULT true,
  -- 员工自己设的密码（开通之前为空；重新开通时清空）
  password_hash         text,
  -- 开通码：打印在开通卡片上，员工用它设密码；用过、重新开通、停用时清掉
  activation_code       text UNIQUE CHECK (activation_code ~ '^[2-9A-HJ-NP-Z]{8}$'),
  activation_expires_at timestamptz,
  -- 生成这张开通码的操作编号：同一编号重提返回同一张，不会换码
  activation_key        uuid,
  activated_at          timestamptz,
  -- 码钥匙的版本：停用、重新开通时加一，旧手机上的码钥匙与登录随之失效
  code_epoch            integer NOT NULL DEFAULT 1 CHECK (code_epoch > 0),
  failed_logins         integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until          timestamptz,
  last_seen_at          timestamptz,
  version               integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_synthetic          boolean NOT NULL DEFAULT false,
  created_by            bigint REFERENCES staff (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((activation_code IS NULL) = (activation_expires_at IS NULL)),
  -- 停用的人没有开通码
  CHECK (active OR activation_code IS NULL)
);
CREATE INDEX canteen_employees_department_idx ON canteen_employees (department_id);

-- 员工端会话（只存令牌摘要；30 天，用着就顺延）。停用、重新开通时整批删掉
CREATE TABLE canteen_sessions (
  token_hash   text PRIMARY KEY,
  employee_id  bigint NOT NULL REFERENCES canteen_employees (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX canteen_sessions_employee_idx ON canteen_sessions (employee_id);

-- 某天某餐的菜单：厨师、负责人在手机上编辑、发布；带版本号，两个人同时改不会互相覆盖
CREATE TABLE canteen_menus (
  id              bigserial PRIMARY KEY,
  menu_date       date NOT NULL,
  meal            text NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'dinner', 'supper')),
  -- [{ id, name, emoji, tags }]，最多 30 道
  dishes          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(dishes) = 'array' AND jsonb_array_length(dishes) <= 30),
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  published       boolean NOT NULL DEFAULT false,
  published_at    timestamptz,
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- 最后一次保存的操作编号：回复没收到时原样重提，返回同一个结果
  last_client_key uuid,
  updated_by      bigint NOT NULL REFERENCES canteen_employees (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (menu_date, meal)
);

-- 点赞：谁给哪份菜单的哪道菜点了赞（主键去重；取消就删掉这一条）
CREATE TABLE canteen_likes (
  menu_id     bigint NOT NULL REFERENCES canteen_menus (id),
  dish_id     text NOT NULL CHECK (dish_id ~ '^[a-z0-9]{1,12}$'),
  employee_id bigint NOT NULL REFERENCES canteen_employees (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (menu_id, dish_id, employee_id)
);
CREATE INDEX canteen_likes_employee_idx ON canteen_likes (employee_id);

-- 打卡：只追加；撤销只做标记（原因与经办人）。同一人同一天同一餐只能有一条没撤销的
CREATE TABLE canteen_checkins (
  id                 bigserial PRIMARY KEY,
  employee_id        bigint NOT NULL REFERENCES canteen_employees (id),
  -- 当时的工号、姓名、部门（快照：之后改名单不改历史）
  emp_no             text NOT NULL,
  employee_name      text NOT NULL,
  department_name    text NOT NULL DEFAULT '',
  meal_date          date NOT NULL,
  meal               text NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'dinner', 'supper')),
  method             text NOT NULL CHECK (method IN ('scan', 'manual')),
  note               text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  -- 扫到（或手动点下）的时间：断网补登时是手机记下的时间
  scanned_at         timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  recorder_id        bigint NOT NULL REFERENCES canteen_employees (id),
  recorder_name      text NOT NULL,
  client_key         uuid NOT NULL UNIQUE,
  voided_at          timestamptz,
  void_reason        text CHECK (char_length(void_reason) BETWEEN 1 AND 100),
  -- 撤销的人：负责人（员工端）或管理员（系统账号），二选一
  voided_by_employee bigint REFERENCES canteen_employees (id),
  voided_by_staff    bigint REFERENCES staff (id),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CHECK (voided_at IS NULL OR ((voided_by_employee IS NULL) <> (voided_by_staff IS NULL))),
  CHECK (voided_at IS NOT NULL OR (voided_by_employee IS NULL AND voided_by_staff IS NULL))
);
CREATE UNIQUE INDEX canteen_checkins_once_per_meal ON canteen_checkins (employee_id, meal_date, meal) WHERE voided_at IS NULL;
CREATE INDEX canteen_checkins_date_idx ON canteen_checkins (meal_date, meal);
CREATE INDEX canteen_checkins_employee_idx ON canteen_checkins (employee_id, meal_date);

-- 打卡记录的保护：不能删除；除了撤销那几列，什么都不能改；撤销过的不能再改
CREATE FUNCTION yuzu_canteen_checkin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '打卡记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION '已撤销的打卡记录不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.employee_id, NEW.emp_no, NEW.employee_name, NEW.department_name, NEW.meal_date, NEW.meal, NEW.method,
      NEW.note, NEW.scanned_at, NEW.recorded_at, NEW.recorder_id, NEW.recorder_name, NEW.client_key)
     IS DISTINCT FROM (OLD.id, OLD.employee_id, OLD.emp_no, OLD.employee_name, OLD.department_name, OLD.meal_date, OLD.meal, OLD.method,
      OLD.note, OLD.scanned_at, OLD.recorded_at, OLD.recorder_id, OLD.recorder_name, OLD.client_key) THEN
    RAISE EXCEPTION '打卡记录只能撤销，其他内容不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER canteen_checkin_guard BEFORE UPDATE OR DELETE ON canteen_checkins
  FOR EACH ROW EXECUTE FUNCTION yuzu_canteen_checkin_guard();
