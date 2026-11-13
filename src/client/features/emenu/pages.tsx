// 菜单页的 11 种版面（docs/EMENU.md 第 5 节）：位置、字号、颜色照设计师的《点餐系统版面模板-26.11.11》逐屏量的，
// 坐标按 1024×768 整页算（顶栏占最上面 102）。平板点餐页与后台的版面预览用的是同一份。

import type { CSSProperties, ReactNode } from 'react';
import { dishBlock, type EmenuBlock, type EmenuDishView, type EmenuPageView, type EmenuSpecView } from '@shared/emenu';
import { blockLabel, dishAttrs, dishDescription, dishNames, dishTagline, dishUnit, namePair, useLang, useM } from './i18n';
import { PlusDot } from './icons';
import { designPoint, FadeImg } from './motion';
import { BIG, box, useBig, ZoomAt } from './stage';

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

/** 加号：图标只有 12.6 大，点按区域放到 44 */
export function PlusButton({ dish, ctx, block, style }: { dish: EmenuDishView; ctx: PageCtx; block: EmenuBlock | null; style?: CSSProperties }) {
  const lang = useLang();
  const m = useM();
  const disabled = !!block || ctx.preview;
  // 放大的一档：圆点本身再大一点（连同整块的放大，屏幕上约 21），中心不动
  const large = useBig();
  const size = large ? 15 : 12.6;
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
      style={{ position: 'relative', width: size, height: size, margin: large ? -1.2 : undefined, padding: 0, border: 0, background: 'none', flex: 'none', ...style }}
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
}) {
  const lang = useLang();
  // 放大的一档：压在图上的「已售罄」等字大一档
  const f = useBig() ? BIG.dish : 1;
  const block = dish ? dishBlock(dish, ctx.open) : null;
  const clickable = !!dish && !ctx.preview && !!ctx.onOpen;
  const why = block ? blockLabel(block, lang) : null;
  return (
    <div
      role={clickable ? 'button' : undefined}
      onClick={clickable ? (e) => ctx.onOpen!(dish!, designPoint(e.currentTarget)) : undefined}
      className={clickable ? 'em-lift' : undefined}
      style={{ ...box(x, y, w, h), background: tint ? '#e2e2e2' : 'var(--em-photo)', overflow: 'hidden', cursor: clickable ? 'pointer' : undefined }}
      data-testid={dish ? `emenu-photo-${dish.id}` : undefined}
    >
      {url ? (
        <FadeImg src={url} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        ctx.preview && (
          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>{label}</span>
        )
      )}
      {why && url && (
        <span
          style={{ position: 'absolute', inset: 0, background: 'rgb(0 0 0 / 0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#f4f3f2' }}
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
 * 每行 13；价格（14 号的数字）在介绍最后一行下面 23.6，没有介绍时在 37.4；加号比菜名高 0.9、跟在菜名后面隔 44.2。
 * desc：normal / tight 见上；none 不要介绍。plusAt：加号放在离左边多远（列表里按列对齐）。
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
  plusAt?: number;
}

export function DishText({
  dish,
  x,
  y,
  w,
  ctx,
  desc = 'none',
  plusAt: plusAtDesign,
  noteByPrice,
  big,
}: {
  dish: EmenuDishView;
  x: number;
  y: number;
  w: number;
  ctx: PageCtx;
  desc?: 'normal' | 'tight' | 'none';
  plusAt?: number;
  big?: BigSpot;
  /** 这道菜在这一页没有图可以压暗：不能点的原因写在价格旁 */
  noteByPrice?: boolean;
}) {
  const lang = useLang();
  const block = dishBlock(dish, ctx.open);
  const spec = displaySpec(dish);
  const name = dishNames(dish, lang);
  const intro = dishDescription(dish, lang);
  const showDesc = desc !== 'none' && !!intro.text;
  const clickable = !ctx.preview && !!ctx.onOpen;
  const large = useBig();
  const k = large ? BIG.dish : 1;
  const at = large ? { x: big?.x ?? x, y: big?.y ?? y, w: big?.w ?? w, bottom: big?.bottom } : { x, y, w, bottom: undefined };
  const plusAt = large ? (big?.plusAt ?? plusAtDesign) : plusAtDesign;
  // 里面能用的宽（放大以前的像素）
  const inner = at.w / k;
  const nameWidth = plusAt !== undefined ? plusAt - 8 : large ? inner - 30 : w - 58;
  const gapUnderName = name.sub ? 0 : 8.7;
  return (
    <div
      style={{ position: 'absolute', left: at.x, ...(at.bottom === undefined ? { top: at.y } : { bottom: 768 - at.bottom }), width: at.w, opacity: block && noteByPrice ? 0.5 : 1 }}
      data-testid={`emenu-dish-${dish.id}`}
      data-block={block ?? undefined}
    >
     <div className={ctx.flashId === dish.id ? 'em-flash' : undefined} style={large ? { width: inner, transform: `scale(${k})`, transformOrigin: at.bottom === undefined ? '0 0' : '0 100%' } : undefined}>
      <div style={{ display: 'flex', alignItems: 'flex-start', minHeight: 16, position: 'relative' }}>
        <span
          role={clickable ? 'button' : undefined}
          onClick={clickable ? (e) => ctx.onOpen!(dish, designPoint(e.currentTarget)) : undefined}
          className={`${name.mainEn ? 'em-en ' : ''}${clickable ? 'em-press' : ''}`}
          style={
            name.mainEn
              ? { fontSize: 14, lineHeight: '16px', minWidth: 0, cursor: clickable ? 'pointer' : undefined, maxWidth: nameWidth, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
              : { fontSize: 16, lineHeight: '16px', minWidth: 0, cursor: clickable ? 'pointer' : undefined, maxWidth: nameWidth }
          }
          data-testid={`emenu-name-${dish.id}`}
        >
          {name.main}
          <Tagline dish={dish} />
        </span>
        <PlusButton dish={dish} ctx={ctx} block={block} style={plusAt === undefined ? { marginLeft: large ? 15 : 44.2, marginTop: -0.9 } : { position: 'absolute', left: plusAt, top: -0.9 }} />
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
              ? { fontSize: 9.5, lineHeight: '13.5px', letterSpacing: intro.en ? '0.2px' : '0.5px', color: MUTE, marginTop: (desc === 'tight' ? 9 : 12) + gapUnderName, maxWidth: Math.min(inner, 310), overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: big?.lines ?? 4, WebkitBoxOrient: 'vertical' }
              : { fontSize: 9, lineHeight: '13px', letterSpacing: intro.en ? '0.2px' : '0.62px', color: MUTE, marginTop: (desc === 'tight' ? 9 : 24.7) + gapUnderName, maxWidth: 262, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' }
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
function VerticalTitle({ x, y, title, titleEn }: { x: number; y: number; title: string; titleEn: string }) {
  // 切到英文：英文那一竖用深色、中文用浅色（位置不动）
  const en = useLang() === 'en' && !!titleEn;
  // 放大的一档：整块绕中文第一个字的左上角放大（x、y 由各版面另给）
  const k = useBig() ? BIG.row : 1;
  return (
    <ZoomAt x={x} y={y} k={k}>
      {titleEn && (
        <div className="em-en" style={{ ...box(-19.4, 3.4), writingMode: 'vertical-rl', fontSize: 14, lineHeight: '14px', letterSpacing: '0.062em', color: en ? 'var(--em-ink)' : MUTE, whiteSpace: 'nowrap' }}>
          {titleEn}
        </div>
      )}
      {title && (
        <div style={{ ...box(0, 4.7), width: 16, fontSize: 16, lineHeight: '16px', wordBreak: 'break-all', textAlign: 'center', color: en ? MUTE : undefined }} data-testid="emenu-vtitle">
          {title}
        </div>
      )}
    </ZoomAt>
  );
}

type Slot = EmenuDishView | null | undefined;

/** 没配图的菜在有图的版面里：图片位是灰底、压不暗，原因写在价格旁 */
const noteIfNoImage = (dish: EmenuDishView, url: string | null) => !url;

function Cover({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  const title = namePair(ctx.categoryName, ctx.categoryNameEn ?? '', useLang());
  // 英文的大标题按长短收字号：左半边能用的宽度约 480
  const enSize = Math.max(22, Math.min(44, Math.floor(480 / (Math.max(title.main.length, 1) * 0.66))));
  return (
    <>
      {title.mainEn ? (
        <>
          <div className="em-en" style={{ ...box(38.6, 222.5), fontSize: enSize, lineHeight: '44px', whiteSpace: 'nowrap', letterSpacing: '0.04em' }} data-testid="emenu-cover-title">
            {title.main}
          </div>
          <div style={{ ...box(40, 274), fontSize: 15, lineHeight: '15px', color: MUTE, whiteSpace: 'nowrap' }}>{title.sub}</div>
        </>
      ) : (
        <div style={{ ...box(37.4, 218.5), fontSize: 48, lineHeight: '48px', whiteSpace: 'nowrap' }} data-testid="emenu-cover-title">
          {title.main}
        </div>
      )}
      {/* 放大的一档：文字的下沿贴在特写图上面 24（往上长） */}
      {d && <DishText dish={d} x={40} y={344} w={420} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(d, d.imageUrl)} big={{ bottom: 485, w: 429 }} />}
      <Photo url={d?.detailUrl ?? null} x={40} y={509.1} w={429.1} h={218.9} dish={d ?? null} ctx={ctx} label="特写图" />
      <Photo url={d?.imageUrl ?? null} x={555.5} y={133.8} w={428.5} h={594.2} dish={d ?? null} ctx={ctx} label="餐品展示" />
    </>
  );
}

function ListImage({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const first: Slot = page.dishes.find((d) => d);
  const large = useBig();
  const cols = [
    { x: 636.9, plus: 120 },
    { x: 823.8, plus: 142 },
  ];
  const rows = [257.7, 350.9, 443];
  // 放大的一档：小标题与两列往左挪（图右边到页边的空都用上），三行拉开
  const bigCols = [566, 778];
  const bigRows = [256, 392, 528];
  return (
    <>
      <Photo url={first?.imageUrl ?? null} x={40} y={133.8} w={428.5} h={594.2} dish={first ?? null} ctx={ctx} label="餐品展示" />
      <VerticalTitle x={large ? 524 : 577.4} y={large ? 252 : 254} title={page.title} titleEn={page.titleEn} />
      {page.dishes.slice(0, 6).map((d, i) => {
        if (!d) return null;
        const col = cols[i % 2]!;
        return <DishText key={d.id} dish={d} x={col.x} y={rows[Math.floor(i / 2)]!} w={170} ctx={ctx} plusAt={col.plus} noteByPrice big={{ x: bigCols[i % 2]!, y: bigRows[Math.floor(i / 2)]!, w: 206, plusAt: 132 }} />;
      })}
    </>
  );
}

function SingleWide({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  const intro = d ? dishDescription(d, useLang()) : null;
  const large = useBig();
  return (
    <>
      <Photo url={d?.imageUrl ?? null} x={40} y={133.8} w={944} h={359.6} dish={d ?? null} ctx={ctx} label="餐品展示" />
      {d && <DishText dish={d} x={39.7} y={525.8} w={420} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} big={{ y: 522, w: 440 }} />}
      {intro?.text && large && (
        <ZoomAt x={512} y={520} k={BIG.dish}>
          <div
            className={intro.en ? 'em-en' : undefined}
            style={{ width: 337, fontSize: 9.5, lineHeight: '13.5px', letterSpacing: intro.en ? '0.2px' : '0.5px', color: MUTE, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical' }}
          >
            {intro.text}
          </div>
        </ZoomAt>
      )}
      {intro?.text && !large && (
        <div
          className={intro.en ? 'em-en' : undefined}
          style={{ ...box(512, 523.4, 392), fontSize: 9, lineHeight: '13px', letterSpacing: intro.en ? '0.2px' : '0.62px', color: MUTE, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical' }}
        >
          {intro.text}
        </div>
      )}
    </>
  );
}

function SingleLeft({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  return (
    <>
      <Photo url={d?.imageUrl ?? null} x={40} y={133.8} w={428.5} h={594.2} dish={d ?? null} ctx={ctx} label="餐品展示" />
      <Photo url={d?.detailUrl ?? null} x={812.4} y={133.8} w={171.6} h={203.1} dish={d ?? null} ctx={ctx} label="特写图" />
      {d && <DishText dish={d} x={554.9} y={464.5} w={420} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(d, d.imageUrl)} big={{ y: 440, w: 429 }} />}
    </>
  );
}

function SingleRight({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  return (
    <>
      {d && <DishText dish={d} x={210.9} y={275.2} w={330} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(d, d.imageUrl)} big={{ x: 130, y: 250, w: 400 }} />}
      <Photo url={d?.detailUrl ?? null} x={40} y={524.9} w={171.6} h={203.1} dish={d ?? null} ctx={ctx} label="特写图" />
      <Photo url={d?.imageUrl ?? null} x={555.5} y={133.8} w={428.5} h={594.2} dish={d ?? null} ctx={ctx} label="餐品展示" />
    </>
  );
}

function DuoStagger({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const [a, b]: Slot[] = page.dishes;
  return (
    <>
      <Photo url={a?.imageUrl ?? null} x={40} y={133.8} w={429.1} h={296.7} dish={a ?? null} ctx={ctx} label="餐品展示" />
      {a && <DishText dish={a} x={40} y={464.6} w={420} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(a, a.imageUrl)} big={{ y: 458, w: 429 }} />}
      {/* 放大的一档：第二道的文字下沿贴在它的图上面 24（往上长），介绍最多 3 行 */}
      {b && <DishText dish={b} x={640.7} y={182.9} w={343} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(b, b.imageUrl)} big={{ bottom: 313, lines: 3 }} />}
      <Photo url={b?.imageUrl ?? null} x={640.8} y={337} w={343.2} h={391} dish={b ?? null} ctx={ctx} label="餐品展示" />
    </>
  );
}

function DuoRow({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const [a, b]: Slot[] = page.dishes;
  return (
    <>
      <Photo url={a?.imageUrl ?? null} x={40} y={165.1} w={386.2} h={359.6} dish={a ?? null} ctx={ctx} label="餐品展示" />
      <Photo url={b?.imageUrl ?? null} x={426.2} y={165.1} w={557.8} h={359.6} dish={b ?? null} ctx={ctx} label="餐品展示" tint />
      {a && <DishText dish={a} x={39.7} y={557.1} w={370} ctx={ctx} noteByPrice={noteIfNoImage(a, a.imageUrl)} big={{ y: 552 }} />}
      {b && <DishText dish={b} x={426.2} y={557.1} w={420} ctx={ctx} noteByPrice={noteIfNoImage(b, b.imageUrl)} big={{ y: 552, w: 540 }} />}
    </>
  );
}

function DuoMixed({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const [a, b]: Slot[] = page.dishes;
  return (
    <>
      {/* 放大的一档：第一道的文字下沿贴在它的图上面 24（往上长） */}
      {a && <DishText dish={a} x={40} y={256.1} w={420} ctx={ctx} desc="tight" noteByPrice={noteIfNoImage(a, a.imageUrl)} big={{ bottom: 344, w: 540 }} />}
      <Photo url={a?.imageUrl ?? null} x={40} y={368.4} w={557.8} h={359.6} dish={a ?? null} ctx={ctx} label="餐品展示" />
      <Photo url={b?.imageUrl ?? null} x={769.5} y={133.8} w={214.5} h={265.6} dish={b ?? null} ctx={ctx} label="餐品展示" />
      {b && <DishText dish={b} x={769.5} y={431.6} w={214.5} ctx={ctx} desc="tight" noteByPrice={noteIfNoImage(b, b.imageUrl)} big={{ y: 426 }} />}
    </>
  );
}

function TrioRow({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  return (
    <>
      {[125.8, 426.2, 726.5].map((x, i) => {
        const d: Slot = page.dishes[i];
        return (
          <div key={x}>
            <Photo url={d?.imageUrl ?? null} x={x} y={165.1} w={257.6} h={343.9} dish={d ?? null} ctx={ctx} label="餐品展示" />
            {d && <DishText dish={d} x={x} y={542.1} w={257.6} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} big={{ y: 536 }} />}
          </div>
        );
      })}
    </>
  );
}

function TrioMixed({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const spots = [
    { x: 40, w: 386.2, h: 281.6, textY: 447.6 },
    { x: 469.1, w: 300.4, h: 406.4, textY: 572.7 },
    { x: 812.4, w: 171.6, h: 234.4, textY: 401.6 },
  ];
  return (
    <>
      {spots.map((s, i) => {
        const d: Slot = page.dishes[i];
        return (
          <div key={s.x}>
            <Photo url={d?.imageUrl ?? null} x={s.x} y={133.8} w={s.w} h={s.h} dish={d ?? null} ctx={ctx} label="餐品展示" />
            {d && <DishText dish={d} x={s.x} y={s.textY} w={s.w} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} big={{ y: s.textY - 6 }} />}
          </div>
        );
      })}
    </>
  );
}

/**
 * 文字陈列的一行：名称、英文名、属性行在左，价格在右上，加号在价格下面（各处离名称文字框左上角的距离是设计稿量的）。
 * 切到英文（8.0.13）：英文名为主、放不下折成两行，下面依次是中文名、属性行（一行行往下排，不压在一起）。
 */
function TextRow({ dish, x, y, ctx }: { dish: EmenuDishView; x: number; y: number; ctx: PageCtx }) {
  const lang = useLang();
  const block = dishBlock(dish, ctx.open);
  const spec = displaySpec(dish);
  const name = dishNames(dish, lang);
  const attrs = dishAttrs(dish, lang);
  const why = block ? blockLabel(block, lang) : null;
  const clickable = !ctx.preview && !!ctx.onOpen;
  const open = clickable ? (e: { currentTarget: Element }) => ctx.onOpen!(dish, designPoint(e.currentTarget)) : undefined;
  // 放大的一档：这一行整块放大（x、y 由 ListText 另给）
  const k = useBig() ? BIG.row : 1;
  return (
    <div style={{ ...box(x, y, 232 * k, 74 * k), opacity: block ? 0.5 : 1 }} data-testid={`emenu-dish-${dish.id}`} data-block={block ?? undefined}>
     <div className={ctx.flashId === dish.id ? 'em-flash' : undefined} style={{ ...box(0, 0, 232, 74), transform: k === 1 ? undefined : `scale(${k})`, transformOrigin: '0 0' }}>
      {name.mainEn ? (
        <div style={{ width: 186 }}>
          <div
            role={clickable ? 'button' : undefined}
            onClick={open}
            className={`em-en${clickable ? ' em-press' : ''}`}
            style={{ fontSize: 13, lineHeight: '15px', cursor: clickable ? 'pointer' : undefined, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            data-testid={`emenu-name-${dish.id}`}
          >
            {name.main}
            <Tagline dish={dish} />
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
          <div role={clickable ? 'button' : undefined} onClick={open} className={`em-clip${clickable ? ' em-press' : ''}`} style={{ fontSize: 16, lineHeight: '16px', width: 186, cursor: clickable ? 'pointer' : undefined }} data-testid={`emenu-name-${dish.id}`}>
            {name.main}
            <Tagline dish={dish} />
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
      <PlusButton dish={dish} ctx={ctx} block={block} style={{ position: 'absolute', left: 206.3, top: 37.2 }} />
     </div>
    </div>
  );
}

/** 文字陈列 5 行的名称上沿（设计稿行距不是整数：89.6–90） */
const TEXT_ROWS = [174.6, 264.2, 354.1, 444, 534];

function ListText({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const large = useBig();
  // 放大的一档：小标题与两列往左挪（左边原来空着的一大块用上），5 行的间隔从 90 拉到 112
  const at = (i: number) => (large ? { x: i % 2 === 0 ? 296 : 660, y: 150 + Math.floor(i / 2) * 112 } : { x: i % 2 === 0 ? 403.7 : 755.1, y: TEXT_ROWS[Math.floor(i / 2)]! });
  return (
    <>
      <VerticalTitle x={large ? 236 : 307.8} y={large ? 156 : 169.9} title={page.title} titleEn={page.titleEn} />
      {page.dishes.slice(0, 10).map((d, i) => (d ? <TextRow key={d.id} dish={d} x={at(i).x} y={at(i).y} ctx={ctx} /> : null))}
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
