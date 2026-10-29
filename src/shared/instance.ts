// 实例标识：登录页与导航栏常显，区分正式服、影子运行、测试服与演示库。
// 不由 APP_ENV 推断：影子库、测试服演练库与正式服都是 APP_ENV=production，只能靠 YUZU_INSTANCE 区分。

/** prod / shadow / test / demo 在 .env 用 YUZU_INSTANCE 设置；dev / trial / unset 是没设置时按 APP_ENV 推出的 */
export type InstanceKind = 'prod' | 'shadow' | 'test' | 'demo' | 'dev' | 'trial' | 'unset';

export const SETTABLE_INSTANCES = ['prod', 'shadow', 'test', 'demo'] as const;

export const INSTANCE_LABELS: Record<InstanceKind, string> = {
  prod: '正式服',
  shadow: '影子运行·不作数',
  test: '测试服·不作数',
  demo: '演示·不作数',
  dev: '开发环境',
  trial: '试用',
  unset: '未设置实例标识',
};

/** 页面上显示的版本：v + 版本号，有提交 SHA 时附前 7 位 */
export function versionText(version: string, commit: string): string {
  return commit ? `v${version} · ${commit.slice(0, 7)}` : `v${version}`;
}
