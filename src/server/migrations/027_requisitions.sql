-- 飞书需求 RQ-005「采购与费用闭环」第二步（v0.7.8，见 docs/REQUISITIONS.md）：
--   ① 部门采购需求单（XQ）：新职责「部门申购」，员工档案加所属部门；采购审核后转采购单，下单 / 到货 / 退货由采购单与收货单算出。
--   ② 图片：压缩后的图片存在数据库里（只追加），需求单的行、采购单的行都能挂图。
--   ③ 采购单的行加规格，记着来自哪几行需求（几个部门要同一种物料时合并成一行下单）。
-- 只加表、列与约束，不改已有数据。

-- ───────────── 职责：部门申购；员工的所属部门 ─────────────
ALTER TABLE staff DROP CONSTRAINT staff_duties_check;
ALTER TABLE staff ADD CONSTRAINT staff_duties_check
  CHECK (duties <@ ARRAY['stock', 'purchase', 'payable', 'approve', 'cost', 'request']::text[]);
ALTER TABLE staff ADD COLUMN department_id bigint REFERENCES departments (id);

-- ───────────── 图片 ─────────────
CREATE TABLE erp_images (
  id          bigserial PRIMARY KEY,
  -- 内容摘要：同一张图只存一份
  sha256      text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data        bytea NOT NULL,
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(data) = size_bytes)
);
CREATE TRIGGER erp_images_append_only BEFORE UPDATE OR DELETE ON erp_images
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 部门采购需求单 ─────────────
CREATE TABLE purchase_requests (
  id              bigserial PRIMARY KEY,
  doc_no          text NOT NULL UNIQUE,
  department_id   bigint NOT NULL REFERENCES departments (id),
  requester_id    bigint NOT NULL REFERENCES staff (id),
  need_by         date,
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  -- submitted 待审核；returned 退回待修改；approved 已通过（可以转采购单）；rejected 不采购；cancelled 已撤回
  status          text NOT NULL CHECK (status IN ('submitted', 'returned', 'approved', 'rejected', 'cancelled')),
  client_key      uuid UNIQUE,
  is_synthetic    boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_by     bigint REFERENCES staff (id),
  reviewed_at     timestamptz,
  -- 退回、不采购、撤回的原因
  reason          text,
  CHECK (status NOT IN ('approved', 'rejected') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX purchase_requests_dept_idx ON purchase_requests (department_id, created_at);
CREATE INDEX purchase_requests_status_idx ON purchase_requests (status);

CREATE TABLE purchase_request_lines (
  id            bigserial PRIMARY KEY,
  request_id    bigint NOT NULL REFERENCES purchase_requests (id),
  line_no       integer NOT NULL,
  -- 已有物料就选物料；新产品写名称（必须有参考链接和图片）
  material_id   bigint REFERENCES materials (id),
  name          text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  purpose       text NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 1 AND 20),
  qty_milli     bigint NOT NULL CHECK (qty_milli > 0),
  unit          text NOT NULL CHECK (char_length(btrim(unit)) BETWEEN 1 AND 8),
  link          text NOT NULL DEFAULT '' CHECK (char_length(link) <= 500),
  details       text NOT NULL DEFAULT '' CHECK (char_length(details) <= 200),
  ref_price_cents bigint CHECK (ref_price_cents >= 0),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  UNIQUE (request_id, line_no)
);
CREATE INDEX purchase_request_lines_material_idx ON purchase_request_lines (material_id);

CREATE TABLE purchase_request_line_images (
  request_line_id bigint NOT NULL REFERENCES purchase_request_lines (id),
  sort_no         integer NOT NULL CHECK (sort_no BETWEEN 1 AND 9),
  image_id        bigint NOT NULL REFERENCES erp_images (id),
  PRIMARY KEY (request_line_id, sort_no)
);

-- 需求单通过、不采购或撤回之后，行与图片不能再改（提交前与退回后可以整单改）
CREATE FUNCTION yuzu_request_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rid bigint;
  st  text;
BEGIN
  IF TG_TABLE_NAME = 'purchase_request_lines' THEN
    rid := CASE WHEN TG_OP = 'INSERT' THEN NEW.request_id ELSE OLD.request_id END;
  ELSE
    SELECT request_id INTO rid FROM purchase_request_lines
    WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.request_line_id ELSE OLD.request_line_id END;
  END IF;
  SELECT status INTO st FROM purchase_requests WHERE id = rid;
  IF st NOT IN ('submitted', 'returned') THEN
    RAISE EXCEPTION '需求单已%，明细不能再改', CASE st WHEN 'approved' THEN '通过' WHEN 'rejected' THEN '定为不采购' ELSE '撤回' END
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER purchase_request_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_request_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_request_line_guard();
CREATE TRIGGER purchase_request_line_images_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_request_line_images
  FOR EACH ROW EXECUTE FUNCTION yuzu_request_line_guard();

-- 需求单不能删除；通过、不采购、撤回是终态（通过之后只能由采购单回写进度，不改需求单）
CREATE FUNCTION yuzu_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '需求单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('approved', 'rejected', 'cancelled') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION '需求单已结束审核，不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.doc_no, NEW.department_id, NEW.requester_id, NEW.created_at, NEW.client_key)
     IS DISTINCT FROM (OLD.doc_no, OLD.department_id, OLD.requester_id, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '需求单的单号、部门、提单人不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_requests_guard BEFORE UPDATE OR DELETE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION yuzu_request_guard();

-- ───────────── 采购单的行：规格、图片、来自哪几行需求 ─────────────
ALTER TABLE purchase_order_lines ADD COLUMN spec text NOT NULL DEFAULT '' CHECK (char_length(spec) <= 80);

CREATE TABLE purchase_order_line_images (
  po_line_id bigint NOT NULL REFERENCES purchase_order_lines (id) ON DELETE CASCADE,
  sort_no    integer NOT NULL CHECK (sort_no BETWEEN 1 AND 9),
  image_id   bigint NOT NULL REFERENCES erp_images (id),
  PRIMARY KEY (po_line_id, sort_no)
);

-- 采购单的一行可以合并几行需求（几个部门要同一种物料）；一行需求最多对应一行有效的采购单行
-- （撤回的采购单不算；转采购单时锁需求单再核对，自检兜底）
CREATE TABLE purchase_order_line_requests (
  po_line_id      bigint NOT NULL REFERENCES purchase_order_lines (id) ON DELETE CASCADE,
  request_line_id bigint NOT NULL REFERENCES purchase_request_lines (id),
  PRIMARY KEY (po_line_id, request_line_id)
);
CREATE INDEX purchase_order_line_requests_request_idx ON purchase_order_line_requests (request_line_id);

-- 图片与需求关联跟采购单明细一样：采购单确认、关闭、撤回之后不能再改（改版时先回到待确认）
CREATE FUNCTION yuzu_po_line_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id
             WHERE pl.id IN (CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.po_line_id END,
                             CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.po_line_id END)
               AND po.status IN ('approved', 'closed', 'cancelled')) THEN
    RAISE EXCEPTION '采购单当前状态不能修改明细' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER purchase_order_line_images_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_line_images
  FOR EACH ROW EXECUTE FUNCTION yuzu_po_line_child_guard();
CREATE TRIGGER purchase_order_line_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_line_requests
  FOR EACH ROW EXECUTE FUNCTION yuzu_po_line_child_guard();

-- ───────────── 审批记录、作废登记、幂等：需求单 ─────────────
ALTER TABLE approval_logs DROP CONSTRAINT approval_logs_doc_kind_check;
ALTER TABLE approval_logs ADD CONSTRAINT approval_logs_doc_kind_check
  CHECK (doc_kind IN ('inv_doc', 'purchase_order', 'payment', 'opening_payable', 'expense_claim', 'petty_advance', 'petty_settlement',
                      'purchase_request'));

-- 「确认作废」也用于费用报销、备用金打款与退回补付、需求单（v0.7.8 修正：页面断网后先作废原编号，原请求晚到也不会登记）
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request'));

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request'));
