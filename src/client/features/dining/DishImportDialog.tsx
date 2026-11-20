// 菜品管理：导入（8.1.15，docs/DISHES_V8115.md 第 6 节）。Excel（.xlsx）或 CSV，先预览再生效：
// 预览列出新建、修改、没变的各几道与每一道改什么，逐行写问题；有一行有问题整份不写。
// 生效带回预览的摘要（预览以后菜被别人改过就拒绝，请重新预览）与操作编号；有改价要写原因。
// 8.1.16：生效没收到结果的进「结果待确认」（dishPendingStore.ts）：查回、按原内容重新提交或确认作废之前不能再导入。

import { useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Download, FileSearch, FileUp, Tag } from 'lucide-react';
import { DISH_SHEET_COLUMNS, DISH_SHEET_HINT, MAX_PRICE_REASON, type DishImportPreview, type DishImportResult } from '@shared/dishes';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { loadTableFile, type LoadedTable } from '../../lib/import-file';
import { useReasons, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { downloadCsvRows, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ReasonChips } from '../../components/ReasonChips';
import { Badge, Button, Field, Input, Notice } from '../../components/ui';
import { StatusChip } from './DishChips';
import { DishPendingNotice } from './DishPendingNotice';
import { pendingOf, sendDishOp, useDishPending } from './dishPendingStore';
import { useRefreshDishes } from './dishQueries';

const SAMPLE = [
  ['', '示例牛肉面（请替换）', '餐饮', '餐厅', '餐饮', '热菜', '38', '', '58', '上架', '微辣、中辣、免葱', '', ''],
  ['', '示例面茶套餐（请替换）', '套餐', '餐厅', '餐饮', '热菜', '48', '', '', '下架', '', '', '示例牛肉面（请替换）×1'],
];

export function DishImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (r: DishImportResult) => void }) {
  const reasons = useReasons('dishPriceReasons');
  const [file, setFile] = useState<LoadedTable | null>(null);
  const [preview, setPreview] = useState<DishImportPreview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'read' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 每换一次文件就加一：晚回来的读取、预览对不上现在选的文件，丢掉
  const selection = useRef(0);
  const session = useSession();
  const refreshDishes = useRefreshDishes();
  // 上一次生效的结果待确认：处理好之前不能再导入
  const waiting = pendingOf(useDishPending(), 'import');
  const reset = () => {
    selection.current += 1;
    setFile(null);
    setPreview(null);
    setReason('');
    setBusy(null);
    setError(null);
  };
  useResetOnOpen(open, reset);
  const body = () => ({ fileName: file!.fileName, csv: file!.csv, xlsxBase64: file!.xlsxBase64 });

  const choose = async (f: File | undefined) => {
    reset();
    if (!f) return;
    const ticket = selection.current;
    setBusy('read');
    try {
      const loaded = await loadTableFile(f);
      if (selection.current === ticket) setFile(loaded);
    } catch (e) {
      if (selection.current === ticket) setError(errorMessage(e));
    } finally {
      if (selection.current === ticket) setBusy(null);
    }
  };

  const runPreview = async () => {
    if (!file) return;
    const ticket = selection.current;
    setBusy('preview');
    setError(null);
    try {
      const result = await api.post<DishImportPreview>('/api/dining/dishes/import/preview', body(), { timeoutMs: 60_000 });
      if (selection.current === ticket) setPreview(result);
    } catch (e) {
      if (selection.current === ticket) setError(errorMessage(e));
    } finally {
      if (selection.current === ticket) setBusy(null);
    }
  };

  const needReason = (preview?.priceChangeCount ?? 0) > 0;
  const nothing = !!preview && preview.createCount + preview.updateCount === 0;
  const blocked = waiting
    ? '上一次导入的结果待确认'
    : !preview
      ? '先预览'
      : preview.issues.length > 0
        ? '有问题的行要先改好'
        : nothing
          ? '没有要改的'
          : needReason && reason.trim().length < 2
            ? '有改价，请写原因'
            : null;

  const apply = async () => {
    if (!file || !preview || blocked) return;
    const key = uuid();
    setBusy('apply');
    setError(null);
    try {
      const r = await sendDishOp<DishImportResult>({
        key,
        type: 'import',
        itemId: null,
        method: 'post',
        url: '/api/dining/dishes/import',
        body: { clientKey: key, ...body(), planHash: preview.planHash, reason: reason.trim() },
        summary: `导入「${file.fileName}」（新建 ${preview.createCount} 道、修改 ${preview.updateCount} 道）`,
        staffName: session.staff.displayName,
      });
      onDone(r);
    } catch (e) {
      // 没收到结果：记录留在本机，上方出现「结果待确认」那一条
      if (!(e instanceof UncertainError)) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="导入菜品"
      description="先预览、再生效。整份里有一行有问题就都不写，改好再导。"
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            关闭
          </Button>
          <Button className="min-h-11" disabled={!file} loading={busy === 'preview'} icon={<FileSearch className="size-4" />} onClick={() => void runPreview()} data-testid="dish-import-preview">
            预览
          </Button>
          <Button
            variant="primary"
            className="min-h-11"
            disabled={!!blocked}
            title={blocked ?? undefined}
            loading={busy === 'apply'}
            icon={<CircleCheck className="size-4" />}
            onClick={() => void apply()}
            data-testid="dish-import-apply"
          >
            生效
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="dish-import">
        {waiting && (
          <DishPendingNotice
            op={waiting}
            onApplied={() => {
              refreshDishes();
              onClose();
            }}
            onAbandoned={() => setPreview(null)}
          />
        )}
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          列：{DISH_SHEET_COLUMNS.join('、')}。{DISH_SHEET_HINT}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-11 min-w-0 flex-1 basis-64 cursor-pointer items-center gap-3 rounded-md border border-dashed border-line-strong px-4 py-2 text-[13.5px] hover:border-ink-3">
            <FileUp className="size-5 shrink-0 text-ink-3" />
            <span className="min-w-0 truncate font-semibold">{file ? `${file.fileName}（${file.encoding}）` : busy === 'read' ? '读取中…' : '选择 Excel（.xlsx）或 CSV 文件'}</span>
            <input
              type="file"
              accept=".csv,.xlsx,text/csv"
              className="sr-only"
              aria-label="选择导入文件"
              disabled={busy === 'preview' || busy === 'apply'}
              onChange={(e) => void choose(e.target.files?.[0])}
              data-testid="dish-import-file"
            />
          </label>
          <Button variant="ghost" className="min-h-11" icon={<Download className="size-4" />} onClick={() => downloadCsvRows([DISH_SHEET_COLUMNS, ...SAMPLE], '菜品导入模板.csv')}>
            下载模板
          </Button>
        </div>
        <p className="text-[12.5px] text-ink-3">最省事的做法：先点菜品表上的「导出全部」，在导出的表里改，再导回来（有「编号」的按编号对，可以改名）。</p>

        {error && <Notice tone="error" title={error} data-testid="dish-import-error" />}

        {preview && (
          <section className="space-y-3" data-testid="dish-import-result">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px]">
              <span className="font-bold">共 {preview.rowCount} 行</span>
              <span>
                新建 <b className="num">{preview.createCount}</b> 道
              </span>
              <span>
                修改 <b className="num">{preview.updateCount}</b> 道
              </span>
              <span className="text-ink-3">没变 {preview.unchangedCount} 道</span>
              {preview.priceChangeCount > 0 && (
                <StatusChip tone="ember" icon={<Tag />}>
                  改价 {preview.priceChangeCount} 道
                </StatusChip>
              )}
              {preview.issues.length > 0 ? (
                <StatusChip tone="clay" icon={<CircleAlert />} testId="dish-import-state">
                  {preview.issues.length} 处要先改好
                </StatusChip>
              ) : nothing ? (
                <StatusChip tone="neutral" testId="dish-import-state">
                  没有要改的
                </StatusChip>
              ) : (
                <StatusChip tone="pine" icon={<CircleCheck />} testId="dish-import-state">
                  可以生效
                </StatusChip>
              )}
            </div>
            {preview.issues.length > 0 && (
              <ul className="divide-y divide-line/70 rounded-lg border border-clay/40 bg-clay-soft/30 text-[13px]" data-testid="dish-import-issues">
                {preview.issues.map((i, k) => (
                  <li key={k} className="px-4 py-2">
                    <span className="num font-bold">第 {i.row} 行</span>
                    <span className="ml-2">{i.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview.changes.length > 0 && (
              <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card text-[13px]" data-testid="dish-import-changes">
                {preview.changes.map((c) => (
                  <li key={c.row} className="px-4 py-2">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="num text-ink-3">第 {c.row} 行</span>
                      <Badge tone={c.action === 'create' ? 'pine' : 'lake'}>{c.action === 'create' ? '新建' : '修改'}</Badge>
                      <span className="text-[14px] font-bold">{c.name}</span>
                    </p>
                    <p className="mt-0.5 text-[16px] text-ink-2">{c.fields.join('；')}</p>
                  </li>
                ))}
              </ul>
            )}
            {needReason && preview.issues.length === 0 && (
              <Field label="改价原因（这份表里有改价，记进改价记录）" htmlFor="dish-import-reason">
                <ReasonChips reasons={reasons} value={reason} onPick={setReason} disabled={busy !== null} />
                <Input id="dish-import-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={MAX_PRICE_REASON} placeholder="例如 菜单调整" data-testid="dish-import-reason" />
              </Field>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}
