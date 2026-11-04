// 后台「期初导入」页的旧系统逐笔流水（v0.7.28 ⑩，N12 待确认）：选模板 CSV → 预览（认出几位会员、认不出的行、格式不对的行）→
// 确认导入（只读，不进正式账）；导入记录可以整批作废。会员详情「旧系统流水」里看。
// 结果不确定（超时、断网）时用同一个操作编号再点一次查回结果；同一份文件只能有一批有效导入，换编号重提也不会重复导入。

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, History } from 'lucide-react';
import { describeHistoryAmount, MEMBER_HISTORY_KIND_LABELS, type MemberHistoryImportSummary, type MemberHistoryReport } from '@shared/member-history';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { readImportFile } from '../../lib/import-file';
import { formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Skeleton } from '../../components/ui';

const listKey = ['member-history-imports'] as const;

export function MemberHistoryImportCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; label: string; csv: string } | null>(null);
  const [preview, setPreview] = useState<MemberHistoryReport | null>(null);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<MemberHistoryImportSummary | null>(null);
  const list = useQuery({ queryKey: listKey, queryFn: () => api.get<MemberHistoryImportSummary[]>('/api/member-history-imports') });

  const runPreview = async (f: { name: string; csv: string }) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.post<MemberHistoryReport>('/api/member-history-imports/preview', { source: 'EBC', fileName: f.name, csv: f.csv }, { timeoutMs: 120_000 }));
      setClientKey(uuid());
    } catch (e) {
      setPreview(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!file || !clientKey) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<MemberHistoryReport>(
        '/api/member-history-imports',
        { source: 'EBC', fileName: file.name, csv: file.csv, clientKey },
        { timeoutMs: 180_000 },
      );
      toast({ tone: 'success', title: r.replayed ? `批次 ${r.importNo} 已导入（查回结果）` : `已导入旧系统流水 ${r.matchedRows} 笔`, body: `${r.memberCount} 位会员；会员详情「旧系统流水」里看` });
      setFile(null);
      setPreview(null);
      setClientKey(null);
      void qc.invalidateQueries({ queryKey: listKey });
      void qc.invalidateQueries({ queryKey: ['member'] });
    } catch (e) {
      // 没收到结果：保留操作编号，再点一次查回（同一份文件不会导入两批）
      setError(e instanceof UncertainError ? '没收到结果：请再点一次「确认导入」查回结果（同一份文件不会重复导入）' : errorMessage(e));
      if (!(e instanceof UncertainError)) void qc.invalidateQueries({ queryKey: listKey });
    } finally {
      setBusy(false);
    }
  };
  const blocked = !!preview && (preview.errors.length > 0 || preview.matchedRows === 0 || !!preview.duplicateOf);

  return (
    <Card className="p-5" data-testid="member-history-import">
      <SectionTitle>
        <span className="flex items-center gap-2">
          <History className="size-4 text-ink-3" /> 旧系统逐笔流水（只读）
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        从旧系统（EBC）导出的会员逐笔流水，按模板导入后在会员详情「旧系统流水」里看；只读、不进正式账，余额照旧以期初导入为准。按旧卡号（期初导入时记下的）或手机号认会员，认不出的行不导入。列：手机号、旧卡号、姓名、时间、类型、金额、赠金、余额、赠金余额、单号、门店、经办人、备注（时间、类型、金额必填）。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          data-testid="member-history-file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              const decoded = await readImportFile(f);
              const loaded = { name: f.name, label: decoded.label, csv: decoded.text };
              setFile(loaded);
              await runPreview(loaded);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        />
        <Button variant="secondary" icon={<FileUp className="size-4" />} loading={busy && !preview} onClick={() => fileRef.current?.click()}>
          选择流水文件
        </Button>
        {file && <span className="text-[12.5px] text-ink-3">{file.label}</span>}
      </div>
      {preview && (
        <div className="mt-3 space-y-2 text-[13px]" data-testid="member-history-preview">
          <p>
            共 {preview.totalRows} 行：认出会员 <b>{preview.matchedRows}</b> 行（{preview.memberCount} 位会员；按旧卡号 {preview.byLegacyNo}、按手机号 {preview.byPhone}）· 认不出会员{' '}
            {preview.unmatched.count} 行（不导入）
          </p>
          {preview.firstAt && (
            <p className="text-ink-3">
              时间 {preview.firstAt.slice(0, 10)} 到 {preview.lastAt!.slice(0, 10)}；
              {preview.byKind.map((k) => `${MEMBER_HISTORY_KIND_LABELS[k.kind]} ${k.count} 笔 ${describeHistoryAmount(k.amount)}`).join('，')}
            </p>
          )}
          {preview.unmatched.lines.length > 0 && (
            <p className="text-[12px] text-ink-3">
              认不出：{preview.unmatched.lines.slice(0, 10).map((u) => `第 ${u.line} 行（${u.name || u.phone || u.legacyNo}）`).join('、')}
              {preview.unmatched.count > 10 ? ' 等' : ''}
            </p>
          )}
          {preview.duplicateOf && <Notice tone="warning" title={`这份文件已经导入过（批次 ${preview.duplicateOf}）；要重新导入请先在下面作废那一批`} />}
          {preview.errors.length > 0 && (
            <Notice tone="error" title={`有 ${preview.errors.length} 行格式不对，改好后重新选择文件`}>
              {preview.errors.slice(0, 8).map((e) => `第 ${e.line} 行：${e.message}`).join('；')}
            </Notice>
          )}
          <Button variant="primary" loading={busy} disabled={blocked} onClick={() => void submit()} data-testid="member-history-submit">
            确认导入
          </Button>
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-4">
        <p className="text-[13px] font-bold text-ink-2">导入记录</p>
        {list.isPending ? (
          <Skeleton className="mt-2 h-12" />
        ) : (list.data ?? []).length === 0 ? (
          <p className="mt-1 text-[12.5px] text-ink-3">还没有导入过旧系统流水。</p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {list.data!.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]" data-testid={`member-history-import-${i.importNo}`}>
                <span className="num font-semibold">{i.importNo}</span>
                <span className="text-ink-3">{i.fileName}</span>
                <span>
                  {i.importedRows} 笔 · {i.memberCount} 位会员{i.skippedRows ? ` · 没认出 ${i.skippedRows} 行` : ''}
                </span>
                <span className="text-[12px] text-ink-3">
                  {i.createdByName} {formatDateTime(i.createdAt)}
                </span>
                <span className="flex-1" />
                {i.status === 'voided' ? (
                  <Badge tone="neutral">已作废（{i.voidReason}）</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setVoiding(i)}>
                    作废
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {voiding && <VoidDialog item={voiding} onClose={() => setVoiding(null)} onDone={() => void qc.invalidateQueries({ queryKey: listKey })} />}
    </Card>
  );
}

function VoidDialog({ item, onClose, onDone }: { item: MemberHistoryImportSummary; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/member-history-imports/${item.id}/void`, { reason: reason.trim() });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`作废批次 ${item.importNo}`}
      description="作废后会员详情里不再显示这一批旧流水（只读数据，不影响余额）；同一份文件可以重新导入。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 2} onClick={() => void submit()}>
            确认作废
          </Button>
        </>
      }
    >
      <Field label="原因">
        <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="如：导错了文件" />
      </Field>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
