// 平板点餐页盖在菜单上的几层：菜品详情（设计稿「菜品详情」）、搜索（「搜索页面」）、
// 订单抽屉（「订单信息」未下单 / 已下单）与备注抽屉（「备注」忌口 / 起菜方式）。坐标都是设计稿 1024×768 上量的。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dishBlock, EMENU_BLOCK_LABELS, EMENU_MAX_CUSTOM_NOTE, type EmenuDishView, type EmenuGuest, type EmenuSpecView } from '@shared/emenu';
import { ArrowDot, CloseDot, MinusDot, PlusDot, SearchIcon } from './icons';
import { Backdrop } from './modals';
import { displaySpec, wrapParen, yuan } from './pages';
import { box, HEADER_H } from './stage';
import type { CartLine, Remark } from './store';

const MUTE = 'var(--em-mute)';
const LINE = '0.5px solid var(--em-mute)';

// ───────────────────────── 菜品详情 ─────────────────────────

export function DishDetail({
  dish,
  open,
  onClose,
  onPrev,
  onNext,
  onAdd,
}: {
  dish: EmenuDishView;
  /** 这道菜所在的分类现在在供应时段里 */
  open: boolean;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onAdd: (spec: EmenuSpecView) => void;
}) {
  const first = displaySpec(dish);
  const [picked, setPicked] = useState<number | null>(first?.itemId ?? null);
  // 换了一道菜（上一道 / 下一道）：规格回到这道菜的默认
  useEffect(() => setPicked(displaySpec(dish)?.itemId ?? null), [dish.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const spec = dish.specs.find((s) => s.itemId === picked) ?? first;
  const block = dishBlock(dish, open);
  const specBlocked = !!block || !spec || spec.state !== 'ok';
  const image = dish.imageUrl ?? dish.detailUrl;
  const round = (onClick: (() => void) | null, x: number, y: number, size: number, icon: ReactNode, label: string, testId: string) =>
    onClick && (
      <button type="button" onClick={onClick} aria-label={label} style={{ ...box(x, y - HEADER_H, size, size), padding: 0, border: 0, background: 'none', borderRadius: '50%' }} data-testid={testId}>
        <span style={{ position: 'absolute', inset: -10 }} />
        {icon}
      </button>
    );
  return (
    <div className="em-fade" style={{ ...box(0, HEADER_H, 1024, 768 - HEADER_H), background: 'var(--em-photo)', overflow: 'hidden' }} data-testid="emenu-detail">
      {image && <img src={image} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      {block && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgb(0 0 0 / 0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 150, color: '#f4f3f2' }}>
          <span style={{ fontSize: 22, lineHeight: '22px' }}>{EMENU_BLOCK_LABELS[block].zh}</span>
          <span className="em-en" style={{ fontSize: 11, marginTop: 4 }}>
            {EMENU_BLOCK_LABELS[block].en}
          </span>
        </div>
      )}
      {round(onClose, 958, 139, 21, <CloseDot />, '关闭', 'emenu-detail-close')}
      {round(onPrev, 40, 369, 30, <ArrowDot dir="left" />, '上一道', 'emenu-detail-prev')}
      {round(onNext, 954, 369, 30, <ArrowDot dir="right" />, '下一道', 'emenu-detail-next')}

      <div className="em-rise" style={{ ...box(40, 575 - HEADER_H, 944, 153), background: 'var(--em-bg)', borderRadius: 3 }}>
        <div style={{ ...box(23, 21, 760), fontSize: 18, lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} data-testid="emenu-detail-name">
          {dish.name}
          {dish.tagline && <span style={{ fontSize: 10, color: MUTE, marginLeft: 3 }}>{wrapParen(dish.tagline)}</span>}
        </div>
        {dish.nameEn && (
          <div className="em-en" style={{ ...box(23, 38.4, 760), fontSize: 9, lineHeight: '10px', color: MUTE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {dish.nameEn}
          </div>
        )}
        <div style={{ ...box(23, 64.6, 520), fontSize: 12, lineHeight: '14px', letterSpacing: '1.1px', color: MUTE, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
          {dish.description}
          {dish.attrs.length > 0 && <span>{dish.description ? '　' : ''}{dish.attrs.join('　')}</span>}
        </div>
        {spec && (
          <div className="em-en" style={{ position: 'absolute', right: 32, top: 26.5, display: 'flex', alignItems: 'baseline', whiteSpace: 'nowrap' }} data-testid="emenu-detail-price">
            <span style={{ fontSize: 12, marginRight: 2 }}>¥</span>
            <span style={{ fontSize: 24, lineHeight: '24px' }}>{yuan(spec.price)}</span>
            <span style={{ fontFamily: 'var(--em-zh)', fontSize: 12, marginLeft: 1 }}>/{dish.unit}</span>
          </div>
        )}
        {dish.specs.length > 1 && (
          <div style={{ ...box(23, 119), display: 'flex', gap: 11 }}>
            {dish.specs.map((s) => {
              const on = s.itemId === spec?.itemId;
              return (
                <button
                  key={s.itemId}
                  type="button"
                  onClick={() => setPicked(s.itemId)}
                  aria-pressed={on}
                  style={{
                    position: 'relative',
                    minWidth: 40,
                    height: 16,
                    padding: '0 8px',
                    borderRadius: 1.5,
                    fontSize: 12,
                    lineHeight: '15px',
                    background: on ? 'var(--em-tan)' : 'transparent',
                    border: on ? '0.5px solid var(--em-tan)' : LINE,
                    color: on ? '#fff' : MUTE,
                    textDecoration: s.state === 'ok' ? undefined : 'line-through',
                  }}
                  data-testid={`emenu-spec-${s.itemId}`}
                >
                  <span style={{ position: 'absolute', inset: '-12px -4px' }} />
                  {s.label}
                </button>
              );
            })}
            {spec && spec.state !== 'ok' && !block && <span style={{ fontSize: 11, lineHeight: '16px', color: MUTE }}>{spec.state === 'sold_out' ? '这个规格已售罄' : '这个规格已下架'}</span>}
          </div>
        )}
        <button
          type="button"
          disabled={specBlocked}
          onClick={() => spec && onAdd(spec)}
          aria-label={`把${dish.name}加进未下单`}
          style={{ ...box(850, 107, 71, 27), padding: 0, border: 0, borderRadius: 1.5, background: 'var(--em-tan)', opacity: specBlocked ? 0.35 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          data-testid="emenu-detail-add"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M0 7h14M7 0v14" stroke="#fff" strokeWidth="0.8" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── 搜索 ─────────────────────────

export interface SearchHit {
  dish: EmenuDishView;
  /** 在整条菜单里是第几页 */
  pageIndex: number;
}

export function SearchOverlay({ hits, onPick, onClose }: { hits: (q: string) => SearchHit[]; onPick: (hit: SearchHit) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const found = useMemo(() => (q.trim() ? hits(q.trim()).slice(0, 8) : []), [q, hits]);
  return (
    <Backdrop onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...box(166, 44.1, 689, 34.3), background: 'var(--em-bg)', borderRadius: 2 }} data-testid="emenu-search">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && found[0]) onPick(found[0]);
          }}
          placeholder="搜一搜想吃的菜"
          maxLength={32}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-label="搜一搜想吃的菜"
          style={{ ...box(40, 0, 609, 34.3), border: 0, outline: 'none', background: 'transparent', textAlign: 'center', fontSize: 16, padding: 0 }}
          data-testid="emenu-search-input"
        />
        <span style={{ ...box(654, 9) }}>
          <SearchIcon size={17} />
        </span>
      </div>
      {q.trim() && (
        <div onClick={(e) => e.stopPropagation()} className="em-rise" style={{ ...box(166, 84.7, 689), background: 'var(--em-bg)', borderRadius: 2 }} data-testid="emenu-search-results">
          {found.length === 0 ? (
            <div style={{ height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: MUTE }}>没有找到，换个字试试</div>
          ) : (
            found.map((h, i) => (
              <button
                key={h.dish.id}
                type="button"
                onClick={() => onPick(h)}
                style={{ display: 'flex', alignItems: 'baseline', width: '100%', height: 34, padding: '0 17px', border: 0, background: 'transparent', textAlign: 'left', borderTop: i === 0 ? 0 : LINE, backgroundClip: 'padding-box' }}
                data-testid={`emenu-search-hit-${h.dish.id}`}
              >
                <span style={{ fontSize: 16, lineHeight: '34px', whiteSpace: 'nowrap' }}>{h.dish.name}</span>
                <span className="em-en" style={{ fontSize: 10, color: MUTE, marginLeft: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {h.dish.nameEn}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </Backdrop>
  );
}

// ───────────────────────── 抽屉 ─────────────────────────

/** 右侧抽屉的壳（设计稿：从 598 起、宽 426，左边的页面压暗） */
function Drawer({ title, subtitle, tableName, onClose, children, testId }: { title: string; subtitle: string; tableName: string; onClose: () => void; children: ReactNode; testId: string }) {
  return (
    <Backdrop onClick={onClose}>
      <div className="em-drawer" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ ...box(598, 0, 426, 768), background: 'var(--em-bg)' }} data-testid={testId}>
        <div style={{ ...box(43, 47), fontSize: 22, lineHeight: '22px' }}>{title}</div>
        <div className="em-en" style={{ ...box(43, 69.4), fontSize: 11, lineHeight: '11px', color: MUTE, letterSpacing: '0.2px' }}>
          {subtitle}
        </div>
        {tableName && (
          <div style={{ position: 'absolute', right: 40, top: 45.6, fontSize: 14, lineHeight: '14px', color: MUTE, whiteSpace: 'nowrap' }}>
            桌号：<span className="em-en">{tableName}</span>
          </div>
        )}
        {children}
      </div>
    </Backdrop>
  );
}

function DrawerButton({ onClick, disabled, children, testId }: { onClick: () => void; disabled?: boolean; children: ReactNode; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ ...box(43, 700, 343, 28.3), padding: 0, border: 0, borderRadius: 1.5, background: 'var(--em-tan)', color: 'var(--em-bg)', fontSize: 16, lineHeight: '16px', letterSpacing: '1px', opacity: disabled ? 0.45 : 1 }}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function Pill({ x, y, on, onClick, children, testId, disabled }: { x: number; y: number; on: boolean; onClick: () => void; children: ReactNode; testId: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      style={{
        ...box(x, y, 102, 28),
        padding: 0,
        borderRadius: 1.5,
        fontSize: 14,
        lineHeight: '14px',
        letterSpacing: '0.6px',
        background: on ? 'var(--em-tan)' : 'transparent',
        border: on ? 0 : LINE,
        color: on ? 'var(--em-light)' : MUTE,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

export interface CartRow extends CartLine {
  name: string;
  nameEn: string;
  tagline: string;
  /** 规格名（大份）；只有一个规格的为空 */
  label: string;
  price: number;
  /** 现在不能点的原因（估清了、下架了、过了供应时段）；能点为 null */
  problem: string | null;
}

/**
 * 订单抽屉「菜品信息」：未下单（加减份数、备注、下单）与已下单（这张手牌点过的菜、整单合计）。
 * locked：有一单结果待确认没处理，这时不能改、不能再下单。
 */
export function OrderDrawer({
  tab,
  onTab,
  rows,
  total,
  guest,
  guestLoading,
  tableName,
  remarkText,
  locked,
  problem,
  onQuantity,
  onRemark,
  onSubmit,
  onClose,
}: {
  tab: 'cart' | 'ordered';
  onTab: (tab: 'cart' | 'ordered') => void;
  rows: CartRow[];
  total: number;
  guest: EmenuGuest | null;
  guestLoading: boolean;
  tableName: string;
  remarkText: string;
  locked: boolean;
  /** 现在不能下单的原因（没点菜、有菜估清了……） */
  problem: string | null;
  onQuantity: (itemId: number, quantity: number) => void;
  onRemark: () => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const step = (onClick: () => void, icon: ReactNode, x: number, label: string, testId: string, disabled?: boolean) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} style={{ ...box(x, -0.6, 12.6, 12.6), padding: 0, border: 0, background: 'none' }} data-testid={testId}>
      <span style={{ position: 'absolute', inset: -12 }} />
      {icon}
    </button>
  );
  return (
    <Drawer title="菜品信息" subtitle="DISH INFORMATION" tableName={tableName} onClose={onClose} testId="emenu-drawer">
      <Pill x={43} y={100} on={tab === 'cart'} onClick={() => onTab('cart')} testId="emenu-tab-cart">
        未下单
      </Pill>
      <Pill x={164} y={100} on={tab === 'ordered'} onClick={() => onTab('ordered')} testId="emenu-tab-ordered">
        已下单
      </Pill>
      <div style={{ ...box(43, 152, 343, 0), borderTop: LINE }} />

      {tab === 'cart' ? (
        <>
          <div className="emenu-scroll" style={{ ...box(43, 160, 343, 506) }} data-testid="emenu-cart">
            {rows.length === 0 ? (
              <div style={{ paddingTop: 90, textAlign: 'center', fontSize: 13, lineHeight: '22px', color: MUTE }}>
                还没有点菜
                <br />
                翻翻菜单，点菜旁边的加号
              </div>
            ) : (
              rows.map((r) => (
                <div key={r.itemId} style={{ position: 'relative', height: 45.3, opacity: r.problem ? 0.55 : 1 }} data-testid={`emenu-cart-${r.itemId}`}>
                  <div style={{ ...box(0, 16.2, 270), fontSize: 14, lineHeight: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.name}
                    {r.label && <span style={{ fontSize: 10, color: MUTE }}>（{r.label}）</span>}
                    {r.tagline && <span style={{ fontSize: 10, color: MUTE }}>{wrapParen(r.tagline)}</span>}
                  </div>
                  <div className="em-en" style={{ ...box(0, 31.2, 270), fontSize: 8, lineHeight: '9px', color: r.problem ? 'var(--em-error)' : MUTE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: r.problem ? 'var(--em-zh)' : undefined }}>
                    {r.problem ?? r.nameEn}
                  </div>
                  <div style={{ ...box(283, 15.8, 60, 13) }}>
                    {step(() => onQuantity(r.itemId, r.quantity - 1), <MinusDot />, 0, `${r.name}少一份`, `emenu-minus-${r.itemId}`, locked)}
                    <span className="em-en" style={{ ...box(12.6, 0.4, 34.8), textAlign: 'center', fontSize: 12, lineHeight: '12px' }} data-testid={`emenu-qty-${r.itemId}`}>
                      {r.quantity}
                    </span>
                    {step(() => onQuantity(r.itemId, r.quantity + 1), <PlusDot />, 47.4, `${r.name}多一份`, `emenu-plus-${r.itemId}`, locked || !!r.problem || r.quantity >= 99)}
                  </div>
                </div>
              ))
            )}
          </div>
          <button type="button" onClick={onRemark} disabled={locked} style={{ ...box(43, 674, 343, 26), padding: 0, border: 0, background: 'none', fontSize: 12, lineHeight: '12px', color: MUTE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} data-testid="emenu-remark-open">
            {remarkText ? `备注：${remarkText}` : '备注'}
          </button>
          <DrawerButton onClick={onSubmit} disabled={!!problem || locked} testId="emenu-submit">
            下单（请呼叫服务员）
          </DrawerButton>
          {rows.length > 0 && (
            <div style={{ ...box(43, 734, 343), textAlign: 'center', fontSize: 11, lineHeight: '14px', color: problem ? 'var(--em-error)' : MUTE }} data-testid="emenu-cart-note">
              {problem ?? (
                <>
                  这一单 <span className="em-en">¥{yuan(total)}</span>，记在手牌上，离店时一起结
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="emenu-scroll" style={{ ...box(43, 160, 343, 470) }} data-testid="emenu-ordered">
            {!guest ? (
              <div style={{ paddingTop: 90, textAlign: 'center', fontSize: 13, color: MUTE }}>{guestLoading ? '正在取…' : '暂时取不到已下单的菜'}</div>
            ) : guest.ordered.length === 0 ? (
              <div style={{ paddingTop: 90, textAlign: 'center', fontSize: 13, color: MUTE }}>这张手牌还没有下过单</div>
            ) : (
              guest.ordered.map((l) => (
                <div key={l.lineId} style={{ position: 'relative', height: 46 }} data-testid={`emenu-ordered-${l.lineId}`}>
                  <div style={{ ...box(0, 16.2, 270), fontSize: 14, lineHeight: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.name}
                    {l.quantity > 1 && <span className="em-en" style={{ fontSize: 11, color: MUTE, marginLeft: 4 }}>× {l.quantity}</span>}
                  </div>
                  <div className="em-en" style={{ ...box(0, 31.2, 270), fontSize: 8, lineHeight: '9px', color: MUTE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.nameEn}
                  </div>
                  <div className="em-en" style={{ position: 'absolute', right: 0, top: 14.6, display: 'flex', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 8, marginRight: 1.4 }}>¥</span>
                    <span style={{ fontSize: 16, lineHeight: '16px' }}>{yuan(l.amount)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
          {guest && (
            <div style={{ position: 'absolute', right: 40, top: 650, display: 'flex', alignItems: 'baseline', whiteSpace: 'nowrap' }} data-testid="emenu-ordered-total">
              <span style={{ fontSize: 14 }}>整单合计：</span>
              <span className="em-en" style={{ fontSize: 16, marginRight: 2 }}>¥</span>
              <span className="em-en" style={{ fontSize: 34, lineHeight: '34px' }}>{yuan(guest.orderedTotal)}</span>
            </div>
          )}
          <DrawerButton onClick={onClose} testId="emenu-drawer-close">
            关闭
          </DrawerButton>
        </>
      )}
    </Drawer>
  );
}

/** 备注抽屉：忌口（多选）、起菜方式（单选，可以不选）、自定义备注（设计稿默认都不选） */
export function RemarkDrawer({
  remark,
  avoidOptions,
  serveOptions,
  tableName,
  onChange,
  onDone,
}: {
  remark: Remark;
  avoidOptions: string[];
  serveOptions: string[];
  tableName: string;
  onChange: (next: Remark) => void;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<'avoid' | 'serve'>('avoid');
  const [custom, setCustom] = useState(!!remark.custom);
  const input = useRef<HTMLInputElement>(null);
  const tabButton = (key: 'avoid' | 'serve', label: string, x: number, w: number) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      aria-pressed={tab === key}
      style={{ ...box(x - 18, 106, w + 36, 44), padding: 0, border: 0, background: 'none', fontSize: 18, lineHeight: '18px', letterSpacing: '1.5px', color: tab === key ? 'var(--em-ink)' : MUTE }}
      data-testid={`emenu-remark-tab-${key}`}
    >
      {label}
      {tab === key && <span style={{ ...box(0, 38.6, w + 36, 0), borderTop: '1px solid var(--em-tan)' }} />}
    </button>
  );
  const options = tab === 'avoid' ? avoidOptions : serveOptions;
  return (
    <Drawer title="备注" subtitle="REMARKS" tableName={tableName} onClose={onDone} testId="emenu-remark">
      <div style={{ ...box(43, 101, 343, 0), borderTop: LINE }} />
      {tabButton('avoid', '忌口', 76, 36)}
      {tabButton('serve', '起菜方式', 178, 72)}
      {options.map((o, i) => {
        const on = tab === 'avoid' ? remark.avoid.includes(o) : remark.serve === o;
        const toggle = () =>
          onChange(
            tab === 'avoid'
              ? { ...remark, avoid: on ? remark.avoid.filter((a) => a !== o) : avoidOptions.filter((a) => a === o || remark.avoid.includes(a)) }
              : { ...remark, serve: on ? null : o },
          );
        return (
          <Pill key={o} x={43 + (i % 3) * 120.5} y={167 + Math.floor(i / 3) * 44} on={on} onClick={toggle} testId={`emenu-remark-${o}`}>
            {o}
          </Pill>
        );
      })}
      {options.length === 0 && <div style={{ ...box(43, 176, 343), textAlign: 'center', fontSize: 13, color: MUTE }}>没有可选的项</div>}
      {custom && (
        <div style={{ ...box(43, 628, 343, 30) }}>
          <input
            ref={input}
            value={remark.custom}
            onChange={(e) => onChange({ ...remark, custom: e.target.value.slice(0, EMENU_MAX_CUSTOM_NOTE) })}
            maxLength={EMENU_MAX_CUSTOM_NOTE}
            placeholder={`别的要求写在这里（最多 ${EMENU_MAX_CUSTOM_NOTE} 个字）`}
            aria-label="自定义备注"
            autoComplete="off"
            enterKeyHint="done"
            onKeyDown={(e) => e.key === 'Enter' && input.current?.blur()}
            style={{ width: '100%', height: 28, border: 0, borderBottom: LINE, outline: 'none', background: 'transparent', fontSize: 14, padding: 0, textAlign: 'center' }}
            data-testid="emenu-remark-custom"
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          setCustom(true);
          setTimeout(() => input.current?.focus(), 0);
        }}
        style={{ ...box(43, 674, 343, 26), padding: 0, border: 0, background: 'none', fontSize: 12, lineHeight: '12px', color: MUTE }}
        data-testid="emenu-remark-custom-open"
      >
        自定义备注
      </button>
      <DrawerButton onClick={onDone} testId="emenu-remark-done">
        备注完成
      </DrawerButton>
    </Drawer>
  );
}
