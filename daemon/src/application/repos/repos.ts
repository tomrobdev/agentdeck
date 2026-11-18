// Use cases for repos: register, configure, check, pause and resume.
import { normalizeNetwork, settingsPath } from '#domain/runs/index.ts';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { App } from '#application/ports/app.ts';
import { autoMergeMaxLinesError, codeCommentMaxLinesError, codeCommentMaxPercentError } from '#domain/landing/index.ts';
import { MERGE_METHODS, type MergeMethod, PR_MODES, type PrMode, type Repo, isMergeMethod } from '#domain/repos/index.ts';
import { goalsError, networkError, parseToolRules, repoNameError, toolRulesError } from '#domain/repos/index.ts';
import { detectToolchain } from '#domain/repos/index.ts';
import { present, textList } from '#domain/shared/index.ts';
import { modelError } from '#domain/work/index.ts';
import { type Check, runDoctor } from '#application/repos/doctor.ts';
import { repoView } from '#application/repos/repo-view.ts';
import { ActionError, flag, list, object, refuse, requireRepo, text, textOrNull, whole } from '#application/shared/input.ts';
import { pauseRepo } from '#application/repos/pause.ts';
import { buildersOnRepo, liveLinks, warnBuildersOnDeleted } from '#application/work/dependencies.ts';
import { prModeOffError, startState } from '#domain/work/index.ts';

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
  auto_review?: boolean;
  escalate?: boolean;
  sandbox?: boolean;
  network?: string | string[];
  auto_merge?: boolean;
  auto_merge_max_lines?: number;
  auto_merge_skip?: string | string[];
  ci_not_run_ok?: boolean;
  code_comment_max_lines?: number;
  code_comment_max_percent?: number;
  model?: string | null;
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
  const auto_review = flag(body, 'auto_review');
  const escalate = flag(body, 'escalate');
  const sandbox = flag(body, 'sandbox');
  const hosts = list(body, 'network', { split: true });
  const network = hosts && normalizeNetwork(hosts);
  const auto_merge = flag(body, 'auto_merge');
  const auto_merge_max_lines = whole(body, 'auto_merge_max_lines', autoMergeMaxLinesError);
  const skip = list(body, 'auto_merge_skip', { split: true });
  const auto_merge_skip = skip && textList(skip);
  const ci_not_run_ok = flag(body, 'ci_not_run_ok');
  const code_comment_max_lines = whole(body, 'code_comment_max_lines', codeCommentMaxLinesError);
  const code_comment_max_percent = whole(body, 'code_comment_max_percent', codeCommentMaxPercentError);
  const model = textOrNull(body, 'model');
  refuse(modelError(model ?? undefined));
  const rules =
    typeof body.allowed_tools === 'string'
      ? parseToolRules(body.allowed_tools)
      : body.allowed_tools === null
        ? []
        : list(body, 'allowed_tools');
  const allowed_tools = rules && (rules.length ? parseToolRules(rules.join('\n')) : null);
  if (allowed_tools) refuse(toolRulesError(allowed_tools));
  if (network) refuse(networkError(network));
  if (pr_mode !== undefined && !PR_MODES.includes(pr_mode as PrMode))
    throw new ActionError(`pr_mode must be one of ${PR_MODES.join(', ')}`);
  if (pr_mode === 'off' && repo.pr_mode !== 'off') {
    const links = liveLinks(app);
    const unmet = app
      .listTasks()
      .filter((t) => t.repo_id === repo.id && t.status !== 'done' && t.status !== 'cancelled')
      .filter((t) => {
        const kind = startState(t, links.linksOf(t.id), links.target).kind;
        return kind !== 'none' && kind !== 'met';
      })
      .map((t) => t.id);
    refuse(prModeOffError(repo.name, unmet));
  }
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
    ...(auto_review !== undefined ? { auto_review } : {}),
    ...(escalate !== undefined ? { escalate } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(auto_merge !== undefined ? { auto_merge } : {}),
    ...(auto_merge_max_lines !== undefined ? { auto_merge_max_lines } : {}),
    ...(auto_merge_skip !== undefined ? { auto_merge_skip } : {}),
    ...(ci_not_run_ok !== undefined ? { ci_not_run_ok } : {}),
    ...(code_comment_max_lines !== undefined ? { code_comment_max_lines } : {}),
    ...(code_comment_max_percent !== undefined ? { code_comment_max_percent } : {}),
    ...(model !== undefined ? { model: model || null } : {}),
    ...(allowed_tools !== undefined ? { allowed_tools } : {}),
  });
  return repoDetail(app, repo.id);
}

export function resumeRepo(app: App, nameOrId: string | number): Repo {
  const repo = requireRepo(app, nameOrId);
  app.setRepoPaused(repo.id, null);
  const draining = app.draining();
  app.setDraining({ ...draining, repos: draining.repos.filter((id) => id !== repo.id) });
  return present(app.getRepo(repo.id), `repo ${repo.name}`);
}

export function drainRepo(app: App, nameOrId: string | number): Repo {
  const repo = requireRepo(app, nameOrId);
  if (repo.archived_at) throw new ActionError(`${repo.name} is archived`);
  if (repo.paused_reason) throw new ActionError(`${repo.name} is paused already: nothing new starts in it`);
  const draining = app.draining();
  app.setDraining({ ...draining, repos: [...draining.repos, repo.id] });
  return repo;
}

export function archiveRepo(app: App, nameOrId: string | number): Repo {
  const repo = requireRepo(app, nameOrId);
  if (repo.archived_at) return repo;
  if (app.repoHasRunning(repo.id))
    throw new ActionError(`${repo.name} has a task running; cancel it or wait for it to finish, then archive`);
  app.setRepoArchived(repo.id, true);
  return present(app.getRepo(repo.id), `repo ${repo.name}`);
}

export function unarchiveRepo(app: App, nameOrId: string | number): Repo {
  const repo = requireRepo(app, nameOrId);
  app.setRepoArchived(repo.id, false);
  return present(app.getRepo(repo.id), `repo ${repo.name}`);
}

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

export async function deleteRepo(app: App, nameOrId: string | number): Promise<{ repo: string; leftover: string[] }> {
  const repo = requireRepo(app, nameOrId);
  if (!repo.archived_at) throw new ActionError(`${repo.name} is not archived; archive it first, then delete`);
  const { tasks, run_logs, planner_logs } = app.repoFootprint(repo.id);
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

export async function doctorRepo(app: App, nameOrId: string | number): Promise<DoctorReport> {
  const repo = requireRepo(app, nameOrId);
  const checks = await runDoctor(app, repo);
  const failed = checks.find((c) => !c.ok);
  if (failed) pauseRepo(app, repo, `doctor: ${failed.name}`, { replace: true });
  else app.setRepoPaused(repo.id, null);
  return { repo: repo.name, ok: !failed, checks, paused_reason: present(app.getRepo(repo.id), `repo ${repo.name}`).paused_reason };
}

export const listRepos = (app: App, opts: { archived?: boolean } = {}): Repo[] => app.listRepos(opts);

export const findRepo = (app: App, nameOrId: string): Repo | undefined => app.findRepo(nameOrId);

export const repoName = (app: App, id: Repo['id']): string => app.getRepo(id)?.name ?? `repo${id}`;
