// A run's log as a transcript: pairing, nesting, folding, the time gutter and colour codes. The dashboard has no test runner, so it is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnsi } from '../../app/src/lib/ansi.ts';
import { buildTranscript, offsetLabel } from '../../app/src/lib/transcript.ts';

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
