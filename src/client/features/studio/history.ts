// UI 工作台编辑器的撤销、重做（8.1.1，docs/WORKBENCH_V811.md 第 5 节）：在本机，最多 200 步。
//   · set：改了一步（同一个 coalesce 的连续修改——比如在属性里一个字一个字地打——一秒之内算同一步）；
//   · live：拖动当中只改眼前的（不记步）；拖完以后 commit 把拖之前的那一份记成一步。

import { useCallback, useReducer } from 'react';
import type { StudioDoc } from '@shared/studio';

const MAX_STEPS = 200;
const COALESCE_MS = 1000;

interface State {
  doc: StudioDoc;
  past: StudioDoc[];
  future: StudioDoc[];
  /** 最近一步的合并标记与时刻 */
  last: { key: string; at: number } | null;
  /** 改了多少次（自动保存看它） */
  changes: number;
}

type Action =
  | { type: 'reset'; doc: StudioDoc }
  | { type: 'set'; doc: StudioDoc; coalesce?: string }
  | { type: 'live'; doc: StudioDoc }
  | { type: 'commit'; before: StudioDoc }
  | { type: 'undo' }
  | { type: 'redo' };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'reset':
      return { doc: a.doc, past: [], future: [], last: null, changes: 0 };
    case 'set': {
      const now = Date.now();
      const merge = !!a.coalesce && s.last?.key === a.coalesce && now - s.last.at < COALESCE_MS;
      return {
        doc: a.doc,
        past: merge ? s.past : [...s.past, s.doc].slice(-MAX_STEPS),
        future: [],
        last: a.coalesce ? { key: a.coalesce, at: now } : null,
        changes: s.changes + 1,
      };
    }
    case 'live':
      return { ...s, doc: a.doc };
    case 'commit':
      return s.doc === a.before ? s : { ...s, past: [...s.past, a.before].slice(-MAX_STEPS), future: [], last: null, changes: s.changes + 1 };
    case 'undo': {
      const prev = s.past[s.past.length - 1];
      return prev ? { doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future].slice(0, MAX_STEPS), last: null, changes: s.changes + 1 } : s;
    }
    case 'redo': {
      const next = s.future[0];
      return next ? { doc: next, past: [...s.past, s.doc].slice(-MAX_STEPS), future: s.future.slice(1), last: null, changes: s.changes + 1 } : s;
    }
  }
}

export function useDocHistory(initial: StudioDoc) {
  const [state, dispatch] = useReducer(reducer, { doc: initial, past: [], future: [], last: null, changes: 0 });
  return {
    doc: state.doc,
    changes: state.changes,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    reset: useCallback((doc: StudioDoc) => dispatch({ type: 'reset', doc }), []),
    set: useCallback((doc: StudioDoc, coalesce?: string) => dispatch({ type: 'set', doc, coalesce }), []),
    live: useCallback((doc: StudioDoc) => dispatch({ type: 'live', doc }), []),
    commit: useCallback((before: StudioDoc) => dispatch({ type: 'commit', before }), []),
    undo: useCallback(() => dispatch({ type: 'undo' }), []),
    redo: useCallback(() => dispatch({ type: 'redo' }), []),
  };
}
