// The command that opens an interactive claude session for a task that needs a person.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixFindingsCommand, fixTaskCommand } from '#app/lib/runs/terminal.ts';
import { hasFindingsToFix } from '#app/lib/runs/verify.ts';
import { canFix } from '#app/lib/work/task-view.ts';
import { fixReason } from '#app/lib/work/task-badges.ts';

test('a done task in review opens /review-task with its id and why', () => {
  const task = { id: 287, status: 'done', pr_state: 'open' } as const;
  assert.equal(fixTaskCommand(task, 'It is in review.'), "claude '/review-task 287 It is in review.'");
});

test('a blocked task opens /triage', () => {
  const task = { id: 12, status: 'blocked', pr_state: null } as const;
  assert.equal(fixTaskCommand(task, 'It is blocked. Needs a host.'), "claude '/triage 12 It is blocked. Needs a host.'");
});

test('a failed task opens /triage', () => {
  const task = { id: 13, status: 'failed', pr_state: null } as const;
  assert.equal(fixTaskCommand(task, 'It is failed.'), "claude '/triage 13 It is failed.'");
});

test('a quote in the reason is escaped for the shell and a newline becomes a space', () => {
  const task = { id: 14, status: 'blocked', pr_state: null } as const;
  assert.equal(fixTaskCommand(task, "can't run\nit's stuck"), `claude '/triage 14 can'\\''t run it'\\''s stuck'`);
});

test('with no reason only the id follows the skill', () => {
  assert.equal(fixTaskCommand({ id: 5, status: 'failed', pr_state: null }, '  '), "claude '/triage 5'");
});

test('verify findings open /triage with the issue of a task that has one', () => {
  assert.equal(
    fixFindingsCommand({ id: 417, issue: { number: 87 } }),
    "claude '/triage 417 Fix its prompt, whose body is GitHub issue #87, from its latest verify findings.'",
  );
  assert.equal(fixFindingsCommand({ id: 5, issue: null }), "claude '/triage 5 Fix its prompt, from its latest verify findings.'");
});

test('only a finished verify run with a claim that is not true has findings to fix', () => {
  const [ok, bad] = (['true', 'partly'] as const).map((verdict) => ({ verdict }) as never);
  assert.ok(hasFindingsToFix({ state: 'done', findings: [ok, bad] }));
  assert.ok(!hasFindingsToFix({ state: 'done', findings: [ok] }));
  assert.ok(!hasFindingsToFix({ state: 'done', findings: [] }));
  assert.ok(!hasFindingsToFix({ state: 'going', findings: [bad] }));
});

test('only a task that needs a person can be fixed', () => {
  assert.ok(canFix({ status: 'done', pr_state: 'open', waiting: null }));
  assert.ok(canFix({ status: 'blocked', pr_state: null, waiting: null }));
  assert.ok(canFix({ status: 'failed', pr_state: null, waiting: null }));
  assert.ok(!canFix({ status: 'queued', pr_state: null, waiting: null }));
  assert.ok(!canFix({ status: 'running', pr_state: null, waiting: null }));
  assert.ok(!canFix({ status: 'done', pr_state: 'merged', waiting: null }));
});

test('the reason is the stage, the stop reason and the auto-merge reasons', () => {
  const view = { label: 'Will not auto-merge', reasons: ['3 files over the limit'] } as never;
  assert.equal(
    fixReason({ status: 'done', pr_state: 'open', stop_reason: null, auto_merge_view: view }),
    'It is in review. Will not auto-merge 3 files over the limit',
  );
  assert.equal(
    fixReason({ status: 'blocked', pr_state: null, stop_reason: 'Needs a host', auto_merge_view: null }),
    'It is blocked. Needs a host',
  );
});
