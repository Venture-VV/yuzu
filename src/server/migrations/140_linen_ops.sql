-- 8.0.20 合并前 Codex 审查（b850838）：布草单据接进全店的「结果待确认 / 确认作废」（AGENTS.md：提交前本机保存原编号与原请求，
-- 查不回只能原样重提，或经服务端确认作废后再重新填写）。
--   · 操作编号照旧记在单据上（linen_docs.client_key，迁移 138）；
--   · 「确认作废」加业务类型 linen_doc：作废登记以后，原请求再到也不会开单。
-- 只放宽约束，不动数据。

-- ───────────── 「确认作废」加业务类型 linen_doc（在 111 的基础上加一项） ─────────────
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
                     'request_import', 'gift_receipt', 'coupon_campaign', 'ar_collection', 'asset_card', 'asset_stocktake', 'technician_state', 'patrol_point', 'linen_doc'));
