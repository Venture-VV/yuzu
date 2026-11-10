-- 8.0.7 Codex 审查（d8b314b）的三处，见 docs/ERP_V807.md 第 5 节：
--   · 审批代理最长在「可调的数值」里可以设到 366 天（A7），库里原来卡在 31 天（ends_on - starts_on <= 30）：放宽到 366 天；
--   · 批量发券一次最多几位可以设到 20,000（HY07），库里原来卡在 2,000：放宽到 20,000；
--   · 资产扫码盘点结束时记下当时的结果（应盘、盘到、盘亏、不在范围里的），之后建卡、调拨、报废不再改写已经结束的盘点；
--     结束以后这一行不能再改，盘点记录不能删。
-- 只放宽约束、加一列：已有的数据都满足；之前已经结束、没有记下结果的盘点照旧按现在的卡片现算。
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'approval_delegations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ends_on - starts_on%' LOOP
    EXECUTE format('ALTER TABLE approval_delegations DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'coupon_campaigns'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%targeted%' LOOP
    EXECUTE format('ALTER TABLE coupon_campaigns DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE approval_delegations ADD CONSTRAINT approval_delegations_span CHECK (ends_on >= starts_on AND ends_on - starts_on <= 365);
ALTER TABLE coupon_campaigns ADD CONSTRAINT coupon_campaigns_targeted_range CHECK (targeted BETWEEN 1 AND 20000);

ALTER TABLE asset_stocktakes ADD COLUMN result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object');

CREATE FUNCTION yuzu_asset_stocktake_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '盘点记录不能删除';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION '已经结束的盘点不能再改';
  END IF;
  IF NEW.result IS NOT NULL AND NEW.status <> 'closed' THEN
    RAISE EXCEPTION '盘点结束时才记结果';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_stocktakes_guard BEFORE UPDATE OR DELETE ON asset_stocktakes
  FOR EACH ROW EXECUTE FUNCTION yuzu_asset_stocktake_guard();
