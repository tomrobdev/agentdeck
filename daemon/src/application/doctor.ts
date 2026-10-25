// Yes/no checks that a repo is ready for unattended runs. Does the I/O; the decisions on tool rules are in domain/.
import { findClaude } from '../adapters/claude.ts';
import { ghAuth } from '../adapters/github.ts';
import {
  addDetachedWorktree,
  hasOrigin,
  isGitRepo,
  makeTempDir,
  pruneWorktrees,
  refExists,
  removeTempDir,
  removeWorktree,
  startPoint,
} from '../adapters/git.ts';
import { rootInfo } from '../adapters/repo-root.ts';
import { runCommand } from '../adapters/shell.ts';
import { lastLine } from '../domain/text.ts';
import { SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS, claudeBin } from '../config.ts';
import type { Repo } from '../domain/repo/repo.ts';
import { refusedCommands } from '../domain/repo/tool-rules.ts';
import { detectToolchain } from '../domain/repo/toolchain.ts';
import { effectiveTools } from './tools.ts';

export interface Check {
  name: string;
  ok: boolean;
  reason: string;
}

/**
 * Run every check and return them in order. Checks that can't run because an earlier one failed are
 * reported as failed with "not run: …", so a green result always means everything was verified.
 * The temporary worktree is removed whether or not the checks pass.
 */
export async function runDoctor(repo: Repo): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, reason: string) => void checks.push({ name, ok, reason });

  const isRepo = await isGitRepo(repo.path);
  add('git repo', isRepo, isRepo ? repo.path : `${repo.path} is not a git repository`);
  if (!isRepo) return checks;

  const local = await refExists(repo.path, `refs/heads/${repo.base_branch}`);
  const remote = !local && (await refExists(repo.path, `refs/remotes/origin/${repo.base_branch}`));
  const baseOk = local || remote;
  const base = local ? repo.base_branch : `origin/${repo.base_branch}`;
  add('base branch', baseOk, baseOk ? `${base} exists` : `no branch ${repo.base_branch} locally or as origin/${repo.base_branch}`);

  const { files, scripts } = rootInfo(repo.path);
  const toolchain = repo.toolchain ?? detectToolchain(files, scripts)?.toolchain ?? null;
  // Not a failure: a repo built with make or plain scripts has no toolchain, only the generic tool rules.
  add(
    'toolchain',
    true,
    toolchain ? `${toolchain}${repo.toolchain ? '' : ' (detected)'}` : 'none detected: no setup step, generic tool rules only',
  );

  const claude = findClaude();
  add('claude binary', !!claude, claude ?? `${claudeBin()} not found; install Claude Code or set AGENTDECK_CLAUDE_BIN`);

  // A PR mode other than off needs an origin to push to and a working gh to open the PR.
  if (repo.pr_mode !== 'off') {
    const origin = await hasOrigin(repo.path);
    add('origin remote', origin, origin ? 'origin exists' : `PR mode is ${repo.pr_mode} but the repo has no origin remote`);
    const gh = await ghAuth();
    add('gh auth', gh.ok, gh.ok ? 'gh auth status succeeded' : `gh auth status failed: ${gh.output}`);
  }

  let worktree: string | null = null;
  const tmp = baseOk ? makeTempDir(repo, 'doctor') : null;
  try {
    if (tmp) {
      const path = tmp.worktree;
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
    if (tmp) removeTempDir(tmp.dir);
    await pruneWorktrees(repo.path).catch(() => {});
  }
  return checks;
}
