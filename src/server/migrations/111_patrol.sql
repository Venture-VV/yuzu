-- 8.0.9 安保巡场（docs/PATROL_V809.md）：场所与场所码、巡场打卡。只建自己的两张表，
-- 放宽「确认作废」的一条约束（加 patrol_point：后台新建场所的「结果待确认」）。不改任何已有的表。

-- ───────────── 场所：一个场所一个码（印在二维码里：员工入口地址 + #patrol=码） ─────────────
CREATE TABLE patrol_points (
  id               bigserial PRIMARY KEY,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20 AND name = btrim(name)),
  area             text NOT NULL DEFAULT '' CHECK (char_length(area) <= 40),
  -- 场所码：12 位大写字母与 2–7（base32），随机；换码时换成新的，旧码马上认不出（XC8）
  token            text NOT NULL UNIQUE CHECK (token ~ '^[A-Z2-7]{12}$'),
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- 新建时的操作编号（「结果待确认」查回、确认作废用）与原请求摘要
  client_key       uuid NOT NULL UNIQUE,
  request_hash     text NOT NULL,
  created_by       bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       bigint REFERENCES staff (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  token_changed_at timestamptz
);
-- 启用的场所不重名（不分大小写，XC12）
CREATE UNIQUE INDEX patrol_points_name_uq ON patrol_points (lower(name)) WHERE active;

-- ───────────── 巡场打卡：只追加，只能作废一次 ─────────────
CREATE TABLE patrol_checkins (
  id              bigserial PRIMARY KEY,
  point_id        bigint NOT NULL REFERENCES patrol_points (id),
  -- 当时的场所名称与员工的工号、姓名、部门（快照：之后改名单、改名称不改历史）
  point_name      text NOT NULL,
  employee_id     bigint NOT NULL REFERENCES canteen_employees (id),
  emp_no          text NOT NULL,
  employee_name   text NOT NULL,
  department_name text NOT NULL DEFAULT '',
  -- 营业日（XC4）：按扫到的时间与营业日切换时间
  business_date   date NOT NULL,
  -- 扫到的时间：断网补交时是手机记下的时间（按服务器时间差修正过，XC7）
  scanned_at      timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  -- 怎么扫的：工作台里扫码 / 用手机相机、微信直接扫开的 / 拍照识别
  via             text NOT NULL CHECK (via IN ('scan', 'link', 'photo')),
  client_key      uuid NOT NULL UNIQUE,
  voided_at       timestamptz,
  void_reason     text CHECK (char_length(void_reason) BETWEEN 1 AND 100),
  voided_by       bigint REFERENCES staff (id),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX patrol_checkins_date_idx ON patrol_checkins (business_date, point_id);
CREATE INDEX patrol_checkins_employee_idx ON patrol_checkins (employee_id, point_id, scanned_at);

-- 打卡记录的保护：不能删除；除了作废那几列，什么都不能改；作废过的不能再改（XC10）
CREATE FUNCTION yuzu_patrol_checkin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '巡场打卡记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION '已作废的巡场打卡记录不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.point_id, NEW.point_name, NEW.employee_id, NEW.emp_no, NEW.employee_name, NEW.department_name, NEW.business_date,
      NEW.scanned_at, NEW.recorded_at, NEW.via, NEW.client_key)
     IS DISTINCT FROM (OLD.id, OLD.point_id, OLD.point_name, OLD.employee_id, OLD.emp_no, OLD.employee_name, OLD.department_name, OLD.business_date,
      OLD.scanned_at, OLD.recorded_at, OLD.via, OLD.client_key) THEN
    RAISE EXCEPTION '巡场打卡记录只能作废，其他内容不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patrol_checkin_guard BEFORE UPDATE OR DELETE ON patrol_checkins
  FOR EACH ROW EXECUTE FUNCTION yuzu_patrol_checkin_guard();

-- 场所不能删除（打卡记录引用它；不用了就停用，XC9）
CREATE FUNCTION yuzu_patrol_point_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '巡场场所禁止删除，不用了请停用' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER patrol_point_guard BEFORE DELETE ON patrol_points
  FOR EACH ROW EXECUTE FUNCTION yuzu_patrol_point_guard();

-- ───────────── 「确认作废」加业务类型 patrol_point（在 110 的基础上加一项） ─────────────
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial',
                     'member_refund', 'member_status', 'member_merge', 'booking_create', 'booking_change',
                     'count_card_sale', 'count_card_refund', 'platform_redemption', 'platform_settlement', 'doc_print', 'member_card',
                     'approval_rule', 'approval_delegation', 'contract_create', 'contract_change', 'contract_seal',
                     'payment_request', 'contract_payout', 'contract_acceptance', 'contract_quality', 'supplier_invoice', 'canteen_reply',
                     'request_import', 'gift_receipt', 'coupon_campaign', 'ar_collection', 'asset_card', 'asset_stocktake', 'technician_state', 'patrol_point'));
