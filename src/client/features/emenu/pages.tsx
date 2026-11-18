// 菜单页的 11 种版面（docs/EMENU.md 第 5 节）：位置、字号、颜色照设计师的《点餐系统版面模板-26.11.11》逐屏量的，
// 坐标按 1024×768 整页算（顶栏占最上面 102）。平板点餐页与后台的版面预览用的是同一份。
// 8.1.2（GZ13）：每一块在哪抽到 @shared/studio 的 EMENU_TEMPLATES（卡片模板），叠上工作台里设计师改过的（templates.tsx），
// 没改过时数与以前一模一样。

import type { CSSProperties, ReactNode } from 'react';
import { dishBlock, type EmenuBlock, type EmenuDishView, type EmenuPageView, type EmenuSpecView } from '@shared/emenu';
import { blockLabel, dishAttrs, dishDescription, dishNames, dishTagline, dishUnit, namePair, useLang, useM } from './i18n';
import { PlusDot } from './icons';
import { designPoint, FadeImg } from './motion';
import { BIG, box, useBig, ZoomAt } from './stage';
import { EMENU_PLUS_GAP, type EmenuPlusKind } from '@shared/studio';
import { inkCss, shadeCss, useDishState, useSlotPos, useSlots, type ResolvedSlot } from './templates';

export interface PageCtx {
  /** 这一页所在的分类：封面用它的名字；不在供应时段时整页的菜都标「当前时段不可售」 */
  categoryName: string;
  categoryNameEn?: string;
  open: boolean;
  /** 后台预览：没配图的位置写上「餐品展示」「特写图」，不能点 */
  preview?: boolean;
  /** origin：点的那个位置（设计稿坐标），菜品详情从那里放大出来 */
  onOpen?: (dish: EmenuDishView, origin?: { x: number; y: number } | null) => void;
  /** from：点的那个加号（加进去以后小圆点从它飞向订单图标） */
  onAdd?: (dish: EmenuDishView, from?: Element) => void;
  /** 搜索跳过来的那道菜闪几下 */
  flashId?: number | null;
}

const MUTE = 'var(--em-mute)';

/** 分 → 元：整数不带小数（42），有零头的带到分（42.5、42.05） */
export function yuan(cents: number): string {
  if (cents % 100 === 0) return String(cents / 100);
  return (cents / 100).toFixed(2).replace(/0$/, '');
}

/** 一道菜显示哪个规格的价格：第一个能点的，都不能点就第一个 */
export const displaySpec = (dish: EmenuDishView): EmenuSpecView | undefined => dish.specs.find((s) => s.state === 'ok') ?? dish.specs[0];

/** ¥42/份（设计稿：¥ 8 号、数字 14 号、斜杠 10 号、单位 7.5 号，同一条基线；¥ 占 4.9 宽、数字从 ¥ 的左边往右 6.6 开始）。切到英文时单位是 /portion */
export function Price({ cents, dish, scale = 1, style }: { cents: number; dish: Pick<EmenuDishView, 'unit' | 'unitEn'>; scale?: number; style?: CSSProperties }) {
  const unit = dishUnit(dish, useLang());
  return (
    <span className="em-en" style={{ display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap', ...style }}>
      <span style={{ fontSize: 8 * scale, width: 4.9 * scale, marginRight: 1.7 * scale, flex: 'none' }}>¥</span>
      <span style={{ fontSize: 14 * scale, lineHeight: `${14 * scale}px` }}>{yuan(cents)}</span>
      <span style={{ fontFamily: 'var(--em-zh)', fontSize: 10.05 * scale, letterSpacing: 0 }}>/</span>
      {unit.en ? <span style={{ fontSize: 8 * scale }}>{unit.text}</span> : <span style={{ fontFamily: 'var(--em-zh)', fontSize: 7.54 * scale, letterSpacing: 0 }}>{unit.text}</span>}
    </span>
  );
}

/** 加号的大小：设计稿 12.6；放大的一档圆点本身再大一点（连同整块的放大，屏幕上约 21） */
export const plusSize = (large: boolean) => (large ? 15 : 12.6);

/**
 * 加号与菜名的间距（8.1.5，PP5，EMENU_PLUS_GAP）：一段能缩的空，照理是加号大小的 4.5 倍（带图片）/ 2.5 倍（纯文字）；
 * 菜名长、地方不够时这段空往下收，最少 1 倍——所以菜名最宽给到「能用的宽 − 加号 − 1 倍的空」
 */
function PlusGap({ kind, large }: { kind: EmenuPlusKind; large: boolean }) {
  const size = plusSize(large);
  return <span aria-hidden style={{ flex: `0 1 ${EMENU_PLUS_GAP[kind] * size}px`, minWidth: size }} />;
}
const nameRoom = (width: number, large: boolean) => width - 2 * plusSize(large);

/** 加号：图标只有 12.6 大，点按区域放到 44。竖直方向比菜名的文字框高 0.9（设计稿） */
export function PlusButton({ dish, ctx, block, style }: { dish: EmenuDishView; ctx: PageCtx; block: EmenuBlock | null; style?: CSSProperties }) {
  const lang = useLang();
  const m = useM();
  const disabled = !!block || ctx.preview;
  const large = useBig();
  const size = plusSize(large);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        ctx.onAdd?.(dish, e.currentTarget);
      }}
      aria-label={m.addAria(dishNames(dish, lang).main)}
      className="em-tap"
      style={{ position: 'relative', width: size, height: size, marginTop: large ? -2.1 : -0.9, padding: 0, border: 0, background: 'none', flex: 'none', ...style }}
      data-testid={`emenu-add-${dish.id}`}
    >
      <span style={{ position: 'absolute', inset: -15.7 }} />
      <PlusDot size={size} muted={!!block} />
    </button>
  );
}

/** 图片位：没配图是设计稿的浅灰底；不能点的菜压暗写原因（设计稿「售罄状态」） */
export function Photo({
  url,
  x,
  y,
  w,
  h,
  dish,
  ctx,
  label,
  tint,
  slot,
}: {
  url: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  dish: EmenuDishView | null;
  ctx: PageCtx;
  /** 预览时没配图的位置上写的字 */
  label: string;
  /** 两张图挨着时第二张的底色浅一点（设计稿「两个菜」并排的那一版） */
  tint?: boolean;
  /** 卡片模板里的哪一块（工作台的画布按它量位置、画框） */
  slot?: string;
}) {
  const lang = useLang();
  // 放大的一档：压在图上的「已售罄」等字大一档
  const f = useBig() ? BIG.dish : 1;
  const block = dish ? dishBlock(dish, ctx.open) : null;
  const clickable = !!dish && !ctx.preview && !!ctx.onOpen;
  const why = block ? blockLabel(block, lang) : null;
  // 售罄、当前时段不可售、已下架的样子（8.1.2 变体，工作台里改；没改过是设计稿：压暗 55%、浅色字居中两行）
  const st = useDishState(block);
  return (
    <div
      role={clickable ? 'button' : undefined}
      onClick={clickable ? (e) => ctx.onOpen!(dish!, designPoint(e.currentTarget)) : undefined}
      className={clickable ? 'em-lift' : undefined}
      // 照片一律直角（8.1.8，品牌部，PENDING_DECISIONS.md PB3）：以前在工作台里加过的圆角不生效，大小不变
      style={{ ...box(x, y, w, h), background: tint ? '#e2e2e2' : 'var(--em-photo)', overflow: 'hidden', cursor: clickable ? 'pointer' : undefined }}
      data-testid={dish ? `emenu-photo-${dish.id}` : undefined}
      data-studio-slot={slot}
    >
      {url ? (
        <FadeImg
          src={url}
          loading="lazy"
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...(why && st.grayscale ? { filter: 'grayscale(1)' } : {}) }}
        />
      ) : (
        ctx.preview && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>{label}</span>
      )}
      {why && url && st.style !== 'center' && (
        // 左上角小标签 / 只压暗
        <span style={{ position: 'absolute', inset: 0, background: shadeCss(st.shade, st.shadeOpacity) }} data-testid={`emenu-block-${dish!.id}`} data-style={st.style}>
          {st.style === 'badge' && (
            <span
              className={why.mainEn ? 'em-en' : undefined}
              style={{
                position: 'absolute',
                left: 10 * f,
                top: 10 * f,
                padding: `${4 * f}px ${8 * f}px`,
                borderRadius: 999,
                background: shadeCss(st.shade, Math.max(0.75, st.shadeOpacity)),
                color: inkCss(st.textColor),
                fontSize: 11 * f,
                lineHeight: `${12 * f}px`,
                whiteSpace: 'nowrap',
              }}
            >
              {why.main}
            </span>
          )}
        </span>
      )}
      {why && url && st.style === 'center' && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            background: shadeCss(st.shade, st.shadeOpacity),
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: inkCss(st.textColor),
          }}
          data-testid={`emenu-block-${dish!.id}`}
        >
          {why.mainEn ? (
            <>
              <span className="em-en" style={{ fontSize: 15 * f, lineHeight: `${15 * f}px` }}>
                {why.main}
              </span>
              <span style={{ fontSize: 9 * f, lineHeight: `${9 * f}px`, marginTop: 3 * f }}>{why.sub}</span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 16 * f, lineHeight: `${16 * f}px` }}>{why.main}</span>
              <span className="em-en" style={{ fontSize: 8 * f, lineHeight: `${8 * f}px`, marginTop: 0.7 * f }}>
                {why.sub}
              </span>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/** 没有图压暗的地方（文字版面、没配图的菜）：价格旁写一行小字 */
function BlockNote({ block }: { block: EmenuBlock }) {
  const why = blockLabel(block, useLang());
  return (
    <span className={why.mainEn ? 'em-en' : undefined} style={{ fontSize: 9, color: MUTE, marginLeft: 8, whiteSpace: 'nowrap' }}>
      {why.main}
    </span>
  );
}

/** 名称后面的小字（中文的补括号；英文的也补） */
function Tagline({ dish }: { dish: EmenuDishView }) {
  const tag = dishTagline(dish, useLang());
  if (!tag.text) return null;
  return (
    <span className={tag.en ? 'em-en' : undefined} style={{ fontSize: tag.en ? 9 : 10, lineHeight: 0, color: MUTE, marginLeft: tag.en ? 3 : undefined }}>
      {wrapParen(tag.text)}
    </span>
  );
}

/**
 * 一道菜的文字：菜名（后面可以带小字）、加号、英文名、介绍、价格。
 * 设计稿每一版里这几行离菜名文字框上沿的距离都一样：英文名 16.7；介绍 51.4（tight 是 35.7，「两个菜」一大一小那一版），
 * 每行 13；价格（14 号的数字）在介绍最后一行下面 23.6，没有介绍时在 37.4；加号比菜名高 0.9、紧跟在菜名后面，
 * 间距是加号大小的 4.5 倍（带图片）/ 2.5 倍（纯文字，plus = 'text'）（8.1.5，原来是 44.2，图文列表的按列对齐）。
 * desc：normal / tight 见上；none 不要介绍。
 * 切到英文（8.0.13）：英文名为主（14 号、放不下折成两行），中文名在下面一行小字；介绍用英文介绍。
 *
 * 放大的一档（8.0.15）：里面的字号不变，整块放大 BIG.dish 倍（菜名 22、介绍 13、价格 20），行与行之间原来留得很宽的空收紧一些；
 * 位置、宽度用 big 里给的（没给的沿用设计稿的），big.bottom 是文字块的下沿贴在哪条线上（往上长，用在文字下面紧挨着图的版面）。
 */
export interface BigSpot {
  x?: number;
  y?: number;
  w?: number;
  bottom?: number;
  /** 介绍最多几行（默认 4） */
  lines?: number;
}

export function DishText({
  dish,
  x,
  y,
  w,
  ctx,
  desc = 'none',
  plus = 'photo',
  noteByPrice,
  big,
  slot,
}: {
  dish: EmenuDishView;
  x: number;
  y: number;
  w: number;
  ctx: PageCtx;
  desc?: 'normal' | 'tight' | 'none';
  /** 加号与菜名的间距按哪一种算（8.1.5）：photo 带图片的 4.5 倍、text 纯文字的 2.5 倍 */
  plus?: EmenuPlusKind;
  big?: BigSpot;
  /** 这道菜在这一页没有图可以压暗：不能点的原因写在价格旁 */
  noteByPrice?: boolean;
  /** 卡片模板里的哪一块（工作台的画布量的是放大以后看到的这一块） */
  slot?: string;
}) {
  const lang = useLang();
  const block = dishBlock(dish, ctx.open);
  const textOpacity = useDishState(block).textOpacity;
  const spec = displaySpec(dish);
  const name = dishNames(dish, lang);
  const intro = dishDescription(dish, lang);
  const showDesc = desc !== 'none' && !!intro.text;
  const clickable = !ctx.preview && !!ctx.onOpen;
  const large = useBig();
  const k = large ? BIG.dish : 1;
  const at = large ? { x: big?.x ?? x, y: big?.y ?? y, w: big?.w ?? w, bottom: big?.bottom } : { x, y, w, bottom: undefined };
  // 里面能用的宽（放大以前的像素）；菜名最宽给到「能用的宽 − 加号 − 1 倍的空」
  const inner = at.w / k;
  const nameWidth = nameRoom(inner, large);
  const gapUnderName = name.sub ? 0 : 8.7;
  return (
    <div
      style={{ position: 'absolute', left: at.x, ...(at.bottom === undefined ? { top: at.y } : { bottom: 768 - at.bottom }), width: at.w, opacity: block && noteByPrice ? textOpacity : 1 }}
      data-testid={`emenu-dish-${dish.id}`}
      data-block={block ?? undefined}
    >
      <div
        className={ctx.flashId === dish.id ? 'em-flash' : undefined}
        style={large ? { width: inner, transform: `scale(${k})`, transformOrigin: at.bottom === undefined ? '0 0' : '0 100%' } : undefined}
        data-studio-slot={slot}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', minHeight: 16, position: 'relative' }}>
          <span
            role={clickable ? 'button' : undefined}
            onClick={clickable ? (e) => ctx.onOpen!(dish, designPoint(e.currentTarget)) : undefined}
            className={`${name.mainEn ? 'em-en ' : ''}${clickable ? 'em-press' : ''}`}
            style={
              name.mainEn
                ? {
                    fontSize: 14,
                    lineHeight: '16px',
                    minWidth: 0,
                    flex: 'none',
                    cursor: clickable ? 'pointer' : undefined,
                    maxWidth: nameWidth,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }
                : { fontSize: 16, lineHeight: '16px', minWidth: 0, flex: 'none', cursor: clickable ? 'pointer' : undefined, maxWidth: nameWidth }
            }
            data-testid={`emenu-name-${dish.id}`}
          >
            {name.main}
            <Tagline dish={dish} />
          </span>
          <PlusGap kind={plus} large={large} />
          <PlusButton dish={dish} ctx={ctx} block={block} />
        </div>
        {name.sub &&
          (name.mainEn ? (
            <div className="em-clip" style={{ fontSize: 9, lineHeight: '9px', marginTop: 2.4, color: MUTE, maxWidth: nameWidth + 40 }}>
              {name.sub}
            </div>
          ) : (
            <div className="em-en em-clip" style={{ fontSize: 8, lineHeight: '8px', marginTop: 0.7, color: MUTE }}>
              {name.sub}
            </div>
          ))}
        {showDesc && (
          <div
            className={intro.en ? 'em-en' : undefined}
            style={
              large
                ? {
                    fontSize: 9.5,
                    lineHeight: '13.5px',
                    letterSpacing: intro.en ? '0.2px' : '0.5px',
                    color: MUTE,
                    marginTop: (desc === 'tight' ? 9 : 12) + gapUnderName,
                    maxWidth: Math.min(inner, 310),
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: big?.lines ?? 4,
                    WebkitBoxOrient: 'vertical',
                  }
                : {
                    fontSize: 9,
                    lineHeight: '13px',
                    letterSpacing: intro.en ? '0.2px' : '0.62px',
                    color: MUTE,
                    marginTop: (desc === 'tight' ? 9 : 24.7) + gapUnderName,
                    maxWidth: 262,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 4,
                    WebkitBoxOrient: 'vertical',
                  }
            }
          >
            {intro.text}
          </div>
        )}
        {spec && (
          <div style={{ marginTop: large ? (showDesc ? 14 : 10 + gapUnderName) : showDesc ? 23.6 : 12.7 + gapUnderName, display: 'flex', alignItems: 'baseline' }}>
            <Price cents={spec.price} dish={dish} />
            {block && noteByPrice && <BlockNote block={block} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** 名称后面的小字：没写括号的补上（煎档 → (煎档)） */
export function wrapParen(text: string): string {
  const t = text.trim();
  return /^[（(].*[）)]$/.test(t) ? t : `(${t})`;
}

/**
 * 竖排小标题：中文一字一行，英文转 90 度（精品推荐 BEST SELLERS / 酒水 BEVERAGE）。x、y 是设计稿里第一个中文字的文字框。
 * 设计稿是竖排文字：字的原点在文字框上沿、基线在下沿；这里一字一行横排，基线在行框上沿往下 0.707，所以整体往下挪 16 × (1 − 0.707) = 4.7。
 * 英文 14 号，文字框在中文左边 19.4、比中文低 2.4 开始。
 */
function VerticalTitle({ x, y, title, titleEn, slot }: { x: number; y: number; title: string; titleEn: string; slot?: string }) {
  // 切到英文：英文那一竖用深色、中文用浅色（位置不动）
  const en = useLang() === 'en' && !!titleEn;
  // 放大的一档：整块绕中文第一个字的左上角放大（x、y 由各版面另给）
  const k = useBig() ? BIG.row : 1;
  return (
    <ZoomAt x={x} y={y} k={k}>
      {titleEn && (
        <div
          className="em-en"
          style={{ ...box(-19.4, 3.4), writingMode: 'vertical-rl', fontSize: 14, lineHeight: '14px', letterSpacing: '0.062em', color: en ? 'var(--em-ink)' : MUTE, whiteSpace: 'nowrap' }}
          data-studio-slot={slot}
        >
          {titleEn}
        </div>
      )}
      {title && (
        <div
          style={{ ...box(0, 4.7), width: 16, fontSize: 16, lineHeight: '16px', wordBreak: 'break-all', textAlign: 'center', color: en ? MUTE : undefined }}
          data-testid="emenu-vtitle"
          data-studio-slot={slot}
        >
          {title}
        </div>
      )}
    </ZoomAt>
  );
}

type Slot = EmenuDishView | null | undefined;

/** 没配图的菜在有图的版面里：图片位是灰底、压不暗，原因写在价格旁 */
const noteIfNoImage = (_dish: EmenuDishView, url: string | null) => !url;

/** 卡片模板里的一张图（照片位）：藏起来的不画；当前这一档的位置；用菜品的餐品图或特写图 */
function SlotPhoto({ s, dish, ctx }: { s: ResolvedSlot; dish: Slot; ctx: PageCtx }) {
  const pos = useSlotPos();
  if (s.hidden) return null;
  const p = pos(s);
  const url = s.def.source === 'detail' ? (dish?.detailUrl ?? null) : (dish?.imageUrl ?? null);
  return <Photo url={url} x={p.x} y={p.y} w={p.w} h={p.h} dish={dish ?? null} ctx={ctx} label={s.def.source === 'detail' ? '特写图' : '餐品展示'} tint={s.def.tint} slot={s.def.key} />;
}

/** 卡片模板里一道菜的文字（菜名、介绍、价格、加号）：原样的位置 + 放大一档另给的（DishText 自己按档取） */
function SlotText({ s, dish, ctx, noteByPrice }: { s: ResolvedSlot; dish: EmenuDishView; ctx: PageCtx; noteByPrice: boolean }) {
  return <DishText dish={dish} x={s.x} y={s.y} w={s.w} ctx={ctx} desc={s.def.desc} plus={s.def.plus} noteByPrice={noteByPrice} big={s.big} slot={s.def.key} />;
}

/**
 * 分类封面大标题右下角的小圆圈（8.1.8，品牌部「点餐首页中“中式午餐”右下角需向图片内标明同款圆形」，PENDING_DECISIONS.md PB2）：
 * 照品牌部给的图量的——直径 0.35 个字、细红线；圆心落在最后一个字的右下角（中文：字形下缘往上 0.075 个字、右缘往里 0.02 个字；
 * 英文按大写字母的底线）。挂在标题那一行字上，跟着字号、位置走；标题藏起来时一起不显示。颜色固定（样式表里的 --em-dot，不进工作台的主题色）。
 */
function CoverDot({ en }: { en: boolean }) {
  return <span aria-hidden className="em-cover-dot" style={en ? { right: '-0.06em', bottom: '0.155em' } : { right: '-0.12em', bottom: '0.055em' }} data-testid="emenu-cover-dot" />;
}

function Cover({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  const slot = useSlots('cover');
  const pos = useSlotPos();
  const title = namePair(ctx.categoryName, ctx.categoryNameEn ?? '', useLang());
  // 英文的大标题按长短收字号：左半边能用的宽度约 480
  const enSize = Math.max(22, Math.min(44, Math.floor(480 / (Math.max(title.main.length, 1) * 0.66))));
  // 封面标题：设计稿里中文在 (37.4, 218.5)；英文为主的两行跟着一起挪
  const t = slot('title');
  const tp = pos(t);
  const dx = tp.x - t.def.x;
  const dy = tp.y - t.def.y;
  return (
    <>
      {t.hidden ? null : title.mainEn ? (
        <>
          <div
            className="em-en"
            style={{ ...box(38.6 + dx, 222.5 + dy), fontSize: enSize, lineHeight: '44px', whiteSpace: 'nowrap', letterSpacing: '0.04em' }}
            data-testid="emenu-cover-title"
            data-studio-slot="title"
          >
            <span style={{ position: 'relative' }}>
              {title.main}
              <CoverDot en />
            </span>
          </div>
          <div style={{ ...box(40 + dx, 274 + dy), fontSize: 15, lineHeight: '15px', color: MUTE, whiteSpace: 'nowrap' }} data-studio-slot="title">
            {title.sub}
          </div>
        </>
      ) : (
        <div style={{ ...box(37.4 + dx, 218.5 + dy), fontSize: 48, lineHeight: '48px', whiteSpace: 'nowrap' }} data-testid="emenu-cover-title" data-studio-slot="title">
          <span style={{ position: 'relative' }}>
            {title.main}
            <CoverDot en={false} />
          </span>
        </div>
      )}
      {/* 放大的一档：文字的下沿贴在特写图上面 24（往上长） */}
      {d && <SlotText s={slot('text')} dish={d} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
      <SlotPhoto s={slot('detail')} dish={d} ctx={ctx} />
      <SlotPhoto s={slot('photo')} dish={d} ctx={ctx} />
    </>
  );
}

function ListImage({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const first: Slot = page.dishes.find((d) => d);
  const slot = useSlots('list_image');
  const pos = useSlotPos();
  // 放大的一档：小标题与两列往左挪（图右边到页边的空都用上），三行拉开（位置在卡片模板里）
  const t = slot('title');
  const tp = pos(t);
  return (
    <>
      <SlotPhoto s={slot('photo')} dish={first} ctx={ctx} />
      {!t.hidden && <VerticalTitle x={tp.x} y={tp.y} title={page.title} titleEn={page.titleEn} slot="title" />}
      {page.dishes.slice(0, 6).map((d, i) => (d ? <SlotText key={d.id} s={slot(`d${i}`)} dish={d} ctx={ctx} noteByPrice /> : null))}
    </>
  );
}

function SingleWide({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  const slot = useSlots('single_wide');
  const pos = useSlotPos();
  const intro = d ? dishDescription(d, useLang()) : null;
  const large = useBig();
  const it = slot('intro');
  const ip = pos(it);
  return (
    <>
      <SlotPhoto s={slot('photo')} dish={d} ctx={ctx} />
      {d && <SlotText s={slot('text')} dish={d} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
      {intro?.text && large && !it.hidden && (
        <ZoomAt x={ip.x} y={ip.y} k={BIG.dish}>
          <div
            className={intro.en ? 'em-en' : undefined}
            style={{
              width: ip.w / BIG.dish,
              fontSize: 9.5,
              lineHeight: '13.5px',
              letterSpacing: intro.en ? '0.2px' : '0.5px',
              color: MUTE,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 6,
              WebkitBoxOrient: 'vertical',
            }}
            data-studio-slot="intro"
          >
            {intro.text}
          </div>
        </ZoomAt>
      )}
      {intro?.text && !large && !it.hidden && (
        <div
          className={intro.en ? 'em-en' : undefined}
          style={{
            ...box(ip.x, ip.y, ip.w),
            fontSize: 9,
            lineHeight: '13px',
            letterSpacing: intro.en ? '0.2px' : '0.62px',
            color: MUTE,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 5,
            WebkitBoxOrient: 'vertical',
          }}
          data-studio-slot="intro"
        >
          {intro.text}
        </div>
      )}
    </>
  );
}

function SingleLeft({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  const slot = useSlots('single_left');
  return (
    <>
      <SlotPhoto s={slot('photo')} dish={d} ctx={ctx} />
      <SlotPhoto s={slot('detail')} dish={d} ctx={ctx} />
      {d && <SlotText s={slot('text')} dish={d} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
    </>
  );
}

function SingleRight({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  const slot = useSlots('single_right');
  return (
    <>
      {d && <SlotText s={slot('text')} dish={d} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
      <SlotPhoto s={slot('detail')} dish={d} ctx={ctx} />
      <SlotPhoto s={slot('photo')} dish={d} ctx={ctx} />
    </>
  );
}

function DuoStagger({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const [a, b]: Slot[] = page.dishes;
  const slot = useSlots('duo_stagger');
  return (
    <>
      <SlotPhoto s={slot('a.photo')} dish={a} ctx={ctx} />
      {a && <SlotText s={slot('a.text')} dish={a} ctx={ctx} noteByPrice={noteIfNoImage(a, a.imageUrl)} />}
      {/* 放大的一档：第二道的文字下沿贴在它的图上面 24（往上长），介绍最多 3 行 */}
      {b && <SlotText s={slot('b.text')} dish={b} ctx={ctx} noteByPrice={noteIfNoImage(b, b.imageUrl)} />}
      <SlotPhoto s={slot('b.photo')} dish={b} ctx={ctx} />
    </>
  );
}

function DuoRow({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const [a, b]: Slot[] = page.dishes;
  const slot = useSlots('duo_row');
  return (
    <>
      <SlotPhoto s={slot('a.photo')} dish={a} ctx={ctx} />
      <SlotPhoto s={slot('b.photo')} dish={b} ctx={ctx} />
      {a && <SlotText s={slot('a.text')} dish={a} ctx={ctx} noteByPrice={noteIfNoImage(a, a.imageUrl)} />}
      {b && <SlotText s={slot('b.text')} dish={b} ctx={ctx} noteByPrice={noteIfNoImage(b, b.imageUrl)} />}
    </>
  );
}

function DuoMixed({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const [a, b]: Slot[] = page.dishes;
  const slot = useSlots('duo_mixed');
  return (
    <>
      {/* 放大的一档：第一道的文字下沿贴在它的图上面 24（往上长） */}
      {a && <SlotText s={slot('a.text')} dish={a} ctx={ctx} noteByPrice={noteIfNoImage(a, a.imageUrl)} />}
      <SlotPhoto s={slot('a.photo')} dish={a} ctx={ctx} />
      <SlotPhoto s={slot('b.photo')} dish={b} ctx={ctx} />
      {b && <SlotText s={slot('b.text')} dish={b} ctx={ctx} noteByPrice={noteIfNoImage(b, b.imageUrl)} />}
    </>
  );
}

function TrioRow({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const slot = useSlots('trio_row');
  return (
    <>
      {(['a', 'b', 'c'] as const).map((k, i) => {
        const d: Slot = page.dishes[i];
        return (
          <div key={k}>
            <SlotPhoto s={slot(`${k}.photo`)} dish={d} ctx={ctx} />
            {d && <SlotText s={slot(`${k}.text`)} dish={d} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
          </div>
        );
      })}
    </>
  );
}

function TrioMixed({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const slot = useSlots('trio_mixed');
  return (
    <>
      {(['a', 'b', 'c'] as const).map((k, i) => {
        const d: Slot = page.dishes[i];
        return (
          <div key={k}>
            <SlotPhoto s={slot(`${k}.photo`)} dish={d} ctx={ctx} />
            {d && <SlotText s={slot(`${k}.text`)} dish={d} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
          </div>
        );
      })}
    </>
  );
}

/** 文字陈列的一行里，菜名连同后面的加号最多排到哪（价格从 196.2 开始，留 8 的空） */
const TEXT_ROW_NAME_W = 188;

/**
 * 文字陈列的一行：名称、英文名、属性行在左，价格在右上（各处离名称文字框左上角的距离是设计稿量的）；加号紧跟在名称后面，
 * 间距是加号大小的 2.5 倍（8.1.5 纯文字的菜，PP5；原来在价格下面）。
 * 切到英文（8.0.13）：英文名为主、放不下折成两行，下面依次是中文名、属性行（一行行往下排，不压在一起）。
 */
function TextRow({ dish, x, y, ctx, slot }: { dish: EmenuDishView; x: number; y: number; ctx: PageCtx; slot?: string }) {
  const lang = useLang();
  const block = dishBlock(dish, ctx.open);
  const spec = displaySpec(dish);
  const name = dishNames(dish, lang);
  const attrs = dishAttrs(dish, lang);
  const why = block ? blockLabel(block, lang) : null;
  const textOpacity = useDishState(block).textOpacity;
  const clickable = !ctx.preview && !!ctx.onOpen;
  const open = clickable ? (e: { currentTarget: Element }) => ctx.onOpen!(dish, designPoint(e.currentTarget)) : undefined;
  // 放大的一档：这一行整块放大（x、y 由 ListText 另给）
  const large = useBig();
  const k = large ? BIG.row : 1;
  const plus = (
    <>
      <PlusGap kind="text" large={large} />
      <PlusButton dish={dish} ctx={ctx} block={block} />
    </>
  );
  return (
    <div style={{ ...box(x, y, 232 * k, 74 * k), opacity: block ? textOpacity : 1 }} data-testid={`emenu-dish-${dish.id}`} data-block={block ?? undefined} data-studio-slot={slot}>
      <div className={ctx.flashId === dish.id ? 'em-flash' : undefined} style={{ ...box(0, 0, 232, 74), transform: k === 1 ? undefined : `scale(${k})`, transformOrigin: '0 0' }}>
        {name.mainEn ? (
          <div style={{ width: 186 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', width: TEXT_ROW_NAME_W }}>
              <div
                role={clickable ? 'button' : undefined}
                onClick={open}
                className={`em-en${clickable ? ' em-press' : ''}`}
                style={{
                  fontSize: 13,
                  lineHeight: '15px',
                  minWidth: 0,
                  maxWidth: nameRoom(TEXT_ROW_NAME_W, large),
                  flex: 'none',
                  cursor: clickable ? 'pointer' : undefined,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
                data-testid={`emenu-name-${dish.id}`}
              >
                {name.main}
                <Tagline dish={dish} />
              </div>
              {plus}
            </div>
            <div className="em-clip" style={{ fontSize: 9, lineHeight: '9px', marginTop: 2.6, color: MUTE }}>
              {name.sub}
            </div>
            <div className={attrs.en ? 'em-en' : undefined} style={{ fontSize: 8.5, lineHeight: '9px', color: MUTE, marginTop: 4 }}>
              {attrs.list.map((a) => (
                <div key={a} className="em-clip" style={{ marginBottom: 1.8 }}>
                  {a}
                </div>
              ))}
              {why && <div className="em-en">{why.main}</div>}
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', width: TEXT_ROW_NAME_W }}>
              <div
                role={clickable ? 'button' : undefined}
                onClick={open}
                className={`em-clip${clickable ? ' em-press' : ''}`}
                style={{ fontSize: 16, lineHeight: '16px', minWidth: 0, maxWidth: nameRoom(TEXT_ROW_NAME_W, large), flex: 'none', cursor: clickable ? 'pointer' : undefined }}
                data-testid={`emenu-name-${dish.id}`}
              >
                {name.main}
                <Tagline dish={dish} />
              </div>
              {plus}
            </div>
            {name.sub && (
              <div className="em-en em-clip" style={{ ...box(1, 16.7, 186), fontSize: 8, lineHeight: '8px', color: MUTE }}>
                {name.sub}
              </div>
            )}
            {/* 属性行：第一行的文字框在名称上沿往下 34.3，每行隔 10.8（行高等于字号、行与行之间用外边距隔开，各家浏览器位置一样） */}
            <div className={attrs.en ? 'em-en' : undefined} style={{ ...box(1, 34.3, 186), fontSize: 9, lineHeight: '9px', color: MUTE }}>
              {attrs.list.map((a) => (
                <div key={a} className="em-clip" style={{ marginBottom: 1.8 }}>
                  {a}
                </div>
              ))}
              {why && <div className={why.mainEn ? 'em-en' : undefined}>{why.main}</div>}
            </div>
          </>
        )}
        {spec && <Price cents={spec.price} dish={dish} style={{ ...box(196.2, 0.6) }} />}
      </div>
    </div>
  );
}

function ListText({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const slot = useSlots('list_text');
  const pos = useSlotPos();
  // 放大的一档：小标题与两列往左挪（左边原来空着的一大块用上），5 行的间隔从 90 拉到 112（位置在卡片模板里）
  const t = slot('title');
  const tp = pos(t);
  return (
    <>
      {!t.hidden && <VerticalTitle x={tp.x} y={tp.y} title={page.title} titleEn={page.titleEn} slot="title" />}
      {page.dishes.slice(0, 10).map((d, i) => {
        if (!d) return null;
        const r = pos(slot(`r${i}`));
        return <TextRow key={d.id} dish={d} x={r.x} y={r.y} ctx={ctx} slot={`r${i}`} />;
      })}
    </>
  );
}

const LAYOUTS: Record<EmenuPageView['layout'], (p: { page: EmenuPageView; ctx: PageCtx }) => ReactNode> = {
  cover: Cover,
  list_image: ListImage,
  single_wide: SingleWide,
  single_left: SingleLeft,
  single_right: SingleRight,
  duo_stagger: DuoStagger,
  duo_row: DuoRow,
  duo_mixed: DuoMixed,
  trio_row: TrioRow,
  trio_mixed: TrioMixed,
  list_text: ListText,
};

/** 一整页（1024×768，顶栏那一条留空给外面画） */
export function PageCanvas({ page, ctx, style }: { page: EmenuPageView; ctx: PageCtx; style?: CSSProperties }) {
  const Layout = LAYOUTS[page.layout];
  return (
    <div style={{ position: 'relative', width: 1024, height: 768, flex: 'none', overflow: 'hidden', ...style }} data-layout={page.layout}>
      <Layout page={page} ctx={ctx} />
    </div>
  );
}
