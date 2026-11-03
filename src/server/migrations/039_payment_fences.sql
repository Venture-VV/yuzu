-- 039 供应商付款、期初未付登记的「确认作废」（v0.7.22，代码整理时发现）：
--   这两项的页面原来只把「结果待确认」的请求放在页面内存里，刷新就丢；服务端也不能作废原编号，
--   刷新后重新填写、原请求又晚到，会登记成两笔付款。v0.7.22 起与核销、供应商退款一样：
--   页面提交前把编号和原请求存在本机，查回、原样重提或在服务端确认作废（原请求晚到也整笔回滚）。
-- 只放宽作废登记允许的业务类型；原有数据不变。

ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable'));
