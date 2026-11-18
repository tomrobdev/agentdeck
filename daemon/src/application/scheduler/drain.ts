// Ending a drain: once nothing is in flight in its scope, the daemon or the repo ends paused and a person is told it drained.
import type { App } from '#application/ports/app.ts';
import type { RepoId } from '#domain/shared/index.ts';
import { type InFlight, drainedMessage, inFlightLine } from '#domain/capacity/index.ts';
import { notifyLater } from '#application/operations/notifications.ts';
import { unblockableTasks } from '#application/runs/unblock.ts';

export interface SchedulerWork {
  busy: boolean;
  follow_ups: number;
  reviews: number;
}

export function inFlight(app: App, repo: RepoId | null, work: SchedulerWork): InFlight {
  const stored = app.inFlightCounts(repo);
  const unblocks = unblockableTasks(app).filter((t) => repo === null || t.repo_id === repo).length;
  return { ...stored, unblocks, follow_ups: work.follow_ups, reviews: work.reviews };
}

export function finishDrains(app: App, work: SchedulerWork, log: (msg: string) => void): void {
  const draining = app.draining();
  if (draining.daemon && !work.busy && !inFlightLine(inFlight(app, null, work))) {
    app.setPaused(true);
    app.setDraining({ daemon: false, repos: draining.repos });
    log('drained: nothing is in flight, the daemon is paused');
    notifyLater(app, { kind: 'drained', ...drainedMessage(null) });
  }
  const done = draining.repos.filter((id) => !inFlightLine(inFlight(app, id, work)));
  if (!done.length) return;
  app.setDraining({ daemon: app.draining().daemon, repos: draining.repos.filter((id) => !done.includes(id)) });
  for (const id of done) {
    const repo = app.getRepo(id);
    if (!repo) continue;
    app.pauseRepo(id, 'drained');
    log(`drained ${repo.name}: nothing is in flight, the repo is paused`);
    notifyLater(app, { kind: 'drained', ...drainedMessage(repo.name) });
  }
}
