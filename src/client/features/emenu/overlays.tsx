// 平板点餐页盖在菜单上的几层：菜品详情（设计稿「菜品详情」）、搜索（「搜索页面」）、
// 订单抽屉（「订单信息」未下单 / 已下单）与备注抽屉（「备注」忌口 / 起菜方式）。坐标都是设计稿 1024×768 上量的。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dishBlock, EMENU_MAX_CUSTOM_NOTE, type EmenuDishView, type EmenuGuest, type EmenuSpecView } from '@shared/emenu';
import { blockLabel, dishAttrs, dishDescription, dishNames, dishTagline, dishUnit, namePair, optionLabel, specLabel, useLang, useM, type NamePair } from './i18n';
import { ArrowDot, CloseDot, MinusDot, PlusDot, SearchIcon } from './icons';
import { Backdrop } from './modals';
import { FadeImg, ScrollArea, useExitGhost } from './motion';
import { displaySpec, wrapParen, yuan } from './pages';
import { box, Hairline, HEADER_H, useStage } from './stage';
import type { CartLine, Remark } from './store';

const MUTE = 'var(--em-mute)';
const LINE = '0.5px solid var(--em-mute)';

// ───────────────────────── 菜品详情 ─────────────────────────

export function DishDetail({
  dish,
  open,
  origin,
  onClose,
  onPrev,
  onNext,
  onAdd,
}: {
  dish: EmenuDishView;
  /** 这道菜所在的分类现在在供应时段里 */
  open: boolean;
  /** 从菜单上哪个位置点开的（设计稿坐标）：详情从那里放大出来、关掉时缩回去；没有就从正中 */
  origin?: { x: number; y: number } | null;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onAdd: (spec: EmenuSpecView, from: Element) => void;
}) {
  const lang = useLang();
  const m = useM();
  const root = useExitGhost<HTMLDivElement>('detail');
  const first = displaySpec(dish);
  const [picked, setPicked] = useState<number | null>(first?.itemId ?? null);
  // 换了一道菜（上一道 / 下一道）：规格回到这道菜的默认
  useEffect(() => setPicked(displaySpec(dish)?.itemId ?? null), [dish.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const spec = dish.specs.find((s) => s.itemId === picked) ?? first;
  const block = dishBlock(dish, open);
  const why = block ? blockLabel(block, lang) : null;
  const specBlocked = !!block || !spec || spec.state !== 'ok';
  const image = dish.imageUrl ?? dish.detailUrl;
  const name = dishNames(dish, lang);
  const tag = dishTagline(dish, lang);
  const intro = dishDescription(dish, lang);
  const attrs = dishAttrs(dish, lang);
  const unit = dishUnit(dish, lang);
  const round = (onClick: (() => void) | null, x: number, y: number, size: number, icon: ReactNode, label: string, testId: string) =>
    onClick && (
      <button type="button" onClick={onClick} aria-label={label} className="em-tap" style={{ ...box(x, y - HEADER_H, size, size), padding: 0, border: 0, background: 'none', borderRadius: '50%' }} data-testid={testId}>
        <span style={{ position: 'absolute', inset: -10 }} />
        {icon}
      </button>
    );
  return (
    <div
      ref={root}
      className="em-zoom-in"
      data-em-out="zoom"
      style={{ ...box(0, HEADER_H, 1024, 768 - HEADER_H), background: 'var(--em-photo)', overflow: 'hidden', transformOrigin: origin ? `${origin.x}px ${origin.y - HEADER_H}px` : '50% 50%' }}
      data-testid="emenu-detail"
    >
      {/* 上一道 / 下一道：新的图淡入 */}
      {image && <FadeImg key={image} src={image} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      {why && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgb(0 0 0 / 0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 150, color: '#f4f3f2' }}>
          <span className={why.mainEn ? 'em-en' : undefined} style={{ fontSize: why.mainEn ? 20 : 22, lineHeight: '22px' }}>
            {why.main}
          </span>
          <span className={why.mainEn ? undefined : 'em-en'} style={{ fontSize: 11, marginTop: 4 }}>
            {why.sub}
          </span>
        </div>
      )}
      {round(onClose, 954, 134.4, 30, <CloseDot />, m.close, 'emenu-detail-close')}
      {round(onPrev, 40, 369, 30, <ArrowDot dir="left" />, m.prevDish, 'emenu-detail-prev')}
      {round(onNext, 954, 369, 30, <ArrowDot dir="right" />, m.nextDish, 'emenu-detail-next')}

      <div className="em-rise" style={{ ...box(40, 575 - HEADER_H, 944, 153), background: 'var(--em-bg)', borderRadius: 3 }}>
        <div key={dish.id} className="em-swap" style={{ position: 'absolute', inset: 0 }}>
          {name.mainEn ? (
            <>
              <div className="em-en em-clip" style={{ ...box(23.3, 21.6, 760), fontSize: 17, lineHeight: '17px' }} data-testid="emenu-detail-name">
                {name.main}
                {tag.text && (
                  <span className={tag.en ? undefined : undefined} style={{ fontSize: 10, lineHeight: 0, color: MUTE, marginLeft: 4, fontFamily: tag.en ? undefined : 'var(--em-zh)' }}>
                    {wrapParen(tag.text)}
                  </span>
                )}
              </div>
              <div className="em-clip" style={{ ...box(23.3, 41.6, 760), fontSize: 10.5, lineHeight: '10.5px', color: MUTE }}>
                {name.sub}
              </div>
            </>
          ) : (
            <>
              <div className="em-clip" style={{ ...box(23.3, 20.7, 760), fontSize: 18, lineHeight: '18px' }} data-testid="emenu-detail-name">
                {name.main}
                {tag.text && <span style={{ fontSize: 10, lineHeight: 0, color: MUTE, marginLeft: 2.6 }}>{wrapParen(tag.text)}</span>}
              </div>
              {name.sub && (
                <div className="em-en em-clip" style={{ ...box(23.3, 38.1, 760), fontSize: 9, lineHeight: '9px', color: MUTE }}>
                  {name.sub}
                </div>
              )}
            </>
          )}
          {/* 设计稿：12 号、行距 14，一行 39 个字正好到 567.6（字距 0.955） */}
          <div
            className={intro.en ? 'em-en' : undefined}
            style={{ ...box(23.3, 65.1, intro.en ? 560 : 510), fontSize: intro.en ? 11.5 : 12, lineHeight: '14px', letterSpacing: intro.en ? '0.2px' : '0.955px', color: MUTE, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
            data-testid="emenu-detail-desc"
          >
            {intro.text}
            {attrs.list.length > 0 && (
              <span className={attrs.en ? 'em-en' : undefined} style={{ fontFamily: attrs.en ? undefined : 'var(--em-zh)' }}>
                {intro.text ? '　' : ''}
                {attrs.list.join(attrs.en ? ' · ' : '　')}
              </span>
            )}
          </div>
          {spec && (
            <div className="em-en" style={{ position: 'absolute', right: 32.5, top: 27.1, display: 'flex', alignItems: 'baseline', whiteSpace: 'nowrap' }} data-testid="emenu-detail-price">
              <span style={{ fontSize: 12, width: 7.3, marginRight: 1.6 }}>¥</span>
              <span style={{ fontSize: 24, lineHeight: '24px' }}>{yuan(spec.price)}</span>
              {unit.en ? <span style={{ fontSize: 11 }}>/{unit.text}</span> : <span style={{ fontFamily: 'var(--em-zh)', fontSize: 12, letterSpacing: 0 }}>/{unit.text}</span>}
            </div>
          )}
          {dish.specs.length > 1 && (
            <div style={{ ...box(23.3, 118.9), display: 'flex', gap: 11 }}>
              {dish.specs.map((s) => {
                const on = s.itemId === spec?.itemId;
                const label = specLabel(s, lang);
                return (
                  <button
                    key={s.itemId}
                    type="button"
                    onClick={() => setPicked(s.itemId)}
                    aria-pressed={on}
                    className="em-tap-soft"
                    style={{
                      position: 'relative',
                      minWidth: 40.1,
                      height: 15.5,
                      // 字的文字框在上沿往下 3.2（设计稿）
                      padding: '3.2px 8.1px 0',
                      borderRadius: 1.5,
                      fontSize: 12,
                      lineHeight: '12px',
                      background: on ? 'var(--em-tan)' : 'transparent',
                      border: 0,
                      color: on ? '#fff' : MUTE,
                      textDecoration: s.state === 'ok' ? undefined : 'line-through',
                      display: 'block',
                      whiteSpace: 'nowrap',
                      transition: 'background-color var(--em-micro) ease, color var(--em-micro) ease',
                    }}
                    data-testid={`emenu-spec-${s.itemId}`}
                  >
                    <span style={{ position: 'absolute', inset: '-12px -4px' }} />
                    {!on && <Hairline />}
                    <span className={label !== s.label ? 'em-en' : undefined} style={{ display: 'block', height: 12.3, fontSize: label !== s.label ? 11 : undefined }}>
                      {label}
                    </span>
                  </button>
                );
              })}
              {spec && spec.state !== 'ok' && !block && <span style={{ fontSize: 11, lineHeight: '16px', color: MUTE }}>{spec.state === 'sold_out' ? m.specSoldOut : m.specOff}</span>}
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={specBlocked}
          onClick={(e) => spec && onAdd(spec, e.currentTarget)}
          aria-label={m.addAria(name.main)}
          className="em-tap-soft"
          style={{ ...box(850.5, 107.1, 70.9, 27.3), padding: 0, border: 0, borderRadius: 1.5, background: 'var(--em-tan)', opacity: specBlocked ? 0.35 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          data-testid="emenu-detail-add"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M0 7h14M7 0v14" stroke="#fff" strokeWidth="1" />
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

/** 一行结果的高度（设计稿） */
const HIT_H = 34.2;

export function SearchOverlay({ hits, onPick, onClose }: { hits: (q: string) => SearchHit[]; onPick: (hit: SearchHit) => void; onClose: () => void }) {
  const lang = useLang();
  const m = useM();
  // 键盘弹起时（8.0.13）：页面不缩放，结果列表的高度按键盘上面剩下的空间收，放不下的在列表里滑
  const { visible } = useStage();
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const found = useMemo(() => (q.trim() ? hits(q.trim()).slice(0, 12) : []), [q, hits]);
  const room = Math.max(HIT_H * 2, Math.min(HIT_H * 8, visible - 84.6 - 10));
  return (
    <Backdrop onClick={onClose} kind="search">
      <div onClick={(e) => e.stopPropagation()} className="em-rise" style={{ ...box(166.4, 44.3, 689, 34.2), background: 'var(--em-bg)', borderRadius: 2 }} data-testid="emenu-search">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && found[0]) onPick(found[0]);
          }}
          placeholder={m.searchPlaceholder}
          maxLength={32}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-label={m.searchPlaceholder}
          className={lang === 'en' ? 'em-en' : undefined}
          // 设计稿里提示字的文字框在框上沿往下 11.5（正中是 9.1）：输入框里的字浏览器自己上下居中，用上内边距往下推
          style={{ ...box(40, 0, 605, 34.2), border: 0, outline: 'none', background: 'transparent', textAlign: 'center', fontSize: lang === 'en' ? 14 : 16, lineHeight: '16px', padding: '4.8px 0 0' }}
          data-testid="emenu-search-input"
        />
        <span style={{ ...box(654.3, 8.9) }}>
          <SearchIcon size={16.9} />
        </span>
      </div>
      {q.trim() && (
        <div onClick={(e) => e.stopPropagation()} className="em-rise" style={{ ...box(166.4, 84.6, 689), background: 'var(--em-bg)', borderRadius: 2, overflow: 'hidden' }} data-testid="emenu-search-results">
          {found.length === 0 ? (
            <div style={{ height: HIT_H, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: MUTE }}>{m.searchEmpty}</div>
          ) : (
            <ScrollArea style={{ maxHeight: room }} testId="emenu-search-list">
              {found.map((h, i) => {
                const name = dishNames(h.dish, lang);
                return (
                  <button
                    key={h.dish.id}
                    type="button"
                    onClick={() => onPick(h)}
                    className="em-press"
                    style={{ position: 'relative', display: 'block', width: '100%', height: HIT_H, padding: 0, border: 0, background: 'transparent', textAlign: 'left' }}
                    data-testid={`emenu-search-hit-${h.dish.id}`}
                  >
                    {/* 设计稿：每行 34.2，菜名的文字框在行上沿往下 11.2、左边往右 16.2，英文名跟在后面同一条基线；行与行之间的线左右各缩进 17 */}
                    {i > 0 && <span style={{ ...box(17.9, 0, 654.7, 0), borderTop: LINE }} />}
                    {name.mainEn ? (
                      <span className="em-en em-clip" style={{ ...box(16.2, 12.2, 656), fontSize: 14, lineHeight: '14px' }}>
                        {name.main}
                        <span style={{ fontFamily: 'var(--em-zh)', fontSize: 11, lineHeight: 0, color: MUTE, marginLeft: 6 }}>{name.sub}</span>
                      </span>
                    ) : (
                      <span className="em-clip" style={{ ...box(16.2, 11.2, 656), fontSize: 16, lineHeight: '16px' }}>
                        {name.main}
                        <span className="em-en" style={{ fontSize: 10, lineHeight: 0, color: MUTE, marginLeft: 3.2 }}>
                          {name.sub}
                        </span>
                      </span>
                    )}
                  </button>
                );
              })}
            </ScrollArea>
          )}
        </div>
      )}
    </Backdrop>
  );
}

// ───────────────────────── 抽屉 ─────────────────────────

/** 右侧抽屉的壳（设计稿：从 598.3 起到右边，里面的内容从 640.7 到 984，左边的页面压暗）。DX 是内容左边离抽屉左边多远 */
const DX = 42.4;
function Drawer({
  kind,
  swap,
  title,
  subtitle,
  tableName,
  onClose,
  children,
  testId,
}: {
  kind: 'drawer' | 'remark';
  /** 抽屉里换内容（未下单 ⇄ 备注）：抽屉不重新滑进来、背景不重新淡入，内容淡入 */
  swap?: boolean;
  title: string;
  subtitle: string;
  tableName: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}) {
  const m = useM();
  const t = namePair(title, subtitle, useLang());
  return (
    <Backdrop onClick={onClose} kind={kind} still={swap}>
      <div className={swap ? undefined : 'em-drawer'} data-em-out="drawer" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ ...box(598.3, 0, 425.7, 768), background: 'var(--em-bg)' }} data-testid={testId}>
        <div className={swap ? 'em-swap' : undefined} style={{ position: 'absolute', inset: 0 }}>
          {t.mainEn ? (
            <>
              <div className="em-en" style={{ ...box(DX, 49.5), fontSize: 17, lineHeight: '17px', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
                {t.main}
              </div>
              <div style={{ ...box(DX, 69.5), fontSize: 12, lineHeight: '12px', color: MUTE }}>{t.sub}</div>
            </>
          ) : (
            <>
              <div style={{ ...box(DX, 46.9), fontSize: 22, lineHeight: '22px' }}>{t.main}</div>
              <div className="em-en" style={{ ...box(DX, 68.7), fontSize: 11, lineHeight: '11px', color: MUTE, letterSpacing: '0.05em' }}>
                {t.sub}
              </div>
            </>
          )}
          {tableName && (
            <div className={t.mainEn ? 'em-en' : undefined} style={{ position: 'absolute', right: 40, top: t.mainEn ? 47.5 : 45.7, fontSize: t.mainEn ? 13 : 14, lineHeight: '14px', color: MUTE, whiteSpace: 'nowrap' }}>
              {m.tableLabel}
              <span className="em-en">{tableName}</span>
            </div>
          )}
          {children}
        </div>
      </div>
    </Backdrop>
  );
}

function DrawerButton({ onClick, disabled, children, testId, shift = 0 }: { onClick: () => void; disabled?: boolean; children: ReactNode; testId: string; shift?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="em-tap-soft"
      style={{ ...box(DX, 700.2, 343.3, 28.3), padding: 0, border: 0, borderRadius: 1.5, background: 'var(--em-tan)', color: 'var(--em-bg)', fontSize: 16, lineHeight: '16px', opacity: disabled ? 0.45 : 1 }}
      data-testid={testId}
    >
      {/* 字的文字框在按钮上沿往下 8.1（设计稿；浏览器自己居中的话是 6.15） */}
      <span style={{ position: 'absolute', left: shift * 2, right: 0, top: 8.1, textAlign: 'center', whiteSpace: 'nowrap' }}>{children}</span>
    </button>
  );
}

function Pill({ x, y, on, onClick, children, testId, disabled, en }: { x: number; y: number; on: boolean; onClick: () => void; children: ReactNode; testId: string; disabled?: boolean; /** 里面是英文（用英文字体、小一号） */ en?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={`em-tap-soft${en ? ' em-en' : ''}`}
      style={{
        ...box(x, y, 102, 28.3),
        padding: 0,
        borderRadius: 1.5,
        fontSize: en ? 12 : 14,
        lineHeight: '14px',
        background: on ? 'var(--em-tan)' : 'transparent',
        border: 0,
        color: on ? 'var(--em-light)' : MUTE,
        overflow: 'hidden',
        transition: 'background-color var(--em-micro) ease, color var(--em-micro) ease',
      }}
      data-testid={testId}
    >
      {!on && <Hairline />}
      {/* 字的文字框在上沿往下 8.85（设计稿） */}
      <span style={{ position: 'absolute', left: 0, right: 0, top: 8.85, textAlign: 'center', whiteSpace: 'nowrap' }}>{children}</span>
    </button>
  );
}

export interface CartRow extends CartLine {
  /** 菜名两行（按现在的语言排好主次） */
  names: NamePair;
  /** 名称后的小字 */
  tagline: { text: string; en: boolean };
  /** 规格名（大份 / Large）；只有一个规格的为空 */
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
  swap,
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
  swap?: boolean;
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
  const lang = useLang();
  const en = lang === 'en';
  const m = useM();
  const step = (onClick: () => void, icon: ReactNode, x: number, label: string, testId: string, disabled?: boolean) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} className="em-tap" style={{ ...box(x, 14.6, 12.6, 12.6), padding: 0, border: 0, background: 'none' }} data-testid={testId}>
      <span style={{ position: 'absolute', inset: -12 }} />
      {icon}
    </button>
  );
  return (
    <Drawer kind="drawer" swap={swap} title="菜品信息" subtitle="DISH INFORMATION" tableName={tableName} onClose={onClose} testId="emenu-drawer">
      <Pill x={DX} y={100.5} on={tab === 'cart'} onClick={() => onTab('cart')} testId="emenu-tab-cart" en={en}>
        {m.tabCart}
      </Pill>
      <Pill x={DX + 120.7} y={100.5} on={tab === 'ordered'} onClick={() => onTab('ordered')} testId="emenu-tab-ordered" en={en}>
        {m.tabOrdered}
      </Pill>
      <div style={{ ...box(DX, 152.2, 343.3, 0), borderTop: LINE }} />

      {tab === 'cart' ? (
        <>
          <ScrollArea style={{ ...box(DX, 160, 343.3, 506) }} testId="emenu-cart">
            {rows.length === 0 ? (
              <div className={en ? 'em-en' : undefined} style={{ paddingTop: 90, textAlign: 'center', fontSize: 13, lineHeight: '22px', color: MUTE }}>
                {m.cartEmpty}
                <br />
                {m.cartEmptyHint}
              </div>
            ) : (
              rows.map((r) => (
                <div key={r.itemId} className="em-rise" style={{ position: 'relative', height: 45.4, opacity: r.problem ? 0.55 : 1 }} data-testid={`emenu-cart-${r.itemId}`}>
                  <div className={`em-clip${r.names.mainEn ? ' em-en' : ''}`} style={{ ...box(0.5, r.names.mainEn ? 16.9 : 15.9, 270), fontSize: r.names.mainEn ? 13 : 14, lineHeight: '14px' }}>
                    {r.names.main}
                    {r.label && <span style={{ fontSize: 10, lineHeight: 0, color: MUTE }}>{r.names.mainEn ? ` (${r.label})` : `（${r.label}）`}</span>}
                    {r.tagline.text && <span style={{ fontSize: 10, lineHeight: 0, color: MUTE, fontFamily: r.tagline.en ? undefined : 'var(--em-zh)' }}>{wrapParen(r.tagline.text)}</span>}
                  </div>
                  {r.problem ? (
                    <div className={`em-clip${en ? ' em-en' : ''}`} style={{ ...box(0.5, 30.6, 270), fontSize: 8, lineHeight: '8px', color: 'var(--em-error)' }}>
                      {r.problem}
                    </div>
                  ) : r.names.mainEn ? (
                    <div className="em-clip" style={{ ...box(0.5, 31.2, 270), fontSize: 9, lineHeight: '9px', color: MUTE }}>
                      {r.names.sub}
                    </div>
                  ) : (
                    <div className="em-en em-clip" style={{ ...box(0.5, 30.6, 270), fontSize: 8, lineHeight: '8px', color: MUTE }}>
                      {r.names.sub}
                    </div>
                  )}
                  {/* 减号 283.6、加号 330.7（离内容左边），份数在两个圆点中间；圆点比菜名高 1.3 */}
                  {step(() => onQuantity(r.itemId, r.quantity - 1), <MinusDot />, 283.6, m.less(r.names.main), `emenu-minus-${r.itemId}`, locked)}
                  <span key={r.quantity} className="em-en em-bump" style={{ ...box(296.2, 16.2, 34.5), textAlign: 'center', fontSize: 12, lineHeight: '12px', letterSpacing: 0 }} data-testid={`emenu-qty-${r.itemId}`}>
                    {r.quantity}
                  </span>
                  {step(() => onQuantity(r.itemId, r.quantity + 1), <PlusDot />, 330.7, m.more(r.names.main), `emenu-plus-${r.itemId}`, locked || !!r.problem || r.quantity >= 99)}
                </div>
              ))
            )}
          </ScrollArea>
          <button type="button" onClick={onRemark} disabled={locked} className="em-press" style={{ ...box(DX, 674, 343.3, 26), padding: 0, border: 0, background: 'none', fontSize: 12, lineHeight: '12px', color: MUTE }} data-testid="emenu-remark-open">
            <span className={`em-clip${en ? ' em-en' : ''}`} style={{ ...box(0, 8.8, 343.3), textAlign: 'center' }}>
              {remarkText ? m.remarkWith(remarkText) : m.remark}
            </span>
          </button>
          {/* 设计稿里这一行字比按钮正中偏右 4.45 */}
          <DrawerButton onClick={onSubmit} disabled={!!problem || locked} testId="emenu-submit" shift={en ? 0 : 4.45}>
            {en ? <span className="em-en" style={{ fontSize: 14 }}>{m.submit}</span> : m.submit}
          </DrawerButton>
          {rows.length > 0 && (
            <div className={en ? 'em-en' : undefined} style={{ ...box(DX, 734, 343.3), textAlign: 'center', fontSize: en ? 10 : 11, lineHeight: '14px', color: problem ? 'var(--em-error)' : MUTE }} data-testid="emenu-cart-note">
              {problem ?? (
                <>
                  {m.cartNoteBefore}
                  <span className="em-en">¥{yuan(total)}</span>
                  {m.cartNoteAfter}
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <ScrollArea style={{ ...box(DX, 160, 343.3, 470) }} testId="emenu-ordered">
            {!guest ? (
              <div className={en ? 'em-en' : undefined} style={{ paddingTop: 90, textAlign: 'center', fontSize: 13, color: MUTE }}>
                {guestLoading ? m.orderedLoading : m.orderedFailed}
              </div>
            ) : guest.ordered.length === 0 ? (
              <div className={en ? 'em-en' : undefined} style={{ paddingTop: 90, textAlign: 'center', fontSize: 13, color: MUTE }}>
                {m.orderedEmpty}
              </div>
            ) : (
              guest.ordered.map((l) => {
                const name = namePair(l.name, l.nameEn, lang);
                return (
                  <div key={l.lineId} style={{ position: 'relative', height: 46 }} data-testid={`emenu-ordered-${l.lineId}`}>
                    <div className={`em-clip${name.mainEn ? ' em-en' : ''}`} style={{ ...box(0.5, name.mainEn ? 16.9 : 15.9, 270), fontSize: name.mainEn ? 13 : 14, lineHeight: '14px' }}>
                      {name.main}
                      {l.quantity > 1 && <span className="em-en" style={{ fontSize: 11, lineHeight: 0, color: MUTE, marginLeft: 4 }}>× {l.quantity}</span>}
                    </div>
                    {name.mainEn ? (
                      <div className="em-clip" style={{ ...box(0.5, 31.2, 270), fontSize: 9, lineHeight: '9px', color: MUTE }}>
                        {name.sub}
                      </div>
                    ) : (
                      <div className="em-en em-clip" style={{ ...box(0.5, 30.6, 270), fontSize: 8, lineHeight: '8px', color: MUTE }}>
                        {name.sub}
                      </div>
                    )}
                    <div className="em-en" style={{ position: 'absolute', right: 0, top: 14.9, display: 'flex', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 8, width: 4.9, marginRight: 0.9 }}>¥</span>
                      <span style={{ fontSize: 16, lineHeight: '16px' }}>{yuan(l.amount)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </ScrollArea>
          {guest && (
            <div style={{ position: 'absolute', right: 42.1, top: 650.6, display: 'flex', alignItems: 'baseline', whiteSpace: 'nowrap' }} data-testid="emenu-ordered-total">
              {en ? (
                <span className="em-en" style={{ fontSize: 13, marginRight: 8 }}>
                  {m.orderedTotal}
                </span>
              ) : (
                <span style={{ fontSize: 14 }}>{m.orderedTotal}</span>
              )}
              {/* 设计稿里 ¥ 往回压在全角冒号的空白上 */}
              <span className="em-en" style={{ fontSize: 16, marginLeft: en ? 0 : -4.6, marginRight: 1.9 }}>¥</span>
              <span className="em-en" style={{ fontSize: 34, lineHeight: '34px' }}>{yuan(guest.orderedTotal)}</span>
            </div>
          )}
          <DrawerButton onClick={onClose} testId="emenu-drawer-close">
            {en ? <span className="em-en" style={{ fontSize: 14 }}>{m.close}</span> : m.close}
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
  optionsEn,
  swap,
  tableName,
  onChange,
  onDone,
}: {
  remark: Remark;
  avoidOptions: string[];
  serveOptions: string[];
  /** 各选项的英文（设置里填的；没填的用内置的） */
  optionsEn: Readonly<Record<string, string>>;
  swap?: boolean;
  tableName: string;
  onChange: (next: Remark) => void;
  onDone: () => void;
}) {
  const lang = useLang();
  const en = lang === 'en';
  const m = useM();
  const [tab, setTab] = useState<'avoid' | 'serve'>('avoid');
  const [custom, setCustom] = useState(!!remark.custom);
  const input = useRef<HTMLInputElement>(null);
  const tabButton = (key: 'avoid' | 'serve', label: string, x: number, w: number) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      aria-pressed={tab === key}
      className={en ? 'em-en em-cat' : 'em-cat'}
      style={{ ...box(x - 18, 106, w + 36, 44), padding: 0, border: 0, background: 'none', fontSize: en ? 15 : 18, lineHeight: '18px', color: tab === key ? 'var(--em-ink)' : MUTE }}
      data-testid={`emenu-remark-tab-${key}`}
    >
      {/* 字的文字框上沿 116.3、下面的线 144.9（设计稿） */}
      <span style={{ ...box(0, 10.3, w + 36), textAlign: 'center', whiteSpace: 'nowrap' }}>{label}</span>
      {tab === key && <span style={{ ...box(0, 38.4, w + 36, 0), borderTop: '1px solid var(--em-tan)' }} />}
    </button>
  );
  const options = tab === 'avoid' ? avoidOptions : serveOptions;
  return (
    <Drawer kind="remark" swap={swap} title="备注" subtitle="REMARKS" tableName={tableName} onClose={onDone} testId="emenu-remark">
      <div style={{ ...box(DX, 100.4, 343.3, 0), borderTop: LINE }} />
      {tabButton('avoid', m.tabAvoid, 75.4, 36)}
      {tabButton('serve', m.tabServe, 178.1, 72)}
      {options.map((o, i) => {
        const on = tab === 'avoid' ? remark.avoid.includes(o) : remark.serve === o;
        const toggle = () =>
          onChange(
            tab === 'avoid'
              ? { ...remark, avoid: on ? remark.avoid.filter((a) => a !== o) : avoidOptions.filter((a) => a === o || remark.avoid.includes(a)) }
              : { ...remark, serve: on ? null : o },
          );
        return (
          <Pill key={o} x={DX + (i % 3) * 120.65} y={166.7 + Math.floor(i / 3) * 44.1} on={on} onClick={toggle} testId={`emenu-remark-${o}`} en={en && optionLabel(o, lang, optionsEn) !== o}>
            {optionLabel(o, lang, optionsEn)}
          </Pill>
        );
      })}
      {options.length === 0 && <div style={{ ...box(DX, 176, 343.3), textAlign: 'center', fontSize: 13, color: MUTE }}>{m.noOptions}</div>}
      {custom && (
        <div style={{ ...box(DX, 628, 343.3, 30) }}>
          <input
            ref={input}
            value={remark.custom}
            onChange={(e) => onChange({ ...remark, custom: e.target.value.slice(0, EMENU_MAX_CUSTOM_NOTE) })}
            maxLength={EMENU_MAX_CUSTOM_NOTE}
            placeholder={m.customPlaceholder}
            aria-label={m.customAria}
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
        className="em-press"
        style={{ ...box(DX, 674, 343.3, 26), padding: 0, border: 0, background: 'none', fontSize: 12, lineHeight: '12px', color: MUTE }}
        data-testid="emenu-remark-custom-open"
      >
        <span className={en ? 'em-en' : undefined} style={{ ...box(0, 8.8, 343.3), textAlign: 'center' }}>
          {m.customOpen}
        </span>
      </button>
      <DrawerButton onClick={onDone} testId="emenu-remark-done">
        {en ? <span className="em-en" style={{ fontSize: 14 }}>{m.remarkDone}</span> : m.remarkDone}
      </DrawerButton>
    </Drawer>
  );
}
