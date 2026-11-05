// 审批单详情（v0.7.30）：一屏看到单据要点、审批链每一级的结果与意见；底部固定「同意」「退回」（手机上整屏）。

import { useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, CornerUpLeft, ExternalLink, TriangleAlert, X } from 'lucide-react';
import { APPROVAL_DOC_TYPE_LABELS, APPROVAL_MODE_LABELS, APPROVAL_STATUS_LABELS } from '@shared/approvals';
import { erpModuleOfPage } from '@shared/erp';
import { COUNT_REASONS, COUNT_REASON_LABELS } from '@shared/inventory';
import { errorMessage, UncertainError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Money } from '../../components/Money';
import { Badge, Button, IconButton, Input, Notice, Select, Skeleton } from '../../components/ui';
import { ApprovalResend, waited } from './ApprovalProgress';
import { useApprovalDetail, useRefreshAfterApproval } from './queries';
import { sendApproval, useSettleWhenFinished, useUncertainApprovals } from './uncertain';

export function ApprovalSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  return (
    <Sheet open={id !== null} onClose={onClose} label="审批单" width="w-[min(560px,100vw)]">
      {id !== null && <Body id={id} onClose={onClose} />}
    </Sheet>
  );
}

function Body({ id, onClose }: { id: number; onClose: () => void }) {
  const detail = useApprovalDetail(id);
  const refresh = useRefreshAfterApproval();
  const toast = useToast();
  const session = useSession();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approve' | 'return' | null>(null);
  const [returning, setReturning] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const d = detail.data;
  // 上次同意或退回没收到结果：只能按原内容重新提交（uncertain.ts），不按刷新后的级别重新拼
  const sent = useUncertainApprovals();
  useSettleWhenFinished(d?.id, d?.status);
  const uncertain = d?.status === 'pending' ? sent.get(d.id) : null;

  const act = async (action: 'approve' | 'return', body: Record<string, unknown>) => {
    if (!d) return;
    setBusy(action);
    try {
      await sendApproval({ staffId: sent.staffId, requestId: d.id, docNo: d.docNo, action, level: d.currentLevel, url: `/api/approvals/${d.id}/${action}`, body: { level: d.currentLevel, ...body } });
      toast({ tone: 'success', title: action === 'approve' ? (d.currentLevel < d.levels ? `已同意第 ${d.currentLevel} 级` : '已同意，单据生效') : '已退回', body: d.docNo });
      setReturning(false);
      setComment('');
      await refresh();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: `没收到结果：${errorMessage(e)}`, body: `${d.docNo} 可能已经生效，下面只能按原内容重新提交` });
        setReturning(false);
      } else toast({ tone: 'error', title: errorMessage(e) });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <header className="flex shrink-0 items-start gap-3 border-b border-line bg-card px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[16px] font-bold">
            {d ? APPROVAL_DOC_TYPE_LABELS[d.docType] : '审批单'}
            {d && <span className="num text-[13px] font-semibold text-ink-3">{d.docNo}</span>}
            {d && (
              <Badge tone={d.status === 'approved' ? 'pine' : d.status === 'pending' ? (d.overdue ? 'clay' : 'yuzu') : 'neutral'}>
                {d.status === 'pending' && d.overdue ? '超时' : APPROVAL_STATUS_LABELS[d.status]}
              </Badge>
            )}
          </p>
          {d && (
            <p className="mt-0.5 text-[12.5px] text-ink-3">
              {d.submittedByName} 提交 · {formatDateTime(d.submittedAt)} · {d.ruleId ? `审批规则${d.ruleNote ? `「${d.ruleNote}」` : ''}` : '默认规则'}
            </p>
          )}
        </div>
        <IconButton label="关闭" onClick={onClose}>
          <X className="size-5" />
        </IconButton>
      </header>

      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" data-testid="approval-detail">
        {detail.error ? (
          <Notice tone="error" title={errorMessage(detail.error)} />
        ) : !d ? (
          <Skeleton className="h-60" />
        ) : (
          <>
            <section className="rounded-lg border border-line bg-card px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 text-[14px] font-semibold">
                  {d.doc.title}
                  {d.doc.party && <span className="text-ink-2"> · {d.doc.party}</span>}
                </p>
                {d.amountCents !== null ? <Money cents={d.amountCents} className="text-[18px] font-bold" /> : <span className="text-[12.5px] text-ink-3">金额算不出</span>}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">
                {d.departmentName && <Fact label="部门" value={d.departmentName} />}
                {d.doc.docDate && <Fact label="日期" value={d.doc.docDate} />}
                {d.doc.facts.map((f) => (
                  <Fact key={f.label} label={f.label} value={f.value} />
                ))}
              </dl>
              {d.doc.note && <p className="mt-2 text-[12.5px] text-ink-2">备注：{d.doc.note}</p>}
              {erpModuleOfPage(d.doc.link.split('?')[0]!) && session.erpModules.includes(erpModuleOfPage(d.doc.link.split('?')[0]!)!) && (
                <Link to={d.doc.link} className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-lake hover:underline">
                  打开原单据 <ExternalLink className="size-3.5" />
                </Link>
              )}
            </section>

            {d.doc.lines.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-[13px] font-bold text-ink-2">单据要点</h3>
                <ul className="divide-y divide-line rounded-lg border border-line bg-card" data-testid="approval-lines">
                  {d.doc.lines.map((l) => (
                    <li key={l.id} className="px-3.5 py-2.5 text-[13px]">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="min-w-0 font-semibold">
                          {l.name}
                          {l.spec && <span className="ml-1.5 text-[12px] font-normal text-ink-3">{l.spec}</span>}
                        </p>
                        {l.amountCents !== null && <Money cents={l.amountCents} className="shrink-0 text-[13px] font-semibold" />}
                      </div>
                      {l.count ? (
                        <div className="mt-1 space-y-1 text-[12.5px] text-ink-2">
                          <p className="num">
                            账面 {l.count.bookMilli / 1000} · 实盘 {l.count.countedMilli / 1000} ·{' '}
                            <span className={l.count.diffMilli < 0 ? 'text-clay' : 'text-pine'}>
                              差异 {l.count.diffMilli > 0 ? '+' : ''}
                              {l.qty} {l.unit}
                            </span>
                            {l.count.pct !== null && ` · ${l.count.pct > 0 ? '+' : ''}${l.count.pct}%`}
                            {l.count.big && (
                              <Badge tone="clay" className="ml-1.5">
                                大差异
                              </Badge>
                            )}
                          </p>
                          <p>
                            原因：{l.count.reason ?? '未写（确认时按默认）'}
                            {l.count.reasonNote && ` · ${l.count.reasonNote}`}
                          </p>
                          {d.canAct && !uncertain && d.currentLevel === d.levels && (
                            <label className="flex items-center gap-2">
                              <span className="shrink-0 text-ink-3">确认原因</span>
                              <Select
                                value={reasons[l.id] ?? ''}
                                onChange={(e) => setReasons((r) => ({ ...r, [l.id]: e.target.value }))}
                                className="h-8 text-[12.5px]"
                                data-testid={`approval-reason-${l.id}`}
                              >
                                <option value="">照提交时的</option>
                                {COUNT_REASONS.map((r) => (
                                  <option key={r} value={r}>
                                    {COUNT_REASON_LABELS[r]}
                                  </option>
                                ))}
                              </Select>
                            </label>
                          )}
                        </div>
                      ) : (
                        l.qty && (
                          <p className="num mt-0.5 text-[12.5px] text-ink-3">
                            {l.qty} {l.unit}
                            {l.priceCents !== null && ` × ¥${(l.priceCents / 100).toFixed(2)}`}
                          </p>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h3 className="mb-1.5 text-[13px] font-bold text-ink-2">审批链</h3>
              <ol className="space-y-2" data-testid="approval-chain">
                {d.levelsDetail.map((lv) => (
                  <li
                    key={lv.level}
                    className={cn('rounded-lg border px-3.5 py-2.5 text-[13px]', lv.state === 'current' ? 'border-yuzu-deep/40 bg-yuzu-tint' : 'border-line bg-card')}
                    data-testid={`approval-chain-${lv.level}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num text-[12px] text-ink-3">第 {lv.level} 级</span>
                      <span className="font-bold">{lv.label}</span>
                      <span className="text-[12px] text-ink-3">{APPROVAL_MODE_LABELS[lv.mode]}</span>
                      <span className="ml-auto text-[12px] font-semibold">
                        {lv.state === 'done' ? (
                          <span className="text-pine">已同意</span>
                        ) : lv.state === 'returned' ? (
                          <span className="text-clay">已退回</span>
                        ) : lv.state === 'current' ? (
                          <span className="text-yuzu-deep">审批中 · 等了 {waited(d.levelStartedAt)}</span>
                        ) : (
                          <span className="text-ink-4">未到</span>
                        )}
                      </span>
                    </div>
                    {lv.waitingFor.length > 0 && <p className="mt-1 text-[12.5px] text-ink-2">还要 {lv.waitingFor.join('、')} 同意</p>}
                    {lv.actions.map((a) => (
                      <p key={a.id} className="mt-1 text-[12.5px] text-ink-2">
                        <span className={a.action === 'return' ? 'font-semibold text-clay' : 'font-semibold text-pine'}>{a.action === 'return' ? '退回' : '同意'}</span>
                        <span>
                          {' '}
                          · {a.actorName}
                          {a.onBehalfOfName ? `（代 ${a.onBehalfOfName}）` : ''}
                        </span>
                        {a.batch && <span className="text-ink-3"> · 批量</span>}
                        <span className="num text-ink-3"> · {formatDateTime(a.createdAt)}</span>
                        {a.comment && <span className="block text-ink">{a.comment}</span>}
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
              {d.stuck && (
                <Notice tone="warning" className="mt-2" icon={<TriangleAlert className="size-4" />} title="这一级目前没人能审">
                  提交人不能审自己的单、指定的人停用或没有审批权限时会这样。请店主改审批规则后让提交人撤回重提，或由店主审。
                </Notice>
              )}
            </section>

            {d.previous.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-[13px] font-bold text-ink-2">以前几轮</h3>
                <ul className="space-y-1 text-[12.5px] text-ink-2">
                  {d.previous.map((p) => (
                    <li key={p.id}>
                      {formatDateTime(p.submittedAt)} 提交 · {APPROVAL_STATUS_LABELS[p.status]}
                      {p.lastComment && ` · ${p.lastComment}`}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {uncertain ? (
        <footer className="shrink-0 border-t border-line bg-card px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          <ApprovalResend sent={uncertain} onDone={refresh} />
        </footer>
      ) : d?.canAct && (
        <footer className="shrink-0 space-y-2 border-t border-line bg-card px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          {d.actingFor.length > 0 && <p className="text-[12.5px] font-semibold text-lake">你是 {d.actingFor.join('、')} 的代理人，这次记「代 {d.actingFor.join('、')}」</p>}
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="意见（选填）" maxLength={200} data-testid="approval-comment" />
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" icon={<CornerUpLeft className="size-4" />} onClick={() => setReturning(true)} data-testid="approval-return">
              退回
            </Button>
            <Button
              variant="primary"
              className="flex-[2]"
              loading={busy === 'approve'}
              icon={<CircleCheck className="size-4" />}
              data-testid="approval-approve"
              onClick={() =>
                void act('approve', {
                  comment: comment.trim(),
                  ...(Object.values(reasons).some(Boolean) ? { countReasons: Object.fromEntries(Object.entries(reasons).filter(([, v]) => v)) } : {}),
                })
              }
            >
              {d.levels > 1 ? `同意（第 ${d.currentLevel}/${d.levels} 级）` : '同意'}
            </Button>
          </div>
        </footer>
      )}

      <ReasonDialog
        open={returning}
        busy={busy === 'return'}
        title={`退回 ${d?.docNo ?? ''}`}
        description="退回后单据回到经办人「已退回」，改了再提交从第一级重新走。"
        label="退回原因"
        confirmLabel="退回"
        testId="approval-return-dialog"
        onClose={() => setReturning(false)}
        onConfirm={(reason) => void act('return', { reason })}
      />
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 truncate text-ink">{value}</dd>
    </div>
  );
}
