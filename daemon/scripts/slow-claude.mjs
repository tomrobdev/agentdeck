#!/usr/bin/env node
// Slow fake `claude -p` for crash tests. Logs start/end to $AGENTDECK_HOME/fake-events.jsonl.
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ev = join(process.env.AGENTDECK_HOME, 'fake-events.jsonl');
const merging = (() => {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const run = merging ? 'resolve' : 'work';
const rec = (o) =>
  appendFileSync(
    ev,
    JSON.stringify({ pid: process.pid, cwd: process.cwd(), task: process.env.AGENTDECK_TASK_ID, run, t: Date.now(), ...o }) + '\n',
  );
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
process.stdout.on('error', (e) => {
  rec({ kind: 'stdout_error', code: e.code });
  process.exit(141);
});
rec({ kind: 'start' });
const ms = 800 + Math.random() * 1200;
out({ type: 'system', subtype: 'init', session_id: 's', cwd: process.cwd() });
const stream = process.env.FAKE_STREAM === '1';
const iv = stream ? setInterval(() => out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }), 300) : null;
await new Promise((r) => setTimeout(r, ms));
clearInterval(iv);
try {
  if (merging) {
    const conflicted = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const file of conflicted) writeFileSync(file, `settled by ${process.pid}\n`);
    execFileSync('git', ['add', '-A']);
    execFileSync('git', ['commit', '-q', '--no-edit']);
  } else {
    writeFileSync(`out-${process.pid}.txt`, 'x\n');
    execFileSync('git', ['add', '-A']);
    execFileSync('git', ['commit', '-q', '-m', `fake ${process.pid}`]);
  }
  rec({ kind: 'committed' });
} catch (e) {
  rec({ kind: 'git_error', msg: String(e.message).slice(0, 200) });
}
out({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done\nSTATUS: DONE',
  session_id: 's',
  num_turns: 1,
  total_cost_usd: 0,
  usage: {},
});
rec({ kind: 'end' });
