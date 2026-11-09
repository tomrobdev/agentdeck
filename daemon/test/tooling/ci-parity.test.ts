// CI runs nothing a task's own check skips: every `run:` step of a workflow is a check `pnpm check:task` runs (check:fast's
// parts, or an extra check the branch's paths call for), or setup listed here with its reason. And CI runs every part of
// check:fast. So a worker whose tests passed is not failed by a check it never ran, as #246 was by the coverage floors.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXTRA_CHECKS } from '../../scripts/lib/check-task.ts';

const ROOT = join(import.meta.dirname, '../../..');
const WORKFLOWS = join(ROOT, '.github/workflows');

/** Workflow steps that set up the machine rather than check the code, each with why. */
const SETUP: Record<string, string> = {
  'pnpm install --frozen-lockfile': "installs dependencies; a task's worktree has its own setup command",
  'git config --global user.name ci && git config --global user.email ci@example.com': 'tests commit in temporary repos',
  'cargo fetch --locked': 'check:rust runs with --offline, so CI fetches the crates first',
  'mkdir -p app/dist': 'tauri::generate_context! needs app/dist to exist to compile',
  'pnpm --filter agentdeck-app exec playwright install --with-deps chromium':
    'test:ui needs a Chromium; on a Mac it was installed by hand, and a worker cannot download it',
};

/** Each workflow's `run:` commands, with the line each is on. */
function runSteps(): { file: string; line: number; command: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((file) =>
      readFileSync(join(WORKFLOWS, file), 'utf8')
        .split('\n')
        .flatMap((text, i) => {
          const m = /^\s*(?:- )?run:\s*(.+?)\s*$/.exec(text);
          return m ? [{ file, line: i + 1, command: m[1].replace(/^['"]|['"]$/g, '') }] : [];
        }),
    );
}

/** The commands `pnpm check:fast` runs, from the root package.json. */
function checkFastParts(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  return pkg.scripts['check:fast'].split('&&').map((s) => s.trim());
}

/** What check:task runs: check:fast's parts and its extra checks' commands. */
const taskCommands = (): string[] => [...checkFastParts(), ...EXTRA_CHECKS.map((c) => c.command.join(' '))];

test('[ci-parity] every CI step is a check pnpm check:task runs, or setup with a reason', () => {
  const task = taskCommands();
  const extra = runSteps().filter((s) => !task.includes(s.command) && !SETUP[s.command]);
  assert.deepEqual(
    extra.map((s) => `.github/workflows/${s.file}:${s.line}: ${s.command}`),
    [],
    'CI steps a task never runs: add them to check:fast or to EXTRA_CHECKS (daemon/scripts/lib/check-task.ts), or to SETUP with why',
  );
});

test('[ci-parity] CI runs every part of check:fast', () => {
  const ci = runSteps().map((s) => s.command);
  assert.deepEqual(
    checkFastParts().filter((c) => !ci.includes(c)),
    [],
    'parts of check:fast no workflow runs: add a named step for each to .github/workflows/check.yml',
  );
});

test('[ci-parity] the setup list names only steps a workflow has', () => {
  const ci = runSteps().map((s) => s.command);
  assert.deepEqual(
    Object.keys(SETUP).filter((c) => !ci.includes(c)),
    [],
    'entries on SETUP that no workflow runs any more',
  );
});

test('[ci-parity] every check step in check.yml has a name, so a failure says what failed', () => {
  const lines = readFileSync(join(WORKFLOWS, 'check.yml'), 'utf8').split('\n');
  const unnamed = runSteps()
    .filter((s) => s.file === 'check.yml' && !SETUP[s.command])
    .filter((s) => !/^\s*- name:/.test(lines[s.line - 2] ?? ''))
    .map((s) => `check.yml:${s.line}: ${s.command}`);
  assert.deepEqual(unnamed, [], 'give each check step a `- name:` line just above its `run:`');
});
