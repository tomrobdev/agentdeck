// Use cases for repos: register, configure, check, pause and resume.
import { normalizeNetwork, settingsPath } from '../../domain/runs/index.ts';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { deleteBranch, currentBranch, isGitRepo, pruneWorktrees, removeWorktree } from '../../adapters/git.ts';
import { deleteGoals, goalsPath, readGoals, writeGoals } from '../../adapters/goals.ts';
import { rootInfo } from '../../adapters/repo-root.ts';
import { removeFiles } from '../../adapters/run-log.ts';
import type { Db } from '../../db/index.ts';
import { autoMergeMaxLinesError } from '../../domain/landing/index.ts';
import { MERGE_METHODS, type MergeMethod, PR_MODES, type PrMode, type Repo, isMergeMethod } from '../../domain/repos/index.ts';
import { goalsError, networkError, repoNameError } from '../../domain/repos/index.ts';
import { detectToolchain } from '../../domain/repos/index.ts';
import { textList } from '../../domain/shared/index.ts';
import { type Check, runDoctor } from './doctor.ts';
import { repoView } from './repo-view.ts';
import { ActionError, flag, list, object, refuse, requireRepo, text, textOrNull, whole } from '../shared/input.ts';
import { pauseRepo } from './pause.ts';
import { buildersOnRepo, warnBuildersOnDeleted } from '../work/dependencies.ts';

/** Register a repo. Its toolchain is detected from the root files and fills in whatever isn't given. */
export async function addRepo(
  db: Db,
  input: { path: string; name?: string; base?: string; test?: string | null; setup?: string | null; tools?: string[] | null },
): Promise<Repo> {
  const body = object(input);
  const path = text(body, 'path', { empty: true });
  if (!path) throw new ActionError('a path is required');
  const name = text(body, 'name', { empty: true });
  const base = text(body, 'base', { empty: true });
  const test = textOrNull(body, 'test');
  const setup = textOrNull(body, 'setup');
  const tools = body.tools === null ? undefined : list(body, 'tools');
  const abs = resolve(path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(abs) || !(await isGitRepo(abs))) throw new ActionError(`${abs} is not a git repository`);
  const repoName = name || basename(abs);
  const nameError = repoNameError(repoName);
  if (nameError) throw new ActionError(nameError);
  const { files, scripts } = rootInfo(abs);
  const detected = detectToolchain(files, scripts);
  try {
    return db.addRepo({
      name: repoName,
      path: abs,
      base_branch: base || (await currentBranch(abs)),
      test_cmd: test || detected?.test_cmd || null,
      // Left null unless given, so the rules follow the repo's scripts as they change (domain/repos/tools.ts).
      allowed_tools: tools?.length ? tools : null,
      toolchain: detected?.toolchain ?? null,
      setup_cmd: setup || detected?.setup_cmd || null,
    });
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new ActionError('a repo with that name or path is already registered');
    throw err;
  }
}

export function repoDetail(db: Db, nameOrId: string | number) {
  const repo = requireRepo(db, nameOrId);
  return { ...repoView(repo), goals: readGoals(repo), goals_path: goalsPath(repo), planner_runs: db.plannerRuns(repo.id, 5) };
}

export interface RepoPatch {
  goals?: string;
  auto_approve?: boolean;
  test_cmd?: string | null;
  setup_cmd?: string | null;
  base_branch?: string;
  pr_mode?: PrMode;
  merge_method?: MergeMethod;
  auto_resolve?: boolean;
  auto_unblock?: boolean;
  sandbox?: boolean;
  /** Hosts the agent's sandboxed commands may reach; a string is split on commas and spaces. */
  network?: string | string[];
  auto_merge?: boolean;
  auto_merge_max_lines?: number;
  /** Path prefixes a PR touching needs a person; a string is split on commas and spaces. */
  auto_merge_skip?: string | string[];
}

export function updateRepo(db: Db, nameOrId: string | number, patch: RepoPatch) {
  const repo = requireRepo(db, nameOrId);
  const body = object(patch);
  const goals = text(body, 'goals', { empty: true, raw: true });
  const auto_approve = flag(body, 'auto_approve');
  const test_cmd = textOrNull(body, 'test_cmd');
  const setup_cmd = textOrNull(body, 'setup_cmd');
  const base_branch = text(body, 'base_branch');
  const pr_mode = text(body, 'pr_mode', { empty: true, raw: true });
  const merge_method = text(body, 'merge_method', { empty: true, raw: true });
  const auto_resolve = flag(body, 'auto_resolve');
  const auto_unblock = flag(body, 'auto_unblock');
  const sandbox = flag(body, 'sandbox');
  const hosts = list(body, 'network', { split: true });
  const network = hosts && normalizeNetwork(hosts);
  const auto_merge = flag(body, 'auto_merge');
  const auto_merge_max_lines = whole(body, 'auto_merge_max_lines', autoMergeMaxLinesError);
  const skip = list(body, 'auto_merge_skip', { split: true });
  const auto_merge_skip = skip && textList(skip);
  if (network) refuse(networkError(network));
  if (pr_mode !== undefined && !PR_MODES.includes(pr_mode as PrMode))
    throw new ActionError(`pr_mode must be one of ${PR_MODES.join(', ')}`);
  if (merge_method !== undefined && !isMergeMethod(merge_method))
    throw new ActionError(`merge_method must be one of ${MERGE_METHODS.join(', ')}`);
  if (base_branch === '') throw new ActionError('base_branch cannot be empty');
  if (goals !== undefined) {
    refuse(goalsError(goals));
    writeGoals(repo, goals);
  }
  db.updateRepo(repo.id, {
    ...(auto_approve !== undefined ? { auto_approve } : {}),
    ...(test_cmd !== undefined ? { test_cmd: test_cmd?.trim() || null } : {}),
    ...(setup_cmd !== undefined ? { setup_cmd: setup_cmd?.trim() || null } : {}),
    ...(base_branch !== undefined ? { base_branch } : {}),
    ...(pr_mode !== undefined ? { pr_mode: pr_mode as PrMode } : {}),
    ...(merge_method !== undefined ? { merge_method: merge_method as MergeMethod } : {}),
    ...(auto_resolve !== undefined ? { auto_resolve } : {}),
    ...(auto_unblock !== undefined ? { auto_unblock } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(auto_merge !== undefined ? { auto_merge } : {}),
    ...(auto_merge_max_lines !== undefined ? { auto_merge_max_lines } : {}),
    ...(auto_merge_skip !== undefined ? { auto_merge_skip } : {}),
  });
  return repoDetail(db, repo.id);
}

/** Let a paused repo's tasks run again. */
export function resumeRepo(db: Db, nameOrId: string | number): Repo {
  const repo = requireRepo(db, nameOrId);
  db.setRepoPaused(repo.id, null);
  return db.getRepo(repo.id)!;
}

/**
 * Hide a repo and all its tasks and stop its work: nothing of it is claimed, planned or polled.
 * Refuses while one of its tasks is running. Its tasks keep their statuses; `unarchiveRepo` brings them back.
 */
export function archiveRepo(db: Db, nameOrId: string | number): Repo {
  const repo = requireRepo(db, nameOrId);
  if (repo.archived_at) return repo;
  if (db.repoHasRunning(repo.id))
    throw new ActionError(`${repo.name} has a task running; cancel it or wait for it to finish, then archive`);
  db.setRepoArchived(repo.id, true);
  return db.getRepo(repo.id)!;
}

export function unarchiveRepo(db: Db, nameOrId: string | number): Repo {
  const repo = requireRepo(db, nameOrId);
  db.setRepoArchived(repo.id, false);
  return db.getRepo(repo.id)!;
}

/** What deleting a repo will remove, counted. */
export function repoDeletionPreview(db: Db, nameOrId: string | number) {
  const repo = requireRepo(db, nameOrId);
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
 * Delete an archived repo and all that belongs to it, locally: the rows, then each task's worktree and branch,
 * the logs, settings files and goals file. Never touches GitHub, the remote or the repo's own folder.
 * Files go after the rows, so a failure leaves files behind, never rows pointing at missing files;
 * `leftover` names what couldn't be removed.
 */
export async function deleteRepo(db: Db, nameOrId: string | number): Promise<{ repo: string; leftover: string[] }> {
  const repo = requireRepo(db, nameOrId);
  if (!repo.archived_at) throw new ActionError(`${repo.name} is not archived; archive it first, then delete`);
  const { tasks, run_logs, planner_logs } = db.repoFootprint(repo.id);
  // Other repos' tasks that build on this repo's unmerged tasks lose those links with it: say so, so none starts unannounced.
  const builders = buildersOnRepo(
    db,
    repo.id,
    tasks.map((t) => t.id),
  );
  if (!db.deleteRepo(repo.id)) throw new ActionError(`${repo.name} is not archived; archive it first, then delete`);
  warnBuildersOnDeleted(db, repo.name, builders);
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
  const repo = requireRepo(db, nameOrId);
  const checks = await runDoctor(repo);
  const failed = checks.find((c) => !c.ok);
  if (failed) pauseRepo(db, repo, `doctor: ${failed.name}`, { replace: true });
  else db.setRepoPaused(repo.id, null);
  return { repo: repo.name, ok: !failed, checks, paused_reason: db.getRepo(repo.id)!.paused_reason };
}
