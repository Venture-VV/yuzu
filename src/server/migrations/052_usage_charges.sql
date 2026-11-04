-- v0.7.28 ②（主线）：派对房等「开单即占用」的计费（设计见 docs/SCHEDULE_FINISH.md 第 3 节，N2、N3）。
--   计费规则在设置 usage_rules.pricing 里（按业态：房费项目、起步时长、计费单位、开台费项目），没设的业态照旧不收费。
--   结束使用时按时长把房费（与开台费）挂到使用人的手牌账单上：明细是价目表里的项目（部门按项目的分类），
--   这张表记下哪条明细是哪张使用单的房费 / 开台费、用了多久、按多久计费（只追加）。
--   会员的包房房费折扣（QY-011）认这里的房费明细，派对房只在营业日是周一至周四时打（M44）。
-- 只加表，不改已有的行（升级前结束的使用单没有计费，照旧）。

CREATE TABLE space_usage_charges (
  usage_id        bigint NOT NULL REFERENCES space_usages (id),
  kind            text NOT NULL CHECK (kind IN ('fee', 'open_fee')),
  line_id         bigint NOT NULL UNIQUE REFERENCES bill_lines (id),
  -- 实际用了多久、按多久计费（开台费这两项记 0）
  minutes         integer NOT NULL CHECK (minutes >= 0),
  charged_minutes integer NOT NULL CHECK (charged_minutes >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_id, kind)
);
CREATE TRIGGER space_usage_charges_append_only BEFORE UPDATE OR DELETE ON space_usage_charges
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
