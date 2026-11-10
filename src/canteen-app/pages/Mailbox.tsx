// 柚子信箱（食堂负责人，店主 2026-11-10，docs/CANTEEN.md 第 18 节，K20）：员工「跟柚子说」的心愿和碎碎念，负责人在手机上看、
// 点「看过了」、回一句话（最多 300 字），不用再开电脑。和后台 ERP「员工食堂 → 柚子信箱」是同一份：谁看过、谁回的后台都看得到；
// 员工在「跟柚子说」里看到的回信照旧写「柚子回信」。
// 结果待确认（AGENTS.md）：回信之前把操作编号与内容存在这台手机上并读回核对，存不下就不发；回复没收到时留着，再打开这一页
// 或联网时按原编号自动重发（同一个编号只记一次，之后改过的回信不会被它改回去），也可以点「原样再发」；没确认之前不能回别的。

import { useCallback, useEffect, useRef, useState } from 'react';
import { FEEDBACK_KIND_LABELS, FEEDBACK_LIMITS, type CanteenFeedbackList, type CanteenFeedbackRow, type CanteenMe } from '@shared/canteen';
import { Mascot } from '../Mascot';
import { IconLetter } from '../doodles';
import { ApiError, call, dayText, messageOf, NetworkError, readJson, removeKey, timeText, uuid, writeJson } from '../lib';
import { Button, Card, cn, Pill, Sheet, toast } from '../ui';

interface PendingReply {
  clientKey: string;
  /** 回的是哪一条 */
  id: number;
  reply: string;
  /** 给人看的：回给谁、他说了什么 */
  to: string;
  savedAt: number;
}
const pendingKey = (managerId: number) => `yuzu.canteen.mailboxPending.v1.${managerId}`;

type Filter = 'all' | 'unread' | 'replied';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '没看过的' },
  { key: 'replied', label: '回过信的' },
];

export function MailboxPage({ me, online }: { me: CanteenMe; online: boolean }) {
  const storeKey = pendingKey(me.employee.id);
  const [filter, setFilter] = useState<Filter>('all');
  const [list, setList] = useState<CanteenFeedbackList | null>(null);
  const [pending, setPending] = useState<PendingReply | null>(() => readJson<PendingReply>(storeKey));
  const [writing, setWriting] = useState<CanteenFeedbackRow | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // 正在发的那一条：同一条同时只发一次（联网时的自动重发不会和还没回来的那次叠在一起）
  const sending = useRef<string | null>(null);
  // 发回信时要找那一条（被拒时把内容放回去改）：用最新的列表，send 不随列表重建
  const listRef = useRef(list);
  listRef.current = list;

  const load = useCallback(async () => {
    try {
      setList(await call<CanteenFeedbackList>('GET', `/api/canteen/mailbox?status=${filter}`));
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) toast(messageOf(e), 'error');
      setList((l) => l ?? { rows: [], total: 0, unread: 0 });
    }
  }, [filter]);

  /** 改好的那一条换进列表（没看过的数跟着变） */
  const adopt = useCallback((row: CanteenFeedbackRow) => {
    setList((l) => {
      if (!l) return l;
      const old = l.rows.find((r) => r.id === row.id);
      const nowRead = !!old && !old.readAt && !!row.readAt;
      return { ...l, rows: l.rows.map((r) => (r.id === row.id ? row : r)), unread: Math.max(0, l.unread - (nowRead ? 1 : 0)) };
    });
  }, []);

  /** 交给门店系统；没收到回复时留着这一笔 */
  const send = useCallback(
    async (p: PendingReply): Promise<boolean> => {
      if (sending.current === p.clientKey) return false;
      sending.current = p.clientKey;
      setBusy(true);
      // 有了结论只放下这一笔：手机上存的已经是别的一笔时不动它
      const settle = () => {
        if (readJson<PendingReply>(storeKey)?.clientKey === p.clientKey) removeKey(storeKey);
        setPending((cur) => (cur?.clientKey === p.clientKey ? null : cur));
      };
      try {
        const row = await call<CanteenFeedbackRow>('POST', `/api/canteen/mailbox/${p.id}/reply`, { clientKey: p.clientKey, reply: p.reply });
        settle();
        adopt(row);
        toast('回信送到啦，柚子替你交给他了 ✉️', 'ok');
        return true;
      } catch (e) {
        // 只有这几种拒绝能说明这一笔（连同之前没收到回复的那次）不会生效：内容不对（原来那次也一样不对）、
        // 没有这一条（说过的话不会被删）、这个编号已经用在别的内容上（原来那次没有按这个内容记下）。放下，内容放回去改
        const settled = e instanceof ApiError && (e.status === 400 || e.status === 404 || e.code === 'IDEMPOTENCY_CONFLICT');
        if (settled) {
          settle();
          toast(messageOf(e), 'error');
          setDraft(p.reply);
          setWriting((cur) => cur ?? listRef.current?.rows.find((r) => r.id === p.id) ?? null);
        } else if (e instanceof ApiError && e.status === 401) {
          // 登录过期：这一笔留在手机上，重新登录以后打开柚子信箱会按原编号再发
          toast('登录过期了：重新登录以后会把这一条回信原样再发一次', 'error');
          window.location.reload();
        } else {
          // 没网、超时、门店系统出错或暂时关着、权限变了：不知道之前那次送到没有，这一笔留着，之后按原编号再发
          toast(e instanceof NetworkError ? '网络不太好，这一条回信先存在手机上，联网后再发' : `${messageOf(e)}（这一条回信先存在手机上，之后再发）`, 'error');
        }
        return false;
      } finally {
        if (sending.current === p.clientKey) sending.current = null;
        setBusy(false);
      }
    },
    [storeKey, adopt],
  );

  useEffect(() => {
    if (!online) return;
    void load();
  }, [online, load]);

  // 上次没确认送到的回信，打开这一页（或联网）时按原编号重发
  useEffect(() => {
    if (!online) return;
    const p = readJson<PendingReply>(storeKey);
    if (p) void send(p);
  }, [online, storeKey, send]);

  const markRead = async (row: CanteenFeedbackRow) => {
    try {
      adopt(await call<CanteenFeedbackRow>('POST', `/api/canteen/mailbox/${row.id}/read`));
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  };

  const openReply = (row: CanteenFeedbackRow) => {
    if (pending) return toast('上一条回信还没确认送到：先点「原样再发」', 'error');
    setWriting(row);
    setDraft(row.reply ?? '');
  };

  const submit = async () => {
    if (!writing) return;
    const text = draft.trim();
    if (!text) return toast('写一句回信', 'error');
    // 上一笔还没确认送到：先把它发出去（再回一条会顶掉它的操作编号，那一笔就没法确认了）
    if (pending || readJson<PendingReply>(storeKey)) return toast('上一条回信还没确认送到：先点「原样再发」', 'error');
    const p: PendingReply = { clientKey: uuid(), id: writing.id, reply: text, to: `${writing.name}：${writing.content}`, savedAt: Date.now() };
    if (!writeJson(storeKey, p)) return toast('这台手机存不下，先不发了：清理一下浏览器的存储再试', 'error');
    setPending(p);
    setWriting(null);
    setDraft('');
    await send(p);
  };

  const left = FEEDBACK_LIMITS.reply - [...draft].length;

  return (
    <div className="space-y-4" data-testid="mailbox-page">
      <header className="relative flex items-end gap-2">
        <div className="min-w-0 flex-1 pb-2">
          <p className="eyebrow">Yuzu&apos;s mailbox</p>
          <h1 className="mt-1 text-[26px] font-black tracking-tight">
            <span className="marker">柚子信箱</span>
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">同事们跟柚子说的话都在这儿。看过了点一下；回一句，柚子替你送到他的「跟柚子说」里。</p>
        </div>
        <div className="w-24 shrink-0">
          <Mascot pose="rest" mood={list?.unread ? 'wink' : 'happy'} className="h-32 w-auto" title="柚子" />
        </div>
      </header>

      {pending && (
        <Card sketch className="bg-yuzu-soft" data-testid="mailbox-pending">
          <p className="text-[14px] font-black text-yuzu-deep">这一条回信还没确认送到</p>
          <p className="mt-1 line-clamp-2 text-[13px] text-ink-3">回给 {pending.to}</p>
          <p className="mt-1 line-clamp-3 text-[14px] text-ink-2">「{pending.reply}」</p>
          <p className="mt-1 text-[12.5px] text-ink-3">联网后会自动再发一次（同一条不会发两遍）；也可以现在点「原样再发」。</p>
          <Button className="mt-3" tone="ink" disabled={busy || !online} onClick={() => void send(pending)}>
            原样再发
          </Button>
        </Card>
      )}

      <div className="flex gap-2" role="radiogroup" aria-label="看哪些">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="radio"
            aria-checked={filter === f.key}
            onClick={() => setFilter(f.key)}
            data-testid={`mailbox-filter-${f.key}`}
            className={cn('rounded-full px-3.5 py-1.5 text-[14px] font-bold active:scale-95', filter === f.key ? 'bg-wood-deep text-white' : 'bg-card text-ink-2 ring-1 ring-line')}
          >
            {f.label}
            {f.key === 'unread' && !!list?.unread && <span className="num ml-1" data-testid="mailbox-unread">{list.unread}</span>}
          </button>
        ))}
      </div>

      {!online && list === null && <p className="px-1 text-[14px] text-ink-3">联网后才看得到</p>}
      {online && list === null && <p className="px-1 text-[14px] text-ink-3">正在取…</p>}
      {list?.rows.length === 0 && (
        <Card className="flex items-center gap-3">
          <Mascot mood="sleepy" className="size-14 shrink-0" />
          <p className="text-[14px] text-ink-2">{filter === 'unread' ? '都看过啦，没有新的。' : '信箱里还空空的。'}</p>
        </Card>
      )}

      <ul className="space-y-2.5">
        {list?.rows.map((r) => (
          <li key={r.id}>
            <Card className={cn('space-y-2 py-3', !r.readAt && 'ring-2 ring-yuzu-deep/40')} data-testid="mailbox-item" data-id={r.id}>
              <div className="flex items-center gap-2">
                <span className="text-[24px] leading-none">{r.avatar}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-black">
                    {r.name} <span className="num text-[12.5px] font-semibold text-ink-3">{r.empNo}</span>
                  </p>
                  <p className="num text-[12px] text-ink-3">
                    {dayText(r.createdAt)} {timeText(r.createdAt)}
                  </p>
                </div>
                <Pill tone={r.kind === 'wish' ? 'yuzu' : 'wood'}>{FEEDBACK_KIND_LABELS[r.kind]}</Pill>
              </div>
              <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-ink">{r.content}</p>
              {r.reply && (
                <div className="flex gap-2 rounded-2xl bg-cream px-3 py-2.5" data-testid="mailbox-reply">
                  <Mascot mood="happy" className="size-9 shrink-0" still />
                  <div className="min-w-0">
                    <p className="text-[12px] font-black text-wood-deep">
                      柚子回信 · {r.repliedByName}
                      {r.repliedAt && <span className="num font-semibold text-ink-3"> · {dayText(r.repliedAt)} {timeText(r.repliedAt)}</span>}
                    </p>
                    <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-ink-2">{r.reply}</p>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                {r.readAt ? (
                  <span className="mr-auto text-[12px] font-bold text-organic">{r.readByName} 看过了</span>
                ) : (
                  <Button tone="ghost" className="mr-auto h-9 px-3 text-[13px]" onClick={() => void markRead(r)} disabled={!online} data-testid="mailbox-read">
                    看过了
                  </Button>
                )}
                <Button className="h-9 px-3 text-[13px]" onClick={() => openReply(r)} disabled={!online || busy} data-testid="mailbox-reply-open">
                  <IconLetter size={18} fill="var(--color-yuzu)" /> {r.reply ? '改回信' : '回信'}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {list && list.total > list.rows.length && <p className="px-1 text-center text-[12.5px] text-ink-3">只列了最近 {list.rows.length} 条（一共 {list.total} 条），更早的在电脑上的柚子信箱里看</p>}

      <Sheet open={!!writing} onClose={() => setWriting(null)} title={writing ? `回信给 ${writing.name}` : '回信'}>
        {writing && (
          <div className="space-y-3 pb-6">
            <p className="line-clamp-4 rounded-2xl bg-cream px-3 py-2 text-[14px] text-ink-2">「{writing.content}」</p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              maxLength={FEEDBACK_LIMITS.reply}
              placeholder="写一句回信，他会在「跟柚子说」里看到（写「柚子回信」）"
              aria-label="回信"
              data-testid="mailbox-reply-text"
              className="block w-full resize-none rounded-2xl border-0 bg-white px-4 py-3 text-[16px] leading-relaxed text-ink ring-2 ring-line outline-none placeholder:text-ink-4 focus:ring-wood"
            />
            <div className="flex items-center gap-3">
              <span className={cn('num text-[12.5px]', left < 30 ? 'font-bold text-energy' : 'text-ink-3')}>还能写 {left} 字</span>
              <Button className="ml-auto" disabled={busy || !draft.trim() || !online} onClick={() => void submit()} data-testid="mailbox-reply-send">
                <IconLetter size={20} fill="var(--color-yuzu)" /> 送回信
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
