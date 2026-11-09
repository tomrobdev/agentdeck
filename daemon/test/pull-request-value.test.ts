// A task's pull request as one value: every combination of its flat columns, read into `pr` by the mapper and turned back.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { taskDetail, taskViews } from '../src/api/wire.ts';
import { openDb } from './open-db.ts';
import { type TaskRow, toTask } from '../src/db/mappers.ts';
import { stored } from '../src/domain/shared/index.ts';
import { checksSummary } from '../src/domain/landing/pull-request/checks.ts';
import { type PrFields, type PrState, type PullRequest, prFields, pullRequestOf } from '../src/domain/landing/pull-request/pr.ts';
import { doneTask } from './fixtures.ts';

const check = { verdict: 'wait' as const, reasons: [{ kind: 'checks_pending' as const, text: '2 checks still running on GitHub' }] };
const conflict = {
  verdict: 'never' as const,
  reasons: [{ kind: 'conflict' as const, text: 'the branch has conflicts with the base branch' }],
  conflict: true as const,
};
const latest = {
  read_at: '2026-11-01 09:00:00',
  head: 'abc',
  checks: [{ name: 'test', state: 'fail' as const, url: null, started_at: null, completed_at: null }],
  notified: true,
};
const counts = { total: 2, failing: 1, pending: 0 };

const NO_PR = prFields(null);
const URL = 'https://x/pull/1';

/** The ways a task can have each group of a PR's columns, which vary independently of its state and url. */
const METHODS: Partial<PrFields>[] = [{}, { merge_method: 'rebase' }];
const CHECKS: Partial<PrFields>[] = [
  {},
  { pr_checks: latest },
  { pr_checks_opened: counts },
  { pr_checks_merged: counts },
  { pr_checks: latest, pr_checks_opened: counts, pr_checks_merged: counts },
];
const AUTO_MERGE: Partial<PrFields>[] = [
  {},
  { auto_merge_check: check, auto_merge_checked_at: '2026-11-01 09:00:00' },
  { auto_merge_check: conflict, auto_merge_checked_at: '2026-11-01 09:00:00' },
];
const MERGE_REQUESTS: Partial<PrFields>[] = [
  {},
  { merge_requested_at: '2026-11-01 10:00:00' },
  { merge_requested_at: '2026-11-01 10:00:00', merge_request_method: 'merge' },
  { merge_requested_at: '2026-11-01 10:00:00', merge_request_method: 'merge', merge_request_check: conflict },
];

/** Every combination of the groups above. */
const records = (): Partial<PrFields>[] =>
  METHODS.flatMap((a) => CHECKS.flatMap((b) => AUTO_MERGE.flatMap((c) => MERGE_REQUESTS.map((d) => ({ ...a, ...b, ...c, ...d })))));

/** A task's row with these PR fields stored as their columns are. Its other columns don't bear on `pr`. */
const rowOf = (fields: PrFields) => ({ needs: null, question: null, plan_steps: null, auto_merge: null, ...stored(fields) }) as TaskRow;

/** The PR columns of a row. */
const columnsOf = (row: TaskRow) => Object.fromEntries(Object.keys(NO_PR).map((k) => [k, row[k as keyof TaskRow]]));

test('every combination of a PR on GitHub maps from its columns to pr and back', () => {
  let seen = 0;
  for (const state of ['open', 'merged', 'closed'] as const) {
    for (const record of records()) {
      const fields = { ...NO_PR, pr_url: URL, pr_state: state, ...record };
      const row = rowOf(fields);
      const task = toTask(row);
      assert.equal(task.pr?.state, state);
      assert.equal(task.pr?.url, URL);
      assert.deepEqual(prFields(task.pr), fields, 'the same fields');
      assert.deepEqual(stored(prFields(task.pr)), columnsOf(row), 'the same columns');
      seen += 1;
    }
  }
  assert.equal(seen, 3 * 2 * 5 * 3 * 4);
});

test("pr_state = 'failed' is a state of its own, with or without the url of a PR opened before", () => {
  for (const pr_url of [null, URL]) {
    for (const record of records()) {
      const fields = { ...NO_PR, pr_url, pr_state: 'failed' as const, ...record };
      const row = rowOf(fields);
      const { pr } = toTask(row);
      assert.equal(pr?.state, 'failed');
      assert.equal(pr?.url, pr_url);
      assert.deepEqual(prFields(pr), fields);
      assert.deepEqual(stored(prFields(pr)), columnsOf(row));
    }
  }
});

test('no pr_state is no PR, and no PR is every column empty', () => {
  const { pr } = toTask(rowOf(NO_PR));
  assert.equal(pr, null);
  assert.deepEqual(stored(prFields(pr)), columnsOf(rowOf(NO_PR)));
});

test('columns that say no PR exists read as none, whatever else they hold', () => {
  for (const record of records()) {
    assert.equal(pullRequestOf({ ...NO_PR, ...record }), null, 'no state');
    assert.equal(pullRequestOf({ ...NO_PR, pr_url: URL, ...record }), null, 'a url with no state');
  }
  for (const pr_state of ['open', 'merged', 'closed'] as PrState[])
    assert.equal(pullRequestOf({ ...NO_PR, pr_state }), null, `${pr_state} on GitHub with no url is half-written`);
});

test('a merge request is one value: its method and check count only with the time it was asked for', () => {
  const pr = pullRequestOf({ ...NO_PR, pr_url: URL, pr_state: 'open', merge_request_method: 'merge', merge_request_check: check });
  assert.equal(pr?.merge_request, null);
  assert.deepEqual(
    pullRequestOf({ ...NO_PR, pr_url: URL, pr_state: 'open', merge_requested_at: 'then', merge_request_check: check })?.merge_request,
    { requested_at: 'then', method: null, check },
  );
});

test('a malformed stored value reads as none in pr too', () => {
  const { pr } = toTask({ ...rowOf({ ...NO_PR, pr_url: URL, pr_state: 'open' }), auto_merge_check: 'not json', pr_checks: '{"checks":3}' });
  assert.equal(pr?.auto_merge_check, null);
  assert.equal(pr?.checks.latest, null);
});

test('checksSummary: only an open PR with checks has a summary', () => {
  const pr = (state: PullRequest['state'], fields: Partial<PrFields> = {}) =>
    pullRequestOf({ ...NO_PR, pr_url: URL, pr_state: state, ...fields });
  assert.equal(checksSummary(null), null);
  assert.equal(checksSummary(pr('open')), null);
  assert.equal(checksSummary(pr('merged', { pr_checks: latest })), null);
  assert.equal(checksSummary(pr('failed', { pr_checks: latest })), null);
  assert.deepEqual(checksSummary(pr('open', { pr_checks: latest })), {
    total: 1,
    failing: 1,
    pending: 0,
    failing_names: ['test'],
    failing_lines: ['test'],
    read_at: latest.read_at,
  });
});

test('a task read from the database has pr beside its flat fields, and the API stays flat', async () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  const t = doneTask(db, repo);
  assert.equal(db.getTask(t.id)!.pr, null);
  db.recordPr(t.id, { type: 'failed', error: 'no remote' });
  assert.equal(db.getTask(t.id)!.pr?.state, 'failed');
  db.recordPr(t.id, { type: 'opened', url: URL });
  assert.deepEqual([db.getTask(t.id)!.pr?.state, db.getTask(t.id)!.pr?.url], ['open', URL]);

  const detail = await taskDetail(db, t.id);
  assert.ok(!('pr' in detail), 'the detail has no pr');
  assert.deepEqual([detail.pr_url, detail.pr_state], [URL, 'open']);
  for (const view of taskViews(db, { limit: 10 })) assert.ok(!('pr' in view), `#${view.id} is listed without pr`);
  db.close();
});

test('the pull request value in domain/landing/pull-request/pr.ts does not import Task', () => {
  const dir = join(import.meta.dirname, '../src/domain/landing/pull-request');
  for (const file of ['pr.ts']) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(text, /from '\.\.\/\.\.\/work\/task/, `${file} imports Task`);
  }
});
