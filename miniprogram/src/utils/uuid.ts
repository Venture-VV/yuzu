// 操作编号（UUID v4）：小程序里没有 crypto.randomUUID；操作编号只用来认出同一次请求，不当密钥用
export function uuid(): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += hex.charAt(8 + Math.floor(Math.random() * 4));
    else s += hex.charAt(Math.floor(Math.random() * 16));
  }
  return s;
}
