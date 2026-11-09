// Every route of the HTTP API, called over HTTP: one row per route (and one 400 row per route that reads a body), each
// checking the status code and the response's shape. The routes come from the modules in src/api/routes/, so a route
// added there without a row here fails the first test, naming its method and pattern.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Run as ContractRun } from '../../src/api/contract/runs.ts';
import type { Route } from '../../src/api/http.ts';
import type { Service, ServiceStatus } from '../../src/application/ports/service.ts';
import type { Workspace } from '../../src/application/ports/workspace.ts';
import type { RepoId, TaskId } from '../../src/domain/shared/id.ts';
import { READY_PR, fakeAgent, fakeCodeHost } from '../fixtures/fakes.ts';
import { blockedTask, doneTask, failedTask, queuedTask, testApp } from '../fixtures/fixtures.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-routes-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../../src/db/index.ts');
const { startApi } = await import('../../src/api/server.ts');
const { realWorkspace } = await import('../../src/compose.ts');
const { ensureWorktree } = await import('../../src/adapters/git/worktrees.ts');
const actions = await import('../../src/application/actions.ts');

// ---- The App: real git, fakes for claude, gh, launchd and notifications

const SERVICE: ServiceStatus = { installed: true, loaded: true, pid: 4242, state: 'running', plist: '/x.plist', program: '/x' };
/** When the fake service was restarted: /daemon/restart-now's effect, replaced. */
const restarts: number[] = [];
const service: Service = {
  status: async () => SERVICE,
  start: async () => SERVICE,
  stop: async () => {},
  restart: async () => (restarts.push(Date.now()), SERVICE),
  install: async () => SERVICE,
  uninstall: async () => {},
  tailLog: async () => {},
  daemonState: async () => null,
  logTail: () => ['daemon started'],
};

/** The real workspace, but a package manager that writes its files instead of reaching the registry. */
const real = realWorkspace();
const workspace: Workspace = {
  ...real,
  runCommand: async (command, cwd, timeoutMs) => {
    if (Array.isArray(command) && command[0] === 'pnpm') {
      writeFileSync(join(cwd, 'package.json'), '{"name":"demo","dependencies":{"left-pad":"1.0.0"}}\n');
      writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      return { passed: true, output: '' } as Awaited<ReturnType<Workspace['runCommand']>>;
    }
    return real.runCommand(command, cwd, timeoutMs);
  },
};

const host = fakeCodeHost();
const app = testApp(openDb(join(home, 'test.db')), {
  agent: fakeAgent(),
  codeHost: host,
  service,
  workspace,
  notifier: { desktop: async () => {}, ntfy: async () => {} },
});
const restartRequests: number[] = [];
const server = await startApi({
  db: app,
  port: 0,
  daemon: {
    info: { commit: null, started_at: new Date().toISOString(), pid: process.pid },
    requestRestart: () => void restartRequests.push(Date.now()),
    reloadFacts: () => ({ changed: [], lastChangeAt: null }),
  },
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
  app.close();
});

// ---- Fixtures: each row makes the repos and tasks it needs, so no row depends on another having run

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

let repos = 0;
/** A new git repo with one commit on main, not registered. */
function gitRepo(): string {
  const path = join(home, `repo-${++repos}`);
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 't@example.com');
  git(path, 'config', 'user.name', 't');
  writeFileSync(join(path, 'a.txt'), 'a\n');
  writeFileSync(join(path, 'package.json'), '{"name":"demo"}\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'init');
  return path;
}

/** A registered repo of its own. */
const newRepo = (o: { archived?: boolean } = {}) => {
  const repo = app.addRepo({ name: `repo-${repos + 1}`, path: gitRepo(), base_branch: 'main', toolchain: 'pnpm' });
  if (o.archived) app.setRepoArchived(repo.id, true);
  return repo;
};

let repo: ReturnType<typeof newRepo>;
before(() => {
  repo = newRepo();
});

const proposed = () => app.addTask({ repo_id: repo.id, title: 'p', prompt: 'p', status: 'proposed' }).id;
const queued = () => queuedTask(app, repo).id;
/** A done task with an open PR on the fake code host. */
const withPr = () => doneTask(app, repo, { pr: 'open' });

/** A task with a worktree whose branch has one commit (b.txt), then taken to done or blocked. */
async function withWorktree(status: 'done' | 'blocked' = 'done', needs?: string[], on: typeof repo = repo): Promise<TaskId> {
  const t = app.addTask({ repo_id: on.id, title: 'w', prompt: 'p' });
  const { branch, path } = await ensureWorktree(on, t);
  app.setCheckout(t.id, { branch, worktree: path });
  writeFileSync(join(path, 'b.txt'), 'b\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'Add b');
  const step = (event: Parameters<typeof app.applyEvent>[1], opts?: Parameters<typeof app.applyEvent>[2]) => {
    const applied = app.applyEvent(t.id, event, opts);
    assert.ok(applied, `${event.type} was refused for #${t.id}`);
    app.markFollowedUp(applied.pending);
  };
  step({ type: 'claim' });
  if (status === 'done') step({ type: 'finish', outcome: 'done' });
  else step({ type: 'finish', outcome: 'blocked', environment: true }, { reason: 'NEEDS', needs: { kind: 'deps', items: needs ?? [] } });
  return t.id;
}

/** A draft review on a new done task with an open PR (the one a person reviews), with one comment. */
function draft() {
  const review = actions.startReview(app, withPr().id);
  const comment = { path: 'a.txt', line: 1, side: 'new', head_commit: 'abc123', body: 'Why?' };
  return actions.addReviewComment(app, review.id, comment);
}

/** A submitted review's comment, open or resolved. */
async function submittedComment(state: 'open' | 'resolved'): Promise<number> {
  const review = await actions.submitReview(app, draft().id, { kind: 'comment' });
  const id = review.comments[0].id;
  if (state === 'resolved') actions.resolveReviewComment(app, id);
  return id;
}

const PLAN = `<!doctype html>
<html data-agentdeck-plan="1"><head><title>A plan</title></head><body>
  <p data-plan-summary>One step.</p>
  <section data-plan-step id="a" data-status="todo"><h2>A</h2></section>
</body></html>`;

// ---- The table

type Method = 'GET' | 'POST' | 'DELETE';
type Json = any;

/** The keys the answer has. `each`: it is a list, and every item has them. `stream`: Server-Sent Events. */
type Shape = readonly string[] | { each: readonly string[] } | 'stream';

interface Row {
  method: Method;
  /** The path, with `:name` for each id `params` makes (`/api/tasks/:task/merge`), and an optional query. */
  path: string;
  /** Makes the row's fixtures and names their ids for the path. */
  params?: () => Record<string, number> | Promise<Record<string, number>>;
  body?: unknown;
  /** 200 unless said. */
  status?: 200 | 400;
  shape: Shape;
  /** More checks on the answer. */
  check?: (json: Json, params: Record<string, number>) => void | Promise<void>;
}

const TASK_DETAIL = ['id', 'repo', 'title', 'status', 'check_list', 'runs', 'events', 'plans'];
const TASK_SAVED = [...TASK_DETAIL, 'warnings'];
/** The keys of the contract's Run (api/contract/runs.ts). */
const RUN = [
  'id',
  'kind',
  'attempt',
  'started_at',
  'ended_at',
  'outcome',
  'num_turns',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cost_usd',
  'tests_passed',
  'result_text',
  'denials',
  'live_turns',
  'live_tool',
  'model',
  'model_id',
  'diff_hash',
  'summary',
] satisfies (keyof ContractRun)[];
const REPO = ['id', 'name', 'path', 'base_branch', 'pr_mode', 'merge_method', 'archived_at'];
const REVIEW = ['id', 'task_id', 'kind', 'body', 'submitted_at', 'comments'];
const STATUS = ['daemon', 'paused', 'running', 'max_concurrent', 'counts', 'headline', 'governor'];
const ERROR = ['error'];

/** A bad-input row: the route parses its body and answers 400 to this one. */
const bad = (method: Method, path: string, body: unknown, params?: Row['params']): Row => ({
  method,
  path,
  params,
  body,
  status: 400,
  shape: ERROR,
});

const task = (make: () => TaskId | Promise<TaskId>) => async () => ({ task: await make() });
const statusOf = (id: number) => app.getTask(id as TaskId)!.status;

const ROWS: Row[] = [
  // daemon.ts
  { method: 'GET', path: '/api/events', shape: 'stream', check: (text) => assert.match(text, /^event: rev\ndata: \{"rev":1\}/) },
  { method: 'GET', path: '/api/status', shape: STATUS },
  { method: 'GET', path: '/api/stats', shape: ['repos', 'total', 'weeks', 'scorecard'] },
  { method: 'GET', path: '/api/daemon', shape: ['commit', 'started_at', 'pid', 'reload'] },
  { method: 'POST', path: '/api/pause', shape: STATUS, check: (st) => assert.equal(st.paused, true) },
  { method: 'POST', path: '/api/resume', shape: STATUS, check: (st) => assert.equal(st.paused, false) },
  {
    method: 'POST',
    path: '/api/daemon/restart',
    shape: ['waiting'],
    check: (r) => {
      assert.equal(r.waiting, null, 'nothing runs, so it restarts at once');
      assert.equal(restartRequests.length, 1);
    },
  },
  {
    method: 'GET',
    path: '/api/daemon/health',
    shape: ['checks', 'head', 'running', 'log'],
    check: (h) => {
      assert.ok(h.checks.every((c: Json) => typeof c.name === 'string' && typeof c.ok === 'boolean'));
      assert.deepEqual(h.log, ['daemon started']);
    },
  },
  {
    method: 'POST',
    path: '/api/daemon/restart-now',
    shape: ['requeued'],
    check: async (r) => {
      assert.deepEqual(r.requeued, []);
      // The restart starts after the answer: the fake service records it.
      const deadline = Date.now() + 5000;
      while (!restarts.length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
      assert.equal(restarts.length, 1, 'the service was restarted once');
    },
  },
  { method: 'GET', path: '/api/service', shape: ['installed', 'loaded', 'pid', 'state'] },
  { method: 'POST', path: '/api/notify/test', shape: ['ok'], check: (r) => assert.equal(r.ok, true) },
  { method: 'POST', path: '/api/app/seen', shape: ['desktop'] },

  // settings.ts
  { method: 'GET', path: '/api/settings', shape: ['max_concurrent', 'budget', 'notify', 'planner', 'reload_on_change'] },
  {
    method: 'POST',
    path: '/api/settings',
    body: { max_concurrent: 3 },
    shape: ['max_concurrent', 'budget', 'notify', 'planner', 'reload_on_change'],
    check: (s) => assert.equal(s.max_concurrent, 3),
  },
  bad('POST', '/api/settings', { max_concurrent: '3' }),

  // repos.ts
  { method: 'GET', path: '/api/repos', shape: { each: REPO } },
  { method: 'GET', path: '/api/repos?archived=1', shape: { each: REPO } },
  { method: 'POST', path: '/api/repos', body: { path: '<new>' }, shape: REPO },
  bad('POST', '/api/repos', { path: 5 }),
  {
    method: 'GET',
    path: '/api/repos/:repo',
    params: () => ({ repo: newRepo().id }),
    shape: [...REPO, 'goals', 'goals_path', 'planner_runs'],
  },
  {
    method: 'POST',
    path: '/api/repos/:repo',
    params: () => ({ repo: newRepo().id }),
    body: { merge_method: 'merge' },
    shape: [...REPO, 'goals', 'goals_path', 'planner_runs'],
    check: (r) => assert.equal(r.merge_method, 'merge'),
  },
  bad('POST', '/api/repos/:repo', { pr_mode: 5 }, () => ({ repo: newRepo().id })),
  {
    method: 'POST',
    path: '/api/repos/:repo/propose',
    params: () => ({ repo: newRepo().id }),
    shape: ['outcome', 'tasks', 'skipped', 'note'],
    check: (r) => assert.equal(r.outcome, 'no_goals', 'a repo with no goals is not planned'),
  },
  {
    method: 'POST',
    path: '/api/repos/:repo/doctor',
    params: () => ({ repo: newRepo().id }),
    shape: ['repo', 'ok', 'checks', 'paused_reason'],
  },
  {
    method: 'POST',
    path: '/api/repos/:repo/resume',
    params: () => {
      const r = newRepo();
      app.setRepoPaused(r.id, 'doctor: git repo');
      return { repo: r.id };
    },
    shape: REPO,
    check: (r) => assert.equal(r.paused_reason, null),
  },
  {
    method: 'POST',
    path: '/api/repos/:repo/archive',
    params: () => ({ repo: newRepo().id }),
    shape: REPO,
    check: (r) => assert.ok(r.archived_at),
  },
  {
    method: 'POST',
    path: '/api/repos/:repo/unarchive',
    params: () => ({ repo: newRepo({ archived: true }).id }),
    shape: REPO,
    check: (r) => assert.equal(r.archived_at, null),
  },
  {
    method: 'GET',
    path: '/api/repos/:repo/deletion',
    params: () => ({ repo: newRepo({ archived: true }).id }),
    shape: ['repo', 'archived', 'tasks', 'runs', 'worktrees'],
  },
  {
    method: 'DELETE',
    path: '/api/repos/:repo',
    params: () => ({ repo: newRepo({ archived: true }).id }),
    shape: ['repo', 'leftover'],
    check: (r, { repo: id }) => {
      assert.deepEqual(r.leftover, []);
      assert.equal(app.getRepo(id as RepoId), undefined);
    },
  },

  // tasks.ts
  { method: 'GET', path: '/api/tasks', shape: { each: ['id', 'repo', 'title', 'status'] } },
  { method: 'GET', path: '/api/tasks?status=nonsense', status: 400, shape: ERROR },
  {
    method: 'POST',
    path: '/api/tasks',
    body: { repo: '<repo>', prompt: 'do it' },
    shape: TASK_SAVED,
    check: (t) => assert.equal(t.status, 'queued'),
  },
  bad('POST', '/api/tasks', { prompt: 5 }),
  { method: 'GET', path: '/api/tasks/:task', params: task(queued), shape: TASK_DETAIL },
  {
    method: 'GET',
    path: '/api/tasks/:task?run',
    params: task(() => {
      const t = failedTask(app, repo);
      const run = app.startRun(t.id, 1, join(home, `task-${t.id}.jsonl`), 'work', 'sonnet');
      app.finishRun(run, { outcome: 'failed', cost_usd: 2.1, input_tokens: 10, num_turns: 3 });
      return t.id;
    }),
    shape: TASK_DETAIL,
    // Every key of the contract's Run, cost and live state included, which the dashboard's run list and header read.
    check: (t) => {
      const [run] = t.runs;
      for (const key of RUN) assert.ok(key in run, `the run has ${key}`);
      assert.equal(run.cost_usd, 2.1);
      assert.equal(run.live_turns, 0);
      assert.equal(run.live_tool, null);
    },
  },
  {
    method: 'POST',
    path: '/api/tasks/:task',
    params: task(queued),
    body: { title: 'Renamed' },
    shape: TASK_SAVED,
    check: (t) => assert.equal(t.title, 'Renamed'),
  },
  bad('POST', '/api/tasks/:task', { priority: '1' }, task(queued)),
  {
    method: 'POST',
    path: '/api/tasks/:task/links',
    params: async () => ({ task: queued(), on: queued() }),
    body: { on: '<on>', kind: 'after' },
    shape: TASK_DETAIL,
    check: (t, { on }) => assert.equal(app.allLinks().filter((l) => l.task_id === t.id && l.on === on).length, 1),
  },
  bad('POST', '/api/tasks/:task/links', { on: 'one', kind: 'after' }, task(queued)),
  {
    method: 'DELETE',
    path: '/api/tasks/:task/links/:on',
    params: () => {
      const [id, on] = [queued(), queued()];
      actions.linkTasks(app, id, { on, kind: 'after' });
      return { task: id, on };
    },
    shape: TASK_DETAIL,
    check: (t) => assert.equal(app.allLinks().filter((l) => l.task_id === t.id).length, 0),
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/approve',
    params: task(proposed),
    shape: TASK_DETAIL,
    check: (t) => assert.equal(t.status, 'queued'),
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/reject',
    params: task(proposed),
    shape: TASK_DETAIL,
    check: (t) => assert.equal(t.status, 'cancelled'),
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/cancel',
    params: task(queued),
    shape: ['result'],
    check: (r) => assert.equal(r.result, 'cancelled'),
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/retry',
    params: task(() => failedTask(app, repo).id),
    body: { note: 'again' },
    shape: TASK_DETAIL,
    check: (t) => assert.equal(t.status, 'queued'),
  },
  bad(
    'POST',
    '/api/tasks/:task/retry',
    { note: 5 },
    task(() => failedTask(app, repo).id),
  ),
  {
    method: 'POST',
    path: '/api/tasks/:task/done',
    params: task(() => blockedTask(app, repo).id),
    body: { note: 'done by hand' },
    shape: TASK_DETAIL,
    check: (t) => assert.equal(t.status, 'done'),
  },
  bad(
    'POST',
    '/api/tasks/:task/done',
    { note: 5 },
    task(() => blockedTask(app, repo).id),
  ),
  {
    method: 'POST',
    path: '/api/tasks/:task/install-needs',
    params: task(() => withWorktree('blocked', ['left-pad'])),
    shape: TASK_DETAIL,
    check: (t) => assert.equal(t.status, 'queued', 'installed, then retried'),
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/clean',
    params: task(() => withWorktree()),
    shape: TASK_DETAIL,
    check: (t) => {
      assert.equal(t.worktree, null);
      assert.ok(t.branch, 'the branch is kept');
    },
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/sync',
    params: task(() => withWorktree()),
    shape: ['outcome', 'files', 'pushed', 'task'],
    check: (r) => assert.equal(r.outcome, 'up_to_date'),
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/verify',
    params: task(proposed),
    body: { wait: true },
    shape: ['run_id', 'report', 'task'],
    check: (r, { task: id }) => {
      // The fake agent answers in words, not findings: the run ends failed, and uses no attempt.
      assert.equal(r.report.outcome, 'garbage');
      assert.equal(r.task.runs.at(-1).kind, 'verify');
      assert.equal(r.task.runs.at(-1).id, r.run_id);
      assert.equal(app.getTask(id as TaskId)!.attempts, 0);
    },
  },
  bad('POST', '/api/tasks/:task/verify', { wait: 'yes' }, task(proposed)),
  bad(
    'POST',
    '/api/tasks/:task/verify',
    {},
    task(() => withWorktree()),
  ),
  {
    method: 'GET',
    path: '/api/tasks/:task/log',
    params: task(queued),
    shape: 'stream',
    check: (text) => assert.match(text, /event: end/, 'a task with no run ends the stream at once'),
  },

  // pull-requests.ts
  {
    method: 'POST',
    path: '/api/tasks/:task/fix-checks',
    params: () => {
      const t = withPr();
      const check = { name: 'test', state: 'fail' as const, url: null, started_at: null, completed_at: null };
      host.details[t.pr!.url!] = { ...READY_PR, checks: { total: 1, failing: 1, pending: 0 }, check_list: [check] };
      return { task: t.id };
    },
    shape: ['checks', 'task'],
    check: (r) => {
      assert.deepEqual(r.checks, ['test']);
      assert.equal(r.task.status, 'queued');
    },
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/open-pr',
    params: task(() => {
      const prRepo = newRepo();
      app.updateRepo(prRepo.id, { pr_mode: 'ready' });
      return withWorktree('done', undefined, prRepo);
    }),
    shape: ['url', 'task'],
    check: (r) => {
      assert.equal(typeof r.url, 'string');
      assert.equal(r.task.pr_state, 'open');
    },
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/close-pr',
    params: task(() => withPr().id),
    shape: TASK_DETAIL,
    check: (t) => assert.equal(t.pr_state, 'closed'),
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/merge',
    params: task(() => withPr().id),
    shape: ['title', 'pr_url', 'method', 'checks', 'problems', 'warnings', 'unblocks', 'request', 'merge_now'],
    check: (p) => assert.deepEqual(p.problems, []),
  },
  {
    method: 'POST',
    path: '/api/tasks/:task/merge',
    params: task(() => withPr().id),
    body: {},
    shape: ['method', 'unblocked', 'task'],
    check: (r) => assert.equal(r.task.pr_state, 'merged'),
  },
  bad(
    'POST',
    '/api/tasks/:task/merge',
    { method: 5 },
    task(() => withPr().id),
  ),
  {
    method: 'POST',
    path: '/api/tasks/:task/merge-request',
    params: task(() => withPr().id),
    body: {},
    shape: ['method', 'task'],
    check: (r) => {
      assert.equal(r.method, repo.merge_method, 'the repo’s method');
      assert.equal(r.task.merge_request?.method, r.method);
    },
  },
  bad(
    'POST',
    '/api/tasks/:task/merge-request',
    { method: 5 },
    task(() => withPr().id),
  ),
  {
    method: 'DELETE',
    path: '/api/tasks/:task/merge-request',
    params: () => {
      const id = withPr().id;
      actions.requestMerge(app, id);
      return { task: id };
    },
    shape: ['cancelled', 'task'],
    check: (r) => assert.equal(r.cancelled, true),
  },
  {
    method: 'POST',
    path: '/api/tasks/merge-requests',
    params: () => ({ a: withPr().id, b: queued() }),
    body: { ids: ['<a>', '<b>'] },
    shape: ['requested', 'failed'],
    check: (r, { a, b }) => {
      assert.deepEqual(r.requested, [a]);
      assert.deepEqual(
        r.failed.map((f: Json) => f.id),
        [b],
      );
    },
  },
  bad('POST', '/api/tasks/merge-requests', { ids: 'one' }),
  {
    method: 'POST',
    path: '/api/tasks/:task/auto-merge',
    params: task(() => withPr().id),
    body: { auto_merge: true },
    shape: ['auto_merge', 'task'],
    check: (r) => assert.equal(r.auto_merge, true),
  },
  bad(
    'POST',
    '/api/tasks/:task/auto-merge',
    { auto_merge: 'yes' },
    task(() => withPr().id),
  ),

  // files.ts
  {
    method: 'GET',
    path: '/api/tasks/:task/changes',
    params: task(() => withWorktree()),
    shape: ['base_ref', 'base', 'head', 'since', 'base_may_show', 'files', 'commits', 'since_points'],
    check: (c) =>
      assert.deepEqual(
        c.files.map((f: Json) => f.path),
        ['b.txt'],
      ),
  },
  {
    method: 'GET',
    path: `/api/tasks/:task/changes?since=${'1'.repeat(40)}`,
    params: task(() => withWorktree()),
    status: 400,
    shape: ERROR,
    check: (e) => assert.match(e.error, /not a commit on this task's branch/),
  },
  {
    method: 'GET',
    path: `/api/tasks/:task/diff?path=b.txt&since=${'1'.repeat(40)}`,
    params: task(() => withWorktree()),
    status: 400,
    shape: ERROR,
    check: (e) => assert.match(e.error, /not a commit on this task's branch/),
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/diff?path=b.txt',
    params: task(() => withWorktree()),
    shape: ['path', 'patch', 'truncated'],
    check: (p) => assert.match(p.patch, /\+b/),
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/tree?ref=head',
    params: task(() => withWorktree()),
    shape: ['ref', 'sha', 'path', 'entries'],
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/file?ref=head&path=b.txt',
    params: task(() => withWorktree()),
    shape: ['path', 'ref', 'sha', 'size', 'binary', 'truncated', 'text'],
    check: (f) => assert.equal(f.text, 'b\n'),
  },
  {
    method: 'GET',
    path: '/api/tasks/:task/proposal-check',
    params: task(() => app.addTask({ repo_id: repo.id, title: 'p', prompt: 'Change `a.txt` and `gone.txt`', status: 'proposed' }).id),
    shape: ['staleness', 'notes', 'overlaps'],
    check: (c) => {
      assert.equal(c.staleness.ref, 'main');
      assert.equal(c.staleness.commits, 0);
      assert.deepEqual(c.notes, ["the prompt names gone.txt, which isn't on main and no task it builds on adds it"]);
    },
  },

  // plans.ts
  {
    method: 'POST',
    path: '/api/tasks/:task/plans',
    params: task(queued),
    body: { html: PLAN },
    shape: ['id', 'task_id', 'name', 'title', 'steps'],
    check: (p) => assert.equal(p.title, 'A plan'),
  },
  bad('POST', '/api/tasks/:task/plans', { html: 5 }, task(queued)),
  {
    method: 'GET',
    path: '/api/tasks/:task/plans/:plan',
    params: () => {
      const id = queued();
      return { task: id, plan: actions.attachPlan(app, id, { html: PLAN }).id };
    },
    shape: ['html'],
    check: (p) => assert.match(p.html, /A plan/),
  },

  // reviews.ts
  { method: 'GET', path: '/api/tasks/:task/reviews', params: () => ({ task: draft().task_id }), shape: { each: REVIEW } },
  {
    method: 'POST',
    path: '/api/tasks/:task/reviews',
    params: task(queued),
    shape: REVIEW,
    check: (r) => assert.equal(r.submitted_at, null, 'a draft'),
  },
  {
    method: 'POST',
    path: '/api/reviews/:review',
    params: () => ({ review: draft().id }),
    body: { body: 'Overall' },
    shape: REVIEW,
    check: (r) => assert.equal(r.body, 'Overall'),
  },
  bad('POST', '/api/reviews/:review', { body: 5 }, () => ({ review: draft().id })),
  {
    method: 'POST',
    path: '/api/reviews/:review/comments',
    params: () => ({ review: draft().id }),
    body: { path: 'a.txt', line: 2, side: 'old', head_commit: 'abc123', body: 'And this?' },
    shape: REVIEW,
    check: (r) => assert.equal(r.comments.length, 2),
  },
  bad('POST', '/api/reviews/:review/comments', { path: 'a.txt', line: 0, side: 'new', head_commit: 'abc', body: 'x' }, () => ({
    review: draft().id,
  })),
  {
    method: 'POST',
    path: '/api/reviews/:review/submit',
    params: () => ({ review: draft().id }),
    body: { kind: 'request_changes', body: 'Please change it' },
    shape: REVIEW,
    check: (r) => {
      assert.equal(r.kind, 'request_changes');
      assert.ok(r.submitted_at);
      assert.equal(statusOf(r.task_id), 'queued', 'request changes retries the task');
    },
  },
  bad('POST', '/api/reviews/:review/submit', { kind: 'approve' }, () => ({ review: draft().id })),
  {
    method: 'DELETE',
    path: '/api/review-comments/:comment',
    params: () => ({ comment: draft().comments[0].id }),
    shape: REVIEW,
    check: (r) => assert.deepEqual(r.comments, []),
  },
  {
    method: 'POST',
    path: '/api/review-comments/:comment/resolve',
    params: async () => ({ comment: await submittedComment('open') }),
    shape: REVIEW,
    check: (r) => assert.equal(r.comments[0].state, 'resolved'),
  },
  {
    method: 'POST',
    path: '/api/review-comments/:comment/reopen',
    params: async () => ({ comment: await submittedComment('resolved') }),
    shape: REVIEW,
    check: (r) => assert.equal(r.comments[0].state, 'open'),
  },
];

// ---- Which route a row calls

/** Every route the API serves, from the modules in src/api/routes/ (the server registers each of them). */
async function collectRoutes(): Promise<Route[]> {
  const dir = join(import.meta.dirname, '../../src/api/routes');
  const ctx = {
    db: app,
    scheduler: { wake: () => {}, track: <T>(p: Promise<T>) => p },
    changes: { rev: 1, subscribe: () => () => {} },
    daemon: {
      info: { commit: null, started_at: '', pid: 0 },
      requestRestart: () => {},
      reloadFacts: () => ({ changed: [], lastChangeAt: null }),
    },
  };
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  const modules = await Promise.all(files.map((f) => import(join(dir, f)) as Promise<{ routes: (c: typeof ctx) => Route[] }>));
  return modules.flatMap((m) => m.routes(ctx));
}

/** A row's path as the router sees it: each `:name` an id, no query. */
const pathname = (path: string) => path.replace(/\?.*$/, '').replace(/:\w+/g, '1');

const routeName = (r: Route) => `${r.method} ${r.path}`;

/** The routes no row calls, each as its method and pattern. */
const unrouted = (routes: Route[], rows: Pick<Row, 'method' | 'path'>[]) =>
  routes.filter((r) => !rows.some((row) => row.method === r.method && r.path.test(pathname(row.path)))).map(routeName);

/** The routes that read a request body, for which a 400 row is wanted. */
const readsBody = (r: Route) => /\bbody\b/.test(r.handle.toString());

const routes = await collectRoutes();

test('every route in src/api/routes/ has a row', () => {
  assert.ok(routes.length > 50, `found ${routes.length} routes`);
  const missing = unrouted(routes, ROWS);
  assert.deepEqual(missing, [], `no row in api-routes.test.ts for: ${missing.join(', ')}`);
});

test('a route without a row is named by its method and pattern', () => {
  const added: Route = { method: 'POST', path: /^\/api\/tasks\/(\d+)\/unrouted$/, handle: () => ({}) };
  assert.deepEqual(unrouted([...routes, added], ROWS), ['POST /^\\/api\\/tasks\\/(\\d+)\\/unrouted$/']);
});

test('every row calls a route, and every route that reads a body has a 400 row', () => {
  for (const row of ROWS) {
    const hits = routes.filter((r) => r.method === row.method && r.path.test(pathname(row.path)));
    assert.equal(hits.length, 1, `${row.method} ${row.path} matches ${hits.length} routes`);
  }
  const find = (method: string, path: string) => routes.find((r) => r.method === method && r.path.test(path))!;
  assert.equal(readsBody(find('POST', '/api/settings')), true, 'a handler that reads its body is seen to');
  assert.equal(readsBody(find('POST', '/api/pause')), false);
  const noBadRow = routes
    .filter(readsBody)
    .filter(
      (r) =>
        !ROWS.some((row) => row.status === 400 && row.body !== undefined && row.method === r.method && r.path.test(pathname(row.path))),
    )
    .map(routeName);
  assert.deepEqual(noBadRow, [], `no bad-input row for: ${noBadRow.join(', ')}`);
});

// ---- Each row, over HTTP

/** `<name>` in a body is the row's id of that name; `<new>` a new git repo's path; `<repo>` the shared repo's name. */
function fill(value: unknown, params: Record<string, number>): unknown {
  if (typeof value === 'string') {
    if (value === '<new>') return gitRepo();
    if (value === '<repo>') return repo.name;
    const m = value.match(/^<(\w+)>$/);
    return m ? params[m[1]] : value;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, params));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, params)]));
  return value;
}

/** Read a stream's first event, then hang up: GET /api/events never ends on its own. */
async function firstEvent(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return text;
}

function checkShape(json: Json, shape: Exclude<Shape, 'stream'>, what: string) {
  const items = Array.isArray(shape) ? [json] : (assert.ok(Array.isArray(json), `${what} answers a list`), json);
  const keys = Array.isArray(shape) ? shape : (shape as { each: readonly string[] }).each;
  for (const item of items) {
    assert.ok(item && typeof item === 'object', `${what} answers an object`);
    const missing = keys.filter((k) => !(k in item));
    assert.deepEqual(missing, [], `${what} answered without ${missing.join(', ')}: ${JSON.stringify(item).slice(0, 300)}`);
  }
}

for (const row of ROWS) {
  const status = row.status ?? 200;
  const to = row.body === undefined ? '' : ` to ${JSON.stringify(row.body)}`;
  test(`${row.method} ${row.path}${status === 400 ? ` answers 400${to}` : ''}`, async () => {
    const params = (await row.params?.()) ?? {};
    const path = row.path.replace(/:(\w+)/g, (_, name: string) => {
      assert.ok(params[name], `${row.path}: params has no ${name}`);
      return String(params[name]);
    });
    const what = `${row.method} ${path}`;
    const ctl = new AbortController();
    const res = await fetch(base + path, {
      method: row.method,
      signal: ctl.signal,
      ...(row.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fill(row.body, params)) }),
    });
    if (row.shape === 'stream') {
      assert.equal(res.status, status, what);
      assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/, what);
      const text = await firstEvent(res);
      await row.check?.(text, params);
      return;
    }
    const json = await res.json();
    assert.equal(res.status, status, `${what} answered ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    checkShape(json, row.shape, what);
    await row.check?.(json, params);
  });
}
