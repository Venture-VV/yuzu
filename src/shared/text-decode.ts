// 导入文件的编码识别（R1.5）：柜号、价目表、期初三处导入共用，命令行与管理页都用。
// 中文 Excel / WPS「另存为 CSV」默认是 GBK（GB18030 兼容 GBK），不是 UTF-8，按 UTF-8 读会整份乱码。
// 先按 UTF-8 严格解码（带 BOM 的去掉 BOM）；不是合法 UTF-8 时按 GB18030 解码；
// 两种都解不了，或解出来带乱码字符（�），就报错，不照常导入。

export type FileEncoding = 'UTF-8' | 'GBK';

export class FileEncodingError extends Error {}

export function decodeImportFile(bytes: Uint8Array): { text: string; encoding: FileEncoding } {
  let decoded: { text: string; encoding: FileEncoding } | null = null;
  try {
    decoded = { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    try {
      decoded = { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'GBK' };
    } catch {
      decoded = null;
    }
  }
  if (!decoded) {
    throw new FileEncodingError('文件编码无法识别（不是 UTF-8，也不是 GBK）。请用 Excel 或 WPS「另存为 → CSV UTF-8（逗号分隔）」后再导入');
  }
  if (decoded.text.includes('�')) {
    throw new FileEncodingError('文件里有乱码字符（�）：可能被别的软件按错误的编码打开又保存过。请从原始数据重新导出，另存为 CSV UTF-8 后再导入');
  }
  return decoded;
}

/** 给员工看的编码说明：GBK 文件已自动转换 */
export const encodingNote = (encoding: FileEncoding) => (encoding === 'GBK' ? '文件是 GBK 编码（Excel / WPS 默认），已自动识别' : '');
