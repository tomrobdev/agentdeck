import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addResult, sessionResult } from '#domain/runs/translate/results.ts';
import { resultFields } from '#domain/runs/index.ts';

const result = (turns: number, cost: number, input: number, output: number, text: string) => ({
  type: 'result',
  subtype: 'success',
  session_id: 's1',
  num_turns: turns,
  total_cost_usd: cost,
  result: text,
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: input * 10, cache_creation_input_tokens: 1 },
});

const log = [
  { type: 'system', subtype: 'init', session_id: 's1' },
  result(2, 0.5, 10, 5, 'first'),
  { type: 'assistant', message: { id: 'm1', content: [] } },
  result(50, 1.25, 20, 7, 'second'),
  result(58, 0.25, 30, 8, 'last'),
];

test('sessionResult adds the turns, tokens and cost of every result and keeps the last one’s text', () => {
  const total = sessionResult(log);
  assert.equal(total?.num_turns, 110);
  assert.equal(total?.total_cost_usd, 2);
  assert.deepEqual(total?.usage, { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 600, cache_creation_input_tokens: 3 });
  assert.equal(total?.result, 'last');
});

test('the run fields come out summed', () => {
  const fields = resultFields(sessionResult(log), 0);
  assert.equal(fields.num_turns, 110);
  assert.equal(fields.input_tokens, 60);
  assert.equal(fields.cost_usd, 2);
});

test('a log with one result, or none, is unchanged', () => {
  assert.deepEqual(sessionResult([result(3, 1, 1, 1, 'x')]), result(3, 1, 1, 1, 'x'));
  assert.equal(sessionResult([{ type: 'system' }]), undefined);
});

test('addResult adds a figure only one result has', () => {
  const total = addResult({ subtype: 'success', num_turns: 2 }, { subtype: 'success', usage: { input_tokens: 4 }, total_cost_usd: 1 });
  assert.equal(total.num_turns, 2);
  assert.equal(total.total_cost_usd, 1);
  assert.deepEqual(total.usage, { input_tokens: 4 });
  const back = addResult({ subtype: 'success', usage: { output_tokens: 3 } }, { subtype: 'success' });
  assert.deepEqual(back.usage, { output_tokens: 3 });
});

test('addResult leaves a figure out when neither result has it', () => {
  const total = addResult({ subtype: 'success' }, { subtype: 'success' });
  assert.equal(total.num_turns, undefined);
  assert.equal(total.usage, undefined);
});
