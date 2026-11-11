import { useRef, useState } from "react";
import type { CatalogItem } from "./types";
import {
  Check,
  ChevronRight,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
export type SaveCatalog = (
  payload: Record<string, unknown>,
  operationKey: string,
) => Promise<CatalogItem[] | null>;
function aliasesFrom(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

export function CatalogApprovalPanel({
  ocrName,
  initialName,
  packageIncluded = false,
  existing,
  onSave,
  onCancel,
  onApplied,
}: {
  ocrName: string;
  initialName: string;
  packageIncluded?: boolean;
  existing?: CatalogItem;
  onSave: SaveCatalog;
  onCancel: () => void;
  onApplied: (item: CatalogItem, catalog: CatalogItem[]) => void;
}) {
  const [name, setName] = useState(
    existing?.name || (initialName !== ocrName ? initialName : ""),
  );
  const [spec, setSpec] = useState(existing?.spec || "");
  const [code, setCode] = useState(existing?.code || "");
  const [aliases, setAliases] = useState(
    [...new Set([...(existing?.aliases || []), ocrName].filter(Boolean))].join(
      "\n",
    ),
  );
  const [included, setIncluded] = useState(
    existing?.packageIncluded ?? packageIncluded,
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef("");
  async function approve() {
    if (working) return;
    if (!name.trim()) {
      setError("请对照原图填写核准的标准名称；不会直接把OCR错字存成标准名。");
      return;
    }
    setWorking(true);
    setError("");
    operation.current ||= crypto.randomUUID();
    try {
      const fresh = await onSave(
        {
          ...(existing ? { id: existing.id, version: existing.version } : {}),
          name: name.trim(),
          spec: spec.trim(),
          code: code.trim(),
          aliases: aliasesFrom(aliases),
          packageIncluded: included,
          active: true,
        },
        operation.current,
      );
      if (!fresh) {
        setError("名称暂未保存成功，当前小票内容仍保留，请检查提示后重试。");
        return;
      }
      const item = existing
        ? fresh.find((i) => i.id === existing.id)
        : fresh.find(
            (i) => i.active && i.name === name.trim() && i.spec === spec.trim(),
          );
      if (!item) {
        setError("名称已提交，但目录尚未同步，请稍后重试；小票内容保留。");
        return;
      }
      onApplied(item, fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "核准失败，请重试。");
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="catalog-approval-panel">
      <div className="catalog-panel-heading">
        <div>
          <ShieldCheck size={17} />
          <strong>经理核准并记住名称</strong>
        </div>
        <button
          type="button"
          className="icon-btn"
          disabled={working}
          onClick={onCancel}
          aria-label="关闭名称核准面板"
        >
          <X size={17} />
        </button>
      </div>
      <p>仅在你明确核准后加入常用项目。员工修改小票不会自动学习成标准名。</p>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <fieldset disabled={working}>
        <div className="form-grid">
          <label className="field field-wide">
            <span>核准的标准名称 *</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={300}
              placeholder="对照原图填写正确名称"
            />
          </label>
          <label className="field">
            <span>规格（选填）</span>
            <input
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              maxLength={200}
              placeholder="如：标准、份、90分钟"
            />
          </label>
          <label className="field">
            <span>内部项目编码（选填）</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={80}
            />
          </label>
          <label className="field field-wide">
            <span>明确核准的识别别名（每行一个）</span>
            <textarea
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              rows={3}
              maxLength={6000}
            />
            <small>
              本次OCR原名：{ocrName || "未识别到名称"}
              。仅唯一已核准别名可自动匹配；歧义仍需人工处理。
            </small>
          </label>
        </div>
        <label className="catalog-package-check">
          <input
            type="checkbox"
            checked={included}
            onChange={(e) => setIncluded(e.target.checked)}
          />
          <span>
            属于套餐内未单独标价的子项
            <small>仅作项目属性；不会把空金额改成0，也不保存价格。</small>
          </span>
        </label>
      </fieldset>
      <div className="catalog-panel-actions">
        <button
          type="button"
          className="btn btn-secondary small-btn"
          disabled={working}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary small-btn"
          disabled={working}
          onClick={() => void approve()}
        >
          {working ? (
            <RefreshCw size={14} className="spin" />
          ) : (
            <Check size={14} />
          )}{" "}
          {working ? "正在核准…" : "核准并记住名称"}
        </button>
      </div>
    </div>
  );
}

export function CatalogManager({
  catalog,
  onSave,
  busy,
}: {
  catalog: CatalogItem[];
  onSave: SaveCatalog;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("active");
  const [editing, setEditing] = useState<{
    item?: CatalogItem;
    key: string;
  } | null>(null);
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [code, setCode] = useState("");
  const [aliases, setAliases] = useState("");
  const [included, setIncluded] = useState(false);
  const [active, setActive] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const rows = catalog.filter(
    (i) =>
      (filter === "all" || i.active === (filter === "active")) &&
      (!search ||
        `${i.name} ${i.spec} ${i.code} ${i.aliases.join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  function edit(item?: CatalogItem) {
    setEditing({ item, key: crypto.randomUUID() });
    setName(item?.name || "");
    setSpec(item?.spec || "");
    setCode(item?.code || "");
    setAliases(item?.aliases.join("\n") || "");
    setIncluded(item?.packageIncluded || false);
    setActive(item?.active ?? true);
    setError("");
  }
  async function save() {
    if (!editing || working || busy) return;
    if (!name.trim()) {
      setError("请填写经核准的标准名称。");
      return;
    }
    setWorking(true);
    setError("");
    try {
      const fresh = await onSave(
        {
          ...(editing.item
            ? { id: editing.item.id, version: editing.item.version }
            : {}),
          name: name.trim(),
          spec: spec.trim(),
          code: code.trim(),
          aliases: aliasesFrom(aliases),
          packageIncluded: included,
          active,
        },
        editing.key,
      );
      if (fresh) setEditing(null);
      else setError("保存未完成，请检查提示后重试；当前输入保留。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setWorking(false);
    }
  }
  async function toggle(item: CatalogItem) {
    if (working || busy) return;
    if (
      !confirm(
        `确定${item.active ? "停用" : "启用"}“${item.name}”吗？${item.active ? "停用后不再用于新小票自动匹配，历史记录保留。" : "启用后可用于新小票匹配。"}`,
      )
    )
      return;
    setWorking(true);
    try {
      await onSave(
        {
          id: item.id,
          version: item.version,
          name: item.name,
          spec: item.spec,
          code: item.code,
          aliases: item.aliases,
          packageIncluded: item.packageIncluded,
          active: !item.active,
        },
        crypto.randomUUID(),
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <div className="info-strip">
        <ShieldCheck size={16} />
        <span>
          只保存经理核准的名称、规格、别名及套餐属性，不含价格。唯一标准名或已核准别名可自动匹配，模糊候选需人工选择。
        </span>
      </div>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>常用项目名称库</h2>
            <span className="count-tag">
              {catalog.filter((i) => i.active).length}项启用
            </span>
          </div>
          <button
            className="btn btn-primary small-btn"
            onClick={() => edit()}
            disabled={working || busy}
          >
            <Plus size={14} />
            新增标准项目
          </button>
        </div>
        <div className="filter-bar">
          <label className="search-field">
            <Search size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标准名、规格、编码或别名"
              aria-label="搜索常用项目"
            />
          </label>
          <div className="filter-selects">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="项目启用状态"
            >
              <option value="active">启用项目</option>
              <option value="all">全部项目</option>
              <option value="inactive">停用项目</option>
            </select>
          </div>
        </div>
        {!rows.length ? (
          <div className="empty-state">
            <div className="empty-icon">
              <FileText size={25} />
            </div>
            <h3>
              {catalog.length
                ? "没有符合条件的项目"
                : "名称库从经理首次校准开始"}
            </h3>
            <p>
              可在修正小票时“核准并记住名称”，也可在这里增补。不会自动把已有OCR错字入库。
            </p>
          </div>
        ) : (
          <div className="catalog-card-list">
            {rows.map((item) => (
              <article
                className={`catalog-item-card ${!item.active ? "inactive" : ""}`}
                key={item.id}
              >
                <div className="catalog-item-title">
                  <div>
                    <strong>{item.name}</strong>
                    {item.spec && <span>{item.spec}</span>}
                    {item.packageIncluded && <em>套餐内子项</em>}
                  </div>
                  <span
                    className={`status status-${item.active ? "green" : "gray"}`}
                  >
                    <i />
                    {item.active ? "启用" : "停用"}
                  </span>
                </div>
                {item.code && <p>内部编码：{item.code}</p>}
                <div className="catalog-aliases">
                  <span>已核准别名</span>
                  {item.aliases.length ? (
                    item.aliases.map((a, i) => <b key={i}>{a}</b>)
                  ) : (
                    <small>尚无别名，仅匹配标准名称</small>
                  )}
                </div>
                <div className="catalog-item-footer">
                  <small>
                    {item.updatedByName || item.createdByName}核准 · 版本
                    {item.version}
                  </small>
                  <button
                    className="text-btn"
                    onClick={() => edit(item)}
                    disabled={working || busy}
                  >
                    <Pencil size={13} />
                    编辑
                  </button>
                  <button
                    className="text-btn"
                    onClick={() => void toggle(item)}
                    disabled={working || busy}
                  >
                    {item.active ? "停用" : "启用"}
                    <ChevronRight size={13} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {editing && (
        <section className="panel catalog-manager-editor">
          <div className="panel-header">
            <div>
              <h2>{editing.item ? "编辑核准项目" : "新增核准项目"}</h2>
            </div>
            <button
              className="icon-btn"
              onClick={() => {
                if (!working && !busy) setEditing(null);
              }}
              disabled={working || busy}
              aria-label="关闭项目编辑"
            >
              <X size={18} />
            </button>
          </div>
          <div className="catalog-manager-form">
            {error && (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            )}
            <fieldset disabled={working || busy}>
              <div className="form-grid">
                <label className="field field-wide">
                  <span>标准名称 *</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={300}
                  />
                </label>
                <label className="field">
                  <span>规格（选填）</span>
                  <input
                    value={spec}
                    onChange={(e) => setSpec(e.target.value)}
                    maxLength={200}
                  />
                </label>
                <label className="field">
                  <span>内部编码（选填）</span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    maxLength={80}
                  />
                </label>
                <label className="field field-wide">
                  <span>已核准别名（每行一个）</span>
                  <textarea
                    value={aliases}
                    onChange={(e) => setAliases(e.target.value)}
                    rows={4}
                    maxLength={6000}
                  />
                </label>
              </div>
              <label className="catalog-package-check">
                <input
                  type="checkbox"
                  checked={included}
                  onChange={(e) => setIncluded(e.target.checked)}
                />
                <span>套餐内未单独标价子项</span>
              </label>
              <label className="catalog-package-check">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                <span>启用此项目</span>
              </label>
            </fieldset>
            <div className="catalog-panel-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setEditing(null)}
                disabled={working || busy}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void save()}
                disabled={working || busy}
              >
                {working ? (
                  <RefreshCw className="spin" size={15} />
                ) : (
                  <Check size={15} />
                )}
                保存核准项目
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
