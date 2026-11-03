// Tasks as the dashboard and the CLI show them: a task plus what the queue says about it.
import type { Db } from '../../db/index.ts';
import { type AutoMergeView, autoMergeOn, autoMergeView } from '../../domain/pull-request/auto-merge.ts';
import { type ChecksSummary, type PrCheck, checksSummary, readStoredChecks } from '../../domain/pull-request/checks.ts';
import { type MergeRequestView, conflictsWithBase, mergeRequestView } from '../../domain/pull-request/merge-request.ts';
import { isMergeLocked } from '../pull-request/merge.ts';
import { type LiveView, type SyncView, liveView, syncView } from '../../domain/run/live.ts';
import { isSyncLocked } from '../sync.ts';
import { hasOpenPr } from '../../domain/task/stage.ts';
import type { StartWait, Waiting } from '../../domain/task/start.ts';
import { measureBranch } from './files.ts';
import type { TaskStatus } from '../../domain/task/lifecycle.ts';
import type { Task } from '../../domain/task/task.ts';
import { type LinkView, dependencyOf, dependentViews, linkViews, loadedLinks, unblocksOf, waitingFor } from './dependencies.ts';
import type { LinkIndex, LinkKind } from '../../domain/task/link.ts';
import { requireTask } from '../input.ts';
import { plansShown } from '../plans.ts';
import { startWaits } from '../scheduler/queue.ts';

/** What the queue says about one task, beyond the task row. */
export interface TaskView {
  repo: string | null;
  waiting: Waiting | null;
  unblocks: number[];
  links: LinkView[];
  dependents: { id: number; kind: LinkKind }[];
  plan_unfinished: boolean;
  wait: StartWait | null;
  /** Whether the PR will merge on its own and why not, from the check the PR refresh stored. Null when the repo is gone. */
  auto_merge_view: AutoMergeView | null;
  /** The person's merge request: waiting for the PR to be ready, or merging it now. Null when there is none. */
  merge_request: MergeRequestView | null;
  /** Whether the open PR conflicts with the base branch, from the last PR check (the merge finding of kind `conflict`). */
  conflicting: boolean;
  /** For a running task: when its run started, turns so far and the last tool call. Null for any other task. */
  live: LiveView | null;
  /** For a done task: the sync under way (a clean one, or a resolve run settling conflicts). Null when none is. */
  sync: SyncView | null;
  /** The open PR's checks, counted, with the failing ones' names. Null when there is no open PR or it has no checks. */
  checks: ChecksSummary | null;
}

/** The task fields a view reads. */
type Viewed = Pick<
  Task,
  | 'id'
  | 'repo_id'
  | 'status'
  | 'max_turns'
  | 'pr_state'
  | 'auto_merge'
  | 'source'
  | 'auto_merge_check'
  | 'auto_merge_checked_at'
  | 'merge_requested_at'
  | 'merge_request_method'
  | 'merge_request_check'
  | 'pr_checks'
>;

/**
 * Each task with its view. Reads the repos, plans, links and queue state once for the whole list, so the queries it runs
 * don't grow with the tasks or their links. `links` is for a test to watch what is read.
 */
export function withViews<T extends Viewed>(db: Db, tasks: T[], links: LinkIndex = loadedLinks(db)): (T & TaskView)[] {
  const repos = new Map(db.listRepos().map((r) => [r.id, r]));
  const waitOf = startWaits(db);
  const unfinished = db.planUnfinishedIds();
  const liveRuns = db.liveRuns('work');
  const resolves = db.liveRuns('resolve');
  return tasks.map((t) => {
    const repo = repos.get(t.repo_id);
    const dependency = dependencyOf(t, links);
    return {
      ...t,
      live: liveView(t, liveRuns.get(t.id)),
      sync: syncView(t, repo?.base_branch ?? null, isSyncLocked(t.id), resolves.get(t.id)),
      merge_request: mergeRequestView(t, isMergeLocked(t.id)),
      checks: checksSummary(t),
      conflicting: conflictsWithBase(t),
      repo: repo?.name ?? null,
      auto_merge_view: repo ? autoMergeView(t, repo) : null,
      waiting: waitingFor(t, dependency),
      unblocks: unblocksOf(t, links),
      links: linkViews(t.id, links),
      dependents: dependentViews(t.id, links),
      plan_unfinished: unfinished.has(t.id),
      wait: waitOf(t, dependency),
    };
  });
}

/** One task with its view, runs, events and plans. A branch with no open PR is measured against the auto-merge limits. */
export async function taskDetail(db: Db, id: number) {
  const task = requireTask(db, id);
  const repo = db.getRepo(task.repo_id);
  const [view] = withViews(db, [task]);
  // Only a done task's branch is final; measuring a running one would start git on every refetch.
  if (repo && task.status === 'done' && task.branch && !hasOpenPr(task) && task.pr_state !== 'merged' && autoMergeOn(task, repo)) {
    const measured = await measureBranch(repo, task.branch);
    if (measured) view.auto_merge_view = autoMergeView(task, repo, measured);
  }
  return {
    ...view,
    check_list: checkList(task.pr_checks),
    runs: db.runsForTask(id),
    events: db.eventsForTask(id),
    plans: plansShown(db, task),
  };
}

/** The PR's latest checks, one by one, and when they were read; null when none were read. */
function checkList(json: string | null): { read_at: string; checks: PrCheck[] } | null {
  const stored = readStoredChecks(json);
  return stored && { read_at: stored.read_at, checks: stored.checks };
}

/** Task summaries (no prompt), newest first, each with its view. The checks are summed up in `checks`, so their list stays out. */
export function taskViews(db: Db, filter: { status?: TaskStatus; limit: number; before?: number }) {
  return withViews(db, db.listTaskSummaries(filter)).map(({ pr_checks: _pr_checks, ...t }) => t);
}
