// 最简单的 Word 文件（.docx，WordprocessingML）：标题、段落、表格、页眉一行字（8.0.21 合同导出，docs/FINANCE_V8021.md 第 6 节）。
// 只用已有的 zip（lib/xlsx），不引入别的库。字体交给 Word：中文用宋体。

import type { DocBlock } from '@shared/contract-templates';
import { zip } from './xlsx';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = '<w:rFonts w:ascii="SimSun" w:hAnsi="SimSun" w:eastAsia="宋体" w:cs="SimSun"/>';

function run(text: string, opts: { bold?: boolean; size?: number } = {}) {
  // 段落里的换行变成 Word 的换行
  const parts = text.split('\n');
  const props = `<w:rPr>${FONT}${opts.bold ? '<w:b/>' : ''}<w:sz w:val="${opts.size ?? 22}"/><w:szCs w:val="${opts.size ?? 22}"/></w:rPr>`;
  return parts.map((p, i) => `<w:r>${props}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(p)}</w:t></w:r>`).join('');
}
const para = (text: string, opts: { bold?: boolean; size?: number; center?: boolean; spacingAfter?: number } = {}) =>
  `<w:p><w:pPr>${opts.center ? '<w:jc w:val="center"/>' : ''}<w:spacing w:after="${opts.spacingAfter ?? 120}" w:line="360" w:lineRule="auto"/></w:pPr>${run(text, opts)}</w:p>`;

function table(header: string[], rows: string[][]) {
  const cell = (t: string, bold = false) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(t, { bold, size: 20, spacingAfter: 0 })}</w:tc>`;
  const border = '<w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/>';
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>` +
    `<w:tr>${header.map((h) => cell(h, true)).join('')}</w:tr>` +
    rows.map((r) => `<w:tr>${r.map((c) => cell(c)).join('')}</w:tr>`).join('') +
    '</w:tbl>' +
    para('', { spacingAfter: 60 })
  );
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export function buildDocx(blocks: DocBlock[], headerText: string): Buffer {
  let first = true;
  const body = blocks
    .map((b) => {
      if (b.kind === 'table') return table(b.header, b.rows);
      if (b.kind === 'heading') {
        const out = para(b.text, { bold: true, size: first ? 32 : 24, center: first, spacingAfter: first ? 240 : 120 });
        first = false;
        return out;
      }
      return para(b.text);
    })
    .join('');
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body}` +
    `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${NS}>${para(headerText, { size: 18, spacingAfter: 0 })}</w:hdr>`;
  return zip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>`,
      ),
    },
    { name: 'word/document.xml', data: Buffer.from(document) },
    { name: 'word/header1.xml', data: Buffer.from(header) },
  ]);
}
