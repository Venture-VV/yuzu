-- 员工食堂 · 柚子饭堂第二期（docs/CANTEEN.md 第 14、16 节，店主 2026-11-06）：员工在开场引导里自己登记、「跟柚子说」。
-- 只改员工食堂自己的表。注册口令存在 settings 的 canteen_registration 一项（不建表）。

-- 自己登记的员工：用户名（登录名，也是负责人扫码时看到的名字）、手机号、来源
ALTER TABLE canteen_employees
  ADD COLUMN username text CHECK (username IS NULL OR char_length(username) BETWEEN 2 AND 16),
  ADD COLUMN phone    text CHECK (phone IS NULL OR phone ~ '^1[3-9][0-9]{9}$'),
  -- admin：管理员在后台加的；self：员工自己在柚子饭堂登记的
  ADD COLUMN source   text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'self'));

-- 自己登记的一定有用户名和手机号
ALTER TABLE canteen_employees ADD CONSTRAINT canteen_employees_self_has_login CHECK (source = 'admin' OR (username IS NOT NULL AND phone IS NOT NULL));

-- 用户名不分大小写唯一；一个手机号只能有一个账号
CREATE UNIQUE INDEX canteen_employees_username_key ON canteen_employees (lower(username)) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX canteen_employees_phone_key ON canteen_employees (phone) WHERE phone IS NOT NULL;

-- 跟柚子说：员工想让柚子做的事（心愿）和碎碎念；管理员在后台看、回一句话。内容发出后不能改、不能删
CREATE TABLE canteen_feedback (
  id            bigserial PRIMARY KEY,
  employee_id   bigint NOT NULL REFERENCES canteen_employees (id),
  -- 当时的名字（快照：之后改名单不改历史）
  employee_name text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('wish', 'chat')),
  content       text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  -- 操作编号：回复没收到时原样重发，返回同一条
  client_key    uuid NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 管理员看过（回信时也算看过）
  read_at       timestamptz,
  read_by       bigint REFERENCES staff (id),
  reply         text CHECK (reply IS NULL OR char_length(reply) BETWEEN 1 AND 300),
  replied_at    timestamptz,
  replied_by    bigint REFERENCES staff (id),
  CHECK ((read_at IS NULL) = (read_by IS NULL)),
  CHECK ((reply IS NULL) = (replied_at IS NULL)),
  CHECK ((reply IS NULL) = (replied_by IS NULL)),
  CHECK (reply IS NULL OR read_at IS NOT NULL)
);
CREATE INDEX canteen_feedback_created_idx ON canteen_feedback (created_at DESC);
CREATE INDEX canteen_feedback_employee_idx ON canteen_feedback (employee_id, created_at DESC);
CREATE INDEX canteen_feedback_unread_idx ON canteen_feedback (created_at DESC) WHERE read_at IS NULL;

-- 内容的保护：不能删；说了什么、谁说的、什么时候说的都不能改（只能标看过、回信）
CREATE FUNCTION yuzu_canteen_feedback_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '跟柚子说的内容禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.employee_id, NEW.employee_name, NEW.kind, NEW.content, NEW.client_key, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.employee_id, OLD.employee_name, OLD.kind, OLD.content, OLD.client_key, OLD.created_at) THEN
    RAISE EXCEPTION '跟柚子说的内容发出后不能改，只能标为看过、回信' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER canteen_feedback_guard BEFORE UPDATE OR DELETE ON canteen_feedback
  FOR EACH ROW EXECUTE FUNCTION yuzu_canteen_feedback_guard();
