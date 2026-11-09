-- 8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）：
--   · 第 9.1 节 买一赠一券：券模板加种类 bogo——买的项目 buy_item_id，赠的项目沿用 exchange_item_id；
--     可选的赠品出库设置（物料、每份出库数量、出哪个仓）；发过券以后「买的项目」与其他条件一样不能改（守护触发器）；
--   · 第 6 节 批量发券：发券单 coupon_campaigns 与圈到的会员 coupon_campaign_members；发券记录加种类「批量发券」与 campaign_id；
--     会员端提醒 member_notices（到账、到期前 N 天）；短信待发箱 sms_outbox；
--   · 第 9.1 节 赠品出库 coupon_gift_outs：用了买一赠一券的结账单记一条，自动任务按它开库存的直接耗用单；
--   · 第 10 节 营销成本的测算单价 marketing_cost_params（服务类权益每次按多少钱测算；只给测算页用，不进任何账）。

-- ───────────────────────── 买一赠一券 ─────────────────────────

ALTER TABLE coupon_templates
  ADD COLUMN buy_item_id       bigint REFERENCES service_items (id),
  ADD COLUMN gift_material_id  bigint REFERENCES materials (id),
  ADD COLUMN gift_qty_milli    bigint CHECK (gift_qty_milli > 0 AND gift_qty_milli <= 1000000000),
  ADD COLUMN gift_warehouse_id bigint REFERENCES warehouses (id);

ALTER TABLE coupon_templates DROP CONSTRAINT coupon_templates_kind_check;
ALTER TABLE coupon_templates ADD CONSTRAINT coupon_templates_kind_check CHECK (kind IN ('cash', 'discount', 'exchange', 'bogo'));
-- 兑换券：一个项目或一个票种；买一赠一：赠的项目（exchange_item_id），不能是票种
ALTER TABLE coupon_templates DROP CONSTRAINT coupon_templates_check3;
ALTER TABLE coupon_templates ADD CONSTRAINT coupon_templates_exchange_target_check
  CHECK ((kind IN ('exchange', 'bogo')) = (num_nonnulls(exchange_item_id, exchange_ticket_type_id) = 1));
ALTER TABLE coupon_templates ADD CONSTRAINT coupon_templates_bogo_check
  CHECK ((kind = 'bogo') = (buy_item_id IS NOT NULL)
         AND (kind <> 'bogo' OR (exchange_item_id IS NOT NULL AND exchange_ticket_type_id IS NULL AND scope = 'all' AND threshold = 0)));
-- 赠品出库：三项一起填或都不填，只有买一赠一券能填
ALTER TABLE coupon_templates ADD CONSTRAINT coupon_templates_gift_out_check
  CHECK (num_nonnulls(gift_material_id, gift_qty_milli, gift_warehouse_id) IN (0, 3) AND (kind = 'bogo' OR gift_material_id IS NULL));

CREATE OR REPLACE FUNCTION yuzu_coupon_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '券模板不能删除，请停用' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.created_by, NEW.created_at, NEW.client_key) IS DISTINCT FROM (OLD.id, OLD.created_by, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '券模板的建档信息不能改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.kind, NEW.face_value, NEW.rate_percent, NEW.max_off, NEW.threshold, NEW.scope, NEW.scope_categories, NEW.scope_items,
      NEW.exchange_item_id, NEW.exchange_ticket_type_id, NEW.validity, NEW.valid_from, NEW.valid_to, NEW.valid_days, NEW.levels, NEW.buy_item_id)
     IS DISTINCT FROM
     (OLD.kind, OLD.face_value, OLD.rate_percent, OLD.max_off, OLD.threshold, OLD.scope, OLD.scope_categories, OLD.scope_items,
      OLD.exchange_item_id, OLD.exchange_ticket_type_id, OLD.validity, OLD.valid_from, OLD.valid_to, OLD.valid_days, OLD.levels, OLD.buy_item_id)
     AND EXISTS (SELECT 1 FROM coupons WHERE template_id = OLD.id) THEN
    RAISE EXCEPTION '这个模板已经发过券，面额、折扣、门槛、范围、有效期不能改，请另建模板' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- ───────────────────────── 批量发券 ─────────────────────────

CREATE TABLE coupon_campaigns (
  id            bigserial PRIMARY KEY,
  campaign_no   text NOT NULL UNIQUE CHECK (char_length(campaign_no) BETWEEN 1 AND 32),
  template_id   bigint NOT NULL REFERENCES coupon_templates (id),
  -- 每人几张
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  -- 圈选条件（发券当时的）：{"grades": [..], "tagIds": [..], "tagNames": [..]}
  audience      jsonb NOT NULL CHECK (jsonb_typeof(audience) = 'object'),
  reason        text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  notify_sms    boolean NOT NULL,
  notify_popup  boolean NOT NULL,
  -- 会员端弹窗：到期前几天再提醒一次
  remind_days   integer CHECK (remind_days BETWEEN 1 AND 30),
  status        text NOT NULL CHECK (status IN ('issuing', 'done')),
  targeted      integer NOT NULL CHECK (targeted BETWEEN 1 AND 2000),
  client_key    uuid NOT NULL UNIQUE,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  business_date date NOT NULL,
  finished_at   timestamptz,
  CHECK ((status = 'done') = (finished_at IS NOT NULL)),
  CHECK (notify_popup = (remind_days IS NOT NULL))
);

-- 圈到的会员（新建时按圈选条件定下来，之后按名单发；跳过的写原因）
CREATE TABLE coupon_campaign_members (
  campaign_id bigint NOT NULL REFERENCES coupon_campaigns (id),
  member_id   bigint NOT NULL REFERENCES members (id),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued', 'skipped')),
  issue_id    bigint REFERENCES coupon_issues (id),
  skip_reason text CHECK (char_length(skip_reason) <= 200),
  PRIMARY KEY (campaign_id, member_id),
  CHECK ((status = 'issued') = (issue_id IS NOT NULL)),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
);
CREATE INDEX coupon_campaign_members_pending_idx ON coupon_campaign_members (campaign_id, member_id) WHERE status = 'pending';

ALTER TABLE coupon_issues ADD COLUMN campaign_id bigint REFERENCES coupon_campaigns (id);
ALTER TABLE coupon_issues DROP CONSTRAINT coupon_issues_kind_check;
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_kind_check
  CHECK (kind IN ('manual', 'batch', 'open_card', 'level_up', 'birthday', 'recharge', 'benefit', 'mp_claim', 'campaign'));
ALTER TABLE coupon_issues DROP CONSTRAINT coupon_issues_rule_check;
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_rule_check
  CHECK ((kind IN ('manual', 'batch', 'benefit', 'mp_claim', 'campaign')) = (rule_id IS NULL));
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_campaign_check
  CHECK ((kind = 'campaign') = (campaign_id IS NOT NULL)
         AND (kind <> 'campaign' OR (member_id IS NOT NULL AND issued_by IS NOT NULL AND dedupe_key LIKE 'campaign:%')));
CREATE INDEX coupon_issues_campaign_idx ON coupon_issues (campaign_id) WHERE campaign_id IS NOT NULL;

-- ───────────────────────── 会员端提醒（小程序弹窗） ─────────────────────────

CREATE TABLE member_notices (
  id          bigserial PRIMARY KEY,
  member_id   bigint NOT NULL REFERENCES members (id),
  -- 到账（您收到 N 张券）、快到期（您的券 N 天后到期）
  kind        text NOT NULL CHECK (kind IN ('coupon_issued', 'coupon_expiring')),
  title       text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 40),
  body        text NOT NULL CHECK (char_length(body) <= 200),
  campaign_id bigint REFERENCES coupon_campaigns (id),
  issue_id    bigint REFERENCES coupon_issues (id),
  -- 哪几天弹（营业日，含两头）
  show_from   date NOT NULL,
  show_until  date NOT NULL,
  dedupe_key  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- 会员在会员端看过（只记一次）
  read_at     timestamptz,
  CHECK (show_from <= show_until)
);
CREATE INDEX member_notices_member_idx ON member_notices (member_id, show_until);

-- ───────────────────────── 短信待发箱 ─────────────────────────

CREATE TABLE sms_outbox (
  id           bigserial PRIMARY KEY,
  member_id    bigint REFERENCES members (id),
  phone        text NOT NULL CHECK (phone ~ '^1[0-9]{10}$'),
  purpose      text NOT NULL CHECK (purpose IN ('coupon_issued')),
  -- 短信模板的变量（阿里云模板参数）与按变量拼好的全文（页面显示、导出手动发用）
  params       jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  content      text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 300),
  campaign_id  bigint REFERENCES coupon_campaigns (id),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   text CHECK (char_length(last_error) <= 300),
  provider     text CHECK (char_length(provider) <= 32),
  provider_ref text CHECK (char_length(provider_ref) <= 64),
  dedupe_key   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX sms_outbox_pending_idx ON sms_outbox (id) WHERE status = 'pending';
CREATE INDEX sms_outbox_campaign_idx ON sms_outbox (campaign_id) WHERE campaign_id IS NOT NULL;

-- ───────────────────────── 买一赠一的赠品出库 ─────────────────────────

CREATE TABLE coupon_gift_outs (
  id            bigserial PRIMARY KEY,
  coupon_id     bigint NOT NULL REFERENCES coupons (id),
  checkout_id   bigint NOT NULL REFERENCES checkouts (id),
  template_id   bigint NOT NULL REFERENCES coupon_templates (id),
  item_id       bigint REFERENCES service_items (id),
  material_id   bigint NOT NULL REFERENCES materials (id),
  qty_milli     bigint NOT NULL CHECK (qty_milli > 0),
  warehouse_id  bigint NOT NULL REFERENCES warehouses (id),
  -- 待出库 → 已出库 / 出库失败（补完库存后重试）；反结账：待出库的取消，已出库的冲销（失败的记下来由仓库手工处理）
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'done', 'failed', 'cancelled', 'void_pending', 'voided', 'void_failed')),
  -- 开库存单用的操作编号（重试也用它，不会开出两张）
  client_key    uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  inv_doc_id    bigint REFERENCES inv_docs (id),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    text CHECK (char_length(last_error) <= 300),
  business_date date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coupon_id, checkout_id),
  CHECK (status NOT IN ('done', 'void_pending', 'voided', 'void_failed') OR inv_doc_id IS NOT NULL)
);
CREATE INDEX coupon_gift_outs_todo_idx ON coupon_gift_outs (id) WHERE status IN ('pending', 'void_pending');
CREATE INDEX coupon_gift_outs_checkout_idx ON coupon_gift_outs (checkout_id);

-- ───────────────────────── 营销成本的测算单价 ─────────────────────────

CREATE TABLE marketing_cost_params (
  benefit_id bigint PRIMARY KEY REFERENCES benefits (id),
  -- 服务类权益每登记一次按多少钱测算（分）
  unit_cost  bigint NOT NULL CHECK (unit_cost >= 0 AND unit_cost <= 100000000),
  updated_by bigint NOT NULL REFERENCES staff (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
