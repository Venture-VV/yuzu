// 详情页的「其他信息」（8.0.21 自定义字段，docs/FINANCE_V8021.md 第 1 节）：会员、供应商、物料、合同。
// 字段在后台「数据字典与字段」里建；这里只填值，单独保存（带看到的值的摘要，别人刚改过会提示刷新），不动业务单据本身。
// 没有启用的字段时整块不显示；取不回来时写明加载失败、可以重试（不当成「没有字段」，Codex 审查 26fe580 后补）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { normalizeCustomValue, type CustomFieldDef, type CustomFieldEntity, type CustomFieldSheet } from '@shared/custom-fields';
import type { Permission } from '@shared/permissions';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice, SectionTitle, Select } from '../../components/ui';

const WRITE_PERM: Record<CustomFieldEntity, Permission> = {
  member: 'member.write',
  supplier: 'inventory.master',
  material: 'inventory.master',
  contract: 'contract.manage',
};

export const customFieldsKey = (entity: CustomFieldEntity, id: number) => ['custom-fields', 'sheet', entity, id] as const;

export function CustomFieldsCard({
  entity,
  entityId,
  bare,
  readOnly,
  className,
}: {
  entity: CustomFieldEntity;
  entityId: number;
  /** 放在弹窗里时不要卡片外框 */
  bare?: boolean;
  /** 页面本身是只读的（例如没有维护权限的弹窗） */
  readOnly?: boolean;
  className?: string;
}) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const sheet = useQuery({
    queryKey: customFieldsKey(entity, entityId),
    queryFn: () => api.get<CustomFieldSheet>(`/api/custom-fields/${entity}/${entityId}`),
  });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = sheet.data;
  if (data && data.hash !== baseHash) {
    // 第一次读到、或保存 / 刷新以后：草稿跟着服务端的值
    setBaseHash(data.hash);
    setDraft(Object.fromEntries(data.defs.map((d) => [d.key, data.values[d.key] ?? ''])));
  }
  // 取不回来（也没有上一次的）：写明失败、给重试，不把整块藏起来——藏起来就跟「没建字段」一样，员工分不出来
  if (sheet.isError && !data) {
    return (
      <LoadFailed title="其他信息加载失败，请检查网络" onRetry={() => void sheet.refetch()} retrying={sheet.isFetching} className={className} testId="custom-fields-error">
        这里是后台「数据字典与字段」里建的字段；重试以后再看或填写。
      </LoadFailed>
    );
  }
  // 还在取：不占位（这一块本来就可有可无，没建字段的门店每打开一次详情就闪一下骨架反而晃眼）；没有启用的字段：整块不显示
  if (!data || !draft || data.defs.length === 0) return null;
  const editable = !readOnly && can(WRITE_PERM[entity]);
  const changed = data.defs.filter((d) => (draft[d.key] ?? '').trim() !== (data.values[d.key] ?? ''));
  const problems = Object.fromEntries(
    changed.flatMap((d) => {
      const r = normalizeCustomValue(d, draft[d.key]);
      return r !== null && typeof r === 'object' ? [[d.key, r.error]] : [];
    }),
  );
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<CustomFieldSheet>(`/api/custom-fields/${entity}/${entityId}`, {
        expectedHash: data.hash,
        values: Object.fromEntries(changed.map((d) => [d.key, draft[d.key]!.trim() || null])),
      });
      qc.setQueryData(customFieldsKey(entity, entityId), next);
      await qc.invalidateQueries({ queryKey: ['custom-fields', 'values', entity] });
      toast({ tone: 'success', title: '其他信息已保存' });
    } catch (err) {
      setError(errorMessage(err));
      void sheet.refetch();
    } finally {
      setSaving(false);
    }
  };

  const body = (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.defs.map((d) => {
          const id = `cf-${entity}-${entityId}-${d.key}`;
          const value = draft[d.key] ?? '';
          if (!editable) {
            return (
              <div key={d.key} className="min-w-0">
                <p className="text-[12.5px] text-ink-3">{d.label}</p>
                <p className={cn('mt-0.5 break-words text-[14px]', !value && 'text-ink-4')}>{value || '—'}</p>
              </div>
            );
          }
          return (
            <Field key={d.key} label={d.label} htmlFor={id} error={problems[d.key] ?? null}>
              {d.type === 'select' ? (
                <Select id={id} value={value} onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })} data-testid={`cf-${d.key}`}>
                  <option value="">（不填）</option>
                  {/* 选项删了以后，老值照样留着、照样显示 */}
                  {value && !d.options.includes(value) && <option value={value}>{value}（已不在选项里）</option>}
                  {d.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id={id}
                  value={value}
                  type={d.type === 'date' ? 'date' : 'text'}
                  inputMode={d.type === 'number' ? 'decimal' : undefined}
                  maxLength={200}
                  onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}
                  className="h-10"
                  data-testid={`cf-${d.key}`}
                />
              )}
            </Field>
          );
        })}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {editable && (
        <div className="mt-3 flex items-center justify-end gap-3">
          {changed.length > 0 && <span className="text-[12.5px] text-ink-3">有未保存的修改</span>}
          <Button size="sm" variant="primary" loading={saving} disabled={!changed.length || Object.keys(problems).length > 0} onClick={() => void save()} data-testid="cf-save">
            保存其他信息
          </Button>
        </div>
      )}
    </>
  );
  if (bare) {
    return (
      <section className={cn('space-y-2', className)} data-testid="custom-fields">
        <p className="text-[13px] font-semibold text-ink-2">其他信息</p>
        {body}
      </section>
    );
  }
  return (
    <Card className={cn('p-5', className)} data-testid="custom-fields">
      <SectionTitle>其他信息</SectionTitle>
      <div className="mt-3">{body}</div>
    </Card>
  );
}

/** 列表上「列表里显示」的字段：一个列表取一次 */
export function useCustomListValues(entity: CustomFieldEntity, ids: number[], enabled = true) {
  const key = [...ids]
    .sort((a, b) => a - b)
    .slice(0, 500)
    .join(',');
  return useQuery({
    queryKey: ['custom-fields', 'values', entity, key],
    queryFn: () => api.get<{ defs: CustomFieldDef[]; values: Record<string, Record<string, string>> }>(`/api/custom-fields/${entity}/values?ids=${key}`),
    enabled: enabled && key.length > 0,
    staleTime: 30_000,
  });
}

/** 列表一行里的「字段：值」 */
export function CustomFieldInline({ data, id, className }: { data: { defs: CustomFieldDef[]; values: Record<string, Record<string, string>> } | undefined; id: number; className?: string }) {
  const row = data?.values[String(id)];
  if (!data || !row) return null;
  const items = data.defs.filter((d) => row[d.key]);
  if (!items.length) return null;
  return (
    <span className={cn('block truncate text-[12px] text-ink-3', className)} data-testid={`cf-inline-${id}`}>
      {items.map((d) => `${d.label}：${row[d.key]}`).join(' · ')}
    </span>
  );
}
