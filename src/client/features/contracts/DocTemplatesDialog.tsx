// 合同模板的维护（8.0.21，docs/FINANCE_V8021.md 第 6 节，CW-E）：正文、可填字段、可选条款。
// 改模板 = 停用旧版、存成新的一版；已经起草的合同记着用的是哪一版，不受影响。要「管理合同」。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { CONTRACT_CATEGORIES, CONTRACT_CATEGORY_LABELS, type ContractCategory } from '@shared/contracts';
import { BUILTIN_TEMPLATE_FIELDS, type ContractTemplate, type TemplateClause, type TemplateField } from '@shared/contract-templates';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, IconButton, Input, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { docTemplatesKey, useDocTemplates } from './TemplateSection';

export function DocTemplatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const can = useCan();
  const manage = can('contract.manage');
  const list = useDocTemplates(true);
  const [editing, setEditing] = useState<ContractTemplate | 'new' | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const rows = (list.data ?? []).filter((t) => showRetired || t.status === 'active');
  return (
    <>
      <Dialog
        open={open && !editing}
        onClose={onClose}
        title="合同模板"
        description="合同正文的模板：{{字段}} 占位，起草时选模板、填字段、勾条款，导出 Word 或打印成 PDF。改模板会存成新的一版，已经起草的合同不受影响。"
        width="max-w-3xl"
        footer={
          <>
            <label className="mr-auto flex items-center gap-2 text-[13px] text-ink-2">
              <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
              显示停用的旧版
            </label>
            {manage && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="doc-template-new">
                新建模板
              </Button>
            )}
          </>
        }
      >
        {!list.data ? (
          <Skeleton className="h-40" />
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-ink-3">还没有合同模板。</p>
        ) : (
          <ul className="divide-y divide-line/70 rounded-lg border border-line" data-testid="doc-templates">
            {rows.map((t) => (
              <li key={t.id} className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]', t.status === 'retired' && 'opacity-60')}>
                <span className="num text-ink-3">{t.code}</span>
                <span className="font-semibold">{t.name}</span>
                <Badge>{CONTRACT_CATEGORY_LABELS[t.category]}</Badge>
                <Badge tone={t.status === 'active' ? 'pine' : 'neutral'}>
                  第 {t.version} 版{t.status === 'retired' ? ' · 已停用' : ''}
                </Badge>
                <span className="text-[12px] text-ink-3">
                  {t.createdByName} · {formatDateTime(t.createdAt)} · {t.usedBy} 份合同在用
                </span>
                <span className="flex-1" />
                {manage && t.status === 'active' && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(t)} data-testid={`doc-template-edit-${t.code}`}>
                    改（存成新版）
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <TemplateEditor editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function TemplateEditor({ editing, onClose }: { editing: ContractTemplate | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = editing && editing !== 'new' ? editing : null;
  const [last, setLast] = useState<typeof editing>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ContractCategory>('purchase');
  const [body, setBody] = useState('');
  const [fields, setFields] = useState<TemplateField[]>([]);
  const [clauses, setClauses] = useState<TemplateClause[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (editing !== last) {
    setLast(editing);
    setName(t?.name ?? '');
    setCategory(t?.category ?? 'purchase');
    setBody(t?.body ?? '# 第一条 合同标的\n\n甲方 {{我方}} 与乙方 {{相对方}} 就……订立本合同，合同编号 {{合同编号}}。\n\n# 第二条 价款与付款\n\n含税总价 {{总价}}（{{总价大写}}），按下表付款：\n\n{{付款节点}}');
    setFields(t?.fields ?? []);
    setClauses(t?.clauses ?? []);
    setError(null);
  }
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = { name: name.trim(), category, body, fields, clauses };
      if (t) await api.post(`/api/erp/contracts/doc-templates/${t.id}/revise`, payload);
      else await api.post('/api/erp/contracts/doc-templates', payload);
      await qc.invalidateQueries({ queryKey: docTemplatesKey });
      toast({ tone: 'success', title: t ? `已存成第 ${t.version + 1} 版` : '模板已建好' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!editing}
      onClose={busy ? () => {} : onClose}
      title={t ? `改「${t.name}」（存成第 ${t.version + 1} 版）` : '新建合同模板'}
      width="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !body.trim()} onClick={() => void save()} data-testid="doc-template-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="模板名称" htmlFor="dt-name">
              <Input id="dt-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="h-10" data-testid="dt-name" />
            </Field>
            <Field label="合同类型" htmlFor="dt-cat">
              <Select id="dt-cat" value={category} onChange={(e) => setCategory(e.target.value as ContractCategory)}>
                {CONTRACT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CONTRACT_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="正文" htmlFor="dt-body" hint="空一行分段；「# 」开头的一行是小标题；{{付款节点}}、{{单价表}} 单独一段写就换成表格">
            <Textarea id="dt-body" value={body} onChange={(e) => setBody(e.target.value)} className="min-h-72 font-mono text-[13px]" data-testid="dt-body" />
          </Field>
          <div>
            <div className="mb-1 flex items-center gap-2">
              <p className="text-[13px] font-semibold text-ink-2">可填字段（起草时填，正文里写 {'{{字段名}}'}）</p>
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setFields([...fields, { key: '', label: '', type: 'text', required: false }])}>
                加一个
              </Button>
            </div>
            {fields.map((f, i) => (
              <div key={i} className="mb-1.5 flex flex-wrap items-center gap-2">
                <Input value={f.key} fullWidth={false} className="h-9 w-36" placeholder="字段名" onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, key: e.target.value.trim(), label: x.label || e.target.value.trim() } : x)))} aria-label={`字段 ${i + 1} 名`} />
                <Input value={f.label} fullWidth={false} className="h-9 w-40" placeholder="起草时显示的说明" onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label={`字段 ${i + 1} 说明`} />
                <Select value={f.type} fullWidth={false} className="h-9 w-24" onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, type: e.target.value as TemplateField['type'] } : x)))}>
                  <option value="text">文字</option>
                  <option value="number">数字</option>
                  <option value="date">日期</option>
                </Select>
                <label className="flex items-center gap-1 text-[12.5px]">
                  <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={f.required} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
                  必填
                </label>
                <IconButton label="删掉" onClick={() => setFields(fields.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2">
              <p className="text-[13px] font-semibold text-ink-2">可选条款（起草时勾选，接在正文后面）</p>
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setClauses([...clauses, { key: `c${clauses.length + 1}`, title: '', text: '', default: false }])}>
                加一条
              </Button>
            </div>
            {clauses.map((c, i) => (
              <div key={i} className="mb-2 space-y-1 rounded-md border border-line p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Input value={c.title} fullWidth={false} className="h-9 w-48" placeholder="条款标题" onChange={(e) => setClauses(clauses.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} aria-label={`条款 ${i + 1} 标题`} />
                  <label className="flex items-center gap-1 text-[12.5px]">
                    <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={c.default} onChange={(e) => setClauses(clauses.map((x, j) => (j === i ? { ...x, default: e.target.checked } : x)))} />
                    默认勾上
                  </label>
                  <span className="flex-1" />
                  <IconButton label="删掉" onClick={() => setClauses(clauses.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
                <Textarea value={c.text} onChange={(e) => setClauses(clauses.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className="min-h-14 text-[13px]" aria-label={`条款 ${i + 1} 内容`} />
              </div>
            ))}
          </div>
          {error && <Notice tone="error" title={error} />}
        </div>
        <aside className="rounded-lg bg-paper-2/60 p-3 text-[12.5px]">
          <p className="mb-1 font-semibold text-ink-2">内置字段（从合同带出）</p>
          <ul className="space-y-0.5">
            {BUILTIN_TEMPLATE_FIELDS.map((f) => (
              <li key={f.key}>
                <code className="text-pine">{`{{${f.key}}}`}</code>
                <span className="ml-1 text-ink-3">{f.hint}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </Dialog>
  );
}
