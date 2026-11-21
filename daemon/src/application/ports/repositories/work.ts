// Work's repositories: tasks, their history, their links and their plans.
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import type { Draining } from '#domain/capacity/index.ts';
import type { AutoMergeCheck, CheckCounts, MergeRequestMove, StoredChecks } from '#domain/landing/index.ts';
import type { AttentionCandidate } from '#domain/operations/index.ts';
import type { MergeMethod } from '#domain/repos/index.ts';
import type {
  BlockedTask,
  Dependent,
  DomainEvent,
  LandingChange,
  LandingPolicy,
  Link,
  LinkKind,
  LinkedTask,
  Needs,
  OwnPlan,
  PendingFollowUp,
  PlanBranch,
  PlanBranchSyncOutcome,
  PlanFollower,
  PlanReviewMove,
  PlanSource,
  PrEvent,
  Task,
  TaskEvent,
  TaskEventRow,
  TaskIssue,
  IssueReport,
  TaskPlan,
  TaskSource,
  TaskStatus,
  TaskSummary,
  UnblockQuestion,
} from '#domain/work/index.ts';

export type TaskEdit = Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'model' | 'max_turns' | 'max_attempts' | 'target'>> & {
  plan_task?: TaskId | null;
  plan_steps?: string[] | null;
};

export interface NewTask {
  repo_id: RepoId;
  title: string;
  prompt: string;
  priority?: number;
  model: string;
  max_turns?: number;
  max_attempts?: number;
  status?: 'queued' | 'proposed';
  source?: TaskSource;
  issue?: { number: number; url: string };
  target?: string | null;
  links?: { on: TaskId; kind: LinkKind }[];
  plan_task?: TaskId | null;
  plan_steps?: string[] | null;
  own_plan?: string;
}

export interface TaskRepository {
  addTask(n: NewTask): Task;
  getTask(id: TaskId): Task | undefined;
  applyEvent: (
    id: TaskId,
    event: TaskEvent,
    opts?: { reason?: string | null; needs?: Needs | null; onlyFrom?: TaskStatus[] },
  ) => { task: Task; event: DomainEvent; pending: number[] } | undefined;
  listTasks(): Task[];
  tasksWithStatus(statuses: readonly TaskStatus[]): Task[];
  tasksForRepo(repo_id: RepoId, limit?: number): Task[];
  tasksOnTarget(repo_id: RepoId, target: string): Task[];
  countOpen(repo_id: RepoId): number;
  countRunning(): number;
  runningTasks(): { id: TaskId; title: string }[];
  countByStatus(): Record<string, number>;
  countQueuedByRepo(): Map<RepoId, number>;
  countRunningByRepo(): Map<RepoId, number>;
  countReview(): number;
  attentionTasks(limit: number): AttentionCandidate[];
  hasQueued(draining?: Draining): boolean;
  unblockCandidates(): BlockedTask[];
  reviewCandidates(): Task[];
  recordQuestion(id: TaskId, question: UnblockQuestion, reason: string): boolean;
  listTaskSummaries(opts: { status?: TaskStatus; limit: number; before?: TaskId }): TaskSummary[];
  openPrTasks(): Task[];
  failedPrTasks(): Task[];
  claimNextTask(draining?: Draining, overlapping?: ReadonlySet<TaskId>): Task | undefined;
  editTask(id: TaskId, fields: TaskEdit, opts?: { ownPlan?: string }): Task | undefined;
  attachOwnPlan(id: TaskId, html: string): TaskPlan | undefined;
  setCheckout(id: TaskId, fields: { branch?: string | null; worktree?: string | null }): void;
  setSyncing(id: TaskId, on: boolean): void;
  hasSyncMarker(id: TaskId): boolean;
  clearSyncMarkers(): void;
  setAutoMerge(id: TaskId, value: boolean | null): Task | undefined;
  setAutoMergeCheck(id: TaskId, check: AutoMergeCheck | null): boolean;
  requestMerge(id: TaskId, method: MergeMethod): boolean;
  clearMergeRequest(id: TaskId, move?: Exclude<MergeRequestMove, 'asked'>): boolean;
  setMergeRequestCheck(id: TaskId, check: AutoMergeCheck): boolean;
  recordPrChecksOpened(id: TaskId, checks: CheckCounts): boolean;
  setPrChecks(id: TaskId, checks: StoredChecks): boolean;
  recordPr(id: TaskId, e: PrEvent): boolean;
  recordMerge(id: TaskId, method: MergeMethod, reason: string, checks?: CheckCounts): boolean;
  recordSync(id: TaskId, reason: string): boolean;
  recordPlanUnfinished(id: TaskId, reason: string): boolean;
  changeModel(
    id: TaskId,
    change: { from: string; to: string },
    row: { type: 'escalate'; reason: string } | { type: 'edit' },
    statuses: TaskStatus[],
  ): boolean;
  changeMaxTurns(id: TaskId, to: number, statuses: TaskStatus[]): boolean;
  recoverOrphans(): { requeued: number; failed: TaskId[] };
}

export interface TaskEventRepository {
  eventsForTask(task_id: TaskId): TaskEventRow[];
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

export interface NewPlanBranch {
  plan_task: TaskId;
  repo_id: RepoId;
  name: string;
  base: string;
  landing_policy?: LandingPolicy;
}

export interface PlanBranchRepository {
  planBranchOf(plan_task: TaskId, repo_id: RepoId): PlanBranch | undefined;
  planBranchNamed(repo_id: RepoId, name: string): PlanBranch | undefined;
  openPlanBranch(branch: NewPlanBranch, retarget: TaskId[]): { opened: PlanBranch; targeted: TaskId[] };
  cutPlanBranch(id: number, head_commit: string): PlanBranch | undefined;
  syncedPlanBranches(): PlanBranch[];
  recordPlanBranchSync(
    branch: Pick<PlanBranch, 'id' | 'status'>,
    outcome: PlanBranchSyncOutcome,
    head_commit: string | null,
    ahead_lines?: number | null,
  ): PlanBranch | undefined;
  landingPlanBranches(): PlanBranch[];
  openPlanBranchPr(id: number, pr_url: string): PlanBranch | undefined;
  recordPlanReview(
    branch: Pick<PlanBranch, 'id' | 'pr_url'>,
    to: PlanReviewMove,
    read: { head: string | null; summary: string | null },
  ): PlanBranch | undefined;
  planBranchesOfPlan(plan_task: TaskId): PlanBranch[];
  setLandingPolicy(plan_task: TaskId, policy: LandingPolicy, order: { id: number; land_order: number | null }[]): PlanBranch[];
  recordLanding(id: number, change: LandingChange, landed?: { commit: string | null; from: string | null } | null): PlanBranch | undefined;
  answerLanding(branch: Pick<PlanBranch, 'id' | 'plan_task'>, to: 'retry' | 'by_hand'): PlanBranch | undefined;
  abandonPlanBranch(
    branch: Pick<PlanBranch, 'id' | 'repo_id' | 'name'>,
  ): { abandoned: PlanBranch; moved: TaskId[] } | { refused: string } | undefined;
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

export interface TaskIssueRepository {
  issueOf(id: TaskId): TaskIssue | undefined;
  issuesOfRepo(repo_id: RepoId): TaskIssue[];
  taskOfIssue(repo_id: RepoId, number: number): TaskId | undefined;
  reportIssue(id: TaskId, reported: IssueReport, at: string): void;
}
