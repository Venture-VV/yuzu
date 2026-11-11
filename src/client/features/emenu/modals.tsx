// 平板点餐页的弹窗：设计稿「输入信息」「确认信息」共用的那种（左边几项、右边数字键盘）、「下单成功」，
// 以及设计稿之外补的小确认框与提示条（docs/EMENU.md 第 3.11 节）。坐标都是设计稿 1024×768 上量的。

import { useEffect, useRef, type ReactNode } from 'react';
import { BackspaceIcon, CheckMark } from './icons';
import { box } from './stage';

/** 弹窗的位置与大小（设计稿） */
const M = { x: 297.5, y: 133.7, w: 429.1, h: 500.6 };
const LINE = '0.5px solid var(--em-mute)';

/** 盖在整页上的半透明层（设计稿里弹窗后面的页面压暗约四成）；blur：起始页输入信息时把氛围图虚化 */
export function Backdrop({ onClick, blur, children }: { onClick?: () => void; blur?: boolean; children?: ReactNode }) {
  return (
    <div
      className="em-fade"
      onClick={onClick}
      style={{ ...box(0, 0, 1024, 768), background: blur ? 'rgb(211 211 211 / 0.55)' : 'rgb(0 0 0 / 0.4)', backdropFilter: blur ? 'blur(14px)' : undefined, WebkitBackdropFilter: blur ? 'blur(14px)' : undefined }}
    >
      {children}
    </div>
  );
}

function Frame({ title, subtitle, children, testId }: { title: string; subtitle: string; children: ReactNode; testId?: string }) {
  return (
    <div
      className="em-pop"
      role="dialog"
      aria-label={title}
      onClick={(e) => e.stopPropagation()}
      style={{ ...box(M.x, M.y, M.w, M.h), background: 'var(--em-modal)', borderRadius: 10, overflow: 'hidden' }}
      data-testid={testId}
    >
      <div style={{ ...box(0, 0, M.w, 84.5), background: 'var(--em-band)' }} />
      <div style={{ ...box(21.4, 84.2, 386.2, 0), borderTop: LINE }} />
      <div style={{ ...box(0, 25.4, M.w), textAlign: 'center', fontSize: 24, lineHeight: '24px' }}>{title}</div>
      <div className="em-en" style={{ ...box(0, 50.4, M.w), textAlign: 'center', fontSize: 12, lineHeight: '12px', color: 'var(--em-mute)', letterSpacing: '0.2px' }}>
        {subtitle}
      </div>
      {children}
    </div>
  );
}

export type FieldKind = 'tag' | 'table' | 'digits';

export interface InfoField {
  key: string;
  label: string;
  value: string;
  kind: FieldKind;
  maxLength: number;
  /** 密码：显示成星号 */
  mask?: boolean;
  readOnly?: boolean;
  /** 画在第几行（0–3）；不给就按在数组里的先后 */
  row?: number;
}

/** 这一项能接受这个字符吗：手牌是字母 + 数字；桌号任意（外接键盘可以打字）；人数、密码只有数字 */
function accepts(kind: FieldKind, ch: string): boolean {
  if (/^[0-9]$/.test(ch)) return true;
  if (kind === 'tag') return /^[A-Za-z]$/.test(ch);
  if (kind === 'table') return ch.length === 1 && ch !== ' ';
  return false;
}

const KEY_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];
const KEY_X = [150.7, 216.6, 282.4];
const KEY_Y = [128.8, 194.5, 260.3];

/**
 * 左边几项、右边数字键盘的弹窗。点哪一项哪一项接收键盘；外接键盘、扫码枪打进来的字也认（扫码枪最后的回车 = 确定）。
 * footer 画在键盘下面（按钮、提示）；fields 最多 4 项。
 */
export function InfoModal({
  title,
  subtitle,
  fields,
  active,
  onActive,
  onChange,
  onEnter,
  footer,
  disabled,
  testId,
}: {
  title: string;
  subtitle: string;
  fields: InfoField[];
  active: string;
  onActive: (key: string) => void;
  onChange: (key: string, value: string) => void;
  onEnter?: () => void;
  footer: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const field = fields.find((f) => f.key === active && !f.readOnly) ?? null;
  const state = useRef({ field, fields, onChange, onActive, onEnter, disabled });
  state.current = { field, fields, onChange, onActive, onEnter, disabled };

  const type = (ch: string) => {
    const { field: f, onChange: change, disabled: off } = state.current;
    if (!f || off || f.value.length >= f.maxLength || !accepts(f.kind, ch)) return;
    change(f.key, f.value + (f.kind === 'tag' ? ch.toUpperCase() : ch));
  };
  const erase = () => {
    const { field: f, onChange: change, disabled: off } = state.current;
    if (f && !off && f.value) change(f.key, f.value.slice(0, -1));
  };
  const clear = () => {
    const { field: f, onChange: change, disabled: off } = state.current;
    if (f && !off) change(f.key, '');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = state.current;
      if (e.key === 'Backspace') {
        e.preventDefault();
        erase();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        s.onEnter?.();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const editable = s.fields.filter((f) => !f.readOnly);
        const i = editable.findIndex((f) => f.key === s.field?.key);
        const next = editable[(i + (e.shiftKey ? editable.length - 1 : 1)) % editable.length];
        if (next) s.onActive(next.key);
      } else if (e.key.length === 1) {
        type(e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const key = (label: ReactNode, x: number, y: number, w: number, h: number, onPress: () => void, opts: { alt?: boolean; aria: string; testId: string }) => (
    <button
      key={opts.testId}
      type="button"
      disabled={disabled}
      onClick={onPress}
      aria-label={opts.aria}
      style={{ ...box(x, y, w, h), background: opts.alt ? 'var(--em-key-2)' : 'var(--em-key)', border: LINE, borderRadius: 2, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      data-testid={opts.testId}
    >
      {label}
    </button>
  );
  const digit = (d: string) => (
    <span className="em-en" style={{ fontSize: 20, lineHeight: '20px' }}>
      {d}
    </span>
  );

  return (
    <Frame title={title} subtitle={subtitle} testId={testId}>
      {fields.map((f, i) => {
        const y = 151.6 + (f.row ?? i) * 65.8;
        const on = f.key === active && !f.readOnly;
        return (
          <button
            key={f.key}
            type="button"
            disabled={disabled || f.readOnly}
            onClick={() => onActive(f.key)}
            aria-label={`${f.label}${f.mask ? '' : ` ${f.value}`}`}
            aria-pressed={on}
            style={{ ...box(21.4, y - 8, 120, 34), padding: 0, border: 0, background: 'none', textAlign: 'left' }}
            data-testid={`emenu-field-${f.key}`}
            data-value={f.mask ? '*'.repeat(f.value.length) : f.value}
          >
            <span style={{ ...box(0, 8), fontSize: 16, lineHeight: '16px' }}>{f.label}</span>
            <span className="em-en" style={{ ...box(41, 7.4, 78), fontSize: 16, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', letterSpacing: f.mask ? '0.5px' : undefined }}>
              {f.mask ? '*'.repeat(f.value.length) : f.value}
              {on && !disabled && <span style={{ display: 'inline-block', width: 0.8, height: 15, background: 'var(--em-ink)', marginLeft: 1.5, verticalAlign: -2, opacity: 0.75 }} />}
            </span>
            <span style={{ ...box(36.8, 24.8, 79.3, 0), borderTop: on ? '0.8px solid var(--em-ink)' : LINE }} />
          </button>
        );
      })}

      {KEY_ROWS.map((row, r) => row.map((d, c) => key(digit(d), KEY_X[c]!, KEY_Y[r]!, 59.5, 59.5, () => type(d), { aria: d, testId: `emenu-key-${d}` })))}
      {key(digit('0'), 150.7, 326, 125.3, 59.5, () => type('0'), { aria: '0', testId: 'emenu-key-0' })}
      {key(digit('.'), 282.3, 326, 59.5, 59.5, () => type('.'), { aria: '点', testId: 'emenu-key-dot' })}
      {key(<BackspaceIcon />, 348.3, 128.9, 59.5, 125.3, erase, { alt: true, aria: '退格', testId: 'emenu-key-back' })}
      {key(
        <span style={{ fontSize: 18, lineHeight: '21.6px', width: 18, wordBreak: 'break-all' }}>清空</span>,
        348.1,
        260.3,
        59.5,
        125.3,
        clear,
        { alt: true, aria: '清空', testId: 'emenu-key-clear' },
      )}
      {footer}
    </Frame>
  );
}

/** 弹窗里的按钮（设计稿：高 28；主按钮卡其色底、浅色字，次按钮细边、灰字）。x、y 相对弹窗左上角 */
export function ModalButton({
  x,
  y,
  w,
  primary,
  disabled,
  onClick,
  children,
  testId,
}: {
  x: number;
  y: number;
  w: number;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...box(x, y, w, 28.3),
        padding: 0,
        borderRadius: 1.5,
        fontSize: 16,
        lineHeight: '16px',
        letterSpacing: '1px',
        background: primary ? 'var(--em-tan)' : 'transparent',
        border: primary ? 0 : LINE,
        color: primary ? 'var(--em-light)' : 'var(--em-mute)',
        opacity: disabled ? 0.5 : 1,
      }}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

/** 弹窗底部的一行提示（红字）与候选（手牌、桌号数字重了时点选）。y 相对弹窗左上角 */
export function ModalNote({ y = 458, error, hint, candidates, onPick }: { y?: number; error?: string | null; hint?: string | null; candidates?: string[]; onPick?: (value: string) => void }) {
  if (!error && !hint && !candidates?.length) return null;
  return (
    <div style={{ ...box(21.4, y, 386.2, 34), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
      {(error || hint) && (
        <span role={error ? 'alert' : undefined} style={{ fontSize: 12, lineHeight: '15px', color: error ? 'var(--em-error)' : 'var(--em-mute)', textAlign: 'center' }} data-testid={error ? 'emenu-error' : 'emenu-hint'}>
          {error ?? hint}
        </span>
      )}
      {candidates?.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick?.(c)}
          className="em-en"
          style={{ height: 22, padding: '0 10px', border: '0.5px solid var(--em-tan)', borderRadius: 1.5, background: 'transparent', fontSize: 13, color: 'var(--em-ink)' }}
          data-testid={`emenu-pick-${c}`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

/** 下单成功：弹窗出现 2 秒，对勾画出来（设计稿「下单成功」） */
export function SuccessModal({ onDone }: { onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const t = setTimeout(() => done.current(), 2000);
    return () => clearTimeout(t);
  }, []);
  return (
    <Backdrop onClick={onDone}>
      <Frame title="下单成功" subtitle="ORDER CONFIRMED" testId="emenu-success">
        <CheckMark style={{ ...box(114.5, 175.3) }} />
      </Frame>
    </Backdrop>
  );
}

/** 设计稿之外补的小确认框（结束点餐等）：样式跟着设计稿的弹窗 */
export function SmallDialog({
  title,
  subtitle,
  children,
  actions,
  onClose,
  testId,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  actions: ReactNode;
  onClose?: () => void;
  testId?: string;
}) {
  return (
    <Backdrop onClick={onClose}>
      <div
        className="em-pop"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ ...box(332, 259, 360, 250), background: 'var(--em-modal)', borderRadius: 10, overflow: 'hidden' }}
        data-testid={testId}
      >
        <div style={{ ...box(0, 0, 360, 72), background: 'var(--em-band)' }} />
        <div style={{ ...box(21.4, 71.7, 317.2, 0), borderTop: LINE }} />
        <div style={{ ...box(0, 19, 360), textAlign: 'center', fontSize: 22, lineHeight: '22px' }}>{title}</div>
        <div className="em-en" style={{ ...box(0, 44, 360), textAlign: 'center', fontSize: 11, lineHeight: '11px', color: 'var(--em-mute)' }}>
          {subtitle}
        </div>
        <div style={{ ...box(28, 96, 304, 88), fontSize: 13, lineHeight: '21px', color: 'var(--em-ink)', textAlign: 'center' }}>{children}</div>
        {actions}
      </div>
    </Backdrop>
  );
}

/** 页面底部的一条提示（加进未下单了、一单最多 30 行……），一会儿自己消失 */
export function Toast({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div style={{ ...box(0, 700, 1024), display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <span className="em-rise" role="status" style={{ background: 'rgb(75 57 42 / 0.9)', color: 'var(--em-light)', fontSize: 12, lineHeight: '12px', padding: '9px 16px', borderRadius: 2, letterSpacing: '0.5px' }} data-testid="emenu-toast">
        {text}
      </span>
    </div>
  );
}
