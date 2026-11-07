// What a use case needs to read a request: ActionError and the rules that raise it, finding the task or repo a person
// named (the one place these messages are worded), and checks on the fields of a request body. A wrong type is the
// caller's mistake, so each throws ActionError (a 400).
import type { Db } from '../db/index.ts';
import type { TaskId } from '../domain/id/id.ts';
import type { Repo } from '../domain/repo/repo.ts';
import type { Task } from '../domain/task/task.ts';

/** Bad input to a use case. The CLI prints it; the API answers 400. */
export class ActionError extends Error {}

/** Turn a domain rule's message into an ActionError; a null message means the input is fine. */
export function refuse(message: string | null): void {
  if (message) throw new ActionError(message);
}

export function requireTask(db: Db, id: TaskId): Task {
  const task = db.getTask(id);
  if (!task) throw new ActionError('no such task');
  return task;
}

export function requireRepo(db: Db, nameOrId: string | number): Repo {
  const repo = db.findRepo(String(nameOrId));
  if (!repo) throw new ActionError(`no repo "${nameOrId}"`);
  return repo;
}

/** The repo a task belongs to. */
export function requireTaskRepo(db: Db, task: Task): Repo {
  const repo = db.getRepo(task.repo_id);
  if (!repo) throw new ActionError('the task has no repo');
  return repo;
}

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

/** A number the field's domain rule accepts (it knows the limits and the message); undefined when absent. */
export function whole(body: Record<string, unknown>, key: string, rule: (value: unknown) => string | null): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  const err = rule(value);
  if (err) throw new ActionError(err);
  return value as number;
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

const ON_WORDS = ['1', 'on', 'true', 'yes'];
const OFF_WORDS = ['0', 'off', 'false', 'no'];

/** An on/off word typed by a person (`on`, `off`, and the synonyms the help lists); anything else is refused. */
export function onOff(key: string, value: string): boolean {
  const word = value.trim().toLowerCase();
  if (ON_WORDS.includes(word)) return true;
  if (OFF_WORDS.includes(word)) return false;
  throw new ActionError(`${key} takes ${ON_WORDS.join(', ')} or ${OFF_WORDS.join(', ')}, got "${value}"`);
}

/** A list of text; undefined when absent. A comma-or-space separated string is accepted when `split` is set. */
export function list(body: Record<string, unknown>, key: string, opts: { split?: boolean } = {}): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (opts.split && typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ActionError(`${key} must be a list of text`);
  return value as string[];
}
