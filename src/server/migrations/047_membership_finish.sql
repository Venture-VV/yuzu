-- 047 会员体系收尾（v0.7.26；店主 2026-11-04：这次 PR 把会员体系都做完；设计 docs/MEMBERSHIP_FINISH.md，默认做法 PENDING_DECISIONS M50、M69–M81）。
--   ① QY-004 浴票延迟的默认分钟数（M50 店主已定）
--   ② 储值退回（MP21）：退储值单、按原收款方式的每一行；余额流水「储值退回」、赠金批次「扣回」
--   ③ 线上收款入口（小程序第二期，MP_RECHARGE.md 第 5 节）：充值单的渠道、系统账号「小程序」
--   ④ 会员停用 / 启用、换手机号、合并：只追加的记录；余额流水「合并转出」「合并转入」、赠金批次搬过去
--   ⑤ QY-041 同行优惠：折扣类加「同行的门票」「同行的整张账单」与「同行几位」
--   ⑥ 作废登记的业务类型、当场授权的用途
-- 不改已有的结账、充值、消费数据；权益只改没人动过的 QY-004、QY-041 草稿。
-- 与小程序线的 046（第二期线上充值单）互不依赖：新装的库先建 046 再建 047，已经升到 047 的库之后补跑 046 也照样能跑。

-- ───────────── ① QY-004 浴票延迟的默认分钟数 ─────────────
-- 已经导入、还没人动过的 QY-004（浴票延迟、草稿、版本 1、起点 L1·尊、没填分钟数）补上默认：
-- 从 L1·初 起 30 分钟；各档阶表 L1·享 60、L1·尊 90，L2–L6 每一档初阶 30、享阶 60、尊阶 90 分钟（共 17 行，
-- 与导入清单的 TICKET_EXTENSION_DEFAULT_ROWS 一样）。仍是草稿、不改版本号（与 042 预填 QY-011 的折扣一样）；改过的不动。
UPDATE benefits
SET start_grade = 1, start_tier = 0, quantity = 30,
    tier_quantities = (
      SELECT jsonb_agg(jsonb_build_object('grade', g, 'tier', t, 'quantity', (ARRAY[30, 60, 90])[t + 1]) ORDER BY g, t)
      FROM generate_series(1, 6) AS g, generate_series(0, 2) AS t
      WHERE g > 1 OR t > 0)
WHERE code = 'QY-004' AND category = 'extension' AND status = 'draft' AND version = 1
  AND start_grade = 1 AND start_tier = 2 AND period = 'none'
  AND quantity IS NULL AND tier_quantities = '[]'::jsonb AND template_id IS NULL;

-- ───────────── ④ 合并（表要先建：余额流水、赠金批次引用它） ─────────────
-- 一位会员只能被并走一次；并了不能撤销。余额与赠金批次在同一事务里转过去，目标会员取两位里高的状态（grade_event_id）
CREATE TABLE member_merges (
  id             bigserial PRIMARY KEY,
  merge_no       text NOT NULL UNIQUE,
  source_id      bigint NOT NULL UNIQUE REFERENCES members (id),
  target_id      bigint NOT NULL REFERENCES members (id),
  principal      bigint NOT NULL CHECK (principal >= 0),
  bonus          bigint NOT NULL CHECK (bonus >= 0),
  reason         text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  staff_id       bigint NOT NULL REFERENCES staff (id),
  business_date  date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  client_key     uuid NOT NULL UNIQUE,
  request_hash   text NOT NULL,
  CHECK (source_id <> target_id)
);
CREATE INDEX member_merges_target_idx ON member_merges (target_id);
CREATE TRIGGER member_merges_append_only BEFORE UPDATE OR DELETE ON member_merges
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 被并走的会员：停用，记下并到了谁（不能指向自己；被并走的不能再被当作目标，由应用核对）
ALTER TABLE members ADD COLUMN merged_into_id bigint REFERENCES members (id);
ALTER TABLE members ADD CONSTRAINT members_merged_check
  CHECK (merged_into_id IS NULL OR (merged_into_id <> id AND status = 'frozen'));
CREATE INDEX members_merged_into_idx ON members (merged_into_id) WHERE merged_into_id IS NOT NULL;

-- ───────────── ② 储值退回 ─────────────
-- 退储值单：退的本金、扣回的赠金、经办人、当场授权的人、记到的班次（退现金时是所选钱箱当班的班次，否则是经办人的班次）
CREATE TABLE member_refunds (
  id             bigserial PRIMARY KEY,
  refund_no      text NOT NULL UNIQUE,
  member_id      bigint NOT NULL REFERENCES members (id),
  principal      bigint NOT NULL CHECK (principal > 0),
  bonus          bigint NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  reason         text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  operator_id    bigint NOT NULL REFERENCES staff (id),
  approved_by    bigint NOT NULL REFERENCES staff (id),
  shift_id       bigint REFERENCES shifts (id),
  business_date  date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  client_key     uuid NOT NULL UNIQUE,
  request_hash   text NOT NULL
);
CREATE INDEX member_refunds_member_idx ON member_refunds (member_id, id);
CREATE INDEX member_refunds_date_idx ON member_refunds (business_date);
CREATE INDEX member_refunds_shift_idx ON member_refunds (shift_id) WHERE shift_id IS NOT NULL;
CREATE TRIGGER member_refunds_append_only BEFORE UPDATE OR DELETE ON member_refunds
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 每一行：退的是哪一笔的本金（充值 / 期初余额 / 合并转入）、按什么方式退、退款单号（扫码、银行卡）或怎么退的（其他）
CREATE TABLE member_refund_lines (
  id               bigserial PRIMARY KEY,
  refund_id        bigint NOT NULL REFERENCES member_refunds (id),
  source           text NOT NULL CHECK (source IN ('recharge', 'opening', 'merge')),
  recharge_id      bigint REFERENCES recharges (id),
  opening_id       bigint REFERENCES opening_balances (id),
  member_merge_id  bigint REFERENCES member_merges (id),
  method           text NOT NULL CHECK (method IN ('wechat', 'alipay', 'cash', 'bank_card', 'other')),
  amount           bigint NOT NULL CHECK (amount > 0),
  ref              text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 64),
  CHECK ((source = 'recharge') = (recharge_id IS NOT NULL)),
  CHECK ((source = 'opening') = (opening_id IS NOT NULL)),
  CHECK ((source = 'merge') = (member_merge_id IS NOT NULL))
);
CREATE INDEX member_refund_lines_refund_idx ON member_refund_lines (refund_id);
CREATE INDEX member_refund_lines_recharge_idx ON member_refund_lines (recharge_id) WHERE recharge_id IS NOT NULL;
CREATE TRIGGER member_refund_lines_append_only BEFORE UPDATE OR DELETE ON member_refund_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 余额流水：「储值退回」本金减、赠金不增；「合并转出」只减、「合并转入」只增；都指向各自的单子
ALTER TABLE ledger_entries
  ADD COLUMN member_refund_id bigint REFERENCES member_refunds (id),
  ADD COLUMN member_merge_id bigint REFERENCES member_merges (id);
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check
  CHECK (entry_type IN ('recharge', 'consume', 'reversal', 'expire', 'opening', 'opening_void', 'refund', 'merge_out', 'merge_in'));
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_check CHECK (
  (member_refund_id IS NULL OR entry_type = 'refund')
  AND (member_merge_id IS NULL OR entry_type IN ('merge_out', 'merge_in'))
  AND (
    (entry_type = 'recharge' AND recharge_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL AND expiry_id IS NULL
      AND opening_id IS NULL AND principal_delta > 0 AND bonus_delta >= 0 AND operator_id IS NOT NULL)
    OR (entry_type = 'consume' AND consumption_id IS NOT NULL AND recharge_id IS NULL AND reversal_id IS NULL AND expiry_id IS NULL
      AND opening_id IS NULL AND principal_delta <= 0 AND bonus_delta <= 0 AND operator_id IS NOT NULL)
    OR (entry_type = 'reversal' AND reversal_id IS NOT NULL AND consumption_id IS NOT NULL AND recharge_id IS NULL AND expiry_id IS NULL
      AND opening_id IS NULL AND principal_delta >= 0 AND bonus_delta >= 0 AND operator_id IS NOT NULL)
    OR (entry_type = 'expire' AND expiry_id IS NOT NULL AND recharge_id IS NULL AND consumption_id IS NULL AND reversal_id IS NULL
      AND opening_id IS NULL AND principal_delta = 0 AND bonus_delta < 0)
    OR (entry_type = 'opening' AND opening_id IS NOT NULL AND recharge_id IS NULL AND consumption_id IS NULL AND reversal_id IS NULL
      AND expiry_id IS NULL AND principal_delta >= 0 AND bonus_delta >= 0 AND principal_delta + bonus_delta > 0 AND operator_id IS NOT NULL)
    OR (entry_type = 'opening_void' AND opening_id IS NOT NULL AND recharge_id IS NULL AND consumption_id IS NULL AND reversal_id IS NULL
      AND expiry_id IS NULL AND principal_delta <= 0 AND bonus_delta <= 0 AND principal_delta + bonus_delta < 0 AND operator_id IS NOT NULL)
    OR (entry_type = 'refund' AND member_refund_id IS NOT NULL AND recharge_id IS NULL AND consumption_id IS NULL AND reversal_id IS NULL
      AND expiry_id IS NULL AND opening_id IS NULL AND principal_delta < 0 AND bonus_delta <= 0 AND operator_id IS NOT NULL)
    OR (entry_type = 'merge_out' AND member_merge_id IS NOT NULL AND recharge_id IS NULL AND consumption_id IS NULL AND reversal_id IS NULL
      AND expiry_id IS NULL AND opening_id IS NULL AND principal_delta <= 0 AND bonus_delta <= 0 AND principal_delta + bonus_delta < 0
      AND operator_id IS NOT NULL)
    OR (entry_type = 'merge_in' AND member_merge_id IS NOT NULL AND recharge_id IS NULL AND consumption_id IS NULL AND reversal_id IS NULL
      AND expiry_id IS NULL AND opening_id IS NULL AND principal_delta >= 0 AND bonus_delta >= 0 AND principal_delta + bonus_delta > 0
      AND operator_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX ledger_entries_member_refund_uq ON ledger_entries (member_refund_id) WHERE member_refund_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_entries_member_merge_uq ON ledger_entries (member_merge_id, entry_type) WHERE member_merge_id IS NOT NULL;

-- 赠金批次：合并搬过去的批次（来源「合并」，记下原批次与合并单，到期日不变）
ALTER TABLE bonus_lots
  ADD COLUMN member_merge_id bigint REFERENCES member_merges (id),
  ADD COLUMN origin_lot_id bigint REFERENCES bonus_lots (id);
ALTER TABLE bonus_lots DROP CONSTRAINT bonus_lots_source_check;
ALTER TABLE bonus_lots ADD CONSTRAINT bonus_lots_source_check CHECK (source IN ('legacy', 'recharge', 'restored', 'opening', 'merged'));
ALTER TABLE bonus_lots ADD CONSTRAINT bonus_lots_merge_check
  CHECK ((source = 'merged') = (member_merge_id IS NOT NULL) AND (member_merge_id IS NULL) = (origin_lot_id IS NULL));

-- 赠金批次的变动：「扣回」（储值退回）、「合并转出」
ALTER TABLE bonus_lot_moves
  ADD COLUMN member_refund_id bigint REFERENCES member_refunds (id),
  ADD COLUMN member_merge_id bigint REFERENCES member_merges (id);
ALTER TABLE bonus_lot_moves DROP CONSTRAINT bonus_lot_moves_kind_check;
ALTER TABLE bonus_lot_moves ADD CONSTRAINT bonus_lot_moves_kind_check
  CHECK (kind IN ('consume', 'restore', 'expire', 'void', 'refund', 'merge_out'));
ALTER TABLE bonus_lot_moves DROP CONSTRAINT bonus_lot_moves_check;
ALTER TABLE bonus_lot_moves ADD CONSTRAINT bonus_lot_moves_check CHECK (
  (member_refund_id IS NULL OR kind = 'refund')
  AND (member_merge_id IS NULL OR kind = 'merge_out')
  AND (
    (kind = 'consume' AND amount < 0 AND consumption_id IS NOT NULL AND reversal_id IS NULL AND expiry_id IS NULL AND opening_id IS NULL)
    OR (kind = 'restore' AND amount > 0 AND consumption_id IS NOT NULL AND reversal_id IS NOT NULL AND expiry_id IS NULL AND opening_id IS NULL)
    OR (kind = 'expire' AND amount < 0 AND expiry_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL AND opening_id IS NULL)
    OR (kind = 'void' AND amount < 0 AND opening_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL AND expiry_id IS NULL)
    OR (kind = 'refund' AND amount < 0 AND member_refund_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL
      AND expiry_id IS NULL AND opening_id IS NULL)
    OR (kind = 'merge_out' AND amount < 0 AND member_merge_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL
      AND expiry_id IS NULL AND opening_id IS NULL)
  )
);

-- ───────────── ③ 线上收款入口（小程序第二期） ─────────────
-- 充值单的渠道：前台 counter、小程序 mp。小程序的不进任何班次，按微信交易单号（收款备注）去重
ALTER TABLE recharges ADD COLUMN channel text NOT NULL DEFAULT 'counter' CHECK (channel IN ('counter', 'mp'));
ALTER TABLE recharges ADD CONSTRAINT recharges_mp_check
  CHECK (channel = 'counter' OR (shift_id IS NULL AND payment_method = 'wechat' AND char_length(payment_ref) > 0));
CREATE UNIQUE INDEX recharges_mp_ref_uq ON recharges (payment_ref) WHERE channel = 'mp';

-- 系统账号：只做系统入账的经办人（线上充值记「小程序」），不能登录（停用、密码不可用），不出现在员工、排班、交班里。
-- 第一次线上入账时才建（system.mp），新装的库、测试库里的员工不受影响
ALTER TABLE staff ADD COLUMN system boolean NOT NULL DEFAULT false;
ALTER TABLE staff ADD CONSTRAINT staff_system_check CHECK (NOT system OR (NOT active AND role = 'clerk'));

-- ───────────── ④ 停用 / 启用、换手机号（合并的表在上面） ─────────────
CREATE TABLE member_status_events (
  id             bigserial PRIMARY KEY,
  member_id      bigint NOT NULL REFERENCES members (id),
  from_status    text NOT NULL CHECK (from_status IN ('active', 'frozen')),
  to_status      text NOT NULL CHECK (to_status IN ('active', 'frozen')),
  -- 合并时停用来源会员也记一条（member_merge_id 指向合并单）
  member_merge_id bigint REFERENCES member_merges (id),
  reason         text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  staff_id       bigint NOT NULL REFERENCES staff (id),
  business_date  date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  client_key     uuid UNIQUE,
  request_hash   text,
  CHECK (from_status <> to_status),
  CHECK ((client_key IS NULL) = (request_hash IS NULL)),
  CHECK (member_merge_id IS NULL OR (to_status = 'frozen' AND client_key IS NULL))
);
CREATE INDEX member_status_events_member_idx ON member_status_events (member_id, id);
CREATE TRIGGER member_status_events_append_only BEFORE UPDATE OR DELETE ON member_status_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE member_phone_changes (
  id             bigserial PRIMARY KEY,
  member_id      bigint NOT NULL REFERENCES members (id),
  old_phone      text NOT NULL,
  new_phone      text NOT NULL,
  reason         text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  staff_id       bigint NOT NULL REFERENCES staff (id),
  -- 当场授权的人；经办人自己有「改会员手机号」权限时为空
  approved_by    bigint REFERENCES staff (id),
  business_date  date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (old_phone <> new_phone)
);
CREATE INDEX member_phone_changes_member_idx ON member_phone_changes (member_id, id);
CREATE TRIGGER member_phone_changes_append_only BEFORE UPDATE OR DELETE ON member_phone_changes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 状态变化记录：「储值退回」降档、「合并」取高的状态
ALTER TABLE member_grade_events DROP CONSTRAINT member_grade_events_kind_check;
ALTER TABLE member_grade_events ADD CONSTRAINT member_grade_events_kind_check
  CHECK (kind IN ('go_live', 'import', 'recharge_up', 'spend_up', 'retain', 'grace_start', 'grace_retain', 'downgrade', 'manual',
                  'refund_down', 'merge'));
ALTER TABLE member_grade_events
  ADD COLUMN member_refund_id bigint REFERENCES member_refunds (id),
  ADD COLUMN member_merge_id bigint REFERENCES member_merges (id);
ALTER TABLE member_grade_events ADD CONSTRAINT member_grade_events_refund_check
  CHECK ((kind = 'refund_down') = (member_refund_id IS NOT NULL) AND (kind = 'merge') = (member_merge_id IS NOT NULL));

-- ───────────── ⑤ QY-041 同行优惠 ─────────────
-- 折扣类加两种适用明细：同行的门票、同行的整张账单；「同行几位」起点一个数、各档阶一张表（按会员现在的档阶取一行，不相加）
ALTER TABLE benefits DROP CONSTRAINT benefits_discount_target_check;
ALTER TABLE benefits ADD CONSTRAINT benefits_discount_target_check
  CHECK (discount_target IN ('room', 'ticket', 'bill', 'companion_ticket', 'companion_bill'));
ALTER TABLE benefits
  ADD COLUMN companion_count smallint CHECK (companion_count BETWEEN 1 AND 9),
  ADD COLUMN companion_counts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(companion_counts) = 'array');
-- 只有「同行的」适用明细才有同行几位；发布同行优惠要填同行几位
ALTER TABLE benefits ADD CONSTRAINT benefits_companion_check CHECK (
  (discount_target IN ('companion_ticket', 'companion_bill')) OR (companion_count IS NULL AND companion_counts = '[]'::jsonb));
ALTER TABLE benefits ADD CONSTRAINT benefits_companion_publish_check CHECK (
  status <> 'published' OR discount_target IS NULL OR discount_target NOT IN ('companion_ticket', 'companion_bill') OR companion_count IS NOT NULL);

-- 已经导入、还没人动过的 QY-041（折扣类、草稿、版本 1、起点 L3·初、没填适用明细与折扣）补上起点与人数（M81）：
-- 同行的门票，同行 1 位，L6·初 起 2 位；不填折扣（会员文档「范围与折扣待定」），发布不了
UPDATE benefits
SET discount_target = 'companion_ticket', companion_count = 1,
    companion_counts = '[{"grade": 6, "tier": 0, "quantity": 2}]'::jsonb
WHERE code = 'QY-041' AND category = 'discount' AND status = 'draft' AND version = 1
  AND start_grade = 3 AND start_tier = 0 AND discount_target IS NULL AND quantity IS NULL AND tier_quantities = '[]'::jsonb;

-- ───────────── ⑥ 作废登记的业务类型、当场授权的用途 ─────────────
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial',
                     'member_refund', 'member_status', 'member_merge'));

ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_purpose_check;
ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_purpose_check
  CHECK (purpose IN ('vip_tag', 'over_limit', 'checkout_discount', 'ticket_discount', 'member_refund', 'member_phone'));
