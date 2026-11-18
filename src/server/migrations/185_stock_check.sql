-- 8.1.10 核库转领用（docs/ERP_V8110.md 第 2 节，PENDING_DECISIONS CK8–CK17）
--   · 需求单的核库状态：none 不用核 / 还没到（等部门主管确认）；pending 待核库；confirming 待部门确认替代；
--     done 核完；skipped 不用核（标了急、集采导入、总仓都没有、开关关着）；timeout 超时转采购；
--   · 状态多「已转领用」（issued）：每一行都从库存领用了，不再进采购；与通过、不采购、撤回一样是结束状态；
--   · request_line_stock：每一行的核库结果（领用、替代、转采购）与领料单；
--   · 已经领用的行不能再改、删（守卫）；
--   · 审批记录加动作 stock（核库，原因里写结果）；操作编号与「确认作废」加 request_stock。约束都在当时的约束上追加（写法见 162、183）。

ALTER TABLE purchase_requests
  ADD COLUMN stock_check text NOT NULL DEFAULT 'none'
    CHECK (stock_check IN ('none', 'pending', 'confirming', 'done', 'skipped', 'timeout')),
  ADD COLUMN stock_check_since timestamptz,
  ADD COLUMN stock_checked_by bigint REFERENCES staff (id),
  ADD COLUMN stock_checked_at timestamptz;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_stock_since
  CHECK (stock_check NOT IN ('pending', 'confirming') OR stock_check_since IS NOT NULL);
-- 核库没完的不能通过（代码先拒 STOCK_CHECK_PENDING，这里兜底）
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_stock_before_approve
  CHECK (NOT (status = 'approved' AND stock_check IN ('pending', 'confirming')));
CREATE INDEX purchase_requests_stock_check_idx ON purchase_requests (stock_check_since) WHERE stock_check IN ('pending', 'confirming');

ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_status_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_status_check
  CHECK (status IN ('submitted', 'returned', 'approved', 'rejected', 'cancelled', 'issued'));

CREATE TABLE request_line_stock (
  request_line_id        bigint PRIMARY KEY REFERENCES purchase_request_lines (id),
  request_id             bigint NOT NULL REFERENCES purchase_requests (id),
  -- issue 领用（可以只领一部分，剩下的转采购）；substitute 提议替代品（等部门确认）；purchase 转采购
  decision               text NOT NULL CHECK (decision IN ('issue', 'substitute', 'purchase')),
  -- 领用了多少（需求单这一行的单位，千分之一）：整行领用时等于申请数量；替代同意以后也记整行
  issued_qty_milli       bigint NOT NULL DEFAULT 0 CHECK (issued_qty_milli >= 0),
  -- 替代：库管提议的物料与数量（库存单位，千分之一）
  substitute_material_id bigint REFERENCES materials (id),
  substitute_qty_milli   bigint CHECK (substitute_qty_milli > 0),
  -- 替代的答复：pending 等部门；accepted 同意（开了领料单）；declined 不用、照原来买；expired 超时没回；failed 同意时总仓不够了
  substitute_state       text CHECK (substitute_state IN ('pending', 'accepted', 'declined', 'expired', 'failed')),
  -- 开的部门领料单（领用的、替代同意了的）
  inv_doc_id             bigint REFERENCES inv_docs (id),
  decided_by             bigint NOT NULL REFERENCES staff (id),
  decided_at             timestamptz NOT NULL DEFAULT now(),
  answered_by            bigint REFERENCES staff (id),
  answered_at            timestamptz,
  CHECK ((decision = 'substitute') = (substitute_material_id IS NOT NULL AND substitute_qty_milli IS NOT NULL AND substitute_state IS NOT NULL)),
  CHECK (decision <> 'purchase' OR (issued_qty_milli = 0 AND inv_doc_id IS NULL)),
  CHECK (decision <> 'issue' OR (issued_qty_milli > 0 AND inv_doc_id IS NOT NULL)),
  CHECK (decision <> 'substitute' OR ((substitute_state = 'accepted') = (inv_doc_id IS NOT NULL AND issued_qty_milli > 0))),
  CHECK ((answered_by IS NULL) = (answered_at IS NULL))
);
CREATE INDEX request_line_stock_request_idx ON request_line_stock (request_id);
CREATE INDEX request_line_stock_pending_idx ON request_line_stock (decided_at) WHERE substitute_state = 'pending';
CREATE INDEX request_line_stock_doc_idx ON request_line_stock (inv_doc_id) WHERE inv_doc_id IS NOT NULL;

-- 已经开了领料单的核库结果不能再改、删（领用是真的出了库；冲销走领料单自己的冲销）
CREATE FUNCTION yuzu_request_line_stock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.inv_doc_id IS NOT NULL THEN
    RAISE EXCEPTION '这一行已经从库存领用，核库结果不能再改' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER request_line_stock_guard BEFORE UPDATE OR DELETE ON request_line_stock
  FOR EACH ROW EXECUTE FUNCTION yuzu_request_line_stock_guard();

-- 需求单通过、不采购、撤回、已转领用之后，行与图片不能再改；已经从库存领用的行任何时候都不能再改、删
CREATE OR REPLACE FUNCTION yuzu_request_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rid bigint;
  st  text;
BEGIN
  IF TG_TABLE_NAME = 'purchase_request_lines' THEN
    rid := CASE WHEN TG_OP = 'INSERT' THEN NEW.request_id ELSE OLD.request_id END;
    IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM request_line_stock WHERE request_line_id = OLD.id AND inv_doc_id IS NOT NULL) THEN
      RAISE EXCEPTION '这一行已经从库存领用，不能再改' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT request_id INTO rid FROM purchase_request_lines
    WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.request_line_id ELSE OLD.request_line_id END;
  END IF;
  SELECT status INTO st FROM purchase_requests WHERE id = rid;
  IF st NOT IN ('submitted', 'returned') THEN
    RAISE EXCEPTION '需求单已%，明细不能再改',
      CASE st WHEN 'approved' THEN '通过' WHEN 'rejected' THEN '定为不采购' WHEN 'issued' THEN '转领用' ELSE '撤回' END
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- 需求单不能删除；通过、不采购、撤回、已转领用是终态
CREATE OR REPLACE FUNCTION yuzu_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '需求单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('approved', 'rejected', 'cancelled', 'issued') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION '需求单已结束审核，不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.doc_no, NEW.department_id, NEW.requester_id, NEW.created_at, NEW.client_key)
     IS DISTINCT FROM (OLD.doc_no, OLD.department_id, OLD.requester_id, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '需求单的单号、部门、提单人不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 审批记录加动作 stock（核库），在当时的约束上追加
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'approval_logs'::regclass AND conname = 'approval_logs_action_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原审批动作约束不存在'; END IF;
  ALTER TABLE approval_logs DROP CONSTRAINT approval_logs_action_check;
  EXECUTE format('ALTER TABLE approval_logs ADD CONSTRAINT approval_logs_action_check CHECK ((%s) OR action IN (''stock''))', expression);
END $$;

-- 操作编号与「确认作废」：核库（request_stock），在当时的约束上追加
DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''request_stock''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
