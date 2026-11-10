// Tasks as the dashboard and the CLI show them: a task plus what the queue says about it.
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { type AutoMergeView, autoMergeOn, autoMergeView } from '../../domain/landing/index.ts';
import { type ChecksSummary, checksSummary } from '../../domain/landing/index.ts';
import { type MergeRequestView, conflictsWithBase, mergeRequestView } from '../../domain/landing/index.ts';
import { isMergeLocked, isSyncLocked } from './checkout-locks.ts';
import { type LiveView, type SyncView, liveView, syncView } from '../../domain/runs/index.ts';
import { type Run, type RunSummary, runSummary } from '../../domain/runs/index.ts';
import { type PrRetry, openPrUrl } from '../../domain/landing/index.ts';
import { prRetryFor } from '../../domain/work/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import type { StartWait, Waiting } from '../../domain/work/index.ts';
import { measureBranch } from './files.ts';
import type { TaskStatus } from '../../domain/work/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { liveLinks, loadedLinks } from './dependencies.ts';
import { type LinkView, dependentViews, linkViews, startState, unblocksOf, waitingFor } from '../../domain/work/index.ts';
import type { LinkIndex, LinkKind } from '../../domain/work/index.ts';
import { requireTask } from '../shared/input.ts';
import { plansShown } from './plans.ts';
import { startWaits } from '../capacity/queue.ts';

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
}

type Viewed = Pick<Task, 'id' | 'repo_id' | 'status' | 'max_turns' | 'auto_merge' | 'source' | 'pr'>;

export function withViews<T extends Viewed>(app: App, tasks: T[], links: LinkIndex = loadedLinks(app)): (T & TaskView)[] {
  const repos = new Map(app.listRepos().map((r) => [r.id, r]));
  const waitOf = startWaits(app);
  const unfinished = app.planUnfinishedIds();
  const runModels = app.latestRunModels();
  const liveRuns = app.liveRuns('work');
  const resolves = app.liveRuns('resolve');
  const now = Date.now();
  return tasks.map((t) => {
    const repo = repos.get(t.repo_id);
    const dependency = startState(t, links.linksOf(t.id), links.target);
    return {
      ...t,
      live: liveView(t, liveRuns.get(t.id)),
      sync: syncView(t, repo?.base_branch ?? null, isSyncLocked(t.id), resolves.get(t.id)),
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
    };
  });
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
    const measured = await measureBranch(app, repo, branch);
    if (measured) view.auto_merge_view = autoMergeView(task, repo, measured);
  }
  return {
    ...view,
    check_list: task.pr?.checks.latest ? { read_at: task.pr.checks.latest.read_at, checks: task.pr.checks.latest.checks } : null,
    runs: app.runsForTask(id).map((run) => ({ ...run, summary: summaryOf(app, run, task, repo) })),
    events: app.eventsForTask(id),
    plans: plansShown(app, task),
  };
}

export function taskViews(app: App, filter: { status?: TaskStatus; limit: number; before?: TaskId }) {
  return withViews(app, app.listTaskSummaries(filter));
}
