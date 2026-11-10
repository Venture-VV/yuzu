// 验收标准模板（8.0.7 供应链收尾 2.5）：名称与逐条标准；起草合同时在「验收」一节选模板，逐条标准写进合同内容。
// 维护合同的人新建、修改、停用（不能删）；改模板不影响已经写进合同的。

import { useState } from 'react';
import { ACCEPTANCE_ITEMS_MAX, type AcceptanceTemplate } from '@shared/contracts';
import { api, errorMessage } from '../../lib/api';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Skeleton, Textarea } from '../../components/ui';
import { useAcceptanceTemplates, useInvalidateContracts } from './queries';

interface Draft {
  id: number | null;
  name: string;
  items: string;
  active: boolean;
  version: number;
}

const blank: Draft = { id: null, name: '', items: '', active: true, version: 0 };

export function TemplatesDialog({ open, onClose, manage }: { open: boolean; onClose: () => void; manage: boolean }) {
  const list = useAcceptanceTemplates(true);
  const invalidate = useInvalidateContracts();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setDraft(null);
    setError(null);
  });
  const edit = (t: AcceptanceTemplate) => setDraft({ id: t.id, name: t.name, items: t.items.join('\n'), active: t.active, version: t.version });
  const items = (draft?.items ?? '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  const problem = !draft ? null : !draft.name.trim() ? '请填写模板名称' : items.length === 0 ? '至少写一条验收标准' : items.length > ACCEPTANCE_ITEMS_MAX ? `验收标准最多 ${ACCEPTANCE_ITEMS_MAX} 条` : null;
  const save = async () => {
    if (!draft || problem) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: draft.name.trim(), items };
      if (draft.id === null) await api.post('/api/erp/contracts/acceptance-templates', body);
      else await api.put(`/api/erp/contracts/acceptance-templates/${draft.id}`, { ...body, active: draft.active, expectedVersion: draft.version });
      toast({ tone: 'success', title: draft.id === null ? '模板已新建' : '模板已保存', body: draft.name.trim() });
      setDraft(null);
      await invalidate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="验收标准模板"
      width="max-w-2xl"
      description="起草合同时在「验收」一节选模板，逐条标准写进合同（之后改模板不影响已经写进合同的）；登记验收时按条打勾，有一条不合格整次就是不合格。"
      footer={
        draft ? (
          <>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
              返回列表
            </Button>
            <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void save()} data-testid="template-save">
              保存
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            {manage && (
              <Button variant="primary" onClick={() => setDraft({ ...blank })} data-testid="template-new">
                新建模板
              </Button>
            )}
          </>
        )
      }
    >
      {draft ? (
        <div className="space-y-3">
          <Field label="模板名称" htmlFor="tpl-name">
            <Input id="tpl-name" value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="h-10" data-testid="template-name" />
          </Field>
          <Field label={`验收标准（每行一条，最多 ${ACCEPTANCE_ITEMS_MAX} 条）`} htmlFor="tpl-items">
            <Textarea id="tpl-items" rows={8} value={draft.items} onChange={(e) => setDraft({ ...draft, items: e.target.value })} data-testid="template-items" />
          </Field>
          {draft.id !== null && (
            <label className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-2">
              <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              在用（停用的起草合同时选不到）
            </label>
          )}
          {problem && <p className="text-[12.5px] text-ink-3">{problem}</p>}
          {error && <Notice tone="error" title={error} />}
        </div>
      ) : list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.error ? (
        <Notice tone="error" title={errorMessage(list.error)} />
      ) : (list.data ?? []).length === 0 ? (
        <p className="text-[13px] text-ink-3">还没有验收标准模板。{manage ? '点「新建模板」写一个，例如「布草类到货验收」。' : ''}</p>
      ) : (
        <ul className="space-y-2" data-testid="template-list">
          {(list.data ?? []).map((t) => (
            <li key={t.id} className="rounded-md border border-line px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] font-bold">{t.name}</span>
                <span className="text-[12.5px] text-ink-3">{t.items.length} 条</span>
                {!t.active && <Badge tone="neutral">已停用</Badge>}
                {manage && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => edit(t)}>
                    修改
                  </Button>
                )}
              </div>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[12.5px] text-ink-2">
                {t.items.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
