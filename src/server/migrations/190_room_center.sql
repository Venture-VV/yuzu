-- 8.1.15 房态中心（《浴族系统需求汇总》房态中心 1–4，docs/ROOM_CENTER_V8115.md）
--   · 房型（room_categories）：房态中心按它分页签——名称、排序、管空间台账里的哪几种业态、是哪一类房间
--     （service 技师服务的房间 / party 开单即占用的房间 / hotel 客房 / hall 大厅类，只看状态）；后台可改；
--   · 房态行（space_room_states）：一个空间一行，记最近一次「清洁完成」、手动标的待清、维修（原因、预计完成时间）、并房；
--     带版本号，房态中心的每个写操作先锁这一行（同一间房上的操作串行）；
--   · 登记单（room_registrations）：服务房间的卡片式登记——哪位客人（来访）登记在哪间房、登记时建的钟单、出单员、备注；
--     「在用」从登记到退房（下钟以后客人还在房里也算在用），客人结账离店时一起结束；
--   · 房间事件（space_room_events，只追加）：登记、换房、退房、续钟、并房、拆并、标待清、清洁完成、维修、恢复——房间的「历史」。
-- 只加表、加索引：客房（rooms / room_stays / room_housekeeping_events）、钟单、使用单都不改，房态中心读它们。
-- 「待清」不另存一个开关：一间房在最近一次「清洁完成」之后又有钟单做完、使用单结束、登记单退房、被手动标过，就是待清
-- （钟房直接派进来的钟、平面图上开的使用单也算，不用在那几条路径里再写一遍）。

-- ───────────── ① 房型 ─────────────
CREATE TABLE room_categories (
  id             bigserial PRIMARY KEY,
  store_id       bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  name           text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 12),
  source         text NOT NULL CHECK (source IN ('service', 'party', 'hotel', 'hall')),
  -- 管空间台账里的哪几种业态（spaces.business_type）；同一种业态同时只在一个在用的房型里（代码在锁里核对）
  business_types text[] NOT NULL DEFAULT '{}' CHECK (cardinality(business_types) <= 20),
  sort_order     integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 9999),
  active         boolean NOT NULL DEFAULT true,
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by     bigint REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint REFERENCES staff (id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX room_categories_name_uq ON room_categories (store_id, lower(btrim(name)));

-- 默认的房型（每家店一份；店主在后台「空间台账 → 房态中心房型」里改）
INSERT INTO room_categories (store_id, name, source, business_types, sort_order)
SELECT s.id, d.name, d.source, d.business_types, d.sort_order
FROM stores s CROSS JOIN (VALUES
  ('按摩房', 'service', ARRAY['按摩', '踩背', '头疗'], 10),
  ('足浴房', 'service', ARRAY['足浴', '投影足浴'], 20),
  ('SPA 房', 'service', ARRAY['SPA'], 30),
  ('休息大厅', 'hall', ARRAY['休息大厅', '休息区', '休息厅'], 40),
  ('宠物轰趴房', 'party', ARRAY['宠物轰趴房'], 50),
  ('派对房', 'party', ARRAY['派对房', '娱乐室'], 60),
  ('客房', 'hotel', ARRAY['客房'], 70)
) AS d (name, source, business_types, sort_order);

-- ───────────── ② 房态行 ─────────────
CREATE TABLE space_room_states (
  space_id           bigint PRIMARY KEY REFERENCES spaces (id),
  store_id           bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  -- 最近一次「清洁完成」的时刻；这以后用过（钟单做完、使用单结束、退房、手动标）就是待清
  cleaned_at         timestamptz NOT NULL,
  -- 手动标成待清、换房换出去的时刻与说明
  dirty_at           timestamptz,
  dirty_note         text NOT NULL DEFAULT '' CHECK (char_length(dirty_note) <= 100),
  maintenance        boolean NOT NULL DEFAULT false,
  maintenance_reason text CHECK (char_length(btrim(maintenance_reason)) BETWEEN 2 AND 100),
  -- 预计完成时间
  maintenance_until  timestamptz,
  maintenance_at     timestamptz,
  maintenance_by     bigint REFERENCES staff (id),
  -- 并房：并到哪一间（主房）；主房自己这一项为空
  merged_into        bigint REFERENCES spaces (id),
  version            integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         bigint REFERENCES staff (id),
  CHECK (maintenance = (maintenance_reason IS NOT NULL)),
  CHECK (maintenance = (maintenance_until IS NOT NULL)),
  CHECK (maintenance = (maintenance_at IS NOT NULL)),
  CHECK (maintenance = (maintenance_by IS NOT NULL)),
  CHECK (merged_into IS NULL OR merged_into <> space_id)
);
CREATE INDEX space_room_states_merged_idx ON space_room_states (merged_into) WHERE merged_into IS NOT NULL;

-- 升级前就有的空间：从升级这一刻起算（以前做完的钟、结束的使用单不会让所有房间一下子都变成待清）；
-- 之后新建的空间没有这一行时按空间建好的时刻算（代码里 coalesce），第一次写的时候再建这一行
INSERT INTO space_room_states (space_id, store_id, cleaned_at) SELECT id, store_id, now() FROM spaces;

-- ───────────── ③ 登记单 ─────────────
CREATE TABLE room_registrations (
  id          bigserial PRIMARY KEY,
  store_id    bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  -- 现在在哪间房（换房时改；从哪间换到哪间记在房间事件里）
  space_id    bigint NOT NULL REFERENCES spaces (id),
  visit_id    bigint NOT NULL REFERENCES visits (id),
  -- 登记时建的钟单；这位客人之后在这次登记里做的钟（续钟、转钟、再点一项）都是编号不小于它的钟单
  session_id  bigint NOT NULL REFERENCES technician_sessions (id),
  -- 出单员：工号与姓名（登记时的快照）
  seller_no   text NOT NULL CHECK (char_length(seller_no) BETWEEN 1 AND 32),
  seller_name text NOT NULL CHECK (char_length(seller_name) BETWEEN 1 AND 32),
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at   timestamptz NOT NULL,
  opened_by   bigint NOT NULL REFERENCES staff (id),
  -- 登记这一笔挂账的操作编号（同一编号只登记一次）
  open_key    uuid NOT NULL UNIQUE,
  closed_at   timestamptz,
  closed_by   bigint REFERENCES staff (id),
  -- 怎么结束的：房态中心退房 / 客人结账离店 / 撤销来访
  close_kind  text CHECK (close_kind IN ('checkout', 'settled', 'visit_cancel')),
  -- 退房时这位客人手牌账单上还没结的金额（退房前预览看到的；结账离店的为 0）
  unpaid_cents integer CHECK (unpaid_cents >= 0),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'open') = (close_kind IS NULL)),
  CHECK ((status = 'open') OR closed_by IS NOT NULL)
);
-- 一位客人同时只登记在一间房（要去另一间先退房或换房）
CREATE UNIQUE INDEX room_registrations_visit_open_uq ON room_registrations (visit_id) WHERE status = 'open';
CREATE INDEX room_registrations_space_open_idx ON room_registrations (space_id, id) WHERE status = 'open';
CREATE INDEX room_registrations_space_closed_idx ON room_registrations (space_id, closed_at) WHERE status = 'closed';

-- 只能从「开着」变成「结束」，结束以后不能再改；不能删
CREATE FUNCTION yuzu_room_registration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '登记单不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '登记单已结束，不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.visit_id <> OLD.visit_id OR NEW.session_id <> OLD.session_id OR NEW.open_key <> OLD.open_key
     OR NEW.opened_at <> OLD.opened_at OR NEW.opened_by <> OLD.opened_by OR NEW.store_id <> OLD.store_id
     OR NEW.seller_no <> OLD.seller_no OR NEW.seller_name <> OLD.seller_name THEN
    RAISE EXCEPTION '登记单的客人、钟单、出单员与登记时刻不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_registrations_guard BEFORE UPDATE OR DELETE ON room_registrations
  FOR EACH ROW EXECUTE FUNCTION yuzu_room_registration_guard();

-- ───────────── ④ 房间事件（只追加） ─────────────
CREATE TABLE space_room_events (
  id              bigserial PRIMARY KEY,
  store_id        bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  space_id        bigint NOT NULL REFERENCES spaces (id),
  kind            text NOT NULL CHECK (kind IN ('register', 'move_out', 'move_in', 'checkout', 'extend', 'merge', 'unmerge', 'dirty', 'cleaned', 'maintenance', 'restore')),
  registration_id bigint REFERENCES room_registrations (id),
  -- 手牌号、项目、技师、金额、原因、换到哪间……（显示用的快照）
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  staff_id        bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX space_room_events_space_idx ON space_room_events (space_id, id);
CREATE TRIGGER space_room_events_append_only BEFORE UPDATE OR DELETE ON space_room_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ⑤ 「待清」要查的两样：这间房里做完的钟、结束的使用单 ─────────────
CREATE INDEX technician_sessions_space_ended_idx ON technician_sessions (space_id, ended_at) WHERE space_id IS NOT NULL AND ended_at IS NOT NULL;
CREATE INDEX space_usages_space_closed_idx ON space_usages (space_id, closed_at) WHERE status = 'closed';
