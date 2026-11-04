import { type ZodType, type z, ZodError } from 'zod';

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You cannot do that.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const badRequest = (message: string, fields?: Record<string, string>) => new HttpError(400, 'bad_request', message, fields);
export const tooMany = (message = 'Too many attempts. Try again in a few minutes.') => new HttpError(429, 'rate_limited', message);

export function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

/** Parse untrusted input or throw a 400 with per-field messages. */
export function parse<S extends ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = zodFields(result.error);
  const first = Object.values(fields)[0] ?? 'Invalid request.';
  throw badRequest(first, fields);
}

export { ZodError };
