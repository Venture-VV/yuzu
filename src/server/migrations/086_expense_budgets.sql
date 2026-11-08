-- 8.0.3 费用预算（docs/BUDGET_INVOICES.md 第 2 节，默认 BI01–BI06 待确认）：
--   · 部门 × 费用科目 × 起始月的额度：从那个月起生效、之后每月沿用，直到下一次修改；额度为空 = 从那个月起不控制；
--   · 报销单记下登记（或退回后再提交）时的超预算核对；超预算的走审批中心的「超预算报销」；
--   · 报销单的守护：要不要审批（needs_approval）与超预算核对只在待确认、退回时随提交更新。顺带修潜伏的问题：
--     门槛以内、但命中审批规则的报销登记时要把 needs_approval 改成「要」，026 的守护不让改，会报错。
-- 只加表、加列、放宽约束，不改已有数据（没设额度的都不控制，报销照旧）。

CREATE TABLE expense_budgets (
  id            bigserial PRIMARY KEY,
  department_id bigint NOT NULL REFERENCES departments (id),
  category      text NOT NULL CHECK (category IN ('office', 'fixed_asset', 'low_value', 'freight')),
  -- 从哪个月起（当月 1 号）
  from_month    date NOT NULL CHECK (from_month = date_trunc('month', from_month)::date),
  -- 额度（分）；为空 = 从这个月起不控制
  amount_cents  bigint CHECK (amount_cents IS NULL OR amount_cents BETWEEN 0 AND 100000000000),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by    bigint NOT NULL REFERENCES staff (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, category, from_month)
);
CREATE TRIGGER expense_budgets_no_delete BEFORE DELETE ON expense_budgets
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

ALTER TABLE expense_claims
  ADD COLUMN over_budget  boolean NOT NULL DEFAULT false,
  -- 核对的明细：[{category, budgetCents, usedBeforeCents, claimCents, fromMonth}]（只列有额度的科目）
  ADD COLUMN budget_check jsonb CHECK (budget_check IS NULL OR jsonb_typeof(budget_check) = 'array');

CREATE OR REPLACE FUNCTION yuzu_expense_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed text[] := ARRAY['status', 'confirmed_by', 'confirmed_at', 'returned_reason', 'voided_by', 'voided_at', 'void_reason', 'updated_at',
                        'needs_approval', 'over_budget', 'budget_check'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '报销单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - fixed) IS DISTINCT FROM (to_jsonb(OLD) - fixed) THEN
    RAISE EXCEPTION '报销单的内容不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'returned', 'cancelled'))
    OR (OLD.status = 'returned' AND NEW.status IN ('submitted', 'cancelled'))
    OR (OLD.status = 'confirmed' AND NEW.status = 'voided')) THEN
    RAISE EXCEPTION '报销单不能从 % 改为 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('confirmed', 'voided') AND (NEW.confirmed_by, NEW.confirmed_at) IS DISTINCT FROM (OLD.confirmed_by, OLD.confirmed_at) THEN
    RAISE EXCEPTION '已确认的报销单不能改确认人' USING ERRCODE = 'P0001';
  END IF;
  -- 要不要审批、超预算的核对只在待确认、退回时随提交更新（8.0.3）
  IF OLD.status IN ('confirmed', 'voided')
     AND (NEW.needs_approval, NEW.over_budget, NEW.budget_check) IS DISTINCT FROM (OLD.needs_approval, OLD.over_budget, OLD.budget_check) THEN
    RAISE EXCEPTION '已确认的报销单不能改审批与预算核对' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('cancelled', 'voided') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION '已撤回或冲销的报销单不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 审批中心的单据类型加「超预算报销」（挂在报销单上）
ALTER TABLE approval_rules DROP CONSTRAINT approval_rules_doc_type_check;
ALTER TABLE approval_rules ADD CONSTRAINT approval_rules_doc_type_check
  CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake',
                      'contract', 'contract_change', 'contract_seal', 'payment_request', 'payment_early', 'urgent_purchase',
                      'expense_over_budget'));
ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_doc_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_doc_type_check
  CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake',
                      'contract', 'contract_change', 'contract_seal', 'payment_request', 'payment_early', 'urgent_purchase',
                      'expense_over_budget'));
