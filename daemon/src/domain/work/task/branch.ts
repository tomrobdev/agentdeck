// The name of a task's branch.
import type { Checkout } from './checkout.ts';
import type { Task } from './task.ts';

export function branchName(task: { id: Task['id']; checkout: Pick<Checkout, 'branch'> | null }): string {
  return task.checkout?.branch ?? `agentdeck/task-${task.id}`;
}
