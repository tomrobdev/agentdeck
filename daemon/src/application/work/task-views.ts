// Tasks as the dashboard and the CLI show them: a task plus what the queue says about it.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { type AutoMergeView, autoMergeOn, autoMergeView } from '#domain/landing/index.ts';
import { type ChecksSummary, checksSummary } from '#domain/landing/index.ts';
import { type MergeRequestView, conflictsWithBase, mergeRequestView } from '#domain/landing/index.ts';
import { isMergeLocked, isSyncLocked } from '#application/work/checkout-locks.ts';
import { type LiveView, type SyncView, liveView, syncView } from '#domain/runs/index.ts';
import { type Run, type RunSummary, runSummary } from '#domain/runs/index.ts';
import { type PrRetry, openPrUrl } from '#domain/landing/index.ts';
import {
  type PlanBranch,
  type PlanBranchStatus,
  type PlanLanding,
  type TaskIssue,
  isLivePlanBranch,
  planLandingOf,
  prRetryFor,
  targetOf,
} from '#domain/work/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import type { StartWait, Waiting } from '#domain/work/index.ts';
import { measureBranch } from '#application/work/files.ts';
import type { TaskStatus } from '#domain/work/index.ts';
import type { Task } from '#domain/work/index.ts';
import { liveLinks, loadedLinks } from '#application/work/dependencies.ts';
import { type LinkView, dependentViews, linkViews, startState, unblocksOf, waitingFor } from '#domain/work/index.ts';
import type { LinkIndex, LinkKind } from '#domain/work/index.ts';
import { requireTask } from '#application/shared/input.ts';
import { plansShown, shownPlanBranch } from '#application/work/plans.ts';
import { startWaits } from '#application/capacity/queue.ts';

export interface TaskView {
  repo: string | null;
  waiting: Waiting | null;
  unblocks: TaskId[];
  links: LinkView[];
  dependents: { id: TaskId; kind: LinkKind }[];
  plan_unfinished: boolean;
  run_model: string | null;
  wait: StartWait | null;
  auto_merge_view: AutoMergeView | null;
  merge_request: MergeRequestView | null;
  conflicting: boolean;
  live: LiveView | null;
  sync: SyncView | null;
  checks: ChecksSummary | null;
  pr_retry: PrRetry | null;
  plan_landing: PlanLanding | null;
  issue: IssueLinkView | null;
  merges_into: MergesIntoView | null;
}

interface IssueLinkView {
  number: number;
  url: string;
  parent: { number: number; title: string } | null;
}

interface MergesIntoView {
  branch: string;
  plan: { task: TaskId; base: string; status: PlanBranchStatus; pr_url: string | null } | null;
}

type Viewed = Pick<Task, 'id' | 'repo_id' | 'status' | 'max_turns' | 'auto_merge' | 'source' | 'pr' | 'target'>;

export function withViews<T extends Viewed>(app: App, tasks: T[], links: LinkIndex = loadedLinks(app)): (T & TaskView)[] {
  const repos = new Map(app.listRepos().map((r) => [r.id, r]));
  const waitOf = startWaits(app);
  const unfinished = app.planUnfinishedIds();
  const runModels = app.latestRunModels();
  const liveRuns = app.liveRuns('work');
  const resolves = app.liveRuns('resolve');
  const issueRepos = new Set(tasks.filter((t) => t.source === 'issue').map((t) => t.repo_id));
  const issues = new Map([...issueRepos].flatMap((id) => app.issuesOfRepo(id)).map((l) => [l.task_id, l]));
  const planBranchAt = planBranchLookup(app);
  const now = Date.now();
  return tasks.map((t) => {
    const repo = repos.get(t.repo_id);
    const dependency = startState(t, links.linksOf(t.id), links.target);
    return {
      ...t,
      live: liveView(t, liveRuns.get(t.id)),
      sync: syncView(t, repo ? targetOf(t, repo) : null, isSyncLocked(t.id), resolves.get(t.id)),
      merge_request: mergeRequestView(t.pr, isMergeLocked(t.id)),
      checks: checksSummary(t.pr),
      conflicting: conflictsWithBase(t.pr),
      repo: repo?.name ?? null,
      auto_merge_view: repo ? autoMergeView(t, repo) : null,
      waiting: waitingFor(t, dependency),
      unblocks: unblocksOf(t, links),
      links: linkViews(t.id, links),
      dependents: dependentViews(t.id, links),
      plan_unfinished: unfinished.has(t.id),
      run_model: runModels.get(t.id) ?? null,
      wait: waitOf(t, dependency),
      pr_retry: prRetryView(app, t, repo, now),
      plan_landing: planLandingView(t, planBranchAt),
      issue: issueLinkView(issues.get(t.id)),
      merges_into: repo ? mergesIntoView(t, repo, planBranchAt) : null,
    };
  });
}

type PlanBranchLookup = (t: Viewed) => PlanBranch | undefined;

function planBranchLookup(app: App): PlanBranchLookup {
  const read = new Map<string, PlanBranch | undefined>();
  return (t) => {
    if (t.target === null) return undefined;
    const key = `${t.repo_id}:${t.target}`;
    if (!read.has(key)) read.set(key, app.planBranchNamed(t.repo_id, t.target));
    return read.get(key);
  };
}

function planLandingView(t: Viewed, planBranchAt: PlanBranchLookup): PlanLanding | null {
  if (t.target === null || t.pr?.state !== 'merged') return null;
  return planLandingOf(t, planBranchAt(t));
}

function prRetryView(app: App, t: Viewed, repo: Repo | undefined, now: number): PrRetry | null {
  if (t.status !== 'done' || t.pr?.state !== 'failed') return null;
  return prRetryFor(t, repo, app.eventsForTask(t.id), now);
}

function summaryOf(app: App, run: Run, task: Task, repo: Repo | undefined): RunSummary | null {
  if (run.outcome !== 'failed' && run.outcome !== 'blocked') return null;
  const events = app.runLog.events(run.log_path);
  if (!events.length) return null;
  return runSummary(events, { testCmd: repo?.test_cmd ?? null, maxTurns: task.max_turns });
}

export async function taskDetail(app: App, id: TaskId) {
  const task = requireTask(app, id);
  const repo = app.getRepo(task.repo_id);
  const [view] = withViews(app, [task], liveLinks(app));
  const branch = task.checkout?.branch;
  if (repo && task.status === 'done' && branch && !openPrUrl(task.pr) && task.pr?.state !== 'merged' && autoMergeOn(task, repo)) {
    const measured = await measureBranch(app, repo, task, branch);
    if (measured) view.auto_merge_view = autoMergeView(task, repo, measured);
  }
  return {
    ...view,
    check_list: task.pr?.checks.latest ? { read_at: task.pr.checks.latest.read_at, checks: task.pr.checks.latest.checks } : null,
    runs: app.runsForTask(id).map((run) => ({ ...run, summary: summaryOf(app, run, task, repo) })),
    events: app.eventsForTask(id),
    plans: plansShown(app, task),
    plan_branch: await planBranchView(app, task, repo),
  };
}

function issueLinkView(link: TaskIssue | undefined): IssueLinkView | null {
  if (!link) return null;
  const parent = link.parent_number === null ? null : { number: link.parent_number, title: link.parent_title ?? '' };
  return { number: link.number, url: link.url, parent };
}

function mergesIntoView(t: Viewed, repo: Repo, planBranchAt: PlanBranchLookup): MergesIntoView {
  const plan = planBranchAt(t);
  return {
    branch: targetOf(t, repo),
    plan: plan ? { task: plan.plan_task, base: plan.base, status: plan.status, pr_url: plan.pr_url } : null,
  };
}

async function planBranchView(app: App, task: Task, repo: Repo | undefined) {
  const branch = shownPlanBranch(app, task);
  if (!branch) return null;
  const counts = repo && isLivePlanBranch(branch) ? await app.workspace.aheadBehind(repo.path, branch.base, branch.name) : null;
  return { ...branch, ahead: counts?.ahead ?? null, behind: counts?.behind ?? null };
}

export function taskViews(app: App, filter: { status?: TaskStatus; limit: number; before?: TaskId }) {
  return withViews(app, app.listTaskSummaries(filter));
}
