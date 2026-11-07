// The task entity. Pure: no I/O.
import type { RepoId, TaskId } from '../shared/id.ts';
import type { PullRequest } from '../landing/pr.ts';
import type { Checkout } from './checkout.ts';
import type { TaskStatus } from './lifecycle.ts';
import type { Needs, UnblockQuestion } from './needs.ts';
import type { PlanLink } from './plan-link.ts';

/** Who made a task: a person, or the planner proposing it. */
export type TaskSource = 'manual' | 'planner';

/** What every task has, whatever its status. */
export interface TaskCore {
  id: TaskId;
  repo_id: RepoId;
  title: string;
  prompt: string;
  priority: number;
  model: string;
  max_turns: number;
  attempts: number;
  max_attempts: number;
  checkout: Checkout | null; // the branch and worktree the work is on, and a running sync
  source: TaskSource;
  restarts: number; // times a daemon restart requeued this task mid-run
  pr: PullRequest | null; // the task's pull request, as one value
  plan: PlanLink | null; // the plan this task follows and its linked steps (domain/work/plan-link.ts); null follows its own plan, if any
  auto_merge: boolean | null; // overrides the repo's auto_merge; null = the repo's (domain/landing/auto-merge.ts)
  created_at: string;
  updated_at: string;
}

/** A task waiting to run or running: it carries nothing about how it ended. */
export interface OpenState {
  status: 'proposed' | 'queued' | 'running' | 'cancel_requested';
}

/** A finished task, and whether a person finished it. */
export interface DoneState {
  status: 'done';
  done_by: 'person' | null; // 'person' when mark_done set the status
}

/** A task stopped until something changes. */
export interface BlockedState {
  status: 'blocked';
  stop_reason: string | null;
  needs: Needs | null; // what the worker said it needs when it blocked
  question: UnblockQuestion | null; // what an unblock run left on the task
}

/** A task that ran out of attempts. */
export interface FailedState {
  status: 'failed';
  stop_reason: string | null;
}

/** A cancelled task, with the stop reason it had if it was blocked or failed when cancelled. */
export interface CancelledState {
  status: 'cancelled';
  stop_reason: string | null;
}

/** A task's status and what it carries in that status: the fields of another status can't be set, nor read until the status is narrowed. */
export type TaskState = OpenState | DoneState | BlockedState | FailedState | CancelledState;

export type Task = TaskCore & TaskState;
export type BlockedTask = TaskCore & BlockedState;
export type TaskSummary = Omit<TaskCore, 'prompt'> & TaskState;

export const isBlocked = (task: Task): task is BlockedTask => task.status === 'blocked';

/** A task's stop reason, for code that reports on a task of any status. Only a blocked, failed or cancelled task has one. */
export const stopReasonOf = (state: TaskState): string | null => ('stop_reason' in state ? state.stop_reason : null);

/** The fields a state carries, each null where its status has none: how the columns and the API, which are flat, store them. */
export interface StateFields {
  stop_reason: string | null;
  needs: Needs | null;
  question: UnblockQuestion | null;
  done_by: 'person' | null;
}

export const stateFields = (state: TaskState): StateFields => ({
  stop_reason: stopReasonOf(state),
  needs: state.status === 'blocked' ? state.needs : null,
  question: state.status === 'blocked' ? state.question : null,
  done_by: state.status === 'done' ? state.done_by : null,
});

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
