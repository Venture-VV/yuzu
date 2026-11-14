-- 8.0.21 发票识别（docs/FINANCE_V8021.md 第 2 节，CW-A / CW1）：进项发票台账记下这一张是怎么登记的。
--   manual 手填；qr 读二维码带出来的；ocr 读 PDF 文字或本机文字识别带出来的。只为统计「多少张是识别的」，
--   识别结果都要人核对后才保存；发票内容仍然不能改（保护触发器照旧），这一列也是登记时写定。
ALTER TABLE supplier_invoices
  ADD COLUMN entry_method text NOT NULL DEFAULT 'manual' CHECK (entry_method IN ('manual', 'qr', 'ocr'));
