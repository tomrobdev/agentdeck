#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json` in tests.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const fromTmp = relative(realpathSync(tmpdir()), realpathSync(process.cwd()));
if (!fromTmp || fromTmp.startsWith('..') || isAbsolute(fromTmp)) {
  process.stderr.write(
    `fake-claude: refusing to run in ${process.cwd()}, which is not inside the temporary directory ${tmpdir()}: tests start it in a scratch checkout\n`,
  );
  process.exit(2);
}

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
const prompt = kept ? `${kept}\n${given}` : given;

if (prompt.includes('FAKE_IGNORE_TERM')) process.on('SIGTERM', () => {});

if (prompt.includes('FAKE_NO_SANDBOX') && settingsPath) {
  const { sandbox } = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (sandbox?.enabled && sandbox.failIfUnavailable) {
    process.stderr.write('Error: sandbox is required (sandbox.failIfUnavailable) but could not start: sandbox-exec not found\n');
    process.exit(1);
  }
}

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
const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
const ending = (text, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  result: text,
  session_id: session,
  num_turns: 3,
  total_cost_usd: 0.01,
  usage: USAGE,
  permission_denials: [],
  ...extra,
});
const result = (text, extra = {}) => out(ending(text, extra));

const stamp = () => new Date().toISOString();
let messages = 0;
let toolUses = 0;
const assistant = (content) =>
  out({
    type: 'assistant',
    message: { id: `msg_fake_${process.pid}_${++messages}`, type: 'message', role: 'assistant', content },
    parent_tool_use_id: null,
    session_id: session,
    timestamp: stamp(),
  });
const toolCall = (name, input, output, { error = false, id = `toolu_fake_${++toolUses}` } = {}) => {
  assistant([{ type: 'tool_use', id, name, input }]);
  out({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: output, ...(error ? { is_error: true } : {}) }] },
    parent_tool_use_id: null,
    session_id: session,
    timestamp: stamp(),
  });
};
const readme = () => toolCall('Read', { file_path: join(process.cwd(), 'README.md') }, '1\t# README\n');

const commented = 'commented.ts';
if (given.startsWith('AgentDeck counted the code comments')) {
  if (!prompt.includes('FAKE_COMMENTS_STAY')) {
    const kept = readFileSync(commented, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    writeFileSync(commented, kept);
  }
  if (prompt.includes('FAKE_COMMENTS_BREAK')) writeFileSync('broken.txt', 'tests fail now\n');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'fake: delete code comments']);
  result('Deleted them.\nSTATUS: DONE');
} else if (prompt.startsWith('AgentDeck verify run')) {
  if (prompt.includes('FAKE_VERIFY_SLOW')) await sleep(30_000);
  readme();
  const answer = prompt.includes('FAKE_VERIFY_GARBAGE')
    ? { summary: 'Looks fine.' }
    : {
        findings: [
          { claim: 'README.md has a heading', verdict: 'true', path: 'README.md', line: 1, evidence: 'Line 1 is "# README".' },
          {
            claim: 'src/count.ts exports count()',
            verdict: 'false',
            path: 'src/count.ts',
            line: 1,
            evidence: 'There is no src/count.ts on the base.',
            fix: 'Say where count() is to be added.',
          },
        ],
      };
  toolCall('StructuredOutput', answer, 'Structured output provided successfully');
  result(JSON.stringify(answer), { structured_output: answer });
} else if (prompt.startsWith('AgentDeck review run')) {
  if (prompt.includes('FAKE_REVIEW_FAIL')) {
    process.stderr.write('fake review failure\n');
    process.exit(1);
  }
  if (prompt.includes('FAKE_REVIEW_SLOW')) await sleep(30_000);
  toolCall('Bash', { command: 'git diff --stat' }, ' fake-output.txt | 1 +\n');
  const answer = prompt.includes('FAKE_REVIEW_GARBAGE')
    ? { findings: [] }
    : prompt.includes('FAKE_REVIEW_BLOCK')
      ? {
          summary: 'It writes the file, but leaves it unchecked.',
          findings: [
            { path: 'fake-output.txt', line: 1, side: 'new', body: 'Nothing checks this line', blocking: true },
            { path: 'fake-output.txt', line: 1, side: 'new', body: 'A clearer name would help', blocking: false },
          ],
        }
      : { summary: 'It does what the task asks.', findings: [] };
  toolCall('StructuredOutput', answer, 'Structured output provided successfully');
  result(JSON.stringify(answer), { structured_output: answer });
} else if (isPlanner) {
  const tasks = prompt.includes('FAKE_PLAN_EMPTY')
    ? []
    : [
        { title: 'Add a greeting helper', prompt: 'FAKE_DONE add greet()', priority: 2, model: 'haiku' },
        { title: 'Document the CLI', prompt: 'FAKE_DONE write docs', priority: 1, model: 'sonnet' },
        { title: 'Add input validation', prompt: 'FAKE_DONE validate', priority: 1, model: 'sonnet' },
        { title: 'Tidy the README', prompt: 'FAKE_DONE tidy', priority: 0, model: 'gpt-9' },
      ];
  const answer = { tasks, note: tasks.length ? 'looked at src/' : 'goals already met' };
  readme();
  toolCall('StructuredOutput', answer, 'Structured output provided successfully');
  result(JSON.stringify(answer), { structured_output: answer });
} else if (prompt.startsWith('AgentDeck conflict resolution')) {
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
} else if (prompt.includes('FAKE_MAX_TURNS')) {
  readme();
  const { result: _text, api_error_status: _status, ...end } = ending('');
  out({ ...end, subtype: 'error_max_turns', is_error: true, num_turns: 2, errors: ['Reached maximum number of turns (1)'] });
  process.exitCode = 1;
} else if (prompt.includes('FAKE_TRUNCATED')) {
  assistant([{ type: 'text', text: 'Almost there.' }]);
  const line = JSON.stringify(ending('Wrote it.\nSTATUS: DONE'));
  process.stdout.write(line.slice(0, Math.floor(line.length / 2)));
} else if (prompt.includes('FAKE_EXIT_MIDSTREAM')) {
  readme();
  process.exitCode = 1;
} else if (prompt.includes('FAKE_DENIED')) {
  const permission_denials = [
    { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npx prettier --write .' } },
    { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'python3 fix.py' } },
  ];
  for (const d of permission_denials) {
    toolCall(d.tool_name, d.tool_input, `Permission to use ${d.tool_name} has been denied.`, { error: true, id: d.tool_use_id });
  }
  assistant([{ type: 'text', text: 'The tool rules refused the command.' }]);
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
  await sleep(30_000);
  result('slow done\nSTATUS: DONE');
} else {
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
  const output = `done by fake claude for: ${prompt.slice(0, 60)}\nrun ${process.pid}\n`;
  if (prompt.includes('FAKE_TOOLS')) {
    readme();
    const file = join(process.cwd(), 'fake-output.txt');
    toolCall('Write', { file_path: file, content: output }, `File created successfully at: ${file}`);
  }
  writeFileSync('fake-output.txt', output);
  if (prompt.includes('FAKE_COMMENTS')) {
    const lines = Array.from({ length: 10 }, (_, i) => `// note ${i}\nexport const v${i} = ${i};`);
    writeFileSync(commented, `${lines.join('\n')}\n`);
  }
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['commit', '-q', '-m', 'fake: add output']);
  assistant([{ type: 'text', text: 'Wrote fake-output.txt' }]);
  const labels = [...prompt.matchAll(/^(c\d+) — /gm)].map((m) => m[1]);
  const answered = prompt.includes('FAKE_ANSWER_FIRST') ? labels.slice(0, 1) : prompt.includes('FAKE_ANSWER') ? labels : [];
  const answers = answered.map((l) => `ANSWER ${l}: handled ${l}\n`).join('');
  result(`Wrote fake-output.txt and committed.\n${answers}STATUS: DONE`);
}
