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
/** 正在发、还没有答复的操作编号：这些不算「结果待确认」（整改：原来请求一发出去，页面上方就闪「结果待确认 · 1笔」，还能点重试、作废） */
const inFlight = new Set<string>();
/** 本机缓存的凭证明细变过几次：工作区没变、明细变了，页面也要更新 */
let receiptStamp = 0;
let seenStamp = -1;
const key = () => `yuzu:concierge:pending:${actorId}`;
export function setConciergeActor(id: number) {
  if (actorId !== String(id)) {
    actorId = String(id);
    cached = undefined;
    revision = "";
    receiptCache.clear();
    inFlight.clear();
    receiptStamp += 1;
  }
}
export function pendingRequests(): Pending[] {
  if (!actorId) return [];
  try {
    const list = JSON.parse(localStorage.getItem(key()) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
/** 结果确实不明、要人处理的那几笔（不含正在发的） */
export function unresolvedPending(): Pending[] {
  return pendingRequests().filter(
    (p) => p.uncertain && !inFlight.has(p.requestId),
  );
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
  try {
    localStorage.setItem(key(), JSON.stringify(list));
  } catch {
    // 记录清不掉不影响已经成功的这一笔：留着的那条之后可以「查回结果」再清
  }
  changed();
}
export async function retryPending(value: Pending) {
  // 原样重提：只发原来的三样（操作、内容、编号），不带本机记的时间与标记
  inFlight.add(value.requestId);
  changed();
  try {
    const result = await api.post("/api/concierge/workspace", {
      action: value.action,
      payload: value.payload,
      requestId: value.requestId,
    });
    forgetPending(value.requestId);
    cached = undefined;
    return result;
  } finally {
    inFlight.delete(value.requestId);
    changed();
  }
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
  receiptStamp += 1;
  if (receiptCache.size > 20)
    receiptCache.delete(receiptCache.keys().next().value!);
  return receipt;
}
export function rememberReceipt(receipt: Receipt) {
  receiptCache.set(receipt.id, receipt);
  receiptStamp += 1;
}
/**
 * 取工作区：先比同步版本号，没变就不重新取。changed = 这次的内容与上次给出去的不一样
 * （页面据此决定要不要重新渲染：原来每 3 秒不管变没变都整个换一遍，开着的编辑器跟着重算）。
 */
export async function loadWorkspace(force = false): Promise<{
  data: WorkspaceData;
  changed: boolean;
}> {
  const rev = await api.get<{ revision: string }>("/api/concierge/revision");
  const fetched = force || !cached || revision !== rev.revision;
  if (fetched) {
    cached = await api.get<WorkspaceData>("/api/concierge/workspace");
    revision = rev.revision;
  }
  const data = cached!;
  const stale = seenStamp !== receiptStamp;
  if (fetched || stale) {
    data.receipts = data.receipts.map((r) => {
      const full = receiptCache.get(r.id);
      return full?.version === r.version ? full : r;
    });
    for (const [id, detail] of receiptCache)
      if (!data.receipts.some((r) => r.id === id)) data.receipts.push(detail);
    seenStamp = receiptStamp;
  }
  return { data, changed: fetched || stale };
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
  if (url === "/api/concierge/workspace" && method === "GET")
    return response((await loadWorkspace()).data);
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
    // 还有别的操作结果待确认时，不发新的写入（整改）：原来关掉弹窗重新填一遍就是一个新编号，
    // 超时的那笔其实成功了的话，会多建一位会员、多记一条余额。先把上面那几笔查回、原样重试或确认不再执行。
    const blocking = unresolvedPending().filter(
      (p) => p.requestId !== body.requestId,
    );
    if (blocking.length)
      throw new Error(
        `还有${blocking.length}笔操作结果待确认，请先在页面上方查回、原样重试或确认不再执行，再继续录入；本次尚未发送。`,
      );
    const operation: Pending = {
      ...body,
      createdAt: previous?.createdAt || new Date().toISOString(),
      uncertain: !!previous?.uncertain,
    };
    putPending(operation);
    inFlight.add(operation.requestId);
    changed();
    try {
      const result = await request<{ id: string }>(method, url, body);
      forgetPending(operation.requestId);
      cached = undefined;
      return response(result);
    } catch (e) {
      if (e instanceof ApiError && e.status < 500 && !operation.uncertain)
        forgetPending(operation.requestId);
      else {
        try {
          putPending({ ...operation, uncertain: true });
        } catch {
          // 发之前已经存下并读回过这条记录；这里再写不进去时原来那条还在，不拿「尚未发送」盖掉真正的错误
        }
      }
      if (e instanceof UncertainError)
        throw new Error(
          "结果待确认：请保留原单，使用上方操作编号查回或原样重试，不能再次新建同一笔。",
        );
      throw e;
    } finally {
      inFlight.delete(operation.requestId);
      changed();
    }
  }
  return response(
    await request(method, url, body, {
      timeoutMs: url.endsWith("/backup") ? 60000 : 15000,
    }),
  );
}
