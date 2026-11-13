import type {
  NativeSpending,
  NativeSpendingPage,
} from "@shared/concierge/types";
import type { Db } from "../../db";
import { memberFamily } from "../membership";
import { canonicalMemberId } from "./native-links";
import { uuid, WorkspaceError } from "./validation";

/** Read only the actual wallet payer's documents. Checkout item snapshots are context,
 * never additional debits and never inferred unit prices. No wallet read-with-expiry API. */
export async function nativeSpending(
  db: Db,
  profileId: string,
  offset: number,
): Promise<NativeSpendingPage> {
  const [profile] =
    await db`SELECT native_member_id FROM concierge_members WHERE id=${uuid(profileId)}::uuid`;
  if (!profile) throw new WorkspaceError("服务档案不存在", 404);
  const id = profile.nativeMemberId
    ? await canonicalMemberId(db, Number(profile.nativeMemberId))
    : null;
  const empty = {
    records: [],
    hasMore: false,
    offset,
    serverTime: new Date().toISOString(),
  };
  if (!id) return empty;
  const family = await memberFamily(db, id);
  const rows =
    await db`SELECT c.id,c.doc_no,c.created_at,c.business_date,c.status,c.total_amount,c.principal_amount,c.bonus_amount,
    s.display_name AS operator_name,m.id AS payer_id,m.member_no AS payer_no,m.name AS payer_name,
    k.id AS checkout_id,k.checkout_no,k.status AS checkout_status,k.total_amount AS checkout_total,
    r.doc_no AS reversal_no,r.reason AS reversal_reason,r.created_at AS reversed_at,
    CASE WHEN k.id IS NULL THEN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name',l.name,'category','','quantity',l.quantity,'unitPriceCents',l.unit_price,'amountCents',l.amount,'discountCents',0) ORDER BY l.id)
      FROM consumption_lines l WHERE l.consumption_id=c.id),'[]'::jsonb)
    ELSE coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name',i.name,'category',i.category,'quantity',i.quantity,'unitPriceCents',null,'amountCents',i.amount,'discountCents',i.discount) ORDER BY i.category,i.name)
      FROM checkout_items i WHERE i.checkout_id=k.id),'[]'::jsonb) END AS items
    FROM consumptions c JOIN members m ON m.id=c.member_id JOIN staff s ON s.id=c.operator_id
    LEFT JOIN checkouts k ON k.id=c.checkout_id LEFT JOIN reversals r ON r.consumption_id=c.id
    WHERE c.member_id IN ${db(family)} AND (c.checkout_id IS NULL OR EXISTS(
      SELECT 1 FROM checkout_payments p WHERE p.checkout_id=c.checkout_id AND p.method='wallet' AND p.consumption_id=c.id AND p.member_id=c.member_id))
    ORDER BY c.id DESC LIMIT 51 OFFSET ${offset}`;
  const records: NativeSpending[] = rows.slice(0, 50).map((r) => ({
    id: Number(r.id),
    docNo: r.docNo,
    occurredAt: r.createdAt,
    businessDate: r.businessDate,
    status: r.status,
    operatorName: r.operatorName,
    totalCents: Number(r.totalAmount),
    principalCents: Number(r.principalAmount),
    bonusCents: Number(r.bonusAmount),
    payer: { id: Number(r.payerId), memberNo: r.payerNo, name: r.payerName },
    checkout: r.checkoutId
      ? {
          id: Number(r.checkoutId),
          number: r.checkoutNo,
          status: r.checkoutStatus,
          totalCents: Number(r.checkoutTotal),
        }
      : null,
    reversal: r.reversalNo
      ? {
          number: r.reversalNo,
          reason: r.reversalReason,
          occurredAt: r.reversedAt,
        }
      : null,
    items: r.items.map((i: NativeSpending["items"][number]) => ({
      ...i,
      quantity: Number(i.quantity),
      unitPriceCents:
        i.unitPriceCents == null ? null : Number(i.unitPriceCents),
      amountCents: Number(i.amountCents),
      discountCents: Number(i.discountCents),
    })),
  }));
  return {
    records,
    hasMore: rows.length > 50,
    offset,
    serverTime: new Date().toISOString(),
  };
}
