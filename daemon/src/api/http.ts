// The generic part of the HTTP API: reading a request, answering it, CORS, and dispatching to routes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ActionError, type ChangeWatcher, type DaemonInfo, type ReloadFacts, type Scheduler } from '../application/actions.ts';
import { API_ALLOWED_ORIGINS } from '../config.ts';
import type { Db } from '../db/index.ts';

/** What the API needs of the scheduler: `wake` after a change that may let queued work start, `track` for runs it starts. */
export type ApiScheduler = Pick<Scheduler, 'wake' | 'track'>;

/** What the route files share: the database, the scheduler to wake, and facts about this daemon process. */
export interface ApiContext {
  db: Db;
  scheduler: ApiScheduler;
  /** The change stream behind GET /api/events. */
  changes: Pick<ChangeWatcher, 'rev' | 'subscribe'>;
  daemon: { info: DaemonInfo; requestRestart: () => void; reloadFacts: () => ReloadFacts };
}

/** Biggest request body accepted. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** A request the client got wrong: answered 400. */
export class BadRequest extends Error {}
/** A body over MAX_BODY_BYTES: answered 413. */
export class PayloadTooLarge extends Error {}

/** What a route handler gets. A handler that writes `res` itself (a stream) returns undefined. */
export interface Call {
  req: IncomingMessage;
  res: ServerResponse;
  /** The captured groups of the path pattern. */
  params: string[];
  /** The parsed JSON body of a POST; {} when there is none. */
  body: Record<string, unknown>;
  query: URLSearchParams;
}

export interface Route {
  method: string;
  path: RegExp;
  handle: (call: Call) => unknown | Promise<unknown>;
}

export const route = (method: string, path: RegExp, handle: Route['handle']): Route => ({ method, path, handle });

export function send(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export const queryOf = (req: IncomingMessage): URLSearchParams => new URL(req.url ?? '/', 'http://x').searchParams;

/** The JSON object in the body; {} when empty. Reads all of an oversized body (keeping none of it) so the client can read the answer. */
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

/** Handle one request: CORS, then the first route that matches, with errors mapped to status codes. */
export async function dispatch(routes: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Browsers may only call us from the dashboard. Requests with no Origin (curl, the CLI) are fine.
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
