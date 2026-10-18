#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json` in tests.
// Behaviour is picked by a keyword in the prompt:
//   FAKE_DONE     writes a file, commits it, reports STATUS: DONE
//   FAKE_BLOCKED  reports STATUS: BLOCKED
//   FAKE_DENIED   reports STATUS: BLOCKED with two permission_denials in the result (FAKE_DENIED_DONE: finishes, same denials)
//   FAKE_ERROR    exits non-zero with no result
//   FAKE_RATELIMIT emits a rejected rate_limit_event
//   FAKE_SLOW     sleeps 30s (for cancel tests)
//   FAKE_NEEDS_SETUP  like FAKE_DONE, but blocks unless the repo's setup wrote setup-done.txt
// Every run appends its prompt to $AGENTDECK_HOME/fake-claude-calls.log, so tests can tell it never started.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const resetsAt = Math.floor(Date.now() / 1000) + 3600;
if (process.env.AGENTDECK_HOME) appendFileSync(join(process.env.AGENTDECK_HOME, 'fake-claude-calls.log'), `${prompt}\n`);

out({ type: 'system', subtype: 'init', session_id: 'fake-session', cwd: process.cwd() });
out({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: prompt.includes('FAKE_RATELIMIT') ? 'rejected' : 'allowed',
    resetsAt,
    unifiedWindows: { five_hour: { utilization: 0.42, resetsAt }, seven_day: { utilization: 0.13, resetsAt: resetsAt + 86400 } },
  },
});

const isPlanner = args.includes('--json-schema');
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

if (isPlanner) {
  // Planner mode: answer with structured output. FAKE_PLAN_EMPTY in the goals → nothing to do.
  const tasks = prompt.includes('FAKE_PLAN_EMPTY')
    ? []
    : [
        { title: 'Add a greeting helper', prompt: 'FAKE_DONE add greet()', priority: 2, model: 'haiku' },
        { title: 'Document the CLI', prompt: 'FAKE_DONE write docs', priority: 1, model: 'sonnet' },
        { title: 'Add input validation', prompt: 'FAKE_DONE validate', priority: 1, model: 'sonnet' },
        { title: 'Tidy the README', prompt: 'FAKE_DONE tidy', priority: 0, model: 'gpt-9' },
      ];
  result('planned', { structured_output: { tasks, note: tasks.length ? 'looked at src/' : 'goals already met' } });
} else if (prompt.includes('FAKE_ERROR')) {
  process.stderr.write('fake failure\n');
  process.exit(1);
} else if (prompt.includes('FAKE_DENIED')) {
  // A tool use the permission rules refused; the agent gives up. FAKE_DENIED_DONE finishes anyway.
  const permission_denials = [
    { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npx prettier --write .' } },
    { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'python3 fix.py' } },
  ];
  if (prompt.includes('FAKE_DENIED_DONE')) {
    writeFileSync('fake-output.txt', 'done despite a refusal\n');
    execFileSync('git', ['add', '-A']);
    execFileSync('git', ['commit', '-q', '-m', 'fake: add output']);
    result('Worked around it.\nSTATUS: DONE', { permission_denials });
  } else {
    result('I could not run prettier.\nSTATUS: BLOCKED: permission refused', { permission_denials });
  }
} else if (prompt.includes('FAKE_RATELIMIT')) {
  result('rate limited', { is_error: true, subtype: 'error_during_execution', api_error_status: 429 });
  process.exit(1);
} else if (prompt.includes('FAKE_BLOCKED')) {
  result('I need to know which database to use.\nSTATUS: BLOCKED: which database?');
} else if (prompt.includes('FAKE_NEEDS_SETUP') && !existsSync('setup-done.txt')) {
  result('setup-done.txt is missing.\nSTATUS: BLOCKED: setup did not run');
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
