#!/usr/bin/env node
// Run the CI checks on every branch of a stack of PRs, each in its own temporary worktree.
// GitHub only runs CI on PRs into main, so a stacked PR's own code is otherwise never checked.
//
// Usage: pnpm check:stack [--base origin/main] [--tip HEAD] [--crash 3] [--fail-fast] [--remote] [--all]
//   --base    where the stack starts (default origin/main)
//   --tip     the top of the stack (default HEAD)
//   --crash   crash-test iterations per branch, 0 to skip (default 3)
//   --remote  instead of checking locally, start the GitHub "check" workflow on each branch
//   --all     also check AgentDeck's own agentdeck/task-* work branches (skipped by default)
// Branches pointing at the same commit are checked once.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/main' },
    tip: { type: 'string', default: 'HEAD' },
    crash: { type: 'string', default: '3' },
    'fail-fast': { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
  },
});

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');

/** Branches whose tip is a commit in base..tip, bottom of the stack first. Local names win over origin/. */
function stackBranches() {
  const commits = git('rev-list', '--reverse', '--topo-order', `${opts.base}..${opts.tip}`).split('\n').filter(Boolean);
  const byCommit = new Map();
  for (const line of git('for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes/origin').split('\n')) {
    const [sha, ref] = line.split(' ');
    if (!ref || ref.endsWith('/HEAD')) continue;
    const name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '');
    if (!opts.all && name.startsWith('agentdeck/')) continue;
    const names = byCommit.get(sha) ?? new Map();
    if (!names.has(name) || ref.startsWith('refs/heads/')) names.set(name, ref);
    byCommit.set(sha, names);
  }
  const out = [];
  for (const sha of commits) {
    const names = [...(byCommit.get(sha)?.keys() ?? [])];
    if (names.length) out.push({ name: names.join(', '), names, sha });
  }
  // The tip itself, even when no branch points at it (e.g. a detached HEAD).
  const tipSha = git('rev-parse', opts.tip);
  if (!out.some((b) => b.sha === tipSha)) out.push({ name: opts.tip, names: [], sha: tipSha });
  return out;
}

function run(cwd, cmd, args) {
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, output, secs: Math.round((Date.now() - started) / 1000) };
}

function checkBranch(b) {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-stack-'));
  const result = { name: b.name, sha: b.sha.slice(0, 7), steps: {}, failed: null };
  try {
    git('worktree', 'add', '--quiet', '--detach', dir, b.sha);
    const install = run(dir, 'pnpm', ['install', '--offline', '--frozen-lockfile']);
    if (!install.ok && !run(dir, 'pnpm', ['install', '--frozen-lockfile']).ok) {
      result.failed = 'install';
      result.steps.install = 'FAIL';
      return result;
    }
    const steps = [
      ['format', ['format:check']],
      ['typecheck', ['typecheck']],
      ['test', ['test']],
    ];
    for (const [label, args] of steps) {
      const r = run(dir, 'pnpm', args);
      const tests = label === 'test' ? r.output.match(/ℹ pass (\d+)/)?.[1] : null;
      result.steps[label] = r.ok ? (tests ? `ok (${tests})` : 'ok') : 'FAIL';
      if (!r.ok) {
        result.failed ??= label;
        result.output = r.output.split('\n').slice(-25).join('\n');
      }
    }
    const crash = Number(opts.crash);
    if (crash > 0) {
      const script = join(dir, 'daemon/scripts/crash-test.mjs');
      const has = spawnSync('test', ['-f', script]).status === 0;
      const r = has ? run(dir, process.execPath, [script, String(crash)]) : null;
      result.steps.crash = !r ? '—' : r.ok ? `ok (${crash})` : 'FAIL';
      if (r && !r.ok) result.failed ??= 'crash';
    }
    return result;
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root });
    rmSync(dir, { recursive: true, force: true });
  }
}

function remote(branches) {
  for (const b of branches) {
    // One run per commit: the first of its branches that is on origin.
    const name = b.names.find((n) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${n}`]).status === 0);
    if (!name) {
      console.log(`${b.name.padEnd(28)} skipped: not pushed to origin`);
      continue;
    }
    const r = spawnSync('gh', ['workflow', 'run', 'check.yml', '--ref', name], { encoding: 'utf8' });
    console.log(`${name.padEnd(28)} ${r.status === 0 ? 'started' : `failed: ${(r.stderr || r.stdout).trim()}`}`);
  }
  console.log('\nFollow them with: gh run list --workflow check.yml');
}

const branches = stackBranches();
if (!branches.length) {
  console.log(`no commits between ${opts.base} and ${opts.tip}`);
  process.exit(0);
}
console.log(`stack ${opts.base}..${opts.tip}: ${branches.map((b) => b.name).join(' → ')}\n`);
if (opts.remote) {
  remote(branches);
  process.exit(0);
}

const results = [];
for (const b of branches) {
  process.stdout.write(`checking ${b.name} … `);
  const r = checkBranch(b);
  results.push(r);
  console.log(r.failed ? `FAIL at ${r.failed}` : 'ok');
  if (r.failed && opts['fail-fast']) break;
}

const cols = ['format', 'typecheck', 'test', 'crash'];
console.log(`\n${'branch'.padEnd(28)} ${'commit'.padEnd(8)} ${cols.map((c) => c.padEnd(10)).join(' ')}`);
for (const r of results) {
  console.log(
    `${r.name.padEnd(28)} ${r.sha.padEnd(8)} ${cols.map((c) => String(r.steps[c] ?? (r.steps.install ? '—' : '')).padEnd(10)).join(' ')}`,
  );
}
const failed = results.filter((r) => r.failed);
for (const r of failed) if (r.output) console.log(`\n--- ${r.name}: ${r.failed} ---\n${r.output}`);
console.log(`\n${results.length - failed.length}/${results.length} branches pass`);
process.exit(failed.length ? 1 : 0);
