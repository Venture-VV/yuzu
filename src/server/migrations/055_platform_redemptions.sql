-- v0.7.28 ⑤（主线）：第三方平台核销补录（设计见 docs/SCHEDULE_FINISH.md 第 6 节，N6 待确认）。
--   · platform_redemptions：已在平台 App（美团、大众点评、抖音等）核销、没有经过前台结账的券，补登记一笔：券码、项目、面值、
--     平台应结给门店的金额、核销时刻；不结账、不算营业额、不动会员钱包；同一平台同一券码只能有一笔有效登记，
--     也不能和前台结账里登记的团购券重复（代码里先取券码的咨询锁再核对两张表）；登记错了作废（写原因）；
--   · platform_settlements：平台打款——哪个平台、哪段时间的、多少、哪天到账、流水号；作废写原因；
--   · 对账按平台、按时间段：补登记的应结 + 结账里的团购券抵扣 与 平台打款比对。
--   · 「确认作废」加业务类型：补登记、打款登记。
-- 只加表、放宽业务类型，不改已有的行。

CREATE TABLE platform_redemptions (
  id             bigserial PRIMARY KEY,
  redemption_no  text NOT NULL UNIQUE,
  platform       text NOT NULL CHECK (platform IN ('meituan', 'dianping', 'douyin', 'other')),
  code           text NOT NULL CHECK (code ~ '^[0-9A-Z]{6,64}$'),
  deal_name      text NOT NULL DEFAULT '' CHECK (char_length(deal_name) <= 48),
  -- 面值（顾客在平台付的）与平台应结给门店的（扣佣金后；不知道时按面值）
  face_value     bigint NOT NULL CHECK (face_value BETWEEN 0 AND 100000000),
  settle_amount  bigint NOT NULL CHECK (settle_amount >= 0 AND settle_amount <= face_value),
  guests         integer NOT NULL DEFAULT 1 CHECK (guests BETWEEN 1 AND 99),
  -- 在平台 App 核销的时刻与它所在的营业日
  redeemed_at    timestamptz NOT NULL,
  business_date  date NOT NULL,
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  registered_by  bigint NOT NULL REFERENCES staff (id),
  registered_at  timestamptz NOT NULL DEFAULT now(),
  client_key     uuid NOT NULL UNIQUE,
  request_hash   text NOT NULL,
  voided_by      bigint REFERENCES staff (id),
  voided_at      timestamptz,
  void_reason    text CHECK (char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX platform_redemptions_code_uq ON platform_redemptions (platform, code) WHERE status = 'active';
CREATE INDEX platform_redemptions_date_idx ON platform_redemptions (business_date);
CREATE TRIGGER platform_redemptions_no_delete BEFORE DELETE ON platform_redemptions FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

CREATE TABLE platform_settlements (
  id             bigserial PRIMARY KEY,
  settlement_no  text NOT NULL UNIQUE,
  platform       text NOT NULL CHECK (platform IN ('meituan', 'dianping', 'douyin', 'other')),
  period_from    date NOT NULL,
  period_to      date NOT NULL,
  amount         bigint NOT NULL CHECK (amount BETWEEN 1 AND 10000000000),
  received_on    date NOT NULL,
  ref            text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 64),
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  created_by     bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  client_key     uuid NOT NULL UNIQUE,
  request_hash   text NOT NULL,
  voided_by      bigint REFERENCES staff (id),
  voided_at      timestamptz,
  void_reason    text CHECK (char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  CHECK (period_from <= period_to),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX platform_settlements_period_idx ON platform_settlements (platform, period_from, period_to);
CREATE TRIGGER platform_settlements_no_delete BEFORE DELETE ON platform_settlements FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial',
                     'member_refund', 'member_status', 'member_merge', 'booking_create', 'booking_change',
                     'count_card_sale', 'count_card_refund', 'platform_redemption', 'platform_settlement'));
