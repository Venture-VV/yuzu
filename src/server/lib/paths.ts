// 按这次请求实际进入的路径判断接口前缀，不按原始地址：原始地址里的字符可能做了 URL 编码（例如 /api/%69nventory），
// 路由按解码后的路径匹配，前缀判断要和路由一致（测试会话复测 v0.7.3 的 P1：关掉的 ERP 模块用编码地址仍能读写）。

import type { FastifyRequest } from 'fastify';

/** 原始地址的路径部分，按 URL 编码解开（解不开的按原样） */
export function decodedPath(url: string): string {
  const path = url.split('?', 1)[0] ?? '';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** 接口请求：解码后的路径或匹配到的路由在 /api/ 下（来源检查、读会话、404 的回复按它） */
export function isApiRequest(req: FastifyRequest): boolean {
  return decodedPath(req.url).startsWith('/api/') || (req.routeOptions.url ?? '').startsWith('/api/');
}

/** 这次请求进入的接口：匹配到的路由（形如 /api/inventory/materials/:id）；没匹配到时按解码后的路径 */
export function routePath(req: FastifyRequest): string {
  return req.routeOptions.url ?? decodedPath(req.url);
}
