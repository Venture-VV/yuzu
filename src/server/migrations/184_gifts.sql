-- 8.1.9 全局签赠（docs/GIFTS_V819.md，PENDING_DECISIONS「8.1.9 签赠」SZ1–SZ8）。
-- 签赠做成「签赠券」：券模板里标了签赠的那一类（兑换券或代金券），发放时必选授权人与渠道；抵扣、退回、作废、过期都与券一样。
-- 板块、权益内容、规则说明是签赠知识库里的内容（发过券以后照样能改）；配置在 settings 的 gift_rules。

ALTER TABLE coupon_templates
  ADD COLUMN gift boolean NOT NULL DEFAULT false,
  ADD COLUMN gift_segment text NOT NULL DEFAULT '' CHECK (char_length(gift_segment) <= 20),
  ADD COLUMN gift_content text NOT NULL DEFAULT '' CHECK (char_length(gift_content) <= 1000),
  ADD COLUMN gift_rules text NOT NULL DEFAULT '' CHECK (char_length(gift_rules) <= 1000);
-- 签赠券类型只能是兑换券或代金券，板块必填
ALTER TABLE coupon_templates ADD CONSTRAINT coupon_templates_gift_check
  CHECK (NOT gift OR (kind IN ('exchange', 'cash') AND char_length(btrim(gift_segment)) BETWEEN 1 AND 20));

-- 发过券的模板不能改签赠标记（原来的模板守卫照旧管面额、范围、有效期）
CREATE FUNCTION yuzu_coupon_template_gift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gift IS DISTINCT FROM OLD.gift AND EXISTS (SELECT 1 FROM coupon_issues WHERE template_id = OLD.id) THEN
    RAISE EXCEPTION '这个模板已经发过券，不能改成签赠或取消签赠' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coupon_templates_gift_guard BEFORE UPDATE ON coupon_templates FOR EACH ROW EXECUTE FUNCTION yuzu_coupon_template_gift_guard();

-- 发券记录：授权人与发放渠道（签赠才有，两个一起有；只能是人工发券）
ALTER TABLE coupon_issues
  ADD COLUMN authorized_by bigint REFERENCES staff (id),
  ADD COLUMN gift_channel text CHECK (gift_channel IS NULL OR char_length(btrim(gift_channel)) BETWEEN 1 AND 20);
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_gift_check
  CHECK ((authorized_by IS NULL) = (gift_channel IS NULL) AND (authorized_by IS NULL OR kind = 'manual'));
CREATE INDEX coupon_issues_gift_idx ON coupon_issues (business_date) WHERE authorized_by IS NOT NULL;

-- 签赠券类型的发券记录一定有授权人与渠道，别的券一定没有（发券规则、无记名、批量发券、会员权益、小程序领取都发不了签赠券）
CREATE FUNCTION yuzu_coupon_issue_gift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_gift boolean;
BEGIN
  SELECT gift INTO is_gift FROM coupon_templates WHERE id = NEW.template_id;
  IF is_gift AND NEW.authorized_by IS NULL THEN
    RAISE EXCEPTION '签赠券只能经「签赠发放」发（要选授权人与渠道）' USING ERRCODE = 'P0001';
  END IF;
  IF NOT is_gift AND NEW.authorized_by IS NOT NULL THEN
    RAISE EXCEPTION '只有签赠券类型的发券记录才有授权人' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coupon_issues_gift_guard BEFORE INSERT ON coupon_issues FOR EACH ROW EXECUTE FUNCTION yuzu_coupon_issue_gift_guard();

-- 操作编号与「确认作废」：新建签赠券类型（gift_type）、签赠发放（gift_issue），在当时的约束上追加（写法见 162）
DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''gift_type'',''gift_issue''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
