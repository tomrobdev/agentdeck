// The name of a task's branch.
import type { Checkout } from '#domain/work/task/checkout.ts';
import type { Task } from '#domain/work/task/task.ts';

export function branchName(task: { id: Task['id']; checkout: Pick<Checkout, 'branch'> | null }): string {
  return task.checkout?.branch ?? `agentdeck/task-${task.id}`;
}
