-- G3 复测修复：交班与收款以班次为界（增量迁移）
--   · 充值单、结账单在入账的同一事务里记下经办人当时未交班的班次（shift_id），交班表按班次汇总，不再按开班到交班的时间窗口：
--     收款事务锁完自己的业务行后对班次加共享锁（FOR SHARE），交班对班次加排他锁（FOR UPDATE）——
--     正在入账的收款提交后才能交班并计入本班次；交班之后才拿到锁的收款看到班次已交，不会记到已交的班次；
--   · 反结账同样记下反结账人当时未交班的班次（void_shift_id），交班表的反结账提醒按班次列出；
--   · 开班仍是可选的：没有开班的员工照常收款，单据的班次为空；
--   · 升级前的单据班次为空：已交班的班次保留交班时的快照不变；升级时仍未交班的班次（legacy_window）
--     对班次为空的单据按原来的时间窗口（开班之后本人经办）补算，升级之后开的班次只按班次汇总。

-- 已有班次（含升级时仍未交班的）记为 true，之后开的班次默认 false；只加列、不改已有行（交班记录的保护触发器不受影响）
ALTER TABLE shifts ADD COLUMN legacy_window boolean NOT NULL DEFAULT true;
ALTER TABLE shifts ALTER COLUMN legacy_window SET DEFAULT false;

-- 充值单只追加：班次在入账时写入
ALTER TABLE recharges ADD COLUMN shift_id bigint REFERENCES shifts (id);
CREATE INDEX recharges_shift_idx ON recharges (shift_id) WHERE shift_id IS NOT NULL;

ALTER TABLE checkouts
  ADD COLUMN shift_id bigint REFERENCES shifts (id),
  ADD COLUMN void_shift_id bigint REFERENCES shifts (id),
  ADD CONSTRAINT checkouts_void_shift_check CHECK (void_shift_id IS NULL OR status = 'voided');
CREATE INDEX checkouts_shift_idx ON checkouts (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX checkouts_void_shift_idx ON checkouts (void_shift_id) WHERE void_shift_id IS NOT NULL;

-- 结账单只能由「已结账」改为「已反结账」（反结账时可同时写入 void_shift_id），其余字段（含 shift_id）不可改；不能删除
CREATE OR REPLACE FUNCTION yuzu_checkout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  void_cols constant text[] := ARRAY['status', 'voided_at', 'voided_by', 'void_reason', 'void_business_date', 'void_shift_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '结账单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.status = 'completed' AND NEW.status = 'voided')
     OR (to_jsonb(NEW) - void_cols) <> (to_jsonb(OLD) - void_cols) THEN
    RAISE EXCEPTION '结账单只能反结账，不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
