// 平板点餐页的返回 / 退出（8.1.15，docs/EMENU.md 第 18 节，PENDING_DECISIONS「8.1.15 追加」TC1–TC10）。
//
//   · ExitKey：左下角固定的一个带字的键——起始页写「退出」，菜单页写「返回」，工作台预览里写「退出预览」；
//   · LeaveSheet：点它打开的「退出界面」。客人的：继续点餐、结束点餐回起始页；员工的：返回工作台（自己的账号有主系统时）、退出登录。
//     员工的两个键要按住约 1.5 秒才生效（HoldButton，松手就取消），整个界面 15 秒没人碰自己收起；
//     后台开了「点单密码」时，按住以后另要一位点单的同事输点单密码（与下单同一套，接口 /api/emenu/staff-check）。
//
// 按住的进度是反馈、不是装饰：用定时器一帧一帧写宽度，后台「动效」关了、系统设了「减少动态效果」时照常走（样式表里那两种情况
// 把动画与过渡都关了）。从哪个键长出来、离开前整屏淡出这些才是动效，关了就不播。

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { EMENU_PIN_LENGTH } from '@shared/emenu';
import { api, ApiError } from '../../lib/api';
import { both, bothText, errorEn, messages, useLang, useM, type Messages } from './i18n';
import { Backdrop, BiText, Centered, InfoModal, ModalButton, ModalNote, Titles } from './modals';
import { Bleed, Hairline, box, useBig, useStage } from './stage';

/** 员工的键要按住多久（毫秒，TC4） */
export const LEAVE_HOLD_MS = 1500;
/** 退出界面多久没人碰自己收起（毫秒，TC4） */
export const LEAVE_IDLE_MS = 15_000;

/** 离开以后去哪 */
export type LeaveAction = 'home' | 'signout' | 'preview';

// ───────────────────────── 左下角的键 ─────────────────────────

/** 门与箭头：线条与顶栏的搜索、订单图标一样细 */
function DoorIcon({ color, size = 13 }: { color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke={color}
      strokeWidth={0.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ display: 'block', flex: 'none' }}
    >
      <path d="M8.2 1.6H2.9c-.5 0-.9.4-.9.9v9c0 .5.4.9.9.9h5.3" />
      <path d="M6 7h6.4" />
      <path d="M10.2 4.7 12.5 7l-2.3 2.3" />
    </svg>
  );
}

/**
 * 左下角的返回 / 退出键（TC1）：与翻页圆点同一条，离菜、加号都远。tone 是字与细边的颜色（起始页有氛围图时用浅色）。
 * 放大的一档（8.0.15）绕左下角放大。
 */
export function ExitKey({ kind, tone, onClick }: { kind: 'exit' | 'back' | 'preview'; tone: string; onClick: () => void }) {
  const m = useM();
  const en = useLang() === 'en';
  const large = useBig();
  const label = kind === 'back' ? m.leaveKeyBack : kind === 'preview' ? m.leaveKeyPreview : m.leaveKeyExit;
  const sub = kind === 'back' ? 'BACK' : kind === 'preview' ? 'PREVIEW' : 'EXIT';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="em-tap-soft em-leave-key"
      aria-label={label}
      style={{
        ...box(40, 728),
        height: 28,
        padding: '0 11px 0 9px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        border: 0,
        borderRadius: 14,
        background: 'none',
        color: tone,
        transform: large ? 'scale(1.25)' : undefined,
        transformOrigin: '0 100%',
        whiteSpace: 'nowrap',
      }}
      data-testid="emenu-leave-key"
      data-kind={kind}
    >
      <Hairline color={tone} radius={14} />
      <DoorIcon color={tone} />
      <span className={en ? 'em-en' : undefined} style={{ fontSize: en ? 11.5 : 12.5, lineHeight: '14px', letterSpacing: en ? '0.06em' : '0.12em' }}>
        {label}
      </span>
      {!en && (
        <span className="em-en" style={{ fontSize: 9, lineHeight: '14px', letterSpacing: '0.12em', opacity: 0.7 }}>
          {sub}
        </span>
      )}
    </button>
  );
}

// ───────────────────────── 按住才生效的键 ─────────────────────────

/**
 * 按住约 1.5 秒才生效（TC4）：按下开始走进度，松手、移开、失去焦点就取消并退回去；走满了调 onDone。
 * 点一下（没按住）调 onTap（界面上提示「请按住」）。键盘上按住空格 / 回车一样。
 */
export function HoldButton({
  x,
  y,
  w,
  label,
  sub,
  holding,
  disabled,
  onDone,
  onTap,
  onTouch,
  testId,
}: {
  x: number;
  y: number;
  w: number;
  label: string;
  /** 键下面的一行小字（「按住 1.5 秒」） */
  sub: string;
  /** 按住时键上换成的字 */
  holding: string;
  disabled?: boolean;
  onDone: () => void;
  onTap: () => void;
  /** 有人在碰（退出界面据此重新计「没人碰」的时间） */
  onTouch?: () => void;
  testId?: string;
}) {
  const [progress, setProgress] = useState(0);
  const run = useRef<{ start: number; frame: number } | null>(null);
  const live = useRef({ onDone, onTap });
  live.current = { onDone, onTap };

  const stop = useCallback((tap: boolean) => {
    const cur = run.current;
    if (!cur) return;
    window.cancelAnimationFrame(cur.frame);
    run.current = null;
    setProgress(0);
    if (tap && Date.now() - cur.start < 350) live.current.onTap();
  }, []);
  const start = useCallback(() => {
    if (disabled || run.current) return;
    onTouch?.();
    const began = Date.now();
    const tick = () => {
      const cur = run.current;
      if (!cur) return;
      const p = Math.min(1, (Date.now() - began) / LEAVE_HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        run.current = null;
        live.current.onDone();
        return;
      }
      cur.frame = window.requestAnimationFrame(tick);
    };
    run.current = { start: began, frame: window.requestAnimationFrame(tick) };
  }, [disabled, onTouch]);
  useEffect(() => () => stop(false), [stop]);

  const active = progress > 0;
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        start();
      }}
      onPointerUp={() => stop(true)}
      onPointerLeave={() => stop(false)}
      onPointerCancel={() => stop(false)}
      onBlur={() => stop(false)}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') stop(true);
      }}
      style={{
        ...box(x, y, w, 40),
        padding: 0,
        border: 0,
        borderRadius: 2,
        overflow: 'hidden',
        background: 'transparent',
        color: 'var(--em-ink)',
        opacity: disabled ? 0.5 : 1,
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
      data-testid={testId}
      data-holding={active ? '' : undefined}
    >
      <Hairline color="var(--em-tan)" radius={2} />
      {/* 进度：从左往右铺满 */}
      <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${progress * 100}%`, background: 'var(--em-tan)', opacity: 0.32 }} />
      <span style={{ position: 'absolute', left: 0, right: 0, top: 6, textAlign: 'center', fontSize: 15, lineHeight: '16px', whiteSpace: 'nowrap' }}>{active ? holding : label}</span>
      <span style={{ position: 'absolute', left: 0, right: 0, top: 24.5, textAlign: 'center', fontSize: 9, lineHeight: '10px', letterSpacing: '0.14em', color: 'var(--em-mute)' }}>
        {active ? `${Math.max(0.1, ((1 - progress) * LEAVE_HOLD_MS) / 1000).toFixed(1)}s` : sub}
      </span>
    </button>
  );
}

// ───────────────────────── 退出界面 ─────────────────────────

const SHEET_W = 440;

export interface LeaveSheetProps {
  /** 在哪一屏打开的：起始页没有「结束点餐」 */
  phase: 'start' | 'menu';
  /** 这一次点餐的手牌（菜单页） */
  tagCode: string | null;
  /** 还没下单的份数 */
  cartCount: number;
  /** 有一单结果待确认（记在平板上，重新进来还在） */
  pending: boolean;
  /** 现在登录的账号叫什么 */
  staffName: string;
  /** 这个账号有主系统可回（「点餐平板」设备账号没有，只能退出登录） */
  hasHome: boolean;
  /** 工作台预览（/emenu?studio=码）：只有「退出预览」，不用按住、不用密码 */
  preview: boolean;
  /** 后台开了「点单密码」：员工离开另要输点单密码（TC5） */
  requirePin: boolean;
  onClose: () => void;
  /** 结束这一次点餐、回起始页 */
  onEnd: () => void;
  /** 真的离开：调用方清掉记在平板上的这一次点餐，再跳转 */
  onLeave: (action: LeaveAction) => void;
}

/** 一段小字：切到英文时英文在上、中文在下（给员工看的，QZ6） */
const staffText = (pick: (t: Messages) => string, lang: 'zh' | 'en') => bothText(both(pick), lang);

export function LeaveSheet({ phase, tagCode, cartCount, pending, staffName, hasHome, preview, requirePin, onClose, onEnd, onLeave }: LeaveSheetProps) {
  const m = useM();
  const lang = useLang();
  const en = lang === 'en';
  const { animated } = useStage();
  const [hint, setHint] = useState<string | null>(null);
  // 按住走满以后：要点单密码的先输密码，不要的直接走
  const [asking, setAsking] = useState<LeaveAction | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [touched, setTouched] = useState(0);
  const touch = useCallback(() => setTouched((n) => n + 1), []);

  // 15 秒没人碰自己收起（输密码、正在离开时不收）
  useEffect(() => {
    if (asking || leaving) return;
    const t = window.setTimeout(onClose, LEAVE_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [touched, asking, leaving, onClose]);

  const go = useCallback(
    (action: LeaveAction) => {
      setLeaving(true);
      // 整屏淡出以后再走；动效关了就马上走
      window.setTimeout(() => onLeave(action), animated ? 260 : 0);
    },
    [animated, onLeave],
  );
  const held = (action: LeaveAction) => () => (requirePin ? setAsking(action) : go(action));
  const tapped = () => {
    touch();
    setHint(staffText((t) => t.leaveHoldHint, lang));
  };

  if (leaving) {
    return (
      <div style={box(0, 0, 1024, 768)} data-testid="emenu-leaving">
        <Bleed className="em-fade" style={{ background: 'var(--em-bg)' }} />
        <div className="em-fade" style={{ ...box(0, 366, 1024), textAlign: 'center', fontSize: 15, lineHeight: '20px', color: 'var(--em-mute)', letterSpacing: '0.12em' }}>
          {m.leaveGoing}
        </div>
      </div>
    );
  }
  if (asking) return <StaffCheck onCancel={() => setAsking(null)} onPassed={() => go(asking)} />;

  // 工作台预览：一步
  if (preview) {
    return (
      <Backdrop onClick={onClose} kind="leave">
        <Centered>
          <Panel h={214} title="退出预览" subtitle="LEAVE PREVIEW" onTouch={touch}>
            <Lines y={94}>{staffText((t) => t.leavePreviewBody, lang)}</Lines>
            <ModalButton x={28} y={158} w={186} onClick={onClose} testId="emenu-leave-stay">
              {m.leaveKeepPreview}
            </ModalButton>
            <ModalButton x={226} y={158} w={186} primary onClick={() => go('preview')} testId="emenu-leave-preview">
              {m.leaveKeyPreview}
            </ModalButton>
          </Panel>
        </Centered>
      </Backdrop>
    );
  }

  const inMenu = phase === 'menu';
  // 从上往下排：客人的一块（菜单页才有「结束点餐」）、员工的一块、底下一行「现在登录的是谁」
  const guestH = inMenu ? 118 : 62;
  const staffTop = 88 + guestH;
  const warn = cartCount > 0 || pending;
  const h = staffTop + 132 + (warn ? 22 : 0) + (en ? 14 : 0);
  return (
    <Backdrop onClick={onClose} kind="leave">
      <Centered>
        <Panel h={h} title={inMenu ? '要离开吗' : '退出电子菜单'} subtitle={inMenu ? 'LEAVING?' : 'EXIT THE MENU'} onTouch={touch}>
          {/* ── 客人的 ── */}
          <ModalButton x={28} y={96} w={SHEET_W - 56} primary onClick={onClose} testId="emenu-leave-stay">
            {inMenu ? m.keepOrdering : m.leaveStay}
          </ModalButton>
          {inMenu && (
            <>
              <ModalButton x={28} y={136} w={SHEET_W - 56} onClick={onEnd} testId="emenu-leave-end">
                {m.leaveEnd}
              </ModalButton>
              <Lines y={172} mute small>
                {tagCode ? m.leaveEndNote(tagCode, cartCount) : ''}
              </Lines>
            </>
          )}

          {/* ── 员工的 ── */}
          <div style={{ ...box(28, staffTop, SHEET_W - 56, 0), borderTop: '0.5px solid var(--em-mute)' }} />
          <div
            className="em-en"
            style={{ ...box(0, staffTop - 6, SHEET_W), textAlign: 'center', fontSize: 9.5, lineHeight: '12px', letterSpacing: '0.16em', color: 'var(--em-mute)', pointerEvents: 'none' }}
          >
            <span style={{ background: 'var(--em-modal)', padding: '0 10px' }}>
              {en ? 'STAFF ONLY' : <span style={{ fontFamily: 'var(--em-zh)', letterSpacing: '0.2em', fontSize: 10.5 }}>员工操作</span>}
            </span>
          </div>
          {hasHome ? (
            <>
              <HoldButton
                x={28}
                y={staffTop + 20}
                w={186}
                label={m.leaveHome}
                sub={m.leaveHoldSub}
                holding={m.leaveHolding}
                onDone={held('home')}
                onTap={tapped}
                onTouch={touch}
                testId="emenu-leave-home"
              />
              <HoldButton
                x={226}
                y={staffTop + 20}
                w={186}
                label={m.signOutFull}
                sub={m.leaveHoldSub}
                holding={m.leaveHolding}
                onDone={held('signout')}
                onTap={tapped}
                onTouch={touch}
                testId="emenu-leave-signout"
              />
            </>
          ) : (
            <HoldButton
              x={28}
              y={staffTop + 20}
              w={SHEET_W - 56}
              label={m.signOutFull}
              sub={m.leaveHoldSub}
              holding={m.leaveHolding}
              onDone={held('signout')}
              onTap={tapped}
              onTouch={touch}
              testId="emenu-leave-signout"
            />
          )}
          <Lines y={staffTop + 70} mute={!hint} error={!!hint} small testId="emenu-leave-hint">
            {hint ?? staffText((t) => (hasHome ? t.leaveStaffNote : t.leaveStaffNoteDevice), lang)}
          </Lines>
          {warn && (
            <Lines y={staffTop + 92 + (en ? 14 : 0)} small testId="emenu-leave-warn">
              {pending ? m.leaveWarnPending : m.leaveWarnCart(cartCount)}
            </Lines>
          )}
          <div
            style={{
              ...box(0, h - 24, SHEET_W),
              textAlign: 'center',
              fontSize: 10.5,
              lineHeight: '12px',
              color: 'var(--em-mute)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              padding: '0 28px',
            }}
            data-testid="emenu-leave-who"
          >
            {m.leaveWho(staffName)}
          </div>
          {/* 自己收起的倒计时：底边一条细线慢慢缩短（有人碰就重新来） */}
          <span
            key={touched}
            aria-hidden
            className="em-leave-idle"
            style={{ ...box(0, h - 2, SHEET_W, 2), background: 'var(--em-tan)', transformOrigin: '0 50%', animationDuration: `${LEAVE_IDLE_MS}ms` }}
          />
        </Panel>
      </Centered>
    </Backdrop>
  );
}

/** 退出界面的那块板：样式跟着设计稿的弹窗（上面一条浅黄、细线、两行标题），从左下角那个键的方向长出来（TC10） */
function Panel({ h, title, subtitle, onTouch, children }: { h: number; title: string; subtitle: string; onTouch: () => void; children: ReactNode }) {
  const en = useLang() === 'en';
  return (
    <div
      className="em-leave-in"
      data-em-out="pop"
      role="dialog"
      aria-label={en ? subtitle : title}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onTouch}
      style={{ ...box((1024 - SHEET_W) / 2, (768 - h) / 2, SHEET_W, h), background: 'var(--em-modal)', borderRadius: 10, overflow: 'hidden', pointerEvents: 'auto' }}
      data-testid="emenu-leave"
    >
      <div style={{ ...box(0, 0, SHEET_W, 72), background: 'var(--em-band)' }} />
      <div style={{ ...box(21.4, 71.7, SHEET_W - 42.8, 0), borderTop: '0.5px solid var(--em-mute)' }} />
      <Titles title={title} subtitle={subtitle} w={SHEET_W} y={[19, 44]} size={[22, 11]} />
      {children}
    </div>
  );
}

/** 板上居中的一段字 */
function Lines({ y, children, mute, small, error, testId }: { y: number; children: string; mute?: boolean; small?: boolean; error?: boolean; testId?: string }) {
  const style: CSSProperties = {
    ...box(28, y, SHEET_W - 56),
    textAlign: 'center',
    fontSize: small ? 11.5 : 13,
    lineHeight: small ? '15px' : '21px',
    color: error ? 'var(--em-error)' : mute ? 'var(--em-mute)' : 'var(--em-ink)',
  };
  return (
    <div style={style} role={error ? 'alert' : undefined} data-testid={testId}>
      <BiText text={children} />
    </div>
  );
}

/** 员工确认（TC5）：后台开了「点单密码」时，离开菜单另要一位点单的同事输点单密码 */
function StaffCheck({ onCancel, onPassed }: { onCancel: () => void; onPassed: () => void }) {
  const m = useM();
  const lang = useLang();
  const en = lang === 'en';
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (pin.length !== EMENU_PIN_LENGTH) return setError(staffText((t) => t.pinStep, lang));
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/emenu/staff-check', { pin });
      onPassed();
    } catch (e) {
      setPin('');
      const zh = e instanceof ApiError ? e.message : m.network;
      const enText = e instanceof ApiError ? errorEn(e.code) : null;
      setError(en && enText ? `${enText}\n${zh}` : zh);
      setBusy(false);
    }
  };
  return (
    <Backdrop kind="leave">
      <InfoModal
        title="员工确认"
        subtitle="STAFF CHECK"
        extra={en ? 22 : 0}
        fields={[{ key: 'pin', label: messages('zh').fieldPin, labelEn: messages('en').fieldPin, value: pin, kind: 'digits', maxLength: EMENU_PIN_LENGTH, mask: true, row: 3 }]}
        active="pin"
        onActive={() => {}}
        onChange={(_, value) => {
          setPin(value);
          setError(null);
        }}
        onEnter={() => void submit()}
        disabled={busy}
        testId="emenu-leave-check"
        footer={
          <>
            <ModalButton x={21.4} y={423.8} w={186} onClick={onCancel} disabled={busy} testId="emenu-leave-check-cancel">
              {m.cancel}
            </ModalButton>
            <ModalButton x={221.6} y={423.8} w={186} primary onClick={() => void submit()} disabled={busy} testId="emenu-leave-check-ok">
              {m.leaveConfirm}
            </ModalButton>
            <ModalNote h={34 + (en ? 22 : 0)} error={error} hint={error ? null : staffText((t) => t.leavePinHint, lang)} />
          </>
        }
      />
    </Backdrop>
  );
}
