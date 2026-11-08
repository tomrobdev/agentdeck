// The repositories the use cases reach the database through: interfaces application/ owns, in domain types. db/
// implements them (`openDb` returns something that satisfies `Repositories`). An interface lists what use cases call
// and no more (test/repositories-used.test.ts); the rest of what the database offers stays on db/'s own `Db`.
import type { PlannerRunId, RepoId, ReviewId, TaskId } from '../../domain/shared/index.ts';
import type { Budget } from '../../domain/capacity/index.ts';
import type { ScorecardEvent, ScorecardTaskRow, StatRun } from '../../domain/insights/index.ts';
import type {
  AutoMergeCheck,
  CheckCounts,
  CommentState,
  Review,
  ReviewComment,
  ReviewKind,
  ReviewWithComments,
  ReviewedDiff,
  StoredChecks,
} from '../../domain/landing/index.ts';
import type { AttentionCandidate, Notification, NotifySettings, ReviewDue, Settings } from '../../domain/operations/index.ts';
import type { PlannerOutcome, PlannerRun, PlannerSettings } from '../../domain/proposals/index.ts';
import type { MergeMethod, Repo } from '../../domain/repos/index.ts';
import type { PidRun, Run, RunKind, RunningTaskRun } from '../../domain/runs/index.ts';
import type {
  BlockedTask,
  Dependent,
  DomainEvent,
  Link,
  LinkKind,
  LinkedTask,
  Needs,
  OwnPlan,
  PendingFollowUp,
  PlanFollower,
  PlanSource,
  PrEvent,
  Task,
  TaskEvent,
  TaskEventRow,
  TaskPlan,
  TaskStatus,
  TaskSummary,
  UnblockQuestion,
} from '../../domain/work/index.ts';

/** The fields of a task a person may change while it is editable. */
export type TaskEdit = Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'model' | 'max_turns' | 'max_attempts'>> & {
  plan_task?: TaskId | null;
  plan_steps?: string[] | null;
};

/** A task to add. */
export interface NewTask {
  repo_id: RepoId;
  title: string;
  prompt: string;
  priority?: number;
  /** Decided by the caller (`newTaskModel`): the store has no default of its own. */
  model: string;
  max_turns?: number;
  max_attempts?: number;
  status?: 'queued' | 'proposed';
  source?: 'manual' | 'planner';
  /** Links the task starts with; the caller has checked them (a new task can't make a cycle). */
  links?: { on: TaskId; kind: LinkKind }[];
  /** The task whose plan this one follows. */
  plan_task?: TaskId | null;
  plan_steps?: string[] | null;
  /** A plan for the new task to own and follow (the caller has parsed it): stored under its numbered name, and linked. */
  own_plan?: string;
}

/** A repo to register. */
export interface NewRepo {
  name: string;
  path: string;
  base_branch: string;
  test_cmd?: string | null;
  allowed_tools?: string[] | null;
  toolchain?: string | null;
  setup_cmd?: string | null;
}

/** The repo fields that can be updated. */
export type RepoUpdate = Partial<
  Pick<
    Repo,
    | 'auto_approve'
    | 'test_cmd'
    | 'setup_cmd'
    | 'proposed_at'
    | 'base_branch'
    | 'pr_mode'
    | 'merge_method'
    | 'auto_resolve'
    | 'auto_unblock'
    | 'auto_review'
    | 'sandbox'
    | 'network'
    | 'auto_merge'
    | 'auto_merge_max_lines'
    | 'auto_merge_skip'
    | 'model'
    | 'allowed_tools'
  >
>;

export interface TaskRepository {
  addTask(n: NewTask): Task;
  getTask(id: TaskId): Task | undefined;
  /**
   * A status change: the task as it is after, its domain events, and the ids of their history rows written pending (those
   * with follow-ups). Only application/landing/settle.ts calls it.
   */
  applyEvent: (
    id: TaskId,
    event: TaskEvent,
    opts?: { reason?: string | null; needs?: Needs | null; onlyFrom?: TaskStatus[] },
  ) => { task: Task; event: DomainEvent; pending: number[] } | undefined;
  listTasks(): Task[];
  tasksForRepo(repo_id: RepoId, limit?: number): Task[];
  countOpen(repo_id: RepoId): number;
  countRunning(): number;
  runningTasks(): { id: TaskId; title: string }[];
  countByStatus(): Record<string, number>;
  countQueuedByRepo(): Map<RepoId, number>;
  countReview(): number;
  attentionTasks(limit: number): AttentionCandidate[];
  hasQueued(): boolean;
  unblockCandidates(): BlockedTask[];
  reviewCandidates(): Task[];
  recordQuestion(id: TaskId, question: UnblockQuestion, reason: string): boolean;
  listTaskSummaries(opts: { status?: TaskStatus; limit: number; before?: TaskId }): TaskSummary[];
  openPrTasks(): Task[];
  failedPrTasks(): Task[];
  claimNextTask(): Task | undefined;
  editTask(id: TaskId, fields: TaskEdit, opts?: { ownPlan?: string }): Task | undefined;
  attachOwnPlan(id: TaskId, html: string): TaskPlan | undefined;
  setCheckout(id: TaskId, fields: { branch?: string | null; worktree?: string | null }): void;
  setSyncing(id: TaskId, on: boolean): void;
  hasSyncMarker(id: TaskId): boolean;
  setAutoMerge(id: TaskId, value: boolean | null): Task | undefined;
  setAutoMergeCheck(id: TaskId, check: AutoMergeCheck | null): boolean;
  requestMerge(id: TaskId, method: MergeMethod): boolean;
  clearMergeRequest(id: TaskId): boolean;
  setMergeRequestCheck(id: TaskId, check: AutoMergeCheck): boolean;
  recordPrChecksOpened(id: TaskId, checks: CheckCounts): boolean;
  setPrChecks(id: TaskId, checks: StoredChecks): boolean;
  recordPr(id: TaskId, e: PrEvent): boolean;
  recordMerge(id: TaskId, method: MergeMethod, reason: string, checks?: CheckCounts): boolean;
  recordSync(id: TaskId, reason: string): boolean;
  recordPlanUnfinished(id: TaskId, reason: string): boolean;
  recoverOrphans(): { requeued: number; failed: TaskId[] };
}

export interface TaskEventRepository {
  eventsForTask(task_id: TaskId): TaskEventRow[];
  /** The outbox: history rows whose follow-ups are still to run, oldest first. */
  pendingFollowUps(): PendingFollowUp[];
  markFollowedUp(ids: number[]): void;
  lastEventId(): number;
  eventsAfter(after: number, upTo: number, repo_id: RepoId): (TaskEventRow & { title: string })[];
  planUnfinishedIds(): Set<number>;
}

export interface TaskLinkRepository {
  linksOf(id: TaskId): Link[];
  allLinks(): Link[];
  dependentsOf(id: TaskId, kind?: LinkKind): Dependent[];
  linkedTasks(): LinkedTask[];
  addLink(link: Link): void;
  removeLink(task_id: TaskId, on: TaskId): boolean;
}

export interface PlanRepository {
  ownPlan(task_id: TaskId): OwnPlan | undefined;
  saveOwnPlan(task_id: TaskId, html: string, source: PlanSource): TaskPlan;
  updatePlanHtml(id: number, html: string): void;
  planShared(task_id: TaskId): boolean;
  planFollowers(task_id: TaskId): PlanFollower[];
  plansForTask(task_id: TaskId): TaskPlan[];
  planHtml(task_id: TaskId, id: number): string | undefined;
}

export interface RepoRepository {
  addRepo(r: NewRepo): Repo;
  getRepo(id: RepoId): Repo | undefined;
  findRepo(nameOrId: string): Repo | undefined;
  listRepos(opts?: { archived?: boolean }): Repo[];
  setRepoArchived(id: RepoId, archived: boolean): void;
  repoHasRunning(id: RepoId): boolean;
  repoFootprint(id: RepoId): {
    tasks: { id: TaskId; branch: string | null; worktree: string | null }[];
    run_logs: string[];
    planner_logs: string[];
  };
  deleteRepo(id: RepoId): boolean;
  updateRepo(id: RepoId, fields: RepoUpdate): void;
  setRepoPaused(id: RepoId, reason: string | null): void;
  pauseRepo(id: RepoId, reason: string): boolean;
}

export interface RunRepository {
  startRun(task_id: TaskId, attempt: number, log_path: string, kind?: RunKind, model?: string | null, diff_hash?: string | null): Run['id'];
  setRunModelId(id: Run['id'], model_id: string): void;
  setRunPid(id: Run['id'], pid: number): void;
  setRunLive(id: Run['id'], live_turns: number, live_tool: string | null): void;
  setRunSession(id: Run['id'], session_id: string): void;
  liveRuns(kind: RunKind): Map<TaskId, { started_at: string; live_turns: number; live_tool: string | null }>;
  finishRun(id: Run['id'], r: Partial<Omit<Run, 'id' | 'task_id' | 'kind' | 'attempt' | 'started_at' | 'log_path' | 'model'>>): void;
  runsForTask(task_id: TaskId): Run[];
  countRunningResolves(): number;
  countRunningUnblocks(): number;
  countRunningReviews(): number;
  slotsUsed(): number;
  pidRuns(days: number): PidRun[];
  runningTaskRuns(): RunningTaskRun[];
  unfinishedPids(): { pid: number; pid_at: string }[];
}

export interface PlannerRunRepository {
  startPlannerRun(repo_id: RepoId, log_path: string): PlannerRunId;
  setPlannerRunPid(id: PlannerRunId, pid: number): void;
  finishPlannerRun(id: PlannerRunId, outcome: PlannerOutcome, proposed: number, note: string | null): void;
  countRunningPlannerRuns(): number;
  unfinishedPlannerRuns(): { id: PlannerRunId; repo_id: RepoId; repo: string; started_at: string }[];
  plannerRuns(repo_id?: RepoId, limit?: number): PlannerRun[];
}

export interface ReviewRepository {
  createReview(task_id: TaskId): Review;
  draftReviewFor(task_id: TaskId): Review | undefined;
  addRunReview(task_id: TaskId, kind: ReviewKind, body: string, read: { head_commit: string; diff_hash: string }): Review;
  reviewsForTask(task_id: TaskId): ReviewWithComments[];
  reviewWithComments(id: ReviewId): ReviewWithComments | undefined;
  setReviewBody(id: ReviewId, body: string): boolean;
  submitReview(id: ReviewId, kind: ReviewKind, body: string, read: ReviewedDiff): boolean;
  getComment(id: number): ReviewComment | undefined;
  addComment(c: Pick<ReviewComment, 'review_id' | 'path' | 'line' | 'side' | 'head_commit' | 'body'>): ReviewComment;
  deleteComment(id: number): boolean;
  moveComment(id: number, from: CommentState[], to: CommentState, answer?: string): boolean;
}

export interface StatsRepository {
  statRuns(repo_id?: RepoId): StatRun[];
  scorecardTasks(repo_id?: RepoId): ScorecardTaskRow[];
  scorecardEvents(repo_id?: RepoId): ScorecardEvent[];
}

export interface NotificationRepository {
  addNotification(kind: string, title: string, body: string, task_id: TaskId | null): void;
  recentNotifications(limit?: number): {
    id: number;
    kind: Notification['kind'];
    title: string;
    body: string;
    task_id: TaskId | null;
    created_at: string;
  }[];
}

export interface UsageRepository {
  recordUsageWindow(window: string, utilization: number, resets_at: number, status: string | null): void;
  usageWindows(): { window: string; utilization: number; resets_at: number; status: string | null; observed_at: string }[];
  usageSamples(window?: string): { window: string; utilization: number; resets_at: number; observed_at: string }[];
}

export interface SettingsRepository {
  readSettings(): Settings;
  writeSettings(s: Settings): void;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  /** Unix seconds until which claude is rate limited, or null when it is not (or has lifted). */
  rateLimitedUntil(): number | null;
  setRateLimitedUntil(until: number): void;
  reloadOnChange(): boolean;
  prCheckRequested(): number;
  requestPrCheck(at?: number): void;
  appSeenAt(): number | null;
  setAppSeenAt(at: number): void;
  budget(): Budget;
  maxConcurrent(): number;
  notifySettings(): NotifySettings;
  plannerSettings(): PlannerSettings;
  /** The default_model, support_model and review_model settings. */
  modelSettings(): Pick<Settings, 'default_model' | 'support_model' | 'review_model'>;
  /** The repos due for an area review, as the daemon's last check found them, for the headline. */
  reviewsDue(): ReviewDue[];
  setReviewsDue(dues: ReviewDue[]): void;
  /** When a person was last told the repo is due for an area review (ms since the epoch); null when never. */
  reviewDueToldAt(repo: RepoId): number | null;
  setReviewDueToldAt(repo: RepoId, at: number): void;
}

export interface ChangeRepository {
  changeCounters(): { dataVersion: number; ownChanges: number };
}

/** Everything the use cases read and write, one object. */
export type Repositories = TaskRepository &
  TaskEventRepository &
  TaskLinkRepository &
  PlanRepository &
  RepoRepository &
  RunRepository &
  PlannerRunRepository &
  ReviewRepository &
  StatsRepository &
  NotificationRepository &
  UsageRepository &
  SettingsRepository &
  ChangeRepository;
