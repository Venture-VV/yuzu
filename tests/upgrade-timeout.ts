// 升级用例（tests/upgrade-*.test.ts）的单条时限放宽到 2 分钟（工程治理收口后，2026-11-18）。
// 这类用例在一条用例里把迁移从某一份一路跑到最新一份，迁移每加一份就慢一点：现在 154 份，同一份代码在 CI 的机器上
// 一条要 10–27 秒不等（机器快慢差一倍多：npm test 整个跑下来快的 4 分半、慢的 10 分钟），默认的 30 秒在慢的那种上不够——
// PR #133 的一次 CI 里五个文件一起超时，同一份代码在 main 上全过。自己写了时限的用例照自己的，别的用例还是 30 秒。
// 这个文件只放数与判断，没有副作用；动手改时限的是 tests/setup-timeouts.ts。

export const UPGRADE_TEST_TIMEOUT = 120_000;

/** 是不是升级用例：文件名以 upgrade- 开头的 .test.ts */
export function isUpgradeTest(path: string): boolean {
  return /(^|[\\/])upgrade-[^\\/]+\.test\.ts$/.test(path);
}
