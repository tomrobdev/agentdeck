// A task's target: the branch its work starts from, syncs with and lands on, the repo's base unless the task names another.
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import type { Checkout } from '#domain/work/task/checkout.ts';

/** What a task's target is read from: its own, else its repo's base. */
export interface TargetOwner {
  target: string | null;
}

export const targetOf = (task: TargetOwner, repo: { base_branch: string }): string => task.target ?? repo.base_branch;

/** One end of a builds-on link, as the target check reads it: id is null for a task not added yet. */
export interface TargetEnd extends TargetOwner {
  id: TaskId | null;
  repo_id: RepoId;
  base_branch: string;
}

const onBase = (end: TargetEnd): boolean => targetOf(end, end) === end.base_branch;

export function buildsOnTargetError(task: TargetEnd, on: TargetEnd): string | null {
  const mine = targetOf(task, task);
  const theirs = targetOf(on, on);
  const same = task.repo_id === on.repo_id ? mine === theirs : onBase(task) && onBase(on);
  if (same) return null;
  const name = task.id === null ? 'the new task' : `#${task.id}`;
  return `${name} targets ${mine} and #${on.id} targets ${theirs}, so it can't build on it: give them the same target, or make it an after link instead`;
}

export function targetChangeError(task: { id: TaskId; checkout: Pick<Checkout, 'branch'> | null }): string | null {
  if (!task.checkout?.branch) return null;
  return `#${task.id} has a branch already (${task.checkout.branch}), so its target can't change`;
}

export function missingTargetError(target: string): string {
  return `no branch ${target} locally or as origin/${target}, so it can't be a target`;
}
