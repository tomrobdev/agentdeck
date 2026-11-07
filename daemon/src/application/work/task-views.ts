// Tasks as the dashboard and the CLI show them: a task plus what the queue says about it.
import type { Db } from '../../db/index.ts';
import type { TaskId } from '../../domain/shared/id.ts';
import { type AutoMergeView, autoMergeOn, autoMergeView } from '../../domain/landing/auto-merge.ts';
import { type ChecksSummary, checksSummary } from '../../domain/landing/checks.ts';
import { type MergeRequestView, conflictsWithBase, mergeRequestView } from '../../domain/landing/merge-request.ts';
import { isMergeLocked, isSyncLocked } from './checkout-locks.ts';
import { type LiveView, type SyncView, liveView, syncView } from '../../domain/runs/translate/live.ts';
import { openPrUrl } from '../../domain/landing/pr.ts';
import type { StartWait, Waiting } from '../../domain/work/start.ts';
import { measureBranch } from './files.ts';
import type { TaskStatus } from '../../domain/work/lifecycle.ts';
import type { Task } from '../../domain/work/task.ts';
import { type LinkView, dependencyOf, dependentViews, linkViews, loadedLinks, unblocksOf, waitingFor } from './dependencies.ts';
import type { LinkIndex, LinkKind } from '../../domain/work/link.ts';
import { requireTask } from '../shared/input.ts';
import { plansShown } from './plans.ts';
import { startWaits } from '../capacity/queue.ts';

/** What the queue says about one task, beyond the task row. */
export interface TaskView {
  repo: string | null;
  waiting: Waiting | null;
  unblocks: TaskId[];
  links: LinkView[];
  dependents: { id: TaskId; kind: LinkKind }[];
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
type Viewed = Pick<Task, 'id' | 'repo_id' | 'status' | 'max_turns' | 'auto_merge' | 'source' | 'pr'>;

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
      wait: waitOf(t, dependency),
    };
  });
}

/** One task with its view, runs, events and plans. A branch with no open PR is measured against the auto-merge limits. */
export async function taskDetail(db: Db, id: TaskId) {
  const task = requireTask(db, id);
  const repo = db.getRepo(task.repo_id);
  const [view] = withViews(db, [task]);
  // Only a done task's branch is final; measuring a running one would start git on every refetch.
  const branch = task.checkout?.branch;
  if (repo && task.status === 'done' && branch && !openPrUrl(task.pr) && task.pr?.state !== 'merged' && autoMergeOn(task, repo)) {
    const measured = await measureBranch(repo, branch);
    if (measured) view.auto_merge_view = autoMergeView(task, repo, measured);
  }
  return {
    ...view,
    check_list: task.pr?.checks.latest ? { read_at: task.pr.checks.latest.read_at, checks: task.pr.checks.latest.checks } : null,
    runs: db.runsForTask(id),
    events: db.eventsForTask(id),
    plans: plansShown(db, task),
  };
}

/** Task summaries (no prompt), newest first, each with its view. The checks are summed up in `checks`, so their list stays out. */
export function taskViews(db: Db, filter: { status?: TaskStatus; limit: number; before?: TaskId }) {
  return withViews(db, db.listTaskSummaries(filter));
}
