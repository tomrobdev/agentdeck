// Use cases for repos: register, configure, check, pause and resume.
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { currentBranch, isGitRepo } from '../adapters/git.ts';
import { goalsPath, readGoals, writeGoals } from '../adapters/goals.ts';
import { rootInfo } from '../adapters/repo-root.ts';
import type { Db } from '../db/index.ts';
import { MERGE_METHODS, type MergeMethod, isMergeMethod } from '../domain/pull-request/merge.ts';
import { PR_MODES, type PrMode } from '../domain/pull-request/pr.ts';
import type { Repo } from '../domain/repo/repo.ts';
import { detectToolchain } from '../domain/repo/toolchain.ts';
import { type Check, runDoctor } from './doctor.ts';
import { ActionError } from './errors.ts';
import { pauseRepo } from './pause.ts';

/** Register a repo. Its toolchain is detected from the root files and fills in whatever isn't given. */
export async function addRepo(
  db: Db,
  input: { path: string; name?: string; base?: string; test?: string | null; setup?: string | null; tools?: string[] | null },
): Promise<Repo> {
  const abs = resolve(input.path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(abs) || !(await isGitRepo(abs))) throw new ActionError(`${abs} is not a git repository`);
  const { files, scripts } = rootInfo(abs);
  const detected = detectToolchain(files, scripts);
  try {
    return db.addRepo({
      name: input.name || basename(abs),
      path: abs,
      base_branch: input.base || (await currentBranch(abs)),
      test_cmd: input.test || detected?.test_cmd || null,
      // Left null unless given, so the rules follow the repo's scripts as they change (application/tools.ts).
      allowed_tools: input.tools?.length ? input.tools : null,
      toolchain: detected?.toolchain ?? null,
      setup_cmd: input.setup || detected?.setup_cmd || null,
    });
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new ActionError('a repo with that name or path is already registered');
    throw err;
  }
}

function repoOrThrow(db: Db, nameOrId: string | number) {
  const repo = db.findRepo(String(nameOrId));
  if (!repo) throw new ActionError(`no repo "${nameOrId}"`);
  return repo;
}

export function repoDetail(db: Db, nameOrId: string | number) {
  const repo = repoOrThrow(db, nameOrId);
  return { ...repo, goals: readGoals(repo), goals_path: goalsPath(repo), planner_runs: db.plannerRuns(repo.id, 5) };
}

export function updateRepo(
  db: Db,
  nameOrId: string | number,
  patch: {
    goals?: string;
    auto_approve?: boolean;
    test_cmd?: string | null;
    setup_cmd?: string | null;
    base_branch?: string;
    pr_mode?: PrMode;
    merge_method?: MergeMethod;
    auto_resolve?: boolean;
  },
) {
  const repo = repoOrThrow(db, nameOrId);
  if (patch.pr_mode !== undefined && !PR_MODES.includes(patch.pr_mode))
    throw new ActionError(`pr_mode must be one of ${PR_MODES.join(', ')}`);
  if (patch.merge_method !== undefined && !isMergeMethod(patch.merge_method))
    throw new ActionError(`merge_method must be one of ${MERGE_METHODS.join(', ')}`);
  if (patch.base_branch !== undefined && !patch.base_branch.trim()) throw new ActionError('base_branch cannot be empty');
  if (patch.goals !== undefined) {
    if (patch.goals.length > 20_000) throw new ActionError('goals are limited to 20,000 characters');
    writeGoals(repo, patch.goals);
  }
  db.updateRepo(repo.id, {
    ...(patch.auto_approve !== undefined ? { auto_approve: patch.auto_approve ? 1 : 0 } : {}),
    ...(patch.test_cmd !== undefined ? { test_cmd: patch.test_cmd?.trim() || null } : {}),
    ...(patch.setup_cmd !== undefined ? { setup_cmd: patch.setup_cmd?.trim() || null } : {}),
    ...(patch.base_branch !== undefined ? { base_branch: patch.base_branch.trim() } : {}),
    ...(patch.pr_mode !== undefined ? { pr_mode: patch.pr_mode } : {}),
    ...(patch.merge_method !== undefined ? { merge_method: patch.merge_method } : {}),
    ...(patch.auto_resolve !== undefined ? { auto_resolve: patch.auto_resolve ? 1 : 0 } : {}),
  });
  return repoDetail(db, repo.id);
}

/** Let a paused repo's tasks run again. */
export function resumeRepo(db: Db, nameOrId: string | number): Repo {
  const repo = repoOrThrow(db, nameOrId);
  db.setRepoPaused(repo.id, null);
  return db.getRepo(repo.id)!;
}

export interface DoctorReport {
  repo: string;
  ok: boolean;
  checks: Check[];
  paused_reason: string | null;
}

/**
 * Check that a repo is ready for unattended runs. A failure pauses the repo, naming the first failed check;
 * a pass clears any pause.
 */
export async function doctorRepo(db: Db, nameOrId: string | number): Promise<DoctorReport> {
  const repo = repoOrThrow(db, nameOrId);
  const checks = await runDoctor(repo);
  const failed = checks.find((c) => !c.ok);
  if (failed) pauseRepo(db, repo, `doctor: ${failed.name}`, { replace: true });
  else db.setRepoPaused(repo.id, null);
  return { repo: repo.name, ok: !failed, checks, paused_reason: db.getRepo(repo.id)!.paused_reason };
}
