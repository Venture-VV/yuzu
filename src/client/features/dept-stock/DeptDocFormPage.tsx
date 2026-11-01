// 本部门小仓的单据录入（v0.7.11）：与库存页用同一张表单，数据与提交都走 /api/erp/dept-stock。

import { Navigate, useSearchParams } from 'react-router';
import { errorMessage } from '../../lib/api';
import { Notice, Skeleton } from '../../components/ui';
import { DocFormPage, deptScope } from '../inventory/DocFormPage';
import { useDeptMeta } from './queries';

export function DeptDocFormPage() {
  const meta = useDeptMeta();
  const [params] = useSearchParams();
  if (meta.isPending) return <Skeleton className="m-7 h-64" />;
  if (meta.error) return <Notice tone="error" title={errorMessage(meta.error)} className="m-7" />;
  const wanted = Number(params.get('dept')) || meta.data.myDepartmentId;
  const dept = meta.data.departments.find((d) => d.id === wanted) ?? meta.data.departments[0];
  if (!dept) return <Navigate to="/erp/dept-stock" replace />;
  return <DocFormPage key={dept.id} scope={deptScope(dept)} />;
}
