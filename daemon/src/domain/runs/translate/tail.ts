// What a live run shows of itself beside others: its turn limit and the last lines of its log.
import { REVIEW_MAX_TURNS } from '#domain/runs/review.ts';
import { UNBLOCK_MAX_TURNS } from '#domain/runs/unblock.ts';
import { VERIFY_MAX_TURNS } from '#domain/runs/verify.ts';
import type { RunKind } from '#domain/runs/run.ts';
import type { LogEntry } from '#domain/runs/translate/log.ts';

export function liveMaxTurns(kind: RunKind, taskMaxTurns: number): number {
  switch (kind) {
    case 'unblock':
      return Math.min(UNBLOCK_MAX_TURNS, taskMaxTurns);
    case 'verify':
      return VERIFY_MAX_TURNS;
    case 'review':
    case 'plan_review':
      return REVIEW_MAX_TURNS;
    case 'work':
    case 'resolve':
    case 'plan_resolve':
      return taskMaxTurns;
    default: {
      const never: never = kind;
      return never;
    }
  }
}

function lineOf(entry: LogEntry): string | null {
  switch (entry.kind) {
    case 'text':
      return entry.text.trim().split('\n')[0] || null;
    case 'tool':
      return `${entry.name} ${entry.summary}`.trim();
    case 'error':
      return `error: ${entry.text.trim().split('\n')[0]}`;
    case 'tests':
      return `Tests ${entry.passed ? 'passed' : 'failed'}`;
    case 'setup':
      return `Setup ${entry.passed ? 'passed' : 'failed'}: ${entry.cmd}`;
    case 'tool_result':
    case 'result':
    case 'prompt':
      return null;
    default: {
      const never: never = entry;
      return never;
    }
  }
}

export function logTail(entries: LogEntry[], count: number): string[] {
  return entries
    .flatMap((e) => lineOf(e) ?? [])
    .slice(-count)
    .map((line) => (line.length > 160 ? `${line.slice(0, 159)}…` : line));
}
