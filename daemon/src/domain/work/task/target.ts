// A task's target: the branch its work starts from, syncs with and lands on, the repo's base unless the task names another.
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import type { Checkout } from '#domain/work/task/checkout.ts';
import { type PlanBranchStatus, isLivePlanBranch } from '#domain/work/plans/plan-branch.ts';

export interface TargetOwner {
  target: string | null;
}

export const targetOf = (task: TargetOwner, repo: { base_branch: string }): string => task.target ?? repo.base_branch;

/** Where a task's work lands, for a link across repos: every repo's base is one place (a null target), any other branch its name. */
export interface Place {
  target: string | null;
  plan_branch: PlanBranchStatus | null;
}

export const BASE_PLACE: Place = { target: null, plan_branch: null };

export const placeAt = (target: string | null, base_branch: string, plan_branch: PlanBranchStatus | null): Place =>
  target === null || target === base_branch ? BASE_PLACE : { target, plan_branch };

const livePlanBranch = (place: Place): boolean => place.plan_branch !== null && isLivePlanBranch({ status: place.plan_branch });

export const placesUsed = (place: Place): (string | null)[] =>
  place.target === null ? [null] : livePlanBranch(place) ? [place.target, null] : [place.target];

export const placesReached = (place: Place): (string | null)[] => (place.plan_branch === 'landed' ? [place.target, null] : [place.target]);

export const placesReachable = (place: Place): (string | null)[] =>
  place.plan_branch === 'landed' || livePlanBranch(place) ? [place.target, null] : [place.target];

export const meets = (reached: (string | null)[], used: (string | null)[]): boolean => reached.some((p) => used.includes(p));

export interface TargetEnd extends TargetOwner {
  id: TaskId | null;
  repo_id: RepoId;
  base_branch: string;
  plan_branch: PlanBranchStatus | null;
}

const placeOfEnd = (end: TargetEnd): Place => placeAt(end.target, end.base_branch, end.plan_branch);

export function buildsOnTargetError(task: TargetEnd, on: TargetEnd): string | null {
  if (meets(placesReachable(placeOfEnd(on)), placesUsed(placeOfEnd(task)))) return null;
  const name = task.id === null ? 'the new task' : `#${task.id}`;
  return `${name} targets ${targetOf(task, task)} and #${on.id} targets ${targetOf(on, on)}, whose work never reaches it, so it can't build on it: give them the same target, or make it an after link instead`;
}

export function targetChangeError(task: { id: TaskId; checkout: Pick<Checkout, 'branch'> | null }): string | null {
  if (!task.checkout?.branch) return null;
  return `#${task.id} has a branch already (${task.checkout.branch}), so its target can't change`;
}

export function missingTargetError(target: string): string {
  return `no branch ${target} locally or as origin/${target}, so it can't be a target`;
}
