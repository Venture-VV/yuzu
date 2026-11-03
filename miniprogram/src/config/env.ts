// 连哪个网关（docs/MINIPROGRAM.md 第 6 节）：按小程序的版本选，小程序只连网关，不直接连门店。
//   · 开发版（微信开发者工具、真机预览）：本机起的网关（node dist/gateway/index.js，默认 8300 端口）；
//     真机预览时手机连不到 127.0.0.1，把 DEV_GATEWAY 改成电脑的局域网地址，手机上打开「开发调试」；
//   · 体验版：测试服的网关（连演示库）；正式版：正式网关。两个域名等备案下来再填（第 7 节手续）。
// 网关是不是「模拟微信」由网关自己报告（/v1/health），正式版一律不用模拟。

export type EnvVersion = 'develop' | 'trial' | 'release';

/** 开发版连的网关：改成自己电脑的地址时不要提交 */
export const DEV_GATEWAY = 'http://127.0.0.1:8300';

const GATEWAYS: Record<EnvVersion, string> = {
  develop: DEV_GATEWAY,
  // 备案域名下来后改成 https://api-test.<域名>、https://api.<域名>，并在小程序后台加进 request、downloadFile 合法域名
  trial: 'https://api-test.domain.invalid',
  release: 'https://api.domain.invalid',
};

export function envVersion(): EnvVersion {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || 'develop';
  } catch {
    return 'develop';
  }
}

export function gatewayBase(): string {
  return GATEWAYS[envVersion()];
}

/** 版本号（正式版、体验版有；开发版为空），显示在「我的」页底部 */
export function appVersion(): string {
  try {
    return wx.getAccountInfoSync().miniProgram.version || '';
  } catch {
    return '';
  }
}
