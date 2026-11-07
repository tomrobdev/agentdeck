// The task entity. Pure: no I/O.
import type { MergeMethod } from '../pull-request/merge.ts';
import type { PrState } from '../pull-request/pr.ts';
import type { TaskStatus } from './lifecycle.ts';

/** Who made a task: a person, or the planner proposing it. */
export type TaskSource = 'manual' | 'planner';

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
  source: TaskSource;
  restarts: number; // times a daemon restart requeued this task mid-run
  pr_url: string | null; // the pull request the daemon opened when the task finished
  pr_state: PrState | null;
  merge_method: MergeMethod | null; // how the PR was merged from the app
  needs: string | null; // JSON Needs (domain/task/needs.ts) the worker said it needs when it blocked; cleared when queued again
  question: string | null; // JSON UnblockQuestion (domain/run/unblock.ts) an unblock run left on the blocked task; cleared with `needs`
  plan_steps: string | null; // JSON array of the linked plan's step ids; null means every unfinished step (see planStepIds)
  done_by: 'person' | null; // 'person' when mark_done set the status; cleared whenever the task leaves done
  auto_merge: number | null; // 1 or 0 overrides the repo's auto_merge; null = the repo's (domain/pull-request/auto-merge.ts)
  auto_merge_check: string | null; // JSON { verdict, reasons }: the PR refresh's latest auto-merge check while the PR is open
  auto_merge_checked_at: string | null; // when that check was made
  pr_checks_opened: string | null; // JSON CheckCounts: the PR's checks the first time they settled after it opened
  pr_checks_merged: string | null; // JSON CheckCounts: the PR's checks when it was merged
  merge_requested_at: string | null; // when a person asked the daemon to merge the PR once it is ready; null when there is no request
  merge_request_method: MergeMethod | null; // the method that request asked for
  merge_request_check: string | null; // JSON { verdict, reasons }: the PR refresh's latest merge request check
  syncing_since: string | null; // when a sync of the branch began; NULL when none is running
  pr_checks: string | null; // JSON StoredChecks (domain/pull-request/checks.ts): the open PR's latest checks, one by one, and when they were read
  plan_task: number | null; // the task whose plan this one follows (itself when its own plan was given with --plan); null follows its own plan, if any
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

/**
 * The sections every task prompt has, in order, each a markdown `##` heading. The delegate skill (.claude/skills/delegate)
 * asks for the same. A task linked to a plan (agentdeck add --plan) needs only Goal, Out of scope and Constraints: the
 * daemon puts the linked steps into the worker's prompt, and they supply Change and Definition of done.
 */
export const PROMPT_SECTIONS = `## Goal
What the task achieves, in a sentence or two.

## Context
The files to start from, why it is needed, related tasks or plans.

## Change
What to do.

## Out of scope
What not to touch.

## Constraints
Limits the agent must keep to, such as no new dependencies or no changes to package.json.

## Definition of done
The test command passing, plus concrete checks a reviewer can confirm.`;

/** The model aliases claude takes; the planner chooses among these. */
export const MODELS = ['haiku', 'sonnet', 'opus'];

/** A model claude will accept: an alias, or a full model id such as claude-sonnet-5-5. */
export const isModel = (model: string): boolean => MODELS.includes(model) || /^claude-[a-z0-9][a-z0-9.-]*$/.test(model);

/** Statuses of a task with a live run: running, or running and asked to stop. */
export const RUNNING_STATUSES: TaskStatus[] = ['running', 'cancel_requested'];

/** Statuses whose task still needs work or a decision. */
export const OPEN_STATUSES: TaskStatus[] = ['proposed', 'queued', ...RUNNING_STATUSES];

/** Statuses in which a task's title, prompt and limits may be edited: waiting, or finished unsuccessfully. */
export const EDITABLE_STATUSES: TaskStatus[] = ['proposed', 'queued', 'blocked', 'failed'];

/** Statuses in which a task's own plan may be attached or replaced: any but a live run's, whose end would write the old plan back. */
export const PLAN_ATTACHABLE_STATUSES: TaskStatus[] = ['proposed', 'queued', 'done', 'blocked', 'failed', 'cancelled'];

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
