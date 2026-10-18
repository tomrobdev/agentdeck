// When a task with `after_task` may start. Pure: no I/O.

/**
 * Whether a task is held back by its `after_task`: the dependency must be done and, if it opened a PR,
 * that PR merged. Mirrors DEPENDENCY_MET in db/tasks.ts. A missing dependency holds the task.
 */
export function isWaiting(
  task: { after_task: number | null },
  dependency: { status: string; pr_url: string | null; pr_state: string | null } | undefined,
): boolean {
  if (task.after_task === null) return false;
  if (!dependency || dependency.status !== 'done') return true;
  return dependency.pr_url !== null && dependency.pr_state !== 'merged';
}
