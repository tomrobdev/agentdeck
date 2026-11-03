// The name of a task's branch. Pure: no I/O.
import type { Task } from '../task/task.ts';

/** The branch a task works on: its own once it has one, else the name the daemon will give it. */
export function branchName(task: Pick<Task, 'id' | 'branch'>): string {
  return task.branch ?? `agentdeck/task-${task.id}`;
}
