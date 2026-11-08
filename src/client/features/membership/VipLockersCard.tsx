// 后台「会员权益 → VIP 柜」（8.0.4，需求表 02，docs/MEMBERSHIP_V804.md 第 2 节）：各档能用到几级 VIP 柜、当场授权开关。
// 原来分在「会员规则」与「手牌与前台」两处，迁移 088 原样搬到这里；保存带上打开时读到的设置，别人刚改过就整页换成最新的。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { MAX_VIP_LEVEL } from '@shared/frontdesk';
import { MAX_GRADE, type VipLockerRules, type VipLockerSettings } from '@shared/membership';
import { api, ApiError, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Button, Card, ConfirmCheck, Notice, PendingBadge, SectionTitle, Select, Skeleton } from '../../components/ui';
import { useMembershipRules } from './queries';

export const vipLockerKey = ['benefits', 'vip-lockers'] as const;

export function VipLockersCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useMembershipRules();
  const q = useQuery({ queryKey: vipLockerKey, queryFn: () => api.get<VipLockerSettings>('/api/vip-lockers') });
  const [draft, setDraft] = useState<VipLockerRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data.rules);
  }, [q.data]);
  if (q.isPending || !draft) return <Skeleton className="h-72" />;
  if (q.error || !q.data) return <Notice tone="error" title={q.error?.message ?? 'VIP 柜设置没有加载出来'} />;
  const saved = q.data.rules;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const problem = draft.levels.some((v, i) => i > 0 && v < draft.levels[i - 1]!) ? '高档能用的 VIP 柜不能比低档少' : null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put<VipLockerSettings>('/api/vip-lockers', { ...draft, based: saved });
      await qc.invalidateQueries({ queryKey: vipLockerKey });
      // 前台徽标、会员详情的「能用几级柜」
      await qc.invalidateQueries({ queryKey: ['membership'] });
      toast({ tone: 'success', title: 'VIP 柜设置已保存', body: '发牌、换牌马上按新的设置核对。' });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === 'RULES_CHANGED') await qc.invalidateQueries({ queryKey: vipLockerKey });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="vip-lockers" id="vip">
      <SectionTitle aside={<PendingBadge title="各档能用几级柜按柜号清单的 1–5 级换算（L0–L3 → 1 级、L4 → 2 级、L5 → 4 级、L6 → 5 级），当场授权默认不开，待店主确认" />}>
        VIP 柜
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        会员能用的柜子等级不低于柜子的等级才能用那个 VIP 柜；散客为 0。8.0.4 起从「会员规则」「手牌与前台」移到这里，原来的设置已原样搬过来。
        {q.data.updatedAt && ` 最近修改：${formatDateTime(q.data.updatedAt)}${q.data.updatedByName ? `（${q.data.updatedByName}）` : ''}。`}
      </p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[460px] text-[13px]">
          <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
            <tr>
              <th className="px-3 py-2 text-left">档级</th>
              <th className="px-3 py-2 text-left">能用到几级 VIP 柜</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {Array.from({ length: MAX_GRADE + 1 }, (_, i) => (
              <tr key={i}>
                <td className="px-3 py-2 font-semibold">
                  L{i} {rules.data?.grades[i]?.name ?? ''}
                </td>
                <td className="px-3 py-1.5">
                  <Select
                    value={draft.levels[i] ?? 0}
                    fullWidth={false}
                    className="w-40"
                    aria-label={`L${i} 能用几级 VIP 柜`}
                    data-testid={`vip-level-${i}`}
                    onChange={(e) => setDraft({ ...draft, levels: draft.levels.map((v, j) => (j === i ? Number(e.target.value) : v)) })}
                  >
                    {Array.from({ length: MAX_VIP_LEVEL + 1 }, (_, lv) => (
                      <option key={lv} value={lv}>
                        {lv === 0 ? '不能用' : `${lv} 级及以下`}
                      </option>
                    ))}
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-ink-3" data-testid="vip-locker-counts">
        手牌池里在用的 VIP 柜：
        {Object.entries(q.data.lockerCounts)
          .map(([level, n]) => `${level} 级 ${n} 个`)
          .join('，')}
        （在「手牌与前台」建牌、改柜型）
      </p>
      <div className="mt-4">
        <ConfirmCheck checked={draft.overrideEnabled} onChange={(v) => setDraft({ ...draft, overrideEnabled: v })}>
          <span className="flex items-center gap-1.5" data-testid="vip-override">
            <ShieldCheck className="size-4 text-pine" /> 允许当场授权散客或等级不够的会员使用 VIP 柜
          </span>
          <span className="block text-[12.5px] font-normal text-ink-3">开启后由值班经理、店总或店主在发牌、换牌弹窗里输入账号密码授权，每次授权只能用一次</span>
        </ConfirmCheck>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!dirty || !!problem} loading={busy} onClick={() => void save()} data-testid="vip-lockers-save">
          保存 VIP 柜设置
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(saved)}>
            放弃修改
          </Button>
        )}
        {problem && <span className="text-[13px] text-clay">{problem}</span>}
      </div>
    </Card>
  );
}
