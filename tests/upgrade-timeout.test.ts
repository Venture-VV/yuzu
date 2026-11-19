// 升级用例的时限（tests/upgrade-timeout.ts 的数，tests/setup-timeouts.ts 在每个用例文件开跑前按文件名放宽）：
// 这个文件自己就叫 upgrade-…，拿它当样本。只引没有副作用的那个文件，时限是不是 2 分钟全看两份配置有没有接上 setupFiles
import { describe, expect, it } from 'vitest';
import { isUpgradeTest, UPGRADE_TEST_TIMEOUT } from './upgrade-timeout';

describe('升级用例的单条时限', () => {
  it('文件名以 upgrade- 开头的用例是 2 分钟', ({ task }) => {
    expect(UPGRADE_TEST_TIMEOUT).toBe(120_000);
    expect(task.timeout).toBe(UPGRADE_TEST_TIMEOUT);
  });

  it('自己写了时限的照自己的', ({ task }) => {
    expect(task.timeout).toBe(5_000);
  }, 5_000);

  it('只认文件名：upgrade-*.test.ts，目录里带 upgrade、名字中间带 upgrade 的不算', () => {
    expect(isUpgradeTest('/repo/tests/upgrade-warehouses.test.ts')).toBe(true);
    expect(isUpgradeTest('tests\\upgrade-r1.test.ts')).toBe(true);
    expect(isUpgradeTest('upgrade-shift.test.ts')).toBe(true);
    expect(isUpgradeTest('/repo/tests/wallet.test.ts')).toBe(false);
    expect(isUpgradeTest('/repo/tests/member-upgrade-rules.test.ts')).toBe(false);
    expect(isUpgradeTest('/repo/upgrade-tools/tests/wallet.test.ts')).toBe(false);
    expect(isUpgradeTest('/repo/tests/upgrade-helpers.ts')).toBe(false);
    expect(isUpgradeTest('')).toBe(false);
  });
});
