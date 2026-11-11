// A GitHub Actions job that never started (a billing stop, a spending limit, a disabled workflow): told apart from one that failed, with GitHub's message.
import { withoutFailure } from '#domain/landing/pull-request/check-failures.ts';
import type { PrCheck } from '#domain/landing/pull-request/checks.ts';

/** What GitHub's job API says about whether a job started: the runner it got and how many steps it ran. */
export interface JobStart {
  /** The runner's name; null when GitHub gave the job none. */
  runner_name: string | null;
  steps: number;
}

const NOT_STARTED = /\bwas not started\b/i;

export const NEVER_STARTED = 'the job never started: GitHub gave it no runner and no steps';

export function notStartedMessage(job: JobStart, annotations: string[]): string | null {
  const said = annotations.find((m) => NOT_STARTED.test(m));
  if (said) return said;
  if (job.runner_name !== null || job.steps > 0) return null;
  return annotations[0] ?? NEVER_STARTED;
}

export const asNotRun = (check: PrCheck, message: string): PrCheck => ({ ...withoutFailure(check), state: 'not_run', not_run: message });

export const ciNotRunMessages = (checks: PrCheck[]): string[] => [
  ...new Set(checks.filter((c) => c.state === 'not_run').map((c) => c.not_run ?? NEVER_STARTED)),
];

export const ciNotRunText = (messages: string[]): string => `CI did not run: ${messages.join('; ')}`;
