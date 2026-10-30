-- R1.9 按实际时间补录纸质单（店主 2026-10-29 决定要做，见 docs/PENDING_DECISIONS.md「按实际时间补录纸质单」）（增量迁移）
--   · 系统停用期间前台用预编号的纸质应急单记录接待、挂账与结账，恢复后按纸质单上的实际时间补录：
--     门票按实际在店时长计价，营业日、日结、对账都按实际时间归属；单据本身照常写在原来的表里（时间为实际时间）；
--   · 每一步补录（接待、挂账、结账）在这里留一条记录：纸质单号、实际时间、补录人与录入时间，日结与每日对账包列出；
--   · 只追加：补录记录与它对应的单据一样不改不删，纠错走反结账、作废明细、撤销来访。

CREATE TABLE backfill_entries (
  id            bigserial PRIMARY KEY,
  slip_no       text NOT NULL CHECK (slip_no ~ '^[0-9A-Za-z-]{1,32}$'),
  kind          text NOT NULL CHECK (kind IN ('checkin', 'charges', 'checkout')),
  -- 这一步的操作编号：接待的 visits.checkin_key、挂账的 bill_lines.post_key、结账的 checkouts.client_key
  op_key        uuid NOT NULL,
  visit_id      bigint REFERENCES visits (id),
  checkout_id   bigint REFERENCES checkouts (id),
  actual_at     timestamptz NOT NULL,
  business_date date NOT NULL,
  entered_by    bigint NOT NULL REFERENCES staff (id),
  entered_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'checkout') = (checkout_id IS NOT NULL)),
  CHECK (kind = 'checkout' OR visit_id IS NOT NULL),
  -- 补录的是已经发生的业务：实际时间不晚于录入时间（容许各终端时钟相差几分钟）
  CHECK (actual_at <= entered_at + interval '5 minutes')
);
CREATE INDEX backfill_entries_date_idx ON backfill_entries (business_date);
CREATE INDEX backfill_entries_visit_idx ON backfill_entries (visit_id) WHERE visit_id IS NOT NULL;
CREATE INDEX backfill_entries_checkout_idx ON backfill_entries (checkout_id) WHERE checkout_id IS NOT NULL;
CREATE INDEX backfill_entries_op_key_idx ON backfill_entries (op_key);

CREATE TRIGGER backfill_entries_append_only BEFORE UPDATE OR DELETE ON backfill_entries
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
