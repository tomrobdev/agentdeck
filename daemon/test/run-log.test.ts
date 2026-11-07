// domain/run/log: tool entries carry the file they name, uncut.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLogLine } from '../src/domain/runs/translate/log.ts';

const toolUse = (name: string, input: unknown) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('tool entries take file from file_path, path or notebook_path', () => {
  assert.deepEqual(parseLogLine(toolUse('Read', { file_path: '/w/task-1/src/a.ts' })), [
    { kind: 'tool', name: 'Read', input: '{"file_path":"/w/task-1/src/a.ts"}', summary: '/w/task-1/src/a.ts', file: '/w/task-1/src/a.ts' },
  ]);
  assert.equal((parseLogLine(toolUse('Grep', { pattern: 'x', path: 'src' }))[0] as any).file, 'src');
  assert.equal((parseLogLine(toolUse('NotebookEdit', { notebook_path: 'n.ipynb' }))[0] as any).file, 'n.ipynb');
  // file_path wins over path.
  assert.equal((parseLogLine(toolUse('X', { path: 'b', file_path: 'a' }))[0] as any).file, 'a');
});

test('the file is kept whole when the input is cut', () => {
  const long = 'src/' + 'deep/'.repeat(100) + 'file.ts';
  const [entry] = parseLogLine(toolUse('Edit', { file_path: long, old_string: 'x'.repeat(1000), new_string: 'y' })) as any[];
  assert.equal(entry.input.length, 400);
  assert.equal(entry.file, long);
});

test('tool entries without a string path have no file field', () => {
  for (const input of [{ command: 'ls' }, { path: 42 }, { file_path: '' }, null]) {
    const [entry] = parseLogLine(toolUse('Bash', input));
    assert.equal(entry.kind, 'tool');
    assert.ok(!('file' in entry), JSON.stringify(input));
  }
});

const userResult = (block: object, extra: object = {}) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', ...block }] }, ...extra });

test('a tool result with string content', () => {
  assert.deepEqual(parseLogLine(userResult({ content: 'a\nb\n' })), [
    { kind: 'tool_result', id: 't1', ok: true, output: 'a\nb\n', lines: 2 },
  ]);
});

test('a tool result with text blocks and an image joins them', () => {
  const content = [
    { type: 'text', text: 'one' },
    { type: 'image', source: {} },
    { type: 'text', text: 'two' },
  ];
  assert.deepEqual(parseLogLine(userResult({ content })), [
    { kind: 'tool_result', id: 't1', ok: true, output: 'one\n[image]\ntwo', lines: 3 },
  ]);
});

test('an error result is not ok', () => {
  const [e] = parseLogLine(userResult({ content: 'boom', is_error: true })) as any[];
  assert.equal(e.ok, false);
});

test('output is cut at 4 KB while lines counts all of it', () => {
  const [e] = parseLogLine(userResult({ content: 'x\n'.repeat(5000) })) as any[];
  assert.equal(e.output.length, 4096);
  assert.equal(e.lines, 5000);
});

test('the summary of each tool', () => {
  const summary = (name: string, input: unknown) => (parseLogLine(toolUse(name, input))[0] as any).summary;
  assert.equal(summary('Bash', { command: 'pnpm   test\n-x' }), 'pnpm test -x');
  for (const name of ['Read', 'Write', 'Edit']) assert.equal(summary(name, { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(summary('NotebookEdit', { notebook_path: 'n.ipynb' }), 'n.ipynb');
  assert.equal(summary('Grep', { pattern: 'foo', path: 'src' }), 'foo in src');
  assert.equal(summary('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(summary('Glob', { pattern: '**/*.ts' }), '**/*.ts');
  assert.equal(summary('WebFetch', { url: 'https://x.dev', prompt: 'p' }), 'https://x.dev');
  assert.equal(summary('Task', { description: 'look around', prompt: 'long' }), 'look around');
  assert.equal(summary('Agent', { description: 'look around' }), 'look around');
  const todos = [{ status: 'completed' }, { status: 'pending' }, { status: 'completed' }];
  assert.equal(summary('TodoWrite', { todos }), '3 todos, 2 done');
  assert.equal(summary('Mystery', { n: 1, q: 'first string', r: 'second' }), 'first string');
});

test('tool entries carry the tool_use id', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }] },
  });
  assert.equal((parseLogLine(line)[0] as any).id, 'u1');
});

test('an Edit carries its change', () => {
  const [e] = parseLogLine(toolUse('Edit', { file_path: 'a', old_string: 'a\nb', new_string: 'c\nd\ne\n' })) as any[];
  assert.deepEqual(e.change, { added: 3, removed: 2, old: 'a\nb', new: 'c\nd\ne\n' });
  const [w] = parseLogLine(toolUse('Write', { file_path: 'a', content: 'x'.repeat(5000) })) as any[];
  assert.equal(w.change.new.length, 2048);
  assert.deepEqual([w.change.added, w.change.removed], [1, 0]);
  const edits = [
    { old_string: 'a', new_string: 'b' },
    { old_string: 'c', new_string: 'd' },
  ];
  const [m] = parseLogLine(toolUse('MultiEdit', { file_path: 'a', edits })) as any[];
  assert.deepEqual([m.change.added, m.change.removed], [2, 2]);
  assert.ok(!('change' in (parseLogLine(toolUse('Bash', { command: 'ls' }))[0] as object)));
});

test('at and parent come from the event', () => {
  const ev = { timestamp: '2026-01-01T00:00:00Z', parent_tool_use_id: 'p1' };
  const text = { message: { content: [{ type: 'text', text: 'hi' }] } };
  const [t] = parseLogLine(JSON.stringify({ type: 'assistant', ...ev, ...text })) as any[];
  assert.equal(t.at, ev.timestamp);
  assert.equal(t.parent, 'p1');
  const [r] = parseLogLine(userResult({ content: 'x' }, ev)) as any[];
  assert.equal(r.at, ev.timestamp);
  assert.equal(r.parent, 'p1');
  const [plain] = parseLogLine(JSON.stringify({ type: 'assistant', ...text })) as any[];
  assert.ok(!('at' in plain) && !('parent' in plain));
});
