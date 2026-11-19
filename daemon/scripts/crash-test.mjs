#!/usr/bin/env node
// Crash test: SIGKILL the daemon in one phase of a task's life, restart it, check invariants.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prRetryFor } from '#domain/work/index.ts';

const N = process.argv[2] === undefined ? 10 : Number(process.argv[2]);
if (!Number.isInteger(N) || N < 1) {
  console.error('usage: crash-test.mjs [iterations>=1]');
  process.exit(2);
}
const DAEMON = resolve(import.meta.dirname, '..');
const CLI = join(DAEMON, 'src/cli.ts');
const FAKE = join(DAEMON, 'scripts/slow-claude.mjs');
const HOOKS = join(DAEMON, 'scripts/crash-hooks.mjs');
const OWN_ROOT = !process.env.CRASH_ROOT;
const ROOT = process.env.CRASH_ROOT ?? mkdtempSync(join(tmpdir(), 'agentdeck-crash-'));
mkdirSync(ROOT, { recursive: true });
const TASKS = 3;
const PHASES = ['running', 'tests', 'pr', 'sync', 'resolve', 'plan', 'land'];
const CLAUDE_PHASES = new Set(['running', 'resolve', 'plan']);
const PLAN_HTML = `<!doctype html><html data-agentdeck-plan="1"><head><title>Crash plan</title></head><body>
<section data-plan-step id="a" data-status="todo"><h2>A</h2></section></body></html>`;
const MARKER_TIMEOUT_MS = 30_000;
const DRAIN_TIMEOUT_MS = 30_000;
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
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const mergeInProgress = (worktree) => {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: worktree, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const staged = (worktree) => {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: worktree, stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
};
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

const fails = {
  a_nonterminal: [],
  b_too_many_runs: [],
  b_concurrent_same_worktree: [],
  c_orphan_alive_after_restart: [],
  c_orphan_commit_after_restart: [],
  d_worktree_mismatch: [],
  e_attempts_insane: [],
  f_restart_timeout: [],
  g_done_without_pr: [],
  g_pr_lost: [],
  g_pr_opened_twice: [],
  h_pushed_twice: [],
  i_merge_in_progress: [],
  j_follow_ups_pending: [],
  k_cli_write_failed: [],
  l_phase_not_reached: [],
  m_plan_branch_half_merged: [],
  n_plan_resolve_unfinished: [],
  o_plan_saga_not_resumed: [],
};
const kills = Object.fromEntries(PHASES.map((p) => [p, 0]));
let orphanTotal = 0,
  orphanCommitsAfterKill = 0,
  orphanEpipe = 0;

function cliAsync(env, ...args) {
  return new Promise((r) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (out += b));
    p.on('exit', (code) => r({ code, out: out.trim() }));
  });
}

function makeRepo(home) {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  const origin = join(home, 'origin.git');
  git(home, 'init', '-q', '--bare', '-b', 'main', origin);
  writeFileSync(join(origin, 'hooks/post-receive'), `#!/bin/sh\ncat >> ${quote(join(home, 'pushes.log'))}\n`, { mode: 0o755 });
  const repo = join(home, 'demo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  writeFileSync(
    join(repo, '.git/hooks/pre-merge-commit'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(HOOKS)} merge-hook ${quote(home)}\n`,
    { mode: 0o755 },
  );
  git(home, 'clone', '-q', origin, join(home, 'pusher'));
  return repo;
}

function divergePlanBranch(home, repo, cli) {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  const planFile = join(home, 'plan.html');
  writeFileSync(planFile, PLAN_HTML);
  const owner = /#(\d+)/.exec(cli('add', '--repo', 'demo', '--plan', planFile, 'the plan'))?.[1];
  const name = /opened (\S+)/.exec(cli('plan-branch', 'open', owner))?.[1];
  git(repo, 'checkout', '-q', '-b', name);
  writeFileSync(join(repo, 'shared.txt'), 'plan side\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'plan side');
  git(repo, 'push', '-q', 'origin', name);
  git(repo, 'checkout', '-q', 'main');
  const pusher = join(home, 'pusher');
  git(pusher, 'pull', '-q', '--ff-only', 'origin', 'main');
  writeFileSync(join(pusher, 'shared.txt'), 'base side\n');
  git(pusher, 'add', '-A');
  git(pusher, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base moved (plan)');
  git(pusher, 'push', '-q', 'origin', 'main');
  return { owner, name, diverged: git(repo, 'rev-parse', `refs/heads/${name}`) };
}

const FAKE_GH = join(DAEMON, 'scripts/fake-gh.mjs');
const PASSING_PR = {
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'check',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      startedAt: '2026-11-08T17:40:38Z',
      completedAt: '2026-11-08T17:42:38Z',
      detailsUrl: 'https://github.com/demo/demo/actions/runs/1/job/1',
      workflowName: 'check',
    },
  ],
};

function stagePlanLanding(home, env, cli) {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  const origin = join(home, 'origin2.git');
  git(home, 'init', '-q', '--bare', '-b', 'develop', origin);
  const second = join(home, 'demo2');
  mkdirSync(second);
  git(second, 'init', '-q', '-b', 'develop');
  git(second, 'config', 'user.name', 't');
  git(second, 'config', 'user.email', 't@t');
  git(second, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(second, 'remote', 'add', 'origin', origin);
  git(second, 'push', '-q', 'origin', 'develop');
  cli('repo', 'add', second);
  cli('repo', 'set', 'demo2', 'pr_mode', 'ready');
  cli('repo', 'set', 'demo2', 'merge_method', 'merge');
  const planFile = join(home, 'plan.html');
  writeFileSync(planFile, PLAN_HTML);
  const owner = /#(\d+)/.exec(cli('add', '--repo', 'demo', '--plan', planFile, 'the plan'))?.[1];
  const other = /#(\d+)/.exec(cli('add', '--repo', 'demo2', '--plan', owner, 'its other repo'))?.[1];
  const name = /opened (\S+)/.exec(cli('plan-branch', 'open', owner))?.[1];
  for (const id of [owner, other]) cli('cancel', id);
  cli('plan-branch', 'policy', owner, 'in_order', 'demo2,demo');
  const db = new DatabaseSync(join(home, 'agentdeck.db'));
  const urls = {};
  for (const [repoName, dir, base] of [
    ['demo2', second, 'develop'],
    ['demo', join(home, 'demo'), 'main'],
  ]) {
    git(dir, 'checkout', '-q', '-b', name);
    writeFileSync(join(dir, `${repoName}.txt`), 'the plan\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `the plan in ${repoName}`);
    git(dir, 'push', '-q', 'origin', name);
    git(dir, 'checkout', '-q', base);
    const url = execFileSync(process.execPath, [FAKE_GH, 'pr', 'create', '--head', name, '--base', base], { env, encoding: 'utf8' }).trim();
    writeFileSync(join(home, `pr-view-${url.split('/').at(-1)}.json`), JSON.stringify(PASSING_PR));
    db.prepare(
      "UPDATE plan_branches SET status = 'landing', pr_url = ?, head_commit = ? WHERE name = ? AND repo_id = (SELECT id FROM repos WHERE name = ?)",
    ).run(url, git(dir, 'rev-parse', name), name, repoName);
    urls[repoName] = url;
  }
  db.close();
  return { name, order: [urls.demo2, urls.demo] };
}

function sagaProblems(home, db, landing) {
  const problems = [];
  const merges = readJsonl(join(home, 'gh-calls.jsonl'))
    .filter((c) => c.kind === 'merged')
    .map((c) => c.url);
  if (merges.join(' ') !== landing.order.join(' '))
    problems.push(`merged ${merges.join(', ') || 'nothing'}, not ${landing.order.join(', ')}`);
  for (const row of db.prepare('SELECT status, pr_url, land_error FROM plan_branches WHERE name = ?').all(landing.name))
    if (row.status !== 'landed') problems.push(`${row.pr_url} is ${row.status}${row.land_error ? ` (${row.land_error})` : ''}`);
  return problems;
}

function planBranchProblems(home, plan) {
  const origin = join(home, 'origin.git');
  const git = (...a) => execFileSync('git', a, { cwd: origin, encoding: 'utf8' }).trim();
  const head = git('rev-parse', `refs/heads/${plan.name}`);
  const problems = [];
  if (/^(<{7}|>{7})/m.test(git('show', `${head}:shared.txt`))) problems.push('its head has conflict markers');
  try {
    git('merge-base', '--is-ancestor', plan.diverged, head);
  } catch {
    problems.push('its head lost the plan side');
  }
  return problems;
}

for (let i = 1; i <= N; i++) {
  const stream = i % 2 === 1;
  const phase = PHASES[(i - 1) % PHASES.length];
  const syncMode = phase === 'plan' ? '' : phase === 'resolve' ? 'conflict' : phase === 'sync' ? 'clean' : i % 2 ? 'conflict' : 'clean';
  const prWhen = kills.pr % 2 === 0 ? 'after' : 'before';
  const landWhen = kills.land % 2 === 0 ? 'merged' : 'between';
  const home = mkdtempSync(join(ROOT, `it${i}-`));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(DAEMON, 'scripts/fake-gh.mjs'))} "$@"\n`, {
    mode: 0o755,
  });
  const env = {
    ...process.env,
    AGENTDECK_HOME: home,
    AGENTDECK_CLAUDE_BIN: FAKE,
    AGENTDECK_NO_NOTIFY: '1',
    AGENTDECK_TICK_MS: '500',
    FAKE_STREAM: stream ? '1' : '0',
    FAKE_GH_DIR: home,
    AGENTDECK_PORT: '0',
    PATH: `${bin}:${process.env.PATH}`,
  };
  const repo = makeRepo(home);
  const cli = (...a) => execFileSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  const hooks = (what) => `node ${quote(HOOKS)} ${what} ${quote(home)}`;
  cli('repo', 'add', repo, '--test', hooks('test'), '--setup', hooks('setup'));
  cli('repo', 'set', 'demo', 'pr_mode', 'ready');
  const plan = phase === 'plan' ? divergePlanBranch(home, repo, cli) : null;
  const landing = phase === 'land' ? stagePlanLanding(home, env, cli) : null;
  for (let t = 0; t < TASKS; t++) cli('add', '--repo', 'demo', ...(plan ? ['--plan', plan.owner] : []), `task ${t}`);
  writeFileSync(join(home, 'sync-mode'), syncMode);
  if (!CLAUDE_PHASES.has(phase)) writeFileSync(join(home, `hang-${phase}`), phase === 'pr' ? prWhen : phase === 'land' ? landWhen : '');

  const evPath = join(home, 'fake-events.jsonl');
  const d1 = spawn(process.execPath, [CLI, 'run-once'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let d1out = '';
  d1.stdout.on('data', (b) => (d1out += b));
  d1.stderr.on('data', (b) => (d1out += b));
  const cliWrites = (async () => {
    const added = await cliAsync(env, 'add', '--repo', 'demo', 'added while the daemon runs');
    const id = /#(\d+)/.exec(added.out)?.[1];
    if (added.code !== 0 || !id) return [`add: ${added.out}`];
    const edits = await Promise.all([
      cliAsync(env, 'edit', id, '--title', 'edited while the daemon runs'),
      cliAsync(env, 'edit', String(TASKS), '--prompt', 'task edited while the daemon runs'),
    ]);
    return edits.filter((e) => e.code !== 0).map((e) => `edit: ${e.out}`);
  })();
  const reached = () =>
    CLAUDE_PHASES.has(phase)
      ? readJsonl(evPath).some(
          (e) =>
            e.kind === 'start' && e.run === (phase === 'running' ? 'work' : 'resolve') && (phase !== 'plan' || e.cwd.includes('/scratch-')),
        )
      : readJsonl(join(home, 'hangs.jsonl')).some((h) => h.phase === phase);
  const t0 = Date.now();
  while (!reached() && Date.now() - t0 < MARKER_TIMEOUT_MS && d1.exitCode === null) await sleep(25);
  const inPhase = reached();
  if (inPhase && CLAUDE_PHASES.has(phase)) await sleep(Math.random() * 600);
  const killAt = Date.now() - t0;
  const killTime = Date.now();
  d1.kill('SIGKILL');
  if (inPhase) kills[phase]++;
  else fails.l_phase_not_reached.push(`it${i}: the daemon never reached the ${phase} phase`);
  await sleep(200);
  writeFileSync(join(home, 'daemon1.log'), d1out);
  for (const h of readJsonl(join(home, 'hangs.jsonl'))) {
    try {
      process.kill(h.pid, 'SIGKILL');
    } catch {}
  }
  for (const p of PHASES) rmSync(join(home, `hang-${p}`), { force: true });
  await sleep(100);
  const wtDir = join(home, 'worktrees', 'demo');
  const worktrees = () => (existsSync(wtDir) ? readdirSync(wtDir) : []);
  const halfMerged = worktrees().filter((d) => mergeInProgress(join(wtDir, d)) || staged(join(wtDir, d))).length;
  for (const err of await cliWrites) fails.k_cli_write_failed.push(`it${i}: ${err}`);
  const evs1 = readJsonl(evPath);
  const started = evs1.filter((e) => e.kind === 'start');
  const ended = new Set(evs1.filter((e) => e.kind === 'end' || e.kind === 'stdout_error').map((e) => e.pid));
  const orphans = started.filter((e) => !ended.has(e.pid) && alive(e.pid));
  orphanTotal += orphans.length;

  const t2 = Date.now();
  const d2 = spawn(process.execPath, [CLI, 'run-once'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let d2out = '';
  d2.stdout.on('data', (b) => (d2out += b));
  d2.stderr.on('data', (b) => (d2out += b));
  const diedAt = new Map();
  const watch = setInterval(() => {
    for (const o of orphans) if (!diedAt.has(o.pid) && !alive(o.pid)) diedAt.set(o.pid, Date.now());
  }, 25);
  const done = await Promise.race([new Promise((r) => d2.on('exit', () => r(true))), sleep(DRAIN_TIMEOUT_MS).then(() => false)]);
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

  const evs = readJsonl(evPath);
  for (const o of orphans) {
    if (evs.some((e) => e.pid === o.pid && e.kind === 'committed' && e.t > killTime)) orphanCommitsAfterKill++;
    const next = evs.find((e) => e.kind === 'start' && e.pid !== o.pid && e.cwd === o.cwd && e.t > killTime);
    if (next && evs.some((e) => e.pid === o.pid && e.kind === 'committed' && e.t > next.t))
      fails.c_orphan_commit_after_restart.push(
        `it${i}: orphan ${o.pid} (task ${o.task}) committed after a new agent started in its worktree`,
      );
    if (evs.some((e) => e.pid === o.pid && e.kind === 'stdout_error')) orphanEpipe++;
  }

  const db = new DatabaseSync(join(home, 'agentdeck.db'), { readOnly: true });
  const tasks = db.prepare('SELECT * FROM tasks').all();
  const prs = readJsonl(join(home, 'gh-calls.jsonl')).filter((c) => c.kind === 'created');
  const pushes = existsSync(join(home, 'pushes.log'))
    ? readFileSync(join(home, 'pushes.log'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(' ')[2])
    : [];
  for (const t of tasks) {
    if (!TERMINAL.has(t.status)) fails.a_nonterminal.push(`it${i}: task ${t.id} ${t.status}`);
    const runs = db.prepare("SELECT * FROM runs WHERE task_id = ? AND kind = 'work' AND outcome IS NOT 'interrupted'").all(t.id);
    if (runs.length > t.max_attempts)
      fails.b_too_many_runs.push(`it${i}: task ${t.id} ${runs.length} real runs > max_attempts ${t.max_attempts}`);
    if (t.attempts < 0 || t.attempts > t.max_attempts || (t.status === 'done' && t.attempts < 1))
      fails.e_attempts_insane.push(`it${i}: task ${t.id} attempts=${t.attempts} status=${t.status}`);

    if (t.status === 'done' && !t.pr_url) {
      const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id').all(t.id);
      const retry = prRetryFor(
        { status: t.status, pr: t.pr_state ? { state: t.pr_state } : null },
        { pr_mode: 'ready' },
        events,
        Date.now(),
      );
      if (!retry || retry.state === 'person')
        fails.g_done_without_pr.push(`it${i}: task ${t.id} is done with no PR (pr_state ${t.pr_state}, retry ${retry?.state ?? 'none'})`);
    }
    const own = prs.filter((p) => p.head === t.branch);
    const url = (p) => `https://github.com/demo/demo/pull/${prs.indexOf(p) + 1}`;
    if (own.length > 1) fails.g_pr_opened_twice.push(`it${i}: task ${t.id} has ${own.length} PRs: ${own.map(url).join(', ')}`);
    for (const p of own)
      if (t.pr_url !== url(p)) fails.g_pr_lost.push(`it${i}: task ${t.id} records ${t.pr_url} but GitHub has ${url(p)} for ${t.branch}`);
    const doneRuns = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'work' AND outcome = 'done'").get(t.id).n;
    const pushed = t.branch ? pushes.filter((ref) => ref === `refs/heads/${t.branch}`).length : 0;
    if (pushed > doneRuns)
      fails.h_pushed_twice.push(`it${i}: task ${t.id}'s branch was pushed ${pushed} times for ${doneRuns} done run(s)`);
    if (t.worktree && existsSync(t.worktree) && mergeInProgress(t.worktree))
      fails.i_merge_in_progress.push(`it${i}: task ${t.id} (${t.status}) has a merge in progress in its worktree`);
  }
  const pending = db.prepare('SELECT task_id, type FROM task_events WHERE follow_up_pending = 1').all();
  if (pending.length)
    fails.j_follow_ups_pending.push(
      `it${i}: ${pending.map((e) => `task ${e.task_id} ${e.type}`).join(', ')} still pending after the restart`,
    );
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
  if (plan) {
    for (const p of planBranchProblems(home, plan)) fails.m_plan_branch_half_merged.push(`it${i}: ${plan.name}: ${p}`);
    const row = db.prepare('SELECT status FROM plan_branches WHERE name = ?').get(plan.name);
    if (row?.status !== 'active') fails.m_plan_branch_half_merged.push(`it${i}: ${plan.name} is ${row?.status ?? 'missing'}`);
  }
  if (landing) for (const p of sagaProblems(home, db, landing)) fails.o_plan_saga_not_resumed.push(`it${i}: ${landing.name}: ${p}`);
  const unfinished = db.prepare("SELECT id FROM runs WHERE kind = 'plan_resolve' AND ended_at IS NULL").all();
  if (unfinished.length) fails.n_plan_resolve_unfinished.push(`it${i}: plan resolve run(s) ${unfinished.map((r) => r.id)} never ended`);
  const onDisk = new Set(worktrees().filter((d) => !d.startsWith('scratch-')));
  const expected = new Set(tasks.filter((t) => t.worktree).map((t) => t.worktree.split('/').pop()));
  const extra = [...onDisk].filter((d) => !expected.has(d)),
    missing = [...expected].filter((d) => !onDisk.has(d));
  if (extra.length || missing.length) fails.d_worktree_mismatch.push(`it${i}: extra=[${extra}] missing=[${missing}]`);
  db.close();
  const resolves = evs.filter((e) => e.kind === 'start' && e.run === 'resolve').length;
  process.stdout.write(
    `it${i} phase=${phase}${phase === 'pr' ? `(${prWhen})` : phase === 'land' ? `(${landWhen})` : ''} sync=${syncMode} stream=${stream} kill@${killAt}ms orphans=${orphans.length} half-merged=${halfMerged} resolves=${resolves} prs=${prs.length} drain=${drainMs}ms ${done ? '' : 'TIMEOUT'}\n`,
  );
}

if (N >= PHASES.length)
  for (const p of PHASES) if (kills[p] === 0) fails.l_phase_not_reached.push(`no iteration killed the daemon in the ${p} phase`);

console.log('\n=== results over', N, 'iterations ===');
console.log(`kills per phase: ${PHASES.map((p) => `${p} ${kills[p]}`).join(', ')}`);
for (const [k, v] of Object.entries(fails)) console.log(`${k.padEnd(30)} ${String(v.length).padStart(3)}  ${v[0] ?? ''}`);
console.log(
  `orphan claude processes total: ${orphanTotal}; committed into worktree after the kill: ${orphanCommitsAfterKill}; died of EPIPE: ${orphanEpipe}`,
);
writeFileSync(join(ROOT, 'results.json'), JSON.stringify({ N, kills, fails, orphanTotal, orphanCommitsAfterKill, orphanEpipe }, null, 2));

const violations = Object.values(fails).reduce((n, v) => n + v.length, 0);
if (violations === 0 && OWN_ROOT) rmSync(ROOT, { recursive: true, force: true });
else if (violations > 0) console.error(`temp homes kept in ${ROOT}`);
console.log(`crash-test: ${N} iterations, ${violations} violations`);
process.exit(violations > 0 ? 1 : 0);
