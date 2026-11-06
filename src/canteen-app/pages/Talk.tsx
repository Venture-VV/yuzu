// 跟柚子说（docs/CANTEEN.md 第 16 节，K16）：想让柚子在汤崎的线上数字化空间做的事（心愿）、碎碎念，都可以写给柚子；
// 管理员在后台「柚子信箱」看、回信，回信显示在下面「我说过的」里。
// 结果待确认（AGENTS.md）：发之前把操作编号与内容存在这台手机上并读回核对，存不下就不发；回复没收到时留着，
// 再打开页面或联网时按原编号自动重发（同一个编号不会存两条），也可以点「原样再发」。

import { useCallback, useEffect, useState } from 'react';
import { FEEDBACK_KIND_LABELS, FEEDBACK_LIMITS, type CanteenMe, type FeedbackKind, type MyFeedbackRow } from '@shared/canteen';
import { Mascot } from '../Mascot';
import { IconLetter, IconSparkle } from '../doodles';
import { ApiError, call, dayText, messageOf, NetworkError, readJson, removeKey, timeText, uuid, writeJson } from '../lib';
import { Button, Card, cn, Pill, toast } from '../ui';

interface Pending {
  clientKey: string;
  kind: FeedbackKind;
  content: string;
  savedAt: number;
}
const pendingKey = (employeeId: number) => `yuzu.canteen.talkPending.v1.${employeeId}`;

const PLACEHOLDER: Record<FeedbackKind, string> = {
  wish: '例如：想在手机上就能看到排班表；希望打卡以后能提醒我明天吃什么……',
  chat: '例如：今天的汤有点咸；红烧肉太好吃了；最近好累……柚子都听着',
};

export function TalkPage({ me, online }: { me: CanteenMe; online: boolean }) {
  const storeKey = pendingKey(me.employee.id);
  const [kind, setKind] = useState<FeedbackKind>('wish');
  const [content, setContent] = useState('');
  const [rows, setRows] = useState<MyFeedbackRow[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(() => readJson<Pending>(storeKey));
  const [busy, setBusy] = useState(false);
  const [flying, setFlying] = useState(0);

  const load = useCallback(async () => {
    try {
      setRows(await call<MyFeedbackRow[]>('GET', '/api/canteen/feedback'));
    } catch {
      setRows((r) => r ?? []);
    }
  }, []);

  /** 交给门店系统；没收到回复时留着这一条 */
  const send = useCallback(
    async (p: Pending): Promise<boolean> => {
      setBusy(true);
      try {
        await call<MyFeedbackRow>('POST', '/api/canteen/feedback', { clientKey: p.clientKey, kind: p.kind, content: p.content });
        removeKey(storeKey);
        setPending(null);
        setFlying((n) => n + 1);
        toast('柚子收到啦！✉️', 'ok');
        void load();
        return true;
      } catch (e) {
        if (e instanceof NetworkError) {
          toast('网络不太好，这一条先存在手机上，联网后再发', 'error');
        } else {
          // 门店系统明确拒绝了（太长、今天说太多了……）：这一条不会生效，放下，内容放回输入框
          removeKey(storeKey);
          setPending(null);
          setContent(p.content);
          setKind(p.kind);
          toast(messageOf(e), 'error');
          if (e instanceof ApiError && e.status === 401) window.location.reload();
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [storeKey, load],
  );

  useEffect(() => {
    if (!online) return;
    void load();
    // 上次没确认送到的，打开页面（或联网）时按原编号重发
    const p = readJson<Pending>(storeKey);
    if (p) void send(p);
  }, [online, load, send, storeKey]);

  const submit = async () => {
    const text = content.trim();
    if (!text) return toast('写点什么吧', 'error');
    const p: Pending = { clientKey: uuid(), kind, content: text, savedAt: Date.now() };
    if (!writeJson(storeKey, p)) return toast('这台手机存不下，先不发了：清理一下浏览器的存储再试', 'error');
    setPending(p);
    setContent('');
    await send(p);
  };

  const left = FEEDBACK_LIMITS.content - [...content].length;

  return (
    <div className="space-y-4" data-testid="talk-page">
      <header className="relative flex items-end gap-2">
        <div className="min-w-0 flex-1 pb-2">
          <p className="eyebrow">Talk to Yuzu</p>
          <h1 className="mt-1 text-[26px] font-black tracking-tight">
            <span className="marker">跟柚子说</span>
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">想让柚子在汤崎的线上空间做什么？或者就是想吐槽两句、碎碎念——柚子都听着。</p>
        </div>
        <div className="relative w-28 shrink-0">
          <Mascot pose={flying ? 'cheer' : 'rest'} mood={flying ? 'love' : 'wink'} className="h-36 w-auto" title="柚子" />
          {flying > 0 && (
            <span key={flying} className="absolute top-10 -left-10 text-wood-deep" style={{ ['--fx' as string]: '70px', ['--fy' as string]: '-40px', animation: 'yz-fly .9s ease-in forwards' }} aria-hidden>
              <IconLetter size={34} fill="var(--color-yuzu)" />
            </span>
          )}
        </div>
      </header>

      {pending && (
        <Card sketch className="bg-yuzu-soft" data-testid="talk-pending">
          <p className="text-[14px] font-black text-yuzu-deep">这一条还没确认送到</p>
          <p className="mt-1 line-clamp-3 text-[14px] text-ink-2">「{pending.content}」</p>
          <p className="mt-1 text-[12.5px] text-ink-3">联网后会自动再发一次（同一条不会发两遍）；也可以现在点「原样再发」。</p>
          <Button className="mt-3" tone="ink" disabled={busy || !online} onClick={() => void send(pending)}>
            原样再发
          </Button>
        </Card>
      )}

      <Card sketch className="space-y-3">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="说点什么">
          {(['wish', 'chat'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-2xl py-2.5 text-[15px] font-black transition-all active:scale-95',
                kind === k ? 'bg-wood-deep text-white shadow-[0_3px_0_var(--color-wood-ink)]' : 'bg-cream text-ink-2 ring-1 ring-line-strong',
              )}
            >
              {k === 'wish' ? <IconSparkle size={20} fill={kind === k ? 'var(--color-yuzu)' : 'none'} /> : <IconLetter size={20} fill={kind === k ? 'var(--color-yuzu)' : 'none'} />}
              {FEEDBACK_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={PLACEHOLDER[kind]}
          rows={5}
          maxLength={FEEDBACK_LIMITS.content}
          aria-label="想跟柚子说的话"
          className="block w-full resize-none rounded-2xl border-0 bg-white px-4 py-3 text-[16px] leading-relaxed text-ink ring-2 ring-line outline-none placeholder:text-ink-4 focus:ring-wood"
          style={{ backgroundImage: 'repeating-linear-gradient(transparent 0 27px, rgb(147 112 81 / .12) 27px 28px)', backgroundPosition: '0 11px' }}
        />
        <div className="flex items-center gap-3">
          <span className={cn('num text-[12.5px]', left < 30 ? 'font-bold text-energy' : 'text-ink-3')}>还能写 {left} 字</span>
          <Button className="ml-auto" disabled={busy || !content.trim() || !online} onClick={() => void submit()} data-testid="talk-send">
            <IconLetter size={20} fill="var(--color-yuzu)" /> 交给柚子
          </Button>
        </div>
        {!online && <p className="text-[13px] font-bold text-relax">现在没网：联网后才能发</p>}
      </Card>

      <section className="space-y-2">
        <h2 className="flex items-center gap-2 px-1 text-[15px] font-extrabold text-ink-2">
          我说过的
          <span className="eyebrow">My notes</span>
        </h2>
        {rows === null && online && <p className="px-1 text-[14px] text-ink-3">正在取…</p>}
        {!online && rows === null && <p className="px-1 text-[14px] text-ink-3">联网后才看得到</p>}
        {rows?.length === 0 && (
          <Card className="flex items-center gap-3">
            <Mascot mood="sleepy" className="size-14 shrink-0" />
            <p className="text-[14px] text-ink-2">还没跟柚子说过话。第一句写点什么？</p>
          </Card>
        )}
        <ul className="space-y-2.5">
          {rows?.map((r) => (
            <li key={r.id}>
              <Card className="space-y-2 py-3">
                <div className="flex items-center gap-2">
                  <Pill tone={r.kind === 'wish' ? 'yuzu' : 'wood'}>{FEEDBACK_KIND_LABELS[r.kind]}</Pill>
                  <span className="num text-[12.5px] text-ink-3">
                    {dayText(r.createdAt)} {timeText(r.createdAt)}
                  </span>
                  <span className={cn('ml-auto text-[12px] font-bold', r.read ? 'text-organic' : 'text-ink-3')}>{r.read ? '柚子看过了' : '柚子还没看'}</span>
                </div>
                <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-ink">{r.content}</p>
                {r.reply && (
                  <div className="flex gap-2 rounded-2xl bg-cream px-3 py-2.5" data-testid="talk-reply">
                    <Mascot mood="happy" className="size-9 shrink-0" still />
                    <div className="min-w-0">
                      <p className="text-[12px] font-black text-wood-deep">柚子回信</p>
                      <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-ink-2">{r.reply}</p>
                    </div>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
