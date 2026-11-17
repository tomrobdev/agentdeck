// Which plan a task follows.
import type { TaskId } from '#domain/shared/index.ts';

/**
 * A task's link to a plan: the task whose plan it follows (itself when its own plan was given with --plan) and the linked step
 * ids, null for every unfinished step. A task with no link has null, and follows its own plan, if it has one.
 */
export interface PlanLink {
  task: TaskId;
  steps: string[] | null;
}

/** A task as far as its plan goes. */
export interface PlanFollower {
  id: TaskId;
  plan: PlanLink | null;
}

export const planOwnerOf = (task: PlanFollower): TaskId => task.plan?.task ?? task.id;

export const hasPlanLink = (task: Pick<PlanFollower, 'plan'>): boolean => task.plan !== null;

export const otherPlanOwner = (task: PlanFollower): TaskId | null => {
  const owner = planOwnerOf(task);
  return owner === task.id ? null : owner;
};
