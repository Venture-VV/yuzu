import { api, request, ApiError, UncertainError } from "../../lib/api";
import type { WorkspaceData, Receipt } from "./types";
export type Pending = {
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: string;
  uncertain?: boolean;
};
let actorId = "";
let cached: WorkspaceData | undefined;
let revision = "";
const receiptCache = new Map<string, Receipt>();
const key = () => `yuzu:concierge:pending:${actorId}`;
export function setConciergeActor(id: number) {
  if (actorId !== String(id)) {
    actorId = String(id);
    cached = undefined;
    revision = "";
    receiptCache.clear();
  }
}
export function pendingRequests(): Pending[] {
  if (!actorId) return [];
  try {
    return JSON.parse(localStorage.getItem(key()) || "[]");
  } catch {
    return [];
  }
}
function changed() {
  window.dispatchEvent(new Event("concierge-pending-changed"));
}
function putPending(value: Pending) {
  const list = pendingRequests().filter((p) => p.requestId !== value.requestId);
  list.push(value);
  try {
    localStorage.setItem(key(), JSON.stringify(list));
    const saved = JSON.parse(localStorage.getItem(key()) || "[]") as Pending[];
    if (
      !saved.some(
        (p) =>
          p.requestId === value.requestId &&
          JSON.stringify(p.payload) === JSON.stringify(value.payload),
      )
    )
      throw new Error("not durable");
  } catch {
    throw new Error("设备无法保存操作编号，请先释放存储空间；本次尚未发送。");
  }
  changed();
}
export function forgetPending(id: string) {
  const list = pendingRequests().filter((p) => p.requestId !== id);
  localStorage.setItem(key(), JSON.stringify(list));
  changed();
}
export async function retryPending(value: Pending) {
  const result = await api.post("/api/concierge/workspace", value);
  forgetPending(value.requestId);
  cached = undefined;
  return result;
}
export async function checkPending(id: string) {
  return api.get<{
    found: boolean;
    response?: { id: string };
    abandoned?: boolean;
  }>(`/api/concierge/ops/${encodeURIComponent(id)}`);
}
export async function abandonPending(id: string) {
  const result = await api.post<{
    found: boolean;
    response?: { id: string };
    abandoned?: boolean;
  }>(`/api/concierge/ops/${encodeURIComponent(id)}/abandon`);
  forgetPending(id);
  cached = undefined;
  return result;
}
export async function loadReceipt(id: string) {
  const receipt = await api.get<Receipt>(
    `/api/concierge/receipts/${encodeURIComponent(id)}`,
  );
  receiptCache.set(id, receipt);
  if (receiptCache.size > 20)
    receiptCache.delete(receiptCache.keys().next().value!);
  return receipt;
}
export function rememberReceipt(receipt: Receipt) {
  receiptCache.set(receipt.id, receipt);
}
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
async function base64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
/** Adapter keeps the verified receipt UI while all requests use yuzu's auth/error/uncertain-result handling. */
export async function conciergeFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (
    url.startsWith("/api/concierge/uploads/") &&
    (!init.method || init.method === "GET")
  )
    return window.fetch(url, { ...init, credentials: "same-origin" });
  const method = (init.method || "GET") as "GET" | "POST" | "PUT";
  if (url === "/api/concierge/workspace" && method === "GET") {
    const rev = await api.get<{ revision: string }>("/api/concierge/revision");
    if (!cached || revision !== rev.revision) {
      const next = await api.get<WorkspaceData>(url);
      next.receipts = next.receipts.map((r) => {
        const detail = receiptCache.get(r.id);
        return detail?.version === r.version ? detail : r;
      });
      for (const [id, detail] of receiptCache)
        if (!next.receipts.some((r) => r.id === id)) next.receipts.push(detail);
      cached = next;
      revision = rev.revision;
    }
    cached.receipts = cached.receipts.map((r) => {
      const full = receiptCache.get(r.id);
      return full?.version === r.version ? full : r;
    });
    for (const [id, detail] of receiptCache)
      if (!cached.receipts.some((r) => r.id === id))
        cached.receipts.push(detail);
    return response(cached);
  }
  if (init.body instanceof FormData) {
    const form = init.body,
      files = form.getAll("files") as File[];
    if (files.length > 4) throw new Error("每次最多上传4张照片");
    const result = await api.post(
      url,
      {
        memberId: String(form.get("memberId") || ""),
        files: await Promise.all(
          files.map(async (f) => ({ mime: f.type, data: await base64(f) })),
        ),
      },
      { timeoutMs: 60000 },
    );
    cached = undefined;
    return response(result);
  }
  const body =
    typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  if (url === "/api/concierge/workspace" && method === "POST") {
    const previous = pendingRequests().find(
      (p) => p.requestId === body.requestId,
    );
    const operation: Pending = {
      ...body,
      createdAt: previous?.createdAt || new Date().toISOString(),
      uncertain: !!previous,
    };
    putPending(operation);
    try {
      const result = await request<{ id: string }>(method, url, body);
      forgetPending(operation.requestId);
      cached = undefined;
      return response(result);
    } catch (e) {
      if (e instanceof ApiError && e.status < 500 && !operation.uncertain)
        forgetPending(operation.requestId);
      else putPending({ ...operation, uncertain: true });
      if (e instanceof UncertainError)
        throw new Error(
          "结果待确认：请保留原单，使用上方操作编号查回或原样重试，不能再次新建同一笔。",
        );
      throw e;
    }
  }
  return response(
    await request(method, url, body, {
      timeoutMs: url.endsWith("/backup") ? 60000 : 15000,
    }),
  );
}
