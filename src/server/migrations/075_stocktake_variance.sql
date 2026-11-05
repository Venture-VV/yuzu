-- v0.7.30（主线）盘点差异审批（清单 #2，docs/APPROVALS.md 第 6 节，A8 待确认）：
--   盘点行的「大差异」（差异超过账面的 2%，账面是 0 的有差异就算；或差异金额超过 ¥500，「库存规则」里可改）提交时要写原因：
--   原因类别照旧记在 diff_reason（提交时就记下，确认时可以改），说明记在新加的 diff_note（至少 2 个字，接口里核对）。
--   有大差异的盘点单（总仓、部门小仓）走审批中心（单据类型「盘点差异」）。只加列，不改已有的行。
ALTER TABLE inv_doc_lines ADD COLUMN diff_note text NOT NULL DEFAULT '' CHECK (char_length(diff_note) <= 100);
