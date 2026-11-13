import type { Db } from "../../db";
import { permissionsOf, can, type Duty, type Role } from "@shared/permissions";
import type { Actor } from "../../lib/context";
import { loadRoleOverrides } from "../../auth/role-permissions";
import type {
  WorkspaceData,
  TeamUser,
  CatalogItem,
  Receipt,
} from "@shared/concierge/types";
import { WorkspaceError, uuid } from "./validation";
import { nativeMemberSummaries, nativeResourceOptions } from "./native-links";
export async function requireMember(db: Db, id: string) {
  const [r] = await db`SELECT id FROM concierge_members WHERE id=${uuid(id)}::uuid`;
  if (!r) throw new WorkspaceError("管家会员不存在，请刷新", 404);
}
export async function readCatalog(db: Db): Promise<CatalogItem[]> {
  const rows =
    await db`SELECT id,data,version,created_at,updated_at FROM concierge_records WHERE kind='catalog' ORDER BY created_at,id`;
  return rows.map(
    (r) =>
      ({
        ...r.data,
        id: String(r.id),
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }) as CatalogItem,
  );
}
export function mapActor(actor: Actor): TeamUser {
  return {
    id: String(actor.id),
    userId: String(actor.id),
    name: actor.displayName,
    email: "",
    login: actor.username,
    role: can(actor, "concierge.manage") ? "manager" : "butler",
    active: true,
  };
}
export async function listTeam(db: Db): Promise<TeamUser[]> {
  const overrides = await loadRoleOverrides(db);
  const rows = await db<
    {
      id: number;
      username: string;
      displayName: string;
      role: Role;
      duties: Duty[];
      active: boolean;
    }[]
  >`SELECT id,username,display_name,role,duties,active FROM staff WHERE NOT system ORDER BY id`;
  return rows.flatMap((s) => {
    const perms = permissionsOf(s, overrides);
    return perms.includes("concierge.read")
      ? [
          {
            id: String(s.id),
            userId: String(s.id),
            name: s.displayName,
            email: "",
            // 同事的登录名不发给页面（整改：原来把店主、店总等所有管家账号的登录名都发给了每个管家）
            login: "",
            role: perms.includes("concierge.manage")
              ? ("manager" as const)
              : ("butler" as const),
            active: s.active,
          },
        ]
      : [];
  });
}
export async function receiptDetail(db: Db, id: string): Promise<Receipt> {
  const [r] =
    await db`SELECT id,data,version,created_at,updated_at FROM concierge_records WHERE id=${uuid(id)}::uuid AND kind='receipt'`;
  if (!r) throw new WorkspaceError("消费单不存在", 404);
  return {
    ...r.data,
    id: String(r.id),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  } as Receipt;
}
export function briefReceipt(r: any): Receipt {
  const { rawText, itemsText, items, review, warnings, ...rest } = r.data;
  return {
    ...rest,
    id: String(r.id),
    version: r.version,
    rawText: "",
    itemsText: "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  } as Receipt;
}
export async function readWorkspace(
  db: Db,
  actor: Actor,
  timezone = "Asia/Shanghai",
): Promise<WorkspaceData> {
  const team = await listTeam(db);
  const members =
    await db`SELECT m.*,s.display_name AS creator_name,u.display_name AS updater_name FROM concierge_members m JOIN staff s ON s.id=m.created_by JOIN staff u ON u.id=m.updated_by ORDER BY code DESC`;
  const records =
    await db`SELECT id,kind,data,version,created_at,updated_at FROM concierge_records WHERE kind<>'receipt' ORDER BY ordinal DESC`;
  const receiptRows =
    await db`SELECT id,data - 'rawText' - 'itemsText' - 'items' - 'review' - 'warnings' AS data,version,created_at,updated_at FROM concierge_records WHERE kind='receipt' ORDER BY created_at DESC,id DESC LIMIT 500`;
  const recordsOf = (kind: string) =>
    records
      .filter((r) => r.kind === kind)
      .map((r) => ({
        ...r.data,
        id: String(r.id),
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  const uploads =
    await db`SELECT u.id,u.member_id,i.mime,i.size_bytes AS size,i.sha256,s.display_name AS created_by_name,u.created_at FROM concierge_uploads u JOIN erp_images i ON i.id=u.image_id AND i.scope='concierge' JOIN staff s ON s.id=u.created_by ORDER BY u.created_at DESC`;
  const audits =
    await db`SELECT id,staff_id,action,target_type,target_id,(detail - 'before' - 'after') || jsonb_build_object('after',jsonb_build_object('status',detail->'after'->'status')) AS detail,created_at FROM audit_logs WHERE action IN ('concierge_record','concierge_upload') AND (${can(actor, "concierge.manage")} OR staff_id=${actor.id}) ORDER BY id DESC LIMIT 2000`;
  const resources = await nativeResourceOptions(db);
  // 会员摘要一批取（8.0.18 整合）：原来每个服务档案各查一遍
  const natives = await nativeMemberSummaries(
    db,
    members.flatMap((m) => (m.nativeMemberId == null ? [] : [Number(m.nativeMemberId)])),
    timezone,
  );
  const profiles = members.map((m) => {
    const native = m.nativeMemberId == null ? null : natives.get(Number(m.nativeMemberId)) ?? null;
    return {
      ...m.data,
      // The member system owns identity; these are live projections, not another editable identity.
      name: native?.name ?? m.data.name,
      phone: native?.phone ?? m.data.phone,
      nativeMember: native,
      id: String(m.id), code: String(m.code).padStart(6,"0"),
      nativeMemberId: m.nativeMemberId == null ? null : Number(m.nativeMemberId),
      version:m.version,createdAt:m.createdAt,updatedAt:m.updatedAt,
      createdByName:m.creatorName,updatedByName:m.updaterName,
    };
  });
  return {
    user: mapActor(actor),
    team,
    members: profiles,
    balances: recordsOf("balance"),
    appointments: recordsOf("appointment").map(a => ({...a,nativeResource:resources.find(r=>r.key===a.resourceKey) ?? null})),
    resourceOptions: resources,
    notes: recordsOf("note"),
    visits: recordsOf("visit"),
    tasks: recordsOf("task"),
    receipts: receiptRows.map(briefReceipt),
    catalog: await readCatalog(db),
    uploads: uploads.map((u) => ({
      ...u,
      id: String(u.id),
      memberId: u.memberId || "",
    })),
    audits: audits.map((a) => ({
      id: String(a.id),
      actorId: String(a.staffId),
      actorName: a.detail.actorName || "",
      action: a.detail.label || a.action,
      objectType: a.detail.objectType || a.targetType || "",
      objectId: a.targetId || "",
      memberId: a.detail.memberId || "",
      before: JSON.stringify(a.detail.before ?? null),
      after: JSON.stringify(a.detail.after ?? null),
      reason: a.detail.reason || "",
      createdAt: a.createdAt,
    })),
    sync: { serverTime: new Date().toISOString(), pollSeconds: 3 },
    capabilities: {
      ocr: "browser",
      staffLogin: false,
      accessRestricted: false,
      operate: can(actor, "concierge.operate"),
      export: can(actor, "concierge.export"),
    },
  } as WorkspaceData;
}
