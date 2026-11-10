// The generic part of the HTTP API: reading a request, answering it, CORS, and dispatching to routes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ActionError,
  type ChangeWatcher,
  type ComposedApp,
  type DaemonInfo,
  type ReloadFacts,
  type Scheduler,
} from '../application/actions.ts';
import { API_ALLOWED_ORIGINS } from '../config.ts';
import { type RepoId, type ReviewId, type TaskId, parseId } from '../domain/shared/index.ts';
import { parseTaskIds } from '../domain/work/index.ts';

export type ApiScheduler = Pick<Scheduler, 'wake' | 'track'>;

export interface ApiContext {
  db: ComposedApp;
  scheduler: ApiScheduler;
  changes: Pick<ChangeWatcher, 'rev' | 'subscribe'>;
  daemon: { info: DaemonInfo; requestRestart: () => void; reloadFacts: () => ReloadFacts };
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class BadRequest extends Error {}
export class PayloadTooLarge extends Error {}

export interface Call {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  body: Record<string, unknown>;
  query: URLSearchParams;
}

export interface Route {
  method: string;
  path: RegExp;
  handle: (call: Call) => unknown | Promise<unknown>;
}

export const route = <T = never>(
  method: string,
  path: RegExp,
  handle: (call: Call) => NoInfer<T> | Promise<NoInfer<T>> | undefined,
): Route => ({ method, path, handle });

export function idsField(body: Record<string, unknown>, key: string, opts: { required?: boolean } = {}): TaskId[] {
  const ids = opts.required && body[key] === undefined ? null : parseTaskIds(body[key]);
  if (!ids) throw new BadRequest(`${key} must be a list of task ids`);
  return ids;
}

export function taskIdParam(text: string): TaskId {
  const id = parseId<TaskId>(text);
  if (id === null) throw new BadRequest(`${text} is not a task id`);
  return id;
}

export function repoIdParam(text: string): RepoId {
  const id = parseId<RepoId>(text);
  if (id === null) throw new BadRequest(`${text} is not a repo id`);
  return id;
}

export function reviewIdParam(text: string): ReviewId {
  const id = parseId<ReviewId>(text);
  if (id === null) throw new BadRequest(`${text} is not a review id`);
  return id;
}

export function send(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export const queryOf = (req: IncomingMessage): URLSearchParams => new URL(req.url ?? '/', 'http://x').searchParams;

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size <= MAX_BODY_BYTES) chunks.push(c as Buffer);
  }
  if (size > MAX_BODY_BYTES) throw new PayloadTooLarge(`the request body is over ${MAX_BODY_BYTES / 1024 / 1024} MB`);
  if (!size) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('the request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new BadRequest('the request body must be a JSON object');
  return parsed as Record<string, unknown>;
}

export async function dispatch(routes: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin;
  if (origin) {
    if (!API_ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'origin not allowed' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return void res.end();
  }

  const path = new URL(req.url ?? '/', 'http://x').pathname;
  for (const r of routes) {
    const m = path.match(r.path);
    if (!m || req.method !== r.method) continue;
    try {
      const isJson = req.headers['content-type']?.startsWith('application/json');
      const body = r.method === 'POST' && isJson ? await readBody(req) : {};
      const out = await r.handle({ req, res, params: m.slice(1), body, query: queryOf(req) });
      if (out !== undefined) send(res, 200, out);
    } catch (err) {
      if (res.headersSent) {
        console.error(err);
        return void res.destroy();
      }
      if (err instanceof PayloadTooLarge) send(res, 413, { error: err.message });
      else if (err instanceof ActionError || err instanceof BadRequest) send(res, 400, { error: err.message });
      else {
        console.error(err);
        send(res, 500, { error: 'internal error' });
      }
    }
    return;
  }
  send(res, 404, { error: 'not found' });
}
