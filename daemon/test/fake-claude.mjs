#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json` in tests.
// Behaviour is picked by a keyword in the prompt:
//   FAKE_DONE     writes a file, commits it, reports STATUS: DONE
//   FAKE_BLOCKED  reports STATUS: BLOCKED
//   FAKE_ERROR    exits non-zero with no result
//   FAKE_RATELIMIT emits a rejected rate_limit_event
//   FAKE_SLOW     sleeps 30s (for cancel tests)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const resetsAt = Math.floor(Date.now() / 1000) + 3600;

out({ type: 'system', subtype: 'init', session_id: 'fake-session', cwd: process.cwd() });
out({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: prompt.includes('FAKE_RATELIMIT') ? 'rejected' : 'allowed',
    resetsAt,
    unifiedWindows: { five_hour: { utilization: 0.42, resetsAt }, seven_day: { utilization: 0.13, resetsAt: resetsAt + 86400 } },
  },
});

const result = (text, extra = {}) =>
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: 'fake-session',
    num_turns: 3,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
    ...extra,
  });

if (prompt.includes('FAKE_ERROR')) {
  process.stderr.write('fake failure\n');
  process.exit(1);
} else if (prompt.includes('FAKE_RATELIMIT')) {
  result('rate limited', { is_error: true, subtype: 'error_during_execution', api_error_status: 429 });
  process.exit(1);
} else if (prompt.includes('FAKE_BLOCKED')) {
  result('I need to know which database to use.\nSTATUS: BLOCKED: which database?');
} else if (prompt.includes('FAKE_SLOW')) {
  await new Promise((r) => setTimeout(r, 30_000));
  result('slow done\nSTATUS: DONE');
} else {
  writeFileSync('fake-output.txt', `done by fake claude for: ${prompt.slice(0, 60)}\n`);
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['commit', '-q', '-m', 'fake: add output']);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Wrote fake-output.txt' }] } });
  result('Wrote fake-output.txt and committed.\nSTATUS: DONE');
}
