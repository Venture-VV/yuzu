// 后台「工作台」分区（8.1.1，GZ4：工作台就在后台）：有哪些界面能改、现在用的是第几版、草稿谁什么时候改的，点进去打开编辑器。
// 8.1.2 起还写着下一次定时换版、没解决的批注几条。
// 设计师（只有「工作台：编辑 / 发布」）进后台只看得到这一个分区。

import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { PenTool } from 'lucide-react';
import type { StudioOverview } from '@shared/studio';
import { api } from '../../lib/api';
import { LoadFailed } from '../../components/LoadFailed';
import { Card, Skeleton } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { SHOWN_ON } from './shownOn';

const short = (at: string) => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function StudioSection() {
  const q = useQuery({ queryKey: ['studio', 'overview'], queryFn: () => api.get<StudioOverview>('/api/studio') });
  return (
    <AdminPage section="studio" description="设计师在系统里直接改版面：所见即所得，改完自己发布（平板回到起始页时换成新样子），改坏了一键回到上一版。点菜、下单这些逻辑不开放，只改长什么样、放在哪。">
      <div className="space-y-4" data-testid="studio-section">
        {!q.data ? (
          q.isError ? (
            <LoadFailed title="工作台取不回来，请检查网络" onRetry={() => void q.refetch()} retrying={q.isFetching} />
          ) : (
            <Skeleton className="h-32" />
          )
        ) : (
          q.data.surfaces.map((s) => (
            <Card key={s.surface} className="flex flex-wrap items-center gap-4 p-5">
              <div className="min-w-0 flex-1">
                <h2 className="text-[16px] font-bold">{s.label}</h2>
                <p className="mt-1 text-[13px] text-ink-2">
                  {SHOWN_ON[s.surface].where}现在用：
                  {s.published ? (
                    <>
                      第 {s.published.version} 版（{s.published.publishedBy} · {new Date(s.published.publishedAt).toLocaleString('zh-CN')}）{s.inherited && '，这家店没发布过，用的是本店的'}
                    </>
                  ) : (
                    '内置的默认版面（还没发布过）'
                  )}
                </p>
                {s.scheduled && (
                  <p className="mt-0.5 text-[12.5px] text-pine" data-testid={`studio-overview-scheduled-${s.surface}`}>
                    定时：第 {s.scheduled.version} 版定在 {short(s.scheduled.effectiveAt!)} 生效（{s.scheduled.publishedBy}；不要了在编辑器的「版本」里撤）
                  </p>
                )}
                <p className="mt-0.5 text-[12.5px] text-ink-3">
                  {s.draftUpdatedAt ? `草稿：${s.draftUpdatedBy} ${new Date(s.draftUpdatedAt).toLocaleString('zh-CN')} 改过` : '草稿：还没改过'}
                  {s.openComments > 0 && <span className="ml-2 text-clay">{s.openComments} 条批注没解决</span>}
                </p>
              </div>
              <Link to={`/studio/${s.surface}`} className="inline-flex h-10 items-center gap-2 rounded-md bg-pine px-4 text-sm text-paper hover:bg-pine-hover" data-testid={`studio-open-${s.surface}`}>
                <PenTool className="size-4" /> 打开工作台
              </Link>
            </Card>
          ))
        )}
        <Card className="space-y-2 p-5 text-[13px] leading-relaxed text-ink-2">
          <h2 className="text-[14px] font-bold text-ink">怎么用</h2>
          <p>① 打开工作台，左上选「起始页 / 菜单页」；中间是平板大小的画布，显示的就是平板上的样子。</p>
          <p>② 点中一块，右边改颜色、字、大小；拖着挪位置，靠近别的块时自动出对齐线；左边「插入」加文字、图形、图片，「主题」一处改全局的颜色与字体。</p>
          <p>③ 「预览」像客人一样点一点，也能在真平板上扫码看；「检查」红的改掉才能发布；「发布」写一句改了什么就生效；「版本」里任何一版都能回去。</p>
          <p>④ 「批注」在画布上点一下留言，设计师和店主来回说、改好了标解决；发布时可以选「定时」（换季菜单、节日海报到点才换，之前能撤）。</p>
          <p>⑤ 「更多」里有「中英文案」（所有的字一张表对着改，可以导出给人翻译再导回来）和「设计包」（在演示库做好，导出一个文件，到正式服导进来再发布）。</p>
          <p className="text-ink-3">Figma 里做好的图标、海报导出成 PNG 或 SVG，在「素材」里传进来就能用。8.1.2 起还能改菜单页的版式（卡片模板）、员工食堂的界面。</p>
        </Card>
      </div>
    </AdminPage>
  );
}
