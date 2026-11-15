// UI 工作台里改卡片模板的两栏（8.1.2，GZ13）：左边「版式」列出菜单页的 11 种版式与每种里面的各块，右边是选中那一块的
// 位置、大小、藏起来、照片圆角与「恢复默认」。傻瓜：一块改了以后用这种版式的每一页都跟着变；改坏了点「恢复默认」。

import { RotateCcw } from 'lucide-react';
import { EMENU_LAYOUT_INFO, EMENU_LAYOUTS, type EmenuLayout, type EmenuMenu } from '@shared/emenu';
import {
  DISH_STATE_DEFAULT,
  DISH_STATE_LABELS,
  DISH_STATES,
  dishStateStyle,
  EMENU_SURFACE,
  EMENU_TEMPLATES,
  resetLayoutTemplate,
  resetSlot,
  resolveSlot,
  setDishState,
  setSlotFlags,
  setSlotSpot,
  slotHideable,
  slotResizable,
  slotSpot,
  type EmenuSlotKind,
  type StudioDishState,
  type StudioDishStateStyle,
  type StudioDoc,
} from '@shared/studio';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui';
import { ColorField, NumberInput, PanelTitle, Row } from './panels';
import { round1 } from './model';
import { pagesWithLayout } from './templateModel';

type Change = (fn: (d: StudioDoc) => StudioDoc, coalesce?: string) => void;

const KIND_LABELS: Record<EmenuSlotKind, string> = { photo: '图', text: '文字', title: '小标题', coverTitle: '大标题', intro: '介绍', row: '一行' };

/** 这种版式里改过几块 */
export const changedSlots = (doc: StudioDoc, layout: string) => Object.keys(doc.templates?.[layout] ?? {}).length;

export function TemplatesPanel({
  doc,
  menu,
  layout,
  onLayout,
  slot,
  onSlot,
  state,
  onState,
  onChange,
}: {
  doc: StudioDoc;
  menu: EmenuMenu | null;
  layout: EmenuLayout;
  onLayout: (l: EmenuLayout) => void;
  slot: string | null;
  onSlot: (key: string | null) => void;
  /** 在改菜的哪种状态（变体）；选了就不选块 */
  state: StudioDishState | null;
  onState: (s: StudioDishState | null) => void;
  onChange: Change;
}) {
  const overrides = doc.templates?.[layout] ?? {};
  const changed = changedSlots(doc, layout);
  return (
    <div className="space-y-4" data-testid="studio-templates">
      <p className="text-[12px] leading-relaxed text-ink-3">
        菜单页的 11 种版式：每一种里面照片、菜名价格、小标题放在哪、多大。改了以后用这种版式的每一页都跟着变；哪一页用哪种版式在后台「电子菜单」里排。
      </p>
      <div>
        <PanelTitle>版式</PanelTitle>
        <div className="space-y-0.5">
          {EMENU_LAYOUTS.map((l) => {
            const n = changedSlots(doc, l);
            const used = pagesWithLayout(menu, l).length;
            return (
              <button
                key={l}
                type="button"
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]', l === layout ? 'bg-pine-tint text-pine' : 'text-ink-2 hover:bg-paper-2')}
                onClick={() => {
                  onLayout(l);
                  onSlot(null);
                }}
                data-testid={`studio-layout-${l}`}
              >
                <span className="min-w-0 flex-1 truncate">{EMENU_LAYOUT_INFO[l].label}</span>
                {n > 0 && <span className="shrink-0 rounded bg-yuzu-soft px-1 text-[10.5px] text-yuzu-deep">改过 {n} 块</span>}
                <span className={cn('shrink-0 text-[11px]', used ? 'text-ink-3' : 'text-ink-3/50')} title="菜单里用这种版式的页数">
                  {used} 页
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <PanelTitle
          aside={
            changed > 0 && (
              <button
                type="button"
                className="flex items-center gap-1 text-[11.5px] text-ink-3 hover:text-clay"
                onClick={() => {
                  if (window.confirm(`「${EMENU_LAYOUT_INFO[layout].label}」里改过的 ${changed} 块都恢复成设计稿的样子？（可以撤销）`)) onChange((d) => resetLayoutTemplate(d, layout));
                }}
                data-testid="studio-layout-reset"
              >
                <RotateCcw className="size-3" /> 整个版式恢复默认
              </button>
            )
          }
        >
          这种版式里的各块
        </PanelTitle>
        <p className="mb-1.5 text-[11.5px] text-ink-3">{EMENU_LAYOUT_INFO[layout].hint}</p>
        <div className="space-y-0.5">
          {EMENU_TEMPLATES[layout].slots.map((def) => {
            const o = overrides[def.key];
            return (
              <button
                key={def.key}
                type="button"
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px]', slot === def.key ? 'bg-[#2f7cf6]/10 text-[#2f7cf6]' : 'text-ink-2 hover:bg-paper-2')}
                onClick={() => {
                  onState(null);
                  onSlot(def.key);
                }}
                data-testid={`studio-slot-item-${def.key}`}
              >
                <span className="w-9 shrink-0 text-[10.5px] text-ink-3">{KIND_LABELS[def.kind]}</span>
                <span className={cn('min-w-0 flex-1 truncate', o?.hidden && 'line-through opacity-60')}>{def.label}</span>
                {o?.hidden && <span className="shrink-0 text-[10.5px] text-ink-3">藏起来了</span>}
                {o && !o.hidden && <span className="size-1.5 shrink-0 rounded-full bg-yuzu" title="改过" />}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <PanelTitle>菜的几种样子（变体）</PanelTitle>
        <p className="mb-1.5 text-[11.5px] text-ink-3">卖完了、不在供应时段、下架了的菜在菜单页上怎么显示（所有版式通用）。选一种，画布上这一页的菜都变成这个样子。</p>
        <div className="space-y-0.5">
          {DISH_STATES.map((k) => (
            <button
              key={k}
              type="button"
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px]', state === k ? 'bg-[#2f7cf6]/10 text-[#2f7cf6]' : 'text-ink-2 hover:bg-paper-2')}
              onClick={() => {
                onSlot(null);
                onState(state === k ? null : k);
              }}
              data-testid={`studio-state-${k}`}
            >
              <span className="min-w-0 flex-1 truncate">{DISH_STATE_LABELS[k]}</span>
              {doc.dishStates?.[k] && <span className="size-1.5 shrink-0 rounded-full bg-yuzu" title="改过" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const STYLE_LABELS: Record<NonNullable<StudioDishStateStyle['style']>, string> = { center: '居中写字', badge: '角上小标签', dim: '只压暗' };
const seg = (on: boolean) => cn('h-7 flex-1 rounded border text-[12px]', on ? 'border-pine bg-pine-tint text-pine' : 'border-line text-ink-2');

/** 菜的一种状态（变体）的样子：照片上怎么写、压暗的颜色与深浅、字的颜色、没有图时文字变浅到多少、照片变灰 */
export function DishStatePanel({ doc, state, onChange }: { doc: StudioDoc; state: StudioDishState; onChange: Change }) {
  const st = dishStateStyle(doc.dishStates, state);
  const changed = !!doc.dishStates?.[state];
  const set = (patch: StudioDishStateStyle, field: string) => onChange((d) => setDishState(d, state, patch), `state.${state}.${field}`);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="space-y-4" data-testid="studio-state-panel">
      <div>
        <PanelTitle>{DISH_STATE_LABELS[state]}</PanelTitle>
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          {state === 'sold_out' ? '厨房估清、今天卖完了的菜。' : state === 'closed' ? '分类不在供应时段时，这一页的菜都是这个样子。' : '后台下架了、还排在页上的菜。'}
          所有版式通用；客人点不了，点了会说明原因。
        </p>
      </div>
      <div className="space-y-2">
        <PanelTitle>照片上</PanelTitle>
        <div className="flex gap-1">
          {(['center', 'badge', 'dim'] as const).map((k) => (
            <button key={k} type="button" className={seg(st.style === k)} onClick={() => set({ style: k }, 'style')} data-testid={`studio-state-style-${k}`}>
              {STYLE_LABELS[k]}
            </button>
          ))}
        </div>
        <Row label="压暗颜色">
          <ColorField value={st.shade} onChange={(v) => v && set({ shade: v }, 'shade')} surface={EMENU_SURFACE} doc={doc} testId="studio-state-shade" />
        </Row>
        <Row label="压暗多少">
          <input
            type="range"
            min={0}
            max={0.9}
            step={0.05}
            value={st.shadeOpacity}
            onChange={(e) => set({ shadeOpacity: Number(e.target.value) }, 'shadeOpacity')}
            className="min-w-0 flex-1 accent-[var(--color-pine)]"
            data-testid="studio-state-shade-opacity"
          />
          <span className="w-10 text-right text-[12px] tabular-nums text-ink-3">{pct(st.shadeOpacity)}</span>
        </Row>
        {st.style !== 'dim' && (
          <Row label="字的颜色">
            <ColorField value={st.textColor} onChange={(v) => v && set({ textColor: v }, 'textColor')} surface={EMENU_SURFACE} doc={doc} testId="studio-state-text" />
          </Row>
        )}
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <input type="checkbox" checked={st.grayscale} onChange={(e) => set({ grayscale: e.target.checked }, 'grayscale')} data-testid="studio-state-gray" />
          照片变成黑白
        </label>
      </div>
      <div className="space-y-2">
        <PanelTitle>没有图的菜</PanelTitle>
        <Row label="文字浅到">
          <input
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={st.textOpacity}
            onChange={(e) => set({ textOpacity: Number(e.target.value) }, 'textOpacity')}
            className="min-w-0 flex-1 accent-[var(--color-pine)]"
            data-testid="studio-state-text-opacity"
          />
          <span className="w-10 text-right text-[12px] tabular-nums text-ink-3">{pct(st.textOpacity)}</span>
        </Row>
        <p className="text-[11px] leading-relaxed text-ink-3">文字陈列、没配图的菜：菜名价格那一块变浅，价格旁写原因。</p>
      </div>
      <Button size="sm" variant="secondary" disabled={!changed} onClick={() => onChange((d) => setDishState(d, state, { ...DISH_STATE_DEFAULT }))} data-testid="studio-state-reset">
        <RotateCcw className="size-3.5" /> 恢复设计稿的样子
      </Button>
    </div>
  );
}

export function SlotPanel({ doc, layout, slot, big, onToggleBig, onChange }: { doc: StudioDoc; layout: EmenuLayout; slot: string | null; big: boolean; onToggleBig: () => void; onChange: Change }) {
  const mode = big ? 'big' : 'design';
  const modeName = big ? '放大' : '原样';
  const def = slot ? EMENU_TEMPLATES[layout].slots.find((s) => s.key === slot) : undefined;
  if (!def) {
    return (
      <div className="space-y-3 text-[12.5px] leading-relaxed text-ink-2" data-testid="studio-slot-panel-empty">
        <PanelTitle>{EMENU_LAYOUT_INFO[layout].label}</PanelTitle>
        <p>点画布上的一块（照片、菜名价格、小标题……）选中：拖着挪位置，拉边角改大小；方向键微调，Shift + 方向键挪 10。</p>
        <p className="text-ink-3">
          两档各有一套位置：现在改的是 <b className="text-ink">「{modeName}」</b>一档（顶栏的「原样 / 放大」切换）。平板用哪一档在后台「电子菜单 → 设置 → 字与按钮的大小」里定。
        </p>
      </div>
    );
  }
  const o = doc.templates?.[layout]?.[def.key];
  const s = resolveSlot(def, o);
  const p = slotSpot(s, mode);
  const can = slotResizable(def);
  const coalesce = `slot.${layout}.${def.key}.${mode}`;
  const set = (next: Parameters<typeof setSlotSpot>[4], field: string) => onChange((d) => setSlotSpot(d, layout, def.key, mode, next), `${coalesce}.${field}`);
  const kindHint: Partial<Record<EmenuSlotKind, string>> = {
    text: '菜名、英文名、介绍、价格与加号是一整块：可以挪、改宽，高跟着内容走（介绍长就高）。',
    intro: '介绍是一整块：可以挪、改宽，高跟着内容走（最多几行照设计稿）。',
    title: '竖排的小标题（后台排页时填的）：只能挪。',
    coverTitle: '分类大标题（分类的名字）：只能挪，中英文两行一起挪。',
    row: '文字陈列的一行（名称、英文名、属性、价格）：只能挪。',
    photo: '照片位：可以挪、改宽高（图按比例铺满、多出来的裁掉），可以加圆角、藏起来。',
  };
  return (
    <div className="space-y-4" data-testid="studio-slot-panel">
      <div>
        <PanelTitle>{def.label}</PanelTitle>
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          {EMENU_LAYOUT_INFO[layout].label} · {kindHint[def.kind]}
        </p>
      </div>
      <div className="rounded-md border border-line bg-paper-2/60 px-2.5 py-2 text-[12px] text-ink-2">
        在改<b className="mx-0.5 text-ink">「{modeName}」</b>一档的位置
        <button type="button" className="ml-2 text-pine underline" onClick={onToggleBig} data-testid="studio-slot-mode">
          改{big ? '原样' : '放大'}一档
        </button>
        <div className="mt-0.5 text-[11px] text-ink-3">{big ? '放大一档没改的项跟着原样一档。' : '原样一档改了，放大一档没单独改过的项也跟着。'}</div>
      </div>
      <div className="space-y-2">
        <PanelTitle>位置与大小</PanelTitle>
        <div className="grid grid-cols-2 gap-2">
          <Row label="X" narrow>
            <NumberInput value={p.x} onChange={(v) => set({ x: round1(v) }, 'x')} testId="studio-slot-x" />
          </Row>
          {p.bottom !== undefined ? (
            <Row label="下沿" narrow>
              <NumberInput value={p.bottom} onChange={(v) => set({ bottom: round1(v) }, 'bottom')} testId="studio-slot-bottom" />
            </Row>
          ) : (
            <Row label="Y" narrow>
              <NumberInput value={p.y} onChange={(v) => set({ y: round1(v) }, 'y')} testId="studio-slot-y" />
            </Row>
          )}
          {can.w && (
            <Row label="宽" narrow>
              <NumberInput value={p.w} min={def.kind === 'photo' ? 24 : 80} max={1024} onChange={(v) => set({ w: round1(v) }, 'w')} testId="studio-slot-w" />
            </Row>
          )}
          {can.h && (
            <Row label="高" narrow>
              <NumberInput value={p.h} min={24} max={768} onChange={(v) => set({ h: round1(v) }, 'h')} testId="studio-slot-h" />
            </Row>
          )}
        </div>
        {p.bottom !== undefined && <p className="text-[11px] leading-relaxed text-ink-3">这一块在放大一档里下沿贴线、往上长（介绍长了往上多出来，不压到下面的图）；挪的是下沿。</p>}
      </div>
      {(slotHideable(def) || def.kind === 'photo') && (
        <div className="space-y-2">
          <PanelTitle>样子</PanelTitle>
          {slotHideable(def) && (
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <input type="checkbox" checked={s.hidden} onChange={(e) => onChange((d) => setSlotFlags(d, layout, def.key, { hidden: e.target.checked }))} data-testid="studio-slot-hidden" />
              藏起来（用这种版式的每一页都不显示，两档一起）
            </label>
          )}
          {def.kind === 'photo' && (
            <Row label="圆角">
              <NumberInput
                value={s.radius ?? 0}
                min={0}
                max={400}
                onChange={(v) => onChange((d) => setSlotFlags(d, layout, def.key, { radius: round1(v) }), `${coalesce}.radius`)}
                testId="studio-slot-radius"
              />
            </Row>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!o?.[mode]} onClick={() => onChange((d) => resetSlot(d, layout, def.key, mode))} data-testid="studio-slot-reset-mode">
          <RotateCcw className="size-3.5" /> 「{modeName}」一档恢复默认
        </Button>
        <Button size="sm" variant="ghost" disabled={!o} onClick={() => onChange((d) => resetSlot(d, layout, def.key))} data-testid="studio-slot-reset">
          这一块全部恢复默认
        </Button>
      </div>
    </div>
  );
}
