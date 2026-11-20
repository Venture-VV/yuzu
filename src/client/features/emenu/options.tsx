// 平板上选做法、加料（8.1.17 BW9，docs/DISHES_V8117.md 第 5 节）：点一道有做法或加料的菜（加号、菜品详情里的加入）时，
// 右边滑出这一块抽屉（与「备注」同一个样子）——
//   · 做法：分了组的同一组只能选一个（再点别的就换过去），必选的组不选不能加；不分组的可以多选；加价的写「+¥2」；
//   · 加料：另外的菜，各算各的钱；加进未下单时另起一行、挂在这道菜上（出品单上写「配 这道菜」）；
//   · 规格照电子菜单原来的做法：在菜品详情里选（每个规格是价目里的一个项目，各有各的价）。
// 核对与点单页、门店系统同一个函数（@shared/dishes 的 methodChoiceProblem）；价格以门店系统为准。

import { useState, type CSSProperties, type ReactNode } from 'react';
import { methodChoiceProblem, methodsExtra, pickedMethods, plusYuan, type DishMethodOption } from '@shared/dishes';
import type { EmenuDishView, EmenuSpecView } from '@shared/emenu';
import { dishNames, specLabel, useLang, useM } from './i18n';
import { MinusDot, PlusDot } from './icons';
import { DrawerButton, Drawer, DX, LINE, MUTE, useDrawerDrop } from './overlays';
import { ScrollArea } from './motion';
import { yuan } from './pages';
import { box, Hairline } from './stage';

export interface PickedOptions {
  methods: string[];
  addons: { itemId: number; quantity: number }[];
}

const pillStyle = (on: boolean, disabled: boolean): CSSProperties => ({
  position: 'relative',
  width: 102,
  height: 28.3,
  padding: 0,
  borderRadius: 1.5,
  border: 0,
  fontSize: 14,
  lineHeight: '14px',
  background: on ? 'var(--em-tan)' : 'transparent',
  color: on ? 'var(--em-light)' : MUTE,
  opacity: disabled ? 0.4 : 1,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  transition: 'background-color var(--em-micro) ease, color var(--em-micro) ease',
});

export function OptionsDrawer({
  dish,
  spec,
  tableName,
  onClose,
  onAdd,
}: {
  dish: EmenuDishView;
  /** 选好了规格的这一个（带 options） */
  spec: EmenuSpecView;
  tableName: string;
  onClose: () => void;
  onAdd: (picked: PickedOptions) => void;
}) {
  const lang = useLang();
  const en = lang === 'en';
  const m = useM();
  const drop = useDrawerDrop();
  const options = spec.options!;
  const [methods, setMethods] = useState<string[]>([]);
  const [addons, setAddons] = useState<Record<number, number>>({});
  const name = dishNames(dish, lang).main;
  const label = specLabel(spec, lang);
  const problem = methodChoiceProblem(name, options.methods, options.groups, methods, { requireAll: true });
  const picked = options.addons.filter((a) => (addons[a.itemId] ?? 0) > 0 && a.state === 'ok');
  const total = spec.price + methodsExtra(options.methods, methods) + picked.reduce((s, a) => s + a.price * addons[a.itemId]!, 0);
  const loose = options.methods.filter((o) => !o.group || !options.groups.some((g) => g.name === o.group));
  const toggle = (o: DishMethodOption) =>
    setMethods((cur) => {
      if (cur.includes(o.name)) return cur.filter((x) => x !== o.name);
      const same = o.group ? options.methods.filter((x) => x.group === o.group).map((x) => x.name) : [];
      return [...cur.filter((x) => !same.includes(x)), o.name];
    });

  const pill = (o: DishMethodOption, radio: boolean) => {
    const on = methods.includes(o.name);
    return (
      <button
        key={o.name}
        type="button"
        role={radio ? 'radio' : undefined}
        aria-checked={radio ? on : undefined}
        aria-pressed={radio ? undefined : on}
        onClick={() => toggle(o)}
        className="em-tap-soft"
        style={pillStyle(on, false)}
        data-testid={`emenu-option-${o.name}`}
      >
        {!on && <Hairline />}
        <span style={{ position: 'absolute', left: 0, right: 0, top: 8.85, textAlign: 'center' }}>
          {o.name}
          {o.price > 0 && (
            <span className="em-en" style={{ fontSize: 11, marginLeft: 3 }}>
              {plusYuan(o.price)}
            </span>
          )}
        </span>
      </button>
    );
  };
  const heading = (text: ReactNode, note: ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '14px 0 8px', fontSize: 14, lineHeight: '16px' }}>
      <span>{text}</span>
      <span className={en ? 'em-en' : undefined} style={{ fontSize: 11, color: MUTE }}>
        {note}
      </span>
    </div>
  );
  const row = (children: ReactNode) => <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 18.65px' }}>{children}</div>;

  return (
    <Drawer kind="options" title="选做法" subtitle="OPTIONS" tableName={tableName} onClose={onClose} testId="emenu-options">
      <div style={{ ...box(DX, 100.4, 343.3, 0), borderTop: LINE }} />
      <div className="em-clip" style={{ ...box(DX, 112, 343.3), fontSize: 16, lineHeight: '18px' }} data-testid="emenu-options-dish">
        {name}
        {label && <span style={{ fontSize: 11, color: MUTE, marginLeft: 4 }}>{en ? `(${label})` : `（${label}）`}</span>}
        <span className="em-en" style={{ fontSize: 13, color: MUTE, marginLeft: 8 }}>
          ¥{yuan(spec.price)}
        </span>
      </div>
      <ScrollArea style={{ ...box(DX, 136, 343.3, 530 - drop) }} testId="emenu-options-list">
        {options.groups
          .filter((g) => options.methods.some((o) => o.group === g.name))
          .map((g) => (
            <div key={g.name} role="radiogroup" aria-label={g.name} data-testid={`emenu-option-group-${g.name}`}>
              {heading(
                g.name,
                <>
                  {m.optionsPickOne}
                  {g.required && (
                    <span style={{ marginLeft: 6, color: 'var(--em-tan)', fontWeight: 600 }} data-testid={`emenu-option-required-${g.name}`}>
                      {m.optionsRequired}
                    </span>
                  )}
                </>,
              )}
              {row(options.methods.filter((o) => o.group === g.name).map((o) => pill(o, true)))}
            </div>
          ))}
        {loose.length > 0 && (
          <div>
            {heading(options.groups.length ? m.optionsMore : m.optionsTitle, m.optionsAny)}
            {row(loose.map((o) => pill(o, false)))}
          </div>
        )}
        {options.addons.length > 0 && (
          <div>
            {heading(m.optionsAddons, m.addonOfLine(name))}
            {options.addons.map((a) => {
              const n = addons[a.itemId] ?? 0;
              const usable = a.state === 'ok';
              const cap = Math.min(99, a.remaining ?? 99);
              const step = (delta: number) => setAddons((cur) => ({ ...cur, [a.itemId]: Math.max(0, Math.min(cap, n + delta)) }));
              return (
                <div key={a.itemId} style={{ position: 'relative', height: 40, opacity: usable ? 1 : 0.45 }} data-testid={`emenu-option-addon-${a.name}`}>
                  <div className="em-clip" style={{ ...box(0, 12, 220), fontSize: 14, lineHeight: '16px' }}>
                    {a.name}
                    <span className="em-en" style={{ fontSize: 12, color: MUTE, marginLeft: 6 }}>
                      +¥{yuan(a.price)}
                    </span>
                  </div>
                  {usable ? (
                    <>
                      <button
                        type="button"
                        aria-label={m.optionsLess(a.name)}
                        disabled={n === 0}
                        onClick={() => step(-1)}
                        className="em-tap"
                        style={{ ...box(255, 11, 18, 18), padding: 0, border: 0, background: 'none', opacity: n === 0 ? 0.35 : 1 }}
                        data-testid={`emenu-option-addon-minus-${a.name}`}
                      >
                        <span style={{ position: 'absolute', inset: -11 }} />
                        <MinusDot size={18} />
                      </button>
                      <span className="em-en" style={{ ...box(276, 12.5, 40), textAlign: 'center', fontSize: 14, lineHeight: '16px' }} data-testid={`emenu-option-addon-qty-${a.name}`}>
                        {n}
                      </span>
                      <button
                        type="button"
                        aria-label={m.optionsMoreOne(a.name)}
                        disabled={n >= cap}
                        onClick={() => step(1)}
                        className="em-tap"
                        style={{ ...box(319, 11, 18, 18), padding: 0, border: 0, background: 'none' }}
                        data-testid={`emenu-option-addon-plus-${a.name}`}
                      >
                        <span style={{ position: 'absolute', inset: -11 }} />
                        <PlusDot size={18} muted={n >= cap} />
                      </button>
                    </>
                  ) : (
                    <span className={en ? 'em-en' : undefined} style={{ position: 'absolute', right: 0, top: 13, fontSize: 11, color: MUTE }}>
                      {a.state === 'sold_out' ? m.specSoldOut : a.state === 'unavailable' ? m.specUnavailable : m.specOff}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
      <div
        className={en ? 'em-en' : undefined}
        style={{ ...box(DX, 680 - drop, 343.3), textAlign: 'center', fontSize: 12, lineHeight: '14px', color: problem ? 'var(--em-error)' : MUTE }}
        data-testid="emenu-options-note"
      >
        {problem
          ? problem.code === 'DISH_METHOD_REQUIRED'
            ? m.optionsMissing(problem.group ?? '')
            : problem.message
          : pickedMethods(options.methods, methods)
              .map((o) => o.name)
              .join(' · ')}
      </div>
      <DrawerButton
        onClick={() => !problem && onAdd({ methods: pickedMethods(options.methods, methods).map((o) => o.name), addons: picked.map((a) => ({ itemId: a.itemId, quantity: addons[a.itemId]! })) })}
        disabled={!!problem}
        testId="emenu-options-add"
      >
        <span className={en ? 'em-en' : undefined} style={en ? { fontSize: 14 } : undefined}>
          {m.optionsAdd} · ¥{yuan(total)}
        </span>
      </DrawerButton>
    </Drawer>
  );
}
