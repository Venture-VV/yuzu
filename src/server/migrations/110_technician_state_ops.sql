-- 8.0.8 合并前 Codex 审查（e2cb70d，测试会话同时独立复现）：停牌、复牌、休假带操作编号（AGENTS.md：写操作带幂等键）。
--   · 停牌请求结果不明（超时、5xx）以后，页面进「结果待确认」：先查回或经服务端确认作废，才能另做停牌、复牌、休假；
--   · 原样重提返回第一次的结果，确认作废以后原请求即使迟到也不生效（不会在复牌以后又把技师停掉）。
-- 只放宽两条约束（与 093、106 一样），加业务类型 technician_state；不改表、不动数据。

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable', 'checkin', 'bill_post', 'tag_swap',
                     'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout', 'room_checkin', 'room_extend', 'room_deposit', 'room_refund',
                     'room_close', 'line_move', 'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund',
                     'erp_import', 'supplier_recon', 'supplier_recon_void', 'space_import', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'booking_create', 'booking_change', 'canteen_reply',
                     'request_import', 'gift_receipt', 'technician_state'));

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
                     'payment_request', 'contract_payout', 'contract_acceptance', 'contract_quality', 'supplier_invoice', 'canteen_reply',
                     'request_import', 'gift_receipt', 'coupon_campaign', 'ar_collection', 'asset_card', 'asset_stocktake', 'technician_state'));
