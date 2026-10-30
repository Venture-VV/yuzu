import { INSTANCE_LABELS, versionText, type InstanceKind } from '@shared/instance';
import { cn } from '../lib/utils';

// 实例标识与版本：登录页、导航栏常显，员工一眼分清正式服和「不作数」的测试服、影子库、演示库
const TONE: Record<InstanceKind, string> = {
  prod: 'bg-pine-soft text-pine',
  shadow: 'bg-ember text-white',
  test: 'bg-ember text-white',
  demo: 'bg-ember text-white',
  dev: 'bg-yuzu text-ink',
  trial: 'bg-yuzu text-ink',
  unset: 'bg-clay text-white',
};

// 前后端同一个镜像，不会出现未知的取值；万一出现也按「未设置」显示，不让页面出错
const labelOf = (instance: InstanceKind) => INSTANCE_LABELS[instance] ?? INSTANCE_LABELS.unset;
const toneOf = (instance: InstanceKind) => TONE[instance] ?? TONE.unset;

/** 登录页：一行标识 */
export function InstanceBadge({ instance, className }: { instance: InstanceKind; className?: string }) {
  return (
    <span
      data-testid="instance-badge"
      className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-[12.5px] leading-none font-bold', toneOf(instance), className)}
    >
      {labelOf(instance)}
    </span>
  );
}

/** 导航栏底部：窄栏里分两行显示标识，下面是版本与提交 SHA */
export function InstanceTag({ instance, version, commit }: { instance: InstanceKind; version: string; commit: string }) {
  const [main, sub] = labelOf(instance).split('·');
  return (
    <div
      data-testid="instance-tag"
      title={`${labelOf(instance)} · ${versionText(version, commit)}`}
      className="mb-3 flex w-[64px] flex-col items-center gap-1 text-center short:mb-2 short:gap-0.5"
    >
      <span className={cn('w-full rounded-md px-1 py-1 text-[11px] leading-tight font-bold', toneOf(instance))}>
        {main}
        {sub && (
          <>
            <br />
            {sub}
          </>
        )}
      </span>
      <span className="num w-full text-[10px] leading-tight break-all text-paper/60">v{version}</span>
      {commit && <span className="num text-[10px] leading-tight text-paper/60">{commit.slice(0, 7)}</span>}
    </div>
  );
}
