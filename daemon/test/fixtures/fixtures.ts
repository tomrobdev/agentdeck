// Tasks in a given state, built the way the daemon builds them: through claim, applyEvent, recordPr and recordMerge.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RepoId, TaskId } from '#domain/shared/id.ts';
import type { App, Ports } from '#application/ports/app.ts';
import type { openDb } from '#db/index.ts';

export { asPlannerRunId, asRepoId, asReviewId, asRunId, asTaskId } from '#domain/shared/id.ts';

type Db = ReturnType<typeof openDb>;

export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 5_000, what }: { timeoutMs?: number; what: string },
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(20);
  }
}

const real = () => import('#src/compose.ts');

const lazy = <T extends object>(load: (compose: Awaited<ReturnType<typeof real>>) => T): T =>
  new Proxy({} as T, {
    get:
      (_, name: string) =>
      async (...args: unknown[]) =>
        (load(await real()) as any)[name](...args),
  });

const lazySync = <T extends object>(load: (compose: Awaited<ReturnType<typeof real>>) => T): T =>
  new Proxy({} as T, {
    get:
      (_, name: string) =>
      (...args: unknown[]) =>
        (load(createRequire(import.meta.url)('../../src/compose.ts')) as any)[name](...args),
  });

const testPorts = (): Ports => ({
  agent: lazy((c) => c.realAgent()),
  codeHost: lazy((c) => c.realCodeHost()),
  workspace: lazy((c) => c.realWorkspace()),
  notifier: lazy((c) => c.realNotifier()),
  service: lazy((c) => c.realService()),
  runLog: lazySync((c) => c.realRunLog()),
  processes: lazySync((c) => c.realProcesses()),
  goals: lazySync((c) => c.realGoals()),
  source: lazySync((c) => c.realSource()),
});

export const testApp = (db: Db, ports: Partial<Ports> = {}): Db & App => Object.assign(db, { ...testPorts(), ...ports });
type Task = NonNullable<ReturnType<Db['getTask']>>;
type TaskStatus = Task['status'];
type NewTask = Partial<Omit<Parameters<Db['addTask']>[0], 'repo_id' | 'status'>>;

export type PrState = 'open' | 'merged' | 'closed' | 'failed';

export interface Outcome {
  pr?: PrState | null;
  url?: string;
  branch?: string;
  doneBy?: 'person' | null;
}

let urls = 0;

const apply = (db: Db, id: TaskId, event: Parameters<Db['applyEvent']>[1], reason?: string) => {
  const applied = db.applyEvent(id, event, reason ? { reason } : undefined);
  assert.ok(applied, `${event.type} was refused for #${id}`);
  db.markFollowedUp(applied.pending);
};

function recordPrOn(db: Db, id: TaskId, pr: PrState, url = `https://x/pull/${++urls}`): void {
  const record = (e: Parameters<Db['recordPr']>[1]) => assert.ok(db.recordPr(id, e), `${e.type} was refused for #${id}`);
  if (pr === 'failed') return record({ type: 'failed', error: 'gh: not authenticated' });
  record({ type: 'opened', url });
  if (pr === 'merged') record({ type: 'seen', state: 'merged' });
  if (pr === 'closed') record({ type: 'closed' });
}

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

export const queuedTask = (db: Db, repo: { id: RepoId }, o: NewTask = {}) => taskIn(db, repo, 'queued', o);

export const runningTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'running', o);

export const doneTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'done', o);

export const blockedTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'blocked', o);

export const failedTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'failed', o);

export const cancelledTask = (db: Db, repo: { id: RepoId }, o: Outcome & NewTask = {}) => taskIn(db, repo, 'cancelled', o);

export function openPr(db: Db, id: TaskId, url = `https://x/pull/${++urls}`): void {
  assert.ok(db.recordPr(id, { type: 'opened', url }), `opened was refused for #${id}`);
}

export function settlePr(db: Db, id: TaskId, state: 'merged' | 'closed'): void {
  const e = state === 'merged' ? ({ type: 'seen', state } as const) : ({ type: 'closed' } as const);
  assert.ok(db.recordPr(id, e), `${state} was refused for #${id}: its PR is not open`);
}

export function rerun(db: Db, id: TaskId): void {
  apply(db, id, { type: 'retry' });
  apply(db, id, { type: 'claim' });
  apply(db, id, { type: 'finish', outcome: 'done' });
}
