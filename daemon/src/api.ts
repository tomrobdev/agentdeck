// Local HTTP API for the dashboard: JSON endpoints plus a Server-Sent Events log tail.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import * as actions from './actions.ts';
import { API_ALLOWED_ORIGINS, API_PORT } from './config.ts';
import { serviceStatus } from './service.ts';
import type { Db, TaskStatus } from './db.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], body: any) => unknown | Promise<unknown>;

const LOG_POLL_MS = 500;

function send(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function taskDetail(db: Db, id: number) {
  const task = db.getTask(id);
  if (!task) throw new actions.ActionError('no such task');
  return { ...task, repo: db.getRepo(task.repo_id)?.name ?? null, runs: db.runsForTask(id) };
}

/** Stream a run's log as SSE: everything so far, then new lines until the run ends. */
function streamLog(db: Db, req: IncomingMessage, res: ServerResponse, taskId: number, attempt?: number): void {
  const runs = db.runsForTask(taskId);
  const run = attempt ? runs.find((r) => r.attempt === attempt) : runs.at(-1);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (!run) {
    res.write('event: end\ndata: {}\n\n');
    return void res.end();
  }

  let offset = 0;
  let partial = '';
  const pump = () => {
    if (existsSync(run.log_path)) {
      const size = statSync(run.log_path).size;
      if (size > offset) {
        const fd = openSync(run.log_path, 'r');
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = size;
        const lines = (partial + buf.toString('utf8')).split('\n');
        partial = lines.pop() ?? '';
        const entries = lines.flatMap(actions.parseLogLine);
        if (entries.length) res.write(`data: ${JSON.stringify(entries)}\n\n`);
      }
    }
    const current = db.runsForTask(taskId).find((r) => r.id === run.id);
    if (current?.ended_at) {
      res.write('event: end\ndata: {}\n\n');
      res.end();
      clearInterval(timer);
    }
  };
  const timer = setInterval(pump, LOG_POLL_MS);
  req.on('close', () => clearInterval(timer));
  pump();
}

export function startApi(db: Db, port = API_PORT): Promise<Server> {
  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/status$/, () => actions.status(db)],
    ['POST', /^\/api\/pause$/, () => (actions.setPaused(db, true), actions.status(db))],
    ['POST', /^\/api\/resume$/, () => (actions.setPaused(db, false), actions.status(db))],
    ['GET', /^\/api\/settings$/, () => actions.getSettings(db)],
    ['GET', /^\/api\/service$/, () => serviceStatus()],
    ['POST', /^\/api\/settings$/, (_q, _s, _p, b) => actions.updateSettings(db, b)],
    ['POST', /^\/api\/notify\/test$/, async () => (await actions.sendTestNotification(db), { ok: true })],
    ['GET', /^\/api\/repos$/, () => db.listRepos()],
    ['POST', /^\/api\/repos$/, (_q, _s, _p, b) => actions.addRepo(db, b)],
    ['GET', /^\/api\/repos\/(\d+)$/, (_q, _s, [id]) => actions.repoDetail(db, Number(id))],
    ['POST', /^\/api\/repos\/(\d+)$/, (_q, _s, [id], b) => actions.updateRepo(db, Number(id), b)],
    ['POST', /^\/api\/repos\/(\d+)\/plan$/, (_q, _s, [id]) => actions.planNow(db, Number(id))],
    ['POST', /^\/api\/tasks\/(\d+)\/approve$/, (_q, _s, [id]) => (actions.approveTask(db, Number(id)), taskDetail(db, Number(id)))],
    ['POST', /^\/api\/tasks\/(\d+)\/reject$/, (_q, _s, [id]) => (actions.rejectTask(db, Number(id)), taskDetail(db, Number(id)))],
    [
      'GET',
      /^\/api\/tasks$/,
      (req) => {
        const status = new URL(req.url!, 'http://x').searchParams.get('status') as TaskStatus | null;
        const names = new Map(db.listRepos().map((r) => [r.id, r.name]));
        return db.listTasks(status ?? undefined).map((t) => ({ ...t, repo: names.get(t.repo_id) ?? null }));
      },
    ],
    ['POST', /^\/api\/tasks$/, (_q, _s, _p, b) => taskDetail(db, actions.addTask(db, b).id)],
    ['GET', /^\/api\/tasks\/(\d+)$/, (_q, _s, [id]) => taskDetail(db, Number(id))],
    ['POST', /^\/api\/tasks\/(\d+)\/cancel$/, (_q, _s, [id]) => ({ result: actions.cancelTask(db, Number(id)) })],
    ['POST', /^\/api\/tasks\/(\d+)\/retry$/, (_q, _s, [id]) => (actions.retryTask(db, Number(id)), taskDetail(db, Number(id)))],
    [
      'GET',
      /^\/api\/tasks\/(\d+)\/log$/,
      (req, res, [id]) => {
        const attempt = Number(new URL(req.url!, 'http://x').searchParams.get('attempt')) || undefined;
        streamLog(db, req, res, Number(id), attempt);
        return undefined; // streamLog owns the response
      },
    ],
  ];

  const server = createServer(async (req, res) => {
    // Browsers may only call us from the dashboard. Requests with no Origin (curl, the CLI) are fine.
    const origin = req.headers.origin;
    if (origin) {
      if (!API_ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'origin not allowed' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      return void res.end();
    }

    const path = new URL(req.url ?? '/', 'http://x').pathname;
    for (const [method, re, handler] of routes) {
      const m = path.match(re);
      if (!m || req.method !== method) continue;
      try {
        const isJson = req.headers['content-type']?.startsWith('application/json');
        const body = method === 'POST' && isJson ? await readBody(req) : {};
        const out = await handler(req, res, m.slice(1), body);
        if (out !== undefined) send(res, 200, out);
      } catch (err) {
        if (err instanceof actions.ActionError || err instanceof SyntaxError) send(res, 400, { error: err.message });
        else {
          console.error(err);
          send(res, 500, { error: 'internal error' });
        }
      }
      return;
    }
    send(res, 404, { error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
