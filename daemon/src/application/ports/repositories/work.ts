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
} from '#domain/work/index.ts';

export type TaskEdit = Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'model' | 'max_turns' | 'max_attempts'>> & {
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
  source?: 'manual' | 'planner';
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
  tasksForRepo(repo_id: RepoId, limit?: number): Task[];
  countOpen(repo_id: RepoId): number;
  countRunning(): number;
  runningTasks(): { id: TaskId; title: string }[];
  countByStatus(): Record<string, number>;
  countQueuedByRepo(): Map<RepoId, number>;
  countReview(): number;
  attentionTasks(limit: number): AttentionCandidate[];
  hasQueued(draining?: Draining): boolean;
  unblockCandidates(): BlockedTask[];
  reviewCandidates(): Task[];
  recordQuestion(id: TaskId, question: UnblockQuestion, reason: string): boolean;
  listTaskSummaries(opts: { status?: TaskStatus; limit: number; before?: TaskId }): TaskSummary[];
  openPrTasks(): Task[];
  failedPrTasks(): Task[];
  claimNextTask(draining?: Draining): Task | undefined;
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

export interface PlanRepository {
  ownPlan(task_id: TaskId): OwnPlan | undefined;
  saveOwnPlan(task_id: TaskId, html: string, source: PlanSource): TaskPlan;
  updatePlanHtml(id: number, html: string): void;
  planShared(task_id: TaskId): boolean;
  planFollowers(task_id: TaskId): PlanFollower[];
  plansForTask(task_id: TaskId): TaskPlan[];
  planHtml(task_id: TaskId, id: number): string | undefined;
}
