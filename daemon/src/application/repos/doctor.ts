// Yes/no checks that a repo is ready for unattended runs.
import type { App } from '../ports/app.ts';
import { lastLine } from '../../domain/shared/index.ts';
import { SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS, claudeBin } from '../../config.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { refusedCommands } from '../../domain/repos/index.ts';
import { detectToolchain } from '../../domain/repos/index.ts';
import { allowedTools } from '../../domain/repos/index.ts';

export interface Check {
  name: string;
  ok: boolean;
  reason: string;
}

export async function runDoctor(app: App, repo: Repo): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, reason: string) => void checks.push({ name, ok, reason });

  const ws = app.workspace;
  const git = await ws.inspectRepo(repo.path, repo.base_branch);
  add('git repo', !!git, git ? repo.path : `${repo.path} is not a git repository`);
  if (!git) return checks;

  const base = git.base;
  add('base branch', !!base, base ? `${base} exists` : `no branch ${repo.base_branch} locally or as origin/${repo.base_branch}`);

  const { files, scripts } = await ws.rootInfo(repo.path);
  const toolchain = repo.toolchain ?? detectToolchain(files, scripts)?.toolchain ?? null;
  add(
    'toolchain',
    true,
    toolchain ? `${toolchain}${repo.toolchain ? '' : ' (detected)'}` : 'none detected: no setup step, generic tool rules only',
  );

  const claude = await app.agent.find();
  add('claude binary', !!claude, claude ?? `${claudeBin()} not found; install Claude Code or set AGENTDECK_CLAUDE_BIN`);

  if (repo.pr_mode !== 'off') {
    add('origin remote', git.origin, git.origin ? 'origin exists' : `PR mode is ${repo.pr_mode} but the repo has no origin remote`);
    const gh = await app.codeHost.auth();
    add('gh auth', gh.ok, gh.ok ? 'gh auth status succeeded' : `gh auth status failed: ${gh.output}`);
  }

  const inCheckout = async (worktree: string | null, notRun: string) => {
    let setupOk = true;
    if (!repo.setup_cmd) {
      add('setup', true, 'no setup command');
    } else if (!worktree) {
      setupOk = false;
      add('setup', false, notRun);
    } else {
      const setup = await ws.runCommand(repo.setup_cmd, worktree, SETUP_TIMEOUT_MS);
      setupOk = setup.passed;
      add('setup', setupOk, setupOk ? `${repo.setup_cmd} succeeded` : `${repo.setup_cmd} failed: ${lastLine(setup.output)}`);
    }

    if (!repo.test_cmd) add('tests', false, 'no test command: tasks would be marked done untested');
    else if (!worktree) add('tests', false, notRun);
    else if (!setupOk) add('tests', false, 'not run: setup failed');
    else {
      const tests = await ws.runCommand(repo.test_cmd, worktree, TEST_TIMEOUT_MS);
      add('tests', tests.passed, tests.passed ? `${repo.test_cmd} passed` : `${repo.test_cmd} failed: ${lastLine(tests.output)}`);
    }

    if (!repo.test_cmd) add('tool rules', true, 'no test command');
    else {
      const refused = refusedCommands(repo.test_cmd, allowedTools(repo, await ws.rootInfo(worktree ?? repo.path)));
      add(
        'tool rules',
        refused.length === 0,
        refused.length ? `the tool rules don't allow: ${refused.join(', ')}` : 'every command in the test command is allowed',
      );
    }
  };

  if (!base) await inCheckout(null, `not run: base branch ${repo.base_branch} is missing`);
  else
    await ws.withScratchCheckout(repo, async (checkout) => {
      if ('error' in checkout) add('worktree', false, `could not check out ${repo.base_branch}: ${lastLine(checkout.error)}`);
      await inCheckout('path' in checkout ? checkout.path : null, 'not run: no worktree');
    });
  return checks;
}
