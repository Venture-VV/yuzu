-- v0.7.27：给小程序线的两处（docs/MEMBERSHIP_FINISH.md 第 6 节）。只放宽约束、加一列，不改已有的行。

-- 1. 2c 线上领券的发券入口（docs/MP_COUPONS.md 第 3 节，MP22）：发券记录的种类加「小程序领取」（mp_claim）。
--    不挂发券规则；经办人是系统账号「小程序」（system.mp）；去重键 mp_claim:<领取记录>，一次发 1 张、发给一位会员。
ALTER TABLE coupon_issues DROP CONSTRAINT coupon_issues_kind_check;
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_kind_check
  CHECK (kind IN ('manual', 'batch', 'open_card', 'level_up', 'birthday', 'recharge', 'benefit', 'mp_claim'));
ALTER TABLE coupon_issues DROP CONSTRAINT coupon_issues_rule_check;
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_rule_check
  CHECK ((kind IN ('manual', 'batch', 'benefit', 'mp_claim')) = (rule_id IS NULL));
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_mp_claim_check
  CHECK (kind <> 'mp_claim' OR (quantity = 1 AND member_id IS NOT NULL AND issued_by IS NOT NULL AND dedupe_key LIKE 'mp_claim:%'));

-- 2. 2d 线上充值的原路退回（docs/MP_RECHARGE.md 第 9 节，MP21）：退储值的每一行记「怎么退」。
--    manual  员工退：现金从钱箱退；扫码、银行卡在商户后台原路退回后登记退款单号（v0.7.26 的做法）；
--    mp_auto 门店系统原路退回：来源是线上充值的那一行，由小程序线按行调微信支付的退款接口，退款单号空着。
--    只在小程序线的原路退回接上并打开时才能选（应用里核对）；退储值单只追加，这一列不会再改。
ALTER TABLE member_refund_lines ADD COLUMN route text NOT NULL DEFAULT 'manual' CHECK (route IN ('manual', 'mp_auto'));
ALTER TABLE member_refund_lines ADD CONSTRAINT member_refund_lines_route_scope_check
  CHECK (route = 'manual' OR (source = 'recharge' AND method = 'wechat' AND ref = ''));
-- 小程序线按行号往后取 mp_auto 的行
CREATE INDEX member_refund_lines_mp_auto_idx ON member_refund_lines (id) WHERE route = 'mp_auto';
