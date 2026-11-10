// 验收不合格挂起付款（8.0.7 V9，docs/ERP_V807.md 第 2.5 节）：合同最近一次验收不合格、「可调的数值」里的开关开着时，
// 这份合同的钱一律不付——按申请登记付款、合同付款，以及 P7 关掉以后直接登记付款、没带申请的预付款核销到它的收货单上（Codex 审查 d8b314b）。
// 单独放一个文件：付款申请（payments/requests）与应付货款（inventory/payables）都要用，互相引用会成环。只读，不加锁。

import type { Db } from '../../db';
import { unprocessable } from '../../lib/errors';
import { loadSettings } from '../settings';

export async function assertNoAcceptanceHold(db: Db, contractId: number) {
  const [a] = await db<{ result: string; acceptedOn: string; note: string; contractNo: string }[]>`
    SELECT a.result, a.accepted_on::text AS accepted_on, a.note, c.contract_no
    FROM contract_acceptances a JOIN contracts c ON c.id = a.contract_id
    WHERE a.contract_id = ${contractId} AND a.voided_at IS NULL
    ORDER BY a.accepted_on DESC, a.id DESC LIMIT 1`;
  if (!a || a.result !== 'fail') return;
  if (!(await loadSettings(db)).acceptanceHoldsPayment) return;
  throw unprocessable('ACCEPTANCE_HOLD', `合同 ${a.contractNo} 最近一次验收（${a.acceptedOn}）不合格${a.note ? `：${a.note}` : ''}，付款挂起；重新验收合格以后再付`);
}

/** 这几张收货单挂着的合同里，有没有验收不合格、付款挂起的（P7 关掉时直接登记付款、核销用） */
export async function assertNoHoldOnReceipts(db: Db, receiptIds: number[]) {
  if (receiptIds.length === 0) return;
  const contracts = await db<{ contractId: number }[]>`
    SELECT DISTINCT po.contract_id FROM inv_docs d JOIN purchase_orders po ON po.id = d.purchase_order_id
    WHERE d.id IN ${db(receiptIds)} AND po.contract_id IS NOT NULL ORDER BY po.contract_id`;
  for (const c of contracts) await assertNoAcceptanceHold(db, Number(c.contractId));
}
