#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json` in tests.
// Behaviour is picked by a keyword in the prompt:
//   FAKE_DONE     writes a file, commits it, reports STATUS: DONE
//   FAKE_BLOCKED  reports STATUS: BLOCKED
//   FAKE_DENIED   reports STATUS: BLOCKED with two permission_denials in the result (FAKE_DENIED_DONE: finishes, same denials;
//                 FAKE_DENIED_NEEDS: blocks with NEEDS edit, same denials)
//   FAKE_PROTECTED_EDIT  like FAKE_DONE, and writes protected edits to .agentdeck/edits/ (.claude/…, claude/… and src/…)
//   FAKE_ERROR    exits non-zero with no result
//   FAKE_RATELIMIT emits a rejected rate_limit_event
//   FAKE_SLOW     sleeps 30s (for cancel tests), resumed or not
//   FAKE_IGNORE_TERM  ignores SIGTERM (use with FAKE_SLOW), so a cancel needs SIGKILL
//   FAKE_STALL   sleeps 30s in a new session; resumed, it finishes like FAKE_DONE (for restart tests)
//   FAKE_NEEDS_SETUP  like FAKE_DONE, but blocks unless the repo's setup wrote setup-done.txt
// A resolve run (the prompt starts "AgentDeck conflict resolution") keeps both sides of every conflict and commits the merge;
// FAKE_RESOLVE_BLOCKED reports BLOCKED, _LEAVE says DONE with the markers still there, _ABORT aborts the merge itself,
// _STAGE stages the files without committing. The words come from the task's prompt, which the resolve prompt quotes.
// An unblock run (the prompt starts "AgentDeck unblock run") retries with a note naming FAKE_UNBLOCKED, which a
// FAKE_BLOCKED task's next run takes as leave to finish like FAKE_DONE; FAKE_UNBLOCK_ASK asks a question with two
// options instead, and FAKE_UNBLOCK_GARBAGE ends without an UNBLOCK line. Those words come from the task's prompt too.
//   FAKE_ANSWER   like FAKE_DONE, and answers every review comment (c1, c2…) the prompt lists; FAKE_ANSWER_FIRST answers only c1
//   FAKE_NO_SANDBOX  if the --settings file enables the sandbox with failIfUnavailable, exits at startup like claude does
//   FAKE_PLAN_ALL    like FAKE_DONE, and marks every step of the plan file (.agentdeck/plan.html) done, with a note in each
//   FAKE_WRITE_PLAN  like FAKE_DONE, and writes a plan of its own to the plan file
// Every run appends its prompt to $AGENTDECK_HOME/fake-claude-calls.log, so tests can tell it never started,
// the --settings path it got (or "-") to $AGENTDECK_HOME/fake-claude-settings.log, and its arguments as a JSON
// array to $AGENTDECK_HOME/fake-claude-args.log.
// The init line names the model --model asked for as a full id (claude-<alias>-5-5).
// Sessions: a new session is named fake-session-<pid> and its prompt kept in $AGENTDECK_HOME/fake-sessions/.
// `--resume <id>` continues it: the init line names <id> and the kept prompt's keywords still count. A session that
// is not kept is answered as claude answers one it no longer has: "No conversation found" on stderr, exit 1, no output.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const given = args[args.indexOf('-p') + 1] ?? '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const resetsAt = Math.floor(Date.now() / 1000) + 3600;
const settingsPath = args.includes('--settings') ? args[args.indexOf('--settings') + 1] : undefined;
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined;
const home = process.env.AGENTDECK_HOME;
if (home) {
  appendFileSync(join(home, 'fake-claude-calls.log'), `${given}\n`);
  appendFileSync(join(home, 'fake-claude-settings.log'), `${settingsPath ?? '-'}\n`);
  appendFileSync(join(home, 'fake-claude-args.log'), `${JSON.stringify(args)}\n`);
}

const sessions = home ? join(home, 'fake-sessions') : undefined;
let kept = '';
if (resume !== undefined) {
  if (!sessions || !existsSync(join(sessions, resume))) {
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    process.exit(1);
  }
  kept = readFileSync(join(sessions, resume), 'utf8');
}
const session = resume ?? `fake-session-${process.pid}`;
if (sessions && resume === undefined) {
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, session), given);
}
// What this session has been told: a resumed one remembers the task.
const prompt = kept ? `${kept}\n${given}` : given;

if (prompt.includes('FAKE_IGNORE_TERM')) process.on('SIGTERM', () => {}); // only SIGKILL stops it

if (prompt.includes('FAKE_NO_SANDBOX') && settingsPath) {
  const { sandbox } = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (sandbox?.enabled && sandbox.failIfUnavailable) {
    process.stderr.write('Error: sandbox is required (sandbox.failIfUnavailable) but could not start: sandbox-exec not found\n');
    process.exit(1);
  }
}

// The init line names the exact model, as claude's does: an alias from --model becomes claude-<alias>-5-5.
const alias = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'sonnet';
const model = alias.startsWith('claude-') ? alias : `claude-${alias}-5-5`;
out({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), model });
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
    session_id: session,
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
} else if (prompt.startsWith('AgentDeck unblock run')) {
  if (prompt.includes('FAKE_UNBLOCK_ASK')) {
    result('Nothing in the repo says which database.\nUNBLOCK: ASK: Which database should it use?\n- sqlite\n- postgres');
  } else if (prompt.includes('FAKE_UNBLOCK_GARBAGE')) {
    result('I looked around.\nNot sure what to make of it.');
  } else {
    result('The README names the database.\nUNBLOCK: RETRY: use sqlite, as the README says (FAKE_UNBLOCKED)');
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
  if (prompt.includes('FAKE_DENIED_NEEDS')) {
    result('Claude Code refused the settings file.\nSTATUS: BLOCKED: NEEDS edit: .claude/settings.json', { permission_denials });
  } else if (prompt.includes('FAKE_DENIED_DONE')) {
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
} else if (prompt.includes('FAKE_BLOCKED') && !prompt.includes('FAKE_UNBLOCKED')) {
  result('I need to know which database to use.\nSTATUS: BLOCKED: which database?');
} else if (prompt.includes('FAKE_NEEDS_SETUP') && !existsSync('setup-done.txt')) {
  result('setup-done.txt is missing.\nSTATUS: BLOCKED: setup did not run');
} else if (prompt.includes('FAKE_SLOW') || (prompt.includes('FAKE_STALL') && resume === undefined)) {
  await sleep(30_000); // time passes: a slow claude, until it is stopped
  result('slow done\nSTATUS: DONE');
} else {
  // The plan file AgentDeck put in the worktree. FAKE_PLAN_ALL marks every step in it done, linked or not, with a note in
  // each step; FAKE_WRITE_PLAN writes a plan of its own there. Either way `git add -A` below must leave it out.
  const planFile = join('.agentdeck', 'plan.html');
  if (prompt.includes('FAKE_PLAN_ALL') && existsSync(planFile)) {
    const html = readFileSync(planFile, 'utf8')
      .replace(/data-status="[^"]*"/g, 'data-status="done"')
      .replace(/<\/section>/g, `<p>noted by run ${process.pid}</p></section>`);
    writeFileSync(planFile, html);
  }
  if (prompt.includes('FAKE_WRITE_PLAN')) {
    mkdirSync('.agentdeck', { recursive: true });
    writeFileSync(
      planFile,
      `<html data-agentdeck-plan="1"><head><title>Fake Plan: Two Steps!</title></head><body>
  <section data-plan-step id="one" data-status="done"><h2>One</h2></section>
  <section data-plan-step id="two" data-status="todo"><h2>Two</h2></section>
</body></html>`,
    );
  }
  if (prompt.includes('FAKE_PROTECTED_EDIT')) {
    const edit = (path, text) => {
      mkdirSync(join('.agentdeck/edits', path, '..'), { recursive: true });
      writeFileSync(join('.agentdeck/edits', path), text);
    };
    edit('.claude/skills/x/SKILL.md', '# x\nnew skill\n');
    edit('claude/skills/y/SKILL.md', '# y\nwritten without the dot\n');
    edit('src/outside.ts', 'export const outside = 1;\n');
  }
  writeFileSync('fake-output.txt', `done by fake claude for: ${prompt.slice(0, 60)}\nrun ${process.pid}\n`);
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['commit', '-q', '-m', 'fake: add output']);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Wrote fake-output.txt' }] } });
  const labels = [...prompt.matchAll(/^(c\d+) — /gm)].map((m) => m[1]);
  const answered = prompt.includes('FAKE_ANSWER_FIRST') ? labels.slice(0, 1) : prompt.includes('FAKE_ANSWER') ? labels : [];
  const answers = answered.map((l) => `ANSWER ${l}: handled ${l}\n`).join('');
  result(`Wrote fake-output.txt and committed.\n${answers}STATUS: DONE`);
}
