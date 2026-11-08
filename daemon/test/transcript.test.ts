// A run's log as a transcript: pairing, nesting, folding, the time gutter and colour codes. The dashboard has no test runner, so it is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from '../../app/src/api/types.ts';
import { parseAnsi } from '../../app/src/lib/ansi.ts';
import { clock, liveSource, placeSegment, runHeader, timeline } from '../../app/src/lib/runLive.ts';
import { REVIEW_MAX_TURNS, UNBLOCK_MAX_TURNS } from '../src/domain/runs/index.ts';
import {
  type CallItem,
  buildTranscript,
  cutRoot,
  offsetLabel,
  outputParts,
  readRange,
  resultHidden,
  toolKind,
} from '../../app/src/lib/transcript.ts';

const callOf = (name: string, input: unknown, res: { ok?: boolean; lines?: number; output?: string }): CallItem => {
  const [item] = buildTranscript([
    tool(name, 'a', { input: JSON.stringify(input) }),
    { kind: 'tool_result', id: 'a', ok: res.ok ?? true, output: res.output ?? 'x', lines: res.lines ?? 1 } as never,
  ]);
  return item as CallItem;
};

test('a Read shows the lines it read', () => {
  assert.equal(readRange(callOf('Read', { offset: 10, limit: 50 }, { lines: 50 })), 'lines 10–59');
  assert.equal(readRange(callOf('Read', { limit: 5 }, { lines: 5 })), 'lines 1–5');
  assert.equal(readRange(callOf('Read', {}, { lines: 40 })), 'lines 1–40');
  assert.equal(readRange(callOf('Read', {}, { lines: 2000 })), 'first 2000 lines');
  assert.equal(readRange(callOf('Read', { limit: 2000 }, { lines: 2000 })), 'lines 1–2000');
  assert.equal(readRange(callOf('Bash', {}, { lines: 3 })), null);
});

test('a write that worked shows no result; a failed one does', () => {
  for (const name of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) {
    assert.equal(resultHidden(callOf(name, {}, {})), true, name);
    assert.equal(resultHidden(callOf(name, {}, { ok: false })), false, name);
  }
  assert.equal(resultHidden(callOf('Bash', {}, {})), false);
});

test('the worktree root is cut from an output, and nothing is cut without one', () => {
  assert.equal(cutRoot('/wt/task-1')('/wt/task-1/src/a.ts and /wt/task-1/b.ts'), 'src/a.ts and b.ts');
  assert.equal(cutRoot('/wt/task-1/')('/wt/task-1/a.ts'), 'a.ts');
  assert.equal(cutRoot(null)('/wt/task-1/a.ts'), '/wt/task-1/a.ts');
});

test('Grep lines link with a path, or with the call’s file; only in a Grep result', () => {
  const isPath = (p: string) => p.startsWith('src/');
  const content = JSON.stringify({ output_mode: 'content' });
  assert.deepEqual(outputParts('src/a.ts:12:foo\nother:3:x', { grep: content, isPath }), [
    { text: 'src/a.ts:12:', path: 'src/a.ts', line: 12 },
    { text: 'foo\n' },
    { text: 'other:3:x' },
  ]);
  assert.deepEqual(outputParts('7:foo', { grep: content, file: 'src/a.ts', isPath }), [
    { text: '7:', path: 'src/a.ts', line: 7 },
    { text: 'foo' },
  ]);
  assert.deepEqual(outputParts('src/a.ts\nnope', { grep: '{}', isPath }), [
    { text: 'src/a.ts', path: 'src/a.ts', line: null },
    { text: '\n' },
    { text: 'nope' },
  ]);
  assert.deepEqual(outputParts('src/a.ts:12:foo', { isPath }), [{ text: 'src/a.ts:12:foo' }]);
});

test('conflict markers at a line start are marked', () => {
  const parts = outputParts('<<<<<<< HEAD\nx =======\n=======\n>>>>>>> b', {});
  assert.deepEqual(
    parts.map((p) => !!p.conflict),
    [true, false, true, true],
  );
});

test('toolKind sorts calls by what they do', () => {
  const table: [string, string][] = [
    ['Read', 'read'],
    ['Grep', 'read'],
    ['Glob', 'read'],
    ['LS', 'read'],
    ['WebFetch', 'read'],
    ['Edit', 'edit'],
    ['MultiEdit', 'edit'],
    ['Write', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Bash', 'command'],
    ['Task', 'agent'],
    ['Agent', 'agent'],
    ['TodoWrite', 'other'],
  ];
  for (const [name, kind] of table) assert.equal(toolKind(name), kind, name);
});

const tool = (name: string, id?: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'tool', name, id, input: '{}', summary: name, ...extra }) as never;
const result = (id: string, ok = true) => ({ kind: 'tool_result', id, ok, output: 'x', lines: 1 }) as never;

test('a result is paired with its call and is not an item of its own', () => {
  const items = buildTranscript([tool('Bash', 'a'), result('a', false)]);
  assert.equal(items.length, 1);
  assert.equal(items[0].type === 'call' && items[0].result?.ok, false);
});

test('back-to-back reads fold into one item; a lone read does not', () => {
  const items = buildTranscript([tool('Read', 'a'), tool('Grep', 'b'), tool('Edit', 'c'), tool('Read', 'd')]);
  assert.deepEqual(
    items.map((i) => i.type),
    ['explored', 'call', 'call'],
  );
});

test("a subagent's entries nest under its call", () => {
  const items = buildTranscript([tool('Task', 't'), tool('Bash', 'b', { parent: 't' })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].type === 'call' && items[0].children.length, 1);
});

test('an old log with no ids shows one item per call', () => {
  const items = buildTranscript([tool('Bash'), tool('Edit'), { kind: 'text', text: 'hi' } as never]);
  assert.deepEqual(
    items.map((i) => i.type),
    ['call', 'call', 'plain'],
  );
});

test('the gutter shows time since the first entry', () => {
  assert.equal(offsetLabel('2026-01-01T00:00:00Z', '2026-01-01T00:01:05Z'), '1:05');
  assert.equal(offsetLabel(undefined, '2026-01-01T00:01:05Z'), '');
});

test('colour codes become colour; other codes are dropped', () => {
  assert.deepEqual(parseAnsi('a\u001b[1;31mb\u001b[0mc\u001b[2Kd'), [
    { text: 'a', bold: false, color: null },
    { text: 'b', bold: true, color: 1 },
    { text: 'c', bold: false, color: null },
    { text: 'd', bold: false, color: null },
  ]);
});

// ---- The live header and the timeline strip

const T0 = Date.parse('2026-11-08T10:00:00Z');
const stamp = (s: number) => new Date(T0 + s * 1000).toISOString();
const runOf = (extra: Partial<Run> = {}): Run =>
  ({
    id: 1,
    kind: 'work',
    attempt: 1,
    started_at: '2026-11-08 10:00:00',
    ended_at: null,
    outcome: null,
    num_turns: null,
    live_turns: 0,
    live_tool: null,
    ...extra,
  }) as never;
const bareTask = { live: null, sync: null };

test('a work run reads the task live source, a resolve run the sync, an unblock run its own', () => {
  const live = { since: 'x', turns: 7, max_turns: 40, tool: 'Edit a.ts' };
  assert.deepEqual(liveSource(runOf(), { ...bareTask, live }), live);
  const sync = { base: 'main', since: 'x', resolving: true, turns: 3, max_turns: 20, tool: 'Read b.ts' };
  assert.equal(liveSource(runOf({ kind: 'resolve' }), { ...bareTask, sync }), sync);
  assert.equal(liveSource(runOf({ kind: 'resolve' }), { ...bareTask, sync: { ...sync, resolving: false } }), null);
  assert.deepEqual(liveSource(runOf({ kind: 'unblock', live_turns: 4, live_tool: 'Bash' }), bareTask), {
    turns: 4,
    max_turns: UNBLOCK_MAX_TURNS,
    tool: 'Bash',
  });
  assert.equal(liveSource(runOf({ kind: 'review' }), bareTask)?.max_turns, REVIEW_MAX_TURNS);
});

test('the header of a live run: turns, the tool and how long its call has run, the time since the start', () => {
  const items = buildTranscript([
    { kind: 'tool', id: 'a', name: 'Read', input: '{}', summary: 'a', at: stamp(5) },
    { kind: 'tool_result', id: 'a', ok: true, output: 'x', lines: 1, at: stamp(6) },
    { kind: 'tool', id: 'b', name: 'Bash', input: '{}', summary: 'sleep', at: stamp(20) },
  ] as never);
  const work = runHeader(runOf(), { turns: 12, max_turns: 40, tool: 'Bash sleep' }, items, T0 + 50_000);
  assert.deepEqual(work, { ended: false, outcome: null, turns: 12, maxTurns: 40, tool: 'Bash sleep', toolSeconds: 30, seconds: 50 });
  const resolve = runHeader(runOf({ kind: 'resolve' }), { turns: 2, max_turns: 20, tool: null }, [], T0 + 9_000);
  assert.equal(resolve.maxTurns, 20);
  assert.equal(resolve.toolSeconds, null);
  const run = runOf({ kind: 'unblock', live_turns: 3, live_tool: 'Read' });
  const unblock = runHeader(run, liveSource(run, bareTask), [], T0 + 9_000);
  assert.equal(unblock.turns, 3);
  assert.equal(unblock.maxTurns, UNBLOCK_MAX_TURNS);
  assert.equal(unblock.toolSeconds, null, 'no call in the log to time');
});

test('the header of an ended run shows its outcome, turns and duration, whatever the clock says', () => {
  const run = runOf({ ended_at: '2026-11-08 10:03:20', outcome: 'failed', num_turns: 31 });
  const h = runHeader(run, null, [], T0 + 9_999_000);
  assert.deepEqual([h.ended, h.outcome, h.turns, h.seconds, h.tool], [true, 'failed', 31, 200, null]);
  assert.equal(clock(200), '3m 20s');
  assert.equal(clock(45), '45s');
  assert.equal(clock(3720), '1h 02m');
});

test('the timeline: a segment per stretch coloured by kind, a tick at a failed test call, the daemon tests at the end', () => {
  const bash = (id: string, command: string, at: number) =>
    tool('Bash', id, { input: JSON.stringify({ command }), summary: command, at: stamp(at) });
  const res = (id: string, ok: boolean, at: number) => ({ ...(result(id, ok) as object), at: stamp(at) }) as never;
  const entries = [
    tool('Read', 'r', { summary: 'a.ts', at: stamp(0) }),
    res('r', true, 2),
    tool('Edit', 'e', { summary: 'a.ts', at: stamp(10) }),
    res('e', true, 11),
    bash('t1', 'pnpm test', 20),
    res('t1', false, 50),
    tool('Edit', 'e2', { summary: 'a.ts', at: stamp(60) }),
    res('e2', true, 61),
    bash('t2', 'pnpm test', 70),
    res('t2', true, 90),
    tool('Bash', 'sub', { summary: 'ls', parent: 'x', at: stamp(75) }),
    { kind: 'tests', passed: true, output: '' } as never,
  ];
  const { segments, ticks } = timeline(entries, 'pnpm test');
  assert.deepEqual(
    segments.map((s) => s.kind),
    ['read', 'write', 'edit', 'write', 'test', 'write', 'edit', 'write', 'test', 'write'],
  );
  assert.equal(segments[4].from, T0 + 20_000);
  assert.equal(segments[4].to, T0 + 50_000);
  assert.equal(segments.at(-1)?.to, null, 'the last one is open until the run ends');
  assert.equal(ticks.length, 2);
  assert.deepEqual([ticks[0].ms, ticks[0].failed, ticks[0].at], [T0 + 20_000, true, stamp(20)]);
  assert.deepEqual([ticks[1].ms, ticks[1].failed, ticks[1].at], [null, false, null]);
  assert.deepEqual(placeSegment(segments[4], T0, T0 + 100_000), { left: 20, width: 30 });
  assert.deepEqual(placeSegment(segments.at(-1)!, T0, T0 + 100_000), { left: 90, width: 10 });
  assert.equal(timeline([bash('x', 'make check', 0)], 'make check').segments[0].kind, 'test');
  assert.equal(timeline([bash('x', 'make check', 0)], null).segments[0].kind, 'command');
});
