// 导入文件的编码识别（R1.5）：UTF-8（带不带 BOM）照常读；中文 Excel / WPS 默认的 GBK 自动识别；
// 两种都不是，或带乱码字符时报错，不照常导入。柜号、价目表、期初三处导入都用同一个函数。

import { describe, expect, it } from 'vitest';
import { parseHandTagCsv } from '../src/shared/hand-tag-import';
import { parseOpeningCsv } from '../src/shared/opening-import';
import { decodeImportFile, FileEncodingError } from '../src/shared/text-decode';

const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
// 「姓名,手机号,本金,赠金,累计充值 / 张三,13800001234,100.50,20,3000」按 GBK 存
const GBK_OPENING = hex(
  'd0d5c3fb2ccad6bbfabac52cb1bebdf02cd4f9bdf02cc0dbbcc6b3e4d6b50d0ad5c5c8fd2c31333830303030313233342c3130302e35302c32302c333030300d0a',
);
// 「柜号,性别,类型,等级 / A8001,男,普通,」按 GBK 存
const GBK_TAGS = hex('b9f1bac52cd0d4b1f02cc0e0d0cd2cb5c8bcb60d0a41383030312cc4d02cc6d5cda82c0d0a');

describe('导入文件的编码识别', () => {
  it('UTF-8 照常读，带 BOM 的去掉 BOM', () => {
    const text = '姓名,手机号\n张三,13800001234\n';
    expect(decodeImportFile(new TextEncoder().encode(text))).toEqual({ text, encoding: 'UTF-8' });
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(decodeImportFile(withBom)).toEqual({ text, encoding: 'UTF-8' });
  });

  it('GBK（中文 Excel / WPS 默认）自动识别，解析出的中文表头与内容正确', () => {
    const opening = decodeImportFile(GBK_OPENING);
    expect(opening.encoding).toBe('GBK');
    const parsed = parseOpeningCsv(opening.text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ name: '张三', phone: '13800001234', principal: 10050, bonus: 2000, totalRecharged: 300000 });

    const tags = decodeImportFile(GBK_TAGS);
    expect(tags.encoding).toBe('GBK');
    expect(parseHandTagCsv(tags.text).rows[0]).toMatchObject({ code: 'A8001', zone: 'male', kind: 'normal' });
  });

  it('既不是 UTF-8 也不是 GBK：报错，不照常导入', () => {
    expect(() => decodeImportFile(Uint8Array.from([0x41, 0xff, 0xfe, 0x42]))).toThrow(FileEncodingError);
    expect(() => decodeImportFile(Uint8Array.from([0x41, 0xff, 0xfe, 0x42]))).toThrow(/编码无法识别/);
  });

  it('文件里已经有乱码字符（被错误的编码打开又保存过）：报错', () => {
    expect(() => decodeImportFile(new TextEncoder().encode('姓名,手机号\n张�,13800001234\n'))).toThrow(/乱码/);
  });
});
