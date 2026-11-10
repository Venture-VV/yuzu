-- 8.0.7 供应链收尾 2.6（docs/ERP_V807.md）：供应商在线对账确认。
-- 对账登记（月结或按批次）以后可以生成「对账确认链接」（有效 N 天，V10，默认 14 天）发给供应商；
-- 供应商打开（不用登录）看这一期的对账单（生成链接时的快照），点「确认无误」或「有异议」（写原因、留姓名），只能回一次。
-- 链接只存摘要（token 的 SHA-256），原文只在生成时给一次；能作废、重发（重发时上一条没回的自动作废）。
-- 只追加：回复、作废各只能写一次；对账登记撤销以后链接一起失效（页面上看不到、不能回）。

CREATE TABLE recon_links (
  id                bigserial PRIMARY KEY,
  reconciliation_id bigint NOT NULL REFERENCES supplier_reconciliations (id),
  token_hash        text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  snapshot          jsonb NOT NULL,
  expires_at        timestamptz NOT NULL,
  created_by        bigint NOT NULL REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  voided_by         bigint REFERENCES staff (id),
  voided_at         timestamptz,
  -- 供应商的回复
  reply             text CHECK (reply IN ('confirmed', 'disputed')),
  reply_name        text CHECK (char_length(btrim(reply_name)) BETWEEN 1 AND 20),
  reply_note        text NOT NULL DEFAULT '' CHECK (char_length(reply_note) <= 300),
  replied_at        timestamptz,
  reply_ip          text,
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK ((reply IS NULL) = (replied_at IS NULL) AND (reply IS NULL) = (reply_name IS NULL)),
  CHECK (reply IS DISTINCT FROM 'disputed' OR char_length(btrim(reply_note)) >= 2)
);
CREATE INDEX recon_links_recon_idx ON recon_links (reconciliation_id, id);

CREATE FUNCTION yuzu_recon_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '对账确认链接不能删除，只能作废' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.reconciliation_id, NEW.token_hash, NEW.snapshot, NEW.expires_at, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.reconciliation_id, OLD.token_hash, OLD.snapshot, OLD.expires_at, OLD.created_by, OLD.created_at)
     OR (OLD.voided_at IS NOT NULL AND (NEW.voided_at, NEW.voided_by) IS DISTINCT FROM (OLD.voided_at, OLD.voided_by))
     OR (OLD.replied_at IS NOT NULL AND (NEW.reply, NEW.reply_name, NEW.reply_note, NEW.replied_at, NEW.reply_ip)
                                         IS DISTINCT FROM (OLD.reply, OLD.reply_name, OLD.reply_note, OLD.replied_at, OLD.reply_ip)) THEN
    RAISE EXCEPTION '对账确认链接只能作废一次、回复一次，别的不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recon_links_guard BEFORE UPDATE OR DELETE ON recon_links
  FOR EACH ROW EXECUTE FUNCTION yuzu_recon_link_guard();
