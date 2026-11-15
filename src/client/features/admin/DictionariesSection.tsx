// 后台「数据字典与字段」（8.0.21，docs/FINANCE_V8021.md 第 1 节，CW-J）：三个页签，写进地址（/admin/dictionaries/fields）。
//   · 快捷原因：作废、撤销、退款、报损……弹窗上那一排快捷原因，每份最多 30 条；原因照旧存文字，页面上仍然可以手填。
//   · 自定义字段：会员、供应商、物料、合同各自最多 10 个启用的字段；编号与类型建了不改，不用了停用（值留着）。
//   · 按字段查：选一类、一个字段，查填了什么的对象，导出 CSV。
// 权限：修改经营规则（店主）；按字段查还要能看那一类。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, Plus, Search, X } from 'lucide-react';
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_ENTITY_LABELS,
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  DEFAULT_DICTIONARIES,
  DICTIONARY_KEYS,
  DICTIONARY_LABELS,
  MAX_CUSTOM_FIELD_LABEL,
  MAX_CUSTOM_FIELDS,
  MAX_DICTIONARY_ITEM_LENGTH,
  MAX_DICTIONARY_ITEMS,
  type CustomFieldDef,
  type CustomFieldEntity,
  type CustomFieldSearchResult,
  type CustomFieldType,
  type Dictionaries,
  type DictionaryKey,
} from '@shared/custom-fields';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn, downloadUrl } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { SubPane } from '../../components/SubNav';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Field, IconButton, Input, Notice, Segmented, SectionTitle, Select, Skeleton } from '../../components/ui';
import { AdminPage } from './AdminShell';

export const DICTIONARY_TABS = [
  { key: 'reasons', label: '快捷原因' },
  { key: 'fields', label: '自定义字段' },
  { key: 'search', label: '按字段查' },
] as const;

export function DictionariesSection() {
  return (
    <AdminPage
      section="dictionaries"
      wide
      tabs={[...DICTIONARY_TABS]}
      description="快捷原因：前台、ERP 弹窗上那一排可点的原因。自定义字段：给会员、供应商、物料、合同加几项门店自己要记的信息，不参与任何计算。"
    >
      <SubPane tab="reasons" lazy>
        <ReasonsBody />
      </SubPane>
      <SubPane tab="fields" lazy>
        <FieldsBody />
      </SubPane>
      <SubPane tab="search" lazy>
        <SearchBody />
      </SubPane>
    </AdminPage>
  );
}

// ───────────────────────── 快捷原因 ─────────────────────────

function ReasonsBody() {
  const settings = useSettings();
  if (!settings.data)
    return settings.isError ? (
      <LoadFailed title="快捷原因取不回来，请检查网络" onRetry={() => void settings.refetch()} retrying={settings.isFetching} testId="dict-reasons-error" />
    ) : (
      <Skeleton className="h-60" />
    );
  const dicts = (settings.data as { dictionaries?: Dictionaries }).dictionaries ?? DEFAULT_DICTIONARIES;
  return (
    <div className="max-w-[1024px] space-y-4">
      <p className="text-[13px] text-ink-3">
        每份最多 {MAX_DICTIONARY_ITEMS} 条、每条最多 {MAX_DICTIONARY_ITEM_LENGTH} 个字。删掉或改名只影响以后的快捷选项：已经记下的原因是文字，照原样留着；页面上照样可以手填别的原因。
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {DICTIONARY_KEYS.map((k) => (
          <ReasonListCard key={k} dictKey={k} saved={dicts[k]} />
        ))}
      </div>
    </div>
  );
}

function ReasonListCard({ dictKey, saved }: { dictKey: DictionaryKey; saved: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<string[]>(saved);
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState(saved);
  // 别处保存了（另一个标签页、别人）：没在改的跟着刷新
  if (JSON.stringify(saved) !== JSON.stringify(base)) {
    setBase(saved);
    if (JSON.stringify(draft) === JSON.stringify(base)) setDraft(saved);
  }
  const meta = DICTIONARY_LABELS[dictKey];
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const trimmed = draft.map((r) => r.trim());
  const problem = trimmed.some((r) => !r)
    ? '原因不能为空'
    : new Set(trimmed).size !== trimmed.length
      ? '原因重复了'
      : trimmed.some((r) => r.length > MAX_DICTIONARY_ITEM_LENGTH)
        ? `每条最多 ${MAX_DICTIONARY_ITEM_LENGTH} 个字`
        : null;
  const move = (i: number, d: -1 | 1) => {
    const next = [...draft];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setDraft(next);
  };
  const add = () => {
    const v = adding.trim();
    if (!v || draft.length >= MAX_DICTIONARY_ITEMS) return;
    setDraft([...draft, v]);
    setAdding('');
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/api/settings', { dictionaries: { [dictKey]: trimmed } });
      await qc.invalidateQueries({ queryKey: qk.settings });
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: `${meta.title}已保存` });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="p-4" data-testid={`dict-${dictKey}`}>
      <SectionTitle
        aside={
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(DEFAULT_DICTIONARIES[dictKey])}>
            恢复默认
          </Button>
        }
      >
        {meta.title}
      </SectionTitle>
      <p className="mt-0.5 text-[12.5px] text-ink-3">{meta.where}</p>
      <ol className="mt-3 divide-y divide-line/70 overflow-hidden rounded-lg border border-line">
        {draft.map((r, i) => (
          <li key={i} className="flex items-center gap-1 py-1 pl-2 pr-1">
            <span className="num w-5 shrink-0 text-right text-[12px] text-ink-4">{i + 1}</span>
            <Input
              value={r}
              maxLength={MAX_DICTIONARY_ITEM_LENGTH}
              onChange={(e) => setDraft(draft.map((x, j) => (j === i ? e.target.value : x)))}
              className="h-8 min-w-0 flex-1 border-transparent px-2 text-[13.5px] hover:border-line"
              aria-label={`${meta.title} 第 ${i + 1} 条`}
            />
            <IconButton label="上移" disabled={i === 0} onClick={() => move(i, -1)} className="size-8 shrink-0">
              <ArrowUp className="size-4" />
            </IconButton>
            <IconButton label="下移" disabled={i === draft.length - 1} onClick={() => move(i, 1)} className="size-8 shrink-0">
              <ArrowDown className="size-4" />
            </IconButton>
            <IconButton label={`删掉「${r}」`} onClick={() => setDraft(draft.filter((_, j) => j !== i))} className="size-8 shrink-0 hover:text-clay">
              <X className="size-4" />
            </IconButton>
          </li>
        ))}
        {draft.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">没有快捷原因，只能手填</li>}
      </ol>
      <div className="mt-3 flex items-center gap-2">
        <Input
          value={adding}
          maxLength={MAX_DICTIONARY_ITEM_LENGTH}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="新的原因，回车添加"
          className="h-9"
          disabled={draft.length >= MAX_DICTIONARY_ITEMS}
          aria-label={`给${meta.title}添加一条`}
          data-testid={`dict-${dictKey}-add`}
        />
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={!adding.trim() || draft.length >= MAX_DICTIONARY_ITEMS} onClick={add}>
          添加
        </Button>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        {problem && <span className="text-[13px] text-clay">{problem}</span>}
        {dirty && !problem && <span className="text-[12.5px] text-ink-3">有未保存的修改</span>}
        <Button size="sm" variant="primary" loading={saving} disabled={!dirty || !!problem} onClick={save} data-testid={`dict-${dictKey}-save`}>
          保存
        </Button>
      </div>
    </Card>
  );
}

// ───────────────────────── 自定义字段 ─────────────────────────

const DEFS_KEY = ['custom-fields', 'defs'] as const;

function FieldsBody() {
  const defs = useQuery({ queryKey: DEFS_KEY, queryFn: () => api.get<CustomFieldDef[]>('/api/custom-fields/defs') });
  const [editing, setEditing] = useState<{ entity: CustomFieldEntity; def: CustomFieldDef | null } | null>(null);
  if (!defs.data)
    return defs.isError ? (
      <LoadFailed title="自定义字段取不回来，请检查网络" onRetry={() => void defs.refetch()} retrying={defs.isFetching} testId="dict-fields-error">
        {errorMessage(defs.error)}
      </LoadFailed>
    ) : (
      <Skeleton className="h-60" />
    );
  return (
    <div className="max-w-[1024px] space-y-4">
      <p className="text-[13px] text-ink-3">
        每类启用的字段最多 {MAX_CUSTOM_FIELDS} 个，在详情页的「其他信息」里填。字段只是记录，不参与结账、成本、付款等任何计算，也不进报表口径。类型建了不改；不用了停用，已经填的值留着，再启用就回来。
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {CUSTOM_FIELD_ENTITIES.map((entity) => {
          const list = defs.data.filter((d) => d.entity === entity);
          const activeCount = list.filter((d) => d.active).length;
          return (
            <Card key={entity} className="p-4" data-testid={`fields-${entity}`}>
              <SectionTitle
                aside={
                  <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={activeCount >= MAX_CUSTOM_FIELDS} onClick={() => setEditing({ entity, def: null })} data-testid={`fields-${entity}-add`}>
                    新增字段
                  </Button>
                }
              >
                {CUSTOM_FIELD_ENTITY_LABELS[entity]}
                <span className="num ml-2 text-[12.5px] font-normal text-ink-3">
                  {activeCount} / {MAX_CUSTOM_FIELDS}
                </span>
              </SectionTitle>
              {list.length === 0 ? (
                <p className="mt-3 text-[13px] text-ink-3">还没有字段</p>
              ) : (
                <ul className="mt-3 divide-y divide-line/70 overflow-hidden rounded-lg border border-line">
                  {list.map((d) => (
                    <li key={d.id} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', !d.active && 'bg-paper-2/50 text-ink-3')}>
                      <span className="font-semibold">{d.label}</span>
                      <Badge tone="neutral">{CUSTOM_FIELD_TYPE_LABELS[d.type]}</Badge>
                      {d.inList && <Badge tone="lake">列表里显示</Badge>}
                      {!d.active && <Badge tone="neutral">已停用</Badge>}
                      {d.type === 'select' && <span className="truncate text-[12.5px] text-ink-3">{d.options.join(' / ')}</span>}
                      <span className="flex-1" />
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ entity, def: d })} data-testid={`field-edit-${d.id}`}>
                        修改
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
      <FieldDialog editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function FieldDialog({ editing, onClose }: { editing: { entity: CustomFieldEntity; def: CustomFieldDef | null } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const def = editing?.def ?? null;
  const [key, setKey] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [options, setOptions] = useState('');
  const [inList, setInList] = useState(false);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openKey = editing ? `${editing.entity}:${def?.id ?? 'new'}:${def?.version ?? 0}` : null;
  if (openKey !== key) {
    setKey(openKey);
    setLabel(def?.label ?? '');
    setType(def?.type ?? 'text');
    setOptions((def?.options ?? []).join('\n'));
    setInList(def?.inList ?? false);
    setActive(def?.active ?? true);
    setError(null);
  }
  const optionList = options
    .split(/\n|、|,|，/)
    .map((o) => o.trim())
    .filter(Boolean);
  const ok = label.trim().length > 0 && (type !== 'select' || optionList.length > 0);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      if (def) {
        await api.put(`/api/custom-fields/defs/${def.id}`, {
          expectedVersion: def.version,
          label: label.trim(),
          inList,
          active,
          ...(def.type === 'select' ? { options: optionList } : {}),
        });
      } else {
        await api.post('/api/custom-fields/defs', { entity: editing.entity, label: label.trim(), type, inList, ...(type === 'select' ? { options: optionList } : {}) });
      }
      await qc.invalidateQueries({ queryKey: ['custom-fields'] });
      toast({ tone: 'success', title: def ? '字段已保存' : '字段已添加' });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      title={editing ? `${def ? '修改' : '新增'}${CUSTOM_FIELD_ENTITY_LABELS[editing.entity]}字段` : ''}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!ok} loading={busy} onClick={() => void save()} data-testid="field-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="字段名称" htmlFor="cf-label" hint={`最多 ${MAX_CUSTOM_FIELD_LABEL} 个字；启用的里面不能重名`}>
          <Input id="cf-label" value={label} maxLength={MAX_CUSTOM_FIELD_LABEL} onChange={(e) => setLabel(e.target.value)} data-autofocus data-testid="field-label" />
        </Field>
        <Field label="类型" htmlFor="cf-type" hint={def ? '类型建了就不能改' : '数字最多两位小数；日期按 年-月-日'}>
          <Select id="cf-type" value={type} disabled={!!def} onChange={(e) => setType(e.target.value as CustomFieldType)} data-testid="field-type">
            {CUSTOM_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {CUSTOM_FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        {type === 'select' && (
          <Field label="选项" htmlFor="cf-options" hint="一行一个（也可以用顿号、逗号隔开），最多 20 个；删掉的选项，已经填了的值照样留着">
            <textarea
              id="cf-options"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              className="min-h-24 w-full rounded-md border border-line-strong bg-card px-3.5 py-2.5 text-ink outline-none focus:border-pine"
              data-testid="field-options"
            />
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <Segmented
            size="sm"
            ariaLabel="列表里显示"
            value={inList ? 'on' : 'off'}
            onChange={(v) => setInList(v === 'on')}
            options={[
              { value: 'on', label: '列表里显示' },
              { value: 'off', label: '只在详情里' },
            ]}
          />
          {def && (
            <Segmented
              size="sm"
              ariaLabel="启用"
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              options={[
                { value: 'on', label: '启用' },
                { value: 'off', label: '停用' },
              ]}
            />
          )}
        </div>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 按字段查 ─────────────────────────

const SEARCH_PERMS: Record<CustomFieldEntity, ('member.read' | 'inventory.read' | 'contract.read')[]> = {
  member: ['member.read'],
  supplier: ['inventory.read', 'contract.read'],
  material: ['inventory.read'],
  contract: ['contract.read'],
};

function SearchBody() {
  const can = useCan();
  const entities = CUSTOM_FIELD_ENTITIES.filter((e) => SEARCH_PERMS[e].some((p) => can(p)));
  const [entity, setEntity] = useState<CustomFieldEntity>(entities[0] ?? 'member');
  const [fieldId, setFieldId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState<{ fieldId: number; q: string } | null>(null);
  const defs = useQuery({ queryKey: DEFS_KEY, queryFn: () => api.get<CustomFieldDef[]>('/api/custom-fields/defs') });
  const fields = (defs.data ?? []).filter((d) => d.entity === entity);
  const field = fields.find((d) => d.id === fieldId) ?? null;
  const qs = submitted ? `fieldId=${submitted.fieldId}&q=${encodeURIComponent(submitted.q)}` : '';
  const result = useQuery({
    queryKey: ['custom-fields', 'search', entity, qs],
    queryFn: () => api.get<CustomFieldSearchResult>(`/api/custom-fields/${entity}/search?${qs}`),
    enabled: !!submitted,
  });
  if (!entities.length) return <Notice tone="info" title="当前岗位看不了会员、供应商、物料、合同，没有可查的" />;
  // 字段定义取不回来：写明加载失败、可以重试，不显示成「没有字段可查」
  if (defs.isError && !defs.data)
    return <LoadFailed title="自定义字段取不回来，请检查网络" onRetry={() => void defs.refetch()} retrying={defs.isFetching} testId="dict-search-error" />;
  return (
    <div className="max-w-[1024px] space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="类别" htmlFor="cf-s-entity">
            <Select
              id="cf-s-entity"
              fullWidth={false}
              className="w-32"
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value as CustomFieldEntity);
                setFieldId(null);
                setSubmitted(null);
              }}
            >
              {entities.map((e) => (
                <option key={e} value={e}>
                  {CUSTOM_FIELD_ENTITY_LABELS[e]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="字段" htmlFor="cf-s-field">
            <Select
              id="cf-s-field"
              fullWidth={false}
              className="w-44"
              value={fieldId ?? ''}
              onChange={(e) => {
                setFieldId(e.target.value ? Number(e.target.value) : null);
                setQ('');
                setSubmitted(null);
              }}
              data-testid="cf-search-field"
            >
              <option value="">选一个字段</option>
              {fields.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                  {d.active ? '' : '（已停用）'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={field?.type === 'text' ? '包含' : '等于'} htmlFor="cf-s-q" className="min-w-48 flex-1">
            {field?.type === 'select' ? (
              <Select id="cf-s-q" value={q} onChange={(e) => setQ(e.target.value)}>
                <option value="">填了的都列出来</option>
                {field.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id="cf-s-q"
                value={q}
                type={field?.type === 'date' ? 'date' : 'text'}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && field && setSubmitted({ fieldId: field.id, q: q.trim() })}
                placeholder="空着 = 填了的都列出来"
                className="h-10"
                data-testid="cf-search-q"
              />
            )}
          </Field>
          <Button variant="primary" icon={<Search className="size-4" />} disabled={!field} onClick={() => field && setSubmitted({ fieldId: field.id, q: q.trim() })} data-testid="cf-search-go">
            查
          </Button>
          <Button
            variant="secondary"
            icon={<Download className="size-4" />}
            disabled={!submitted || !result.data?.rows.length}
            onClick={() => downloadUrl(`/api/custom-fields/${entity}/search.csv?${qs}`)}
          >
            导出
          </Button>
        </div>
      </Card>
      {result.error && !result.data && <LoadFailed title={`没查出来：${errorMessage(result.error)}`} onRetry={() => void result.refetch()} retrying={result.isFetching} testId="cf-search-error" />}
      {submitted && result.data && (
        <Card className="overflow-hidden" data-testid="cf-search-result">
          {result.data.rows.length === 0 ? (
            <p className="p-4 text-[13px] text-ink-3">没有找到</p>
          ) : (
            <table className="w-full text-[13.5px]">
              <thead className="bg-paper-2 text-left text-[12.5px] text-ink-3">
                <tr>
                  <th className="px-4 py-2 font-semibold">编号</th>
                  <th className="px-4 py-2 font-semibold">名称</th>
                  <th className="px-4 py-2 font-semibold">{result.data.def.label}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {result.data.rows.map((r) => (
                  <tr key={r.entityId} className={cn(r.inactive && 'text-ink-3')}>
                    <td className="num px-4 py-2">{r.code}</td>
                    <td className="px-4 py-2">
                      {r.name}
                      {r.inactive && <Badge tone="neutral" className="ml-2">停用</Badge>}
                    </td>
                    <td className="px-4 py-2">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.data.truncated && <p className="border-t border-line px-4 py-2 text-[12.5px] text-ink-3">只列前 500 条，全部的请导出</p>}
        </Card>
      )}
    </div>
  );
}

