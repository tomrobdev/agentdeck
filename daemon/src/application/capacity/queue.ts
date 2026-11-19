// What queued tasks wait for: what stops the whole queue, and what each task waits for.
import type { App } from '#application/ports/app.ts';
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import { mayStart } from '#domain/capacity/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import type { StartState } from '#domain/work/index.ts';
import { type QueueWait, type StartWait, planBranchWait, startWait } from '#domain/work/index.ts';
import type { Task } from '#domain/work/index.ts';
import { queueWait } from '#application/capacity/gate.ts';

export interface PausedRepo {
  id: RepoId;
  name: string;
  reason: string;
  queued: number;
}

export function queueWaits(app: App): { wait: QueueWait | null; paused_repos: PausedRepo[] } {
  const queued = app.countQueuedByRepo();
  return {
    wait: queueWait(app).wait,
    paused_repos: app
      .listRepos()
      .filter((r): r is Repo & { paused_reason: string } => !!r.paused_reason)
      .map((r) => ({ id: r.id, name: r.name, reason: r.paused_reason, queued: queued.get(r.id) ?? 0 })),
  };
}

export function startWaits(
  app: App,
): (task: Pick<Task, 'id' | 'status' | 'repo_id' | 'target'>, dependency: StartState) => StartWait | null {
  const { wait: queue, used, max } = queueWait(app);
  const repos = new Map<RepoId, Repo>(app.listRepos().map((r) => [r.id, r]));
  const planBranches = app.syncedPlanBranches();
  const planBranchOf = (task: Pick<Task, 'repo_id' | 'target'>) =>
    planBranchWait(planBranches.find((b) => b.repo_id === task.repo_id && b.name === task.target));
  const unblocks = app.liveRuns('unblock');
  const draining = app.draining();
  const ran = draining.daemon || draining.repos.length ? app.queuedThatRan() : new Set<TaskId>();
  const drainOf = (task: Pick<Task, 'id' | 'repo_id'>) =>
    mayStart(draining, { repo_id: task.repo_id, has_run: ran.has(task.id) }) ? null : draining.daemon ? 'daemon' : 'repo';
  return (task, dependency) =>
    startWait(task, {
      queue,
      repoPaused: repos.get(task.repo_id)?.paused_reason ?? null,
      draining: drainOf(task),
      dependency,
      planBranch: planBranchOf(task),
      unblocking: unblocks.has(task.id),
      running: used,
      max,
    });
}
