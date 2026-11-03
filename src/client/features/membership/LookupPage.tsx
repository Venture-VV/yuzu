// 他店查询（会员体系 v2，v0.7.23；docs/MEMBERSHIP.md 第 8 节）：另一家店的同事按完整手机号或会员号查一位会员——
// 档阶、会籍到期日、是否在补充期、账户状态；姓名、手机号遮一部分；看不到余额与流水，也不能改。每次查询记审计。

import { useState } from 'react';
import { Award, ScanSearch } from 'lucide-react';
import type { MemberLookupResult } from '@shared/membership';
import { api, errorMessage } from '../../lib/api';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, Input, Notice } from '../../components/ui';

export function LookupPage() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ query: string; member: MemberLookupResult | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<{ found: boolean; member: MemberLookupResult | null }>(`/api/membership/lookup?q=${encodeURIComponent(query)}`);
      setResult({ query, member: r.member });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const m = result?.member;
  return (
    <>
      <PageHeader title="会员查询" subtitle="按完整手机号或会员号查会员的档阶与会籍（只读，不含余额）" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[560px] space-y-4 px-5 py-6" data-testid="member-lookup">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="11 位手机号或会员号" inputMode="text" autoFocus aria-label="手机号或会员号" data-testid="member-lookup-input" />
            <Button type="submit" variant="primary" icon={<ScanSearch className="size-4" />} loading={busy} disabled={!q.trim()} data-testid="member-lookup-submit">
              查询
            </Button>
          </form>
          {error && <Notice tone="error" title={error} />}
          {result && !m && <Notice tone="info" title={`没有找到「${result.query}」`}>请核对完整的手机号或会员号；只按完整号码查，不支持模糊查找。</Notice>}
          {m && (
            <Card className="p-5" data-testid="member-lookup-result">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[20px] font-bold text-ink">{m.maskedName}</p>
                <span className="num text-[13px] text-ink-3">
                  {m.maskedPhone} · 会员号 {m.memberNo}
                </span>
                {m.status === 'frozen' && <Badge tone="clay">已停用</Badge>}
              </div>
              <p className="mt-3 flex items-center gap-2 text-[18px] font-bold text-yuzu-deep" data-testid="member-lookup-grade">
                <Award className="size-5" /> {m.label}
              </p>
              <p className="mt-1 text-[13px] text-ink-2">
                {m.grade === 0 ? '免费注册会员，没有会籍周期' : `会籍到期 ${m.cycleEnd}`}
                {m.inGrace && <span className="ml-2 font-semibold text-ember">补充期至 {m.graceUntil}</span>}
              </p>
              <p className="mt-3 text-[12px] text-ink-3">两店资金暂不通用：这里不显示余额与消费记录，也不能在这里扣款。</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
