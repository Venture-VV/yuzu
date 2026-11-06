-- 员工食堂 · 柚子饭堂第二期续（docs/CANTEEN.md 第 16 节；Codex 自动审查 3bc51e6）：柚子信箱的回信也走 ERP 的「结果待确认」。
-- 回信的操作编号记在 idempotency_keys（业务类型 canteen_reply，ref_id 是那一条）：没收到结果时关掉对话框、刷新以后也能查回、
-- 按原内容重新提交（同一编号只记一次）或确认作废（原请求晚到也不会改回信）。
-- 只放宽这两个约束（照 053、081 的清单各加一类），不改任何表、不动已有数据。

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable', 'checkin', 'bill_post', 'tag_swap',
                     'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout', 'room_checkin', 'room_extend', 'room_deposit', 'room_refund',
                     'room_close', 'line_move', 'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund',
                     'erp_import', 'supplier_recon', 'supplier_recon_void', 'space_import', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'booking_create', 'booking_change', 'canteen_reply'));
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
                     'payment_request', 'contract_payout', 'contract_acceptance', 'contract_quality', 'supplier_invoice', 'canteen_reply'));
