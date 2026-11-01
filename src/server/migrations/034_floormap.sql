-- v0.7.16 · 飞书需求 RQ-004 第三段（docs/ROOMMAP.md）：房态图——钟单记「服务的房间」（空间台账里的技师服务类空间），
-- 房态图按钟单显示技师房的空闲、服务中；钟房日志加「换房间」。已有的钟单没有房间（为空），不影响提成与对账。
-- 只加列、加索引、放宽约束。

ALTER TABLE technician_sessions ADD COLUMN space_id bigint REFERENCES spaces (id);
-- 房间的版本号：每换一次房间加 1。换房间的请求带上页面看到的版本号，对不上就拒绝——中间有过任何修改（哪怕又换回原来那间），
-- 超时后迟到的旧请求都不会盖掉后来的修改
ALTER TABLE technician_sessions ADD COLUMN space_version integer NOT NULL DEFAULT 0 CHECK (space_version >= 0);
-- 房态图、派钟选房间：每个房间里还没结束的钟单
CREATE INDEX technician_sessions_space_idx ON technician_sessions (space_id, id) WHERE space_id IS NOT NULL AND status IN ('waiting', 'serving');

-- 钟房日志：换房间（派钟后改服务的房间、补选房间、清掉房间）
ALTER TABLE technician_events DROP CONSTRAINT technician_events_kind_check;
ALTER TABLE technician_events ADD CONSTRAINT technician_events_kind_check
  CHECK (kind IN ('sign_in', 'rest', 'back', 'sign_out', 'to_end', 'dispatch', 'skip', 'start', 'extend', 'finish', 'cancel', 'reject', 'queue', 'room'));
