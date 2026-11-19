// Keeps plan branches current: merges each one's base into it in a scratch checkout, with a resolve run on its plan's task for conflicts.
import type { App } from '#application/ports/app.ts';
import type { SyncStart } from '#application/ports/workspace.ts';
import type { Repo } from '#domain/repos/index.ts';
import { type Outcome, type Run, buildPlanResolvePrompt, resolveOutcome } from '#domain/runs/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import {
  type PlanBranch,
  type PlanBranchSyncOutcome,
  type Task,
  leftoversMessage,
  mayResolvePlanBranch,
  planBranchSyncDue,
} from '#domain/work/index.ts';
import { endTaskRun, openTaskRun, startTaskRun } from '#application/runs/claude-run.ts';
import { resolutionProblem } from '#application/runs/sync.ts';
import { nextPlanBranchToLand, openPlanBranchPr } from '#application/landing/pull-request/plan-branch-pr.ts';
import { nextPlanReview, runPlanReview } from '#application/runs/plan-review.ts';

export interface PlanBranchSyncReport {
  outcome: PlanBranchSyncOutcome | 'deferred' | 'error';
  files: string[];
  reason?: string;
  pushed: boolean;
}

const syncing = new Set<number>();

export const isPlanBranchSyncing = (branch: Pick<PlanBranch, 'id'>): boolean => syncing.has(branch.id);

export async function syncPlanBranch(app: App, branch: PlanBranch, opts: { allowResolve: boolean }): Promise<PlanBranchSyncReport> {
  while (syncing.has(branch.id)) await new Promise((r) => setTimeout(r, 100));
  syncing.add(branch.id);
  try {
    const fresh = app.planBranchNamed(branch.repo_id, branch.name);
    const repo = app.getRepo(branch.repo_id);
    const owner = app.getTask(branch.plan_task);
    if (!fresh || !repo || !owner) return { outcome: 'error', files: [], reason: `${branch.name} is gone`, pushed: false };
    if (fresh.status !== 'active' && fresh.status !== 'conflict')
      return { outcome: 'deferred', files: [], reason: fresh.status, pushed: false };
    return await app.workspace.withScratchCheckout(repo, fresh.name, async (checkout) => {
      if ('error' in checkout) return { outcome: 'error' as const, files: [], reason: checkout.error, pushed: false };
      return syncIn(app, { branch: fresh, repo, owner, worktree: checkout.path }, opts.allowResolve && mayResolvePlanBranch(fresh, repo));
    });
  } catch (err) {
    return { outcome: 'error', files: [], reason: errorMessage(err), pushed: false };
  } finally {
    syncing.delete(branch.id);
  }
}

interface SyncPlace {
  branch: PlanBranch;
  repo: Repo;
  owner: Task;
  worktree: string;
}

async function syncIn(app: App, at: SyncPlace, allowResolve: boolean): Promise<PlanBranchSyncReport> {
  const { branch, repo, owner, worktree } = at;
  const before = (await app.workspace.head(worktree))?.sha ?? null;
  const merge = await app.workspace.startSync(repo, branch.base, worktree, leftoversMessage(owner));
  if (merge.kind === 'no_base') return { outcome: 'error', files: [], reason: `there is no ${merge.ref} to sync with`, pushed: false };
  if (merge.kind === 'up_to_date') return settled(app, at, 'up_to_date', before, []);
  if (merge.kind === 'merged') return land(app, at, 'clean', []);
  if (!allowResolve) return settled(app, at, 'conflict', null, merge.files);
  const resolved = await resolve(app, at, merge);
  if (resolved.outcome === 'done') return land(app, at, 'resolved', merge.files);
  if (resolved.outcome === 'rate_limited' || resolved.outcome === 'cancelled')
    return { outcome: 'deferred', files: merge.files, reason: resolved.reason || resolved.outcome, pushed: false };
  return { ...(await settled(app, at, 'conflict', null, merge.files)), reason: resolved.reason };
}

async function resolve(
  app: App,
  at: SyncPlace,
  conflict: Extract<SyncStart, { kind: 'conflicts' }>,
): Promise<{ outcome: Outcome; reason: string }> {
  const { branch, repo, owner, worktree } = at;
  const { files, ours, theirs, before } = conflict;
  const prompt = buildPlanResolvePrompt(owner, branch.name, { base: branch.base, files, ours, theirs, testCmd: repo.test_cmd });
  const opened = openTaskRun(app, owner, 'plan_resolve');
  let fields: Partial<Run> = {};
  let outcome: Outcome;
  let reason = '';
  try {
    const ran = await startTaskRun(app, owner, { kind: 'plan_resolve', repo, worktree, prompt, opened, cancelled: () => false });
    fields = ran.fields;
    const settledRun = resolveOutcome(ran.end);
    if (settledRun.outcome !== 'check') {
      outcome = settledRun.outcome;
      reason = 'reason' in settledRun ? settledRun.reason : '';
    } else {
      reason = resolutionProblem(await app.workspace.finishSync(worktree, files, before, leftoversMessage(owner)));
      outcome = reason ? 'failed' : 'done';
    }
  } catch (err) {
    outcome = 'failed';
    reason = errorMessage(err);
  }
  await endTaskRun(app, opened, outcome, reason, fields);
  return { outcome, reason };
}

async function land(app: App, at: SyncPlace, outcome: 'clean' | 'resolved', files: string[]): Promise<PlanBranchSyncReport> {
  const { branch, repo, worktree } = at;
  const head = await app.workspace.head(worktree);
  if (!head) return { outcome: 'error', files, reason: 'the merge left no head', pushed: false };
  const moved = await app.workspace.moveBranch(repo.path, branch.name, head.sha);
  if (moved.origin) {
    try {
      await app.codeHost.push(repo.path, branch.name);
    } catch (err) {
      return { outcome: 'error', files, reason: `push: ${errorMessage(err)}`, pushed: false };
    }
  }
  return { ...(await settled(app, at, outcome, head.sha, files)), pushed: moved.origin };
}

async function aheadLines(app: App, at: SyncPlace): Promise<number | null> {
  const { files } = await app.workspace.compare(at.repo.path, at.branch.base, at.branch.name).catch(() => ({ files: null }));
  return files ? files.reduce((sum, f) => sum + f.additions + f.deletions, 0) : null;
}

async function settled(
  app: App,
  at: SyncPlace,
  outcome: PlanBranchSyncOutcome,
  head: string | null,
  files: string[],
): Promise<PlanBranchSyncReport> {
  app.recordPlanBranchSync(at.branch, outcome, head, outcome === 'conflict' ? null : await aheadLines(app, at));
  return { outcome, files, pushed: false };
}

export async function keepPlanBranchCurrent(app: App, repo: Repo, task: Pick<Task, 'id' | 'target'>): Promise<PlanBranchSyncReport | null> {
  const branch = task.target === null ? undefined : app.planBranchNamed(repo.id, task.target);
  if (branch?.status !== 'active') return null;
  return syncPlanBranch(app, branch, { allowResolve: true });
}

export function nextPlanBranchSync(app: App, now: number): PlanBranch | null {
  const every = app.planBranchSyncMinutes();
  const open = new Set(app.listRepos().flatMap((r) => (r.paused_reason ? [] : [r.id])));
  return app.syncedPlanBranches().find((b) => open.has(b.repo_id) && !isPlanBranchSyncing(b) && planBranchSyncDue(b, now, every)) ?? null;
}

export async function landPlanBranch(app: App, branch: PlanBranch): Promise<string> {
  const synced = await syncPlanBranch(app, branch, { allowResolve: true });
  const sync = `${synced.outcome}${synced.reason ? ` (${synced.reason})` : ''}`;
  if (synced.outcome !== 'up_to_date' && synced.outcome !== 'clean' && synced.outcome !== 'resolved')
    return `synced before landing: ${sync}, so its PR waits`;
  const { url, error } = await openPlanBranchPr(app, branch);
  return url ? `synced (${sync}) and its PR opened into ${branch.base}: ${url}` : `synced (${sync}), but its PR did not open: ${error}`;
}

export function startPlanBranchSync(app: App, log: (msg: string) => void, now: number = Date.now()): Promise<void> | null {
  const ready = nextPlanBranchToLand(app, now, isPlanBranchSyncing);
  if (ready) return landPlanBranch(app, ready).then((line) => log(`plan branch ${ready.name}: ${line}`));
  const review = nextPlanReview(app);
  if (review)
    return runPlanReview(app, review).then((r) =>
      log(`plan branch ${review.name}: plan review run: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`),
    );
  const branch = nextPlanBranchSync(app, now);
  if (!branch) return null;
  return syncPlanBranch(app, branch, { allowResolve: true }).then((r) =>
    log(`plan branch ${branch.name}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}${r.pushed ? ', pushed' : ''}`),
  );
}
