import { test } from 'node:test';
import assert from 'node:assert/strict';
import { START_LIVE, liveView, nextLive, toolText } from '../src/domain/run/live.ts';

const assistant = (id: string, ...uses: { name: string; input: unknown }[]) => ({
  type: 'assistant',
  message: { id, content: uses.map((u) => ({ type: 'tool_use', ...u })) },
});

test('a tool call is worded in a few words', () => {
  assert.equal(toolText('Edit', { file_path: '/a/b/worker.ts' }), 'Edit worker.ts');
  assert.equal(toolText('Bash', { command: 'pnpm   test\n' }), 'Bash pnpm test');
  assert.equal(toolText('Grep', { pattern: 'foo' }), 'Grep foo');
  assert.equal(toolText('TodoWrite', {}), 'TodoWrite');
  assert.ok(toolText('Bash', { command: 'x'.repeat(200) }).length <= 40);
});

test('each assistant message is a turn and the last tool use is the tool', () => {
  let s = nextLive(START_LIVE, assistant('m1', { name: 'Read', input: { file_path: 'a.ts' } }));
  assert.deepEqual([s.turns, s.tool], [1, 'Read a.ts']);
  // The same message in a second event is the same turn.
  s = nextLive(s, assistant('m1', { name: 'Edit', input: { file_path: 'a.ts' } }));
  assert.deepEqual([s.turns, s.tool], [1, 'Edit a.ts']);
  s = nextLive(s, assistant('m2'));
  assert.deepEqual([s.turns, s.tool], [2, 'Edit a.ts']);
  assert.equal(nextLive(s, { type: 'user' }), s);
});

test('only a running task has a live view', () => {
  const run = { started_at: '2026-01-01 00:00:00', live_turns: 3, live_tool: 'Edit a.ts' };
  assert.deepEqual(liveView({ status: 'running', max_turns: 40 }, run), {
    since: run.started_at,
    turns: 3,
    max_turns: 40,
    tool: 'Edit a.ts',
  });
  assert.equal(liveView({ status: 'done', max_turns: 40 }, run), null);
  assert.equal(liveView({ status: 'running', max_turns: 40 }, undefined), null);
});
