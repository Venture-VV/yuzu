// 导入用的表格文件（OTA 渠道订单表、网银对账单；Codex 审查 970c95c 后补）：CSV 按 UTF-8 / GBK 自动识别——
// 中文 Excel / WPS「另存为 CSV」默认 GBK，OTA 原来一律按 UTF-8 读，表头成了乱码、必须有的列一个都认不出来；
// .xlsx 原样转 base64 交给服务端；识别不了、有乱码的报错，不照常导入。
import { describe, expect, it } from 'vitest';
import { readTablePayload } from '../src/client/lib/import-file';
import { detectOtaColumns, otaColumnProblem } from '../src/shared/ota';
import { FileEncodingError } from '../src/shared/text-decode';

const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
// 「订单号,入住人,房型,入住日期,离店日期,间数,金额 / GBK001,张三,大床房,2026-12-01,2026-12-03,1,￥600」按 GBK 存
const GBK_ORDERS = hex(
  'b6a9b5a5bac52cc8ebd7a1c8cb2cb7bfd0cd2cc8ebd7a1c8d5c6da2cc0ebb5eac8d5c6da2cbce4cafd2cbdf0b6ee0d0a47424b3030312cd5c5c8fd2cb4f3b4b2b7bf2c323032362d31322d30312c323032362d31322d30332c312ca3a43630300d0a',
);
const TEXT = '订单号,入住人,房型,入住日期,离店日期,间数,金额\r\nGBK001,张三,大床房,2026-12-01,2026-12-03,1,￥600\r\n';
const headerOf = (csv: string) => csv.split(/\r?\n/)[0]!.split(',');

describe('导入用的表格文件', () => {
  it('GBK 的订单表自动识别：读出来的就是原文，必须有的列都认得出来', async () => {
    const payload = await readTablePayload(new File([GBK_ORDERS], '携程订单.csv'));
    expect(payload).toEqual({ csv: TEXT });
    expect(otaColumnProblem(detectOtaColumns(headerOf(payload.csv!)))).toBeNull();
    // 原来按 UTF-8 读：表头乱码，列认不出来
    const asUtf8 = new TextDecoder('utf-8').decode(GBK_ORDERS);
    expect(otaColumnProblem(detectOtaColumns(headerOf(asUtf8)))).not.toBeNull();
  });

  it('UTF-8（带不带 BOM）照常读；.xlsx 原样转 base64', async () => {
    const utf8 = new TextEncoder().encode(TEXT);
    expect(await readTablePayload(new File([utf8], 'a.csv'))).toEqual({ csv: TEXT });
    expect(await readTablePayload(new File([Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8])], 'a.csv'))).toEqual({ csv: TEXT });
    const xlsx = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);
    expect(await readTablePayload(new File([xlsx], '订单.XLSX'))).toEqual({ xlsxBase64: Buffer.from(xlsx).toString('base64') });
  });

  it('既不是 UTF-8 也不是 GBK：报错，不照常导入', async () => {
    await expect(readTablePayload(new File([Uint8Array.from([0x41, 0xff, 0xfe, 0x42])], 'a.csv'))).rejects.toThrow(FileEncodingError);
  });
});
