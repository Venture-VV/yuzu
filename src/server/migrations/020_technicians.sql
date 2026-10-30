-- v0.7.0 S6 技师第一步（ROADMAP 第 10 节：先做技师名册和「挂技师项目时选技师」，钟房看板、轮钟排队、上下钟计时与提成在第二步）
--   · 技师名册：工号、名字、性别、等级（对应价目表的「标准 / 专业 / 优选」价格档）、可做的项目分类；不删除，离职的停用；
--   · 项目可标「需要技师」；挂这类项目时记下技师与点钟 / 轮钟（在明细上，随明细只追加，作废时一起作废）；
--   · 技师功能由后台开关控制（默认关闭），关闭时前台与升级前完全一样。
-- 只加表、加列，不改已有数据。

CREATE TABLE technicians (
  id           bigserial PRIMARY KEY,
  -- 工号：1–6 位数字或字母，例如 08、A12；保存后不变
  tech_no      text NOT NULL UNIQUE CHECK (tech_no ~ '^[0-9A-Za-z]{1,6}$'),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 16),
  gender       text NOT NULL CHECK (gender IN ('male', 'female')),
  grade        text NOT NULL CHECK (grade IN ('standard', 'professional', 'premium')),
  -- 可做的项目分类（与项目的分类同名）；空为全部需要技师的项目
  skills       text[] NOT NULL DEFAULT '{}',
  active       boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  is_synthetic boolean NOT NULL DEFAULT false,
  created_by   bigint REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE service_items ADD COLUMN technician_required boolean NOT NULL DEFAULT false;

-- 明细上的技师与上钟方式：designated 点钟（客人点名）/ rotation 轮钟（按轮排）
ALTER TABLE bill_lines
  ADD COLUMN technician_id bigint REFERENCES technicians (id),
  ADD COLUMN call_type     text CHECK (call_type IN ('designated', 'rotation')),
  ADD CONSTRAINT bill_lines_technician_check CHECK ((technician_id IS NULL) = (call_type IS NULL));
CREATE INDEX bill_lines_technician_idx ON bill_lines (technician_id) WHERE technician_id IS NOT NULL;

-- 明细保护：唯一允许的变化仍是「有效 → 已作废」。004 之后加的列（价格档 009、门票 014、技师 020）一并列为不可改
CREATE OR REPLACE FUNCTION yuzu_bill_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '账单明细禁止删除，请作废并填写原因' USING ERRCODE = 'P0001';
  END IF;
  SELECT status INTO bill_status FROM bills WHERE id = NEW.bill_id;
  IF bill_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION '账单已结束，不能再挂账或更正' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION '新登记的明细必须为有效状态' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'voided'
     AND (NEW.id, NEW.bill_id, NEW.source, NEW.item_id, NEW.name, NEW.unit_price, NEW.quantity, NEW.amount,
          NEW.post_key, NEW.business_date, NEW.posted_by, NEW.posted_at,
          NEW.tier, NEW.ticket_type_id, NEW.ticket_segments, NEW.technician_id, NEW.call_type)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.bill_id, OLD.source, OLD.item_id, OLD.name, OLD.unit_price, OLD.quantity, OLD.amount,
          OLD.post_key, OLD.business_date, OLD.posted_by, OLD.posted_at,
          OLD.tier, OLD.ticket_type_id, OLD.ticket_segments, OLD.technician_id, OLD.call_type) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '账单明细只能作废，不能修改' USING ERRCODE = 'P0001';
END $$;
