-- v0.7.28 ④（主线）：次卡（设计见 docs/SCHEDULE_FINISH.md 第 5 节，N5 待确认）。
--   · count_card_types：卡种——能抵的价目项目、票种，几次、售价、有效期（天，空为长期）；改了只影响之后卖的卡；
--   · count_cards：会员的次卡——记下卖的时候的条件（名称、能抵的项目与票种、总次数、售价、到期日）、剩几次、状态；
--     售卡（现金类收款，记到经办人当班的班次，是收款、不是营业额）或旧次卡期初（只记次数）；
--   · count_card_refunds：退卡单（退剩下的次数，按现金类方式退，记到班次），不能作废；
--   · count_card_moves：次数的变动（售卡、期初、结账使用、反结账退回、退卡、过期），只追加；剩几次 = 变动之和（自检）；
--   · 结账收款加「次卡」（count_card）：会员的预付消费，与会员储值一样算营业额、不算实收；记下用的哪张卡、几次。
--   · 「确认作废」加业务类型：售卡、退卡。
-- 只加表、加列、放宽约束，不改已有的行。

CREATE TABLE count_card_types (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE CHECK (char_length(btrim(name)) BETWEEN 1 AND 32),
  item_ids      bigint[] NOT NULL DEFAULT '{}',
  ticket_type_ids bigint[] NOT NULL DEFAULT '{}',
  uses          integer NOT NULL CHECK (uses BETWEEN 1 AND 100),
  price         bigint NOT NULL CHECK (price BETWEEN 1 AND 10000000),
  valid_days    integer CHECK (valid_days BETWEEN 1 AND 3650),
  active        boolean NOT NULL DEFAULT true,
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint REFERENCES staff (id),
  updated_at    timestamptz,
  CHECK (cardinality(item_ids) + cardinality(ticket_type_ids) BETWEEN 1 AND 50)
);
CREATE TRIGGER count_card_types_no_delete BEFORE DELETE ON count_card_types FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

CREATE TABLE count_cards (
  id              bigserial PRIMARY KEY,
  card_no         text NOT NULL UNIQUE,
  member_id       bigint NOT NULL REFERENCES members (id),
  type_id         bigint REFERENCES count_card_types (id),
  name            text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 32),
  item_ids        bigint[] NOT NULL DEFAULT '{}',
  ticket_type_ids bigint[] NOT NULL DEFAULT '{}',
  total_uses      integer NOT NULL CHECK (total_uses BETWEEN 1 AND 1000),
  remaining       integer NOT NULL CHECK (remaining >= 0),
  price           bigint NOT NULL CHECK (price >= 0),
  expires_on      date,
  source          text NOT NULL CHECK (source IN ('sale', 'opening')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used_up', 'expired', 'refunded')),
  payment_method  text CHECK (payment_method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other')),
  payment_ref     text NOT NULL DEFAULT '' CHECK (char_length(payment_ref) <= 64),
  shift_id        bigint REFERENCES shifts (id),
  business_date   date NOT NULL,
  sold_by         bigint NOT NULL REFERENCES staff (id),
  sold_at         timestamptz NOT NULL,
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  client_key      uuid UNIQUE,
  request_hash    text,
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (remaining <= total_uses),
  CHECK (cardinality(item_ids) + cardinality(ticket_type_ids) >= 1),
  -- 售卡：有卡种、收款方式、班次与操作编号；期初：没有收款
  CHECK (source <> 'sale' OR (type_id IS NOT NULL AND payment_method IS NOT NULL AND client_key IS NOT NULL AND request_hash IS NOT NULL AND price > 0)),
  CHECK (source <> 'opening' OR (payment_method IS NULL AND shift_id IS NULL)),
  CHECK (status <> 'used_up' OR remaining = 0),
  CHECK (status NOT IN ('expired', 'refunded') OR remaining = 0)
);
CREATE INDEX count_cards_member_idx ON count_cards (member_id, id);
CREATE INDEX count_cards_date_idx ON count_cards (business_date);
CREATE INDEX count_cards_shift_idx ON count_cards (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX count_cards_due_idx ON count_cards (expires_on) WHERE status = 'active';
CREATE TRIGGER count_cards_no_delete BEFORE DELETE ON count_cards FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

CREATE TABLE count_card_refunds (
  id             bigserial PRIMARY KEY,
  refund_no      text NOT NULL UNIQUE,
  card_id        bigint NOT NULL UNIQUE REFERENCES count_cards (id),
  uses           integer NOT NULL CHECK (uses >= 0),
  amount         bigint NOT NULL CHECK (amount >= 0),
  method         text NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other')),
  ref            text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 64),
  reason         text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  operator_id    bigint NOT NULL REFERENCES staff (id),
  shift_id       bigint REFERENCES shifts (id),
  business_date  date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  client_key     uuid NOT NULL UNIQUE,
  request_hash   text NOT NULL
);
CREATE INDEX count_card_refunds_date_idx ON count_card_refunds (business_date);
CREATE INDEX count_card_refunds_shift_idx ON count_card_refunds (shift_id) WHERE shift_id IS NOT NULL;
CREATE TRIGGER count_card_refunds_append_only BEFORE UPDATE OR DELETE ON count_card_refunds
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE count_card_moves (
  id            bigserial PRIMARY KEY,
  card_id       bigint NOT NULL REFERENCES count_cards (id),
  kind          text NOT NULL CHECK (kind IN ('sale', 'opening', 'use', 'return', 'refund', 'expire')),
  delta         integer NOT NULL,
  -- 售卡：售价；结账使用、反结账退回：抵的金额（按明细的价钱）；退卡：退的钱；期初、过期：0
  amount        bigint NOT NULL DEFAULT 0 CHECK (amount >= 0),
  checkout_id   bigint REFERENCES checkouts (id),
  refund_id     bigint REFERENCES count_card_refunds (id),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  staff_id      bigint NOT NULL REFERENCES staff (id),
  at            timestamptz NOT NULL,
  business_date date NOT NULL,
  CHECK ((kind IN ('sale', 'opening', 'return') AND delta > 0) OR (kind IN ('use', 'expire') AND delta < 0) OR (kind = 'refund' AND delta <= 0)),
  CHECK ((kind IN ('use', 'return')) = (checkout_id IS NOT NULL)),
  CHECK ((kind = 'refund') = (refund_id IS NOT NULL))
);
CREATE INDEX count_card_moves_card_idx ON count_card_moves (card_id, id);
CREATE INDEX count_card_moves_date_idx ON count_card_moves (business_date);
CREATE INDEX count_card_moves_checkout_idx ON count_card_moves (checkout_id) WHERE checkout_id IS NOT NULL;
CREATE TRIGGER count_card_moves_append_only BEFORE UPDATE OR DELETE ON count_card_moves
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 结账收款「次卡」：哪张卡、抵了几次
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check
  CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other', 'wallet', 'coupon', 'discount', 'store_coupon', 'member_discount', 'count_card'));
ALTER TABLE checkout_payments
  ADD COLUMN count_card_id bigint REFERENCES count_cards (id),
  ADD COLUMN count_card_uses integer CHECK (count_card_uses >= 1),
  ADD CONSTRAINT checkout_payments_count_card_check CHECK (
    (method = 'count_card') = (count_card_id IS NOT NULL) AND (method = 'count_card') = (count_card_uses IS NOT NULL));
CREATE INDEX checkout_payments_count_card_idx ON checkout_payments (count_card_id) WHERE count_card_id IS NOT NULL;

ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial',
                     'member_refund', 'member_status', 'member_merge', 'booking_create', 'booking_change',
                     'count_card_sale', 'count_card_refund'));
