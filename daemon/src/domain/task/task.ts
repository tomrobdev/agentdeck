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
  stop_reason: string | null;
  source: string; // manual | planner
  restarts: number; // times a daemon restart requeued this task mid-run
  pr_url: string | null; // the pull request the daemon opened when the task finished
  pr_state: PrState | null;
  merge_method: MergeMethod | null; // how the PR was merged from the app
  after_task: number | null; // not claimed until that task is done (and its PR merged, if it has one)
  plan_path: string | null; // the plan this task carries out: a repo-relative path under docs/plans/
  needs: string | null; // JSON Needs (domain/task/needs.ts) the worker said it needs when it blocked; cleared when queued again
  plan_steps: string | null; // JSON array of that plan's step ids; null means every unfinished step (see planStepIds)
  done_by: 'person' | null; // 'person' when mark_done set the status; cleared whenever the task leaves done
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

/** The sections every task prompt has, in order. The delegate skill (.claude/skills/delegate) asks for the same. */
export const PROMPT_SECTIONS = `Goal: what the task achieves, in a sentence or two.
Context: the files to start from, why it is needed, related tasks or plans.
Change: what to do.
Out of scope: what not to touch.
Constraints: limits the agent must keep to, such as no new dependencies or no changes to package.json.
Definition of done: the test command passing, plus concrete checks a reviewer can confirm.

A task linked to a plan (agentdeck add --plan) needs only Goal, Out of scope and Constraints: the daemon puts the linked steps into the worker's prompt, and they supply Change and Definition of done.`;

/** The model aliases claude takes; the planner chooses among these. */
export const MODELS = ['haiku', 'sonnet', 'opus'];

/** A model claude will accept: an alias, or a full model id such as claude-sonnet-5-5. */
export const isModel = (model: string): boolean => MODELS.includes(model) || /^claude-[a-z0-9][a-z0-9.-]*$/.test(model);

/** Statuses whose task still needs work or a decision. */
export const OPEN_STATUSES: TaskStatus[] = ['proposed', 'queued', 'running', 'cancel_requested'];

/** Statuses in which a task's title, prompt and limits may be edited: waiting, or finished unsuccessfully. */
export const EDITABLE_STATUSES: TaskStatus[] = ['proposed', 'queued', 'blocked', 'failed'];

/** The commit message for work an agent left uncommitted in a task's worktree. */
export function leftoversMessage(task: Pick<Task, 'id' | 'title'>): string {
  return `agentdeck: uncommitted work from task ${task.id}\n\n${task.title}`;
}

/** First sentence of the prompt, cut at a word boundary. */
export function defaultTitle(prompt: string, max = 72): string {
  const first = prompt.split('\n')[0].trim();
  const sentence = first.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? first;
  if (sentence.length <= max) return sentence.replace(/\.$/, '');
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : max).replace(/[,;:\s]+$/, '')}…`;
}
