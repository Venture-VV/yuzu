// 每个用例文件开跑前执行一次（vitest.config.ts 与 vitest.unit.config.ts 的 setupFiles）：
// 升级用例的单条时限放宽，来由与数在 tests/upgrade-timeout.ts。用例文件不要引这个文件（引了就等于自己把时限改了，测不出配置有没有接上）。
import { expect, vi } from 'vitest';
import { isUpgradeTest, UPGRADE_TEST_TIMEOUT } from './upgrade-timeout';

if (isUpgradeTest(expect.getState().testPath ?? '')) vi.setConfig({ testTimeout: UPGRADE_TEST_TIMEOUT });
