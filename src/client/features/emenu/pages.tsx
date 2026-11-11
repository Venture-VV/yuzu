// 菜单页的 11 种版面（docs/EMENU.md 第 5 节）：位置、字号、颜色照设计师的《点餐系统版面模板-26.11.11》逐屏量的，
// 坐标按 1024×768 整页算（顶栏占最上面 102）。平板点餐页与后台的版面预览用的是同一份。

import type { CSSProperties, ReactNode } from 'react';
import { dishBlock, EMENU_BLOCK_LABELS, type EmenuBlock, type EmenuDishView, type EmenuPageView, type EmenuSpecView } from '@shared/emenu';
import { PlusDot } from './icons';
import { box } from './stage';

export interface PageCtx {
  /** 这一页所在的分类：封面用它的名字；不在供应时段时整页的菜都标「当前时段不可售」 */
  categoryName: string;
  open: boolean;
  /** 后台预览：没配图的位置写上「餐品展示」「特写图」，不能点 */
  preview?: boolean;
  onOpen?: (dish: EmenuDishView) => void;
  onAdd?: (dish: EmenuDishView) => void;
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

/** ¥42/份（设计稿：¥ 8 号、数字 14 号、斜杠 10 号、单位 7.5 号，同一条基线；¥ 占 4.9 宽、数字从 ¥ 的左边往右 6.6 开始） */
export function Price({ cents, unit, scale = 1, style }: { cents: number; unit: string; scale?: number; style?: CSSProperties }) {
  return (
    <span className="em-en" style={{ display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap', ...style }}>
      <span style={{ fontSize: 8 * scale, width: 4.9 * scale, marginRight: 1.7 * scale, flex: 'none' }}>¥</span>
      <span style={{ fontSize: 14 * scale, lineHeight: `${14 * scale}px` }}>{yuan(cents)}</span>
      <span style={{ fontFamily: 'var(--em-zh)', fontSize: 10.05 * scale, letterSpacing: 0 }}>/</span>
      <span style={{ fontFamily: 'var(--em-zh)', fontSize: 7.54 * scale, letterSpacing: 0 }}>{unit}</span>
    </span>
  );
}

/** 加号：图标只有 12.6 大，点按区域放到 44 */
export function PlusButton({ dish, ctx, block, style }: { dish: EmenuDishView; ctx: PageCtx; block: EmenuBlock | null; style?: CSSProperties }) {
  const disabled = !!block || ctx.preview;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        ctx.onAdd?.(dish);
      }}
      aria-label={`把${dish.name}加进未下单`}
      style={{ position: 'relative', width: 12.6, height: 12.6, padding: 0, border: 0, background: 'none', flex: 'none', ...style }}
      data-testid={`emenu-add-${dish.id}`}
    >
      <span style={{ position: 'absolute', inset: -15.7 }} />
      <PlusDot muted={!!block} />
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
  const block = dish ? dishBlock(dish, ctx.open) : null;
  const clickable = !!dish && !ctx.preview && !!ctx.onOpen;
  return (
    <div
      role={clickable ? 'button' : undefined}
      onClick={clickable ? () => ctx.onOpen!(dish!) : undefined}
      style={{ ...box(x, y, w, h), background: tint ? '#e2e2e2' : 'var(--em-photo)', overflow: 'hidden', cursor: clickable ? 'pointer' : undefined }}
      data-testid={dish ? `emenu-photo-${dish.id}` : undefined}
    >
      {url ? (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        ctx.preview && (
          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>{label}</span>
        )
      )}
      {block && url && (
        <span
          style={{ position: 'absolute', inset: 0, background: 'rgb(0 0 0 / 0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#f4f3f2' }}
          data-testid={`emenu-block-${dish!.id}`}
        >
          <span style={{ fontSize: 16, lineHeight: '16px' }}>{EMENU_BLOCK_LABELS[block].zh}</span>
          <span className="em-en" style={{ fontSize: 8, lineHeight: '8px', marginTop: 0.7 }}>
            {EMENU_BLOCK_LABELS[block].en}
          </span>
        </span>
      )}
    </div>
  );
}

/** 没有图压暗的地方（文字版面、没配图的菜）：价格旁写一行小字 */
function BlockNote({ block }: { block: EmenuBlock }) {
  return <span style={{ fontSize: 9, color: MUTE, marginLeft: 8, whiteSpace: 'nowrap' }}>{EMENU_BLOCK_LABELS[block].zh}</span>;
}

/**
 * 一道菜的文字：菜名（后面可以带小字）、加号、英文名、介绍、价格。
 * 设计稿每一版里这几行离菜名文字框上沿的距离都一样：英文名 16.7；介绍 51.4（tight 是 35.7，「两个菜」一大一小那一版），
 * 每行 13；价格（14 号的数字）在介绍最后一行下面 23.6，没有介绍时在 37.4；加号比菜名高 0.9、跟在菜名后面隔 44.2。
 * desc：normal / tight 见上；none 不要介绍。plusAt：加号放在离左边多远（列表里按列对齐）。
 */
export function DishText({
  dish,
  x,
  y,
  w,
  ctx,
  desc = 'none',
  plusAt,
  noteByPrice,
}: {
  dish: EmenuDishView;
  x: number;
  y: number;
  w: number;
  ctx: PageCtx;
  desc?: 'normal' | 'tight' | 'none';
  plusAt?: number;
  /** 这道菜在这一页没有图可以压暗：不能点的原因写在价格旁 */
  noteByPrice?: boolean;
}) {
  const block = dishBlock(dish, ctx.open);
  const spec = displaySpec(dish);
  const showDesc = desc !== 'none' && !!dish.description;
  const clickable = !ctx.preview && !!ctx.onOpen;
  return (
    <div
      className={ctx.flashId === dish.id ? 'em-flash' : undefined}
      style={{ ...box(x, y, w), opacity: block && noteByPrice ? 0.5 : 1 }}
      data-testid={`emenu-dish-${dish.id}`}
      data-block={block ?? undefined}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', minHeight: 16, position: 'relative' }}>
        <span
          role={clickable ? 'button' : undefined}
          onClick={clickable ? () => ctx.onOpen!(dish) : undefined}
          style={{ fontSize: 16, lineHeight: '16px', minWidth: 0, cursor: clickable ? 'pointer' : undefined, maxWidth: plusAt === undefined ? w - 58 : plusAt - 8 }}
        >
          {dish.name}
          {dish.tagline && <span style={{ fontSize: 10, lineHeight: 0, color: MUTE }}>{wrapParen(dish.tagline)}</span>}
        </span>
        <PlusButton dish={dish} ctx={ctx} block={block} style={plusAt === undefined ? { marginLeft: 44.2, marginTop: -0.9 } : { position: 'absolute', left: plusAt, top: -0.9 }} />
      </div>
      {dish.nameEn && (
        <div className="em-en em-clip" style={{ fontSize: 8, lineHeight: '8px', marginTop: 0.7, color: MUTE }}>
          {dish.nameEn}
        </div>
      )}
      {showDesc && (
        <div style={{ fontSize: 9, lineHeight: '13px', letterSpacing: '0.62px', color: MUTE, marginTop: (desc === 'tight' ? 9 : 24.7) + (dish.nameEn ? 0 : 8.7), maxWidth: 262, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' }}>
          {dish.description}
        </div>
      )}
      {spec && (
        <div style={{ marginTop: showDesc ? 23.6 : 12.7 + (dish.nameEn ? 0 : 8.7), display: 'flex', alignItems: 'baseline' }}>
          <Price cents={spec.price} unit={dish.unit} />
          {block && noteByPrice && <BlockNote block={block} />}
        </div>
      )}
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
  return (
    <>
      {titleEn && (
        <div className="em-en" style={{ ...box(x - 19.4, y + 3.4), writingMode: 'vertical-rl', fontSize: 14, lineHeight: '14px', letterSpacing: '0.062em', color: MUTE, whiteSpace: 'nowrap' }}>
          {titleEn}
        </div>
      )}
      {title && (
        <div style={{ ...box(x, y + 4.7), width: 16, fontSize: 16, lineHeight: '16px', wordBreak: 'break-all', textAlign: 'center' }} data-testid="emenu-vtitle">
          {title}
        </div>
      )}
    </>
  );
}

type Slot = EmenuDishView | null | undefined;

/** 没配图的菜在有图的版面里：图片位是灰底、压不暗，原因写在价格旁 */
const noteIfNoImage = (dish: EmenuDishView, url: string | null) => !url;

function Cover({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  return (
    <>
      <div style={{ ...box(37.4, 218.5), fontSize: 48, lineHeight: '48px', whiteSpace: 'nowrap' }} data-testid="emenu-cover-title">
        {ctx.categoryName}
      </div>
      {d && <DishText dish={d} x={40} y={344} w={420} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
      <Photo url={d?.detailUrl ?? null} x={40} y={509.1} w={429.1} h={218.9} dish={d ?? null} ctx={ctx} label="特写图" />
      <Photo url={d?.imageUrl ?? null} x={555.5} y={133.8} w={428.5} h={594.2} dish={d ?? null} ctx={ctx} label="餐品展示" />
    </>
  );
}

function ListImage({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const first: Slot = page.dishes.find((d) => d);
  const cols = [
    { x: 636.9, plus: 120 },
    { x: 823.8, plus: 142 },
  ];
  const rows = [257.7, 350.9, 443];
  return (
    <>
      <Photo url={first?.imageUrl ?? null} x={40} y={133.8} w={428.5} h={594.2} dish={first ?? null} ctx={ctx} label="餐品展示" />
      <VerticalTitle x={577.4} y={254} title={page.title} titleEn={page.titleEn} />
      {page.dishes.slice(0, 6).map((d, i) => {
        if (!d) return null;
        const col = cols[i % 2]!;
        return <DishText key={d.id} dish={d} x={col.x} y={rows[Math.floor(i / 2)]!} w={170} ctx={ctx} plusAt={col.plus} noteByPrice />;
      })}
    </>
  );
}

function SingleWide({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  return (
    <>
      <Photo url={d?.imageUrl ?? null} x={40} y={133.8} w={944} h={359.6} dish={d ?? null} ctx={ctx} label="餐品展示" />
      {d && <DishText dish={d} x={39.7} y={525.8} w={420} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
      {d?.description && (
        <div style={{ ...box(512, 523.4, 392), fontSize: 9, lineHeight: '13px', letterSpacing: '0.62px', color: MUTE, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical' }}>
          {d.description}
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
      {d && <DishText dish={d} x={554.9} y={464.5} w={420} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
    </>
  );
}

function SingleRight({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  return (
    <>
      {d && <DishText dish={d} x={210.9} y={275.2} w={330} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
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
      {a && <DishText dish={a} x={40} y={464.6} w={420} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(a, a.imageUrl)} />}
      {b && <DishText dish={b} x={640.7} y={182.9} w={343} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(b, b.imageUrl)} />}
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
      {a && <DishText dish={a} x={39.7} y={557.1} w={370} ctx={ctx} noteByPrice={noteIfNoImage(a, a.imageUrl)} />}
      {b && <DishText dish={b} x={426.2} y={557.1} w={420} ctx={ctx} noteByPrice={noteIfNoImage(b, b.imageUrl)} />}
    </>
  );
}

function DuoMixed({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const [a, b]: Slot[] = page.dishes;
  return (
    <>
      {a && <DishText dish={a} x={40} y={256.1} w={420} ctx={ctx} desc="tight" noteByPrice={noteIfNoImage(a, a.imageUrl)} />}
      <Photo url={a?.imageUrl ?? null} x={40} y={368.4} w={557.8} h={359.6} dish={a ?? null} ctx={ctx} label="餐品展示" />
      <Photo url={b?.imageUrl ?? null} x={769.5} y={133.8} w={214.5} h={265.6} dish={b ?? null} ctx={ctx} label="餐品展示" />
      {b && <DishText dish={b} x={769.5} y={431.6} w={214.5} ctx={ctx} desc="tight" noteByPrice={noteIfNoImage(b, b.imageUrl)} />}
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
            {d && <DishText dish={d} x={x} y={542.1} w={257.6} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
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
            {d && <DishText dish={d} x={s.x} y={s.textY} w={s.w} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
          </div>
        );
      })}
    </>
  );
}

/** 文字陈列的一行：名称、英文名、属性行在左，价格在右上，加号在价格下面（各处离名称文字框左上角的距离是设计稿量的） */
function TextRow({ dish, x, y, ctx }: { dish: EmenuDishView; x: number; y: number; ctx: PageCtx }) {
  const block = dishBlock(dish, ctx.open);
  const spec = displaySpec(dish);
  const clickable = !ctx.preview && !!ctx.onOpen;
  return (
    <div className={ctx.flashId === dish.id ? 'em-flash' : undefined} style={{ ...box(x, y, 232, 74), opacity: block ? 0.5 : 1 }} data-testid={`emenu-dish-${dish.id}`} data-block={block ?? undefined}>
      <div
        role={clickable ? 'button' : undefined}
        onClick={clickable ? () => ctx.onOpen!(dish) : undefined}
        className="em-clip"
        style={{ fontSize: 16, lineHeight: '16px', width: 186, cursor: clickable ? 'pointer' : undefined }}
      >
        {dish.name}
        {dish.tagline && <span style={{ fontSize: 10, lineHeight: 0, color: MUTE }}>{wrapParen(dish.tagline)}</span>}
      </div>
      {dish.nameEn && (
        <div className="em-en em-clip" style={{ ...box(1, 16.7, 186), fontSize: 8, lineHeight: '8px', color: MUTE }}>
          {dish.nameEn}
        </div>
      )}
      {/* 属性行：第一行的文字框在名称上沿往下 34.3，每行隔 10.8（行高等于字号、行与行之间用外边距隔开，各家浏览器位置一样） */}
      <div style={{ ...box(1, 34.3, 186), fontSize: 9, lineHeight: '9px', color: MUTE }}>
        {dish.attrs.map((a) => (
          <div key={a} className="em-clip" style={{ marginBottom: 1.8 }}>
            {a}
          </div>
        ))}
        {block && <div>{EMENU_BLOCK_LABELS[block].zh}</div>}
      </div>
      {spec && <Price cents={spec.price} unit={dish.unit} style={{ ...box(196.2, 0.6) }} />}
      <PlusButton dish={dish} ctx={ctx} block={block} style={{ position: 'absolute', left: 206.3, top: 37.2 }} />
    </div>
  );
}

/** 文字陈列 5 行的名称上沿（设计稿行距不是整数：89.6–90） */
const TEXT_ROWS = [174.6, 264.2, 354.1, 444, 534];

function ListText({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  return (
    <>
      <VerticalTitle x={307.8} y={169.9} title={page.title} titleEn={page.titleEn} />
      {page.dishes.slice(0, 10).map((d, i) => (d ? <TextRow key={d.id} dish={d} x={i % 2 === 0 ? 403.7 : 755.1} y={TEXT_ROWS[Math.floor(i / 2)]!} ctx={ctx} /> : null))}
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
