-- v0.7.29 ERP 采购五项⑤（主线）：询价比价与定标（E5–E8，设计见 docs/ERP_PURCHASING.md 第 6 节）。
--   · 询价单：标题、要货日期、物料与数量（采购单位，建好不改），状态 询价中 → 已定标（可撤销定标回到询价中）/ 已撤销；
--   · 报价：每家供应商一份，每行含税单价、运费、付款条件与账期、交货天数、有效期；同一张询价单一家供应商只有一份有效报价，
--     询价中可以撤下（写原因）重报；货款合计与综合到价（货款 + 运费）在登记时算好；
--   · 定标：选一份有效报价并写理由；有效报价不够规则要求的家数时标「单一来源」、由负责人定标（接口里核对权限）；
--   · 采购单记来自哪张询价单：同一张询价单同时只有一张没撤回的采购单（唯一索引兜底）；
--     合计到询价门槛的采购单第一次提交时要来自已定标的询价单（接口里核对，QUOTES_REQUIRED）。
-- 只加表与采购单的一列；不改已有的行。

CREATE TABLE sourcing_events (
  id               bigserial PRIMARY KEY,
  doc_no           text NOT NULL UNIQUE,
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awarded', 'cancelled')),
  need_by          date,
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  awarded_quote_id bigint,
  award_reason     text CHECK (award_reason IS NULL OR char_length(award_reason) BETWEEN 2 AND 200),
  single_source    boolean NOT NULL DEFAULT false,
  awarded_by       bigint REFERENCES staff(id),
  awarded_at       timestamptz,
  cancel_reason    text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 2 AND 200),
  -- 页面带操作编号：同一编号、同样的内容重提返回原询价单，内容不同拒绝（只用自己的列，不动共用的幂等表）
  client_key       uuid NOT NULL UNIQUE,
  request_hash     text NOT NULL,
  created_by       bigint NOT NULL REFERENCES staff(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  is_synthetic     boolean NOT NULL DEFAULT false,
  CONSTRAINT sourcing_events_award CHECK (
    (status = 'awarded') = (awarded_quote_id IS NOT NULL)
    AND (status <> 'awarded' OR (award_reason IS NOT NULL AND awarded_by IS NOT NULL AND awarded_at IS NOT NULL))
  ),
  CONSTRAINT sourcing_events_cancel CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);

CREATE TABLE sourcing_lines (
  id                 bigserial PRIMARY KEY,
  event_id           bigint NOT NULL REFERENCES sourcing_events(id),
  line_no            integer NOT NULL CHECK (line_no >= 1),
  material_id        bigint NOT NULL REFERENCES materials(id),
  purchase_qty_milli bigint NOT NULL CHECK (purchase_qty_milli > 0),
  purchase_unit      text NOT NULL,
  factor_milli       bigint NOT NULL CHECK (factor_milli > 0),
  base_qty_milli     bigint NOT NULL CHECK (base_qty_milli > 0),
  spec               text NOT NULL DEFAULT '' CHECK (char_length(spec) <= 80),
  UNIQUE (event_id, line_no),
  UNIQUE (event_id, material_id)
);

CREATE TABLE sourcing_quotes (
  id              bigserial PRIMARY KEY,
  event_id        bigint NOT NULL REFERENCES sourcing_events(id),
  supplier_id     bigint NOT NULL REFERENCES suppliers(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  goods_cents     bigint NOT NULL CHECK (goods_cents >= 0),
  freight_cents   bigint NOT NULL DEFAULT 0 CHECK (freight_cents BETWEEN 0 AND 100000000),
  pay_terms       text NOT NULL CHECK (char_length(pay_terms) BETWEEN 1 AND 30),
  credit_days     integer NOT NULL DEFAULT 0 CHECK (credit_days BETWEEN 0 AND 365),
  delivery_days   integer CHECK (delivery_days IS NULL OR delivery_days BETWEEN 0 AND 365),
  valid_until     date,
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  withdraw_reason text CHECK (withdraw_reason IS NULL OR char_length(withdraw_reason) BETWEEN 2 AND 200),
  withdrawn_by    bigint REFERENCES staff(id),
  withdrawn_at    timestamptz,
  client_key      uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  created_by      bigint NOT NULL REFERENCES staff(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sourcing_quotes_withdrawn CHECK ((status = 'withdrawn') = (withdraw_reason IS NOT NULL))
);
-- 同一张询价单一家供应商只有一份有效报价
CREATE UNIQUE INDEX sourcing_quotes_one_active ON sourcing_quotes (event_id, supplier_id) WHERE status = 'active';

CREATE TABLE sourcing_quote_lines (
  quote_id         bigint NOT NULL REFERENCES sourcing_quotes(id),
  sourcing_line_id bigint NOT NULL REFERENCES sourcing_lines(id),
  price_cents      bigint NOT NULL CHECK (price_cents BETWEEN 0 AND 100000000),
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (quote_id, sourcing_line_id)
);

ALTER TABLE sourcing_events
  ADD CONSTRAINT sourcing_events_awarded_quote_fkey FOREIGN KEY (awarded_quote_id) REFERENCES sourcing_quotes(id);

ALTER TABLE purchase_orders ADD COLUMN sourcing_event_id bigint REFERENCES sourcing_events(id);
-- 同一张询价单同时只有一张没撤回的采购单
CREATE UNIQUE INDEX purchase_orders_sourcing_once ON purchase_orders (sourcing_event_id)
  WHERE sourcing_event_id IS NOT NULL AND status <> 'cancelled';
