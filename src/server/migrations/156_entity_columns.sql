-- 8.0.22 多公司主体（docs/MULTISTORE_V8022.md 第 9 节，MD-C）：合同、进项发票、付款申请与付款、合同付款、开票申请、
-- 银行账户、批量付款记哪个主体；默认当前门店所属的主体（只有一家店时都是「本公司」，编号 1），现有行都是本公司。
-- 有上级单据的跟着上级走（付款跟付款申请、付款申请跟合同、开票申请跟结账 / 充值所在的门店、批量付款跟付款账户），在代码里显式写。

CREATE FUNCTION yuzu_entity() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT entity_id FROM stores WHERE id = yuzu_store()), 1)
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contracts', 'supplier_invoices', 'payment_requests', 'payments', 'contract_payouts', 'invoice_requests', 'bank_accounts', 'payment_batches'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN entity_id bigint NOT NULL DEFAULT yuzu_entity() REFERENCES legal_entities (id)', t);
    EXECUTE format('CREATE INDEX %I ON %I (entity_id)', t || '_entity_idx', t);
  END LOOP;
END $$;
