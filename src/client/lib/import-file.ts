import { decodeImportFile } from '@shared/text-decode';

/** 读管理页选的导入文件：自动识别 UTF-8 / GBK；识别不了或有乱码时抛出错误（message 直接给员工看） */
export async function readImportFile(file: File): Promise<{ text: string; label: string }> {
  const { text, encoding } = decodeImportFile(new Uint8Array(await file.arrayBuffer()));
  return { text, label: encoding === 'GBK' ? `${file.name}（GBK 编码，已自动识别）` : file.name };
}
