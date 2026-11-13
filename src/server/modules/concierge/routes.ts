import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { guard } from "../../auth/guard";
import { readSnapshot } from "../../db";
import type { Deps } from "../../lib/context";
import { AppError } from "../../lib/errors";
import { writeAudit } from "../../lib/audit";
import {
  readWorkspace,
  receiptDetail,
  briefReceipt,
  requireMember,
} from "./store";
import { can } from "@shared/permissions";
import { mutate, moduleLock, bumpRevision } from "./mutations";
import { WorkspaceError, text, uuid } from "./validation";
import { nativeMemberSummary, nativeRevision, searchNativeMembers } from "./native-links";
const object = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new WorkspaceError("请求格式不正确");
  return v as Record<string, any>;
};
const fail = (e: unknown): never => {
  // 错误码按类型分（整改：原来 400 / 403 / 404 / 409 都是 CONCIERGE_VALIDATION，日志与页面分不出是没权限、不存在还是被同事改过）
  if (e instanceof WorkspaceError)
    throw new AppError(
      e.status,
      e.status === 403
        ? "FORBIDDEN"
        : e.status === 404
          ? "NOT_FOUND"
          : e.status === 409
            ? "CONCIERGE_CONFLICT"
            : "CONCIERGE_VALIDATION",
      e.message,
    );
  throw e;
};
async function run<T>(f: () => Promise<T>) {
  try {
    return await f();
  } catch (e) {
    return fail(e);
  }
}
function sniff(buf: Buffer) {
  if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (
    buf.subarray(0, 4).toString() === "RIFF" &&
    buf.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return "";
}
export function registerConciergeRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get(
    "/api/concierge/revision",
    { preHandler: guard("concierge.read") },
    async (_req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      // 管家部自己的同步版本号（整改，见 mutations.ts bumpRevision）
      const [r] =
        await sql`SELECT revision::text AS revision FROM concierge_sync`;
      return { revision: `${r?.revision ?? "0"}:${await nativeRevision(sql,deps.config.timezone)}` };
    },
  );
  app.get(
    "/api/concierge/workspace",
    { preHandler: guard("concierge.read") },
    async (req, reply) =>
      run(async () => {
        reply.header("Cache-Control", "private, no-store");
        return readSnapshot(sql, async (tx) => {
          const data = await readWorkspace(tx, req.actor, deps.config.timezone);
          const ev =
            await tx`SELECT balance_id,upload_id,receipt_id FROM concierge_balance_evidence ORDER BY id`;
          for (const b of data.balances) {
            const own = ev.filter((x) => x.balanceId === b.id);
            b.uploadIds = [
              ...new Set([
                ...b.uploadIds,
                ...own.flatMap((x) => (x.uploadId ? [String(x.uploadId)] : [])),
              ]),
            ];
            b.receiptIds = [
              ...new Set([
                ...b.receiptIds,
                ...own.flatMap((x) =>
                  x.receiptId ? [String(x.receiptId)] : [],
                ),
              ]),
            ];
          }
          return data;
        });
      }),
  );
  app.post(
    "/api/concierge/workspace",
    {
      preHandler: guard("concierge.read", "concierge.operate"),
      bodyLimit: 1024 * 1024,
    },
    async (req) =>
      run(async () => {
        const b = object(req.body);
        return mutate(
          deps,
          req.actor,
          text(b.action, 60, true),
          object(b.payload),
          text(b.requestId, 100, true),
          req.ip,
        );
      }),
  );
  app.get(
    "/api/concierge/receipts/:id",
    { preHandler: guard("concierge.read") },
    async (req, reply) =>
      run(async () => {
        reply.header("Cache-Control", "private, no-store");
        return receiptDetail(sql, text((req.params as any).id, 80, true));
      }),
  );
  app.get(
    "/api/concierge/receipts",
    { preHandler: guard("concierge.read") },
    async (req, reply) =>
      run(async () => {
        reply.header("Cache-Control", "private, no-store");
        const q = object(req.query),
          search = text(q.q, 100),
          offset = Number(q.offset || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
          throw new WorkspaceError("页码不正确");
        const rows =
          await sql`SELECT r.id,r.data - 'rawText' - 'itemsText' - 'items' - 'review' - 'warnings' AS data,r.version,r.created_at,r.updated_at
            FROM concierge_records r LEFT JOIN concierge_members m ON m.id=r.member_id
            LEFT JOIN LATERAL (
              WITH RECURSIVE chain AS (
                SELECT n.id,n.name,n.phone,n.member_no,n.merged_into_id,0 AS depth FROM members n WHERE n.id=m.native_member_id
                UNION ALL SELECT n.id,n.name,n.phone,n.member_no,n.merged_into_id,c.depth+1 FROM members n JOIN chain c ON c.merged_into_id=n.id WHERE c.depth<30
              ) SELECT name,phone,member_no FROM chain WHERE merged_into_id IS NULL LIMIT 1
            ) n ON true
            WHERE r.kind='receipt' AND (${search}='' OR concat(r.data->>'number',' ',r.data->>'store',' ',m.data->>'name',' ',m.data->>'phone',' ',m.data->>'serviceAlias',' ',m.data->>'cardNo',' ',n.name,' ',n.phone,' ',n.member_no) ILIKE ${"%" + search + "%"})
            ORDER BY r.created_at DESC,r.id DESC LIMIT 51 OFFSET ${offset}`;
        return {
          receipts: rows.slice(0, 50).map(briefReceipt),
          hasMore: rows.length > 50,
          offset,
        };
      }),
  );
  app.get(
    "/api/concierge/native-members",
    { preHandler: guard("concierge.read") },
    async (req, reply) =>
      run(async () => {
        reply.header("Cache-Control", "private, no-store");
        const q = text(object(req.query).q, 60);
        return readSnapshot(sql,async tx=>({ members: await searchNativeMembers(tx,q,deps.config.timezone) }));
      }),
  );
  app.get("/api/concierge/native-members/:id", {preHandler:guard("concierge.read")}, async(req,reply)=>run(async()=>{
    reply.header("Cache-Control","private, no-store");
    const id=Number((req.params as any).id);
    if (!Number.isSafeInteger(id) || id<1) throw new WorkspaceError("系统会员编号不正确");
    const member=await readSnapshot(sql,tx=>nativeMemberSummary(tx,id,deps.config.timezone));
    if (!member) throw new WorkspaceError("系统会员不存在",404);
    return {member};
  }));
  app.get(
    "/api/concierge/audits/export",
    { preHandler: guard("concierge.read", "concierge.export") },
    async (req, reply) =>
      run(async () => {
        const q = object(req.query),
          actor = text(q.actor, 80),
          type = text(q.type, 40),
          search = text(q.q, 200),
          from = text(q.from, 10),
          to = text(q.to, 10);
        for (const d of [from, to])
          if (
            d &&
            (!/^\d{4}-\d\d-\d\d$/.test(d) || !Number.isFinite(Date.parse(d)))
          )
            throw new WorkspaceError("日期筛选不正确");
        const start = from
            ? new Date(from + "T00:00:00+08:00").toISOString()
            : null,
          end = to
            ? new Date(
                Date.parse(to + "T00:00:00+08:00") + 86400000,
              ).toISOString()
            : null;
        const [upper] =
          await sql`SELECT coalesce(max(id),0)::text AS id FROM audit_logs`;
        let cursor = upper!.id;
        const cell = (v: unknown) => {
          let s = String(v ?? "");
          if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
          return '"' + s.replaceAll('"', '""') + '"';
        };
        async function* lines() {
          yield "\uFEFF" +
            [
              "时间",
              "操作账号ID",
              "操作人",
              "动作",
              "对象",
              "记录编号",
              "关联会员",
              "原因",
              "变更前",
              "变更后",
            ]
              .map(cell)
              .join(",") +
            "\r\n";
          while (true) {
            const rows =
              await sql`SELECT a.id,a.staff_id,a.target_id,a.detail,a.created_at,m.data->>'name' AS member_name FROM audit_logs a LEFT JOIN concierge_members m ON m.id::text=a.detail->>'memberId' WHERE a.id<=${cursor}::bigint AND a.action IN ('concierge_record','concierge_upload') AND (${actor}='' OR a.staff_id::text=${actor}) AND (${type}='' OR a.detail->>'objectType'=${type}) AND (${search}='' OR a.detail::text ILIKE ${"%" + search + "%"}) AND (${start}::timestamptz IS NULL OR a.created_at>=${start}::timestamptz) AND (${end}::timestamptz IS NULL OR a.created_at<${end}::timestamptz) ORDER BY a.id DESC LIMIT 100`;
            if (!rows.length) break;
            for (const r of rows)
              yield [
                r.createdAt,
                r.staffId,
                r.detail.actorName,
                r.detail.label,
                r.detail.objectType,
                r.targetId,
                r.memberName,
                r.detail.reason,
                JSON.stringify(r.detail.before ?? null),
                JSON.stringify(r.detail.after ?? null),
              ]
                .map(cell)
                .join(",") + "\r\n";
            cursor = String(BigInt(rows.at(-1)!.id) - 1n);
          }
        }
        // 导出留痕（整改：原来两种导出都不记审计；别的模块的导出都记）
        await writeAudit(sql, {
          staffId: req.actor.id,
          action: "concierge_record",
          targetType: "concierge_export",
          detail: {
            actorName: req.actor.displayName,
            label: "导出操作记录",
            objectType: "export",
            filters: { actor, type, q: search, from, to },
          },
          ip: req.ip,
        });
        reply
          .header("Cache-Control", "private, no-store")
          .header(
            "Content-Disposition",
            'attachment; filename="concierge-audit.csv"',
          )
          .type("text/csv; charset=utf-8");
        return reply.send(Readable.from(lines()));
      }),
  );
  app.get(
    "/api/concierge/audits/:id",
    { preHandler: guard("concierge.read") },
    async (req, reply) =>
      run(async () => {
        reply.header("Cache-Control", "private, no-store");
        const id = text((req.params as any).id, 20, true);
        if (!/^[1-9]\d{0,17}$/.test(id))
          throw new WorkspaceError("操作日志不存在", 404);
        const [a] =
          await sql`SELECT id,staff_id,target_type,target_id,detail,created_at FROM audit_logs WHERE id=${id}::bigint AND action IN ('concierge_record','concierge_upload') AND (${can(req.actor, "concierge.manage")} OR staff_id=${req.actor.id})`;
        if (!a) throw new WorkspaceError("操作日志不存在", 404);
        return {
          id: String(a.id),
          actorId: String(a.staffId),
          actorName: a.detail.actorName || "",
          action: a.detail.label || "",
          objectType: a.detail.objectType || a.targetType || "",
          objectId: a.targetId || "",
          memberId: a.detail.memberId || "",
          before: JSON.stringify(a.detail.before ?? null),
          after: JSON.stringify(a.detail.after ?? null),
          reason: a.detail.reason || "",
          createdAt: a.createdAt,
        };
      }),
  );
  app.post(
    "/api/concierge/uploads",
    {
      preHandler: guard("concierge.read", "concierge.operate"),
      bodyLimit: 17 * 1024 * 1024,
    },
    async (req, reply) =>
      run(async () => {
        const b = object(req.body),
          memberId = text(b.memberId, 80),
          files = b.files;
        if (!Array.isArray(files) || !files.length || files.length > 4)
          throw new WorkspaceError("每次请选择1至4张照片");
        let total = 0;
        const inputs = files.map((v) => {
          const f = object(v),
            data = text(f.data, 6 * 1024 * 1024, true);
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data))
            throw new WorkspaceError("照片编码错误");
          const buf = Buffer.from(data, "base64"),
            mime = sniff(buf);
          if (!mime || f.mime !== mime || buf.toString("base64") !== data)
            throw new WorkspaceError("只接受真实JPEG、PNG或WebP照片");
          if (!buf.length || buf.length > 4194304)
            throw new WorkspaceError("每张照片不能超过4MB");
          total += buf.length;
          return {
            buf,
            mime,
            sha: createHash("sha256").update(buf).digest("hex"),
          };
        });
        if (total > 12 * 1024 * 1024)
          throw new WorkspaceError("每批照片合计不能超过12MB");
        const uploads = await sql.begin(async (tx) => {
          await moduleLock(tx);
          if (memberId) await requireMember(tx, memberId);
          const result = [];
          for (const i of inputs) {
            await tx`INSERT INTO erp_images(scope,sha256,mime,data,size_bytes,created_by) VALUES('concierge',${i.sha},${i.mime},${i.buf},${i.buf.length},${req.actor.id}) ON CONFLICT(scope,sha256) DO NOTHING`;
            const [image] =
              await tx`SELECT id FROM erp_images WHERE scope='concierge' AND sha256=${i.sha}`;
            const [old] =
              await tx`SELECT id,created_at FROM concierge_uploads WHERE image_id=${image!.id} AND member_id IS NOT DISTINCT FROM ${memberId || null}::uuid`;
            let id = old?.id,
              createdAt = old?.createdAt;
            if (!old) {
              id = randomUUID();
              const [saved] =
                await tx`INSERT INTO concierge_uploads(id,member_id,image_id,created_by) VALUES(${id},${memberId || null},${image!.id},${req.actor.id}) RETURNING created_at`;
              createdAt = saved!.createdAt;
              await bumpRevision(tx);
              await writeAudit(tx, {
                staffId: req.actor.id,
                action: "concierge_upload",
                targetType: "concierge_upload",
                targetId: id,
                detail: {
                  actorName: req.actor.displayName,
                  label: "上传管家凭证",
                  objectType: "upload",
                  memberId,
                  size: i.buf.length,
                  sha256: i.sha,
                },
                ip: req.ip,
              });
            }
            result.push({
              id: String(id),
              memberId,
              mime: i.mime,
              size: i.buf.length,
              sha256: i.sha,
              createdAt,
              createdByName: req.actor.displayName,
            });
          }
          return result;
        });
        reply.code(201);
        return { uploads };
      }),
  );
  app.get(
    "/api/concierge/uploads/:id",
    { preHandler: guard("concierge.read") },
    async (req, reply) =>
      run(async () => {
        const id = text((req.params as any).id, 80, true);
        const [r] =
          await sql`SELECT i.data,i.mime FROM concierge_uploads u JOIN erp_images i ON i.id=u.image_id AND i.scope='concierge' WHERE u.id=${uuid(id)}::uuid`;
        if (!r) throw new WorkspaceError("凭证照片不存在", 404);
        reply
          .header("Cache-Control", "private, no-store")
          .header("Content-Disposition", "inline")
          .type(r.mime);
        return reply.send(r.data);
      }),
  );
  app.get(
    "/api/concierge/ops/:id",
    { preHandler: guard("concierge.read") },
    async (req) =>
      run(async () => {
        const id = text((req.params as any).id, 100, true);
        const [row] =
          await sql`SELECT response,abandoned FROM concierge_operations WHERE actor_id=${req.actor.id} AND request_id=${id}`;
        return row ? { found: true, ...row } : { found: false };
      }),
  );
  app.post(
    "/api/concierge/ops/:id/abandon",
    { preHandler: guard("concierge.read", "concierge.operate") },
    async (req) =>
      run(async () => {
        const id = text((req.params as any).id, 100, true);
        return sql.begin(async (tx) => {
          await moduleLock(tx);
          const [old] =
            await tx`SELECT response,abandoned FROM concierge_operations WHERE actor_id=${req.actor.id} AND request_id=${id}`;
          if (old) return { found: true, ...old };
          await tx`INSERT INTO concierge_operations(actor_id,request_id,request_hash,abandoned) VALUES(${req.actor.id},${id},'',true)`;
          await writeAudit(tx, {
            staffId: req.actor.id,
            action: "concierge_record",
            targetType: "concierge_operation",
            targetId: id,
            detail: {
              actorName: req.actor.displayName,
              label: "确认不再执行",
              requestId: id,
            },
            ip: req.ip,
          });
          return { found: true, abandoned: true };
        });
      }),
  );
  app.get(
    "/api/concierge/backup",
    { preHandler: guard("concierge.read", "concierge.export") },
    async (req, reply) =>
      run(async () => {
        const backup = await readSnapshot(sql, async (tx) => {
          const [size] =
            await tx`SELECT coalesce(sum(i.size_bytes),0)::bigint AS total FROM concierge_uploads u JOIN erp_images i ON i.id=u.image_id`;
          if (size!.total > 20 * 1024 * 1024)
            throw new WorkspaceError(
              "原图超过20MB，模块JSON导出不能完整打包，请使用企业数据库备份",
            );
          const names = [
            "concierge_members",
            "concierge_records",
            "concierge_uploads",
            "concierge_revisions",
            "concierge_operations",
            "concierge_balance_evidence",
          ];
          const tables: Record<string, unknown> = {};
          for (const name of names)
            tables[name] = await tx.unsafe(`SELECT * FROM ${name}`);
          const images =
            await tx`SELECT DISTINCT i.id,i.mime,i.sha256,i.size_bytes,encode(i.data,'base64') AS data FROM erp_images i JOIN concierge_uploads u ON u.image_id=i.id WHERE i.scope='concierge'`;
          return {
            format: "yuzu-concierge-8.0.12",
            exportedAt: new Date().toISOString(),
            tables,
            images,
          };
        });
        await writeAudit(sql, {
          staffId: req.actor.id,
          action: "concierge_record",
          targetType: "concierge_export",
          detail: {
            actorName: req.actor.displayName,
            label: "导出模块备份（含原图）",
            objectType: "export",
            images: (backup.images as unknown[]).length,
          },
          ip: req.ip,
        });
        reply.header("Cache-Control", "private, no-store");
        return backup;
      }),
  );
}
