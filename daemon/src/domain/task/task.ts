// The task entity. Pure: no I/O.
import type { MergeMethod } from '../pull-request/merge.ts';
import type { PrState } from '../pull-request/pr.ts';
import type { TaskStatus } from './lifecycle.ts';

export interface Task {
  id: number;
  repo_id: number;
  title: string;
  prompt: string;
  status: TaskStatus;
  priority: number;
  model: string;
  max_turns: number;
  attempts: number;
  max_attempts: number;
  branch: string | null;
  worktree: string | null;
  blocked_reason: string | null;
  source: string; // manual | planner
  restarts: number; // times a daemon restart requeued this task mid-run
  pr_url: string | null; // the pull request the daemon opened when the task finished
  pr_state: PrState | null;
  merge_method: MergeMethod | null; // how the PR was merged from the app
  after_task: number | null; // not claimed until that task is done (and its PR merged, if it has one)
  plan_path: string | null; // the plan this task carries out: a repo-relative path under docs/plans/
  plan_steps: string | null; // JSON array of that plan's step ids; null means every unfinished step (see planStepIds)
  created_at: string;
  updated_at: string;
}

export type TaskSummary = Omit<Task, 'prompt'>;

/** The step ids in a task's `plan_steps`, or null when it names none (every unfinished step). */
export function planStepIds(task: Pick<Task, 'plan_steps'>): string[] | null {
  if (task.plan_steps === null) return null;
  try {
    const ids: unknown = JSON.parse(task.plan_steps);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : null;
  } catch {
    return null;
  }
}

/** Statuses whose task still needs work or a decision. */
export const OPEN_STATUSES: TaskStatus[] = ['proposed', 'queued', 'running', 'cancel_requested'];

/** Statuses in which a task's title, prompt and limits may be edited: waiting, or finished unsuccessfully. */
export const EDITABLE_STATUSES: TaskStatus[] = ['proposed', 'queued', 'blocked', 'failed'];

/** First sentence of the prompt, cut at a word boundary. */
export function defaultTitle(prompt: string, max = 72): string {
  const first = prompt.split('\n')[0].trim();
  const sentence = first.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? first;
  if (sentence.length <= max) return sentence.replace(/\.$/, '');
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : max).replace(/[,;:\s]+$/, '')}…`;
}
