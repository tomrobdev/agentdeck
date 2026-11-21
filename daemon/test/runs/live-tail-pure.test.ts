// Pure tests of a live run's turn limit and the tail of its log.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type LogEntry, liveMaxTurns, logTail } from '#domain/runs/index.ts';

test('a work, resolve or plan resolve run has its task’s turn limit; the others have their own', () => {
  assert.equal(liveMaxTurns('work', 80), 80);
  assert.equal(liveMaxTurns('resolve', 80), 80);
  assert.equal(liveMaxTurns('plan_resolve', 80), 80);
  assert.equal(liveMaxTurns('review', 80), 30);
  assert.equal(liveMaxTurns('plan_review', 80), 30);
  assert.equal(liveMaxTurns('verify', 80), 30);
  assert.equal(liveMaxTurns('unblock', 80), 30);
  assert.equal(liveMaxTurns('unblock', 10), 10);
});

test('the log tail keeps the last readable lines, one per entry, and cuts a long one', () => {
  const entries: LogEntry[] = [
    { kind: 'text', text: 'first\nsecond line' },
    { kind: 'tool', name: 'Read', input: '{}', summary: 'a.ts' },
    { kind: 'tool_result', id: 'x', ok: true, output: 'ignored', lines: 1 },
    { kind: 'tests', passed: false, output: '' },
    { kind: 'setup', passed: true, cmd: 'pnpm i', output: '' },
    { kind: 'error', text: 'boom\nmore' },
    { kind: 'text', text: 'x'.repeat(300) },
  ];
  const tail = logTail(entries, 4);
  assert.deepEqual(tail.slice(0, 3), ['Tests failed', 'Setup passed: pnpm i', 'error: boom']);
  assert.equal(tail[3].length, 160);
  assert.deepEqual(logTail(entries.slice(0, 3), 5), ['first', 'Read a.ts']);
  assert.deepEqual(logTail([], 3), []);
});
