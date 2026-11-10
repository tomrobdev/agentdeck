// What each kind of run needs to start: its log lines, and what happens when it crashes or ends.
import { settle } from '../landing/settle.ts';
import type { App } from '../ports/app.ts';
import { runReview } from '../runs/review.ts';
import { runUnblock } from '../runs/unblock.ts';
import { runTask } from '../runs/worker.ts';

type Log = (msg: string) => void;

export function startWork(app: App, task: Parameters<typeof runTask>[1], log: Log, done: () => void): Promise<unknown> {
  log(`task ${task.id} attempt ${task.attempts}: starting "${task.title}"`);
  return runTask(app, task)
    .then((res) => log(`task ${task.id}: ${res.outcome}${res.reason ? ` (${res.reason})` : ''}`))
    .catch((err) => {
      log(`task ${task.id}: worker crashed: ${err?.stack ?? err}`);
      return settle(app, task.id, { type: 'finish', outcome: 'failed', retry: false }, { reason: String(err?.message ?? err) }).catch((e) =>
        log(`task ${task.id}: settling crashed: ${e?.stack ?? e}`),
      );
    })
    .finally(done);
}

export function startUnblock(app: App, task: Parameters<typeof runUnblock>[1], log: Log, done: () => void): Promise<unknown> {
  log(`task ${task.id}: unblock run: reading why it blocked`);
  return runUnblock(app, task)
    .then((r) => log(`task ${task.id}: unblock run: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`))
    .catch((err) => log(`task ${task.id}: unblock run crashed: ${err?.stack ?? err}`))
    .finally(done);
}

export function startReview(app: App, target: Parameters<typeof runReview>[1], log: Log, done: () => void): Promise<unknown> {
  const id = target.task.id;
  log(`task ${id}: review run: reading its changes`);
  return runReview(app, target)
    .then((r) => log(`task ${id}: review run: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`))
    .catch((err) => log(`task ${id}: review run crashed: ${err?.stack ?? err}`))
    .finally(done);
}
