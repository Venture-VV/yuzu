-- 8.0.21 供应商收款账户的双人复核（Codex 安全审查 354e34c 后补，docs/FINANCE_V8021.md 第 5 节，PENDING_DECISIONS CW28）：
--   收款户名、开户行、账号只由应付岗（payable.manage：店主与「应付」职责）在专门的接口里改，采购（inventory.master）改不了；
--   店主以外的人改了，要另一位应付或店主复核以后，批量付款才用它（生成批次时只抄已复核的）。
--   bank_changed_*：最近一次改收款账户的人与时刻；bank_verified_*：复核的人与时刻（没复核为空）。
--   触发器兜底：收款账户三项变了而同一句没有写新的复核，复核就清空（哪条路径改的都一样）。

ALTER TABLE suppliers
  ADD COLUMN bank_changed_by  bigint REFERENCES staff (id),
  ADD COLUMN bank_changed_at  timestamptz,
  ADD COLUMN bank_verified_by bigint REFERENCES staff (id),
  ADD COLUMN bank_verified_at timestamptz,
  ADD CONSTRAINT suppliers_bank_verified_pair CHECK ((bank_verified_by IS NULL) = (bank_verified_at IS NULL)),
  ADD CONSTRAINT suppliers_bank_verified_needs_account CHECK (bank_verified_at IS NULL OR bank_account <> '');

CREATE FUNCTION yuzu_supplier_bank_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.bank_payee, NEW.bank_name, NEW.bank_account) IS DISTINCT FROM (OLD.bank_payee, OLD.bank_name, OLD.bank_account)
     AND (NEW.bank_verified_by, NEW.bank_verified_at) IS NOT DISTINCT FROM (OLD.bank_verified_by, OLD.bank_verified_at) THEN
    NEW.bank_verified_by := NULL;
    NEW.bank_verified_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER suppliers_bank_guard BEFORE UPDATE OF bank_payee, bank_name, bank_account ON suppliers
  FOR EACH ROW EXECUTE FUNCTION yuzu_supplier_bank_guard();
