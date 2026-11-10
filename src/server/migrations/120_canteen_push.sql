-- 员工食堂 · 饭点提醒（店主 2026-11-10，docs/CANTEEN.md 第 19 节，K22–K24）：网页推送（Web Push）的钥匙、员工手机的订阅、
-- 员工自己关掉的餐次、每天每顿的提醒与每台手机的发送记录。只建员工食堂自己的表，不改已有的表。
-- 迁移号 120 是员工食堂单独的 PR 在 ROADMAP 第 7 节登记的（主线照旧从 110 起，用到 119 时跳过 120）。
-- 提醒的时间与话术是规则类设置（settings 的 canteen_reminders），不在这里。

-- 这个实例的网页推送钥匙（VAPID，P-256）：第一次用到时生成，只有一行（换了钥匙，员工手机上原来的订阅就都收不到了）。
-- 私钥只在服务端发推送时用：不进设置、不给页面、不写日志
CREATE TABLE web_push_keys (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key  text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  private_key text NOT NULL CHECK (private_key ~ '^[A-Za-z0-9_-]{43}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 员工手机上的订阅：一台手机（一个浏览器、或桌面上的柚子饭堂）一条，推送地址唯一；同一台手机换人登录后再打开提醒，改到新的人名下。
-- 停用以后不再发，记录留着：off 员工自己关掉、logout 退出登录、gone 推送服务说这个订阅没了（404 / 410）
CREATE TABLE canteen_push_subscriptions (
  id              bigserial PRIMARY KEY,
  employee_id     bigint NOT NULL REFERENCES canteen_employees (id),
  endpoint        text NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 1 AND 2048),
  p256dh          text NOT NULL CHECK (length(p256dh) BETWEEN 1 AND 200),
  auth            text NOT NULL CHECK (length(auth) BETWEEN 1 AND 100),
  platform        text NOT NULL DEFAULT 'other' CHECK (platform IN ('ios', 'android', 'other')),
  -- 员工打开柚子饭堂的 https 地址（例如 https://staff.example.com）：发推送时告诉推送服务这是谁家的（VAPID 的联系方式）
  origin          text CHECK (origin ~ '^https://[^/\s]+$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failures        integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_error      text,
  disabled_at     timestamptz,
  disabled_reason text CHECK (disabled_reason IN ('off', 'logout', 'gone')),
  CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);
CREATE INDEX canteen_push_subscriptions_employee_idx ON canteen_push_subscriptions (employee_id) WHERE disabled_at IS NULL;

-- 员工自己关掉的餐次（柚子饭堂「我的 → 饭点提醒」）：没有这一行 = 后台开着的几顿都提醒
CREATE TABLE canteen_push_prefs (
  employee_id bigint PRIMARY KEY REFERENCES canteen_employees (id),
  muted_meals text[] NOT NULL DEFAULT '{}' CHECK (muted_meals <@ ARRAY['breakfast', 'lunch', 'dinner', 'supper']::text[]),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 每天每顿的饭点提醒：先认领（同一天同一顿只有一行，几个进程同时跑也只有一个认领到），写租约，事务外发送，最后记结果。
-- 进程在发送中断了的，租约过期以后、还在到点后 30 分钟之内，由下一分钟接着发没发过的手机
CREATE TABLE canteen_reminder_runs (
  id                 bigserial PRIMARY KEY,
  meal_date          date NOT NULL,
  meal               text NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'dinner', 'supper')),
  due_at             timestamptz NOT NULL,
  title              text NOT NULL,
  -- 这一天轮到的那一句（{名字} 发的时候按人换）与 {菜单} 换成的菜
  line               text NOT NULL,
  menu_text          text NOT NULL DEFAULT '',
  open_page          text NOT NULL CHECK (open_page IN ('code', 'menu', 'home')),
  status             text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'done')),
  lease_until        timestamptz,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  sent               integer NOT NULL DEFAULT 0 CHECK (sent >= 0),
  failed             integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  skipped_checked_in integer NOT NULL DEFAULT 0 CHECK (skipped_checked_in >= 0),
  UNIQUE (meal_date, meal),
  CHECK ((status = 'done') = (finished_at IS NOT NULL))
);

-- 每台手机的发送记录：同一次提醒同一台手机只发一次（先记一行再发；中断后接着发的跳过记过的，结果不明的也不重发）
CREATE TABLE canteen_reminder_deliveries (
  run_id          bigint NOT NULL REFERENCES canteen_reminder_runs (id),
  subscription_id bigint NOT NULL REFERENCES canteen_push_subscriptions (id),
  employee_id     bigint NOT NULL REFERENCES canteen_employees (id),
  status          text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed', 'gone')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  PRIMARY KEY (run_id, subscription_id)
);
CREATE INDEX canteen_reminder_deliveries_subscription_idx ON canteen_reminder_deliveries (subscription_id);
