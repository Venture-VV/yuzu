-- 125 部门主管与需求单的主管确认（8.0.17，店主 2026-11-13，docs/FLOW_V8017.md 第 8 节，PENDING_DECISIONS LC1、LC11–LC13）。
--   · 部门档案加主管（head_id，可空）：库存 → 档案 → 部门里设；
--   · 需求单加「主管确认」：提交时按采购规则定下来要不要确认、由谁确认（dept_head_id，记当时的主管）；
--     none 不用确认（规则没要求、部门没设主管）；pending 等主管确认；confirmed 已确认（提单人就是主管、店主提的也算）。
-- 只加列、都有默认值：原来的需求单都是 none，照旧只走采购的一道审核。
-- 兜底：等主管确认的需求单不能是「已通过」（程序在需求单的行锁里核对，这里再拦一道）。

ALTER TABLE departments ADD COLUMN head_id bigint REFERENCES staff (id);

ALTER TABLE purchase_requests
  ADD COLUMN dept_confirm      text NOT NULL DEFAULT 'none' CHECK (dept_confirm IN ('none', 'pending', 'confirmed')),
  ADD COLUMN dept_head_id      bigint REFERENCES staff (id),
  ADD COLUMN dept_confirmed_by bigint REFERENCES staff (id),
  ADD COLUMN dept_confirmed_at timestamptz,
  ADD CONSTRAINT purchase_requests_dept_confirmed CHECK ((dept_confirm = 'confirmed') = (dept_confirmed_at IS NOT NULL AND dept_confirmed_by IS NOT NULL)),
  ADD CONSTRAINT purchase_requests_dept_pending_head CHECK (dept_confirm <> 'pending' OR dept_head_id IS NOT NULL),
  ADD CONSTRAINT purchase_requests_dept_before_approve CHECK (NOT (status = 'approved' AND dept_confirm = 'pending'));

-- 主管找「等我确认的」
CREATE INDEX purchase_requests_dept_pending_idx ON purchase_requests (dept_head_id) WHERE dept_confirm = 'pending' AND status = 'submitted';
