-- v0.7.29 ERP 采购五项③（主线）：部门备用金台账（E3，设计见 docs/ERP_PURCHASING.md 第 4 节）。
--   · 每个部门一行：保管人、定额（可空）、备注；改设置带版本号，两人同时改后保存的被拒；
--   · 余额、在手、待补付、台账都按已有的打款、报销、退回补付算，不另记余额（这张表只放设置）。
-- 只加表；没有设置的部门照常用备用金。

CREATE TABLE petty_accounts (
  department_id bigint PRIMARY KEY REFERENCES departments(id),
  custodian_id  bigint REFERENCES staff(id),
  limit_cents   bigint CHECK (limit_cents IS NULL OR (limit_cents > 0 AND limit_cents <= 100000000)),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by    bigint NOT NULL REFERENCES staff(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
