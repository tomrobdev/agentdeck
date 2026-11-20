import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeWait, fileSize, taskList } from '#app/lib/work/work-wording.ts';
import { asTaskId } from '#test/fixtures/fixtures.ts';

test('the dashboard words each wait of a queued task', () => {
  assert.equal(describeWait({ kind: 'daemon-paused' }), 'AgentDeck is paused');
  assert.match(
    describeWait({ kind: 'governor', reason: '5h window at 92%', until: null }),
    /^On hold for the usage budget: 5h window at 92%$/,
  );
  assert.match(describeWait({ kind: 'governor', reason: 'weekly pace', until: 1_800_000_000 }), /; lifts around /);
  assert.match(describeWait({ kind: 'rate-limited', until: 1_800_000_000 }), /^Claude rate-limited us; resumes /);
  assert.equal(describeWait({ kind: 'repo-paused', reason: 'by hand' }), 'The repo is paused: by hand');
  assert.match(describeWait({ kind: 'draining', repo: true }), /^The repo is draining/);
  assert.match(describeWait({ kind: 'draining', repo: false }), /^AgentDeck is draining/);
  assert.equal(describeWait({ kind: 'dependency', on: [asTaskId(3)], stuck: null }), 'Waits for #3 to finish');
  assert.equal(describeWait({ kind: 'dependency', on: [asTaskId(3)], stuck: '#3 failed' }), "Can't start: #3 failed");
  assert.equal(
    describeWait({ kind: 'plan-branch', name: 'plan/7-pay', base: 'main', status: 'conflict' }),
    'Waits: plan/7-pay conflicts with main; it starts once a merge of main into it is pushed',
  );
  assert.match(
    describeWait({ kind: 'plan-branch', name: 'plan/7-pay', base: 'main', status: 'partly_landed' }),
    /landed in only some repos/,
  );
  assert.equal(describeWait({ kind: 'unblocking' }), 'Waits for its unblock run to stop');
  assert.equal(describeWait({ kind: 'overlap', with: asTaskId(4) }), 'Waits for #4: same files');
  assert.equal(describeWait({ kind: 'slots', running: 2, max: 2, repo: null }), 'Waiting for a free slot (2 of 2 in use)');
  assert.equal(describeWait({ kind: 'slots', running: 1, max: 1, repo: 'demo' }), 'Waiting for a slot in demo (1 of 1 in use)');
});

test('a list of tasks and the size of a file', () => {
  assert.equal(taskList([1]), '#1');
  assert.equal(taskList([1, 2, 3]), '#1, #2 and #3');
  assert.equal(fileSize(512), '512 B');
  assert.equal(fileSize(4096), '4 KB');
});
