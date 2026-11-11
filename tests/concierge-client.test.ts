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
  loadWorkspace,
  unresolvedPending,
  retryPending,
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
  // ── 主线整改（docs/HANDOFF_V8012.md）──
  it("正在发的请求不算「结果待确认」；没有明确结果以后才算", async () => {
    let seenWhileSending = -1;
    mocks.request.mockImplementationOnce(async () => {
      // 请求在路上：本机已经记下（发之前存的），但不显示成待确认
      expect(pendingRequests()).toHaveLength(1);
      seenWhileSending = unresolvedPending().length;
      throw new UncertainError("timeout");
    });
    await expect(
      conciergeFetch("/api/concierge/workspace", input()),
    ).rejects.toThrow("结果待确认");
    expect(seenWhileSending).toBe(0);
    expect(unresolvedPending().map((p) => p.requestId)).toEqual(["original-id"]);
  });
  it("有一笔结果待确认时，不发新的写入（换个编号重新填一遍也不行）；原编号原样重试可以", async () => {
    mocks.request.mockRejectedValueOnce(new UncertainError("timeout"));
    await expect(
      conciergeFetch("/api/concierge/workspace", input()),
    ).rejects.toThrow();
    mocks.request.mockClear();
    const again = {
      method: "POST",
      body: JSON.stringify({
        requestId: "second-id",
        action: "createMember",
        payload: { name: "合成客户", cardNo: "QA" },
      }),
    };
    await expect(
      conciergeFetch("/api/concierge/workspace", again),
    ).rejects.toThrow("尚未发送");
    expect(mocks.request).not.toHaveBeenCalled();
    expect(pendingRequests().map((p) => p.requestId)).toEqual(["original-id"]);
    // 原编号、原内容重试：照常发；成功以后清掉，别的写入恢复
    mocks.request.mockResolvedValueOnce({ id: "m1" });
    await conciergeFetch("/api/concierge/workspace", input());
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(unresolvedPending()).toHaveLength(0);
    mocks.request.mockResolvedValueOnce({ id: "m2" });
    await conciergeFetch("/api/concierge/workspace", again);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
  it("待确认面板的「原样重试」只发原来的操作、内容与编号", async () => {
    mocks.request.mockRejectedValueOnce(new UncertainError("timeout"));
    await expect(
      conciergeFetch("/api/concierge/workspace", input()),
    ).rejects.toThrow();
    mocks.post.mockResolvedValueOnce({ id: "m1" });
    await retryPending(unresolvedPending()[0]!);
    expect(mocks.post).toHaveBeenCalledWith("/api/concierge/workspace", {
      action: "createMember",
      payload: { name: "合成客户", cardNo: "QA" },
      requestId: "original-id",
    });
    expect(pendingRequests()).toHaveLength(0);
  });
  it("同步版本号没变：不重新取工作区、告诉页面没有变化；取到凭证明细以后算有变化", async () => {
    const full = { id: "r1", version: 1, rawText: "原文", items: [{ name: "项目" }] };
    let rev = "7";
    mocks.get.mockImplementation(async (url: string) =>
      url.endsWith("/revision")
        ? { revision: rev }
        : url.endsWith("/receipts/r1")
          ? full
          : { receipts: [{ id: "r1", version: 1 }] },
    );
    const first = await loadWorkspace();
    expect(first.changed).toBe(true);
    const second = await loadWorkspace();
    expect(second.changed).toBe(false);
    expect(second.data).toBe(first.data);
    expect(mocks.get.mock.calls.filter((c) => c[0] === "/api/concierge/workspace")).toHaveLength(1);
    await loadReceipt("r1");
    const third = await loadWorkspace();
    expect(third.changed).toBe(true);
    expect(third.data.receipts[0]).toEqual(full);
    expect((await loadWorkspace()).changed).toBe(false);
    rev = "8";
    expect((await loadWorkspace()).changed).toBe(true);
    expect(mocks.get.mock.calls.filter((c) => c[0] === "/api/concierge/workspace")).toHaveLength(2);
  });
  it("本机存的待确认记录不是数组（被别的东西写坏）时当作没有，不让页面崩掉", () => {
    storage.set(`yuzu:concierge:pending:${actor}`, JSON.stringify({ broken: true }));
    expect(pendingRequests()).toEqual([]);
    expect(unresolvedPending()).toEqual([]);
  });
});
