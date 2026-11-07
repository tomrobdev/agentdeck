// The unblock run: a short claude run that reads why a blocked task stopped and either sends it back to work with a
// note or leaves it blocked with a question and options for a person. It uses no attempt. Pure: no I/O.
import { isConflictReason } from '../branch/sync.ts';
import { parsePlanWithText } from '../plan/plan.ts';
import type { Repo } from '../repo/repo.ts';
import type { Task } from '../task/task.ts';
import { lastLine } from '../text.ts';
import type { PromptPlan } from './prompt.ts';
import { type Run, isSetupFailure } from './run.ts';

/** How the note on a retry by an unblock run begins, so the worker and the timeline can tell it from a person's. */
export const UNBLOCK_NOTE = 'Unblock run: ';

/** An unblock run is short: it reads a block, it does not do the task. */
export const UNBLOCK_MAX_TURNS = 30;

/** The most options a question carries. */
export const MAX_OPTIONS = 4;

/** What an unblock run left on a task it did not retry (the task's `question`). */
export interface UnblockQuestion {
  question: string;
  options: string[];
}

/** What an unblock run's final message says: retry with a note, or ask a person. */
export type UnblockAnswer = { retry: string } | { ask: string; options: string[] };

/** What the daemon does after an unblock run: queue the task again with `note`, or keep it blocked with `ask`. */
export type UnblockDecision = { retry: string } | { ask: UnblockQuestion };

/**
 * Whether only a person can settle the block: packages or hosts the worker named (NEEDS deps, NEEDS host), a setup
 * command that failed, or a conflict. An unblock run never installs, never widens the network and never syncs.
 */
export function onlyAPersonSettles(task: Pick<Task, 'needs' | 'stop_reason'>): boolean {
  const { needs } = task;
  if (needs && (needs.kind === 'deps' || needs.kind === 'host')) return true;
  return isSetupFailure(task.stop_reason) || isConflictReason(task.stop_reason);
}

/**
 * Whether an unblock run may start for `task`: it is blocked, its repo has auto_unblock on, its block isn't one only a
 * person can settle, and it has had no unblock run since it last blocked (`lastRuns` is its runs, oldest first; one
 * still going counts). A block ends a work run, so the runs since the block are those after its newest work run. An
 * unblock run a rate limit stopped never read the block, so it does not count.
 */
export function unblockable(
  task: Pick<Task, 'status' | 'needs' | 'stop_reason'>,
  lastRuns: Pick<Run, 'kind' | 'outcome'>[],
  repo: Pick<Repo, 'auto_unblock'>,
): boolean {
  if (repo.auto_unblock !== 1 || task.status !== 'blocked' || onlyAPersonSettles(task)) return false;
  const since = lastRuns.slice(lastRuns.findLastIndex((r) => r.kind === 'work') + 1);
  return !since.some((r) => r.kind === 'unblock' && r.outcome !== 'rate_limited');
}

/** Appended to the unblock run's system prompt in place of the worker's. */
export function unblockSystemPrompt(): string {
  return `You are running unattended as an AgentDeck unblock run, inside a blocked task's git worktree on its branch.
- Be brief: you have few turns. Read before you change anything.
- Change files with the Edit and Write tools, not shell redirection or sed. Commit what you change with a clear message. Never push, never switch branches.
- Some commands are refused by AgentDeck's tool rules. A refusal covers only that one command: try a simpler command or another tool.
- Never install packages, never ask for network hosts and never edit files under .claude/: a person settles those.
- End your final message with the UNBLOCK lines the prompt asks for, and nothing after them.`;
}

/** The linked plan steps, with their status and text, for the unblock prompt. */
function planSteps(plan: PromptPlan): string {
  const parsed = plan.html === null ? null : parsePlanWithText(plan.html);
  if (!parsed) return `The task follows the plan ${plan.name}, which could not be read.`;
  const ids = plan.steps;
  const lines = [`The task's plan steps (${plan.name}):`];
  parsed.plan.steps.forEach((step, i) => {
    if (ids !== null && (step.id === null || !ids.includes(step.id))) return;
    lines.push(`Step${step.id ? ` "${step.id}"` : ''}: ${step.title} (status: ${step.status})`);
    if (parsed.texts[i]) lines.push(parsed.texts[i].slice(0, 2000));
  });
  return lines.join('\n');
}

export interface UnblockContext {
  /** The plan the task follows, if any. */
  plan: PromptPlan | null;
  /** The final message of the task's last work run. */
  lastMessage: string | null;
  /** The note on the task's latest retry (`latestReviewNote`). */
  reviewNote: string | null;
}

/**
 * The prompt of an unblock run: the task's prompt and plan steps, why it stopped, the last run's final message and the
 * review notes, then what the run may do and the lines it must end with.
 */
export function buildUnblockPrompt(task: Pick<Task, 'id' | 'title' | 'prompt' | 'stop_reason'>, ctx: UnblockContext): string {
  return [
    `AgentDeck unblock run for task #${task.id}: "${task.title}".`,
    '',
    "This task's worker stopped and reported it blocked. You are not that worker: find out why it stopped, then either send it back to work with a note that gets it past the block, or turn the block into one clear question for a person.",
    '',
    'Why it stopped:',
    task.stop_reason ?? '(no reason given)',
    ...(ctx.lastMessage ? ['', "The worker's final message:", ctx.lastMessage.slice(0, 4000)] : []),
    ...(ctx.reviewNote ? ['', 'Notes from review:', ctx.reviewNote.slice(0, 2000)] : []),
    '',
    'The task:',
    task.prompt.slice(0, 4000),
    ...(ctx.plan ? ['', planSteps(ctx.plan)] : []),
    '',
    'You may read the code in this worktree, and make a small fix with commits when that is all that stands in the way. Leave the task itself to the worker.',
    'Retry when a note can get the worker past the block without a decision only a person can make; otherwise ask.',
    '',
    'End your final message with exactly one of these:',
    'UNBLOCK: RETRY: <a note for the worker, on one line: what to do differently>',
    `UNBLOCK: ASK: <one question for a person, on one line>, followed by up to ${MAX_OPTIONS} lines "- <option>", each an answer the person could pick`,
  ].join('\n');
}

const UNBLOCK_LINE = /^UNBLOCK:\s*(RETRY|ASK)\s*:\s*(.*)$/i;
const OPTION_LINE = /^[-*]\s+(.+)$/;

/**
 * What an unblock run's final message says: its last UNBLOCK line, and for ASK the option lines after it (at most
 * MAX_OPTIONS). Anything else (no UNBLOCK line, an empty note or question) counts as ask, with the message's last line.
 */
export function parseUnblock(text: string | null | undefined): UnblockAnswer {
  const lines = (text ?? '')
    .trim()
    .split('\n')
    .map((l) => l.trim());
  const at = lines.findLastIndex((l) => UNBLOCK_LINE.test(l));
  const m = at === -1 ? null : lines[at].match(UNBLOCK_LINE);
  const said = m?.[2].trim() ?? '';
  if (m && said && m[1].toUpperCase() === 'RETRY') return { retry: said };
  if (m && said) {
    const options: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!line) continue;
      const o = line.match(OPTION_LINE);
      if (!o) break;
      options.push(o[1].trim());
    }
    return { ask: said, options: options.slice(0, MAX_OPTIONS) };
  }
  return { ask: lastLine(text ?? '') || 'The unblock run left no answer.', options: [] };
}

/**
 * What follows an unblock run's answer: a retry when the task has attempts left, with the note starting UNBLOCK_NOTE;
 * otherwise, or on ask, a question for a person. A retry with no attempts left asks whether to retry with the note.
 */
export function unblockDecision(answer: UnblockAnswer, task: Pick<Task, 'attempts' | 'max_attempts'>): UnblockDecision {
  if ('ask' in answer) return { ask: { question: answer.ask, options: answer.options } };
  if (task.attempts < task.max_attempts) return { retry: `${UNBLOCK_NOTE}${answer.retry}` };
  return { ask: { question: `The task has no attempts left. Retry it with this note? ${answer.retry}`, options: [] } };
}
