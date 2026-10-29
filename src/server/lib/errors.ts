// 业务错误：带 HTTP 状态码、稳定的错误码和面向员工的中文提示。

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = '请先登录') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = '当前岗位没有这项操作的权限') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message: string) => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(422, code, message, details);
