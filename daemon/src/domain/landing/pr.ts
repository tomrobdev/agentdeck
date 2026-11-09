// A task's pull request as a value, and what goes into one. Pure: no I/O.
import { STATUS_TAIL } from '../shared/index.ts';
import type { AutoMergeCheck } from './merge.ts';
import type { CheckCounts, StoredChecks } from './checks.ts';
import type { MergeMethod } from '../repos/index.ts';

/** `failed` is the daemon's own: the task finished but its PR could not be opened (`FailedPullRequest`). */
export type PrState = 'open' | 'merged' | 'closed' | 'failed';

/** A PR's checks: the latest ones read, and the counts kept from when they first settled and from when it merged. */
export interface PrChecks {
  latest: StoredChecks | null;
  opened: CheckCounts | null;
  merged: CheckCounts | null;
}

/** A person's merge request on a PR: when they asked, the method they asked for, and the last check of it. */
export interface PrMergeRequest {
  requested_at: string;
  method: MergeMethod | null;
  check: AutoMergeCheck | null;
}

/** What a task keeps about its PR in any state. */
export interface PrRecord {
  merge_method: MergeMethod | null; // how the PR was merged from the app
  checks: PrChecks;
  auto_merge_check: AutoMergeCheck | null; // the PR refresh's latest auto-merge check while the PR is open
  auto_merge_checked_at: string | null; // when that check was made
  merge_request: PrMergeRequest | null;
}

/** A PR that exists on GitHub. */
export interface OpenedPullRequest extends PrRecord {
  state: Exclude<PrState, 'failed'>;
  url: string;
}

/** The task finished but its PR could not be opened. `url` is the PR an earlier attempt opened, which is closed or merged; null with none. */
export interface FailedPullRequest extends PrRecord {
  state: 'failed';
  url: string | null;
}

/** A task's pull request. A task with no PR yet has null, not a value. */
export type PullRequest = OpenedPullRequest | FailedPullRequest;

/** The url of a task's PR while it is open; null with none or in any other state. */
export const openPrUrl = (pr: PullRequest | null): string | null => (pr?.state === 'open' ? pr.url : null);

/**
 * Whether `gh pr create` failed because the branch has an open PR already (gh: 'a pull request for branch "x" into branch "y"
 * already exists'): a daemon stopped between opening it and recording it, or the task moved on while it opened.
 */
export const isPrExistsError = (error: string): boolean => /a pull request for branch .+ already exists/i.test(error);

/**
 * Which of a branch's PRs (`prs`, newest first, as gh lists them) is the one `gh pr create` found: the open one, since gh only
 * refuses while one is open; else the newest, which was closed or merged since. Null when the branch has none.
 */
export const existingPr = <P extends { state: PrState }>(prs: P[]): P | null => prs.find((p) => p.state === 'open') ?? prs[0] ?? null;

/** A PR as flat fields, the shape of its columns on a task. */
export interface PrFields {
  pr_url: string | null;
  pr_state: PrState | null;
  merge_method: MergeMethod | null;
  auto_merge_check: AutoMergeCheck | null;
  auto_merge_checked_at: string | null;
  pr_checks: StoredChecks | null;
  pr_checks_opened: CheckCounts | null;
  pr_checks_merged: CheckCounts | null;
  merge_requested_at: string | null;
  merge_request_method: MergeMethod | null;
  merge_request_check: AutoMergeCheck | null;
}

/**
 * The PR that flat fields describe. No state means no PR, and a PR on GitHub needs its url: fields that say otherwise are half-written
 * and read as none, as a malformed stored value does. So does a merge request's method or check with no time it was asked for.
 */
export function pullRequestOf(fields: PrFields): PullRequest | null {
  const { pr_state: state, pr_url: url } = fields;
  if (state === null) return null;
  const record: PrRecord = {
    merge_method: fields.merge_method,
    checks: { latest: fields.pr_checks, opened: fields.pr_checks_opened, merged: fields.pr_checks_merged },
    auto_merge_check: fields.auto_merge_check,
    auto_merge_checked_at: fields.auto_merge_checked_at,
    merge_request:
      fields.merge_requested_at === null
        ? null
        : { requested_at: fields.merge_requested_at, method: fields.merge_request_method, check: fields.merge_request_check },
  };
  if (state === 'failed') return { ...record, state, url };
  return url === null ? null : { ...record, state, url };
}

/** A PR as flat fields: the way back from `pullRequestOf`. */
export function prFields(pr: PullRequest | null): PrFields {
  return {
    pr_url: pr?.url ?? null,
    pr_state: pr?.state ?? null,
    merge_method: pr?.merge_method ?? null,
    auto_merge_check: pr?.auto_merge_check ?? null,
    auto_merge_checked_at: pr?.auto_merge_checked_at ?? null,
    pr_checks: pr?.checks.latest ?? null,
    pr_checks_opened: pr?.checks.opened ?? null,
    pr_checks_merged: pr?.checks.merged ?? null,
    merge_requested_at: pr?.merge_request?.requested_at ?? null,
    merge_request_method: pr?.merge_request?.method ?? null,
    merge_request_check: pr?.merge_request?.check ?? null,
  };
}

export interface PrRun {
  kind?: string; // 'resolve' and 'unblock' runs are listed but never supply the final message; missing means 'work'
  attempt: number;
  outcome: string | null;
  num_turns: number | null;
  cost_usd: number;
  tests_passed: boolean | null;
  result_text: string | null;
}

/** The agent's final message without its trailing "STATUS: DONE" line. */
export function finalMessage(runs: Pick<PrRun, 'kind' | 'result_text'>[]): string {
  const text = runs.filter((r) => (r.kind ?? 'work') === 'work').at(-1)?.result_text ?? '';
  return text.replace(STATUS_TAIL, '').trim();
}

/** The plan a task carries out: its name (`112-plans-in-agentdeck.html`) and the linked steps as AgentDeck stores them. */
export interface PrPlan {
  name: string;
  steps: { title: string; status: string; done: string[] }[];
}

/** The "Plan" section: each linked step with its status, and its done criteria as a checklist for the reviewer. */
function planSection(plan: PrPlan): string[] {
  const out = [`## Plan: \`${plan.name}\``];
  for (const step of plan.steps) {
    out.push('', `**${step.title}** (${step.status})`);
    if (step.done.length) out.push('', ...step.done.map((d) => `- [ ] ${d}`));
  }
  return [...out, ''];
}

/**
 * The agent's final message, the linked plan's steps, a table of the task's runs, and a signature. A verify run read the
 * prompt before the work began, not the work, so it is left out of the table.
 */
export function buildPrBody(task: { id: number }, runs: PrRun[], plan: PrPlan | null = null): string {
  const rows = runs
    .filter((r) => r.kind !== 'verify')
    .map((r) => {
      const tests = r.tests_passed === null ? '-' : r.tests_passed ? 'pass' : 'fail';
      const kind = r.kind === 'resolve' ? ' (conflicts)' : r.kind === 'unblock' ? ' (unblock)' : r.kind === 'review' ? ' (review)' : '';
      return `| ${r.attempt}${kind} | ${r.outcome ?? '-'} | ${r.num_turns ?? '-'} | $${r.cost_usd.toFixed(2)} | ${tests} |`;
    });
  return [
    finalMessage(runs) || '(the agent left no final message)',
    '',
    '<details><summary>Plan and runs</summary>',
    '',
    ...(plan && plan.steps.length ? planSection(plan) : []),
    '| Attempt | Outcome | Turns | Cost | Tests |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '</details>',
    '',
    `Made by AgentDeck task #${task.id}.`,
  ].join('\n');
}

/** Map `gh pr view --json state` output ("OPEN", "MERGED", "CLOSED") to a PR state. */
export function parsePrState(state: string): PrState | null {
  const s = state.trim().toLowerCase();
  return s === 'open' || s === 'merged' || s === 'closed' ? s : null;
}
