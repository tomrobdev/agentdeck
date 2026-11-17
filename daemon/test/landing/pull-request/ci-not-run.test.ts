// A GitHub check whose job never started reads as "CI did not run", not as failing, and ci_not_run_ok lets passing tests stand in for it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_MERGE_LABEL,
  asNotRun,
  autoMergeCheck,
  carryFailures,
  checksSummary,
  mergeCheck,
  notStartedMessage,
  parseAnnotations,
  parseJobStart,
  withCheckList,
} from '#domain/landing/index.ts';
import type { PrCheck, PrDetails, PullRequest, StoredChecks } from '#domain/landing/index.ts';
import { countOf } from '#domain/landing/pull-request/checks.ts';

const BILLING =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";

const check = (name: string, job: number, state: PrCheck['state'] = 'fail'): PrCheck => ({
  name,
  state,
  url: `https://github.com/acme/demo/actions/runs/7/job/${job}`,
  started_at: '2026-11-10T10:00:00Z',
  completed_at: '2026-11-10T10:00:02Z',
});

const prWith = (check_list: PrCheck[]): PrDetails => ({
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'UNSTABLE',
  commits: 1,
  files: 1,
  additions: 10,
  deletions: 2,
  checks: countOf(check_list),
  check_list,
  head: 'head-1',
  paths: ['src/a.ts'],
  labels: [AUTO_MERGE_LABEL.name],
});

test("parseJobStart and parseAnnotations read GitHub's job and check-run annotations", () => {
  assert.deepEqual(parseJobStart(JSON.stringify({ runner_name: '', steps: [] })), { runner_name: null, steps: 0 });
  assert.deepEqual(parseJobStart(JSON.stringify({ runner_name: 'GitHub Actions 3', steps: [{}, {}] })), {
    runner_name: 'GitHub Actions 3',
    steps: 2,
  });
  assert.deepEqual(parseAnnotations(JSON.stringify([{ message: ` ${BILLING} ` }, { message: '' }, null])), [BILLING]);
  assert.deepEqual(parseAnnotations('{}'), []);
});

test("a job with no runner and no steps, or GitHub's 'was not started' annotation, never started; one that ran did", () => {
  assert.equal(notStartedMessage({ runner_name: null, steps: 0 }, [BILLING]), BILLING);
  assert.equal(notStartedMessage({ runner_name: 'GitHub Actions 3', steps: 4 }, [BILLING]), BILLING, 'the annotation says so on its own');
  assert.match(notStartedMessage({ runner_name: null, steps: 0 }, []) ?? '', /never started/);
  assert.equal(notStartedMessage({ runner_name: 'GitHub Actions 3', steps: 4 }, ['Process completed with exit code 1.']), null);
});

test('a never-started job reads as not run with its message; a failed job still reads as failing', () => {
  const notRun = asNotRun({ ...check('check', 1), step: 'x', excerpt: 'y' }, BILLING);
  assert.equal(notRun.state, 'not_run');
  assert.equal(notRun.not_run, BILLING);
  assert.equal(notRun.excerpt, undefined);

  const pr = prWith([notRun, check('ui', 2)]);
  assert.deepEqual(countOf(pr.check_list ?? []), { total: 2, failing: 1, pending: 0 }, 'not run counts neither as failing nor pending');
  const { warnings } = mergeCheck({ pr_state: 'open', pr, tests_passed: true });
  assert.ok(warnings.includes('1 check failing on GitHub'));
  assert.ok(warnings.includes(`CI did not run: ${BILLING}`));
});

test('a check read as not run stays not run on the same head, and is read again on a new one', () => {
  const stored: StoredChecks = { read_at: 'x', head: 'head-1', checks: [asNotRun(check('check', 1), BILLING)], notified: false };
  const fresh = prWith([check('check', 1)]);
  const kept = withCheckList(fresh, carryFailures(stored, 'head-1', fresh.check_list ?? []).checks);
  assert.equal(kept.check_list?.[0].state, 'not_run');
  assert.equal(kept.check_list?.[0].not_run, BILLING);
  assert.equal(kept.checks.failing, 0);
  assert.deepEqual(carryFailures(stored, 'head-1', fresh.check_list ?? []).unread, []);
  assert.equal(carryFailures(stored, 'head-2', fresh.check_list ?? []).unread.length, 1);
});

test("the task's checks summary carries what GitHub said about the checks that never ran", () => {
  const checks = [asNotRun(check('check', 1), BILLING), asNotRun(check('ui', 2), BILLING), check('lint', 3, 'pass')];
  const pr: PullRequest = {
    state: 'open',
    url: 'https://github.com/acme/demo/pull/1',
    merge_method: null,
    checks: { latest: { read_at: '2026-11-10 10:00:00', head: 'head-1', checks, notified: false }, opened: null, merged: null },
    auto_merge_check: null,
    auto_merge_checked_at: null,
    merge_request: null,
  };
  const summary = checksSummary(pr);
  assert.deepEqual(summary?.not_run, [BILLING]);
  assert.equal(summary?.failing, 0);
});

const repo = { test_cmd: 'pnpm test', auto_merge_max_lines: 400, auto_merge_skip: ['.github/'] };
const notRunPr = prWith([asNotRun(check('check', 1), BILLING), asNotRun(check('ui', 2), BILLING)]);
const autoMerge = (tests_passed: boolean | null, ci_not_run_ok?: boolean) =>
  autoMergeCheck({
    repo,
    pr_state: 'open',
    pr: notRunPr,
    tests_passed,
    paused: null,
    ...(ci_not_run_ok === undefined ? {} : { ci_not_run_ok }),
  });

test('with ci_not_run_ok off, a job that never started needs a person, said as CI did not run', () => {
  for (const off of [undefined, false]) {
    const verdict = autoMerge(true, off);
    assert.equal(verdict.verdict, 'never');
    assert.deepEqual(verdict.reasons, [{ kind: 'ci_not_run', text: `CI did not run: ${BILLING}` }]);
  }
});

test('with ci_not_run_ok on, auto-merge goes ahead when the tests passed and needs a person when they did not', () => {
  assert.equal(autoMerge(true, true).verdict, 'merge');
  const failed = autoMerge(false, true);
  assert.equal(failed.verdict, 'never');
  assert.deepEqual(
    failed.reasons.map((r) => r.kind),
    ['tests_failed', 'ci_not_run'],
  );
  assert.deepEqual(
    autoMerge(null, true).reasons.map((r) => r.kind),
    ['ci_not_run', 'tests_not_run'],
  );
});

test('ci_not_run_ok does not wave through a check that failed', () => {
  const pr = prWith([asNotRun(check('check', 1), BILLING), check('ui', 2)]);
  const verdict = autoMergeCheck({ repo, pr_state: 'open', pr, tests_passed: true, paused: null, ci_not_run_ok: true });
  assert.equal(verdict.verdict, 'never');
  assert.deepEqual(
    verdict.reasons.map((r) => r.kind),
    ['checks_failing'],
  );
});
