#!/usr/bin/env node
// Crash test: SIGKILL the daemon at a random moment, restart it, check invariants.
// Usage: node scripts/crash-test.mjs [iterations=40]
// Odd iterations use a streaming fake claude (FAKE_STREAM=1), even ones a quiet fake.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const N = Number(process.argv[2] ?? 40);
const DAEMON = resolve(import.meta.dirname, '..');
const CLI = join(DAEMON, 'src/cli.ts');
const FAKE = join(DAEMON, 'scripts/slow-claude.mjs');
const ROOT = process.env.CRASH_ROOT ?? mkdtempSync(join(tmpdir(), 'agentdeck-crash-'));
mkdirSync(ROOT, { recursive: true });
const TASKS = 4;
const TERMINAL = new Set(['done', 'blocked', 'failed', 'cancelled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const fails = {
  a_nonterminal: [],
  b_too_many_runs: [],
  b_concurrent_same_worktree: [],
  c_orphan_alive_after_restart: [],
  c_orphan_commit_after_restart: [],
  d_worktree_mismatch: [],
  e_attempts_insane: [],
  f_restart_timeout: [],
};
let orphanTotal = 0,
  orphanCommitsAfterKill = 0,
  orphanEpipe = 0;

function sh(cwd, cmd, ...args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: process.env }).trim();
}

for (let i = 1; i <= N; i++) {
  const stream = i % 2 === 1;
  const home = mkdtempSync(join(ROOT, `it${i}-`));
  const env = {
    ...process.env,
    AGENTDECK_HOME: home,
    AGENTDECK_CLAUDE_BIN: FAKE,
    AGENTDECK_NO_NOTIFY: '1',
    FAKE_STREAM: stream ? '1' : '0',
    AGENTDECK_PORT: '0',
  };
  const repo = join(home, 'demo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  const cli = (...a) => execFileSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  cli('repo', 'add', repo, '--test', 'true');
  for (let t = 0; t < TASKS; t++) cli('add', '--repo', 'demo', `task ${t}`);

  // First daemon: kill -9 at a random moment.
  const d1 = spawn(process.execPath, [CLI, 'run-once'], { env, stdio: 'ignore' });
  const killAt = 300 + Math.random() * 7000;
  await sleep(killAt);
  const killTime = Date.now();
  d1.kill('SIGKILL');
  await sleep(200);
  const evPath = join(home, 'fake-events.jsonl');
  const evs1 = existsSync(evPath) ? readFileSync(evPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const started = evs1.filter((e) => e.kind === 'start');
  const ended = new Set(evs1.filter((e) => e.kind === 'end' || e.kind === 'stdout_error').map((e) => e.pid));
  const orphans = started.filter((e) => !ended.has(e.pid) && alive(e.pid));
  orphanTotal += orphans.length;

  // Restart and drain.
  const t2 = Date.now();
  const d2 = spawn(process.execPath, [CLI, 'run-once'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let d2out = '';
  d2.stdout.on('data', (b) => (d2out += b));
  d2.stderr.on('data', (b) => (d2out += b));
  // Record when each orphan dies: a killed process writes no 'end' event of its own.
  const diedAt = new Map();
  const watch = setInterval(() => {
    for (const o of orphans) if (!diedAt.has(o.pid) && !alive(o.pid)) diedAt.set(o.pid, Date.now());
  }, 25);
  const done = await Promise.race([new Promise((r) => d2.on('exit', () => r(true))), sleep(90_000).then(() => false)]);
  const drainMs = Date.now() - t2;
  writeFileSync(join(home, 'daemon2.log'), d2out);
  if (!done) {
    d2.kill('SIGKILL');
    fails.f_restart_timeout.push(`it${i}`);
  }
  clearInterval(watch);
  const survivors = orphans.filter((o) => alive(o.pid));
  if (survivors.length)
    fails.c_orphan_alive_after_restart.push(
      `it${i}: ${survivors.length} orphan(s) still alive after the restarted daemon drained (tasks ${survivors.map((o) => o.task).join(',')})`,
    );
  for (const o of survivors) {
    try {
      process.kill(o.pid, 'SIGKILL');
    } catch {}
  }

  const evs = readFileSync(evPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  for (const o of orphans) {
    if (evs.some((e) => e.pid === o.pid && e.kind === 'committed' && e.t > killTime)) orphanCommitsAfterKill++;
    // Only a commit after a new agent started in the same worktree mixes two agents' work.
    const next = evs.find((e) => e.kind === 'start' && e.pid !== o.pid && e.cwd === o.cwd && e.t > killTime);
    if (next && evs.some((e) => e.pid === o.pid && e.kind === 'committed' && e.t > next.t))
      fails.c_orphan_commit_after_restart.push(
        `it${i}: orphan ${o.pid} (task ${o.task}) committed after a new agent started in its worktree`,
      );
    if (evs.some((e) => e.pid === o.pid && e.kind === 'stdout_error')) orphanEpipe++;
  }

  const db = new DatabaseSync(join(home, 'agentdeck.db'), { readOnly: true });
  const tasks = db.prepare('SELECT * FROM tasks').all();
  for (const t of tasks) {
    if (!TERMINAL.has(t.status)) fails.a_nonterminal.push(`it${i}: task ${t.id} ${t.status}`);
    const runs = db
      .prepare("SELECT * FROM runs WHERE task_id = ? AND (result_text IS NULL OR result_text != 'daemon restarted')")
      .all(t.id);
    if (runs.length > t.max_attempts)
      fails.b_too_many_runs.push(`it${i}: task ${t.id} ${runs.length} real runs > max_attempts ${t.max_attempts}`);
    if (t.attempts < 0 || t.attempts > t.max_attempts || (t.status === 'done' && t.attempts < 1))
      fails.e_attempts_insane.push(`it${i}: task ${t.id} attempts=${t.attempts} status=${t.status}`);
  }
  // Overlapping fake-claude processes in the same worktree.
  const spans = new Map();
  for (const e of evs) {
    if (e.kind === 'start') spans.set(e.pid, { cwd: e.cwd, task: e.task, s: e.t, e: Infinity });
    else if ((e.kind === 'end' || e.kind === 'stdout_error') && spans.has(e.pid)) spans.get(e.pid).e = e.t;
  }
  for (const [pid, t] of diedAt) if (spans.has(pid) && spans.get(pid).e === Infinity) spans.get(pid).e = t;
  const list = [...spans.entries()];
  const seen = new Set();
  for (let x = 0; x < list.length; x++)
    for (let y = x + 1; y < list.length; y++) {
      const [pa, a] = list[x],
        [pb, b] = list[y];
      if (a.cwd === b.cwd && a.s < b.e && b.s < a.e && !seen.has(a.cwd)) {
        seen.add(a.cwd);
        fails.b_concurrent_same_worktree.push(
          `it${i}: task ${a.task} pids ${pa}+${pb} overlapped ${Math.round(Math.min(a.e, b.e) - Math.max(a.s, b.s))}ms in ${a.cwd.split('/').slice(-1)}`,
        );
      }
    }
  // Worktrees on disk vs tasks.
  const wtDir = join(home, 'worktrees', 'demo');
  const onDisk = new Set(existsSync(wtDir) ? readdirSync(wtDir) : []);
  const expected = new Set(tasks.filter((t) => t.worktree).map((t) => t.worktree.split('/').pop()));
  const extra = [...onDisk].filter((d) => !expected.has(d)),
    missing = [...expected].filter((d) => !onDisk.has(d));
  if (extra.length || missing.length) fails.d_worktree_mismatch.push(`it${i}: extra=[${extra}] missing=[${missing}]`);
  db.close();
  process.stdout.write(
    `it${i} stream=${stream} kill@${Math.round(killAt)}ms orphans=${orphans.length} drain=${drainMs}ms ${done ? '' : 'TIMEOUT'}\n`,
  );
}

console.log('\n=== results over', N, 'iterations ===');
for (const [k, v] of Object.entries(fails)) console.log(`${k.padEnd(30)} ${String(v.length).padStart(3)}  ${v[0] ?? ''}`);
console.log(
  `orphan claude processes total: ${orphanTotal}; committed into worktree after the kill: ${orphanCommitsAfterKill}; died of EPIPE: ${orphanEpipe}`,
);
writeFileSync(join(ROOT, 'results.json'), JSON.stringify({ N, fails, orphanTotal, orphanCommitsAfterKill, orphanEpipe }, null, 2));
