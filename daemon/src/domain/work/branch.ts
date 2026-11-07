// The name of a task's branch. Pure: no I/O.
import type { Checkout } from './checkout.ts';
import type { Task } from './task.ts';

/** The branch a task works on: its own once it has one, else the name the daemon will give it. */
export function branchName(task: { id: Task['id']; checkout: Pick<Checkout, 'branch'> | null }): string {
  return task.checkout?.branch ?? `agentdeck/task-${task.id}`;
}
