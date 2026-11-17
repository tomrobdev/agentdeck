#!/usr/bin/env node
// The one check a task's branch must pass: check:fast, plus the crash test or check:rust when the branch changes the paths
// that need them (the rules are in daemon/scripts/lib/check-task.ts). It prints which extra checks it ran and why.
// `pnpm check` and CI keep running everything.
//
// Usage: pnpm check:task [--base origin/main] [--dry-run] [--ci-plan]
//   --base     what the branch is compared with (default origin/main, else main)
//   --dry-run  only print which checks would run and why
//   --ci-plan  only print, and write to $GITHUB_OUTPUT, which of CI's extra jobs run (all with CI_RUN_ALL=true)
// The changed paths are those between the merge base and the working tree, untracked files included.
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { EXTRA_CHECKS, ciJobs, extraChecks, reasonLine, skipLine } from '../daemon/scripts/lib/check-task.ts';

const { values: opts } = parseArgs({
  options: { base: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, 'ci-plan': { type: 'boolean', default: false } },
});

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const lines = (out) => out.split('\n').filter(Boolean);

/** The first of the candidate bases that exists, or null. */
function findBase() {
  for (const ref of opts.base ? [opts.base] : ['origin/main', 'main']) {
    try {
      git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
      return ref;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** The paths the branch changes against `base`, or null when git cannot say. */
function changedPaths(base) {
  try {
    const since = git('merge-base', base, 'HEAD');
    return [...lines(git('diff', '--name-only', '--no-renames', since)), ...lines(git('ls-files', '--others', '--exclude-standard'))];
  } catch {
    return null;
  }
}

function run(name, command) {
  console.log(`\n▶ ${name}: ${command.join(' ')}`);
  const r = spawnSync(command[0], command.slice(1), { cwd: root, stdio: 'inherit' });
  return r.status === 0;
}

const base = findBase();
const changed = base ? changedPaths(base) : null;
const chosen = changed ? extraChecks(changed) : EXTRA_CHECKS.map((c) => ({ ...c, because: [] }));

console.log('check:task runs check:fast');
if (!changed) console.log(`  could not tell what the branch changes (no ${opts.base ?? 'origin/main or main'}), so every extra check runs`);
for (const check of EXTRA_CHECKS) {
  const picked = chosen.find((c) => c.name === check.name);
  if (!changed) console.log(`  + ${check.name}`);
  else console.log(picked ? `  + ${reasonLine(picked)}` : `  - ${skipLine(check)}`);
}
if (changed && !chosen.length) console.log(`  check:fast alone: nothing the branch changes against ${base} needs more`);
if (opts['ci-plan']) {
  const jobs = ciJobs(process.env.CI_RUN_ALL === 'true' ? null : changed);
  const lines = Object.entries(jobs).map(([job, on]) => `${job}=${on}`);
  console.log(`CI jobs: ${lines.join(' ')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  process.exit(0);
}
if (opts['dry-run']) process.exit(0);

const steps = [{ name: 'check:fast', command: ['pnpm', 'check:fast'] }, ...chosen];
const ran = [];
const failed = [];
for (const step of steps) {
  ran.push(step.name);
  if (run(step.name, step.command)) continue;
  failed.push(step.name);
  if (step.name === 'check:fast') break; // the extra checks are slow, and their result would not change the verdict
}

console.log(`\ncheck:task ${failed.length ? `failed: ${failed.join(', ')}` : 'passed'} (ran ${ran.join(', ')})`);
process.exit(failed.length ? 1 : 0);
