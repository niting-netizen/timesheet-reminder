import type { ZodError } from 'zod';
import type { FieldError } from '../../shared/settings';

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public fieldErrors?: FieldError[],
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, fieldErrors?: FieldError[]) => new AppError(400, msg, fieldErrors);
export const notFound = (msg: string) => new AppError(404, msg);
export const conflict = (msg: string) => new AppError(409, msg);

export function fromZod(err: ZodError, prefix = ''): AppError {
  const fieldErrors = err.issues.map((i) => ({
    path: [prefix, ...i.path].filter((p) => p !== '').join('.'),
    message: i.message,
  }));
  return badRequest(`Some settings are not valid: ${fieldErrors[0]?.message ?? 'check the form'}.`, fieldErrors);
}
