import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  request: vi.fn(),
}));
vi.mock("../src/client/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post },
  request: mocks.request,
  ApiError: class ApiError extends Error {
    constructor(public status: number) {
      super("rejected");
    }
  },
  UncertainError: class UncertainError extends Error {},
}));
import { ApiError, UncertainError } from "../src/client/lib/api";
import {
  conciergeFetch,
  pendingRequests,
  setConciergeActor,
  loadReceipt,
} from "../src/client/features/concierge/api";
let actor = 1000;
let storage = new Map<string, string>();
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) || null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
  vi.stubGlobal("window", new EventTarget());
  vi.clearAllMocks();
  setConciergeActor(++actor);
});
const input = () => ({
  method: "POST",
  body: JSON.stringify({
    requestId: "original-id",
    action: "createMember",
    payload: { name: "合成客户", cardNo: "QA" },
  }),
});
describe("管家持久操作编号与按需详情", () => {
  it("本机存储静默失败时禁止发送写请求", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    await expect(
      conciergeFetch("/api/concierge/workspace", input()),
    ).rejects.toThrow("尚未发送");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("曾超时的原编号重提即使409也保留，直到查回或明确停止", async () => {
    mocks.request.mockRejectedValueOnce(new UncertainError("network"));
    await expect(
      conciergeFetch("/api/concierge/workspace", input()),
    ).rejects.toThrow("结果待确认");
    expect(pendingRequests()).toHaveLength(1);
    mocks.request.mockRejectedValueOnce(
      new ApiError(409, "CONFLICT", "rejected"),
    );
    await expect(
      conciergeFetch("/api/concierge/workspace", input()),
    ).rejects.toThrow();
    expect(pendingRequests()[0]?.requestId).toBe("original-id");
  });
  it("首次明确校验失败可清除该编号，不产生假未决", async () => {
    mocks.request.mockRejectedValueOnce(
      new ApiError(400, "VALIDATION", "bad input"),
    );
    await expect(
      conciergeFetch("/api/concierge/workspace", input()),
    ).rejects.toThrow();
    expect(pendingRequests()).toHaveLength(0);
  });
  it("历史第501单的详情在无新版本的轮询后仍保留", async () => {
    const full = {
      id: "old-501",
      version: 2,
      rawText: "旧单全文",
      items: [{ name: "标准项目" }],
    };
    mocks.get.mockImplementation(async (url: string) =>
      url.endsWith("/revision")
        ? { revision: "same" }
        : url.endsWith("/receipts/old-501")
          ? full
          : { receipts: [{ id: "new-1", version: 1 }] },
    );
    await conciergeFetch("/api/concierge/workspace");
    await loadReceipt("old-501");
    const result = await (
      await conciergeFetch("/api/concierge/workspace")
    ).json();
    expect(result.receipts.find((r: any) => r.id === "old-501")).toEqual(full);
  });
  it("近期单据的同版本摘要也被完整明细替换，不能经轮询清空项目", async () => {
    const full = {
      id: "recent-1",
      version: 1,
      rawText: "完整识别原文",
      items: [{ name: "实际识别明细", amountCents: 3200 }],
    };
    mocks.get.mockImplementation(async (url: string) =>
      url.endsWith("/revision")
        ? { revision: "same" }
        : url.endsWith("/receipts/recent-1")
          ? full
          : {
              receipts: [
                { id: "recent-1", version: 1, rawText: "", itemsText: "" },
              ],
            },
    );
    await conciergeFetch("/api/concierge/workspace");
    await loadReceipt("recent-1");
    const result = await (
      await conciergeFetch("/api/concierge/workspace")
    ).json();
    expect(result.receipts[0]).toEqual(full);
  });
});
