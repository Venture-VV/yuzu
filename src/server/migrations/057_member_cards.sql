-- v0.7.28 ⑦（主线）：会员实体卡——发卡、刷卡找会员、挂失、补卡（设计见 docs/SCHEDULE_FINISH.md 第 8 节，N8 待确认）。
--   · member_cards：一张实体卡一行。卡号是读卡器读到的号（或手输），规整成大写数字字母；
--     一位会员同时只有一张在用的卡，同一个卡号同时只能是一张在用或挂失的卡（挂失的卡号不能再发给别人）；
--   · 挂失：原卡从此不能用（找回也不解挂），补一张新卡；损坏换卡：原卡记「已换下」，卡号可以再发；
--   · 卡只是认人：钱照旧在会员钱包里；发卡、补卡不收工本费（N8 待确认）；
--   · 「确认作废」加业务类型：发卡（member_card）。
-- 只加表、放宽业务类型，不改已有的行。

CREATE TABLE member_cards (
  id            bigserial PRIMARY KEY,
  card_no       text NOT NULL CHECK (card_no ~ '^[0-9A-Z]{4,32}$'),
  member_id     bigint NOT NULL REFERENCES members (id),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lost', 'canceled')),
  issued_by     bigint NOT NULL REFERENCES staff (id),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  -- 补卡：换下的那一张（挂失的、损坏的）
  replaces_id   bigint REFERENCES member_cards (id),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  client_key    uuid NOT NULL UNIQUE,
  request_hash  text NOT NULL,
  -- 挂失、换下：谁、什么时候、为什么
  ended_by      bigint REFERENCES staff (id),
  ended_at      timestamptz,
  end_reason    text CHECK (end_reason IS NULL OR char_length(btrim(end_reason)) BETWEEN 2 AND 100),
  CHECK ((status = 'active') = (ended_at IS NULL) AND (ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (replaces_id IS NULL OR replaces_id <> id)
);
-- 一位会员同时只有一张在用的卡；同一个卡号同时只能是一张在用或挂失的卡
CREATE UNIQUE INDEX member_cards_active_member_uq ON member_cards (member_id) WHERE status = 'active';
CREATE UNIQUE INDEX member_cards_no_uq ON member_cards (card_no) WHERE status IN ('active', 'lost');
CREATE INDEX member_cards_member_idx ON member_cards (member_id, id DESC);
CREATE INDEX member_cards_no_idx ON member_cards (card_no);
CREATE TRIGGER member_cards_no_delete BEFORE DELETE ON member_cards FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial',
                     'member_refund', 'member_status', 'member_merge', 'booking_create', 'booking_change',
                     'count_card_sale', 'count_card_refund', 'platform_redemption', 'platform_settlement', 'doc_print', 'member_card'));
