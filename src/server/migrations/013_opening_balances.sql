-- Batch 2.4d：旧系统（EBC）会员余额期初导入（店主 2026-10-27 #5 #6 #7）
--   · 旧会员只做导入：按手机号匹配已有会员，没有的新建档案；本金、赠金分开迁入，金额与旧系统一致；
--   · 每一批导入记下来源（例如 EBC）、文件名与文件摘要、经办人；每一行记下原始内容、旧卡号与是否新建会员；
--   · 迁入的余额记为单独的流水类型「期初导入」，不计入充值实收；一位会员只能有一笔有效的期初；
--   · 导入错了可以作废（逐位或整批；这位会员在期初之后还没有其他余额变动时），作废记为「期初作废」流水，原记录保留；
--   · 期初赠金进入赠金批次（可带旧系统的到期日）；旧系统的累计充值可一并导入，用于 VIP 柜等级。

CREATE TABLE opening_imports (
  id              bigserial PRIMARY KEY,
  import_no       text NOT NULL UNIQUE,
  -- 页面或命令行的操作编号：同一编号重提返回同一批，不会重复导入
  client_key      uuid NOT NULL UNIQUE,
  source          text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 32),
  file_name       text NOT NULL DEFAULT '' CHECK (char_length(file_name) <= 200),
  file_sha256     text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  row_count       integer NOT NULL CHECK (row_count > 0),
  created_count   integer NOT NULL CHECK (created_count >= 0),
  principal_total bigint NOT NULL CHECK (principal_total >= 0),
  bonus_total     bigint NOT NULL CHECK (bonus_total >= 0),
  business_date   date NOT NULL,
  imported_by     bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE opening_balances (
  id                bigserial PRIMARY KEY,
  import_id         bigint NOT NULL REFERENCES opening_imports (id),
  member_id         bigint NOT NULL REFERENCES members (id),
  doc_no            text NOT NULL UNIQUE,
  -- 来源文件里的行号（含表头，从 1 开始）与原始内容
  line_no           integer NOT NULL,
  source_row        jsonb NOT NULL,
  legacy_no         text NOT NULL DEFAULT '' CHECK (char_length(legacy_no) <= 32),
  principal         bigint NOT NULL CHECK (principal >= 0),
  bonus             bigint NOT NULL CHECK (bonus >= 0),
  bonus_expires_at  timestamptz,
  -- 旧系统的累计充值（用于 VIP 柜等级，口径待确认）；不计入充值实收
  legacy_recharged  bigint NOT NULL DEFAULT 0 CHECK (legacy_recharged >= 0),
  member_created    boolean NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  voided_at         timestamptz,
  voided_by         bigint REFERENCES staff (id),
  void_reason       text CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 2 AND 200),
  -- 作废记入的营业日（日结按它汇总期初作废）
  void_business_date date,
  UNIQUE (import_id, line_no),
  CHECK (bonus > 0 OR bonus_expires_at IS NULL),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL)
         AND (voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (void_business_date IS NULL))
);
-- 一位会员只能有一笔有效的期初
CREATE UNIQUE INDEX opening_balances_member_uq ON opening_balances (member_id) WHERE status = 'active';

CREATE TRIGGER opening_imports_guard BEFORE UPDATE OR DELETE ON opening_imports
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 期初明细只能从「有效」改为「已作废」（同时记下作废人、时间、原因），其余内容不能改
CREATE FUNCTION yuzu_opening_balance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  void_cols constant text[] := ARRAY['status', 'voided_at', 'voided_by', 'void_reason', 'void_business_date'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'opening_balances 禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.status = 'active' AND NEW.status = 'voided')
     OR (to_jsonb(NEW) - void_cols) <> (to_jsonb(OLD) - void_cols) THEN
    RAISE EXCEPTION 'opening_balances 只能作废' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_balances_guard BEFORE UPDATE OR DELETE ON opening_balances
  FOR EACH ROW EXECUTE FUNCTION yuzu_opening_balance_guard();

-- 期初赠金进入赠金批次；批次作废（整批期初作废时）记一笔 void 变动
ALTER TABLE bonus_lots ADD COLUMN opening_id bigint UNIQUE REFERENCES opening_balances (id);
ALTER TABLE bonus_lots DROP CONSTRAINT bonus_lots_source_check;
ALTER TABLE bonus_lots ADD CONSTRAINT bonus_lots_source_check CHECK (source IN ('legacy', 'recharge', 'restored', 'opening'));
ALTER TABLE bonus_lots ADD CONSTRAINT bonus_lots_opening_check CHECK ((source = 'opening') = (opening_id IS NOT NULL));

ALTER TABLE bonus_lot_moves ADD COLUMN opening_id bigint REFERENCES opening_balances (id);
ALTER TABLE bonus_lot_moves DROP CONSTRAINT bonus_lot_moves_kind_check;
ALTER TABLE bonus_lot_moves ADD CONSTRAINT bonus_lot_moves_kind_check CHECK (kind IN ('consume', 'restore', 'expire', 'void'));
ALTER TABLE bonus_lot_moves DROP CONSTRAINT bonus_lot_moves_check;
ALTER TABLE bonus_lot_moves ADD CONSTRAINT bonus_lot_moves_check CHECK (
  (kind = 'consume' AND amount < 0 AND consumption_id IS NOT NULL AND reversal_id IS NULL AND expiry_id IS NULL AND opening_id IS NULL)
  OR (kind = 'restore' AND amount > 0 AND consumption_id IS NOT NULL AND reversal_id IS NOT NULL AND expiry_id IS NULL AND opening_id IS NULL)
  OR (kind = 'expire' AND amount < 0 AND expiry_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL AND opening_id IS NULL)
  OR (kind = 'void' AND amount < 0 AND opening_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL AND expiry_id IS NULL)
);

-- 余额流水：「期初导入」只增不减，「期初作废」只减不增；都指向期初明细
ALTER TABLE ledger_entries ADD COLUMN opening_id bigint REFERENCES opening_balances (id);
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check
  CHECK (entry_type IN ('recharge', 'consume', 'reversal', 'expire', 'opening', 'opening_void'));
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_check CHECK (
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
);
CREATE UNIQUE INDEX ledger_entries_opening_uq ON ledger_entries (opening_id, entry_type) WHERE opening_id IS NOT NULL;
