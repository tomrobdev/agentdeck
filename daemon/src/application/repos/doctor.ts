// Yes/no checks that a repo is ready for unattended runs.
import type { App } from '#application/ports/app.ts';
import { lastLine } from '#domain/shared/index.ts';
import { SETUP_TIMEOUT_MS, TEST_TIMEOUT_MS, claudeBin } from '#src/config.ts';
import type { Repo, WorkflowFile } from '#domain/repos/index.ts';
import { planBranchCiWarning } from '#domain/repos/index.ts';
import { refusedCommands } from '#domain/repos/index.ts';
import { detectToolchain } from '#domain/repos/index.ts';
import { allowedTools } from '#domain/repos/index.ts';

export interface Check {
  name: string;
  ok: boolean;
  reason: string;
}

const WORKFLOWS_DIR = '.github/workflows';
const WORKFLOW_LIMIT = 200_000;
const LIVE_TARGET_STATUSES = ['proposed', 'queued', 'running', 'blocked'];

async function workflowsAt(app: App, repo: Repo, ref: string): Promise<WorkflowFile[]> {
  const entries = await app.workspace.listTree(repo.path, ref, WORKFLOWS_DIR).catch(() => []);
  const files = (entries ?? []).filter((e) => e.type === 'file' && /\.ya?ml$/.test(e.name));
  const read = await Promise.all(
    files.map(async (e) => ({
      path: e.path,
      file: await app.workspace.readFile(repo.path, ref, e.path, WORKFLOW_LIMIT).catch(() => null),
    })),
  );
  return read.flatMap((r) => (r.file ? [{ path: r.path, text: r.file.bytes.toString('utf8') }] : []));
}

async function missingOnOrigin(app: App, repo: Repo): Promise<string[]> {
  const names = new Set([
    ...app.syncedPlanBranches().flatMap((b) => (b.repo_id === repo.id ? [b.name] : [])),
    ...app.tasksForRepo(repo.id).flatMap((t) => (t.target && LIVE_TARGET_STATUSES.includes(t.status) ? [t.target] : [])),
  ]);
  const missing = await Promise.all([...names].map(async (name) => ((await app.workspace.onOrigin(repo.path, name)) ? null : name)));
  return missing.filter((name) => name !== null);
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

  if (base) {
    const warning = await planBranchCiWarning(await workflowsAt(app, repo, base));
    add(
      'ci on plan branches',
      true,
      warning ? `warning: ${warning}` : 'pull requests into a plan branch run the checks, or the repo has no pull_request workflow',
    );
    if (git.origin) {
      const missing = await missingOnOrigin(app, repo);
      add(
        'targets on origin',
        missing.length === 0,
        missing.length ? `not on origin: ${missing.join(', ')}` : 'every plan branch and target in use is on origin',
      );
    }
  }

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
    await ws.withScratchCheckout(repo, repo.base_branch, async (checkout) => {
      if ('error' in checkout) add('worktree', false, `could not check out ${repo.base_branch}: ${lastLine(checkout.error)}`);
      await inCheckout('path' in checkout ? checkout.path : null, 'not run: no worktree');
    });
  return checks;
}
