import { useEffect, useState } from "react";
import { money, stamp } from "./format";
import { liveRefresh } from "./live";
import { api } from "../../lib/api";
import type { NativeSpendingPage, Member } from "./types";
const time = (s: string) => stamp(s);
export function NativeSpendingList({ member }: { member: Member }) {
  const [page, setPage] = useState(0),
    [data, setData] = useState<NativeSpendingPage | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true,
      inFlight = false;
    setData(null);
    setError("");
    setLoading(true);
    const run = async () => {
      if (!live || inFlight || document.hidden || !navigator.onLine) return;
      inFlight = true;
      try {
        const result = await api.get<NativeSpendingPage>(
          `/api/concierge/members/${member.id}/spending?offset=${page * 50}`,
        );
        if (live) {
          setData((old) =>
            old &&
            JSON.stringify(old.records) === JSON.stringify(result.records) &&
            old.hasMore === result.hasMore
              ? old
              : result,
          );
          setError("");
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        inFlight = false;
        if (live) setLoading(false);
      }
    };
    void run();
    const wake = () => void run();
    const stopLive = liveRefresh(wake, 15_000);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false;
      stopLive();
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [member.id, page, refresh]);
  if (!member.nativeMemberId)
    return (
      <p className="detail-notice">
        关联前台系统会员后，这里同步显示系统储值扣费明细。
      </p>
    );
  return (
    <section className="native-spending" aria-label="系统储值扣费">
      <div className="panel-header">
        <h3>系统储值扣费</h3>
        <button
          type="button"
          className="text-btn"
          onClick={() => setRefresh((n) => n + 1)}
        >
          刷新扣费记录
        </button>
      </div>
      <p className="detail-notice">
        自动同步会员系统的实际扣卡单；已撤销保留原单。结账整单项目作消费依据，本会员扣款单独列示，不重复扣款。
      </p>
      {error && (
        <p role="alert" className="orange-text">
          扣费记录同步失败：{error}。请重试，当前列表可能未更新。
        </p>
      )}
      {loading && !data && <p role="status">正在读取系统扣费记录…</p>}
      {data && !data.records.length && !error && (
        <p>暂无系统储值扣费记录。现金等未扣会员钱包的支付不列入本区。</p>
      )}
      {data?.records.map((r) => (
        <article className="history-item native-spending-record" key={r.id}>
          <div className="history-top">
            <strong>
              {r.docNo} · {r.status === "reversed" ? "已撤销" : "已扣费"}
            </strong>
            <strong className={r.status === "reversed" ? "muted" : ""}>
              ¥{money(r.totalCents)}
            </strong>
          </div>
          <p>
            {time(r.occurredAt)} · 经办：{r.operatorName}
          </p>
          <p>
            本笔扣本金 ¥{money(r.principalCents)} ＋ 赠金 ¥{money(r.bonusCents)}
          </p>
          <small>
            原付款会员：{r.payer.name} · {r.payer.memberNo}
          </small>
          {r.checkout && (
            <p>
              结账单 {r.checkout.number} · 整单金额 ¥
              {money(r.checkout.totalCents)}
              {r.checkout.status === "voided" ? " · 已反结账" : ""}
            </p>
          )}
          {r.reversal && (
            <p className="orange-text">
              撤销单 {r.reversal.number} · {r.reversal.reason}
              。赠金可能涉及到期处理，当前可用金额以系统钱包为准。
            </p>
          )}
          <details>
            <summary>查看消费明细（{r.items.length}项）</summary>
            {r.checkout && (
              <p className="muted small">
                以下为结账时保存的整单项目，可能含其他支付或同行消费；项目合计不等同于本会员扣卡金额。未留存原单价时不反推单价。
              </p>
            )}
            {r.items.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>项目</th>
                      <th>数量</th>
                      <th>原单价</th>
                      <th>项目金额</th>
                      <th>分摊优惠</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((i, k) => (
                      <tr key={k}>
                        <td>
                          {i.name}
                          {i.category && (
                            <small className="cell-sub">{i.category}</small>
                          )}
                        </td>
                        <td>{i.quantity}</td>
                        <td>
                          {i.unitPriceCents == null
                            ? "未留存"
                            : `¥${money(i.unitPriceCents)}`}
                        </td>
                        <td>¥{money(i.amountCents)}</td>
                        <td>¥{money(i.discountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>原单未留存逐项快照，请核对原始结账依据。</p>
            )}
          </details>
        </article>
      ))}
      {data && (
        <div className="table-footer">
          <button
            type="button"
            className="btn btn-secondary small-btn"
            disabled={!page}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </button>
          <span>第{page + 1}页 · 每页最多50笔</span>
          <button
            type="button"
            className="btn btn-secondary small-btn"
            disabled={!data.hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
