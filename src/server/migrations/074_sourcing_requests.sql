-- v0.7.30（主线）：询价接上需求单与补货建议（v0.7.29 的已知问题，见 docs/HANDOFF_V0729.md 第 6 节）。
--   · 从需求单发起询价时，询价单的每一行记下来自哪几行需求（同一物料的几行需求可以并成询价单的一行）；
--   · 定标转采购单时把这些需求行带到采购单行上（purchase_order_line_requests），需求单的进度照旧由采购单算；
--   · 一行需求同时只能在一张没撤销的询价单里（接口里锁需求单再核对，自检兜底）；询价单撤销后需求行回到「未下单」。
-- 询价单的物料行建好不改，关联也只在建询价单时写，之后只追加、不改不删。只加表，不改已有的行。

CREATE TABLE sourcing_line_requests (
  sourcing_line_id bigint NOT NULL REFERENCES sourcing_lines (id),
  request_line_id  bigint NOT NULL REFERENCES purchase_request_lines (id),
  PRIMARY KEY (sourcing_line_id, request_line_id)
);
CREATE INDEX sourcing_line_requests_request_idx ON sourcing_line_requests (request_line_id);

CREATE TRIGGER sourcing_line_requests_append_only BEFORE UPDATE OR DELETE ON sourcing_line_requests
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
