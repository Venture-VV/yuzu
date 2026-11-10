// 付款页面共用的小块（v0.7.32）：状态色、三单状态、质保金状态。

import { PAYMENT_STAGE_LABELS, type PaymentStage } from '@shared/contracts';
import {
  PAYMENT_REQUEST_STATUS_LABELS,
  THREE_WAY_STATUS_LABELS,
  WARRANTY_ROW_STATUS_LABELS,
  type PaymentRequestStatus,
  type ThreeWayStatus,
  type WarrantyRowStatus,
} from '@shared/payments';
import { Badge } from '../../components/ui';

type Tone = 'neutral' | 'pine' | 'yuzu' | 'clay' | 'lake' | 'ember';

const REQUEST_TONE: Record<PaymentRequestStatus, Tone> = {
  submitted: 'yuzu',
  returned: 'clay',
  approved: 'lake',
  paid: 'pine',
  ended: 'neutral',
  voided: 'neutral',
};

export function RequestStatusBadge({ status }: { status: PaymentRequestStatus }) {
  return <Badge tone={REQUEST_TONE[status]}>{PAYMENT_REQUEST_STATUS_LABELS[status]}</Badge>;
}

const THREE_WAY_TONE: Record<ThreeWayStatus, Tone> = { matched: 'pine', released: 'lake', held: 'clay', incomplete: 'yuzu' };

export function ThreeWayBadge({ status }: { status: ThreeWayStatus }) {
  return <Badge tone={THREE_WAY_TONE[status]}>{THREE_WAY_STATUS_LABELS[status]}</Badge>;
}

const WARRANTY_TONE: Record<WarrantyRowStatus, Tone> = { not_started: 'neutral', running: 'lake', due_soon: 'ember', payable: 'pine', held: 'clay', paid: 'neutral' };

export function WarrantyBadge({ status }: { status: WarrantyRowStatus }) {
  return <Badge tone={WARRANTY_TONE[status]}>{WARRANTY_ROW_STATUS_LABELS[status]}</Badge>;
}

/** 合同号 + 付款节点：HT20261106-0001 · 验收款 */
export const stageText = (contractNo: string | null, stage: PaymentStage | null) => (contractNo && stage ? `${contractNo} · ${PAYMENT_STAGE_LABELS[stage]}款` : '没挂合同的应付');
