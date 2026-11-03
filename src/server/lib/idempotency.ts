// 操作编号（幂等键）的共用小工具：原请求的摘要（同一编号重提时比对内容是否一致）。
// 各模块原来各写一份同样的实现（v0.7.22 代码整理时合到这里）。

import { createHash } from 'node:crypto';

/** 原请求的摘要：按 JSON 序列化后取 SHA-256；同一编号重提时内容不同的拒绝 */
export const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
