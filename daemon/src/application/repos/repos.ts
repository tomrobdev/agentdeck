// Use cases for repos: register, configure, check, pause and resume.
import { normalizeNetwork, settingsPath } from '../../domain/runs/index.ts';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { App } from '../ports/app.ts';
import { autoMergeMaxLinesError } from '../../domain/landing/index.ts';
import { MERGE_METHODS, type MergeMethod, PR_MODES, type PrMode, type Repo, isMergeMethod } from '../../domain/repos/index.ts';
import { goalsError, networkError, parseToolRules, repoNameError, toolRulesError } from '../../domain/repos/index.ts';
import { detectToolchain } from '../../domain/repos/index.ts';
import { textList } from '../../domain/shared/index.ts';
import { modelError } from '../../domain/work/index.ts';
import { type Check, runDoctor } from './doctor.ts';
import { repoView } from './repo-view.ts';
import { ActionError, flag, list, object, refuse, requireRepo, text, textOrNull, whole } from '../shared/input.ts';
import { pauseRepo } from './pause.ts';
import { buildersOnRepo, warnBuildersOnDeleted } from '../work/dependencies.ts';

/** Register a repo. Its toolchain is detected from the root files and fills in whatever isn't given. */
export async function addRepo(
  app: App,
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
  const git = existsSync(abs) ? await app.workspace.inspectRepo(abs) : null;
  if (!git) throw new ActionError(`${abs} is not a git repository`);
  const repoName = name || basename(abs);
  const nameError = repoNameError(repoName);
  if (nameError) throw new ActionError(nameError);
  const { files, scripts } = await app.workspace.rootInfo(abs);
  const detected = detectToolchain(files, scripts);
  try {
    return app.addRepo({
      name: repoName,
      path: abs,
      base_branch: base || git.branch,
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

export function repoDetail(app: App, nameOrId: string | number) {
  const repo = requireRepo(app, nameOrId);
  return { ...repoView(repo), goals: app.goals.read(repo), goals_path: app.goals.path(repo), planner_runs: app.plannerRuns(repo.id, 5) };
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
  /** The model a new task of the repo takes when it names none: an alias or a claude-… id; null or "" clears it. */
  model?: string | null;
  /**
   * The repo's own tool rules, in place of the detected ones; a string is split on commas and lines (`parseToolRules`).
   * None (null, "" or []) goes back to the defaults plus the rules detected from its toolchain.
   */
  allowed_tools?: string | string[] | null;
}

export function updateRepo(app: App, nameOrId: string | number, patch: RepoPatch) {
  const repo = requireRepo(app, nameOrId);
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
  const model = textOrNull(body, 'model');
  refuse(modelError(model ?? undefined));
  const rules =
    typeof body.allowed_tools === 'string'
      ? parseToolRules(body.allowed_tools)
      : body.allowed_tools === null
        ? []
        : list(body, 'allowed_tools');
  // No rules is null, not [] (which would allow nothing): the detected rules again.
  const allowed_tools = rules && (rules.length ? parseToolRules(rules.join('\n')) : null);
  if (allowed_tools) refuse(toolRulesError(allowed_tools));
  if (network) refuse(networkError(network));
  if (pr_mode !== undefined && !PR_MODES.includes(pr_mode as PrMode))
    throw new ActionError(`pr_mode must be one of ${PR_MODES.join(', ')}`);
  if (merge_method !== undefined && !isMergeMethod(merge_method))
    throw new ActionError(`merge_method must be one of ${MERGE_METHODS.join(', ')}`);
  if (base_branch === '') throw new ActionError('base_branch cannot be empty');
  if (goals !== undefined) {
    refuse(goalsError(goals));
    app.goals.write(repo, goals);
  }
  app.updateRepo(repo.id, {
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
    ...(model !== undefined ? { model: model || null } : {}),
    ...(allowed_tools !== undefined ? { allowed_tools } : {}),
  });
  return repoDetail(app, repo.id);
}

/** Let a paused repo's tasks run again. */
export function resumeRepo(app: App, nameOrId: string | number): Repo {
  const repo = requireRepo(app, nameOrId);
  app.setRepoPaused(repo.id, null);
  return app.getRepo(repo.id)!;
}

/**
 * Hide a repo and all its tasks and stop its work: nothing of it is claimed, planned or polled.
 * Refuses while one of its tasks is running. Its tasks keep their statuses; `unarchiveRepo` brings them back.
 */
export function archiveRepo(app: App, nameOrId: string | number): Repo {
  const repo = requireRepo(app, nameOrId);
  if (repo.archived_at) return repo;
  if (app.repoHasRunning(repo.id))
    throw new ActionError(`${repo.name} has a task running; cancel it or wait for it to finish, then archive`);
  app.setRepoArchived(repo.id, true);
  return app.getRepo(repo.id)!;
}

export function unarchiveRepo(app: App, nameOrId: string | number): Repo {
  const repo = requireRepo(app, nameOrId);
  app.setRepoArchived(repo.id, false);
  return app.getRepo(repo.id)!;
}

/** What deleting a repo will remove, counted. */
export function repoDeletionPreview(app: App, nameOrId: string | number) {
  const repo = requireRepo(app, nameOrId);
  const { tasks, run_logs } = app.repoFootprint(repo.id);
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
export async function deleteRepo(app: App, nameOrId: string | number): Promise<{ repo: string; leftover: string[] }> {
  const repo = requireRepo(app, nameOrId);
  if (!repo.archived_at) throw new ActionError(`${repo.name} is not archived; archive it first, then delete`);
  const { tasks, run_logs, planner_logs } = app.repoFootprint(repo.id);
  // Other repos' tasks that build on this repo's unmerged tasks lose those links with it: say so, so none starts unannounced.
  const builders = buildersOnRepo(
    app,
    repo.id,
    tasks.map((t) => t.id),
  );
  if (!app.deleteRepo(repo.id)) throw new ActionError(`${repo.name} is not archived; archive it first, then delete`);
  warnBuildersOnDeleted(app, repo.name, builders);
  const leftover: string[] = [];
  for (const t of tasks) {
    try {
      const worktree = t.worktree && existsSync(t.worktree) ? t.worktree : null;
      if (worktree || t.branch) await app.workspace.removeCheckout(repo, { worktree, branch: t.branch });
    } catch (err) {
      leftover.push(`task #${t.id} checkout: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const logs = [...run_logs, ...planner_logs];
  leftover.push(...app.runLog.removeFiles([...logs, ...logs.map(settingsPath)]));
  try {
    app.goals.delete(repo);
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
export async function doctorRepo(app: App, nameOrId: string | number): Promise<DoctorReport> {
  const repo = requireRepo(app, nameOrId);
  const checks = await runDoctor(app, repo);
  const failed = checks.find((c) => !c.ok);
  if (failed) pauseRepo(app, repo, `doctor: ${failed.name}`, { replace: true });
  else app.setRepoPaused(repo.id, null);
  return { repo: repo.name, ok: !failed, checks, paused_reason: app.getRepo(repo.id)!.paused_reason };
}

/** The repos, the archived ones only when asked for. */
export const listRepos = (app: App, opts: { archived?: boolean } = {}): Repo[] => app.listRepos(opts);

/** A repo by name or id, or undefined. */
export const findRepo = (app: App, nameOrId: string): Repo | undefined => app.findRepo(nameOrId);

/** A repo's name for a line of output: `repo<id>` when it is gone. */
export const repoName = (app: App, id: Repo['id']): string => app.getRepo(id)?.name ?? `repo${id}`;
