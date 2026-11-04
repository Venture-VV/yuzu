-- v0.7.28 ⑩（主线）：旧 EBC 逐笔流水只读导入（N12，设计见 docs/SCHEDULE_FINISH.md 第 11 节）。
--   · 旧系统（EBC）导出的会员逐笔流水（充值、消费、赠送、退款、调整……）按模板导入两张只读表，会员详情「旧系统流水」里看；
--   · 只读、不进正式账：不写余额流水、不改会员余额与档阶，期初余额照旧以期初导入为准；
--   · 每行按旧卡号（期初导入记下的）或手机号认会员，认不出的行不导入（预览与导入结果里列出）；
--   · 同一份文件（内容摘要相同）只能有一批有效的导入；整批作废后页面上不再显示，可以重新导入。
-- 只加表；不改已有的行。

CREATE TABLE member_history_imports (
  id            bigserial PRIMARY KEY,
  import_no     text NOT NULL UNIQUE,
  -- 页面上的「确认导入」带操作编号：同一编号重提返回第一次的结果
  client_key    uuid UNIQUE,
  source        text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 32),
  file_name     text NOT NULL DEFAULT '' CHECK (char_length(file_name) <= 200),
  file_sha256   text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  -- 文件里的数据行、导入的行、认不出会员没导入的行、涉及几位会员
  total_rows    integer NOT NULL CHECK (total_rows >= 0),
  imported_rows integer NOT NULL CHECK (imported_rows >= 0),
  skipped_rows  integer NOT NULL CHECK (skipped_rows >= 0),
  member_count  integer NOT NULL CHECK (member_count >= 0),
  first_at      timestamptz,
  last_at       timestamptz,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  voided_at     timestamptz,
  voided_by     bigint REFERENCES staff (id),
  void_reason   text CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 2 AND 200),
  CHECK (imported_rows + skipped_rows = total_rows),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
-- 同一份文件只能有一批有效的导入
CREATE UNIQUE INDEX member_history_imports_file_uq ON member_history_imports (file_sha256) WHERE status = 'active';

CREATE TABLE member_history_rows (
  id            bigserial PRIMARY KEY,
  import_id     bigint NOT NULL REFERENCES member_history_imports (id),
  -- 文件里的行号（含表头，从 1 开始）
  line_no       integer NOT NULL CHECK (line_no >= 2),
  member_id     bigint NOT NULL REFERENCES members (id),
  -- 怎么认出的会员：旧卡号（期初导入记下的）或手机号
  matched_by    text NOT NULL CHECK (matched_by IN ('legacy_no', 'phone')),
  occurred_at   timestamptz NOT NULL,
  -- 类型：原文（旧系统写的）与归类（充值、消费、赠送、退款、调整、其他，只用于显示）
  type_label    text NOT NULL CHECK (char_length(type_label) BETWEEN 1 AND 32),
  kind          text NOT NULL CHECK (kind IN ('recharge', 'consume', 'bonus', 'refund', 'adjust', 'other')),
  -- 金额（分，按旧系统的正负）；赠金、余额、赠金余额没有时为空
  amount        bigint NOT NULL,
  bonus         bigint,
  balance       bigint,
  bonus_balance bigint,
  doc_no        text NOT NULL DEFAULT '' CHECK (char_length(doc_no) <= 64),
  store         text NOT NULL DEFAULT '' CHECK (char_length(store) <= 64),
  operator      text NOT NULL DEFAULT '' CHECK (char_length(operator) <= 32),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  -- 原始内容（表头 → 单元格）
  raw           jsonb NOT NULL,
  UNIQUE (import_id, line_no)
);
CREATE INDEX member_history_rows_member_idx ON member_history_rows (member_id, occurred_at DESC, id DESC);

-- 流水行只读；导入记录只能作废一次（记作废时间、人与原因），其他字段不改
CREATE FUNCTION yuzu_member_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'member_history_rows' THEN
    RAISE EXCEPTION '旧系统流水只读，不能修改或删除（整批作废导入记录）' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '旧系统流水的导入记录禁止删除（可以作废）' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.status = 'active' AND NEW.status = 'voided')
     OR (to_jsonb(NEW) - ARRAY['status', 'voided_at', 'voided_by', 'void_reason']) <> (to_jsonb(OLD) - ARRAY['status', 'voided_at', 'voided_by', 'void_reason']) THEN
    RAISE EXCEPTION '旧系统流水的导入记录只能作废一次，不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_history_rows_guard BEFORE UPDATE OR DELETE ON member_history_rows
  FOR EACH ROW EXECUTE FUNCTION yuzu_member_history_guard();
CREATE TRIGGER member_history_imports_guard BEFORE UPDATE OR DELETE ON member_history_imports
  FOR EACH ROW EXECUTE FUNCTION yuzu_member_history_guard();
