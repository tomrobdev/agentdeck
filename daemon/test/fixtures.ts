// Tasks in a given state, built the way the daemon builds them: through claim, applyEvent, recordPr and recordMerge.
// A state a fixture cannot reach through those calls fails an assertion here, so tests cannot depend on one.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { RepoId, TaskId } from '../src/domain/shared/id.ts';
import type { App, Ports } from '../src/application/ports/app.ts';
import type { openDb } from '../src/db/index.ts';

// A test makes an id from a number with these.
export { asPlannerRunId, asRepoId, asReviewId, asRunId, asTaskId } from '../src/domain/shared/id.ts';

type Db = ReturnType<typeof openDb>;

/**
 * The real adapters, loaded on first use: `compose.ts` reaches `config.ts`, which reads AGENTDECK_HOME when first
 * imported, so a test that sets it first must not pull it in through this file.
 */
const real = () => import('../src/compose.ts');

/** A port whose every method loads the real adapter on its first call, then calls it. */
const lazy = <T extends object>(load: (compose: Awaited<ReturnType<typeof real>>) => T): T =>
  new Proxy({} as T, {
    get:
      (_, name: string) =>
      async (...args: unknown[]) =>
        (load(await real()) as any)[name](...args),
  });

/** Like `lazy`, for a port whose methods are synchronous: the real adapter is loaded with `require`. */
const lazySync = <T extends object>(load: (compose: Awaited<ReturnType<typeof real>>) => T): T =>
  new Proxy({} as T, {
    get:
      (_, name: string) =>
      (...args: unknown[]) =>
        (load(createRequire(import.meta.url)('../src/compose.ts')) as any)[name](...args),
  });

/**
 * The ports a test's App gets unless it hands in its own (the in-memory fakes in `fakes.ts`): the real adapters.
 * Workspace has no fake: tests run it on real git in a temporary folder.
 */
const testPorts = (): Ports => ({
  agent: lazy((c) => c.realAgent()),
  codeHost: lazy((c) => c.realCodeHost()),
  workspace: lazy((c) => c.realWorkspace()),
  notifier: lazy((c) => c.realNotifier()),
  service: lazy((c) => c.realService()),
  // These are called without awaiting, so they load the real adapter synchronously on first use.
  runLog: lazySync((c) => c.realRunLog()),
  processes: lazySync((c) => c.realProcesses()),
  goals: lazySync((c) => c.realGoals()),
  source: lazySync((c) => c.realSource()),
});

/**
 * The App for a test, as `src/compose.ts` builds it for the daemon and the CLI, on a database the test opened
 * (`openDb(':memory:')` or a scratch file): the test's own `openDb`, because it must run after AGENTDECK_HOME is set.
 */
export const testApp = (db: Db, ports: Partial<Ports> = {}): Db & App => Object.assign(db, { ...testPorts(), ...ports });
type Task = NonNullable<ReturnType<Db['getTask']>>;
type TaskStatus = Task['status'];
type NewTask = Partial<Omit<Parameters<Db['addTask']>[0], 'repo_id' | 'status'>>;

export type PrState = 'open' | 'merged' | 'closed' | 'failed';

/** Where a fixture ends up: its PR (none by default), the PR's url, the branch it is checked out on, and who finished it. */
export interface Outcome {
  /** `failed` is a PR that could not be opened, so it has no url. */
  pr?: PrState | null;
  url?: string;
  branch?: string;
  /** Only for a done task: a person marked it done after a conflict. */
  doneBy?: 'person' | null;
}

let urls = 0;

/** A status change the task went through in its past: its follow-ups are not left pending for a scheduler to run. */
const apply = (db: Db, id: TaskId, event: Parameters<Db['applyEvent']>[1], reason?: string) => {
  const applied = db.applyEvent(id, event, reason ? { reason } : undefined);
  assert.ok(applied, `${event.type} was refused for #${id}`);
  db.markFollowedUp(applied.pending);
};

/** Record a PR on a done task. open: recordPr opened. merged: opened, then seen merged. closed: opened, then closed. failed: recordPr failed. */
function recordPrOn(db: Db, id: TaskId, pr: PrState, url = `https://x/pull/${++urls}`): void {
  const record = (e: Parameters<Db['recordPr']>[1]) => assert.ok(db.recordPr(id, e), `${e.type} was refused for #${id}`);
  if (pr === 'failed') return record({ type: 'failed', error: 'gh: not authenticated' });
  record({ type: 'opened', url });
  if (pr === 'merged') record({ type: 'seen', state: 'merged' });
  if (pr === 'closed') record({ type: 'closed' });
}

/**
 * Take a queued task to `status`. Events: claim; finish (done, blocked or failed) or cancel.
 * With a PR the task goes through done first (claim, finish done, recordPr), because only a done task gets a PR,
 * and then leaves done the way a task with a PR does: blocked by conflict; queued, running, failed or cancelled by retry.
 * With `doneBy: 'person'` a done task goes through conflict and mark_done.
 */
export function advance(db: Db, id: TaskId, status: TaskStatus, o: Outcome = {}): Task {
  const pr = o.pr ?? null;
  const done = o.doneBy === 'person';
  if (status === 'proposed') assert.fail('a proposal is added as one, not advanced to');
  if (pr === null) {
    if (status !== 'queued' && status !== 'cancelled') apply(db, id, { type: 'claim' });
    if (status === 'done') apply(db, id, { type: 'finish', outcome: 'done' });
    if (status === 'blocked') apply(db, id, { type: 'finish', outcome: 'blocked' }, 'stuck');
    if (status === 'failed') apply(db, id, { type: 'finish', outcome: 'failed', retry: false }, 'broke');
    if (status === 'cancelled' || status === 'cancel_requested') apply(db, id, { type: 'cancel' });
  } else {
    apply(db, id, { type: 'claim' });
    apply(db, id, { type: 'finish', outcome: 'done' });
    recordPrOn(db, id, pr, o.url);
    if (status === 'blocked') apply(db, id, { type: 'conflict' }, 'conflict');
    if (status !== 'done' && status !== 'blocked') apply(db, id, { type: 'retry' });
    if (status === 'running' || status === 'failed' || status === 'cancel_requested') apply(db, id, { type: 'claim' });
    if (status === 'failed') apply(db, id, { type: 'finish', outcome: 'failed', retry: false }, 'broke');
    if (status === 'cancelled' || status === 'cancel_requested') apply(db, id, { type: 'cancel' });
  }
  if (done && status === 'done') {
    apply(db, id, { type: 'conflict' }, 'conflict');
    apply(db, id, { type: 'mark_done' });
  }
  if (o.branch) db.setCheckout(id, { branch: o.branch });
  return db.getTask(id)!;
}

function taskIn(db: Db, repo: { id: RepoId }, status: TaskStatus, o: Outcome & NewTask): Task {
  const { pr, url, branch, doneBy, ...fields } = o;
  const t = db.addTask({ repo_id: repo.id, title: 'task', prompt: 'x', ...fields });
  return advance(db, t.id, status, { pr, url, branch, doneBy });
}

/** A queued task. Events: none, `addTask` queues it. */
export const queuedTask = (db: Db, repo: { id: RepoId }, o: NewTask = {}) => taskIn(db, repo, 'queued', o);

/** A running task. Events: claim. */
export const runningTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'running', o);

/**
 * A done task, with a PR in the state `pr` says (none by default). Events: claim, finish done; then recordPr
 * opened (and seen merged, or closed) or failed; with `doneBy: 'person'` conflict and mark_done.
 */
export const doneTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'done', o);

/**
 * A blocked task. Events: claim, finish blocked. With a PR it is a done task whose branch conflicts:
 * claim, finish done, recordPr, conflict, so the PR stays on it.
 */
export const blockedTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'blocked', o);

/**
 * A failed task. Events: claim, finish failed. With a PR it is a retry that failed: claim, finish done, recordPr,
 * retry, claim, finish failed, so the PR stays on it.
 */
export const failedTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'failed', o);

/** A cancelled task. Events: cancel. With a PR: claim, finish done, recordPr, retry, cancel. */
export const cancelledTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'cancelled', o);

/** A done task opens a PR. Events: recordPr opened (a new url when it had a closed or failed PR). */
export function openPr(db: Db, id: TaskId, url = `https://x/pull/${++urls}`): void {
  assert.ok(db.recordPr(id, { type: 'opened', url }), `opened was refused for #${id}`);
}

/** The open PR of a task is merged or closed. Events: recordPr seen merged, or recordPr closed. */
export function settlePr(db: Db, id: TaskId, state: 'merged' | 'closed'): void {
  const e = state === 'merged' ? ({ type: 'seen', state } as const) : ({ type: 'closed' } as const);
  assert.ok(db.recordPr(id, e), `${state} was refused for #${id}: its PR is not open`);
}

/** A done task runs again and is done again, as after a retry. Events: retry, claim, finish done. */
export function rerun(db: Db, id: TaskId): void {
  apply(db, id, { type: 'retry' });
  apply(db, id, { type: 'claim' });
  apply(db, id, { type: 'finish', outcome: 'done' });
}
