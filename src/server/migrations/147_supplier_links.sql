-- 8.0.21 供应商门户（docs/FINANCE_V8021.md 第 7 节，CW-F / CW6）：在对账确认链接（迁移 100）的做法上扩成三种——
-- 报价（开着的询价单）、订单确认（已确认的采购单）、发货预告（供应商已确认的采购单）。
-- 不开账号、凭链接，有效天数与对账链接同一项设置（默认 14 天），能作废、重发（重发时同种类没用过的旧链接自动作废）；
-- 链接只存摘要（token 的 SHA-256），原文只在生成时给一次。对账确认照旧用 recon_links，这里不搬。
-- 只追加：链接只能作废一次；回复、确认各写一行，不改不删。

CREATE TABLE supplier_links (
  id                bigserial PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('quote', 'po_confirm', 'delivery')),
  sourcing_event_id bigint REFERENCES sourcing_events (id),
  purchase_order_id bigint REFERENCES purchase_orders (id),
  supplier_id       bigint NOT NULL REFERENCES suppliers (id),
  token_hash        text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  snapshot          jsonb NOT NULL,
  expires_at        timestamptz NOT NULL,
  created_by        bigint NOT NULL REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  voided_by         bigint REFERENCES staff (id),
  voided_at         timestamptz,
  CHECK ((kind = 'quote') = (sourcing_event_id IS NOT NULL)),
  CHECK ((kind = 'quote') = (purchase_order_id IS NULL)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX supplier_links_event_idx ON supplier_links (sourcing_event_id, supplier_id, id) WHERE sourcing_event_id IS NOT NULL;
CREATE INDEX supplier_links_po_idx ON supplier_links (purchase_order_id, kind, id) WHERE purchase_order_id IS NOT NULL;

CREATE FUNCTION yuzu_supplier_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '供应商链接不能删除，只能作废' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.kind, NEW.sourcing_event_id, NEW.purchase_order_id, NEW.supplier_id, NEW.token_hash, NEW.snapshot, NEW.expires_at, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.kind, OLD.sourcing_event_id, OLD.purchase_order_id, OLD.supplier_id, OLD.token_hash, OLD.snapshot, OLD.expires_at, OLD.created_by, OLD.created_at)
     OR (OLD.voided_at IS NOT NULL AND (NEW.voided_at, NEW.voided_by) IS DISTINCT FROM (OLD.voided_at, OLD.voided_by)) THEN
    RAISE EXCEPTION '供应商链接只能作废一次，别的不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_links_guard BEFORE UPDATE OR DELETE ON supplier_links
  FOR EACH ROW EXECUTE FUNCTION yuzu_supplier_link_guard();

-- 供应商每回复一次记一行：报价、订单确认、发货预告各自的内容；client_key 是供应商页面生成的，没收到结果再点一次照样只记一次
CREATE TABLE supplier_link_replies (
  id           bigserial PRIMARY KEY,
  link_id      bigint NOT NULL REFERENCES supplier_links (id),
  client_key   uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  reply_name   text NOT NULL CHECK (char_length(btrim(reply_name)) BETWEEN 1 AND 20),
  content      jsonb NOT NULL,
  quote_id     bigint REFERENCES sourcing_quotes (id),
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_link_replies_link_idx ON supplier_link_replies (link_id, id);

-- 订单确认：一张采购单只认第一次确认（确认以后不再发确认链接；到货日有变的，供应商在发货预告里写预计到货日）
CREATE TABLE po_supplier_confirmations (
  id                bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL UNIQUE REFERENCES purchase_orders (id),
  link_id           bigint NOT NULL REFERENCES supplier_links (id),
  reply_id          bigint NOT NULL UNIQUE REFERENCES supplier_link_replies (id),
  promised_date     date NOT NULL,
  reply_name        text NOT NULL,
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION yuzu_supplier_reply_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '供应商的回复只追加，不能改、不能删' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER supplier_link_replies_guard BEFORE UPDATE OR DELETE ON supplier_link_replies
  FOR EACH ROW EXECUTE FUNCTION yuzu_supplier_reply_guard();
CREATE TRIGGER po_supplier_confirmations_guard BEFORE UPDATE OR DELETE ON po_supplier_confirmations
  FOR EACH ROW EXECUTE FUNCTION yuzu_supplier_reply_guard();

-- 报价从哪来：员工登记的为空；供应商在链接里报的记链接
ALTER TABLE sourcing_quotes ADD COLUMN via_link_id bigint REFERENCES supplier_links (id);
