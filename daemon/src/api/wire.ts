// Tasks as the API sends them.
import * as actions from '#application/actions.ts';
import type { ComposedApp } from '#application/actions.ts';
import { type TaskId, stored } from '#domain/shared/index.ts';
import { type PullRequest, prFields } from '#domain/landing/index.ts';
import type { Checkout } from '#domain/work/index.ts';
import type { PlanLink } from '#domain/work/index.ts';
import { type TaskState, stateFields } from '#domain/work/index.ts';

const flat = <T extends TaskState & { pr: PullRequest | null; checkout: Checkout | null; plan: PlanLink | null }>(task: T) => {
  const { pr, checkout, plan, ...fields } = task;
  return stored({
    ...fields,
    ...stateFields(task),
    ...prFields(pr),
    branch: checkout?.branch ?? null,
    worktree: checkout?.worktree ?? null,
    syncing_since: checkout?.syncing_since ?? null,
    plan_task: plan?.task ?? null,
    plan_steps: plan?.steps ?? null,
  });
};

export async function taskDetail(db: ComposedApp, id: TaskId) {
  const detail = await actions.taskDetail(db, id);
  return { ...flat(detail), runs: detail.runs.map(stored) };
}

export function taskViews(db: ComposedApp, filter: Parameters<typeof actions.taskViews>[1]) {
  return actions.taskViews(db, filter).map((task) => {
    const { pr_checks: _pr_checks, ...fields } = flat(task);
    return fields;
  });
}
