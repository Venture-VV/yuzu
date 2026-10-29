import { z } from 'zod';
import { badRequest } from './errors';

/** 校验请求体，失败时返回第一条中文提示。 */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.');
    throw badRequest(issue?.message ?? '提交的数据格式不正确', field ? { field } : undefined);
  }
  return result.data;
}

export const idParam = z.object({ id: z.coerce.number().int().positive('编号不正确') });
export const cents = (label: string) =>
  z.number(`${label}必须是数字`).int(`${label}必须精确到分`).nonnegative(`${label}不能为负数`).max(1_000_000_000, `${label}过大`);
export const positiveCents = (label: string) => cents(label).positive(`${label}必须大于 0`);
