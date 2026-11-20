import type { CustomerLowBalancePage } from '@shared/customer';
import { maskPhone } from '@shared/labels';
import { ArrowRight } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { Button, Card, SectionTitle } from '../../components/ui';
import { customerUrl, useCustomerRead } from './api';
import { ListFilters, useCorrectPage } from './Lists';
import type { ListProps } from './Lists';
import { staffName } from './types';
import { Amount, Metric, PageControls, ReadStatus } from './ui';

export function LowBalances(props: ListProps) {
  const f = props.filters;
  const read = useCustomerRead<CustomerLowBalancePage>(customerUrl('low-balances', { q: f.query, managerId: f.managerId, offset: f.offset }), props.revision);
  useCorrectPage(read.data, props);
  const d = read.data;
  return (
    <div className="customer-stack">
      <ListFilters {...props} managerVisible searchLabel="搜索低余额会员" />
      <ReadStatus {...read} hasData={Boolean(d)} onRetry={props.onRefresh} />
      {d && (
        <>
          <div className="customer-metrics customer-metrics-single">
            <Metric
              label="低余额关注会员"
              note={
                <>
                  本金加可用赠金不到 <Amount value={d.thresholdCents} />
                </>
              }
            >
              {d.totals.memberCount}
              <small> 位</small>
            </Metric>
          </div>
          <Card className="customer-section">
            <SectionTitle>低余额关注名单</SectionTitle>
            <p className="customer-caption">与管家部看的是同一份会员余额（本金加还能用的赠金），实时更新，不随上面选的营业日变；余额满 30,000 元的不列入。点击会员可查看个人档案、原单与维护记录。</p>
            <DataTable
              className="customer-member-table"
              tableClassName="customer-table"
              rows={d.rows}
              rowKey={(member) => member.id}
              empty="当前条件下没有低余额关注会员"
              columns={[
                {
                  key: 'member',
                  header: '会员 / 会员号',
                  cell: (member) => (
                    <>
                      <button type="button" className="customer-text-button" onClick={() => props.onRecord('member', member.id)}>
                        {member.name}
                      </button>
                      <small>
                        {member.memberNo} · {maskPhone(member.phone)}
                      </small>
                    </>
                  ),
                },
                {
                  key: 'grade',
                  header: '实时档阶',
                  cell: (member) => (
                    <>
                      {member.gradeLabel}
                      {member.status !== 'active' && <small>已停用</small>}
                    </>
                  ),
                },
                { key: 'total', header: '可用总余额', numeric: true, cell: (member) => <Amount value={member.totalCents} /> },
                {
                  key: 'principal',
                  header: '本金 / 可用赠金',
                  numeric: true,
                  cell: (member) => (
                    <>
                      <Amount value={member.principalCents} />
                      <small>
                        可用赠金 <Amount value={member.bonusCents} />
                      </small>
                    </>
                  ),
                },
                { key: 'maintainer', header: '长期维护人', cell: (member) => staffName(member.binding.maintainer) },
                {
                  key: 'profile',
                  header: '个人档案',
                  cell: (member) => (
                    <Button size="sm" variant="ghost" onClick={() => props.onRecord('member', member.id)}>
                      查看档案
                      <ArrowRight size={13} />
                    </Button>
                  ),
                },
              ]}
            />
            <PageControls {...d} total={d.filteredTotal} onOffset={(offset) => props.onFilters({ ...f, offset })} />
          </Card>
        </>
      )}
    </div>
  );
}
