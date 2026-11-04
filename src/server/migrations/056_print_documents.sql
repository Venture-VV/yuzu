-- v0.7.28 ⑥（主线）：业务单据打到小票机与断网打印队列（设计见 docs/SCHEDULE_FINISH.md 第 7 节，N7 待确认；硬件 v0.2）。
--   · 打印任务加四种业务单据：结账单、退款单、交班表、日结单（80mm 汇总）。内容在提交时排好、存在任务上（不超过 64 KB），
--     补打的也是提交那一刻的数；测试页、测试标签照旧在发送时现排（没有内容列）；
--   · 状态加「等打印机恢复」（waiting）：业务单据遇到打印机离线、故障（缺纸、开盖），或还没开始发就连不上时进这里，
--     心跳看到打印机恢复在线后按提交顺序改回排队、自动补打；等太久（默认 30 分钟）不再打、记失败；
--     加「已取消」（canceled）：排队、等恢复中的单子可以取消；
--   · 记第一次开始等的时间与在等什么（补打的单子末尾注明）、取消人；
--   · 「确认作废」加业务类型：打印单据（doc_print）。
-- 只加列、放宽约束，不改已有的行。

ALTER TABLE device_jobs DROP CONSTRAINT device_jobs_kind_check;
ALTER TABLE device_jobs ADD CONSTRAINT device_jobs_kind_check
  CHECK (kind IN ('test_page', 'label_test', 'checkout_slip', 'refund_slip', 'shift_slip', 'settlement_slip'));

ALTER TABLE device_jobs DROP CONSTRAINT device_jobs_status_check;
ALTER TABLE device_jobs ADD CONSTRAINT device_jobs_status_check
  CHECK (status IN ('queued', 'sending', 'done', 'failed', 'waiting', 'canceled'));

-- 结束的（完成、失败、取消）才有结束时间
ALTER TABLE device_jobs DROP CONSTRAINT device_jobs_check;
ALTER TABLE device_jobs ADD CONSTRAINT device_jobs_finished_check
  CHECK ((status IN ('done', 'failed', 'canceled')) = (finished_at IS NOT NULL));

ALTER TABLE device_jobs
  -- 业务单据：哪张（结账单、退款单、交班表的编号，日结单的营业日）与显示用的单据名（如「结账单 A8071」）
  ADD COLUMN doc_ref         text CHECK (doc_ref IS NULL OR char_length(doc_ref) BETWEEN 1 AND 40),
  ADD COLUMN doc_label       text CHECK (doc_label IS NULL OR char_length(doc_label) BETWEEN 1 AND 60),
  -- 提交时排好的 ESC/POS 内容（不含末尾的走纸与切纸；补打时在末尾注明补打）
  ADD COLUMN payload         bytea CHECK (payload IS NULL OR octet_length(payload) BETWEEN 1 AND 65536),
  -- 第一次进「等打印机恢复」的时间（之后不再改：按它算等了多久）与最近一次在等什么（错误码）
  ADD COLUMN first_waited_at timestamptz,
  ADD COLUMN wait_code       text CHECK (wait_code IS NULL OR char_length(wait_code) <= 40),
  ADD COLUMN canceled_by     bigint REFERENCES staff (id),
  ADD CONSTRAINT device_jobs_doc_check
    CHECK ((kind IN ('test_page', 'label_test')) = (payload IS NULL) AND (payload IS NULL) = (doc_ref IS NULL) AND (doc_ref IS NULL) = (doc_label IS NULL)),
  ADD CONSTRAINT device_jobs_waiting_check CHECK (status <> 'waiting' OR first_waited_at IS NOT NULL),
  ADD CONSTRAINT device_jobs_canceled_check CHECK ((status = 'canceled') = (canceled_by IS NOT NULL));

CREATE INDEX device_jobs_waiting_idx ON device_jobs (device_id, id) WHERE status = 'waiting';

ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial',
                     'member_refund', 'member_status', 'member_merge', 'booking_create', 'booking_change',
                     'count_card_sale', 'count_card_refund', 'platform_redemption', 'platform_settlement', 'doc_print'));
