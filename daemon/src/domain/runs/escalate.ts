// Escalation: a retry after a failure a stronger model may fix runs one model up. Pure: no I/O.
import type { Needs } from '../work/index.ts';
import { INTERRUPTED, NO_CHANGE, type Run, type RunOutcome, TESTS_FAILED, TURN_LIMIT, isNoResult, isSetupFailure } from './run.ts';

/** The model aliases from weakest to strongest: an escalation goes one step along. */
const LADDER = ['haiku', 'sonnet', 'opus'];

/**
 * The model one step up from `model`: haiku to sonnet, sonnet to opus. A full model id goes by its family
 * (claude-haiku-5-5 to sonnet). Null for the strongest, and for a model not on the ladder.
 */
export function strongerModel(model: string): string | null {
  const step = LADDER.findIndex((m) => model === m || new RegExp(`^claude-${m}\\b`).test(model));
  return step < 0 ? null : (LADDER[step + 1] ?? null);
}

/**
 * A failure a stronger model may fix: the turn limit, failing tests, an error claude reported, an end with no result after
 * the run had worked, or a run that finished without a change.
 */
export type HardFailure = 'turn_limit' | 'tests_failed' | 'error' | 'no_result' | 'no_change';

/** How a work run ended, as far as the escalation reads it: its outcome, the stop reason, and what blamed the environment. */
export interface WorkRunEnd {
  outcome: RunOutcome | null;
  /** The stop reason (`WorkerResult.reason`, a task's `stop_reason`). */
  reason: string | null;
  /** What the worker said it needs, for a block. */
  needs: Needs | null;
  /** Tool uses the permission rules refused during the run. */
  denials: number;
  /** Turns the run took (claude's count, else as counted live). */
  turns: number;
}

/**
 * Which failure a stronger model may fix a run's end was, or null for one it would not: a done or cancelled run, a rate limit or
 * a restart, a block the environment caused (NEEDS, refused tool uses, a failed setup), a conflict, a block the agent reported in
 * its own words (the person's note answers it), and a claude that stopped before its first turn. Refused tool uses blame the
 * environment unless the tests failed: then they did not stop the run.
 */
export function hardFailure(end: WorkRunEnd): HardFailure | null {
  if (end.outcome !== 'failed' && end.outcome !== 'blocked') return null;
  const reason = end.reason ?? '';
  if (end.needs || isSetupFailure(reason) || (end.denials > 0 && reason !== TESTS_FAILED)) return null;
  if (end.outcome === 'blocked') return reason === NO_CHANGE ? 'no_change' : null;
  if (reason === TURN_LIMIT) return 'turn_limit';
  if (reason === TESTS_FAILED) return 'tests_failed';
  if (isNoResult(reason)) return end.turns > 0 ? 'no_result' : null;
  return /^error_/.test(reason) ? 'error' : null;
}

/** A change of a task's model one step up, and the failure that called for it. */
export interface Escalation {
  from: string;
  to: string;
  cause: HardFailure;
}

/**
 * Whether the task's next attempt, after work run `run` ended as `end`, runs one model up. Only when the repo has escalate on,
 * the run ran on the task's model as it is now (a person who changed the model since, or an escalation already made for this
 * run, wins), it ended in a failure a stronger model may fix, and there is a stronger model.
 */
export function escalation(
  task: { model: string },
  run: Pick<Run, 'model'>,
  end: WorkRunEnd,
  repo: { escalate: boolean },
): Escalation | null {
  if (!repo.escalate || run.model !== task.model) return null;
  const cause = hardFailure(end);
  const to = cause && strongerModel(task.model);
  return cause && to ? { from: task.model, to, cause } : null;
}

const CAUSE_TEXT: Record<HardFailure, string> = {
  turn_limit: 'the turn limit',
  tests_failed: 'failing tests',
  error: 'an error',
  no_result: 'an end with no result',
  no_change: 'a run that changed nothing',
};

/**
 * Why the model changed, for the timeline and the next prompt, which reads "This attempt " before it: "runs on opus, up from
 * sonnet, after the turn limit (the last run used 60 of 60 turns, …)". `verdict` is the run's summary in a line (`runSummary`).
 */
export function escalationReason(e: Escalation, verdict: string | null): string {
  return `runs on ${e.to}, up from ${e.from}, after ${CAUSE_TEXT[e.cause]}${verdict ? ` (the last run ${verdict})` : ''}`;
}

/**
 * The reason of the escalation made since the task's last work run that ended (a restart or a rate limit only cut it off), for
 * the prompt of the run it is for; null when there is none. A row from the second that run started counts.
 */
export function escalationSince(
  events: { type: string; reason: string | null; at: string }[],
  previousRuns: Pick<Run, 'kind' | 'outcome' | 'started_at'>[],
): string | null {
  const last = previousRuns.findLast((r) => r.kind === 'work' && r.outcome !== INTERRUPTED && r.outcome !== 'rate_limited');
  if (!last) return null;
  return events.findLast((e) => e.type === 'escalate' && e.at >= last.started_at)?.reason ?? null;
}
