// Local HTTP API for the dashboard: JSON endpoints plus a Server-Sent Events log tail.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { serviceStatus } from '../adapters/service.ts';
import * as actions from '../application/actions.ts';
import { unblocksOf, waitingFor } from '../application/dependencies.ts';
import { startHolds } from '../application/queue.ts';
import { API_ALLOWED_ORIGINS, API_PORT } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { TaskStatus } from '../domain/task/lifecycle.ts';
import { streamLog } from './log-stream.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], body: any) => unknown | Promise<unknown>;

function send(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const query = (req: IncomingMessage) => new URL(req.url!, 'http://x').searchParams;

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function taskDetail(db: Db, id: number) {
  const task = db.getTask(id);
  if (!task) throw new actions.ActionError('no such task');
  return {
    ...task,
    repo: db.getRepo(task.repo_id)?.name ?? null,
    waiting: waitingFor(db, task),
    unblocks: unblocksOf(db, task),
    hold: startHolds(db)(task),
    runs: db.runsForTask(id),
    events: db.eventsForTask(id),
    plans: db.plansForTask(id),
  };
}

/** `wake` runs after a change that may let queued work start, such as a merge (the scheduler's `wake`). */
export function startApi(
  db: Db,
  port = API_PORT,
  wake: () => void = () => {},
  daemon: { info: actions.DaemonInfo; requestRestart: () => void } = {
    info: { commit: null, started_at: new Date().toISOString() },
    requestRestart: () => {},
  },
): Promise<Server> {
  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/status$/, () => actions.status(db, daemon.info)],
    ['POST', /^\/api\/pause$/, () => (actions.setPaused(db, true), actions.status(db, daemon.info))],
    ['POST', /^\/api\/resume$/, () => (actions.setPaused(db, false), actions.status(db, daemon.info))],
    ['POST', /^\/api\/daemon\/restart$/, () => actions.restartDaemon(db, daemon.requestRestart)],
    ['GET', /^\/api\/settings$/, () => actions.getSettings(db)],
    ['GET', /^\/api\/service$/, () => serviceStatus()],
    ['POST', /^\/api\/settings$/, (_q, _s, _p, b) => actions.updateSettings(db, b)],
    ['POST', /^\/api\/notify\/test$/, async () => (await actions.sendTestNotification(db), { ok: true })],
    ['GET', /^\/api\/repos$/, () => db.listRepos()],
    ['POST', /^\/api\/repos$/, (_q, _s, _p, b) => actions.addRepo(db, b)],
    ['GET', /^\/api\/repos\/(\d+)$/, (_q, _s, [id]) => actions.repoDetail(db, Number(id))],
    ['POST', /^\/api\/repos\/(\d+)$/, (_q, _s, [id], b) => actions.updateRepo(db, Number(id), b)],
    ['POST', /^\/api\/repos\/(\d+)\/plan$/, (_q, _s, [id]) => actions.planNow(db, Number(id))],
    ['POST', /^\/api\/repos\/(\d+)\/doctor$/, (_q, _s, [id]) => actions.doctorRepo(db, Number(id))],
    ['POST', /^\/api\/repos\/(\d+)\/resume$/, (_q, _s, [id]) => actions.resumeRepo(db, Number(id))],
    ['POST', /^\/api\/tasks\/(\d+)\/approve$/, (_q, _s, [id]) => (actions.approveTask(db, Number(id)), taskDetail(db, Number(id)))],
    ['POST', /^\/api\/tasks\/(\d+)\/reject$/, (_q, _s, [id]) => (actions.rejectTask(db, Number(id)), taskDetail(db, Number(id)))],
    [
      'GET',
      /^\/api\/tasks$/,
      (req) => {
        const q = new URL(req.url!, 'http://x').searchParams;
        const status = q.get('status') as TaskStatus | null;
        const limit = Math.min(Math.max(Math.floor(Number(q.get('limit'))) || 200, 1), 1000);
        const before = Number(q.get('before')) || undefined;
        const names = new Map(db.listRepos().map((r) => [r.id, r.name]));
        const holdOf = startHolds(db);
        return db.listTaskSummaries({ status: status ?? undefined, limit, before }).map((t) => ({
          ...t,
          repo: names.get(t.repo_id) ?? null,
          waiting: waitingFor(db, t),
          unblocks: unblocksOf(db, t),
          hold: holdOf(t),
        }));
      },
    ],
    ['POST', /^\/api\/tasks$/, (_q, _s, _p, b) => taskDetail(db, actions.addTask(db, b).id)],
    ['GET', /^\/api\/tasks\/(\d+)$/, (_q, _s, [id]) => taskDetail(db, Number(id))],
    ['POST', /^\/api\/tasks\/(\d+)$/, (_q, _s, [id], b) => (actions.editTask(db, Number(id), b), taskDetail(db, Number(id)))],
    ['POST', /^\/api\/tasks\/(\d+)\/cancel$/, (_q, _s, [id]) => ({ result: actions.cancelTask(db, Number(id)) })],
    ['POST', /^\/api\/tasks\/(\d+)\/retry$/, (_q, _s, [id], b) => (actions.retryTask(db, Number(id), b?.note), taskDetail(db, Number(id)))],
    [
      'POST',
      /^\/api\/tasks\/(\d+)\/close-pr$/,
      async (_q, _s, [id]) => (await actions.closeTaskPr(db, Number(id)), taskDetail(db, Number(id))),
    ],
    // Merge the task's PR. GET is the preview the confirm dialog shows; POST merges and wakes the scheduler so dependents start now.
    ['GET', /^\/api\/tasks\/(\d+)\/merge$/, (_q, _s, [id]) => actions.mergePreview(db, Number(id))],
    [
      'POST',
      /^\/api\/tasks\/(\d+)\/merge$/,
      async (_q, _s, [id], b) => {
        const result = await actions.mergeTask(db, Number(id), { method: b.method, delete_branch: b.delete_branch === true });
        wake();
        return { ...result, task: taskDetail(db, Number(id)) };
      },
    ],
    // Bring the base branch into the task's branch, resolving conflicts with a claude run. Answers when it is done.
    [
      'POST',
      /^\/api\/tasks\/(\d+)\/resolve$/,
      async (_q, _s, [id]) => {
        const report = await actions.resolveTask(db, Number(id));
        wake();
        return { ...report, task: taskDetail(db, Number(id)) };
      },
    ],
    [
      'GET',
      /^\/api\/tasks\/(\d+)\/log$/,
      (req, res, [id]) => {
        const q = new URL(req.url!, 'http://x').searchParams;
        // A run by its id (resolve runs share an attempt number with a work run), or by attempt.
        streamLog(db, req, res, Number(id), { attempt: Number(q.get('attempt')) || undefined, run: Number(q.get('run')) || undefined });
        return undefined; // streamLog owns the response
      },
    ],
    // Reads of the task's branch from git objects. ref is head or base, paths are repo-relative.
    ['GET', /^\/api\/tasks\/(\d+)\/changes$/, (_q, _s, [id]) => actions.taskChanges(db, Number(id))],
    ['GET', /^\/api\/tasks\/(\d+)\/diff$/, (req, _s, [id]) => actions.taskDiff(db, Number(id), query(req).get('path'))],
    [
      'GET',
      /^\/api\/tasks\/(\d+)\/tree$/,
      (req, _s, [id]) => actions.taskTree(db, Number(id), query(req).get('ref'), query(req).get('path')),
    ],
    [
      'GET',
      /^\/api\/tasks\/(\d+)\/file$/,
      (req, _s, [id]) => actions.taskFile(db, Number(id), query(req).get('ref'), query(req).get('path')),
    ],
    // Plans: collected from the branch after each run, or attached (domain/plan).
    ['POST', /^\/api\/tasks\/(\d+)\/plans$/, (_q, _s, [id], b) => actions.attachPlan(db, Number(id), b)],
    ['POST', /^\/api\/tasks\/(\d+)\/plans\/collect$/, (_q, _s, [id]) => actions.collectPlans(db, Number(id))],
    ['GET', /^\/api\/tasks\/(\d+)\/plans\/(\d+)$/, (_q, _s, [id, pid]) => actions.planHtml(db, Number(id), Number(pid))],
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
