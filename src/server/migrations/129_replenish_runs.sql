-- 8.0.20 自动补货（docs/ERP_V8020.md 第 3 节，JX-D / JX5 / JX10）：每天过了设定的时间，把「补货建议」里有供应商的行
-- 按供应商各建一张采购单草稿（不提交）。这张表一天一行：当天跑没跑过、建了哪几张草稿、有几样缺供应商。
-- 草稿算在途，第二天不会重复建议；规则存在 settings 的 auto_replenish（开关默认开、时间默认 05:30）。

CREATE TABLE replenish_runs (
  run_date            date PRIMARY KEY,
  status              text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  po_ids              bigint[] NOT NULL DEFAULT '{}',
  line_count          integer NOT NULL DEFAULT 0,
  -- 建议里没有供应商（物料没设默认供应商、也没收过货）的行数：要人先选供应商
  skipped_no_supplier integer NOT NULL DEFAULT 0,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
