// 合同表单里的「合同正文（模板）」（8.0.21，docs/FINANCE_V8021.md 第 6 节，CW-E）：选模板、填模板里的字段、勾可选条款。
// 模板只管正文；付款节点、单价表、验收这些照旧在表单下面填，导出时按模板排进正文。
// 编辑已经用了某一版模板的合同：那一版停用了也照样显示、照样能改字段（合同记着用的是哪一版）。

import { useQuery } from '@tanstack/react-query';
import type { ContractCategory, ContractTemplateRef } from '@shared/contracts';
import { CONTRACT_CATEGORY_LABELS } from '@shared/contracts';
import type { ContractTemplate } from '@shared/contract-templates';
import { api } from '../../lib/api';
import { Card, Field, Input, Notice, Select } from '../../components/ui';

export const docTemplatesKey = ['contracts', 'doc-templates'] as const;
export const useDocTemplates = (all = false) =>
  useQuery({ queryKey: [...docTemplatesKey, all], queryFn: () => api.get<ContractTemplate[]>(`/api/erp/contracts/doc-templates${all ? '?all=1' : ''}`) });

export function TemplateSection({ category, value, onChange }: { category: ContractCategory; value: ContractTemplateRef | null; onChange: (v: ContractTemplateRef | null) => void }) {
  const list = useDocTemplates(true);
  const all = list.data ?? [];
  const current = value ? all.find((t) => t.id === value.id) ?? null : null;
  const choices = all.filter((t) => t.status === 'active' || t.id === value?.id);
  const pick = (id: number | null) => {
    const t = all.find((x) => x.id === id);
    if (!t) return onChange(null);
    onChange({ id: t.id, code: t.code, version: t.version, name: t.name, values: {}, clauses: t.clauses.filter((c) => c.default).map((c) => c.key) });
  };
  return (
    <Card className="p-5" data-testid="contract-template-section">
      <h2 className="mb-1 text-[14px] font-bold">合同正文（模板）</h2>
      <p className="mb-3 text-[12.5px] text-ink-3">选了模板，导出 Word / PDF 时按模板排正文，下面填的付款节点、单价表、验收自动带进去；不选就只导出合同要素与两张表。</p>
      <Field label="模板" htmlFor="ct-template">
        <Select id="ct-template" value={value?.id ?? ''} onChange={(e) => pick(Number(e.target.value) || null)} data-testid="ct-template">
          <option value="">不用模板</option>
          {choices.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{CONTRACT_CATEGORY_LABELS[t.category]} · 第 {t.version} 版{t.status === 'retired' ? '，已停用' : ''}）
            </option>
          ))}
        </Select>
      </Field>
      {value && current && current.category !== category && (
        <Notice tone="warning" className="mt-2" title={`这是${CONTRACT_CATEGORY_LABELS[current.category]}合同的模板`}>
          与这份合同的类型不一样，确认一下是不是选错了。
        </Notice>
      )}
      {value && current?.status === 'retired' && (
        <p className="mt-2 text-[12.5px] text-ink-3">这份合同用的是第 {value.version} 版；模板已经改过，新起草的合同用新的一版。</p>
      )}
      {value && current && (
        <div className="mt-3 space-y-3">
          {current.fields.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {current.fields.map((f) => (
                <Field key={f.key} label={`${f.label}${f.required ? '（必填）' : ''}`} htmlFor={`ct-f-${f.key}`}>
                  <Input
                    id={`ct-f-${f.key}`}
                    type={f.type === 'date' ? 'date' : 'text'}
                    inputMode={f.type === 'number' ? 'decimal' : undefined}
                    value={value.values[f.key] ?? ''}
                    maxLength={500}
                    onChange={(e) => onChange({ ...value, values: { ...value.values, [f.key]: e.target.value } })}
                    className="h-10"
                    data-testid={`ct-field-${f.key}`}
                  />
                </Field>
              ))}
            </div>
          )}
          {current.clauses.length > 0 && (
            <div>
              <p className="mb-1 text-[13px] font-semibold text-ink-2">可选条款</p>
              <ul className="space-y-1">
                {current.clauses.map((c) => (
                  <li key={c.key}>
                    <label className="flex cursor-pointer items-start gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 accent-[var(--color-pine)]"
                        checked={value.clauses.includes(c.key)}
                        onChange={(e) => onChange({ ...value, clauses: e.target.checked ? [...value.clauses, c.key] : value.clauses.filter((k) => k !== c.key) })}
                        data-testid={`ct-clause-${c.key}`}
                      />
                      <span>
                        <span className="font-semibold">{c.title}</span>
                        <span className="block text-[12.5px] text-ink-3">{c.text}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
