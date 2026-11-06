// 柚子信箱（docs/CANTEEN.md 第 16 节，K16）：员工在柚子饭堂「跟柚子说」写的心愿与碎碎念。
// 没看过的排前面；点「看过了」、写一句回信（回信自动算看过），员工在柚子饭堂里看得到回信；导出表格不截断。
// 看过的再点不变。回信走 ERP 的「结果待确认」（sendErpOp + ErpPendingPanel）：先把操作编号和原请求存在这台电脑上，
// 没收到结果时关掉对话框、刷新以后也能查回、按原内容重新提交（同一编号只记一次）或确认作废；没确认之前这一条不能再回信，
// 免得晚到的那次把新回信改回去。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, MessageCircleReply } from 'lucide-react';
import { FEEDBACK_KIND_LABELS, FEEDBACK_LIMITS, type CanteenFeedbackList, type CanteenFeedbackRow, type FeedbackKind } from '@shared/canteen';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending, type ErpPendingOp } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { downloadUrl, formatDateTime, relativeTime, uuid } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Card, Field, Notice, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { Mascot } from '../../../canteen-app/Mascot';

type Status = 'unread' | 'all' | 'replied';
const REPLY_PENDING = ['canteen_reply'] as const;
const replyUrl = (id: number) => `/api/erp/canteen/feedback/${id}/reply`;
/** 本机还没确认结果的回信是回给哪一条的 */
const pendingFor = (ops: ErpPendingOp[]) => new Set(ops.map((op) => Number(/\/feedback\/(\d+)\/reply$/.exec(op.url)?.[1])).filter((id) => id > 0));

export function FeedbackTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('unread');
  const [kind, setKind] = useState<FeedbackKind | 'all'>('all');
  const params = new URLSearchParams({ status, kind }).toString();
  const list = useQuery({ queryKey: ['canteen', 'feedback', params], queryFn: () => api.get<CanteenFeedbackList>(`/api/erp/canteen/feedback?${params}`) });
  const [replying, setReplying] = useState<CanteenFeedbackRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const pendingReplies = pendingFor(useErpPending(REPLY_PENDING));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['canteen'] });

  const markRead = async (row: CanteenFeedbackRow) => {
    setBusyId(row.id);
    try {
      await api.post(`/api/erp/canteen/feedback/${row.id}/read`);
      refresh();
    } catch (e) {
      toast({ tone: 'error', title: '没标上', body: errorMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  const data = list.data;
  return (
    <div className="space-y-4" data-testid="canteen-feedback">
      <ErpPendingPanel types={REPLY_PENDING} onFound={refresh} />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Status>
          size="sm"
          value={status}
          onChange={setStatus}
          ariaLabel="看哪些"
          options={[
            { value: 'unread', label: data ? `没看过的（${data.unread}）` : '没看过的' },
            { value: 'all', label: '全部' },
            { value: 'replied', label: '回过信的' },
          ]}
        />
        <Select value={kind} onChange={(e) => setKind(e.target.value as FeedbackKind | 'all')} aria-label="种类" className="w-44" fullWidth={false}>
          <option value="all">心愿和碎碎念</option>
          <option value="wish">{FEEDBACK_KIND_LABELS.wish}</option>
          <option value="chat">{FEEDBACK_KIND_LABELS.chat}</option>
        </Select>
        <span className="ml-auto" />
        <Button variant="secondary" size="sm" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/erp/canteen/feedback.csv?${params}`)}>
          导出表格
        </Button>
      </div>

      {list.isLoading ? (
        <Skeleton className="h-48" />
      ) : list.isError ? (
        <Notice tone="error" title="取不到柚子信箱" />
      ) : !data?.rows.length ? (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <Mascot mood={status === 'unread' ? 'happy' : 'sleepy'} className="h-28 w-auto" still />
          <p className="text-[15px] font-bold">{status === 'unread' ? '都看过啦' : '柚子信箱还是空的'}</p>
          <p className="max-w-md text-[13px] text-ink-3">员工在手机上「跟柚子说」写的心愿和碎碎念会出现在这里，回一句话他们就看得到。</p>
        </Card>
      ) : (
        <>
          {data.total > data.rows.length && <Notice tone="info">一共 {data.total} 条，这里列出最近的 {data.rows.length} 条；要看全部请导出表格。</Notice>}
          <ul className="space-y-3">
            {data.rows.map((r) => (
              <li key={r.id}>
                <Card className={`p-4 ${r.readAt ? '' : 'ring-2 ring-yuzu'}`} data-testid={`feedback-${r.id}`}>
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="text-[22px]">{r.avatar}</span>
                    <span className="font-bold">{r.name}</span>
                    <span className="num text-ink-3">{r.empNo}</span>
                    <Badge tone={r.kind === 'wish' ? 'yuzu' : 'lake'}>{FEEDBACK_KIND_LABELS[r.kind]}</Badge>
                    <span className="text-ink-3" title={formatDateTime(r.createdAt)}>
                      {relativeTime(r.createdAt)}
                    </span>
                    {!r.readAt && <Badge tone="ember">没看过</Badge>}
                    {pendingReplies.has(r.id) && <Badge tone="neutral">回信待确认</Badge>}
                  </div>
                  <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-wrap">{r.content}</p>
                  {r.reply && (
                    <div className="mt-3 flex gap-2 rounded-xl bg-paper-2 px-3 py-2.5">
                      <Mascot mood="happy" className="size-9 shrink-0" still />
                      <div className="min-w-0">
                        <p className="text-[12px] font-semibold text-ink-3">
                          回信 · {r.repliedByName} · {r.repliedAt && relativeTime(r.repliedAt)}
                        </p>
                        <p className="text-[14px] whitespace-pre-wrap">{r.reply}</p>
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    {r.readAt && !r.reply && <span className="mr-auto text-[12px] text-ink-3">{r.readByName} 看过了</span>}
                    {!r.readAt && (
                      <Button size="sm" variant="ghost" icon={<Check className="size-3.5" />} loading={busyId === r.id} onClick={() => void markRead(r)}>
                        看过了
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={r.reply ? 'ghost' : 'primary'}
                      icon={<MessageCircleReply className="size-3.5" />}
                      disabled={pendingReplies.has(r.id)}
                      title={pendingReplies.has(r.id) ? '上一次回信还没确认：先在上面查回、按原内容重新提交或作废' : undefined}
                      onClick={() => setReplying(r)}
                      data-testid={`feedback-reply-${r.id}`}
                    >
                      {r.reply ? '改回信' : '回信'}
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      <ReplyDialog
        row={replying}
        onClose={() => setReplying(null)}
        onDone={() => {
          setReplying(null);
          refresh();
          toast({ tone: 'success', title: '回信发出去了，员工在柚子饭堂里看得到' });
        }}
        onUncertain={() => {
          // 没收到结果：记录留在这台电脑上，到上面查回、按原内容重新提交（不会发两遍）或确认作废
          setReplying(null);
          refresh();
          toast({ tone: 'info', title: '回信：没收到结果', body: '可能已经发出去了。记录留在这台电脑上，到上面查回、按原内容重新提交（不会发两遍）或确认作废' });
        }}
      />
    </div>
  );
}

function ReplyDialog({ row, onClose, onDone, onUncertain }: { row: CanteenFeedbackRow | null; onClose: () => void; onDone: () => void; onUncertain: () => void }) {
  const session = useSession();
  const [text, setText] = useState('');
  const [clientKey, setClientKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useResetOnOpen(!!row, () => {
    setText(row?.reply ?? '');
    setClientKey(uuid());
    setError('');
  });
  const save = async () => {
    if (!row) return;
    const reply = text.trim();
    setBusy(true);
    setError('');
    try {
      // 先存在这台电脑上并读回核对，存不下就不发（sendErpOp 抛出原因）
      await sendErpOp<CanteenFeedbackRow>({
        key: clientKey,
        type: 'canteen_reply',
        url: replyUrl(row.id),
        body: { clientKey, reply },
        summary: `回信给 ${row.name}：${reply.length > 40 ? `${reply.slice(0, 40)}…` : reply}`,
        staffName: session.staff.displayName,
      });
      onDone();
    } catch (e) {
      if (e instanceof UncertainError) onUncertain();
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!row}
      onClose={onClose}
      title={`回信给 ${row?.name ?? ''}`}
      description="员工在柚子饭堂「跟柚子说」里看得到这句回信（署名是柚子）。回信以后也算看过了。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void save()} data-testid="feedback-reply-save">
            发回信
          </Button>
        </>
      }
    >
      {row && (
        <div className="space-y-3">
          <p className="rounded-lg bg-paper-2 px-3 py-2 text-[14px] whitespace-pre-wrap">「{row.content}」</p>
          <Field label="回信" hint={`最多 ${FEEDBACK_LIMITS.reply} 字`}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={FEEDBACK_LIMITS.reply} rows={4} aria-label="回信" />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      )}
    </Dialog>
  );
}
