-- 8.0.22 AI 辅助（docs/AI_V8022.md，MD-D）：每天的经营小结、问数的记录；对外调用记录多一种「ai」。
-- 只读、只出文字：这两张表只记 AI 写的文字与用到的汇总数，不碰任何业务表。

CREATE TABLE ai_summaries (
  id             bigserial PRIMARY KEY,
  -- 空 = 全公司合并的那一份
  store_id       bigint REFERENCES stores (id),
  business_date  date NOT NULL,
  kind           text NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily')),
  facts          jsonb NOT NULL,
  facts_hash     text NOT NULL,
  text           text,
  model          text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  status         text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'unconfigured')),
  attempts       smallint NOT NULL DEFAULT 0,
  lease_until    timestamptz,
  error          text CHECK (error IS NULL OR char_length(error) <= 500),
  -- 推企业微信（MD11）：推出去的时间；没推出去的原因（只推一次，不重试）
  pushed_at      timestamptz,
  push_error     text CHECK (push_error IS NULL OR char_length(push_error) <= 300),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- 同一店同一天同一种只有一份（全公司合并的按 0 算）
CREATE UNIQUE INDEX ai_summaries_uq ON ai_summaries (coalesce(store_id, 0), business_date, kind);

CREATE TABLE ai_questions (
  id             bigserial PRIMARY KEY,
  staff_id       bigint NOT NULL REFERENCES staff (id),
  store_id       bigint NOT NULL REFERENCES stores (id),
  client_key     uuid NOT NULL UNIQUE,
  question       text NOT NULL CHECK (char_length(question) BETWEEN 2 AND 500),
  answer         text,
  tool_calls     jsonb NOT NULL DEFAULT '[]'::jsonb,
  model          text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  status         text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'refused')),
  error          text CHECK (error IS NULL OR char_length(error) <= 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX ai_questions_staff_idx ON ai_questions (staff_id, id DESC);
CREATE INDEX ai_questions_day_idx ON ai_questions (staff_id, created_at);

-- 对外调用记录多一种「ai」（在当时的约束上追加）
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'integration_calls'::regclass AND conname = 'integration_calls_kind_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原对外调用种类约束不存在'; END IF;
  ALTER TABLE integration_calls DROP CONSTRAINT integration_calls_kind_check;
  EXECUTE format('ALTER TABLE integration_calls ADD CONSTRAINT integration_calls_kind_check CHECK ((%s) OR kind IN (''ai''))', expression);
END $$;
