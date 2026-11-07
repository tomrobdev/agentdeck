// Which plan a task follows. Pure: no I/O.
import type { TaskId } from '../shared/id.ts';

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

/** The task whose plan this one follows: the one its link names, or else itself. */
export const planOwnerOf = (task: PlanFollower): TaskId => task.plan?.task ?? task.id;

/** Whether the task has a plan link at all, whether to its own plan or another task's. */
export const hasPlanLink = (task: Pick<PlanFollower, 'plan'>): boolean => task.plan !== null;

/** The task whose plan this one follows when that is another task; null when it follows its own plan or none. */
export const otherPlanOwner = (task: PlanFollower): TaskId | null => {
  const owner = planOwnerOf(task);
  return owner === task.id ? null : owner;
};
