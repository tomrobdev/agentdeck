// What every view of a task shows besides its title (app/src/lib/taskBadges.ts). The dashboard has no test runner, so its
// badge rules are tested here, like the board's move rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AutoMergeView, TaskSummary } from '../src/api/contract.ts';
import { AUTO_MERGE_CHIP, TONE_CHIP, statusLine, statusText, taskBadges } from '../../app/src/lib/taskBadges.ts';
import { TONES, statusTone } from '../../app/src/lib/tone.ts';
import { asRepoId, asTaskId } from './fixtures.ts';

test('the chip maps give tone names, not class strings', () => {
  for (const tone of [...Object.values(TONE_CHIP), ...Object.values(AUTO_MERGE_CHIP)]) assert.ok(TONES.includes(tone), tone);
  assert.deepEqual(TONE_CHIP, { blocked: 'blocked', failed: 'failed' });
  assert.equal(AUTO_MERGE_CHIP.merge, 'done');
  assert.equal(AUTO_MERGE_CHIP.wait, 'blocked');
  assert.equal(AUTO_MERGE_CHIP.never, 'failed');
});

test('a task status maps to a tone, and an unknown one is muted', () => {
  assert.equal(statusTone('cancel_requested'), 'running');
  assert.equal(statusTone('checks_failed'), 'failed');
  assert.equal(statusTone('nonsense'), 'muted');
});

const task = (extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id: asTaskId(1),
  repo_id: asRepoId(1),
  repo: 'agentdeck',
  title: 'A task',
  status: 'queued',
  priority: 0,
  model: 'opus',
  max_turns: 40,
  attempts: 1,
  max_attempts: 3,
  branch: null,
  worktree: null,
  stop_reason: null,
  source: 'manual',
  pr_url: null,
  pr_state: null,
  merge_method: null,
  plan_task: null,
  plan_steps: null,
  needs: null,
  question: null,
  done_by: null,
  auto_merge: null,
  auto_merge_view: null,
  merge_request: null,
  conflicting: false,
  waiting: null,
  unblocks: [],
  links: [],
  dependents: [],
  plan_unfinished: false,
  live: null,
  sync: null,
  checks: null,
  wait: null,
  created_at: '2026-11-01 10:00:00',
  updated_at: '2026-11-01 10:00:00',
  ...extra,
});

const autoMerge = (extra: Partial<AutoMergeView> = {}): AutoMergeView => ({
  state: 'on',
  label: 'auto-merge on',
  reasons: [],
  source: 'repo',
  checked_at: null,
  limits: { max_lines: 400, skip: ['.github/'], tests: 'the last run must pass the tests' },
  ...extra,
});

const conflict = 'the branch has conflicts with the base branch';
const review = (extra: Partial<TaskSummary> = {}) =>
  task({ status: 'done', pr_url: 'https://github.com/o/r/pull/1', pr_state: 'open', branch: 'agentdeck/task-1', ...extra });

test('a PR in review with a waiting merge request and a conflict: a status line, a conflicts chip, ↓ and try 2', () => {
  const t = review({
    attempts: 2,
    merge_request: { state: 'waiting', method: 'squash', reasons: [conflict], since: '2026-11-01 10:00:00' },
    conflicting: true,
    unblocks: [asTaskId(7), asTaskId(9)],
    auto_merge_view: autoMerge(),
  });
  const l = statusLine(t);
  assert.equal(l?.kind, 'merge_request');
  assert.equal(l?.text, `Merging when ready · ${conflict}`);
  assert.equal(l?.cancelMerge, true, 'a waiting request can be withdrawn from the line');

  const b = taskBadges(t);
  assert.deepEqual(
    b.attention.map((a) => [a.label, a.tone]),
    [['conflicts', 'failed']],
  );
  assert.deepEqual(b.down, [7, 9]);
  assert.deepEqual(b.up, []);
  assert.deepEqual(
    b.facts.map((f) => f.label),
    ['try 2'],
  );
  assert.equal(statusText(t), 'in review');
});

test('a conflict is the API field, not words in the reasons', () => {
  const t = review({ merge_request: { state: 'waiting', method: 'squash', reasons: [conflict], since: '2026-11-01 10:00:00' } });
  assert.deepEqual(taskBadges(t).attention, [], 'no conflicting field, no chip, whatever the reasons say');
  assert.deepEqual(taskBadges({ ...t, conflicting: true, pr_state: 'merged' }).attention, [], 'only an open PR conflicts');
});

test('auto-merge that follows the repo shows no badge; one set on the task does', () => {
  for (const state of ['off', 'on', 'merge', 'wait'] as const) {
    const b = taskBadges(review({ auto_merge_view: autoMerge({ state }) }));
    assert.deepEqual(b.facts, [], `${state} from the repo`);
    assert.deepEqual(b.attention, []);
  }
  assert.deepEqual(
    taskBadges(review({ auto_merge_view: autoMerge({ state: 'off', source: 'task' }) })).facts.map((f) => f.label),
    ['auto-merge off'],
  );
  assert.deepEqual(
    taskBadges(review({ auto_merge_view: autoMerge({ state: 'wait', source: 'task' }) })).facts.map((f) => f.label),
    ['auto-merge on'],
  );
});

test("auto-merge that needs a person is a won't auto-merge chip, unless a merge request stands in for it", () => {
  const never = autoMerge({ state: 'never', label: 'needs a person to merge: tests failed', reasons: ['tests failed on the last run'] });
  const b = taskBadges(review({ auto_merge_view: never }));
  assert.deepEqual(
    b.attention.map((a) => a.label),
    ["won't auto-merge"],
  );
  assert.match(b.attention[0].title, /tests failed on the last run/);
  const requested = review({
    auto_merge_view: never,
    merge_request: { state: 'merging', method: 'squash', reasons: [], since: '2026-11-01 10:00:00' },
  });
  assert.deepEqual(taskBadges(requested).attention, []);
  assert.equal(statusLine(requested)?.text, 'Merging…');
  assert.equal(statusLine(requested)?.cancelMerge, false);
});

test('a queued task built on two unmerged tasks shows ↑ both', () => {
  const t = task({
    links: [
      { on: asTaskId(3), kind: 'builds_on', state: 'waiting' },
      { on: asTaskId(4), kind: 'builds_on', state: 'waiting' },
      { on: asTaskId(2), kind: 'builds_on', state: 'met' },
      { on: asTaskId(5), kind: 'after', state: 'unlanded' },
    ],
    waiting: { on: [asTaskId(3), asTaskId(4)], stuck: null },
  });
  assert.deepEqual(taskBadges(t).up, [3, 4]);
  assert.equal(statusLine(t), null, 'waiting on its way is not a sentence');
});

test('the status line goes in order: live run, sync, merge request, stop reason, can’t start, auto-merge', () => {
  const live = { since: '2026-11-01 10:00:00', turns: 3, max_turns: 40, tool: 'Edit a.ts' };
  const sync = { base: 'main', since: null, resolving: false, turns: 0, max_turns: 40, tool: null };
  assert.equal(statusLine(task({ status: 'running', live }))?.kind, 'live');
  assert.equal(
    statusLine(review({ sync, merge_request: { state: 'merging', method: 'squash', reasons: [], since: '' } }))?.text,
    'Syncing with main…',
  );
  assert.deepEqual(
    [
      statusLine(task({ status: 'failed', stop_reason: 'tests failed' }))?.text,
      statusLine(task({ status: 'failed', stop_reason: 'x' }))?.tone,
    ],
    ['tests failed', 'failed'],
  );
  assert.equal(statusLine(task({ waiting: { on: [asTaskId(3)], stuck: '#3 was cancelled' } }))?.text, "Can't start: #3 was cancelled");
  assert.equal(statusLine(task({ wait: { kind: 'repo-paused', reason: 'by hand' } }))?.text, "Can't start: agentdeck is paused");
  assert.equal(statusLine(task({ wait: { kind: 'daemon-paused' } as TaskSummary['wait'] }))?.text, "Can't start: AgentDeck is paused");
  assert.equal(statusLine(task({ wait: { kind: 'slots', running: 2, max: 2 } })), null, 'a full slot is no sentence');
  assert.equal(
    statusLine(review({ auto_merge_view: autoMerge({ state: 'wait', reasons: ['1 check still running on GitHub'] }) }))?.text,
    'Auto-merges when ready · 1 check still running on GitHub',
  );
  assert.equal(statusLine(review({ auto_merge_view: autoMerge({ state: 'on' }) })), null);
});

test('facts: planner, a merged or closed PR (not an open one), and the repo when the display shows it', () => {
  const labels = (t: TaskSummary, opts = {}) => taskBadges(t, opts).facts.map((f) => f.label);
  assert.deepEqual(labels(review({ source: 'planner' })), ['planner']);
  assert.deepEqual(labels(review({ pr_state: 'merged' })), ['PR merged']);
  assert.deepEqual(labels(review({ pr_state: 'closed' }), { pr: false }), [], 'the PR display option off');
  assert.deepEqual(labels(task(), { repo: true }), ['agentdeck']);
  assert.deepEqual(
    taskBadges(task({ status: 'blocked', needs: JSON.stringify({ kind: 'deps', items: ['zod'] }), plan_unfinished: true })).attention.map(
      (a) => a.label,
    ),
    ['needs deps', 'steps unfinished'],
  );
});

test('checks: running and passed are muted facts, failing is an attention chip, none is no badge', () => {
  const sum = (extra: Partial<NonNullable<TaskSummary['checks']>>) => ({
    total: 5,
    failing: 0,
    pending: 0,
    failing_names: [],
    read_at: '2026-11-01 10:00:00',
    ...extra,
  });
  const labels = (t: TaskSummary) => taskBadges(t).facts.map((f) => f.label);

  const running = taskBadges(review({ checks: sum({ pending: 2 }) }));
  assert.deepEqual(running.attention, []);
  assert.deepEqual(
    running.facts.map((f) => f.label),
    ['● checks 3/5'],
  );

  const passed = taskBadges(review({ checks: sum({}) }));
  assert.deepEqual(passed.attention, []);
  assert.deepEqual(
    passed.facts.map((f) => f.label),
    ['✓ checks'],
  );

  const one = taskBadges(review({ checks: sum({ failing: 1, failing_names: ['lint'] }) }));
  assert.equal(one.attention[0]?.label, '✗ 1 check failing');
  assert.match(one.attention[0]?.title ?? '', /lint/);
  assert.deepEqual(one.facts, []);
  const two = taskBadges(review({ checks: sum({ failing: 2, pending: 1, failing_names: ['lint', 'test'] }) }));
  assert.equal(two.attention[0]?.label, '✗ 2 checks failing');
  assert.match(two.attention[0]?.title ?? '', /lint, test/);

  assert.deepEqual(labels(review({ checks: null })), []);
  assert.deepEqual(labels(review({})), []);
  assert.deepEqual(labels(review({ pr_state: 'merged', checks: sum({}) })), ['PR merged']);
});
