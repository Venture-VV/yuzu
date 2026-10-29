-- Batch 3 · S3.4：交班（店主 2026-10-27 #11：店员交班时需要做交班表或日结）
--   · 当班员工开班时登记备用金；交班时系统按本班次（开班到交班）本人经办、仍有效的结账与充值汇总各收款方式，
--     算出应有现金 = 备用金 + 现金收款，员工实点现金后交班，差额（长款 / 短款）与汇总快照一起留存；
--   · 一位员工同时只能有一个未交班的班次；交班后班次记录不能修改、不能删除。

CREATE TABLE shifts (
  id            bigserial PRIMARY KEY,
  shift_no      text NOT NULL UNIQUE,
  staff_id      bigint NOT NULL REFERENCES staff (id),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  business_date date NOT NULL,
  started_at    timestamptz NOT NULL,
  -- 备用金（开班时抽屉里的现金，分）
  opening_cash  bigint NOT NULL CHECK (opening_cash >= 0),
  ended_at      timestamptz,
  -- 交班时系统算出的应有现金、员工实点的现金
  expected_cash bigint,
  counted_cash  bigint CHECK (counted_cash >= 0),
  -- 交班时的汇总快照（各收款方式、单据数、反结账提醒等）
  summary       jsonb,
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  -- 接班人（可不填）
  handed_to     bigint REFERENCES staff (id),
  closed_by     bigint REFERENCES staff (id),
  CHECK ((status = 'closed') = (ended_at IS NOT NULL) AND (ended_at IS NULL) = (expected_cash IS NULL)
         AND (ended_at IS NULL) = (counted_cash IS NULL) AND (ended_at IS NULL) = (summary IS NULL)
         AND (ended_at IS NULL) = (closed_by IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX shifts_open_uq ON shifts (staff_id) WHERE status = 'open';
CREATE INDEX shifts_date_idx ON shifts (business_date);

-- 班次只能由「当班」改为「已交班」（同时写入交班信息），其余字段不可改；不能删除
CREATE FUNCTION yuzu_shift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  close_cols constant text[] := ARRAY['status', 'ended_at', 'expected_cash', 'counted_cash', 'summary', 'note', 'handed_to', 'closed_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '班次记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.status = 'open' AND NEW.status = 'closed')
     OR (to_jsonb(NEW) - close_cols) <> (to_jsonb(OLD) - close_cols) THEN
    RAISE EXCEPTION '班次只能交班一次，交班后不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shifts_guard BEFORE UPDATE OR DELETE ON shifts
  FOR EACH ROW EXECUTE FUNCTION yuzu_shift_guard();
