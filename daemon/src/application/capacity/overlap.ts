import type { App } from '#application/ports/app.ts';
import type { Draining } from '#domain/capacity/index.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { type Footprinted, RUNNING_STATUSES, type Task, footprint, overlapWith, planOwnerOf } from '#domain/work/index.ts';

export function overlapWaits(app: App): Map<TaskId, TaskId> {
  const open = app.tasksWithStatus(['queued', ...RUNNING_STATUSES]);
  const running = open.filter((t) => RUNNING_STATUSES.includes(t.status));
  const waits = new Map<TaskId, TaskId>();
  if (!running.length) return waits;
  const queued = open.filter((t) => t.status === 'queued' && running.some((r) => r.repo_id === t.repo_id));
  if (!queued.length) return waits;
  const changed = app.changedPathsOf([...running, ...queued].map((t) => t.id));
  const pathsOf = (task: Task): string[] => {
    const plan = app.ownPlan(planOwnerOf(task));
    return footprint({
      prompt: task.prompt,
      plan: plan ? { html: plan.html, steps: task.plan?.steps ?? null } : null,
      changed: changed.get(task.id) ?? [],
    });
  };
  const footprints: Footprinted[] = running.map((r) => ({ id: r.id, paths: pathsOf(r) }));
  const repoOf = new Map(running.map((r) => [r.id, r.repo_id]));
  for (const task of queued) {
    const other = overlapWith(
      pathsOf(task),
      footprints.filter((f) => repoOf.get(f.id) === task.repo_id),
    );
    if (other !== null) waits.set(task.id, other);
  }
  return waits;
}

export function claimNext(app: App, draining: Draining): Task | undefined {
  return app.claimNextTask(draining, new Set(overlapWaits(app).keys()));
}
