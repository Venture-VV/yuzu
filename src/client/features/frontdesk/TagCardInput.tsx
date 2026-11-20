// 刷卡带出牌号（8.1.15，docs/FRONTDESK_RISK_V8115.md 第 2 节）：能单独用的牌号输入部件 TagCardInput ——
// 读卡器状态、刷到的芯片号查牌号、失败原因，随时能手输。接待发牌、换牌用它；房态中心登记手牌号也直接用它（第 2.5 节的接头说明）。
//
// 读卡走设备模块的读卡通道（docs/HARDWARE.md 第 3 节）：
//   · 本机终端的设备服务（桥）报上来的读卡（串口读卡器、商米终端的 NFC）；
//   · USB 读卡器当键盘用的：很短时间内连续输入、以回车结束的一串认作一次刷卡——光标在牌号框里时由牌号框自己收
//     （框里原来的内容不动，这一串按芯片号查）；光标不在任何输入框里时在窗口上收。
// 浏览器的 Web NFC 要 HTTPS，门店内网是 http，用不了。
//
// 一屏上有几个牌号框时（接待发牌一位客人一行）：只让当前那一个收读卡（listening），读卡器状态那一行由页面自己放一条 ReaderStatusLine。

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from 'react';
import { CircleAlert, CircleCheck, Nfc } from 'lucide-react';
import { createWedgeRecognizer, WEDGE_MAX_GAP_MS } from '@shared/devices';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { CARD_UID_PATTERN, normalizeCardUid, type TagByCard, type TagCardFound } from '@shared/frontdesk-risk';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, isTypingTarget } from '../../lib/utils';
import { Input } from '../../components/ui';
import { useTerminalBridge, useTerminalState } from '../devices/terminal';
import { StatusChip } from './parts';

/** 读卡的结果：成功（ok）、提醒（warn，例如「本次已刷」）、读不出来或这张牌不能用的原因（error） */
export interface CardMessage {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

/** 按芯片号查手牌与现在的状态 */
export const lookupCard = (uid: string) => api.get<TagByCard>(`/api/frontdesk/tags/by-card?uid=${encodeURIComponent(uid)}`);

/** 读卡器现在的状态：连没连上、状态两个字、写给店员看的一句话 */
function useReaderStatus(): { ok: boolean; label: string; hint: string } {
  const can = useCan();
  const t = useTerminalState();
  if (!can('device.view')) return { ok: false, label: '读卡器状态看不到', hint: '这个账号没有「看设备状态」；键盘式读卡器可以直接刷，或手输牌号' };
  if (!t.connected) return { ok: false, label: '读卡器没连上', hint: '请手输牌号（USB 键盘式读卡器可以直接刷）' };
  const readers = t.devices.filter((d) => d.kind === 'card_reader');
  if (readers.some((d) => d.status === 'online')) return { ok: true, label: '读卡器已连接', hint: '把手牌放到读卡器上，牌号会自己带出来' };
  if (readers.length > 0) return { ok: false, label: '读卡器没连上', hint: '读卡器离线或故障，请手输牌号' };
  return { ok: false, label: '读卡器没连上', hint: '本机设备服务连上了，但没有读卡器；请手输牌号（USB 键盘式读卡器可以直接刷）' };
}

/**
 * 收读卡（低一层的钩子；一般直接用 TagCardInput）：桥报上来的新读卡、桥报的读卡失败、光标不在输入框里时键盘式读卡器打进来的卡号。
 * 只认打开之后的新事件；回调用最新的（不用放进依赖）。后台给手牌绑芯片号要的是卡号本身，直接用它。
 */
export function useCardReader(active: boolean, handlers: { onCard: (uid: string) => void; onReadError: (message: string) => void }) {
  useTerminalBridge(active);
  const events = useTerminalState().events;
  const latest = useRef(handlers);
  latest.current = handlers;
  const seen = useRef<string | null>(events[0]?.id ?? null);
  useEffect(() => {
    const e = events[0];
    if (!e || e.id === seen.current) return;
    seen.current = e.id;
    if (!active || e.source !== 'bridge') return;
    if (e.type === 'card') latest.current.onCard(e.value);
    else if (e.type === 'error') latest.current.onReadError(`没读到卡（${e.value}），请再刷一次，或手输牌号`);
  }, [events, active]);
  useEffect(() => {
    if (!active) return;
    const wedge = createWedgeRecognizer();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const code = wedge.feed(e.key, e.timeStamp);
      if (code) {
        // 这一次回车是读卡器打的，不是人按的「确认」
        e.preventDefault();
        e.stopPropagation();
        latest.current.onCard(code);
      }
    };
    // 抢在页面自己的回车处理之前
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
}

/** 读卡器状态那一行：连没连上（没连上时写「请手输牌号」），与最近一次读卡的结果 */
export function ReaderStatusLine({ message, className }: { message?: CardMessage | null; className?: string }) {
  const status = useReaderStatus();
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-paper/60 px-3 py-2', className)} data-testid="reader-line">
      <StatusChip tone={status.ok ? 'pine' : 'neutral'} icon={<Nfc className="size-4 shrink-0" />} testId="reader-status">
        {status.label}
      </StatusChip>
      {message ? <CardMessageText message={message} /> : <span className="min-w-0 text-[13px] text-ink-3">{status.hint}</span>}
    </div>
  );
}

function CardMessageText({ message, className }: { message: CardMessage; className?: string }) {
  return (
    <span
      className={cn('flex min-w-0 items-start gap-1 text-[13px] font-semibold', message.tone === 'ok' ? 'text-pine' : message.tone === 'warn' ? 'text-yuzu-deep' : 'text-clay', className)}
      role={message.tone === 'error' ? 'alert' : 'status'}
      data-testid="reader-message"
      data-tone={message.tone}
    >
      {message.tone === 'ok' ? <CircleCheck className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
      {message.text}
    </span>
  );
}

export interface TagCardInputProps {
  /** 牌号（受控）。手输照常；刷卡查到能用的牌时也经 onChange 填进来 */
  value: string;
  onChange: (code: string) => void;
  /**
   * 刷卡查到了一张牌，这里能不能用：能用返回 null；不能用返回写给店员看的原因（字符串按「读不出来」显示，
   * 要按提醒显示的——例如「本次已刷」——返回 { tone: 'warn', text }）。不给时查到的都接受。
   * 发牌要空闲的牌（@shared/frontdesk-risk 的 cardProblem）；房态登记要在店的牌（看 found.state === 'in_use' 与 found.visit）。
   */
  check?: (found: TagCardFound) => CardMessage | string | null;
  /** 刷卡带出了牌号（已经过 check，牌号也已经经 onChange 填进来）：这里拿得到手牌、现在的状态与在店的来访 */
  onCard?: (found: TagCardFound) => void;
  /** 带出牌号以后写的那句话；不给时写「已读到 牌号，核对后再确认」 */
  okText?: (found: TagCardFound) => string;
  /** 框里的内容算不算一个牌号（算的话回车不按芯片号查，交给 onEnter）；不给时按牌号的格式判断 */
  isTagCode?: (code: string) => boolean;
  /** 人按了回车（框里是牌号，或是空的）：补全、提交由页面自己定；不想让回车再往外传的自己 preventDefault */
  onEnter?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** 这一个现在收不收读卡；一屏上有几个牌号框时只让当前那一个收。默认收 */
  listening?: boolean;
  /** 显示读卡器状态那一行；一屏上有几个牌号框时关掉，由页面自己放一条 ReaderStatusLine。默认显示 */
  showStatus?: boolean;
  /** 读卡结果（成功、失败原因）写在输入框下面；页面要自己显示时关掉、用 onMessage 接。默认显示 */
  showMessage?: boolean;
  onMessage?: (message: CardMessage | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onBlur?: () => void;
  className?: string;
  inputClassName?: string;
  /** 浏览器用例用：输入框的 data-testid */
  testId?: string;
}

/**
 * 牌号输入框，能刷卡带出牌号：
 *   · 读卡器刷到一张牌 → 按芯片号查 → 经 check 判断 → 牌号填进来（不提交，核对后由页面自己确认）；
 *   · 读不出来写明原因：读卡器没连上、没读到卡、这张卡没绑手牌，以及 check 给的原因（已停用、已锁定、已在店、分区不符……）；
 *   · 键盘式读卡器把卡号打进这个框再回车：框里原来的内容不动，那一串按芯片号查；手敲进来的不是牌号时回车也按芯片号查一次；
 *   · 随时可以手输。
 */
export function TagCardInput({
  value,
  onChange,
  check,
  onCard,
  okText,
  isTagCode,
  onEnter,
  listening = true,
  showStatus = true,
  showMessage = true,
  onMessage,
  disabled,
  invalid,
  placeholder = '牌号',
  ariaLabel = '牌号',
  id,
  autoFocus,
  inputRef,
  onBlur,
  className,
  inputClassName,
  testId,
}: TagCardInputProps) {
  const [message, setMessage] = useState<CardMessage | null>(null);
  const say = (m: CardMessage | null) => {
    setMessage(m);
    onMessage?.(m);
  };
  /** 一串很快的按键从哪开始：那时框里的内容（读卡器打完以后恢复成它） */
  const burst = useRef({ wedge: createWedgeRecognizer(), prefix: '', last: -Infinity });
  const isTag = isTagCode ?? ((code: string) => TAG_CODE_PATTERN.test(code));

  /** 一张卡：按芯片号查牌、判断能不能用、填进来。typed 为这串内容是打进输入框的（可能是手敲错的牌号） */
  const read = async (raw: string, typed: boolean) => {
    const uid = normalizeCardUid(raw);
    if (!CARD_UID_PATTERN.test(uid)) return say({ tone: 'error', text: '没读到卡（卡号不完整），请再刷一次，或手输牌号' });
    let found: TagByCard;
    try {
      found = await lookupCard(uid);
    } catch (e) {
      return say({ tone: 'error', text: `查不到这张卡（${errorMessage(e)}），请手输牌号` });
    }
    if (!found.found) {
      return say({
        tone: 'error',
        text: typed ? `「${uid}」不是牌号，按芯片号查也没有绑定的手牌；请核对牌号，或到后台「手牌池」绑定这张卡` : '这张卡没绑手牌：请在后台「手牌与前台 → 手牌池」绑定，这一次先手输牌号',
      });
    }
    const problem = check?.(found) ?? null;
    if (problem) return say(typeof problem === 'string' ? { tone: 'error', text: `${problem}；可以换一张牌再刷，或手输牌号` } : problem);
    onChange(found.tag.code);
    onCard?.(found);
    say({ tone: 'ok', text: okText ? okText(found) : `已读到 ${found.tag.code}，核对后再确认` });
  };
  useCardReader(listening && !disabled, { onCard: (uid) => void read(uid, false), onReadError: (text) => say({ tone: 'error', text }) });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const b = burst.current;
    if (e.timeStamp - b.last > WEDGE_MAX_GAP_MS) b.prefix = value;
    b.last = e.timeStamp;
    const scanned = b.wedge.feed(e.key, e.timeStamp);
    if (e.key !== 'Enter') return;
    if (scanned) {
      // 键盘式读卡器（或扫码枪）打进来的一串：这一次回车不是人按的确认
      e.preventDefault();
      const code = normalizeTagCode(scanned);
      // 打进来的就是一个牌号（例如扫了印着牌号的码）：当牌号用
      if (isTag(code)) return onChange(code);
      onChange(b.prefix);
      void read(scanned, true);
      return;
    }
    const code = normalizeTagCode(value);
    // 手敲（或粘贴）进来的不是牌号：按芯片号查一次
    if (code && !isTag(code) && CARD_UID_PATTERN.test(normalizeCardUid(value))) {
      e.preventDefault();
      void read(value, true);
      return;
    }
    onEnter?.(e);
  };

  return (
    <div className={cn('min-w-0', className)}>
      {showStatus && <ReaderStatusLine className="mb-2" />}
      <Input
        ref={inputRef}
        id={id}
        autoFocus={autoFocus}
        data-autofocus={autoFocus ? true : undefined}
        value={value}
        disabled={disabled}
        invalid={invalid}
        onChange={(e) => {
          if (message) say(null);
          onChange(e.target.value.toUpperCase());
        }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        inputMode="text"
        autoComplete="off"
        aria-label={ariaLabel}
        className={inputClassName}
        data-testid={testId}
        data-tag-input
      />
      {showMessage && message && <CardMessageText message={message} className="mt-1.5" />}
    </div>
  );
}
