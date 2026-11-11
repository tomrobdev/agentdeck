// Runs: a task's attempts, live state, syncs and verify runs.
import type { RunId } from '../../domain/shared/index.ts';
import type { RunKind, VerifyFinding } from '../../domain/runs/index.ts';
import type { TaskDetail } from './work.ts';

/** A running task's live state. `since` is UTC `YYYY-MM-DD HH:MM:SS`; `tool` is a few words, e.g. "Edit worker.ts". */
export interface LiveView {
  since: string;
  turns: number;
  max_turns: number;
  tool: string | null;
}

/** A sync of a done task under way. `since` is null for a clean sync (no claude), else the resolve run's start, UTC `YYYY-MM-DD HH:MM:SS`. */
export interface SyncView {
  /** The base branch being synced with. */
  base: string;
  since: string | null;
  /** A resolve run is settling conflicts. */
  resolving: boolean;
  turns: number;
  max_turns: number;
  tool: string | null;
}

export interface Run {
  id: RunId;
  /**
   * A resolve run merges the base branch into the task's branch, an unblock run reads why a blocked task stopped, a review
   * run reads a done task's changes; none uses an attempt.
   */
  kind: RunKind;
  /** A resolve run carries the attempt it ran beside, so pick runs by id. */
  attempt: number;
  started_at: string;
  ended_at: string | null;
  outcome: 'done' | 'blocked' | 'failed' | 'cancelled' | 'rate_limited' | 'interrupted' | null;
  num_turns: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** What the run would have cost at API prices, in US dollars, from claude's result; 0 until it ends, or with no result. */
  cost_usd: number;
  tests_passed: number | null;
  result_text: string | null;
  denials: number;
  /** Turns so far while the run is live; the header of an unblock or review run reads it. */
  live_turns: number;
  /** The last tool call while the run is live, in a few words; null before the first. */
  live_tool: string | null;
  /** The model the run was started with; null for a run from before runs recorded it. Missing from a daemon that predates it. */
  model?: string | null;
  /** The exact model id claude's init line named, such as claude-sonnet-5-5; null until it arrives. */
  model_id?: string | null;
  /** For a review run, the patch-id of the task's changes it was started to read; null for other kinds. Missing from a daemon that predates it. */
  diff_hash?: string | null;
  /**
   * For a verify run, the base commit it read; its findings are its `result_text`, as JSON (`runFindings` in domain/runs).
   * Null for other kinds. Missing from a daemon that predates it.
   */
  base_commit?: string | null;
  /** The code comment lines a work run's branch adds, as last measured; null when not measured. Missing from a daemon that predates it. */
  code_comment_lines?: number | null;
  /** Those lines as a share of the lines the branch adds, from 0 to 100; null when not measured. */
  code_comment_percent?: number | null;
  /** For a failed or blocked run: its turns, time, tools and tests summed up from its log, with a verdict line. Null otherwise. */
  summary?: RunSummary | null;
}

/** A failed or blocked run summed up from its log (`runSummary` in domain/runs). */
export interface RunSummary {
  /** How claude ended: out of turns, on its own, on another error, or cut off before a result. */
  end: 'max_turns' | 'ended' | 'error' | 'cut_off';
  turns: number;
  max_turns: number | null;
  minutes: number;
  test_minutes: number;
  tools: { name: string; count: number }[];
  test_runs: number;
  test_turns: number;
  last_test: 'passed' | 'failed' | null;
  refused: number;
  /** The tail of the last failing output the run saw. */
  excerpt: string | null;
  final_message: string | null;
  /** The last measurement of the code comments the branch adds; null when not measured. Missing from a daemon that predates it. */
  code_comments?: string | null;
  /** The summary in one line, e.g. "used 60 of 60 turns, 14 of them running tests that kept failing". */
  verdict: string;
}

/** What a sync of a task's branch came to (POST /api/tasks/:id/sync). */
export interface SyncResult {
  /** `skipped`: conflicts, but auto_resolve is off. `deferred`: the usage limit or a cancel stopped it. */
  outcome: 'up_to_date' | 'clean' | 'resolved' | 'blocked' | 'skipped' | 'deferred' | 'error';
  files: string[];
  reason?: string;
  /** The branch was pushed, so the PR has it. */
  pushed: boolean;
  push_error?: string;
  task: TaskDetail;
}

/**
 * POST /api/tasks/:id/verify: a verify run started on a proposed or queued task. With `{ wait: true }` the answer comes
 * once it ends, with `report`; else at once, and the run's row says how it goes.
 */
export interface VerifyResult {
  run_id: RunId;
  report: {
    outcome: 'done' | 'garbage' | 'failed' | 'rate_limited' | 'cancelled';
    findings: VerifyFinding[];
    commit: string | null;
    reason?: string;
  } | null;
  task: TaskDetail;
}
