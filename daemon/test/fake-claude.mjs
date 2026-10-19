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
// A resolve run (the prompt starts "AgentDeck conflict resolution") keeps both sides of every conflict and commits the merge;
// FAKE_RESOLVE_BLOCKED reports BLOCKED, _LEAVE says DONE with the markers still there, _ABORT aborts the merge itself,
// _STAGE stages the files without committing. The words come from the task's prompt, which the resolve prompt quotes.
//   FAKE_NO_SANDBOX  if the --settings file enables the sandbox with failIfUnavailable, exits at startup like claude does
// Every run appends its prompt to $AGENTDECK_HOME/fake-claude-calls.log, so tests can tell it never started,
// and the --settings path it got (or "-") to $AGENTDECK_HOME/fake-claude-settings.log.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const resetsAt = Math.floor(Date.now() / 1000) + 3600;
const settingsPath = args.includes('--settings') ? args[args.indexOf('--settings') + 1] : undefined;
if (process.env.AGENTDECK_HOME) {
  appendFileSync(join(process.env.AGENTDECK_HOME, 'fake-claude-calls.log'), `${prompt}\n`);
  appendFileSync(join(process.env.AGENTDECK_HOME, 'fake-claude-settings.log'), `${settingsPath ?? '-'}\n`);
}

if (prompt.includes('FAKE_NO_SANDBOX') && settingsPath) {
  const { sandbox } = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (sandbox?.enabled && sandbox.failIfUnavailable) {
    process.stderr.write('Error: sandbox is required (sandbox.failIfUnavailable) but could not start: sandbox-exec not found\n');
    process.exit(1);
  }
}

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
} else if (prompt.startsWith('AgentDeck conflict resolution')) {
  // A resolve run: a merge is in progress in the worktree. Keep both sides of every conflict, unless told otherwise.
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
  const files = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  if (prompt.includes('FAKE_RESOLVE_BLOCKED')) {
    result('The two sides contradict each other.\nSTATUS: BLOCKED: which behaviour wins?');
  } else if (prompt.includes('FAKE_RESOLVE_LEAVE')) {
    result('Looked at it.\nSTATUS: DONE');
  } else if (prompt.includes('FAKE_RESOLVE_ABORT')) {
    git('merge', '--abort');
    result('Gave up on the merge.\nSTATUS: DONE');
  } else {
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^(<{7}|={7}|>{7})( |$)/.test(l))
        .join('\n');
      writeFileSync(f, text);
      git('add', f);
    }
    if (!prompt.includes('FAKE_RESOLVE_STAGE')) git('commit', '-q', '--no-edit');
    result(`Resolved ${files.length} file(s).\nSTATUS: DONE`);
  }
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
