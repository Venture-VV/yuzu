-- 员工食堂：柚子信箱交给食堂负责人在手机上看、回信（店主 2026-11-10，docs/CANTEEN.md 第 18 节，K20）。
-- 只改员工食堂自己的表：
--   · canteen_feedback 加「哪位食堂负责人看过、回信」两列（引用 canteen_employees）。原来「看过就一定有管理员」「回信就一定有管理员」
--     两条约束放宽成：看过的人、回信的人各自正好一个——管理员（read_by / replied_by）或食堂负责人（read_by_employee /
--     replied_by_employee）。看过的人记第一次看过的那位，之后不变；回信的人记最后一次回信的那位（另一列清空）。
--   · 新表 canteen_feedback_reply_ops：负责人在手机上回信的操作编号（回复没收到时原样重发，同一个编号只记一次、返回那一条，
--     之后改过的回信不会被晚到的旧请求改回去）。只追加，不改不删。管理员在后台回信照旧记在 idempotency_keys（canteen_reply）。

ALTER TABLE canteen_feedback
  ADD COLUMN read_by_employee    bigint REFERENCES canteen_employees (id),
  ADD COLUMN replied_by_employee bigint REFERENCES canteen_employees (id);

-- 091 建表时没起名字的两条：(read_at IS NULL) = (read_by IS NULL)、(reply IS NULL) = (replied_by IS NULL)
ALTER TABLE canteen_feedback DROP CONSTRAINT canteen_feedback_check;
ALTER TABLE canteen_feedback DROP CONSTRAINT canteen_feedback_check2;
ALTER TABLE canteen_feedback
  ADD CONSTRAINT canteen_feedback_reader_check CHECK (
    CASE WHEN read_at IS NULL THEN read_by IS NULL AND read_by_employee IS NULL
         ELSE num_nonnulls(read_by, read_by_employee) = 1 END),
  ADD CONSTRAINT canteen_feedback_replier_check CHECK (
    CASE WHEN reply IS NULL THEN replied_by IS NULL AND replied_by_employee IS NULL
         ELSE num_nonnulls(replied_by, replied_by_employee) = 1 END);

CREATE TABLE canteen_feedback_reply_ops (
  client_key   uuid PRIMARY KEY,
  feedback_id  bigint NOT NULL REFERENCES canteen_feedback (id),
  -- 回信的负责人
  employee_id  bigint NOT NULL REFERENCES canteen_employees (id),
  -- 原请求摘要（那一条 + 回信的内容）：同一个编号换了内容拒绝
  request_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canteen_feedback_reply_ops_feedback_idx ON canteen_feedback_reply_ops (feedback_id);
CREATE TRIGGER canteen_feedback_reply_ops_append_only BEFORE UPDATE OR DELETE ON canteen_feedback_reply_ops
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
