-- v0.7.30（主线）审批中心（docs/APPROVALS.md，默认 A1–A10 待确认）：
--   · 审批规则：单据类型 × 金额区间（含下限、不含上限）× 部门 → 一到三级审批链（每级一个岗位组或指定的人，或签 / 会签）；
--     没有规则命中按现有的「负责人确认」开关与门槛走（默认规则，不存表），所以没建规则时行为与 v0.7.29 一样；
--   · 审批单：单据提交、要审批时生成，记下审批链的快照；逐级同意、任何一级可退回；同一单据同时只有一张在审的审批单；
--   · 审批记录：每一级的同意、退回（含代理审的「代 某某」），只追加；
--   · 代理人：请假时设，起止日期内代理人能审被代理人能审的单；
--   · 迁移时已经在「待确认」的单据各补一张审批单（默认规则：一级负责人），不改任何单据的状态。

CREATE TABLE approval_rules (
  id            bigserial PRIMARY KEY,
  doc_type      text NOT NULL CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake')),
  min_cents     bigint NOT NULL DEFAULT 0 CHECK (min_cents >= 0),
  max_cents     bigint CHECK (max_cents IS NULL OR max_cents > min_cents),
  department_id bigint REFERENCES departments (id),
  -- 审批链：[{ "group": "manager" | "finance" | "store_manager" | "owner" } 或 { "staffIds": [..] }，加 "mode": "any" | "all"]，一到三级
  steps         jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 3),
  allow_self    boolean NOT NULL DEFAULT false,
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  active        boolean NOT NULL DEFAULT true,
  version       integer NOT NULL DEFAULT 1,
  -- 新建时的操作编号与原请求摘要（同一编号重提返回原来那条，内容不一样拒绝）
  client_key    uuid NOT NULL UNIQUE,
  request_hash  text NOT NULL,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint REFERENCES staff (id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_rules_type_idx ON approval_rules (doc_type) WHERE active;

CREATE TABLE approval_requests (
  id               bigserial PRIMARY KEY,
  doc_kind         text NOT NULL CHECK (doc_kind IN ('purchase_order', 'inv_doc', 'payment', 'opening_payable', 'expense_claim')),
  doc_id           bigint NOT NULL,
  doc_type         text NOT NULL CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake')),
  doc_no           text NOT NULL,
  amount_cents     bigint,
  department_id    bigint REFERENCES departments (id),
  rule_id          bigint REFERENCES approval_rules (id),
  rule_version     integer,
  steps            jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 3),
  allow_self       boolean NOT NULL,
  current_level    integer NOT NULL DEFAULT 1 CHECK (current_level >= 1),
  level_started_at timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'returned', 'cancelled')),
  submitted_by     bigint NOT NULL REFERENCES staff (id),
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  finished_by      bigint REFERENCES staff (id),
  CONSTRAINT approval_requests_level CHECK (current_level <= jsonb_array_length(steps)),
  CONSTRAINT approval_requests_finished CHECK ((status = 'pending') = (finished_at IS NULL))
);
-- 同一单据同时只有一张在审的审批单
CREATE UNIQUE INDEX approval_requests_open ON approval_requests (doc_kind, doc_id) WHERE status = 'pending';
CREATE INDEX approval_requests_doc_idx ON approval_requests (doc_kind, doc_id);
CREATE INDEX approval_requests_pending_idx ON approval_requests (status, doc_type) WHERE status = 'pending';

CREATE TABLE approval_actions (
  id           bigserial PRIMARY KEY,
  request_id   bigint NOT NULL REFERENCES approval_requests (id),
  level        integer NOT NULL CHECK (level >= 1),
  action       text NOT NULL CHECK (action IN ('approve', 'return')),
  actor_id     bigint NOT NULL REFERENCES staff (id),
  on_behalf_of bigint REFERENCES staff (id),
  comment      text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 200),
  batch        boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (action <> 'return' OR char_length(btrim(comment)) >= 2),
  CHECK (on_behalf_of IS NULL OR on_behalf_of <> actor_id)
);
CREATE INDEX approval_actions_request_idx ON approval_actions (request_id, level);
CREATE TRIGGER approval_actions_append_only BEFORE UPDATE OR DELETE ON approval_actions
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE approval_delegations (
  id          bigserial PRIMARY KEY,
  staff_id    bigint NOT NULL REFERENCES staff (id),
  delegate_id bigint NOT NULL REFERENCES staff (id),
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  reason      text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 60),
  client_key  uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  bigint REFERENCES staff (id),
  revoked_at  timestamptz,
  CHECK (staff_id <> delegate_id),
  CHECK (ends_on >= starts_on AND ends_on - starts_on <= 30),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX approval_delegations_delegate_idx ON approval_delegations (delegate_id) WHERE revoked_at IS NULL;

-- ───────────── 迁移时已在「待确认」的单据：各补一张审批单（默认规则：一级负责人），单据状态不动 ─────────────
INSERT INTO approval_requests (doc_kind, doc_id, doc_type, doc_no, amount_cents, steps, allow_self, submitted_by, submitted_at, level_started_at)
SELECT 'purchase_order', p.id, 'purchase_order', p.doc_no, p.total_cents, '[{"group":"manager","mode":"any"}]'::jsonb, true,
       coalesce(p.submitted_by, p.created_by), coalesce(p.submitted_at, p.updated_at), coalesce(p.submitted_at, p.updated_at)
FROM purchase_orders p WHERE p.status = 'submitted';

INSERT INTO approval_requests (doc_kind, doc_id, doc_type, doc_no, amount_cents, department_id, steps, allow_self, submitted_by, submitted_at, level_started_at)
SELECT 'inv_doc', d.id,
       CASE d.doc_type WHEN 'count' THEN 'stocktake' ELSE d.doc_type END,
       d.doc_no, NULL, w.department_id, '[{"group":"manager","mode":"any"}]'::jsonb, true,
       coalesce(d.submitted_by, d.created_by), coalesce(d.submitted_at, d.updated_at), coalesce(d.submitted_at, d.updated_at)
FROM inv_docs d LEFT JOIN warehouses w ON w.id = d.warehouse_id
WHERE d.status = 'submitted' AND d.doc_type IN ('damage', 'supplier_return', 'opening', 'count') AND NOT d.urgent;

INSERT INTO approval_requests (doc_kind, doc_id, doc_type, doc_no, amount_cents, steps, allow_self, submitted_by, submitted_at, level_started_at)
SELECT 'payment', p.id, 'payment', p.doc_no, p.amount_cents, '[{"group":"manager","mode":"any"}]'::jsonb, true, p.created_by, p.created_at, p.created_at
FROM payments p WHERE p.status = 'submitted';

INSERT INTO approval_requests (doc_kind, doc_id, doc_type, doc_no, amount_cents, steps, allow_self, submitted_by, submitted_at, level_started_at)
SELECT 'opening_payable', o.id, 'opening', o.doc_no, o.amount_cents, '[{"group":"manager","mode":"any"}]'::jsonb, true, o.created_by, o.created_at, o.created_at
FROM opening_payables o WHERE o.status = 'submitted';

INSERT INTO approval_requests (doc_kind, doc_id, doc_type, doc_no, amount_cents, department_id, steps, allow_self, submitted_by, submitted_at, level_started_at)
SELECT 'expense_claim', c.id, 'expense_claim', c.doc_no, c.amount_cents, c.department_id, '[{"group":"manager","mode":"any"}]'::jsonb, true, c.created_by, c.created_at, c.created_at
FROM expense_claims c WHERE c.status = 'submitted';
