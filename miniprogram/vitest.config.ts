import { defineConfig } from 'vitest/config';

// 小程序的单元测试：只测不依赖微信界面的部分（金额与日期、会员码二维码、接口与登录、导览图换算），wx 在测试里换成假的
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
