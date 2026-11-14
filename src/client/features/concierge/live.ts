// 管家部各处只读小查询的刷新节奏（8.0.18 整合）。
// 原来每个部件各自 3 秒轮询一遍自己的接口（会员名单那一条每次要读全部会员与到访）。
// 现在只有工作区那一条 3 秒的同步在跑（只取版本号与指纹，几毫秒）：它发现有变就发 REVISION_EVENT，
// 各部件听到再取；指纹管不到的（没建服务档案的会员、别人的到访）另按慢一些的间隔自己刷新。
// 进页面、回到页面、重新联网时照旧各自马上取一次。

export const REVISION_EVENT = "concierge-revision-changed";

/** 工作区的同步发现版本号或指纹变了 */
export function announceRevision() {
  window.dispatchEvent(new Event(REVISION_EVENT));
}

/** 听同步的变化，另加一个慢速的定时刷新；返回收尾函数 */
export function liveRefresh(run: () => void, everyMs = 30_000): () => void {
  const timer = window.setInterval(run, everyMs);
  window.addEventListener(REVISION_EVENT, run);
  return () => {
    clearInterval(timer);
    window.removeEventListener(REVISION_EVENT, run);
  };
}
