-- 8.0.20 会员联动房价（docs/ERP_V8020.md 第 6 节，JX-G / JX8）。
--
--   · room_type_member_prices：房型按档级的会员价（某一档起；高档没单独设的用比它低的最近一档）。全天房是每晚、钟点房是每段。
--   · room_stays 加两列：list_rate 入住时的门市价、member_grade 用了哪一档的会员价（没用会员价是空）。
--     用了会员价的入住单，它的房费结账时不再参加会员折扣（不叠加）。升级前的入住单两列都是空，照旧。

CREATE TABLE room_type_member_prices (
  room_type_id bigint NOT NULL REFERENCES room_types (id),
  grade        smallint NOT NULL CHECK (grade BETWEEN 1 AND 6),
  price        integer NOT NULL CHECK (price BETWEEN 1 AND 10000000),
  updated_by   bigint REFERENCES staff (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_type_id, grade)
);

ALTER TABLE room_stays
  ADD COLUMN list_rate integer CHECK (list_rate > 0),
  ADD COLUMN member_grade smallint CHECK (member_grade BETWEEN 1 AND 6),
  ADD CONSTRAINT room_stays_member_rate_ck CHECK (member_grade IS NULL OR (list_rate IS NOT NULL AND rate < list_rate));
