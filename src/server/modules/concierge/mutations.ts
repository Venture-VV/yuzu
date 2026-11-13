import { randomUUID } from "node:crypto";
import { can } from "@shared/permissions";
import {
  normalizeReceiptPaymentMethod,
  normalizeCatalogText,
} from "@shared/concierge/receipt-review";
import type { TeamUser } from "@shared/concierge/types";
import type { Db, Tx } from "../../db";
import type { Actor, Deps } from "../../lib/context";
import { writeAudit } from "../../lib/audit";
import { hashRequest } from "../../lib/idempotency";
import { setTxTimeouts } from "../../lib/tx";
import { mapActor, listTeam, requireMember } from "./store";
import { buildReceipt } from "./receipt";
import { canonicalMemberId, nativeResourceOptions, resourceColumns } from "./native-links";
import { executePraise } from "./praise";
import { memberFamily } from "../membership";
import {
  WorkspaceError,
  text,
  dateTime,
  amountCents,
  checkedTime,
  version,
  idList,
  uuid,
} from "./validation";
const now = () => new Date().toISOString();
const integer = (x: unknown, label: string) => {
  const n = Number(x);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new WorkspaceError(`${label}不正确`);
  return n;
};
export async function moduleLock(tx: Tx) {
  await setTxTimeouts(tx);
  await tx`SELECT pg_advisory_xact_lock(8012,135)`;
}
/**
 * 管家部自己的同步版本号（整改）：每次写入在模块锁里加一，页面每 3 秒只比这个数。
 * 原来比的是全店 audit_logs 的最大编号——别的模块登录、结账一条审计，所有开着管家部的页面都要重新取一遍整个工作区。
 */
export async function bumpRevision(tx: Tx) {
  await tx`UPDATE concierge_sync SET revision=revision+1`;
}
/** 审计里不放整段识别原文（最长各 6 万字）：完整快照在 concierge_revisions 里，一版一份 */
const slim = (v: any) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const { rawText, itemsText, ...rest } = v;
  return rawText === undefined && itemsText === undefined
    ? v
    : { ...rest, rawTextLength: String(rawText ?? "").length, itemsTextLength: String(itemsText ?? "").length };
};
async function oldRecord(
  tx: Tx,
  id: string,
  kind: string,
  p: Record<string, any>,
) {
  const [r] =
    await tx`SELECT * FROM concierge_records WHERE id=${uuid(id)}::uuid AND kind=${kind} FOR UPDATE`;
  if (!r) throw new WorkspaceError("记录不存在", 404);
  if (r.version !== version(p.version))
    throw new WorkspaceError("资料已被同事修改，请刷新核对后重试", 409);
  return r;
}
async function audit(
  tx: Tx,
  actor: Actor,
  label: string,
  type: string,
  id: string,
  memberId: string,
  before: any,
  after: any,
  reason = "",
  ip?: string,
) {
  await writeAudit(tx, {
    staffId: actor.id,
    action: "concierge_record",
    targetType: `concierge_${type}`,
    targetId: id,
    detail: {
      actorName: actor.displayName,
      label,
      objectType: type,
      memberId,
      before: slim(before),
      after: slim(after),
      reason,
    },
    ip,
  });
}
async function revision(
  tx: Tx,
  type: string,
  id: string,
  v: number,
  snapshot: any,
  actor: Actor,
  reason: string,
) {
  await tx`INSERT INTO concierge_revisions(object_type,object_id,version,snapshot,actor_id,reason) VALUES(${type},${id},${v},${tx.json(snapshot)},${actor.id},${reason})`;
}
async function saveRecord(
  tx: Tx,
  kind: string,
  id: string,
  memberId: string,
  data: any,
  actor: Actor,
  before: any,
  reason: string,
  ip?: string,
  nativeBookingId: number | null = null,
  nativeCheckoutId: number | null = null,
) {
  const v = before ? before.version + 1 : 1;
  data.createdByName = before?.data.createdByName || actor.displayName;
  data.updatedByName = actor.displayName;
  const refs = resourceColumns(kind === "appointment" ? data.resourceKey : undefined);
  if (before)
    await tx`UPDATE concierge_records SET member_id=${memberId || null},data=${tx.json(data)},version=${v},updated_by=${actor.id},updated_at=now(),native_booking_id=${nativeBookingId},native_checkout_id=${nativeCheckoutId},native_space_id=${refs.spaceId},native_table_id=${refs.tableId},native_room_id=${refs.roomId} WHERE id=${id}`;
  else
    await tx`INSERT INTO concierge_records(id,kind,member_id,data,created_by,updated_by,native_booking_id,native_checkout_id,native_space_id,native_table_id,native_room_id) VALUES(${id},${kind},${memberId || null},${tx.json(data)},${actor.id},${actor.id},${nativeBookingId},${nativeCheckoutId},${refs.spaceId},${refs.tableId},${refs.roomId})`;
  await revision(tx, kind, id, v, data, actor, reason);
  await audit(
    tx,
    actor,
    (
      {
        balance: "核对余额",
        note: "服务记录",
        appointment: before ? "调整协调预约" : "登记协调预约",
        visit: "到店接待",
        task: "回访交班",
        receipt: "消费凭证",
        catalog: "核准常用项目",
      } as Record<string, string>
    )[kind] || kind,
    kind,
    id,
    memberId,
    before?.data ?? null,
    data,
    reason,
    ip,
  );
  return { id };
}
async function evidence(db: Db, memberId: string, p: Record<string, any>) {
  const uploadIds = idList(p.uploadIds),
    receiptIds = idList(p.receiptIds);
  for (const id of uploadIds) {
    const [r] =
      await db`SELECT member_id FROM concierge_uploads WHERE id=${uuid(id)}::uuid`;
    if (!r || r.memberId !== memberId)
      throw new WorkspaceError("余额照片必须属于当前会员");
  }
  for (const id of receiptIds) {
    const [r] =
      await db`SELECT member_id,data FROM concierge_records WHERE id=${uuid(id)}::uuid AND kind='receipt'`;
    if (
      !r ||
      r.data.status === "已作废" ||
      (r.memberId !== memberId &&
        !r.data.payments?.some(
          (p: any) =>
            normalizeReceiptPaymentMethod(p.method) === "会员扣卡" &&
            p.memberId === memberId,
        ))
    )
      throw new WorkspaceError("消费依据必须属于当前会员");
  }
  return { uploadIds, receiptIds };
}
async function assignee(db: Db, id: string) {
  if (id && !(await listTeam(db)).some((t) => t.id === id && t.active))
    throw new WorkspaceError("负责人不存在、已停用或没有管家权限");
}
async function nativeMember(db: Db, value: unknown) {
  if (value == null || value === "") return null;
  const id = await canonicalMemberId(db, integer(value, "企业会员编号"));
  if (!id) throw new WorkspaceError("系统会员不存在");
  const [r] =
    await db`SELECT id,merged_into_id,status FROM members WHERE id=${id} FOR SHARE`;
  if (!r || r.mergedIntoId || r.status !== "active")
    throw new WorkspaceError("企业会员不存在、已合并或不可用");
  return id;
}
async function coordinationConflict(db:Db,key:string,label:string,start:string,end:string,except:string) {
  const ids=resourceColumns(key);
  const [room]=ids.roomId ? await db`SELECT space_id FROM rooms WHERE id=${ids.roomId}` : [];
  const space=ids.spaceId || room?.spaceId || null;
  const [hit]=await db`SELECT id FROM concierge_records WHERE kind='appointment' AND id<>${uuid(except)}::uuid
    AND ((coalesce(data->>'resourceKey','')<>'' AND data->>'resourceKey'=${key} AND ${key}<>'')
      OR (native_space_id=${space} AND ${space}::bigint IS NOT NULL)
      OR (native_room_id IN (SELECT id FROM rooms WHERE space_id=${space}) AND ${space}::bigint IS NOT NULL)
      OR (coalesce(data->>'resourceKey','')='' AND lower(data->>'resource')=lower(${label})))
    AND data->>'status' IN ('已确认','已到店') AND data->>'startAt'<${end} AND data->>'endAt'>${start}`;
  if (hit) throw new WorkspaceError("管家服务安排已有同一资源的时段冲突，请调整时间或资源",409);
}
async function checkNativeBooking(db: Db, memberId: string, id: number) {
  if (!memberId) throw new WorkspaceError("前台预约与当前关联企业会员不匹配");
  const [b] = await db`SELECT member_id FROM bookings WHERE id=${id}`;
  const [m] =
    await db`SELECT native_member_id FROM concierge_members WHERE id=${uuid(memberId)}::uuid`;
  const canonical=m?.nativeMemberId ? await canonicalMemberId(db,Number(m.nativeMemberId)) : null;
  const family=canonical ? await memberFamily(db,canonical) : [];
  if (!b || !family.includes(Number(b.memberId)))
    throw new WorkspaceError("前台预约与当前关联企业会员不匹配");
}
async function checkNativeCheckout(db: Db, memberId: string, id: number) {
  if (!memberId)
    throw new WorkspaceError("请先关联企业会员，再关联同一位会员的结账");
  const [m] =
    await db`SELECT native_member_id FROM concierge_members WHERE id=${uuid(memberId)}::uuid`;
  if (!m?.nativeMemberId)
    throw new WorkspaceError("请先关联企业会员，再关联同一位会员的结账");
  const canonical=await canonicalMemberId(db,Number(m.nativeMemberId));
  if (!canonical) throw new WorkspaceError("系统会员关联不存在");
  const family=await memberFamily(db,canonical);
  const [hit] =
    await db`SELECT c.id FROM checkouts c WHERE c.id=${id} AND c.status<>'voided' AND (EXISTS(SELECT 1 FROM checkout_bills cb JOIN visits v ON v.id=cb.visit_id WHERE cb.checkout_id=c.id AND v.member_id IN ${db(family)}) OR EXISTS(SELECT 1 FROM checkout_payments cp WHERE cp.checkout_id=c.id AND cp.method='wallet' AND cp.consumption_id IS NOT NULL AND cp.member_id IN ${db(family)}))`;
  if (!hit) throw new WorkspaceError("企业结账不属于当前关联会员");
}
async function execute(
  tx: Tx,
  actor: Actor,
  action: string,
  p: Record<string, any>,
  ip?: string,
) {
  const user: TeamUser = mapActor(actor);
  const ts = now();
  if (action === "createMember" || action === "updateMember") {
    const id = action === "createMember" ? randomUUID() : text(p.id, 80, true);
    const [before] =
      action === "updateMember"
        ? await tx`SELECT * FROM concierge_members WHERE id=${uuid(id)}::uuid FOR UPDATE`
        : [];
    if (
      action === "updateMember" &&
      (!before || before.version !== version(p.version))
    )
      throw new WorkspaceError("会员资料已更新，请刷新核对", 409);
    const reason =
      action === "updateMember"
        ? text(p.changeReason ?? p.reason, 1000, true)
        : "管家首次纳入";
    let name = text(p.name, 60),
      phone = text(p.phone, 30);
    const
      cardNo = text(p.cardNo, 60),
      ownerId = text(p.ownerId, 80);
    if (phone && !/^[+\d\s()-]{5,30}$/.test(phone))
      throw new WorkspaceError("联系电话格式不正确");
    await assignee(tx, ownerId);
    const joinedAt = text(p.joinedAt, 10);
    if (
      joinedAt &&
      (!/^\d{4}-\d\d-\d\d$/.test(joinedAt) ||
        !Number.isFinite(Date.parse(joinedAt)) ||
        new Date(joinedAt).toISOString().slice(0, 10) !== joinedAt)
    )
      throw new WorkspaceError("建档日期不存在");
    // 只在关联变了的时候核对企业会员还在用：页面每次保存都带着原来的关联，
    // 关联的企业会员后来被停用、被合并以后，这份管家档案照样要能改（整改：原来每次都核对，档案就再也存不了）
    const sameLink =
      p.nativeMemberId === undefined ||
      (!!before &&
        String(p.nativeMemberId ?? "") === String(before.nativeMemberId ?? ""));
    if (before?.nativeMemberId && !sameLink && !p.nativeMemberId) throw new WorkspaceError("已关联的服务档案不能退回独立会员，请保留系统关联");
    if (before?.nativeMemberId && !sameLink && !can(actor,"concierge.manage")) throw new WorkspaceError("纠正已有系统会员关联请由经理核对并说明原因",403);
    const nativeId = sameLink
      ? (before?.nativeMemberId ?? null)
      : await nativeMember(tx, p.nativeMemberId);
    if (!before && !nativeId) throw new WorkspaceError("请先选择前台已办理的系统会员，再建立服务档案");
    if (nativeId) {
      const canonical = await canonicalMemberId(tx, nativeId);
      if (!canonical) throw new WorkspaceError("关联的系统会员不存在");
      const family=await memberFamily(tx,canonical);
      const [existing]=await tx`SELECT id,code FROM concierge_members WHERE native_member_id IN ${tx(family)} AND id<>${uuid(id)}::uuid LIMIT 1`;
      if (existing && (!before || !sameLink)) throw new WorkspaceError(`这位系统会员已有管家服务档案 ${String(existing.code).padStart(6,"0")}，请打开原档案`,409);
      const [identity]=await tx`SELECT name,phone FROM members WHERE id=${canonical}`;
      name=before && sameLink ? before.data.name : identity!.name;
      phone=before && sameLink ? before.data.phone : identity!.phone;
    }
    if (!name) throw new WorkspaceError("请填写接待称呼");
    if (!phone && !cardNo) throw new WorkspaceError("手机号和收银卡号至少填一项");
    if (before && nativeId !== (before.nativeMemberId ?? null)) {
      const [linked] =
        await tx`SELECT id FROM concierge_records WHERE member_id=${uuid(id)}::uuid AND (native_booking_id IS NOT NULL OR native_checkout_id IS NOT NULL) LIMIT 1`;
      if (linked)
        throw new WorkspaceError(
          "已有前台单据关联，请先核对并解除原关联，再调整企业会员",
        );
    }
    const data = {
      name,
      phone,
      cardNo,
      ownerId,
      cardTier: nativeId ? before?.data.cardTier || "" : text(p.cardTier, 60),
      serviceAlias: text(p.serviceAlias,60),
      preferences: text(p.preferences, 2000),
      source: text(p.source, 100),
      joinedAt,
    };
    if (before)
      await tx`UPDATE concierge_members SET data=${tx.json(data)},native_member_id=${nativeId},version=version+1,updated_by=${actor.id},updated_at=now() WHERE id=${id}`;
    else
      await tx`INSERT INTO concierge_members(id,native_member_id,data,created_by,updated_by) VALUES(${id},${nativeId},${tx.json(data)},${actor.id},${actor.id})`;
    await revision(
      tx,
      "member",
      id,
      before ? before.version + 1 : 1,
      { ...data, nativeMemberId: nativeId },
      actor,
      reason,
    );
    await audit(
      tx,
      actor,
      before ? "修改会员" : "新建会员",
      "member",
      id,
      id,
      before ? { ...before.data, nativeMemberId: before.nativeMemberId } : null,
      { ...data, nativeMemberId: nativeId },
      reason,
      ip,
    );
    if (!before && p.openingBalance !== undefined && p.openingBalance !== "")
      await saveRecord(
        tx,
        "balance",
        randomUUID(),
        id,
        {
          memberId: id,
          amountCents: amountCents(p.openingBalance),
          checkedAt: checkedTime(p.checkedAt),
          source: "收银人工核对",
          note: text(p.balanceNote, 1000) || "建档首次核对",
          actorName: actor.displayName,
          uploadIds: [],
          receiptIds: [],
        },
        actor,
        null,
        "建档首次核对",
        ip,
      );
    return { id };
  }
  if (action === "saveBalance") {
    const memberId = text(p.memberId, 80, true);
    await requireMember(tx, memberId);
    const [old] =
      await tx`SELECT id,data FROM concierge_records WHERE kind='balance' AND member_id=${uuid(memberId)}::uuid ORDER BY ordinal DESC LIMIT 1`;
    const expected =
      p.expectedBalanceId === null ? null : text(p.expectedBalanceId, 80, true);
    if ((old ? String(old.id) : null) !== expected)
      throw new WorkspaceError("余额已被同事核对，请刷新后重试", 409);
    const checkedAt = checkedTime(p.checkedAt);
    if (old && checkedAt < old.data.checkedAt)
      throw new WorkspaceError("较早核对不能覆盖较新的余额");
    const links = await evidence(tx, memberId, p);
    return saveRecord(
      tx,
      "balance",
      randomUUID(),
      memberId,
      {
        memberId,
        amountCents: amountCents(p.amount),
        checkedAt,
        note: text(p.note, 1000, true),
        source: text(p.source, 100) || "收银人工核对",
        actorName: actor.displayName,
        ...links,
      },
      actor,
      null,
      text(p.note, 1000, true),
      ip,
    );
  }
  if (action === "attachBalanceEvidence") {
    const id = text(p.balanceId ?? p.id, 80, true);
    const [old] =
      await tx`SELECT * FROM concierge_records WHERE id=${uuid(id)}::uuid AND kind='balance' FOR UPDATE`;
    if (!old) throw new WorkspaceError("核对记录不存在", 404);
    const links = await evidence(tx, String(old.memberId), p);
    if (!links.uploadIds.length && !links.receiptIds.length)
      throw new WorkspaceError("请至少选择一张照片或消费凭证");
    // Balance snapshots are immutable; append evidence in its own table/revision stream.
    const reason = text(p.reason, 1000) || "补充核对依据";
    const before = await balanceEvidence(tx, id);
    for (const uploadId of links.uploadIds)
      await tx`INSERT INTO concierge_balance_evidence(balance_id,upload_id,created_by) VALUES(${id},${uploadId},${actor.id}) ON CONFLICT DO NOTHING`;
    for (const receiptId of links.receiptIds)
      await tx`INSERT INTO concierge_balance_evidence(balance_id,receipt_id,created_by) VALUES(${id},${receiptId},${actor.id}) ON CONFLICT DO NOTHING`;
    const after = await balanceEvidence(tx, id);
    await audit(
      tx,
      actor,
      "追加余额证据",
      "balance",
      id,
      String(old.memberId),
      before,
      after,
      reason,
      ip,
    );
    return { id };
  }
  if (action === "saveNote") {
    const memberId = text(p.memberId, 80, true);
    await requireMember(tx, memberId);
    return saveRecord(
      tx,
      "note",
      randomUUID(),
      memberId,
      {
        memberId,
        content: text(p.content, 3000, true),
        nextAt: dateTime(p.nextAt),
        actorName: actor.displayName,
      },
      actor,
      null,
      "",
      ip,
    );
  }
  if (action === "saveCatalogItem") {
    if (!can(actor, "concierge.manage"))
      throw new WorkspaceError("只有管家经理可以核准名称", 403);
    const id = p.id ? text(p.id, 80, true) : randomUUID(),
      before = p.id ? await oldRecord(tx, id, "catalog", p) : null;
    const previous = before?.data || {};
    const name = text(p.name ?? previous.name, 200, true),
      spec = text(p.spec ?? previous.spec, 100),
      code = text(p.code ?? previous.code, 80),
      aliases = p.aliases ?? previous.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.length > 50)
      throw new WorkspaceError("核准别名最多50条");
    if (
      (p.active !== undefined && typeof p.active !== "boolean") ||
      (p.packageIncluded !== undefined &&
        typeof p.packageIncluded !== "boolean")
    )
      throw new WorkspaceError("启用或套餐标记错误");
    const data = {
      name,
      spec,
      code,
      aliases: [
        ...new Map(
          aliases.map((x) => {
            const v = text(x, 300, true);
            return [normalizeCatalogText(v), v];
          }),
        ).values(),
      ],
      normalizedName: normalizeCatalogText(name),
      normalizedSpec: normalizeCatalogText(spec),
      packageIncluded: p.packageIncluded ?? previous.packageIncluded ?? false,
      active: p.active ?? previous.active ?? true,
    };
    return saveRecord(
      tx,
      "catalog",
      id,
      "",
      data,
      actor,
      before,
      text(p.reason, 1000) || "经理核准名称",
      ip,
    );
  }
  if (
    [
      "createAppointment",
      "updateAppointment",
      "saveVisit",
      "saveTask",
      "saveReceipt",
    ].includes(action)
  ) {
    const kind = action.endsWith("Appointment")
      ? "appointment"
      : action === "saveVisit"
        ? "visit"
        : action === "saveTask"
          ? "task"
          : "receipt";
    const id = p.id ? text(p.id, 80, true) : randomUUID();
    const before = p.id ? await oldRecord(tx, id, kind, p) : null;
    const memberId = text(
      p.memberId === undefined ? before?.data.memberId : p.memberId,
      80,
      kind !== "receipt",
    );
    if (memberId) await requireMember(tx, memberId);
    const reason = text(
      p.changeReason ?? p.reason,
      1000,
      kind === "appointment" && !!before,
    );
    let data: any;
    let nativeBookingId: number | null = before?.nativeBookingId ?? null;
    let nativeCheckoutId: number | null = before?.nativeCheckoutId ?? null;
    if (kind === "appointment") {
      const startAt = dateTime(p.startAt, true),
        endAt = dateTime(p.endAt),
        status = text(p.status, 20, true),
        hostId = text(p.hostId, 80),
        partySize = integer(p.partySize, "人数");
      const resourceKey=p.resourceKey===undefined ? before?.data.resourceKey || "" : text(p.resourceKey,80);
      resourceColumns(resourceKey);
      let resource=text(p.resource,240), service=text(p.service,100,true);
      let resourceCategory=text(p.resourceCategory ?? before?.data.resourceCategory,80), resourceGroup=text(p.resourceGroup ?? before?.data.resourceGroup,120);
      if (resourceKey) {
        const ids=resourceColumns(resourceKey);
        const table=ids.spaceId ? "spaces" : ids.tableId ? "dining_tables" : "rooms";
        const resourceId=ids.spaceId || ids.tableId || ids.roomId;
        await tx`SELECT id FROM ${tx(table)} WHERE id=${resourceId!} FOR SHARE`;
        const option=(await nativeResourceOptions(tx)).find(r=>r.key===resourceKey);
        if (!option) throw new WorkspaceError("系统资源不存在，请刷新后重新选择");
        const closing=["已取消","已完成","未到店"].includes(status);
        const changesArrangement=!before || before.data.resourceKey!==resourceKey || (!closing && (before.data.startAt!==startAt || before.data.endAt!==endAt || before.data.status!==status));
        if (changesArrangement && !option.active) throw new WorkspaceError("所选系统资源已停用或不可安排，请重新选择");
        resource=before && before.data.resourceKey===resourceKey ? before.data.resource : option.label;
        service=before && before.data.resourceKey===resourceKey ? before.data.service : option.categoryLabel;
        resourceCategory=option.category;
        resourceGroup=option.group;
      } else if (resourceCategory) {
        const options=await nativeResourceOptions(tx);
        const option=options.find(r=>r.active && r.category===resourceCategory && (!resourceGroup || r.group===resourceGroup));
        const unchanged=before?.data.resourceCategory===resourceCategory && before?.data.resourceGroup===resourceGroup;
        if (!option && !unchanged) throw new WorkspaceError("区域或规格已变更，请刷新后重新选择");
        if (option) service=option.categoryLabel;
        resource=""; // An area/specification request never reserves an entire group.
      }
      await assignee(tx, hostId);
      if (
        partySize > 9999 ||
        !["待确认", "已确认", "已到店", "已完成", "已取消", "未到店"].includes(
          status,
        )
      )
        throw new WorkspaceError("人数或预约状态不正确");
      if (
        endAt &&
        (endAt <= startAt ||
          Date.parse(endAt) - Date.parse(startAt) > 7 * 86400000)
      )
        throw new WorkspaceError("结束应晚于开始，单次不超过7天");
      if (resource && ["已确认", "已到店"].includes(status) && !endAt)
        throw new WorkspaceError("指定协调资源请填写结束时间");
      if (resource && endAt && ["已确认", "已到店"].includes(status)) {
        await coordinationConflict(tx,resourceKey,resource,startAt,endAt,id);
      }
      if (p.nativeBookingId !== undefined) {
        nativeBookingId =
          p.nativeBookingId === "" || p.nativeBookingId === null
            ? null
            : integer(p.nativeBookingId, "前台预约编号");
        if (
          nativeBookingId !== (before?.nativeBookingId ?? null) &&
          !can(actor, "booking.manage")
        )
          throw new WorkspaceError("关联前台正式预约需要原生预约权限", 403);
      }
      if (nativeBookingId)
        await checkNativeBooking(tx, memberId, nativeBookingId);
      data = {
        memberId,
        startAt,
        endAt,
        status,
        resource,
        resourceKey,
        resourceCategory,
        resourceGroup,
        hostId,
        partySize,
        service,
        note: text(p.note, 2000),
        changeReason: reason,
        nativeBookingId,
      };
    }
    if (kind === "visit") {
      const hostId = text(p.hostId, 80),
        partySize = integer(p.partySize, "人数"),
        status = text(p.status, 20, true),
        appointmentId = text(p.appointmentId, 80);
      await assignee(tx, hostId);
      if (partySize > 9999 || !["接待中", "已完成"].includes(status))
        throw new WorkspaceError("接待人数或状态不正确");
      // 接待关联的协调预约定了就不能换、也不能摘掉（整改：原来这条核对写在「带了预约」的分支里，
      // 先传空摘掉、下一次再挂另一张就绕过去了）
      if (
        before?.data.appointmentId &&
        before.data.appointmentId !== appointmentId
      )
        throw new WorkspaceError("接待已关联预约，不能换单");
      if (appointmentId) {
        const [appt] =
          await tx`SELECT * FROM concierge_records WHERE id=${uuid(appointmentId)}::uuid AND kind='appointment' FOR UPDATE`;
        if (
          !appt ||
          appt.memberId !== memberId ||
          ["已取消", "未到店"].includes(appt.data.status)
        )
          throw new WorkspaceError("关联协调预约不匹配或已取消");
        if (appt.data.resourceKey && status === "接待中" &&
            (!before || before.data.status !== "接待中" || !["已到店", "已完成"].includes(appt.data.status))) {
          const ids = resourceColumns(appt.data.resourceKey);
          const table = ids.spaceId ? "spaces" : ids.tableId ? "dining_tables" : "rooms";
          await tx.unsafe(`SELECT id FROM ${table} WHERE id=$1 FOR SHARE`, [ids.spaceId ?? ids.tableId ?? ids.roomId!]);
          const resource = (await nativeResourceOptions(tx)).find(r => r.key === appt.data.resourceKey);
          if (!resource?.active) throw new WorkspaceError("预约资源已停用或不可安排，请先调整预约再开始接待");
        }
        if (appt.data.resource && appt.data.endAt && status === "接待中") {
          await coordinationConflict(tx,appt.data.resourceKey || "",appt.data.resource,appt.data.startAt,appt.data.endAt,String(appt.id));
        }
        // 预约状态只往前走、变了才写（整改：原来每次保存接待都重写一版，
        // 预约已经「已完成」以后再改一下还在「接待中」的接待，会把它退回「已到店」）
        const rank = (x: string) => (x === "已完成" ? 2 : x === "已到店" ? 1 : 0);
        const next = status === "已完成" ? "已完成" : "已到店";
        if (rank(next) > rank(appt.data.status))
          await saveRecord(
            tx,
            "appointment",
            String(appt.id),
            memberId,
            { ...appt.data, status: next },
            actor,
            appt,
            "接待状态接续",
            ip,
            appt.nativeBookingId,
          );
      }
      data = {
        memberId,
        hostId,
        partySize,
        status,
        appointmentId,
        feedback: text(p.feedback, 2000),
        pending: text(p.pending, 1000),
      };
    }
    if (kind === "task") {
      const taskKind = text(p.kind, 10, true),
        status = text(p.status, 20, true),
        assigneeId = text(p.assigneeId, 80, true);
      await assignee(tx, assigneeId);
      if (
        !["回访", "交班"].includes(taskKind) ||
        !["待处理", "处理中", "待接收", "已接收", "已完成"].includes(status)
      )
        throw new WorkspaceError("待办类别或状态不正确");
      if (
        before &&
        before.data.assigneeId !== assigneeId &&
        !can(actor, "concierge.manage")
      )
        throw new WorkspaceError("已交出的事项改派需经理处理", 403);
      if (
        status === "已接收" &&
        String(actor.id) !== assigneeId &&
        !can(actor, "concierge.manage")
      )
        throw new WorkspaceError("请由接班人确认接收", 403);
      const result = text(p.result, 1000);
      if (status === "已完成" && !result)
        throw new WorkspaceError("完成事项请记录实际结果");
      data = {
        memberId,
        kind: taskKind,
        status,
        assigneeId,
        category: text(p.category, 60),
        content: text(p.content, 1500, true),
        dueAt: dateTime(p.dueAt, true),
        result,
        nextAction: text(p.nextAction, 1000),
      };
    }
    if (kind === "receipt") {
      data = await buildReceipt(
        tx,
        p,
        before?.data ?? null,
        user,
        id,
        memberId,
      );
      const references =
        await tx`SELECT b.member_id FROM concierge_balance_evidence e JOIN concierge_records b ON b.id=e.balance_id WHERE e.receipt_id=${uuid(id)}::uuid UNION SELECT member_id FROM concierge_records WHERE kind='balance' AND (data->'receiptIds') ? ${id}`;
      for (const ref of references)
        if (
          ref.memberId !== memberId &&
          !data.payments.some(
            (pay: any) =>
              normalizeReceiptPaymentMethod(pay.method) === "会员扣卡" &&
              pay.memberId === ref.memberId,
          )
        )
          throw new WorkspaceError(
            "此单已作为其他扣卡会员的余额依据，不能移除该会员关联；请另存更正依据",
          );
      // Photo ownership is checked separately from the current receipt member: initial uploads may be unmatched.
      for (const image of data.uploadIds) {
        const [u] =
          await tx`SELECT member_id FROM concierge_uploads WHERE id=${uuid(image)}::uuid`;
        if (u?.memberId && memberId && u.memberId !== memberId)
          throw new WorkspaceError("凭证照片属于另一位会员，请核对");
      }
      if (p.nativeCheckoutId !== undefined) {
        nativeCheckoutId =
          p.nativeCheckoutId === "" || p.nativeCheckoutId === null
            ? null
            : integer(p.nativeCheckoutId, "企业结账编号");
        if (
          nativeCheckoutId !== (before?.nativeCheckoutId ?? null) &&
          !can(actor, "frontdesk.read")
        )
          throw new WorkspaceError("关联结账需要原生前台查看权限", 403);
      }
      if (nativeCheckoutId)
        await checkNativeCheckout(tx, memberId, nativeCheckoutId);
      data.nativeCheckoutId = nativeCheckoutId;
    }
    return saveRecord(
      tx,
      kind,
      id,
      memberId,
      data,
      actor,
      before,
      reason,
      ip,
      nativeBookingId,
      nativeCheckoutId,
    );
  }
  throw new WorkspaceError(
    "不支持的管家业务操作；账号和密码请在企业员工后台管理",
  );
}
export async function balanceEvidence(db: Db, id: string) {
  const rows =
    await db`SELECT upload_id,receipt_id FROM concierge_balance_evidence WHERE balance_id=${uuid(id)}::uuid ORDER BY id`;
  return {
    uploadIds: rows.flatMap((r) => (r.uploadId ? [String(r.uploadId)] : [])),
    receiptIds: rows.flatMap((r) => (r.receiptId ? [String(r.receiptId)] : [])),
  };
}
export async function mutate(
  deps: Deps,
  actor: Actor,
  action: string,
  p: Record<string, any>,
  requestId: string,
  ip?: string,
) {
  if (!can(actor, "concierge.operate"))
    throw new WorkspaceError("没有管家录入权限", 403);
  const key = text(requestId, 100, true),
    hash = hashRequest({ action, payload: p });
  try {
    return await deps.sql.begin(async (tx) => {
      await moduleLock(tx);
      const [old] =
        await tx`SELECT * FROM concierge_operations WHERE actor_id=${actor.id} AND request_id=${key}`;
      if (old) {
        if (old.abandoned)
          throw new WorkspaceError(
            "此操作编号已标记不再执行，请核对记录后重新录入",
            409,
          );
        if (old.requestHash !== hash)
          throw new WorkspaceError(
            "相同操作编号的内容不一致，请核对原请求",
            409,
          );
        return old.response;
      }
      const response = action === "savePraise" || action === "voidPraise"
        ? await executePraise(tx, actor, action, p, deps.config.timezone, ip)
        : await execute(tx, actor, action, p, ip);
      await bumpRevision(tx);
      await tx`INSERT INTO concierge_operations(actor_id,request_id,request_hash,response) VALUES(${actor.id},${key},${hash},${tx.json(response)})`;
      return response;
    });
  } catch (error) {
    const e = error as { code?: string; constraint_name?: string };
    if (e.code === "23505")
      throw new WorkspaceError(
        "会员卡号、关联会员、消费单、接待或名称已经存在，请打开已有记录核对",
        409,
      );
    throw error;
  }
}
