// 空间台账导入（RQ-004 第一段，v0.7.14）：区域清单、空间清单（与需求文档附件草稿的列名一致）。
// 下载模板 → 选 CSV 或 Excel → 预览（逐行校验；编码、区域已在台账里的不覆盖，列出与台账不同的字段）→ 写入；同一个文件只能写入一次。
// 写入带操作编号：先存本机再发，结果不明时在页面上方查回、按原内容重新提交或作废（与 ERP 批量导入同一套）。
// 真实台账在门店环境导入前须店主同意。

import { useRef, useState } from 'react';
import { CircleCheck, Download, FileSearch, FileUp } from 'lucide-react';
import {
  SPACE_IMPORT_COLUMNS,
  SPACE_IMPORT_LABELS,
  ZONE_IMPORT_COLUMNS,
  type SpaceImportKind,
  type SpaceImportPreview,
  type SpaceImportRecord,
} from '@shared/spaces';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpPending } from '../../lib/erpPending';
import { bytesToBase64, readImportFile } from '../../lib/import-file';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { useInvalidateSpaces, useSpaceImports } from '../spaces/queries';

const TEMPLATES: Record<SpaceImportKind, { columns: readonly string[]; sample: string[][]; hint: string }> = {
  zones: {
    columns: ZONE_IMPORT_COLUMNS,
    sample: [['L3', '示例区域（请替换）', 'Sample Zone', '']],
    hint: '楼层写编码（L1、L2、L3）；同一层的区域名不能重复，已在台账里的不覆盖。先导入区域清单，空间清单里才能写「区域」。',
  },
  spaces: {
    columns: SPACE_IMPORT_COLUMNS,
    sample: [['L3', 'S', 'S999', 'SPA', '1', '示例 SPA 1人间（请替换）', '', '示例标注', '', '', '', '', '']],
    hint: '楼层、编码、业态必填；编码按编码图写（大写字母开头，最多 8 位），缺号不补；编码已在台账里的不覆盖。备注里写了「推断」「近邻标签」的标为推断；「区域」「英文名」「可售」「核对状态」可选。',
  },
};

type Loaded = { fileName: string; csv?: string; xlsxBase64?: string; encoding: string };

function downloadTemplate(kind: SpaceImportKind) {
  const t = TEMPLATES[kind];
  const csv = '﻿' + [t.columns.join(','), ...t.sample.map((r) => r.join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${SPACE_IMPORT_LABELS[kind]}导入模板.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function SpaceImportCard() {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateSpaces();
  const history = useSpaceImports();
  const pending = useErpPending(['space_import']);
  const [kind, setKind] = useState<SpaceImportKind>('zones');
  const [file, setFile] = useState<Loaded | null>(null);
  const [preview, setPreview] = useState<SpaceImportPreview | null>(null);
  // 每换一次文件或导入类型就加一：晚回来的预览、文件读取对不上现在选的文件，丢掉
  const selection = useRef(0);
  const [busy, setBusy] = useState<'read' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    selection.current += 1;
    setFile(null);
    setPreview(null);
    setError(null);
  };
  const body = () => ({ kind, fileName: file!.fileName, csv: file!.csv, xlsxBase64: file!.xlsxBase64, encoding: file!.encoding });

  const choose = async (f: File | undefined) => {
    reset();
    if (!f) return;
    const ticket = selection.current;
    const current = () => selection.current === ticket;
    setBusy('read');
    try {
      if (/\.xlsx$/i.test(f.name)) {
        const xlsxBase64 = bytesToBase64(await f.arrayBuffer());
        if (current()) setFile({ fileName: f.name, xlsxBase64, encoding: 'Excel' });
      } else if (/\.csv$/i.test(f.name) || f.type === 'text/csv') {
        const loaded = await readImportFile(f);
        if (current()) setFile({ fileName: f.name, csv: loaded.text, encoding: loaded.label.includes('GBK') ? 'GBK' : 'UTF-8' });
      } else setError('只能导入 CSV（.csv）或 Excel（.xlsx）文件；老版本的 .xls 请另存为 .xlsx 或 CSV');
    } catch (e) {
      if (current()) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async () => {
    if (!file) return;
    const ticket = selection.current;
    setBusy('preview');
    setError(null);
    try {
      const result = await api.post<SpaceImportPreview>('/api/admin/spaces/imports/preview', body());
      if (selection.current === ticket) setPreview(result);
    } catch (e) {
      if (selection.current === ticket) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // 每次写入用新的操作编号：先把编号和原请求（含文件内容）记在本机并读回核对，记不下就不发请求
  const apply = async () => {
    if (!file) return;
    if (pending.length > 0) return setError('上一次导入结果待确认：请先在页面上方查回、按原内容重新提交或作废');
    const clientKey = uuid();
    setBusy('apply');
    setError(null);
    try {
      const r = await sendErpOp<{ import: SpaceImportRecord; replayed: boolean }>({
        key: clientKey,
        type: 'space_import',
        url: '/api/admin/spaces/imports',
        body: { ...body(), clientKey },
        summary: `${SPACE_IMPORT_LABELS[kind]} · ${file.fileName}${preview ? ` · ${preview.rowCount} 行` : ''}`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      toast({
        tone: 'success',
        title: r.replayed ? '这个文件之前已经导入过' : `已新建 ${r.import.createdCount} 个${r.import.kind === 'zones' ? '区域' : '空间'}`,
        body: `${r.import.fileName}${r.import.skippedCount ? `；已在台账里的 ${r.import.skippedCount} 个没有覆盖` : ''}`,
      });
      reset();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '导入结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要改了文件再导入。' });
        reset();
      } else if (e instanceof ErpPendingStoreError) setError(`${e.message} 文件较大时也可以拆成几份分批导入。`);
      else setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const t = TEMPLATES[kind];
  const sampleColumns = preview?.sample[0] ? Object.keys(preview.sample[0]) : [];
  const unit = kind === 'zones' ? '区域' : '空间';
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5" data-testid="space-import">
        <SectionTitle>导入</SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<SpaceImportKind>
            size="sm"
            value={kind}
            onChange={(k) => {
              setKind(k);
              reset();
            }}
            ariaLabel="导入什么"
            options={(['zones', 'spaces'] as const).map((k) => ({ value: k, label: SPACE_IMPORT_LABELS[k], disabled: busy !== null }))}
          />
          <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={() => downloadTemplate(kind)}>
            下载模板
          </Button>
        </div>
        <p className="text-[12.5px] text-ink-3">
          列：{t.columns.join('、')}。{t.hint}
        </p>
        <label className="flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong px-4 py-3 text-[13px] hover:border-ink-3">
          <FileUp className="size-5 text-ink-3" />
          <span className="font-semibold">{file ? `${file.fileName}（${file.encoding}）` : '选择 CSV 或 Excel 文件'}</span>
          <input
            type="file"
            accept=".csv,.xlsx,text/csv"
            className="sr-only"
            aria-label="选择导入文件"
            disabled={busy === 'preview' || busy === 'apply'}
            onChange={(e) => void choose(e.target.files?.[0])}
            data-testid="space-import-file"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!file} loading={busy === 'preview'} icon={<FileSearch className="size-4" />} onClick={runPreview} data-testid="space-import-preview">
            预览
          </Button>
          <Button
            variant="primary"
            disabled={!preview || preview.issues.length > 0 || !!preview.duplicateOf || preview.createCount === 0 || pending.length > 0}
            loading={busy === 'apply'}
            icon={<CircleCheck className="size-4" />}
            onClick={apply}
            data-testid="space-import-apply"
          >
            写入
          </Button>
        </div>
        {pending.length > 0 && <Notice tone="warning" title="上一次导入结果待确认：请先在页面上方处理，再写入新的一份" />}
        {error && <Notice tone="error" title={error} />}
      </Card>

      {preview && (
        <section className="space-y-3" data-testid="space-import-result">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <span className="font-bold">共 {preview.rowCount} 行</span>
            <span>
              新建 <b className="num">{preview.createCount}</b> 个{unit}
            </span>
            {preview.skipCount > 0 && <span className="text-ink-3">已在台账里 {preview.skipCount} 个（不覆盖）</span>}
            {preview.inferredCount > 0 && <Badge tone="yuzu">推断 {preview.inferredCount} 个</Badge>}
            {preview.siteCheckCount > 0 && <Badge tone="ember">待现场核对 {preview.siteCheckCount} 个</Badge>}
            {preview.issues.length === 0 ? (
              preview.createCount > 0 ? (
                <Badge tone="pine">可以写入</Badge>
              ) : (
                <Badge>没有要新建的</Badge>
              )
            ) : (
              <Badge tone="clay">{preview.issues.length} 行要先改好</Badge>
            )}
          </div>
          {preview.duplicateOf && (
            <Notice tone="warning" title={`这个文件已经在 ${formatDateTime(preview.duplicateOf.createdAt)} 由 ${preview.duplicateOf.createdByName} 导入过`}>
              同一个文件只能写入一次。
            </Notice>
          )}
          {preview.issues.length > 0 && (
            <ul className="divide-y divide-line/70 rounded-lg border border-clay/40 bg-clay-soft/30 text-[13px]" data-testid="space-import-issues">
              {preview.issues.map((i) => (
                <li key={`${i.row}${i.message}`} className="px-4 py-2">
                  <span className="num font-bold">第 {i.row} 行</span>
                  <span className="ml-2">{i.message}</span>
                </li>
              ))}
            </ul>
          )}
          {preview.diffs.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-card" data-testid="space-import-diffs">
              <p className="px-3 pt-2.5 text-[13px] font-bold">与台账不同的地方（导入不覆盖；要改请在空间详情里改）</p>
              <table className="mt-1 w-full min-w-[560px] text-left text-[13px]">
                <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                  <tr>
                    <th className="px-3 py-2">行</th>
                    <th className="px-3 py-2">{kind === 'zones' ? '区域' : '编码'}</th>
                    <th className="px-3 py-2">字段</th>
                    <th className="px-3 py-2">台账</th>
                    <th className="px-3 py-2">文件</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {preview.diffs.flatMap((d) =>
                    d.fields.map((f, i) => (
                      <tr key={`${d.row}-${f.field}`}>
                        <td className="num px-3 py-1.5">{i === 0 ? d.row : ''}</td>
                        <td className="num px-3 py-1.5 font-semibold">{i === 0 ? d.key : ''}</td>
                        <td className="px-3 py-1.5">{f.field}</td>
                        <td className="px-3 py-1.5 text-ink-3">{f.ledger || '（空）'}</td>
                        <td className="px-3 py-1.5">{f.file || '（空）'}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
          {preview.sample.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-card">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                  <tr>
                    {sampleColumns.map((c) => (
                      <th key={c} className="px-3 py-2">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {preview.sample.map((r, i) => (
                    <tr key={i}>
                      {sampleColumns.map((c) => (
                        <td key={c} className="px-3 py-1.5">
                          {r[c]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.rowCount > preview.sample.length && <p className="px-3 py-2 text-[12px] text-ink-3">只显示前 {preview.sample.length} 行。</p>}
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-[13px] font-bold text-ink-2">导入记录</h2>
        {history.isPending ? (
          <Skeleton className="h-16" />
        ) : !history.data?.length ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">还没有导入过。</p>
        ) : (
          <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card shadow-card" data-testid="space-import-history">
            {history.data.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                <Badge tone={h.kind === 'zones' ? 'lake' : 'pine'}>{SPACE_IMPORT_LABELS[h.kind]}</Badge>
                <span className="font-semibold">{h.fileName}</span>
                <span className="text-ink-3">
                  {h.rowCount} 行 · 新建 {h.createdCount}
                  {h.skippedCount ? ` · 已在台账里 ${h.skippedCount}` : ''} · {h.createdByName} · {formatDateTime(h.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
