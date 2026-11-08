// A run's log as a transcript: pairing, nesting, folding, the time gutter and colour codes. The dashboard has no test runner, so it is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnsi } from '../../app/src/lib/ansi.ts';
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
