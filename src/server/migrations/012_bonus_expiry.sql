-- Batch 2.4c：赠金有效期（店主 2026-10-27 #2：档位、赠送金额和赠金有效期——包括不设有效期——都由店主在后台维护）
--   · 充值套餐可设赠金有效期（天），不设为长期有效；自定义赠金按经营规则里的默认有效期（默认不设）；
--   · 每笔赠金是一个「赠金批次」，记下金额、剩余与到期时间；消费扣赠金时先用最早到期的批次（长期有效的最后用）；
--   · 到期未用完的赠金作废：生成「赠金过期单」与一条只减赠金的余额流水，记账人为系统；
--   · 撤销消费时赠金恢复到原批次，原批次已到期的随即作废；
--   · 升级前已有的赠金余额记为一个长期有效的批次（legacy），与升级前一致；升级前的消费被撤销时，
--     恢复的赠金记为长期有效的批次（restored）。
-- 会员钱包仍是唯一的储值账本：members.bonus_balance = 全部批次剩余之和，自检逐位核对。

ALTER TABLE recharge_plans ADD COLUMN bonus_valid_days integer CHECK (bonus_valid_days BETWEEN 1 AND 3650);
-- 充值时确定的赠金到期时间（到期那个营业日开始时作废）；没有赠金或不设有效期时为空
ALTER TABLE recharges ADD COLUMN bonus_expires_at timestamptz;

CREATE TABLE bonus_expiries (
  id            bigserial PRIMARY KEY,
  doc_no        text NOT NULL UNIQUE,
  member_id     bigint NOT NULL REFERENCES members (id),
  amount        bigint NOT NULL CHECK (amount > 0),
  business_date date NOT NULL,
  -- 撤销消费时恢复到已到期批次、随即作废的，记下是哪张撤销单
  reversal_id   bigint REFERENCES reversals (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bonus_expiries_date_idx ON bonus_expiries (business_date);
CREATE INDEX bonus_expiries_member_idx ON bonus_expiries (member_id);

CREATE TABLE bonus_lots (
  id          bigserial PRIMARY KEY,
  member_id   bigint NOT NULL REFERENCES members (id),
  source      text NOT NULL CHECK (source IN ('legacy', 'recharge', 'restored')),
  recharge_id bigint UNIQUE REFERENCES recharges (id),
  amount      bigint NOT NULL CHECK (amount > 0),
  remaining   bigint NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
  -- 空为长期有效
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'recharge') = (recharge_id IS NOT NULL))
);
CREATE INDEX bonus_lots_member_idx ON bonus_lots (member_id, id);
CREATE INDEX bonus_lots_due_idx ON bonus_lots (expires_at) WHERE remaining > 0 AND expires_at IS NOT NULL;

-- 批次的每一笔变动：消费扣用（负）、撤销恢复（正）、到期作废（负）
CREATE TABLE bonus_lot_moves (
  id             bigserial PRIMARY KEY,
  lot_id         bigint NOT NULL REFERENCES bonus_lots (id),
  kind           text NOT NULL CHECK (kind IN ('consume', 'restore', 'expire')),
  amount         bigint NOT NULL,
  consumption_id bigint REFERENCES consumptions (id),
  reversal_id    bigint REFERENCES reversals (id),
  expiry_id      bigint REFERENCES bonus_expiries (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'consume' AND amount < 0 AND consumption_id IS NOT NULL AND reversal_id IS NULL AND expiry_id IS NULL)
    OR (kind = 'restore' AND amount > 0 AND consumption_id IS NOT NULL AND reversal_id IS NOT NULL AND expiry_id IS NULL)
    OR (kind = 'expire' AND amount < 0 AND expiry_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL)
  )
);
CREATE INDEX bonus_lot_moves_lot_idx ON bonus_lot_moves (lot_id);
CREATE INDEX bonus_lot_moves_consumption_idx ON bonus_lot_moves (consumption_id) WHERE consumption_id IS NOT NULL;

CREATE TRIGGER bonus_expiries_append_only BEFORE UPDATE OR DELETE ON bonus_expiries
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER bonus_lot_moves_append_only BEFORE UPDATE OR DELETE ON bonus_lot_moves
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 批次只能改剩余金额，不能删除
CREATE FUNCTION yuzu_bonus_lot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bonus_lots 禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.member_id <> OLD.member_id OR NEW.source <> OLD.source
     OR NEW.recharge_id IS DISTINCT FROM OLD.recharge_id OR NEW.amount <> OLD.amount
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'bonus_lots 只能修改剩余金额' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bonus_lots_guard BEFORE UPDATE OR DELETE ON bonus_lots
  FOR EACH ROW EXECUTE FUNCTION yuzu_bonus_lot_guard();

-- 余额流水：新增「赠金过期」（只减赠金）；过期由系统处理，没有经办员工
ALTER TABLE ledger_entries ADD COLUMN expiry_id bigint REFERENCES bonus_expiries (id);
ALTER TABLE ledger_entries ALTER COLUMN operator_id DROP NOT NULL;
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check
  CHECK (entry_type IN ('recharge', 'consume', 'reversal', 'expire'));
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_check CHECK (
  (entry_type = 'recharge' AND recharge_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL AND expiry_id IS NULL
    AND principal_delta > 0 AND bonus_delta >= 0 AND operator_id IS NOT NULL)
  OR (entry_type = 'consume' AND consumption_id IS NOT NULL AND recharge_id IS NULL AND reversal_id IS NULL AND expiry_id IS NULL
    AND principal_delta <= 0 AND bonus_delta <= 0 AND operator_id IS NOT NULL)
  OR (entry_type = 'reversal' AND reversal_id IS NOT NULL AND consumption_id IS NOT NULL AND recharge_id IS NULL AND expiry_id IS NULL
    AND principal_delta >= 0 AND bonus_delta >= 0 AND operator_id IS NOT NULL)
  OR (entry_type = 'expire' AND expiry_id IS NOT NULL AND recharge_id IS NULL AND consumption_id IS NULL AND reversal_id IS NULL
    AND principal_delta = 0 AND bonus_delta < 0)
);
CREATE UNIQUE INDEX ledger_entries_expiry_uq ON ledger_entries (expiry_id) WHERE expiry_id IS NOT NULL;

-- 升级前已有的赠金：长期有效
INSERT INTO bonus_lots (member_id, source, amount, remaining, expires_at)
SELECT id, 'legacy', bonus_balance, bonus_balance, NULL FROM members WHERE bonus_balance > 0;
