import { useEffect, useState } from "react";
import { money } from "./format";
import { liveRefresh } from "./live";
import { api } from "../../lib/api";
import { useCan } from "../../lib/session";
import type {
  Member,
  NativeMemberSummary,
  NativeResourceOption,
  Appointment,
  Balance,
} from "./types";

export const memberGrade = (m: Member) =>
  m.nativeMember?.gradeLabel ||
  (m.nativeMemberId ? "系统档阶暂不可用" : "待关联系统会员");
export const resourceLabel = (a: Appointment) =>
  a.nativeResource?.label || a.resource || a.resourceGroup || "";
export function currentBalance(m: Member, _manual?: Balance): number | null {
  return m.nativeMember ? m.nativeMember.totalCents : null;
}
export function balanceGroupOf(m: Member, manual?: Balance) {
  const value = currentBalance(m, manual);
  return value == null ? "unknown" : value < 3000000 ? "low" : "normal";
}
export function uniqueMembers(members: Member[]) {
  const seen = new Set<string>();
  return members.filter((m) => {
    const key = m.nativeMember
      ? `native:${m.nativeMember.id}`
      : `local:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A narrow live query, shared by enrollment and the department's member lookup. */
function useMembers(q: string) {
  const [data, setData] = useState<NativeMemberSummary[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true,
      inFlight = false;
    const run = async () => {
      if (!live || inFlight || document.hidden || !navigator.onLine) return;
      inFlight = true;
      setLoading(true);
      try {
        const r = await api.get<{ members: NativeMemberSummary[] }>(
          `/api/concierge/native-members?q=${encodeURIComponent(q.trim())}`,
        );
        if (live) {
          setData(r.members);
          setError("");
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        inFlight = false;
        if (live) setLoading(false);
      }
    };
    setData([]);
    const debounce = window.setTimeout(() => void run(), 250);
    const wake = () => void run();
    const stopLive = liveRefresh(wake, 30_000);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false;
      clearTimeout(debounce);
      stopLive();
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [q, refresh]);
  return { data, error, loading, refresh: () => setRefresh((x) => x + 1) };
}

function Summary({ member: m }: { member: NativeMemberSummary }) {
  return (
    <span className="native-member-summary">
      <strong>
        {m.name} · {m.memberNo}
      </strong>
      <span>
        {m.phone} · {m.gradeLabel}
        {m.status !== "active" ? " · 已停用" : ""}
      </span>
      <span>
        系统余额 ¥{money(m.totalCents)}（本金 ¥{money(m.principalCents)}
        ＋可用赠金 ¥{money(m.bonusCents)}）
      </span>
      {m.profiles.length > 1 && (
        <small className="orange-text">
          同一会员有多份历史服务档案；余额和人数已去重，历史分别保留。
        </small>
      )}
    </span>
  );
}

export function SystemMemberResults({
  query,
  onOpen,
  onCreate,
}: {
  query: string;
  onOpen: (id: string) => void;
  onCreate: (m: NativeMemberSummary) => void;
}) {
  const lookup = useMembers(query);
  return (
    <section className="panel native-member-search" aria-label="系统会员查询">
      <div className="panel-heading">
        <div>
          <h2>系统会员 · 前台统一建档</h2>
          <p>
            {query
              ? "与会员工作台使用同一查找规则。"
              : "显示近期系统会员；输入姓名、手机号、会员号或刷实体卡可查找。"}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary small-btn"
          onClick={lookup.refresh}
        >
          刷新系统会员
        </button>
      </div>
      {lookup.error && (
        <p role="alert" className="orange-text">
          {lookup.error}
        </p>
      )}
      {!lookup.error && lookup.loading && !lookup.data.length && (
        <p role="status">正在查找系统会员…</p>
      )}
      {!lookup.loading && !lookup.error && !lookup.data.length && (
        <p>没有匹配的系统会员，请先由前台核对或办理。</p>
      )}
      {lookup.data.map((m) => (
        <div key={m.id} className="native-member-row">
          <Summary member={m} />
          <span className="native-member-actions">
            {m.profiles.length ? (
              m.profiles.map((p) => (
                <button
                  type="button"
                  className="btn btn-secondary small-btn"
                  key={p.id}
                  onClick={() => onOpen(p.id)}
                >
                  打开服务档案 {p.code}
                </button>
              ))
            ) : (
              <button
                type="button"
                className="btn btn-primary small-btn"
                disabled={m.status !== "active"}
                onClick={() => onCreate(m)}
              >
                建立服务档案
              </button>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}

export function MemberIdentityFields({
  member,
  initialNative,
}: {
  member?: Member;
  initialNative?: NativeMemberSummary;
}) {
  const can = useCan();
  const [native, setNative] = useState<NativeMemberSummary | null>(
    initialNative || member?.nativeMember || null,
  );
  const [id, setId] = useState<string>(
    String(member?.nativeMemberId || initialNative?.id || ""),
  );
  const [q, setQ] = useState(""),
    [legacyName, setLegacyName] = useState(member?.name || ""),
    [legacyPhone, setLegacyPhone] = useState(member?.phone || ""),
    [detailError, setDetailError] = useState("");
  const lookup = useMembers(q);
  useEffect(() => {
    if (!id) return;
    let live = true,
      inFlight = false;
    const run = async () => {
      if (!live || inFlight || document.hidden || !navigator.onLine) return;
      inFlight = true;
      try {
        const r = await api.get<{ member: NativeMemberSummary }>(
          `/api/concierge/native-members/${id}`,
        );
        if (live) {
          setNative((old) =>
            JSON.stringify(old) === JSON.stringify(r.member) ? old : r.member,
          );
          setDetailError("");
        }
      } catch (e) {
        if (live) setDetailError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void run();
    const wake = () => void run();
    const stopLive = liveRefresh(wake, 10_000);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      live = false;
      stopLive();
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [id]);
  function select(m: NativeMemberSummary) {
    setNative(m);
    setId(
      String(member?.nativeMember?.id === m.id ? member.nativeMemberId : m.id),
    );
  }
  return (
    <>
      <div className="field field-wide">
        <label htmlFor="concierge-native-query">选择系统会员 *</label>
        <div className="inline-form">
          <input
            id="concierge-native-query"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                lookup.refresh();
              }
            }}
            placeholder="姓名、手机号、会员号或实体卡号"
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={lookup.refresh}
          >
            查找
          </button>
        </div>
        <input type="hidden" name="nativeMemberId" value={id} />
        {native && (
          <div className="native-selected">
            <Summary member={native} />
            {Number(id) !== native.id && (
              <small>
                原关联已合并，现读取主会员 {native.memberNo}；原服务记录保留。
              </small>
            )}
            {can("member.read") && (
              <a href={`/?m=${native.id}`} target="_blank" rel="noreferrer">
                查看会员工作台
              </a>
            )}
          </div>
        )}
        {(lookup.error || detailError) && (
          <small role="alert">{detailError || lookup.error}</small>
        )}
        {lookup.loading && !lookup.data.length && (
          <small role="status">正在查找…</small>
        )}
        {!lookup.loading && !lookup.error && !lookup.data.length && (
          <small>没有匹配会员，请由前台核对或办理。</small>
        )}
        <div className="native-member-options">
          {lookup.data.map((m) => {
            const other = m.profiles.filter((p) => p.id !== member?.id);
            return (
              <button
                key={m.id}
                type="button"
                className={`native-member-option ${native?.id === m.id ? "is-selected" : ""}`}
                disabled={m.status !== "active" || other.length > 0}
                onClick={() => select(m)}
              >
                <span>
                  {m.name} · {m.memberNo} · {m.phone}
                </span>
                <small>
                  {m.gradeLabel}
                  {other.length
                    ? ` · 已有服务档案 ${other.map((p) => p.code).join("、")}`
                    : m.status !== "active"
                      ? " · 已停用"
                      : ""}
                </small>
              </button>
            );
          })}
        </div>
        <small>
          前台统一办理会员；这里建立服务档案，资料、档阶及余额自动同步。
        </small>
      </div>
      <label className="field">
        <span>系统会员姓名 *</span>
        <input
          name="name"
          required
          value={native?.name ?? legacyName}
          readOnly={!!id || !member}
          onChange={(e) => setLegacyName(e.target.value)}
          maxLength={60}
        />
      </label>
      <label className="field">
        <span>系统手机号</span>
        <input
          name="phone"
          type="tel"
          value={native?.phone ?? legacyPhone}
          readOnly={!!id || !member}
          onChange={(e) => setLegacyPhone(e.target.value)}
          maxLength={30}
        />
      </label>
      <label className="field">
        <span>接待称呼（选填）</span>
        <input
          name="serviceAlias"
          defaultValue={member?.serviceAlias}
          maxLength={60}
          placeholder="例如：张总；不更改系统姓名"
        />
      </label>
      <label className="field">
        <span>原收银卡号（选填）</span>
        <input
          name="cardNo"
          defaultValue={member?.cardNo}
          maxLength={60}
          placeholder="历史卡号备注，与系统会员号分开"
        />
      </label>
      <div className="field field-wide">
        <span>系统档阶（自动同步）</span>
        <strong>{native?.gradeLabel || "请先选择系统会员"}</strong>
        {member?.cardTier && (
          <small>原人工级别备注：{member.cardTier}；不作为现行系统档阶。</small>
        )}
      </div>
      <input type="hidden" name="cardTier" value={member?.cardTier || ""} />
    </>
  );
}

export function ResourceFields({
  options,
  appointment,
}: {
  options: NativeResourceOption[];
  appointment?: Appointment;
}) {
  const selected = options.find((r) => r.key === appointment?.resourceKey);
  const [category, setCategory] = useState(
    selected?.category ||
      appointment?.resourceCategory ||
      (appointment?.service ? "legacy" : "arrival"),
  );
  const [group, setGroup] = useState(
    selected?.group || appointment?.resourceGroup || "",
  );
  const [key, setKey] = useState(appointment?.resourceKey || "");
  const [custom, setCustom] = useState(appointment?.service || "");
  const categories = [
    ...new Map(
      options
        .filter((r) => r.active || r.key === key || (!key && r.category === appointment?.resourceCategory))
        .map((r) => [r.category, r.categoryLabel]),
    ).entries(),
  ];
  const groups = [
    ...new Set(
      options
        .filter((r) => r.category === category && (r.active || r.key === key || (!key && r.group === appointment?.resourceGroup)))
        .map((r) => r.group),
    ),
  ];
  const current = options.find((r) => r.key === key);
  useEffect(() => {
    if (current) {
      setCategory(current.category);
      setGroup(current.group);
    }
  }, [key, current?.category, current?.group]);
  const choices = options.filter(
    (r) =>
      r.category === category &&
      r.group === group &&
      (r.active || r.key === key),
  );
  const service =
    category === "arrival"
      ? "到店接待"
      : category === "legacy"
        ? appointment?.service || ""
        : category === "other"
          ? custom
          : categories.find((x) => x[0] === category)?.[1] || "";
  const legacyResource =
    category === "legacy" ? appointment?.resource || "" : "";
  return (
    <>
      <label className="field">
        <span>接待需求 *</span>
        <select
          aria-label="接待需求"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setGroup("");
            setKey("");
          }}
        >
          <option value="arrival">到店接待</option>
          {categories.map(([k, label]) => (
            <option value={k} key={k}>
              {label}
            </option>
          ))}
          <option value="other">其他需求</option>
          {appointment?.service && !appointment.resourceKey && !appointment.resourceCategory && (
            <option value="legacy">原记录：{appointment.service}</option>
          )}
        </select>
      </label>
      <input type="hidden" name="service" value={service} />
      <input type="hidden" name="resourceKey" value={key} />
      <input
        type="hidden"
        name="resourceCategory"
        value={categories.some((x) => x[0] === category) ? category : ""}
      />
      <input
        type="hidden"
        name="resourceGroup"
        value={categories.some((x) => x[0] === category) ? group : ""}
      />
      <input
        type="hidden"
        name="resource"
        value={
          key ? current?.label || appointment?.resource || "" : legacyResource
        }
      />
      {category === "other" && (
        <label className="field">
          <span>其他需求说明 *</span>
          <input
            required
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            maxLength={100}
          />
        </label>
      )}
      {categories.some((x) => x[0] === category) && (
        <>
          <label className="field">
            <span>区域 / 规格</span>
            <select
              aria-label="区域 / 规格"
              value={group}
              onChange={(e) => {
                setGroup(e.target.value);
                setKey("");
              }}
            >
              <option value="">选择系统区域或房型</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-wide">
            <span>包间 / 房间</span>
            <select
              aria-label="包间 / 房间"
              value={key}
              disabled={!group}
              onChange={(e) => setKey(e.target.value)}
            >
              <option value="">暂不指定具体资源</option>
              {choices.map((r) => (
                <option key={r.key} value={r.key} disabled={!r.active}>
                  {r.name}
                  {!r.active ? " · 已停用" : ""}
                </option>
              ))}
            </select>
          </label>
          {!groups.length && (
            <small className="field-wide">
              该区域暂无可安排资源，请先由区域负责人维护系统台账。
            </small>
          )}
        </>
      )}
      {category === "legacy" && (
        <p className="field-wide">
          原区域记录：{appointment?.resource || "未指定"}
          。选择上面的系统区域后，可关联具体资源。
        </p>
      )}
      {(current?.warning || current?.active === false) && (
        <p role="status" className="field-wide orange-text">
          {current?.active === false
            ? "原资源已停用；可以取消、完成或保留原安排补说明。 "
            : ""}
          {current?.warning}
        </p>
      )}
      {key && (
        <small className="field-wide">
          {current?.label || appointment?.resource}
          。具体占用仍须在原系统预约、开房、开台或派钟流程核实；此处不自动锁房。
        </small>
      )}
    </>
  );
}
