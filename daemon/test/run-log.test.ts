// domain/run/log: tool entries carry the file they name, uncut.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLogLine } from '../src/domain/run/log.ts';

const toolUse = (name: string, input: unknown) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('tool entries take file from file_path, path or notebook_path', () => {
  assert.deepEqual(parseLogLine(toolUse('Read', { file_path: '/w/task-1/src/a.ts' })), [
    { kind: 'tool', name: 'Read', input: '{"file_path":"/w/task-1/src/a.ts"}', file: '/w/task-1/src/a.ts' },
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
