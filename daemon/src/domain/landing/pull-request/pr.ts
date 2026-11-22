// A task's pull request as a value, and what goes into one.
import { STATUS_TAIL } from '#domain/shared/index.ts';
import type { AutoMergeCheck } from '#domain/landing/merge/merge.ts';
import type { CheckCounts, StoredChecks } from '#domain/landing/pull-request/checks.ts';
import type { MergeMethod } from '#domain/repos/index.ts';

/** `failed` is the daemon's own: the task finished but its PR could not be opened (`FailedPullRequest`). */
export type PrState = 'open' | 'merged' | 'closed' | 'failed';

export const PR_STATES: readonly PrState[] = ['open', 'merged', 'closed', 'failed'];

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

export const openPrUrl = (pr: PullRequest | null): string | null => (pr?.state === 'open' ? pr.url : null);

export const isPrExistsError = (error: string): boolean => /a pull request for branch .+ already exists/i.test(error);

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

export function finalMessage(runs: Pick<PrRun, 'kind' | 'result_text'>[]): string {
  const text = runs.filter((r) => (r.kind ?? 'work') === 'work').at(-1)?.result_text ?? '';
  return text.replace(STATUS_TAIL, '').trim();
}

/** The plan a task carries out: its name (`112-plans-in-agentdeck.html`) and the linked steps as AgentDeck stores them. */
export interface PrPlan {
  name: string;
  steps: { title: string; status: string; done: string[] }[];
}

function planSection(plan: PrPlan): string[] {
  const out = [`## Plan: \`${plan.name}\``];
  for (const step of plan.steps) {
    out.push('', `**${step.title}** (${step.status})`);
    if (step.done.length) out.push('', ...step.done.map((d) => `- [ ] ${d}`));
  }
  return [...out, ''];
}

export function buildPrBody(
  task: { id: number },
  runs: PrRun[],
  plan: PrPlan | null = null,
  codeComments: string | null = null,
  issue: number | null = null,
): string {
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
    ...(issue === null ? [] : [`Closes #${issue}.`, '']),
    ...(codeComments ? [`A person needs to merge this: ${codeComments}.`, ''] : []),
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

export function parsePrState(state: string): PrState | null {
  const s = state.trim().toLowerCase();
  return s === 'open' || s === 'merged' || s === 'closed' ? s : null;
}
