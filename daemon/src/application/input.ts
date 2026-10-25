// Checks on the fields of a request body. A wrong type is the caller's mistake, so each throws ActionError (a 400).
import { ActionError } from './errors.ts';

/** The body itself must be a JSON object. */
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ActionError('the request body must be a JSON object');
  return value as Record<string, unknown>;
}

/** Text, trimmed unless `raw`; undefined when absent. An empty string is an error unless `empty` is set. */
export function text(body: Record<string, unknown>, key: string, opts: { empty?: boolean; raw?: boolean } = {}): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ActionError(`${key} must be text`);
  const trimmed = opts.raw ? value : value.trim();
  if (!trimmed && !opts.empty) throw new ActionError(`${key} cannot be empty`);
  return trimmed;
}

/** Text or null (to clear a field); undefined when absent. */
export function textOrNull(body: Record<string, unknown>, key: string): string | null | undefined {
  return body[key] === null ? null : text(body, key, { empty: true });
}

/** A whole number from min to max; undefined when absent. */
export function whole(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new ActionError(`${key} must be a whole number from ${min} to ${max}`);
  return value;
}

/** A finite number; undefined when absent. */
export function number(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ActionError(`${key} must be a number`);
  return value;
}

/** true or false; undefined when absent. */
export function flag(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ActionError(`${key} must be true or false`);
  return value;
}

/** A list of text; undefined when absent. A comma-or-space separated string is accepted when `split` is set. */
export function list(body: Record<string, unknown>, key: string, opts: { split?: boolean } = {}): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (opts.split && typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ActionError(`${key} must be a list of text`);
  return value as string[];
}
