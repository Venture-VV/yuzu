// 草稿箱（供应链二次整改 03，docs/ERP_ROUND2.md）：自己的需求单草稿——查看、继续填写、删除。
// 「采购需求单」页与填单页都能打开；填单页上正在填的那一份只标出来，不在这里删。

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronDown, ChevronRight, FilePen, Inbox, Trash2, X } from 'lucide-react';
import { type RequestDraft, type RequestDraftSummary } from '@shared/requests';
import { errorMessage } from '../../lib/api';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ImageThumbs } from '../../components/Images';
import { Dialog, Sheet } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Notice, Skeleton } from '../../components/ui';
import { PriorityTag } from './parts';
import { deleteDraft, fetchDraft, useDrafts, useInvalidateDrafts } from './drafts';

/** 还有几天过期（不足一天算今天） */
export function daysLeft(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 86_400_000));
}

export const draftLabel = (d: RequestDraftSummary) =>
  `${d.request ? `修改 ${d.request.docNo}` : (d.departmentName ?? '还没选部门')} · ${d.title || '还没填产品名'}${d.lineCount > 1 ? ` 等 ${d.lineCount} 行` : ''}`;

export function DraftBox({ open, onClose, currentKey }: { open: boolean; onClose: () => void; currentKey?: string }) {
  const drafts = useDrafts(null, open);
  const invalidate = useInvalidateDrafts();
  const navigate = useNavigate();
  const toast = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ key: string; draft?: RequestDraft; error?: string } | null>(null);
  const [removing, setRemoving] = useState<RequestDraftSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (d: RequestDraftSummary) => {
    if (expanded === d.key) return setExpanded(null);
    setExpanded(d.key);
    setDetail({ key: d.key });
    try {
      const draft = await fetchDraft(d.key);
      setDetail((cur) => (cur?.key === d.key ? { key: d.key, draft } : cur));
    } catch (e) {
      setDetail((cur) => (cur?.key === d.key ? { key: d.key, error: errorMessage(e) } : cur));
    }
  };

  const resume = (d: RequestDraftSummary) => {
    onClose();
    navigate(d.request ? `/erp/requests/${d.request.id}/edit` : `/erp/requests/new?draft=${d.key}`);
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDraft(removing.key);
      await invalidate();
      toast({ tone: 'success', title: '草稿已删除' });
      setRemoving(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const list = drafts.data?.drafts ?? [];
  return (
    <>
      <Sheet open={open} onClose={onClose} label="草稿箱" width="w-[min(640px,100vw)]">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="flex size-8 items-center justify-center rounded-full bg-yuzu-tint text-yuzu-deep">
            <Inbox className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-bold">草稿箱</p>
            <p className="text-[12.5px] text-ink-3">
              只有你自己看得到；{drafts.data?.keepDays ?? 30} 天没再保存的自动清理，最多 {drafts.data?.max ?? 20} 份
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-ink-3 hover:bg-paper-2" aria-label="关闭">
            <X className="size-5" />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4" data-testid="draft-box">
          {drafts.error ? (
            <Notice tone="error" title={errorMessage(drafts.error)} />
          ) : !drafts.data ? (
            <Skeleton className="h-40" />
          ) : list.length === 0 ? (
            <EmptyState art="search" title="草稿箱是空的" description="提需求填到一半离开时会自动存成草稿，下次可以在这里接着填。" />
          ) : (
            <ul className="space-y-3">
              {list.map((d) => {
                const isOpen = expanded === d.key;
                const current = d.key === currentKey;
                const left = daysLeft(d.expiresAt);
                return (
                  <li key={d.key} className="rounded-lg border border-line bg-card shadow-card" data-testid={`draft-${d.key}`}>
                    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 p-4">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-[14px] font-bold">
                          {d.request ? <Badge tone="lake">修改 {d.request.docNo}</Badge> : <Badge tone="yuzu">新需求</Badge>}
                          <span className="truncate">{d.title || '还没填产品名'}</span>
                          {current && <Badge tone="pine">正在填写</Badge>}
                        </p>
                        <p className="mt-1 text-[12.5px] text-ink-3">
                          {d.departmentName ?? '还没选部门'} · {d.lineCount} 行 · 保存于 {formatDateTime(d.updatedAt)} ·{' '}
                          <span className={cn(left <= 3 && 'font-semibold text-clay')}>{left > 0 ? `还有 ${left} 天过期` : '今天过期'}</span>
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <Button size="sm" variant="ghost" icon={isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} onClick={() => void toggle(d)} data-testid={`draft-view-${d.key}`}>
                          查看
                        </Button>
                        {!current && (
                          <>
                            <Button size="sm" variant="primary" icon={<FilePen className="size-4" />} onClick={() => resume(d)} data-testid={`draft-resume-${d.key}`}>
                              继续填写
                            </Button>
                            <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setRemoving(d)} aria-label="删除草稿" data-testid={`draft-delete-${d.key}`} />
                          </>
                        )}
                      </div>
                    </div>
                    {isOpen && (
                      <div className="border-t border-line px-4 py-3" data-testid={`draft-detail-${d.key}`}>
                        {detail?.key !== d.key || (!detail.draft && !detail.error) ? (
                          <Skeleton className="h-20" />
                        ) : detail.error ? (
                          <Notice tone="error" title={detail.error} />
                        ) : (
                          <DraftDetail draft={detail.draft!} />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Sheet>
      <Dialog
        open={!!removing}
        onClose={() => !busy && setRemoving(null)}
        title="删除这份草稿？"
        description={removing ? draftLabel(removing) : undefined}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>
              不删
            </Button>
            <Button variant="danger" loading={busy} disabled={busy} onClick={() => void remove()} data-testid="draft-delete-confirm">
              删除
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] text-ink-2">删除以后找不回来。已经提交的需求单不受影响。</p>
        {error && <Notice tone="error" title={error} className="mt-3" />}
      </Dialog>
    </>
  );
}

function DraftDetail({ draft }: { draft: RequestDraft }) {
  const b = draft.body;
  return (
    <div className="space-y-2.5">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-2">
        <PriorityTag priority={b.priority} />
        {b.needBy && <span>期望 {b.needBy} 到货</span>}
        {b.note && <span>备注：{b.note}</span>}
      </p>
      <ul className="divide-y divide-line rounded-md border border-line">
        {b.lines.map((l, i) => (
          <li key={i} className="space-y-1 px-3 py-2 text-[13px]">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">{l.name || <span className="text-ink-3">（没填产品名）</span>}</span>
              <span className="text-[12px] text-ink-3">{l.kind === 'material' ? '已有物料' : '新产品'}</span>
              <span className="num ml-auto">
                {l.qty || '—'} {l.unit}
              </span>
            </p>
            {(l.purpose || l.details || l.note || l.refPrice) && (
              <p className="text-[12.5px] text-ink-2">
                {[l.purpose && `用途：${l.purpose}`, l.refPrice && `参考单价 ¥${l.refPrice}`, l.details, l.note && `备注：${l.note}`].filter(Boolean).join(' · ')}
              </p>
            )}
            {l.link && <p className="truncate text-[12.5px] text-lake">{l.link}</p>}
            <ImageThumbs images={l.images} size={40} />
          </li>
        ))}
      </ul>
    </div>
  );
}
