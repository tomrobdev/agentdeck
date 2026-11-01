// Tasks as the dashboard and the CLI show them: a task plus what the queue says about it.
import type { Db } from '../../db/index.ts';
import { type AutoMergeMeasured, type AutoMergeView, autoMergeOn, autoMergeView } from '../../domain/pull-request/auto-merge.ts';
import { type MergeRequestView, mergeRequestView } from '../../domain/pull-request/merge-request.ts';
import { isMergeLocked } from '../pull-request/pull-requests.ts';
import { type LiveView, type SyncView, liveView, syncView } from '../../domain/run/live.ts';
import { isSyncLocked } from '../sync.ts';
import { hasOpenPr } from '../../domain/task/stage.ts';
import type { StartWait } from '../../domain/task/start.ts';
import { measureBranch } from './files.ts';
import type { TaskStatus } from '../../domain/task/lifecycle.ts';
import type { Task } from '../../domain/task/task.ts';
import { type LinkView, type Waiting, dependentViews, linkViews, unblocksOf, waitingFor } from './dependencies.ts';
import type { LinkKind } from '../../domain/task/link.ts';
import { requireTask } from '../input.ts';
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
  /** For a running task: when its run started, turns so far and the last tool call. Null for any other task. */
  live: LiveView | null;
  /** For a done task: the sync under way (a clean one, or a resolve run settling conflicts). Null when none is. */
  sync: SyncView | null;
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
>;

/**
 * Each task with its view. Reads the repos, plans and queue state once for the whole list. `measured` holds, by task id,
 * how a branch with no open PR measures against the auto-merge limits (see `measureBranches`).
 */
export function withViews<T extends Viewed>(db: Db, tasks: T[], measured: Map<number, AutoMergeMeasured> = new Map()): (T & TaskView)[] {
  const repos = new Map(db.listRepos().map((r) => [r.id, r]));
  const waitOf = startWaits(db);
  const unfinished = db.planUnfinishedIds();
  const liveRuns = db.liveRuns();
  const resolves = db.liveResolves();
  return tasks.map((t) => ({
    ...t,
    live: liveView(t, liveRuns.get(t.id)),
    sync: syncView(t, repos.get(t.repo_id)?.base_branch ?? null, isSyncLocked(t.id), resolves.get(t.id)),
    merge_request: mergeRequestView(t, isMergeLocked(t.id)),
    repo: repos.get(t.repo_id)?.name ?? null,
    auto_merge_view: repos.has(t.repo_id) ? autoMergeView(t, repos.get(t.repo_id)!, measured.get(t.id)) : null,
    waiting: waitingFor(db, t),
    unblocks: unblocksOf(db, t),
    links: linkViews(db, t.id),
    dependents: dependentViews(db, t.id),
    plan_unfinished: unfinished.has(t.id),
    wait: waitOf(t),
  }));
}

/** One task with its view, runs, events and plans. A branch with no open PR is measured against the auto-merge limits. */
export async function taskDetail(db: Db, id: number) {
  const task = requireTask(db, id);
  const repo = db.getRepo(task.repo_id);
  const measured = new Map<number, AutoMergeMeasured>();
  if (repo && task.branch && !hasOpenPr(task) && task.pr_state !== 'merged' && autoMergeOn(task, repo)) {
    const m = await measureBranch(repo, task.branch);
    if (m) measured.set(id, m);
  }
  return {
    ...withViews(db, [task], measured)[0],
    runs: db.runsForTask(id),
    events: db.eventsForTask(id),
    plans: db.plansForTask(id),
  };
}

/** Task summaries (no prompt), newest first, each with its view. */
export function taskViews(db: Db, filter: { status?: TaskStatus; limit: number; before?: number }) {
  return withViews(db, db.listTaskSummaries(filter));
}
