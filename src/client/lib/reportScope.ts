// 报表、看板的「合并看」（8.0.22，MD18）：地址带 ?scope=all 时看自己能进的几家店的合计；
// 只能进一家店（含只有本店）的人没有这个开关，与以往一样。
import { useSearchParams } from 'react-router';
import { useSession } from './session';

export function useReportScope() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const multi = session.stores.length > 1;
  const merged = multi && params.get('scope') === 'all';
  const set = (on: boolean) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (on) next.set('scope', 'all');
        else next.delete('scope');
        return next;
      },
      { replace: true },
    );
  /** 拼在已有查询参数后面（`&scope=all`） */
  const q = merged ? '&scope=all' : '';
  /** 没有别的查询参数时用（`?scope=all`） */
  const qs = merged ? '?scope=all' : '';
  return { multi, merged, set, q, qs, count: session.stores.length };
}
