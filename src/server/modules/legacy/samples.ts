// 旧账的合成样例（v0.7.10）：四份文件的结构与原表一致（标题行、表头、合并格、公式、Excel 日期序号、文字日期、
// 合计行、超链接、WPS 单元格图、空行），内容是编的、金额是凑的假数。演示库、测试与验收都用它；
// 导入后核验页的每一个数写在 src/server/demo/legacy-expected.json。原始文件是真实业务数据，不进 Git。

import { deflateSync } from 'node:zlib';
import { crc32, zip } from '../../lib/xlsx';

// ───────────────────────── 仿 WPS 存的 .xlsx ─────────────────────────

type CellSpec = string | number | { f: string; v?: string | number } | null | undefined;

export interface SheetSpec {
  name: string;
  /** 行号 → 各列（从 A 起）的值；数字按数字存，文字按共享字符串存 */
  rows: Record<number, CellSpec[]>;
  /** 写出空行直到第几行（WPS 常带很多空的格式行） */
  emptyRowsUntil?: number;
  merges?: string[];
  hyperlinks?: { ref: string; url: string }[];
}

interface CellImageSpec {
  id: string;
  png: Buffer;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function buildWorkbook(sheets: SheetSpec[], images: CellImageSpec[] = []): Buffer {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const si = (s: string) => {
    let i = sharedIndex.get(s);
    if (i === undefined) {
      i = shared.length;
      shared.push(s);
      sharedIndex.set(s, i);
    }
    return i;
  };
  const files: { name: string; data: Buffer; store?: boolean }[] = [];
  const sheetXml = sheets.map((sh, idx) => {
    const lastRow = Math.max(sh.emptyRowsUntil ?? 0, ...Object.keys(sh.rows).map(Number));
    const rows: string[] = [];
    for (let r = 1; r <= lastRow; r++) {
      const cells = sh.rows[r];
      if (!cells) {
        if (r <= (sh.emptyRowsUntil ?? 0)) rows.push(`<row r="${r}" spans="1:10"/>`);
        continue;
      }
      const cs = cells
        .map((c, i) => {
          if (c === null || c === undefined || c === '') return '';
          const ref = `${colName(i)}${r}`;
          if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
          if (typeof c === 'string') return `<c r="${ref}" t="s"><v>${si(c)}</v></c>`;
          const cached = c.v === undefined ? '' : typeof c.v === 'number' ? `<v>${c.v}</v>` : `<v>${esc(c.v)}</v>`;
          return `<c r="${ref}"${typeof c.v === 'string' ? ' t="str"' : ''}><f>${esc(c.f)}</f>${cached}</c>`;
        })
        .join('');
      rows.push(`<row r="${r}">${cs}</row>`);
    }
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const links = sh.hyperlinks?.length ? `<hyperlinks>${sh.hyperlinks.map((h, i) => `<hyperlink ref="${h.ref}" r:id="rIdL${i}"/>`).join('')}</hyperlinks>` : '';
    if (sh.hyperlinks?.length) {
      files.push({
        name: `xl/worksheets/_rels/sheet${idx + 1}.xml.rels`,
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sh.hyperlinks
            .map((h, i) => `<Relationship Id="rIdL${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(h.url)}" TargetMode="External"/>`)
            .join('')}</Relationships>`,
        ),
      });
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${rows.join('')}</sheetData>${merges}${links}</worksheet>`;
  });
  const hasImages = images.length > 0;
  files.push(
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
          .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
          .join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${hasImages ? '<Override PartName="/xl/cellimages.xml" ContentType="application/vnd.wps-officedocument.cellimage+xml"/>' : ''}</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
          .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('')}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>${hasImages ? '<Relationship Id="rIdC" Type="http://www.wps.cn/officeDocument/2020/cellImage" Target="cellimages.xml"/>' : ''}</Relationships>`,
      ),
    },
    ...sheetXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(xml) })),
    {
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
          .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
          .join('')}</sst>`,
      ),
    },
  );
  if (hasImages) {
    files.push(
      {
        name: 'xl/cellimages.xml',
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><etc:cellImages xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData">${images
            .map(
              (img, i) =>
                `<etc:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="${img.id}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdI${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr/></xdr:pic></etc:cellImage>`,
            )
            .join('')}</etc:cellImages>`,
        ),
      },
      {
        name: 'xl/_rels/cellimages.xml.rels',
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${images
            .map((_, i) => `<Relationship Id="rIdI${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`)
            .join('')}</Relationships>`,
        ),
      },
      ...images.map((img, i) => ({ name: `xl/media/image${i + 1}.png`, data: img.png, store: true })),
    );
  }
  return zip(files);
}

/** 纯色小图（8×8 PNG） */
export function solidPng(r: number, g: number, b: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 8 }, () => [r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** YYYY-MM-DD → Excel 日期序号 */
const serial = (date: string) => (Date.parse(`${date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;

// ───────────────────────── 四份样例 ─────────────────────────

function purchaseLedgerSample(): Buffer {
  const D = serial;
  return buildWorkbook([
    {
      name: 'Sheet1',
      merges: ['A1:I1', 'A2:I2', 'E8:E9'],
      rows: {
        1: ['费用报销明细表（合成样例）'],
        2: ['单位：样例公司                报销人：                单位：元'],
        3: ['序号', '日期', '类别', '数量', '金额', '商户', '用途', '是否有发票', '备注'],
        4: [null, null, null, null, { f: '-3000-500', v: -3500 }],
        5: [1, D('2026-08-31'), '样例-抹布', 10, 120, '样例网店', '保洁', '普通发票'],
        6: [2, D('2026-08-31'), '样例-拖把', 2, 80, '样例网店', '保洁'],
        // 没存结果的公式：精确算是 45.495 → ¥45.50（用二进制浮点数算会得 45.49499… → ¥45.49）
        7: [3, null, '样例-洗洁精', 3, { f: '64.005-18.51' }, '样例超市', '厨房'],
        8: [4, D('2026-09-01'), '样例-托盘', 4, 600, '样例网店', '客房'],
        9: [5, D('2026-09-01'), '样例-托盘垫', 4, null, '样例网店', '客房'],
        10: [6, D('2026-09-01'), '样例-抹布退货', 1, -20, '样例网店', '保洁', null, '退货退款'],
        11: [7, null, null, null, -2500],
        12: [8, D('2026-09-02'), '样例-保险柜', 1, 1200, '样例网店', '前台', '专用发票'],
        13: [9, D('2026-09-02'), null, null, 300, '样例超市'],
        14: [10, D('2026-09-02'), '样例-退回', 1, -1000, null, null, null, '退回出纳'],
        15: [11, null, null, null, { f: '-1500-500' }],
        16: [12, D('2026-09-03'), '样例-垃圾袋', '2+2', 50, '样例超市', '保洁'],
        17: [13, D('2026-09-03'), '样例-纸巾', 5, null, '样例超市', '保洁'],
        18: [14, '2026/9/4', '样例-毛巾', 10, 199.99, '样例网店', '客房'],
      },
    },
    {
      name: 'Sheet2',
      rows: {
        1: ['日期', '打款金额', '应退回金额', '退回出纳', '备注'],
        2: [D('2026-08-31'), { f: '3000+500', v: 3500 }, { f: '3300', v: 3300 }, 3300, '样例：老板代付，已原路退回'],
        3: [D('2026-09-01'), 600, 20],
        4: [D('2026-09-02'), 2500, 900, 1000],
        5: [D('2026-09-03')],
        6: [D('2026-09-04'), 200, 0.5],
        7: [D('2026-09-05'), 2000, 1950, 1950],
        8: ['合计', { f: 'B2+B3+B4+B5+B6+B7', v: 8800 }, { f: 'C2+C3+C4+C5+C6+C7', v: 6170.5 }, { f: 'D2+D3+D4+D5+D6+D7', v: 6250 }],
      },
      emptyRowsUntil: 10,
    },
  ]);
}

function materialDetailSample(): Buffer {
  const D = serial;
  const header = ['序号', '购买日期', '物品名', '用途', '金额', '购买数量', '到货数量', '部门', '发票（专票、普票）', '税点', '备注（办公费、固定资产、低值易耗等）'];
  return buildWorkbook([
    {
      name: '8月',
      merges: ['A1:K1', 'E6:E7'],
      rows: {
        1: ['采购物资明细表（合成样例）'],
        2: header,
        3: [1, D('2026-08-31'), '样例-水杯', '采样', 9.9, 2, 2, '餐厅', '普票', 0.01, '固定资产'],
        4: [2, D('2026-08-31'), '样例-托盘', null, 190, 4, 3, '男女宾、餐厅', '普通', 0.13, '低值耗材'],
        5: [3, D('2026-08-31')],
        6: [4, D('2026-08-31'), '样例-清洁剂', null, 60, 1, 1, '厨房耗材', '专票', 0.13, '耗材'],
        // 收据只能是 0 税点：第 5 条算对不上字典
        7: [5, D('2026-08-31'), '样例-清洁布', null, null, 1, 1, '保洁', '收据', 0.03, '低值易耗'],
      },
      emptyRowsUntil: 12,
    },
    {
      name: '9月',
      merges: ['A1:K1'],
      rows: {
        1: ['采购物资明细表（合成样例）'],
        2: header,
        3: [1, D('2026-09-02'), '样例-椅子', null, 1000, 2, 2, '前厅', '专票', 0.13, '固定资产'],
        4: [2, D('2026-09-02'), '样例-抹布', null, 30.5, 5, 5, '保洁', null, null, '低值易耗'],
        5: [3],
      },
      emptyRowsUntil: 8,
    },
    { name: '10月', merges: ['A1:K1'], rows: { 1: ['采购物资明细表（合成样例）'], 2: header }, emptyRowsUntil: 6 },
  ]);
}

function orderedMaterialsSample(): Buffer {
  const D = serial;
  const img = (id: string) => ({ f: `_xlfn.DISPIMG("${id}",1)`, v: '' });
  const header = ['下单时间', '产品名称', '图片', '选款', '部门', '下单人', '数量', '金额', '备注'];
  return buildWorkbook(
    [
      {
        name: '10月',
        merges: ['C3:C4'],
        rows: {
          1: header,
          2: [D('2026-10-23'), '样例-沙发套', img('ID_SAMPLE_A'), '深灰;单人', '运营', '样例员工甲', 6, 96],
          3: [D('2026-10-23'), '样例-乳酪', img('ID_SAMPLE_B'), '1kg', '厨房', '样例员工甲', 1, 18.7],
          4: [D('2026-10-24'), '样例-芝士', null, '1kg', '厨房', '样例员工甲', 1, 45],
          5: [D('2026-10-26'), '样例-半身裙', null, '均码', '品牌', '样例员工乙', 1, 99],
          6: [D('2026-10-26'), '样例-半身裙', img('ID_SAMPLE_A'), '均码', '品牌', '样例员工乙', 1, 99],
        },
        emptyRowsUntil: 9,
      },
      { name: '11月', rows: { 1: header }, emptyRowsUntil: 4 },
    ],
    [
      { id: 'ID_SAMPLE_A', png: solidPng(0x2f, 0x6f, 0x5e) },
      { id: 'ID_SAMPLE_B', png: solidPng(0xe0, 0xa8, 0x2e) },
    ],
  );
}

function brandRequestsSample(): Buffer {
  return buildWorkbook([
    {
      name: '工作表1',
      merges: ['A1:J1'],
      rows: {
        1: ['品牌新增寻款采购清单（合成样例）'],
        2: ['序号', '是否下单', '是否到货', '是否退货', '产品名称', '用途', '采购数量', '备注', '产品详情', '参考链接渠道'],
        3: [1, '是', '是', null, '样例-玻璃杯', '客房漱口', 19, '大货', '水波杯 300ml', '样例店铺 玻璃杯'],
        4: [2, '是', '是', '是', '样例-托盘', '客房桌面', 9, null, '方舟托盘 30×24', '样例店铺 托盘'],
        // 没有超链接，网址写在分享文字里：算有链接
        5: [3, '是', null, null, '样例-垃圾桶', '淋浴间', 1, '样品采购', '米白', '【样例】垃圾桶 https://example.com/sample/3 点击链接直接打开'],
        // 只写了店铺名称、没有网址：算没有链接
        6: [4, null, null, null, '样例-香薰', null, null, null, null, '样例店铺 香薰'],
        7: [5],
      },
      emptyRowsUntil: 12,
      hyperlinks: [
        { ref: 'J3', url: 'https://example.com/sample/1' },
        { ref: 'J4', url: 'https://example.com/sample/2' },
      ],
    },
  ]);
}

export interface LegacySampleFile {
  name: string;
  data: Buffer;
}

/** 四份合成样例（与原表同样的文件名，后面加「（合成样例）」） */
export function legacySampleFiles(): LegacySampleFile[] {
  return [
    { name: '采购台账（合成样例）.xlsx', data: purchaseLedgerSample() },
    { name: '采购物资明细表（合成样例）.xlsx', data: materialDetailSample() },
    { name: '已下单物料（合成样例）.xlsx', data: orderedMaterialsSample() },
    { name: '品牌新增寻款采购清单（合成样例）.xlsx', data: brandRequestsSample() },
  ];
}
