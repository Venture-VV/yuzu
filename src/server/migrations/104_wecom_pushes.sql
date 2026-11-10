-- 8.0.7 A4 企业微信每周一推（docs/ERP_V807.md 第 4 节，V19、V20）：推送记录。
--   · 每周一 9:00（门店时区）以后，开关打开、服务器 .env 配了 ERP_WECOM_WEBHOOK 时，每分钟的自动任务把本周应付、待审批、
--     快到期的（质保金、合同、证照、批次）、逾期应收推到企业微信群机器人；同一周只推一次：period_key（那一周的周一）的部分唯一索引兜底，
--     几个进程同时跑也只有一个认领到。
--   · 认领时写租约（claimed_until）：进程在发送中断了，租约过期以后下一分钟再认领（宁可重发，不漏发）；发不出去的隔 5 分钟再试，最多 3 次。
--   · 「发一条试试」（kind = 'test'）每次一行，不去重。
--   · 机器人地址是密钥：只在 .env，不进库、不进日志；这里只记发的内容、结果与出错原因（原因里不带地址）。
CREATE TABLE wecom_pushes (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('weekly', 'test')),
  -- weekly：那一周的周一（门店时区）；test 为空
  period_key date,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  content text NOT NULL DEFAULT '',
  error text,
  attempts int NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  claimed_until timestamptz,
  created_by bigint REFERENCES staff(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((kind = 'weekly') = (period_key IS NOT NULL))
);
CREATE UNIQUE INDEX wecom_pushes_weekly_once ON wecom_pushes (period_key) WHERE kind = 'weekly';
CREATE INDEX wecom_pushes_recent_idx ON wecom_pushes (id DESC);
