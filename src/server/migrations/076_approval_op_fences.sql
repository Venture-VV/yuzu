-- v0.7.30 审批中心：新建审批规则、设代理人加入「确认作废」的业务类型（Codex 自动审查 2cfd28b）。
-- 没收到结果时（超时、断网、服务器出错）页面把操作编号与原请求存在本机，可以查回、按原内容重新提交，或在服务端确认作废——
-- 作废登记之后原请求才到也整笔拒绝（OP_ABANDONED），不会多建一条规则、不会悄悄多出一条代理设置。
-- 编号记在 approval_rules、approval_delegations 的 client_key 上（073）；这里只放宽作废登记的约束（同 039、057）。

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
                     'approval_rule', 'approval_delegation'));
