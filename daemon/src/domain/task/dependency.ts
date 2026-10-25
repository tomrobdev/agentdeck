// When a task with `after_task` may start, and why not. Pure: no I/O.

/** `pr_mode` is that of the dependency's repo: a done task in a repo that opens PRs isn't met until its PR is merged. */
type Dependency = { status: string; pr_url: string | null; pr_state: string | null; pr_mode: string; done_by: string | null };

/**
 * Where a task stands with its `after_task`:
 * - none: it has no dependency
 * - met: the dependency is done and, if its repo opens PRs, the PR is merged (or a person marked it done and its PR is not open)
 * - waiting: the dependency is still on its way (queued, running, its PR not opened yet, or its PR is open)
 * - stuck: the dependency won't get there on its own (it failed, was blocked or cancelled, its PR could not
 *   be opened or was closed, or it is gone). The task still waits, since retrying the dependency releases it,
 *   but a human has to act. `reason` says why, in a few words.
 * Mirrors DEPENDENCY_MET in db/tasks.ts.
 */
export type DependencyState = { kind: 'none' } | { kind: 'met' } | { kind: 'waiting' } | { kind: 'stuck'; reason: string };

export function dependencyState(task: { after_task: number | null }, dependency: Dependency | undefined): DependencyState {
  if (task.after_task === null) return { kind: 'none' };
  const id = `#${task.after_task}`;
  if (!dependency) return { kind: 'stuck', reason: `${id} no longer exists` };
  switch (dependency.status) {
    case 'done':
      if (dependency.pr_state === 'merged') return { kind: 'met' };
      if (dependency.pr_url === null && dependency.pr_state === null && dependency.pr_mode === 'off') return { kind: 'met' };
      // A person said it is done: that releases dependents unless its PR is still open (they wait for the merge).
      if (dependency.done_by === 'person' && dependency.pr_state !== 'open') return { kind: 'met' };
      if (dependency.pr_state === 'closed') return { kind: 'stuck', reason: `${id}'s PR was closed without merging` };
      if (dependency.pr_state === 'failed') return { kind: 'stuck', reason: `${id}'s PR could not be opened` };
      return { kind: 'waiting' };
    case 'failed':
      return { kind: 'stuck', reason: `${id} failed` };
    case 'blocked':
      return { kind: 'stuck', reason: `${id} is blocked` };
    case 'cancelled':
      return { kind: 'stuck', reason: `${id} was cancelled` };
    default:
      return { kind: 'waiting' };
  }
}

/** Whether a task is held back by its `after_task` (waiting or stuck). A missing dependency holds the task. */
export function isWaiting(task: { after_task: number | null }, dependency: Dependency | undefined): boolean {
  const s = dependencyState(task, dependency).kind;
  return s === 'waiting' || s === 'stuck';
}
