// Yes/no checks that a repo is ready for unattended runs. Does the I/O; the decisions on tool rules are in domain/.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { WORKTREE_DIR, claudeBin } from './config.ts';
import type { Repo } from './db.ts';
import { detectToolchain } from './domain/toolchain.ts';
import { refusedCommands } from './domain/tool-rules.ts';
import { addDetachedWorktree, git, hasOrigin, isGitRepo, refExists, removeWorktree, rootInfo, startPoint } from './git.ts';
import { SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS, effectiveTools, lastLine, runCommand } from './worker.ts';

export interface Check {
  name: string;
  ok: boolean;
  reason: string;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where the claude binary is, or null. A bare name is looked up on PATH. */
function findClaude(): string | null {
  const bin = claudeBin();
  if (isAbsolute(bin) || bin.includes('/')) return executable(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && executable(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

function ghAuth(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'status'], { timeout: 30_000 }, (err, stdout, stderr) => {
      const text = `${stdout}${stderr}`.trim();
      resolve({ ok: !err, output: text ? lastLine(text) : (err?.message ?? '') });
    });
  });
}

/** A fresh directory for the temporary worktree, under the daemon's own worktree dir. */
function makeTempDir(repo: Repo): string {
  const parent = join(WORKTREE_DIR, repo.name);
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'doctor-'));
}

/**
 * Run every check and return them in order. Checks that can't run because an earlier one failed are
 * reported as failed with "not run: …", so a green result always means everything was verified.
 * The temporary worktree is removed whether or not the checks pass.
 */
export async function runDoctor(repo: Repo): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, reason: string) => void checks.push({ name, ok, reason });

  const isRepo = existsSync(repo.path) && (await isGitRepo(repo.path));
  add('git repo', isRepo, isRepo ? repo.path : `${repo.path} is not a git repository`);
  if (!isRepo) return checks;

  const local = await refExists(repo.path, `refs/heads/${repo.base_branch}`);
  const remote = !local && (await refExists(repo.path, `refs/remotes/origin/${repo.base_branch}`));
  const baseOk = local || remote;
  const base = local ? repo.base_branch : `origin/${repo.base_branch}`;
  add('base branch', baseOk, baseOk ? `${base} exists` : `no branch ${repo.base_branch} locally or as origin/${repo.base_branch}`);

  const { files, scripts } = rootInfo(repo.path);
  const toolchain = repo.toolchain ?? detectToolchain(files, scripts)?.toolchain ?? null;
  add('toolchain', !!toolchain, toolchain ? `${toolchain}${repo.toolchain ? '' : ' (detected)'}` : 'none detected or set');

  const claude = findClaude();
  add('claude binary', !!claude, claude ?? `${claudeBin()} not found; install Claude Code or set AGENTDECK_CLAUDE_BIN`);

  // Repos have no PR mode yet; once they do, anything but off needs a working gh and an origin to push to.
  const prMode = (repo as Repo & { pr_mode?: string | null }).pr_mode;
  if (prMode && prMode !== 'off') {
    const gh = await ghAuth();
    add('gh auth', gh.ok, gh.ok ? 'gh auth status succeeded' : `gh auth status failed: ${gh.output}`);
    const origin = await hasOrigin(repo.path);
    add('origin remote', origin, origin ? 'origin exists' : `PR mode is ${prMode} but the repo has no origin remote`);
  }

  let worktree: string | null = null;
  const tmp = baseOk ? makeTempDir(repo) : null;
  try {
    if (tmp) {
      const path = join(tmp, 'wt');
      try {
        await addDetachedWorktree(repo, path, await startPoint(repo.path, repo.base_branch));
        worktree = path;
      } catch (err) {
        add('worktree', false, `could not check out ${repo.base_branch}: ${lastLine((err as Error).message)}`);
      }
    }
    const notRun = !baseOk ? `not run: base branch ${repo.base_branch} is missing` : 'not run: no worktree';

    let setupOk = true;
    if (!repo.setup_cmd) {
      add('setup', true, 'no setup command');
    } else if (!worktree) {
      setupOk = false;
      add('setup', false, notRun);
    } else {
      const setup = await runCommand(repo.setup_cmd, worktree, SETUP_TIMEOUT_MS);
      setupOk = setup.passed;
      add('setup', setupOk, setupOk ? `${repo.setup_cmd} succeeded` : `${repo.setup_cmd} failed: ${lastLine(setup.output)}`);
    }

    if (!repo.test_cmd) add('tests', false, 'no test command: tasks would be marked done untested');
    else if (!worktree) add('tests', false, notRun);
    else if (!setupOk) add('tests', false, 'not run: setup failed');
    else {
      const tests = await runCommand(repo.test_cmd, worktree, TEST_TIMEOUT_MS);
      add('tests', tests.passed, tests.passed ? `${repo.test_cmd} passed` : `${repo.test_cmd} failed: ${lastLine(tests.output)}`);
    }

    if (!repo.test_cmd) add('tool rules', true, 'no test command');
    else {
      const refused = refusedCommands(repo.test_cmd, effectiveTools(repo, worktree ?? repo.path));
      add(
        'tool rules',
        refused.length === 0,
        refused.length ? `the tool rules don't allow: ${refused.join(', ')}` : 'every command in the test command is allowed',
      );
    }
  } finally {
    if (worktree) await removeWorktree(repo, worktree).catch(() => {});
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    await git(repo.path, 'worktree', 'prune').catch(() => {});
  }
  return checks;
}
