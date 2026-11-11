// What a use case needs to read a request: ActionError and the rules that raise it, finding the task or repo a person named (the one place these messages are worded), and checks on the fields of a request body.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import type { Task } from '#domain/work/index.ts';

export class ActionError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function refuse(message: string | null, code?: string): void {
  if (message) throw new ActionError(message, code);
}

export function requireTask(app: App, id: TaskId): Task {
  const task = app.getTask(id);
  if (!task) throw new ActionError('no such task');
  return task;
}

export function requireRepo(app: App, nameOrId: string | number): Repo {
  const repo = app.findRepo(String(nameOrId));
  if (!repo) throw new ActionError(`no repo "${nameOrId}"`);
  return repo;
}

export function requireTaskRepo(app: App, task: Task): Repo {
  const repo = app.getRepo(task.repo_id);
  if (!repo) throw new ActionError('the task has no repo');
  return repo;
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ActionError('the request body must be a JSON object');
  return value as Record<string, unknown>;
}

export function text(body: Record<string, unknown>, key: string, opts: { empty?: boolean; raw?: boolean } = {}): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ActionError(`${key} must be text`);
  const trimmed = opts.raw ? value : value.trim();
  if (!trimmed && !opts.empty) throw new ActionError(`${key} cannot be empty`);
  return trimmed;
}

export function textOrNull(body: Record<string, unknown>, key: string): string | null | undefined {
  return body[key] === null ? null : text(body, key, { empty: true });
}

export function whole(body: Record<string, unknown>, key: string, rule: (value: unknown) => string | null): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  const err = rule(value);
  if (err) throw new ActionError(err);
  return value as number;
}

export function number(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ActionError(`${key} must be a number`);
  return value;
}

export function flag(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ActionError(`${key} must be true or false`);
  return value;
}

const ON_WORDS = ['1', 'on', 'true', 'yes'];
const OFF_WORDS = ['0', 'off', 'false', 'no'];

export function onOff(key: string, value: string): boolean {
  const word = value.trim().toLowerCase();
  if (ON_WORDS.includes(word)) return true;
  if (OFF_WORDS.includes(word)) return false;
  throw new ActionError(`${key} takes ${ON_WORDS.join(', ')} or ${OFF_WORDS.join(', ')}, got "${value}"`);
}

export function list(body: Record<string, unknown>, key: string, opts: { split?: boolean } = {}): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (opts.split && typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ActionError(`${key} must be a list of text`);
  return value as string[];
}
