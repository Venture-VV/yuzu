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

/** ¥42/份（设计稿：¥ 8 号、数字 14 号、斜杠 10 号、单位 7.5 号，底边对齐） */
export function Price({ cents, unit, scale = 1, style }: { cents: number; unit: string; scale?: number; style?: CSSProperties }) {
  return (
    <span className="em-en" style={{ display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap', ...style }}>
      <span style={{ fontSize: 8 * scale, marginRight: 1.7 * scale }}>¥</span>
      <span style={{ fontSize: 14 * scale, lineHeight: `${14 * scale}px` }}>{yuan(cents)}</span>
      <span style={{ fontFamily: 'var(--em-zh)', fontSize: 10 * scale }}>/</span>
      <span style={{ fontFamily: 'var(--em-zh)', fontSize: 7.5 * scale }}>{unit}</span>
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
          <span className="em-en" style={{ fontSize: 8, lineHeight: '9px', marginTop: 1.4 }}>
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
 * desc：normal 介绍在菜名下 51；tight 在菜名下 36（设计稿「两个菜」一大一小那一版）；none 不要介绍、价格紧跟英文名。
 * plusAt：加号放在离左边多远（列表里按列对齐）；不给就跟在菜名后面、隔 44。
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
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 16, position: 'relative' }}>
        <span
          role={clickable ? 'button' : undefined}
          onClick={clickable ? () => ctx.onOpen!(dish) : undefined}
          style={{ fontSize: 16, lineHeight: '16px', minWidth: 0, cursor: clickable ? 'pointer' : undefined, maxWidth: plusAt === undefined ? w - 58 : plusAt - 8 }}
        >
          {dish.name}
          {dish.tagline && <span style={{ fontSize: 10, color: MUTE }}>{wrapParen(dish.tagline)}</span>}
        </span>
        <PlusButton dish={dish} ctx={ctx} block={block} style={plusAt === undefined ? { marginLeft: 44 } : { position: 'absolute', left: plusAt, top: 1.2 }} />
      </div>
      {dish.nameEn && (
        <div className="em-en" style={{ fontSize: 8, lineHeight: '9px', marginTop: 0.4, color: MUTE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {dish.nameEn}
        </div>
      )}
      {showDesc && (
        <div style={{ fontSize: 9, lineHeight: '13px', letterSpacing: '0.25px', color: MUTE, marginTop: (desc === 'tight' ? 8 : 23.4) + (dish.nameEn ? 0 : 9.4), maxWidth: 262, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' }}>
          {dish.description}
        </div>
      )}
      {spec && (
        <div style={{ marginTop: showDesc ? 23.6 : 11.8 + (dish.nameEn ? 0 : 9.4), display: 'flex', alignItems: 'baseline' }}>
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

/** 竖排小标题：中文一字一行，英文转 90 度（精品推荐 BEST SELLERS / 酒水 BEVERAGE） */
function VerticalTitle({ x, y, title, titleEn }: { x: number; y: number; title: string; titleEn: string }) {
  return (
    <>
      {titleEn && (
        <div className="em-en" style={{ ...box(x - 19.5, y + 2), writingMode: 'vertical-rl', fontSize: 9, letterSpacing: '0.2px', color: MUTE, whiteSpace: 'nowrap', lineHeight: '14px' }}>
          {titleEn}
        </div>
      )}
      {title && (
        <div style={{ ...box(x, y), width: 16, fontSize: 16, lineHeight: '16px', wordBreak: 'break-all', textAlign: 'center' }} data-testid="emenu-vtitle">
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
    { x: 637, plus: 120 },
    { x: 824, plus: 141 },
  ];
  return (
    <>
      <Photo url={first?.imageUrl ?? null} x={40} y={133.8} w={428.5} h={594.2} dish={first ?? null} ctx={ctx} label="餐品展示" />
      <VerticalTitle x={577} y={254} title={page.title} titleEn={page.titleEn} />
      {page.dishes.slice(0, 6).map((d, i) => {
        if (!d) return null;
        const col = cols[i % 2]!;
        return <DishText key={d.id} dish={d} x={col.x} y={258 + Math.floor(i / 2) * 92.6} w={170} ctx={ctx} plusAt={col.plus} noteByPrice />;
      })}
    </>
  );
}

function SingleWide({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  return (
    <>
      <Photo url={d?.imageUrl ?? null} x={40} y={133.8} w={944} h={359.6} dish={d ?? null} ctx={ctx} label="餐品展示" />
      {d && <DishText dish={d} x={40} y={526} w={420} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
      {d?.description && (
        <div style={{ ...box(512, 523.4, 392), fontSize: 9, lineHeight: '13px', letterSpacing: '0.25px', color: MUTE, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical' }}>
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
      {d && <DishText dish={d} x={555} y={464.3} w={420} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
    </>
  );
}

function SingleRight({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const d: Slot = page.dishes[0];
  return (
    <>
      {d && <DishText dish={d} x={211.6} y={275} w={330} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
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
      {a && <DishText dish={a} x={40} y={464.7} w={420} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(a, a.imageUrl)} />}
      {b && <DishText dish={b} x={641} y={183} w={343} ctx={ctx} desc="normal" noteByPrice={noteIfNoImage(b, b.imageUrl)} />}
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
      {a && <DishText dish={a} x={40} y={556.8} w={370} ctx={ctx} noteByPrice={noteIfNoImage(a, a.imageUrl)} />}
      {b && <DishText dish={b} x={426.2} y={556.8} w={420} ctx={ctx} noteByPrice={noteIfNoImage(b, b.imageUrl)} />}
    </>
  );
}

function DuoMixed({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const [a, b]: Slot[] = page.dishes;
  return (
    <>
      {a && <DishText dish={a} x={40} y={256} w={420} ctx={ctx} desc="tight" noteByPrice={noteIfNoImage(a, a.imageUrl)} />}
      <Photo url={a?.imageUrl ?? null} x={40} y={368.4} w={557.8} h={359.6} dish={a ?? null} ctx={ctx} label="餐品展示" />
      <Photo url={b?.imageUrl ?? null} x={769.5} y={133.8} w={214.5} h={265.6} dish={b ?? null} ctx={ctx} label="餐品展示" />
      {b && <DishText dish={b} x={769.5} y={431.6} w={214.5} ctx={ctx} desc="tight" noteByPrice={noteIfNoImage(b, b.imageUrl)} />}
    </>
  );
}

function TrioRow({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  return (
    <>
      {[126, 426.2, 726.4].map((x, i) => {
        const d: Slot = page.dishes[i];
        return (
          <div key={x}>
            <Photo url={d?.imageUrl ?? null} x={x} y={165.1} w={257.6} h={343.9} dish={d ?? null} ctx={ctx} label="餐品展示" />
            {d && <DishText dish={d} x={x} y={541.5} w={257.6} ctx={ctx} noteByPrice={noteIfNoImage(d, d.imageUrl)} />}
          </div>
        );
      })}
    </>
  );
}

function TrioMixed({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  const spots = [
    { x: 40, w: 386.2, h: 281.6, textY: 447.7 },
    { x: 469.1, w: 300.4, h: 406.4, textY: 572.6 },
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

/** 文字陈列的一行：名称、英文名、属性行在左，价格在右上，加号在价格下面 */
function TextRow({ dish, x, y, ctx }: { dish: EmenuDishView; x: number; y: number; ctx: PageCtx }) {
  const block = dishBlock(dish, ctx.open);
  const spec = displaySpec(dish);
  const clickable = !ctx.preview && !!ctx.onOpen;
  return (
    <div className={ctx.flashId === dish.id ? 'em-flash' : undefined} style={{ ...box(x, y, 232, 74), opacity: block ? 0.5 : 1 }} data-testid={`emenu-dish-${dish.id}`} data-block={block ?? undefined}>
      <div
        role={clickable ? 'button' : undefined}
        onClick={clickable ? () => ctx.onOpen!(dish) : undefined}
        style={{ fontSize: 16, lineHeight: '16px', width: 186, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: clickable ? 'pointer' : undefined }}
      >
        {dish.name}
        {dish.tagline && <span style={{ fontSize: 10, color: MUTE }}>{wrapParen(dish.tagline)}</span>}
      </div>
      {dish.nameEn && (
        <div className="em-en" style={{ ...box(0.8, 16.4, 186), fontSize: 8, lineHeight: '9px', color: MUTE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {dish.nameEn}
        </div>
      )}
      <div style={{ ...box(0.8, 33, 186), fontSize: 9, lineHeight: '11px', color: MUTE }}>
        {dish.attrs.map((a) => (
          <div key={a} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {a}
          </div>
        ))}
        {block && <div>{EMENU_BLOCK_LABELS[block].zh}</div>}
      </div>
      {spec && <Price cents={spec.price} unit={dish.unit} style={{ ...box(196, 0) }} />}
      <PlusButton dish={dish} ctx={ctx} block={block} style={{ position: 'absolute', left: 206, top: 36.6 }} />
    </div>
  );
}

function ListText({ page, ctx }: { page: EmenuPageView; ctx: PageCtx }) {
  return (
    <>
      <VerticalTitle x={307.6} y={170} title={page.title} titleEn={page.titleEn} />
      {page.dishes.slice(0, 10).map((d, i) => (d ? <TextRow key={d.id} dish={d} x={i % 2 === 0 ? 404 : 755} y={174.5 + Math.floor(i / 2) * 89.7} ctx={ctx} /> : null))}
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
