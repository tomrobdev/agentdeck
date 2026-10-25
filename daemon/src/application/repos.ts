// Use cases for repos: register, configure, check, pause and resume.
import { normalizeNetwork, settingsPath } from '../domain/run/sandbox.ts';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { deleteBranch, currentBranch, isGitRepo, pruneWorktrees, removeWorktree } from '../adapters/git.ts';
import { deleteGoals, goalsPath, readGoals, writeGoals } from '../adapters/goals.ts';
import { rootInfo } from '../adapters/repo-root.ts';
import { removeFiles } from '../adapters/run-log.ts';
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
    sandbox?: boolean;
    /** Hosts the agent's sandboxed commands may reach; a string is split on commas and spaces. */
    network?: string | string[];
  },
) {
  const repo = repoOrThrow(db, nameOrId);
  const network = patch.network !== undefined ? normalizeNetwork(patch.network) : undefined;
  const badHost = network?.find((d) => !/^[A-Za-z0-9*.:[\]-]+$/.test(d));
  if (badHost !== undefined) throw new ActionError(`not a host name: ${badHost}`);
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
    ...(patch.sandbox !== undefined ? { sandbox: patch.sandbox ? 1 : 0 } : {}),
    ...(network !== undefined ? { network: JSON.stringify(network) } : {}),
  });
  return repoDetail(db, repo.id);
}

/** Let a paused repo's tasks run again. */
export function resumeRepo(db: Db, nameOrId: string | number): Repo {
  const repo = repoOrThrow(db, nameOrId);
  db.setRepoPaused(repo.id, null);
  return db.getRepo(repo.id)!;
}

/**
 * Hide a repo and all its tasks and stop its work: nothing of it is claimed, planned or polled.
 * Refuses while one of its tasks is running. Its tasks keep their statuses; `unarchiveRepo` brings them back.
 */
export function archiveRepo(db: Db, nameOrId: string | number): Repo {
  const repo = repoOrThrow(db, nameOrId);
  if (repo.archived_at) return repo;
  if (db.repoHasRunning(repo.id))
    throw new ActionError(`${repo.name} has a task running; cancel it or wait for it to finish, then archive`);
  db.setRepoArchived(repo.id, true);
  return db.getRepo(repo.id)!;
}

export function unarchiveRepo(db: Db, nameOrId: string | number): Repo {
  const repo = repoOrThrow(db, nameOrId);
  db.setRepoArchived(repo.id, false);
  return db.getRepo(repo.id)!;
}

/** What deleting a repo will remove, counted. */
export function repoDeletionPreview(db: Db, nameOrId: string | number) {
  const repo = repoOrThrow(db, nameOrId);
  const { tasks, run_logs } = db.repoFootprint(repo.id);
  return {
    repo: repo.name,
    archived: !!repo.archived_at,
    tasks: tasks.length,
    runs: run_logs.length,
    worktrees: tasks.filter((t) => t.worktree && existsSync(t.worktree)).length,
  };
}

/**
 * Delete an archived repo and all that belongs to it, locally: each task's worktree and branch, the rows,
 * then the logs, settings files and goals file. Never touches GitHub, the remote or the repo's own folder.
 * Files go after the rows, so a failure leaves files behind, never rows pointing at missing files;
 * `leftover` names what couldn't be removed.
 */
export async function deleteRepo(db: Db, nameOrId: string | number): Promise<{ repo: string; leftover: string[] }> {
  const repo = repoOrThrow(db, nameOrId);
  if (!repo.archived_at) throw new ActionError(`${repo.name} is not archived; archive it first, then delete`);
  const { tasks, run_logs, planner_logs } = db.repoFootprint(repo.id);
  const leftover: string[] = [];
  for (const t of tasks) {
    try {
      if (t.worktree && existsSync(t.worktree)) await removeWorktree(repo, t.worktree);
      if (t.branch) await deleteBranch(repo.path, t.branch);
    } catch (err) {
      leftover.push(`task #${t.id} checkout: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await pruneWorktrees(repo.path);
  } catch {
    // the repo's folder may be gone; nothing to prune then
  }
  if (!db.deleteRepo(repo.id)) throw new ActionError(`${repo.name} is not archived; archive it first, then delete`);
  const logs = [...run_logs, ...planner_logs];
  leftover.push(...removeFiles([...logs, ...logs.map(settingsPath)]));
  try {
    deleteGoals(repo);
  } catch (err) {
    leftover.push(`goals file: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { repo: repo.name, leftover };
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
