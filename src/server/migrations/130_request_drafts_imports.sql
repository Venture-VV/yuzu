-- 供应链二次整改（docs/ERP_ROUND2.md，店主 2026-11-11）：
--   · 03 草稿箱：erp_drafts（这次只接需求单；按「哪一类单据」留了字段，别的单据以后接同一张表）；
--   · 02 部门表格导入：导入记录分集采（bulk）与部门（dept），「同一份文件只能导入一次」只管集采；需求单的来源加「部门表格导入」（sheet）；
--   · 01 集采模板最终版：导入记录记下没导入的行数（表里标了线下已下单的）。
-- 只加表、加列、放宽约束；不动操作编号与「确认作废」的两条约束（部门表格导入的操作编号用「部门需求单」）。
-- 旧数据：已有的导入记录都是集采（bulk），没有跳过的行。

-- ───────────── 草稿：不是单据，能改能删；只有本人看得到 ─────────────
CREATE TABLE erp_drafts (
  id            bigserial PRIMARY KEY,
  -- 草稿编号：页面生成，继续填写、刷新都用它
  key           uuid NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('purchase_request')),
  staff_id      bigint NOT NULL REFERENCES staff (id),
  -- 修改已有单据的草稿：那张单据（需求单的 id）；新提的为空
  ref_id        bigint,
  -- 页面上填到哪算哪（不按提交的规则核对，只限长度与行数）
  payload       jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- 草稿里用到的图片（看图片的权限按它核对）
  image_ids     bigint[] NOT NULL DEFAULT '{}',
  -- 草稿箱里显示的摘要：前几行的名称、行数
  title         text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  line_count    integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  -- 版本号：别处存过以后这边再存对不上、拒绝；最后一次保存的编号：没收到回复再发一次的同一次保存只算一次
  rev           integer NOT NULL DEFAULT 1 CHECK (rev >= 1),
  last_save_id  uuid NOT NULL,
  -- 关闭（提交成需求单、手动删除、单据已结束）：先留着挡住迟到的保存请求，第二天由自动任务清掉
  closed_at     timestamptz,
  closed_reason text CHECK (closed_reason IN ('submitted', 'deleted', 'obsolete')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
);
CREATE INDEX erp_drafts_staff_idx ON erp_drafts (staff_id, kind, updated_at DESC) WHERE closed_at IS NULL;
-- 修改同一张单据的草稿一人一份
CREATE UNIQUE INDEX erp_drafts_ref_uq ON erp_drafts (staff_id, kind, ref_id) WHERE ref_id IS NOT NULL AND closed_at IS NULL;
-- 过期清理按最后一次保存的时间
CREATE INDEX erp_drafts_updated_idx ON erp_drafts (updated_at);

-- ───────────── 导入记录：集采（bulk）与部门表格导入（dept） ─────────────
ALTER TABLE purchase_request_imports
  ADD COLUMN kind          text NOT NULL DEFAULT 'bulk' CHECK (kind IN ('bulk', 'dept')),
  ADD COLUMN skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0);
-- 同一份文件只能导入一次：只管集采；部门的常规补货可以再用同一份表（页面上要确认）
ALTER TABLE purchase_request_imports DROP CONSTRAINT purchase_request_imports_file_sha256_key;
CREATE UNIQUE INDEX purchase_request_imports_bulk_sha_uq ON purchase_request_imports (file_sha256) WHERE kind = 'bulk';
CREATE INDEX purchase_request_imports_sha_idx ON purchase_request_imports (file_sha256, id);

-- ───────────── 需求单的来源加「部门表格导入」 ─────────────
ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_source_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_source_check CHECK (source IN ('form', 'import', 'sheet'));
ALTER TABLE purchase_requests DROP CONSTRAINT purchase_requests_source_import;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_source_import CHECK ((source IN ('import', 'sheet')) = (import_id IS NOT NULL));
