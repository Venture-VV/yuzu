-- 8.0.9 巡场（Codex 审查 94f53d5）：同一个人 2 分钟内重复扫同一个码只记一次（XC5）；被当成「刚打过卡」的那一笔也记下
-- 操作编号与它指向的那条打卡，回复丢了原样重提返回第一次的结果。之前不记：原来那条在重提之前被后台作废的话，
-- 重提会再记一条新的有效打卡，等于撤销了作废。只追加，不能改、不能删。

CREATE TABLE patrol_checkin_repeats (
  client_key  uuid PRIMARY KEY,
  -- 当时算作「刚打过卡」的那一条（之后被作废也照样指着它）
  checkin_id  bigint NOT NULL REFERENCES patrol_checkins (id),
  employee_id bigint NOT NULL REFERENCES canteen_employees (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION yuzu_patrol_repeat_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '巡场重复扫码的记录只追加，不可修改、删除' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER patrol_checkin_repeat_guard BEFORE UPDATE OR DELETE ON patrol_checkin_repeats
  FOR EACH ROW EXECUTE FUNCTION yuzu_patrol_repeat_guard();
