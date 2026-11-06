-- v0.7.31 合同与法务审查（docs/CONTRACTS.md，默认 C1–C12 待确认）：合同台账与四要素、提交记录与法务审查清单的结论、
-- 版本、变更单、用印登记、扫描件；员工职责加「法务」；审批中心加三种单据（合同、合同变更、用印）；「确认作废」加三类。
-- 只加表、放宽约束，不改任何已有数据。

-- ───────────── 员工职责加「法务」（C4，单独一组） ─────────────
ALTER TABLE staff DROP CONSTRAINT staff_duties_check;
ALTER TABLE staff ADD CONSTRAINT staff_duties_check
  CHECK (duties <@ ARRAY['stock', 'purchase', 'payable', 'approve', 'cost', 'request', 'legal']::text[]);

-- ───────────── 合同 ─────────────
CREATE TABLE contracts (
  id                  bigserial PRIMARY KEY,
  contract_no         text NOT NULL UNIQUE,
  category            text NOT NULL CHECK (category IN ('purchase', 'service', 'lease', 'other')),
  supplier_id         bigint REFERENCES suppliers (id),
  counterparty        text NOT NULL CHECK (char_length(btrim(counterparty)) BETWEEN 1 AND 60),
  department_id       bigint REFERENCES departments (id),
  handler_id          bigint NOT NULL REFERENCES staff (id),
  -- 续签：新合同指向被续签的旧合同
  renewal_of          bigint REFERENCES contracts (id),
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'reviewing', 'returned', 'approved', 'signed', 'archived', 'terminated', 'voided')),
  -- 起草中、已退回时编辑的内容（标题、起止日、总价、税率、运费卸货、四要素、单价表、备注）；审批通过以后改走变更单
  draft               jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  -- 台账用的当前内容：没生效前取草稿，生效后取生效的那一版
  title               text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 60),
  start_date          date,
  end_date            date,
  total_cents         bigint NOT NULL CHECK (total_cents >= 0),
  -- 生效的那份提交记录与版本号（审批通过以后才有；变更单同意后换成新的一份、版本号加 1）
  current_revision_id bigint,
  current_version     integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  -- 改内容、改状态的乐观锁（两人同时改，后保存的被拒）
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- 签署登记
  signed_on           date,
  our_signatory       text CHECK (our_signatory IS NULL OR char_length(btrim(our_signatory)) BETWEEN 1 AND 20),
  their_signatory     text CHECK (their_signatory IS NULL OR char_length(btrim(their_signatory)) BETWEEN 1 AND 20),
  signed_by           bigint REFERENCES staff (id),
  signed_at           timestamptz,
  -- 归档
  archive_no          text UNIQUE,
  archive_location    text CHECK (archive_location IS NULL OR char_length(btrim(archive_location)) BETWEEN 1 AND 60),
  archived_by         bigint REFERENCES staff (id),
  archived_at         timestamptz,
  -- 作废（没签署的）、终止（签署以后的）
  closed_reason       text CHECK (closed_reason IS NULL OR char_length(btrim(closed_reason)) BETWEEN 2 AND 200),
  closed_on           date,
  closed_by           bigint REFERENCES staff (id),
  closed_at           timestamptz,
  client_key          uuid UNIQUE,
  request_hash        text,
  created_by          bigint NOT NULL REFERENCES staff (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- 采购合同的相对方从供应商档案里选（C1）
  CHECK (category <> 'purchase' OR supplier_id IS NOT NULL),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  CHECK (renewal_of IS NULL OR renewal_of <> id),
  -- 审批通过以后才有生效的一版
  CHECK ((status IN ('approved', 'signed', 'archived', 'terminated')) = (current_revision_id IS NOT NULL) OR status = 'voided'),
  CHECK ((status IN ('signed', 'archived')) <= (signed_on IS NOT NULL AND signed_at IS NOT NULL)),
  CHECK ((status = 'archived') <= (archive_no IS NOT NULL AND archived_at IS NOT NULL)),
  CHECK ((status IN ('terminated', 'voided')) = (closed_at IS NOT NULL)),
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
);
CREATE INDEX contracts_status_idx ON contracts (status);
CREATE INDEX contracts_supplier_idx ON contracts (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX contracts_renewal_idx ON contracts (renewal_of) WHERE renewal_of IS NOT NULL;
CREATE INDEX contracts_end_idx ON contracts (end_date) WHERE status IN ('signed', 'archived');

-- ───────────── 变更单（改价、改量、延期；C10） ─────────────
CREATE TABLE contract_changes (
  id              bigserial PRIMARY KEY,
  change_no       text NOT NULL UNIQUE,
  contract_id     bigint NOT NULL REFERENCES contracts (id),
  -- 在第几版上改
  base_version    integer NOT NULL CHECK (base_version >= 1),
  kinds           text[] NOT NULL CHECK (cardinality(kinds) >= 1 AND kinds <@ ARRAY['price', 'quantity', 'extension', 'other']::text[]),
  reason          text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  -- 改后的全部内容（与合同的草稿同一个格式）
  draft           jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  -- 改后与改前总价之差的绝对值（审批规则按它匹配）
  delta_cents     bigint NOT NULL CHECK (delta_cents >= 0),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewing', 'returned', 'approved', 'voided')),
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- 同意后合同的第几版
  result_version  integer CHECK (result_version IS NULL OR result_version >= 2),
  closed_reason   text CHECK (closed_reason IS NULL OR char_length(btrim(closed_reason)) BETWEEN 2 AND 200),
  closed_by       bigint REFERENCES staff (id),
  closed_at       timestamptz,
  client_key      uuid UNIQUE,
  request_hash    text,
  created_by      bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'approved') = (result_version IS NOT NULL)),
  CHECK ((status = 'voided') = (closed_at IS NOT NULL)),
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
);
-- 同一合同同时只有一张没结束的变更单
CREATE UNIQUE INDEX contract_changes_open ON contract_changes (contract_id) WHERE status IN ('draft', 'reviewing', 'returned');
CREATE INDEX contract_changes_contract_idx ON contract_changes (contract_id);

-- ───────────── 提交记录（每次提交审查存一份当时的内容；只追加） ─────────────
CREATE TABLE contract_revisions (
  id                  bigserial PRIMARY KEY,
  contract_id         bigint NOT NULL REFERENCES contracts (id),
  -- 变更单的提交记录记下是哪张变更单（合同本身的提交为空）
  change_id           bigint REFERENCES contract_changes (id),
  -- 这份合同的第几次提交（合同与变更单的提交一起排）
  seq                 integer NOT NULL CHECK (seq >= 1),
  -- 标题、起止日、总价、税率、运费卸货、付款节点、质保、验收标准、备注（单价表在 contract_lines）
  content             jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  approval_request_id bigint REFERENCES approval_requests (id),
  submitted_by        bigint NOT NULL REFERENCES staff (id),
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, seq)
);
CREATE INDEX contract_revisions_change_idx ON contract_revisions (change_id) WHERE change_id IS NOT NULL;
CREATE TRIGGER contract_revisions_append_only BEFORE UPDATE OR DELETE ON contract_revisions
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
ALTER TABLE contracts ADD CONSTRAINT contracts_current_revision_fk FOREIGN KEY (current_revision_id) REFERENCES contract_revisions (id);

-- 单价表（挂在提交记录上；只追加）
CREATE TABLE contract_lines (
  id           bigserial PRIMARY KEY,
  revision_id  bigint NOT NULL REFERENCES contract_revisions (id),
  line_no      integer NOT NULL CHECK (line_no >= 1),
  material_id  bigint REFERENCES materials (id),
  item_name    text NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 40),
  spec         text NOT NULL DEFAULT '' CHECK (char_length(spec) <= 80),
  unit         text NOT NULL CHECK (char_length(btrim(unit)) BETWEEN 1 AND 8),
  -- 含税单价（每个单位，整数分）、税率（万分比）
  price_cents  bigint NOT NULL CHECK (price_cents >= 0),
  tax_rate_bp  integer NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  -- 合同数量（千分之一单位；空 = 不限量）
  qty_milli    bigint CHECK (qty_milli IS NULL OR qty_milli > 0),
  UNIQUE (revision_id, line_no)
);
CREATE INDEX contract_lines_material_idx ON contract_lines (material_id) WHERE material_id IS NOT NULL;
CREATE TRIGGER contract_lines_append_only BEFORE UPDATE OR DELETE ON contract_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 版本：审批通过的提交记录（第 1 版是合同审批通过的那份，之后每张同意的变更单加一版；只追加）
CREATE TABLE contract_versions (
  id           bigserial PRIMARY KEY,
  contract_id  bigint NOT NULL REFERENCES contracts (id),
  version_no   integer NOT NULL CHECK (version_no >= 1),
  revision_id  bigint NOT NULL UNIQUE REFERENCES contract_revisions (id),
  change_id    bigint REFERENCES contract_changes (id),
  approved_by  bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, version_no),
  CHECK ((version_no = 1) = (change_id IS NULL))
);
CREATE TRIGGER contract_versions_append_only BEFORE UPDATE OR DELETE ON contract_versions
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 法务审查清单的结论（C3；法务那一级同意或退回时逐条给，挂在提交记录上；只追加）
CREATE TABLE contract_reviews (
  id                  bigserial PRIMARY KEY,
  revision_id         bigint NOT NULL REFERENCES contract_revisions (id),
  approval_request_id bigint NOT NULL REFERENCES approval_requests (id),
  level               integer NOT NULL CHECK (level >= 1),
  action              text NOT NULL CHECK (action IN ('approve', 'return')),
  -- [{ key, verdict: pass | revise | risk, note }]
  items               jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 20),
  reviewer_id         bigint NOT NULL REFERENCES staff (id),
  on_behalf_of        bigint REFERENCES staff (id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_reviews_revision_idx ON contract_reviews (revision_id);
CREATE TRIGGER contract_reviews_append_only BEFORE UPDATE OR DELETE ON contract_reviews
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 用印登记（C7；提交即走审批） ─────────────
CREATE TABLE contract_seals (
  id            bigserial PRIMARY KEY,
  seal_no       text NOT NULL UNIQUE,
  contract_id   bigint NOT NULL REFERENCES contracts (id),
  seal_type     text NOT NULL CHECK (seal_type IN ('company', 'contract', 'finance', 'legal_rep')),
  copies        integer NOT NULL CHECK (copies BETWEEN 1 AND 20),
  -- 用印人
  operator_id   bigint NOT NULL REFERENCES staff (id),
  seal_date     date NOT NULL,
  purpose       text NOT NULL DEFAULT '' CHECK (char_length(purpose) <= 100),
  status        text NOT NULL DEFAULT 'reviewing' CHECK (status IN ('reviewing', 'returned', 'approved', 'withdrawn')),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  client_key    uuid UNIQUE,
  request_hash  text,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_seals_contract_idx ON contract_seals (contract_id);

-- ───────────── 扫描件（按页拍照，图片沿用 erp_images；不删，传错的标记删掉） ─────────────
CREATE TABLE contract_files (
  id           bigserial PRIMARY KEY,
  contract_id  bigint NOT NULL REFERENCES contracts (id),
  image_id     bigint NOT NULL REFERENCES erp_images (id),
  sort_no      integer NOT NULL CHECK (sort_no >= 1),
  added_by     bigint NOT NULL REFERENCES staff (id),
  added_at     timestamptz NOT NULL DEFAULT now(),
  removed_by   bigint REFERENCES staff (id),
  removed_at   timestamptz,
  UNIQUE (contract_id, sort_no),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE OR REPLACE FUNCTION yuzu_contract_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '合同的扫描件不能删除，只能标记删掉'; END IF;
  IF NEW.contract_id <> OLD.contract_id OR NEW.image_id <> OLD.image_id OR NEW.sort_no <> OLD.sort_no
     OR NEW.added_by <> OLD.added_by OR NEW.added_at <> OLD.added_at OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION '合同的扫描件只能标记删掉一次';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_files_guard BEFORE UPDATE OR DELETE ON contract_files
  FOR EACH ROW EXECUTE FUNCTION yuzu_contract_file_guard();

-- ───────────── 审批中心：三种单据 ─────────────
ALTER TABLE approval_rules DROP CONSTRAINT approval_rules_doc_type_check;
ALTER TABLE approval_rules ADD CONSTRAINT approval_rules_doc_type_check
  CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake',
                      'contract', 'contract_change', 'contract_seal'));
ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_doc_kind_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_doc_kind_check
  CHECK (doc_kind IN ('purchase_order', 'inv_doc', 'payment', 'opening_payable', 'expense_claim', 'contract', 'contract_change', 'contract_seal'));
ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_doc_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_doc_type_check
  CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake',
                      'contract', 'contract_change', 'contract_seal'));

-- ───────────── 「确认作废」加三类：新建合同、变更单、用印申请（同 039、057、076） ─────────────
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial',
                     'member_refund', 'member_status', 'member_merge', 'booking_create', 'booking_change',
                     'count_card_sale', 'count_card_refund', 'platform_redemption', 'platform_settlement', 'doc_print', 'member_card',
                     'approval_rule', 'approval_delegation', 'contract_create', 'contract_change', 'contract_seal'));
