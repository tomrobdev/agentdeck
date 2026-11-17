#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const session = 'ui-session';
const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
let n = 0;

out({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), model: 'claude-sonnet-5-5' });
out({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt,
    unifiedWindows: { five_hour: { utilization: 0.24, resetsAt }, seven_day: { utilization: 0.18, resetsAt: resetsAt + 86400 } },
  },
});

const assistant = (content) =>
  out({
    type: 'assistant',
    message: { id: `msg_ui_${++n}`, type: 'message', role: 'assistant', content },
    parent_tool_use_id: null,
    session_id: session,
  });
const say = (text) => assistant([{ type: 'text', text }]);
const tool = (name, input, output) => {
  const id = `toolu_ui_${++n}`;
  assistant([{ type: 'tool_use', id, name, input }]);
  out({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: output }] },
    parent_tool_use_id: null,
    session_id: session,
  });
};
const result = (text) =>
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    result: text,
    session_id: session,
    num_turns: 4,
    total_cost_usd: 0.12,
    usage: { input_tokens: 1200, output_tokens: 640, cache_read_input_tokens: 18000, cache_creation_input_tokens: 2400 },
    permission_denials: [],
  });

function edit(file, text) {
  const path = join(process.cwd(), file);
  tool('Read', { file_path: path }, readFileSync(path, 'utf8'));
  writeFileSync(path, text);
  tool('Edit', { file_path: path, old_string: '…', new_string: '…' }, `The file ${path} has been updated successfully.`);
}

function commit(message) {
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['commit', '-q', '-m', message]);
}

if (prompt.startsWith('AgentDeck unblock run')) {
  result(
    'The task leaves the store open, and nothing in the repo picks one.\nUNBLOCK: ASK: Which store should the queue use?\n- sqlite\n- a JSON file',
  );
} else if (prompt.includes('UI_BLOCKED')) {
  tool('Bash', { command: 'git grep -n store' }, 'src/queue.ts:1:// TODO: pick a store\n');
  result('The queue needs a store, and the task does not say which.\nSTATUS: BLOCKED: which store should the queue use?');
} else if (prompt.includes('UI_RUNNING')) {
  edit('README.md', '# demo\n\nA small queue, used by the dashboard tests.\n\n## Usage\n\nRun `node src/queue.ts`.\n');
  say('Writing the usage section, then the tests.');
  const parent = process.ppid;
  for (;;) {
    await sleep(500);
    if (process.ppid !== parent) process.exit(1);
  }
} else if (prompt.includes('UI_GREET')) {
  edit(
    'src/greet.ts',
    [
      '/** A greeting for one person, or for everyone when no name is given. */',
      'export function greet(name?: string): string {',
      "  const who = name?.trim() || 'everyone';",
      '  return `Hello, ${who}!`;',
      '}',
      '',
      '/** Greetings for each of the names, in order. */',
      'export function greetAll(names: string[]): string[] {',
      '  return names.map((name) => greet(name));',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    'src/greet.test.ts',
    "import { greet } from '#src/greet.ts';\n\nif (greet() !== 'Hello, everyone!') throw new Error('greet() without a name');\n",
  );
  commit('Greet everyone when no name is given');
  say('greet() now falls back to everyone, and greetAll() greets a list.');
  result(
    '## Overview\n- `greet()` greets everyone when no name is given, and `greetAll()` greets a list.\n- Checked with `src/greet.test.ts`.\n\nSTATUS: DONE',
  );
} else if (prompt.includes('UI_QUEUE')) {
  edit(
    'src/queue.ts',
    [
      '// A first-in, first-out queue of strings.',
      'const items: string[] = [];',
      '',
      'export function push(item: string): number {',
      '  items.push(item);',
      '  return items.length;',
      '}',
      '',
      '/** The oldest item, or undefined when the queue is empty. */',
      'export function pop(): string | undefined {',
      '  return items.shift();',
      '}',
      '',
      'export const size = (): number => items.length;',
      '',
    ].join('\n'),
  );
  commit('The queue says how long it is');
  say('push() returns the new length, and size() reads it.');
  result('## Overview\n- `push()` returns the queue length and `size()` reads it.\n\nSTATUS: DONE');
} else {
  result(`The end-to-end claude has no answer for this prompt.\nSTATUS: BLOCKED: unexpected prompt`);
}
