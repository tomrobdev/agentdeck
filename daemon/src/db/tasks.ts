// Tasks. Every status change goes through applyEvent, the claim included, guarded by the current status.
import { type SQL, and, asc, count, desc, eq, exists, inArray, isNotNull, isNull, lt, ne, not, notExists, or, sql } from 'drizzle-orm';
import { type AnySQLiteColumn, alias } from 'drizzle-orm/sqlite-core';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '../config.ts';
import { type RepoId, type TaskId, asTaskId, stored } from '../domain/shared/index.ts';
import type { AutoMergeCheck } from '../domain/landing/index.ts';
import type { StoredChecks } from '../domain/landing/index.ts';
import type { CheckCounts } from '../domain/landing/index.ts';
import {
  type TaskChanges,
  autoMergeCheckChanges,
  autoMergeSettingChanges,
  mergedPrChanges,
  mergeRequestChanges,
  mergeRequestCheckChanges,
  noMergeRequestChanges,
  prChanges,
  prChecksChanges,
  prChecksOpenedChanges,
  questionChanges,
} from '../domain/work/index.ts';
import type { MergeMethod } from '../domain/repos/index.ts';
import { INTERRUPTED, type RunOutcome } from '../domain/runs/index.ts';
import {
  DEFAULT_MODEL,
  type DomainEvent,
  type TaskEvent,
  type TaskStatus,
  followUpsOf,
  fromStatuses,
  transition,
} from '../domain/work/index.ts';
import type { LinkKind } from '../domain/work/index.ts';
import { type PrEvent, prEventReason } from '../domain/work/index.ts';
import type { TaskPlan } from '../domain/work/index.ts';
import {
  type BlockedTask,
  EDITABLE_STATUSES,
  OPEN_STATUSES,
  PLAN_ATTACHABLE_STATUSES,
  RUNNING_STATUSES,
  type Task,
  type TaskSummary,
  isBlocked,
} from '../domain/work/index.ts';
import type { AttentionCandidate, AttentionWhy } from '../domain/operations/index.ts';
import type { Needs, UnblockQuestion } from '../domain/work/index.ts';
import { SUMMARY_COLUMNS, TASK_COLUMNS, mapFound, stateColumns, toTask, toTaskSummary } from './mappers.ts';
import type { Orm } from './orm.ts';
import { insertOwnPlan, saveOwnPlan } from './plans.ts';
import { NOW_SQL, atomically, changed, inActiveRepo as inActiveRepoOf } from './sql.ts';
import { plannerRuns, repos, runs, taskLinks, tasks } from './tables.ts';
import { recordEvent } from './task-events.ts';
import { insertLinks } from './task-links.ts';

/** A task whose PR is open. */
const prOpen = eq(tasks.pr_state, 'open');
/** A task whose PR is open and which is done: in review. Writes to a PR's checks and requests only apply to such a task. */
const inReview = and(eq(tasks.status, 'done'), prOpen);

/** A domain write's changes as columns: the documents as JSON, and `'now'` as the database's clock. */
const columns = (changes: TaskChanges) => {
  const { auto_merge_checked_at, merge_requested_at, ...rest } = changes;
  return {
    ...stored(rest),
    ...(auto_merge_checked_at === undefined ? {} : { auto_merge_checked_at: auto_merge_checked_at === 'now' ? NOW_SQL : null }),
    ...(merge_requested_at === undefined ? {} : { merge_requested_at: merge_requested_at === 'now' ? NOW_SQL : null }),
  };
};

/**
 * The task's PR state is still the one `task` was read with: a PR the task has no value for (`pullRequestOf`) has no state,
 * or no url and a state other than failed.
 */
const prStateAsRead = (task: Task): SQL | undefined =>
  task.pr ? eq(tasks.pr_state, task.pr.state) : or(isNull(tasks.pr_state), and(isNull(tasks.pr_url), ne(tasks.pr_state, 'failed')));

/** The task row `t` in the claim and queue queries, which `notWaiting` refers to. */
const t = alias(tasks, 't');
/** A builds-on link of `t`, the task `d` it builds on, and `d`'s repo `r`: what `notWaiting` looks through. */
const buildsOn = alias(taskLinks, 'l');
const dep = alias(tasks, 'd');
const depRepo = alias(repos, 'r');

/** Unset fields are left alone by Drizzle; these writes have always stored a given-as-undefined field as NULL. */
const given = <T extends object>(fields: T) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v ?? null])) as { [K in keyof T]-?: Exclude<T[K], undefined> };

export function taskStore(db: DatabaseSync, orm: Orm) {
  const inActiveRepo = (col: AnySQLiteColumn) => inActiveRepoOf(orm, col);
  /** The repo id column `col` belongs to a repo work may start in: not paused and not archived. */
  const inOpenRepo = (col: AnySQLiteColumn) =>
    inArray(
      col,
      orm
        .select({ id: repos.id })
        .from(repos)
        .where(and(isNull(repos.paused_reason), isNull(repos.archived_at))),
    );
  /**
   * The task row `t` is free to start: every task it builds on is met, that is done, and merged unless its repo has pr_mode off.
   * A done task with no PR state (none opened yet, or an earlier one set aside by a retry) counts as met only in a repo with
   * pr_mode off. A task a person marked done counts as met unless its PR is open. After links never stop a start.
   * Mirrors startState and domain/work/link.ts.
   */
  const notWaiting = () => {
    const met = and(
      eq(dep.status, 'done'),
      or(
        eq(dep.pr_state, 'merged'),
        and(
          isNull(dep.pr_state),
          exists(
            orm
              .select({ id: depRepo.id })
              .from(depRepo)
              .where(and(eq(depRepo.id, dep.repo_id), eq(depRepo.pr_mode, 'off'))),
          ),
        ),
        and(eq(dep.done_by, 'person'), or(isNull(dep.pr_state), ne(dep.pr_state, 'open'))),
      ),
    );
    const unmet = orm
      .select({ id: dep.id })
      .from(dep)
      .where(and(eq(dep.id, buildsOn.on_task), met));
    return notExists(
      orm
        .select({ task_id: buildsOn.task_id })
        .from(buildsOn)
        .where(and(eq(buildsOn.task_id, t.id), eq(buildsOn.kind, 'builds_on'), notExists(unmet))),
    );
  };
  /** The task row `t` has no unblock run going: a person's retry during one waits for it to stop before a claim. */
  const notUnblocking = () =>
    notExists(
      orm
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.task_id, t.id), eq(runs.kind, 'unblock'), isNull(runs.ended_at))),
    );
  /**
   * The task row `t` may be claimed: in a status a claim is allowed from (queued), not waiting on a task it builds on, with no
   * unblock run going, in a repo work may start in. The one definition, for the claim and `hasQueued`; mirrors `startWait`
   * in domain/work/start.ts, but for the slots, which the scheduler counts.
   */
  const claimable = () => and(inArray(t.status, fromStatuses({ type: 'claim' })), notWaiting(), notUnblocking(), inOpenRepo(t.repo_id));
  const countWhere = (where: SQL | undefined) => orm.select({ n: count() }).from(tasks).where(where).get()?.n ?? 0;

  const getTask = (id: TaskId): Task | undefined => mapFound(orm.select(TASK_COLUMNS).from(tasks).where(eq(tasks.id, id)).get(), toTask);

  /**
   * Touch a task that is in one of `statuses` and record a history row of `type` for it, which leaves the status as it is.
   * Returns false if the task is missing or in another status.
   */
  const noteEvent = (id: TaskId, statuses: TaskStatus[], type: 'sync' | 'plan_unfinished', reason: string): boolean =>
    atomically(db, () => {
      const row = orm
        .update(tasks)
        .set({ updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), inArray(tasks.status, statuses)))
        .returning({ status: tasks.status })
        .get() as { status: TaskStatus } | undefined;
      if (!row) return false;
      recordEvent(orm, id, type, row.status, row.status, reason);
      return true;
    });

  /**
   * The only way to change a task's status. Asks the lifecycle whether `event` is allowed from the
   * task's current status and writes the result guarded by that status, so a concurrent change
   * (say, a cancel arriving as a run finishes) is never overwritten. Returns the updated task, or
   * undefined if the task is missing or the event isn't allowed. `onlyFrom` narrows it further: the write also
   * requires the task to be in one of those statuses, so a caller that checked a status before a long wait
   * does not undo a change made meanwhile.
   */
  const applyEvent = (
    id: TaskId,
    event: TaskEvent,
    opts: { reason?: string | null; needs?: Needs | null; onlyFrom?: TaskStatus[] } = {},
  ): { task: Task; events: DomainEvent[]; pending: number[] } | undefined => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = getTask(id);
      if (!cur) return undefined;
      if (opts.onlyFrom && !opts.onlyFrom.includes(cur.status)) return undefined;
      const next = transition(cur, event, opts);
      if (!next) return undefined;
      const pending: number[] = [];
      const task = atomically(db, () => {
        // Guarded on the status, the counters and the PR state the changes were computed from.
        const row = mapFound(
          orm
            .update(tasks)
            .set({
              status: next.state.status,
              ...stateColumns(next.state),
              ...next.counters,
              ...columns(next.changes),
              updated_at: NOW_SQL,
            })
            .where(
              and(
                eq(tasks.id, id),
                eq(tasks.status, cur.status),
                eq(tasks.attempts, cur.attempts),
                eq(tasks.max_attempts, cur.max_attempts),
                eq(tasks.restarts, cur.restarts),
                prStateAsRead(cur),
              ),
            )
            .returning(TASK_COLUMNS)
            .get(),
          toTask,
        );
        // An event with follow-ups is written pending, in the same transaction as the change: the outbox.
        if (row)
          for (const e of next.events) {
            const followUp = followUpsOf([e]).length > 0;
            const eventId = recordEvent(orm, e.task_id, e.history, e.from, e.to, e.reason, followUp);
            if (followUp) pending.push(eventId);
          }
        return row;
      });
      if (task) return { task, events: next.events, pending };
    }
    return undefined;
  };

  return {
    addTask(n: {
      repo_id: RepoId;
      title: string;
      prompt: string;
      priority?: number;
      /**
       * Required on the port (`NewTask`), so every use case decides it with `newTaskModel`; only a direct store call (a test)
       * leaves it out and gets the default_model setting's default.
       */
      model?: string;
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
    }): Task {
      const status = n.status ?? 'queued';
      const id = atomically(db, () => {
        const info = orm
          .insert(tasks)
          .values({
            repo_id: n.repo_id,
            title: n.title,
            prompt: n.prompt,
            priority: n.priority ?? 0,
            model: n.model ?? DEFAULT_MODEL,
            max_turns: n.max_turns ?? DEFAULTS.maxTurns,
            max_attempts: n.max_attempts ?? DEFAULTS.maxAttempts,
            status,
            source: n.source ?? 'manual',
            plan_task: n.plan_task ?? null,
            plan_steps: stored({ plan_steps: n.plan_steps ?? null }).plan_steps,
          })
          .run();
        const id = asTaskId(Number(info.lastInsertRowid));
        if (n.own_plan !== undefined) {
          insertOwnPlan(orm, id, n.own_plan, 'attached');
          orm.update(tasks).set({ plan_task: id }).where(eq(tasks.id, id)).run();
        }
        insertLinks(orm, id, n.links ?? []);
        recordEvent(orm, id, 'created', null, status);
        return id;
      });
      return getTask(id)!;
    },
    getTask,
    applyEvent,
    listTasks(): Task[] {
      return orm.select(TASK_COLUMNS).from(tasks).where(inActiveRepo(tasks.repo_id)).orderBy(desc(tasks.id)).all().map(toTask);
    },
    tasksForRepo(repo_id: RepoId, limit = 40): Task[] {
      return orm.select(TASK_COLUMNS).from(tasks).where(eq(tasks.repo_id, repo_id)).orderBy(desc(tasks.id)).limit(limit).all().map(toTask);
    },
    /** Tasks of a repo that still need work or a decision; the planner waits until there are none. */
    countOpen(repo_id: RepoId): number {
      return countWhere(and(eq(tasks.repo_id, repo_id), inArray(tasks.status, OPEN_STATUSES)));
    },
    countRunning(): number {
      return countWhere(inArray(tasks.status, RUNNING_STATUSES));
    },
    /** The tasks with a live run, oldest first: what a restart at once would requeue. */
    runningTasks(): { id: TaskId; title: string }[] {
      return orm
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(inArray(tasks.status, RUNNING_STATUSES))
        .orderBy(asc(tasks.id))
        .all();
    },
    /** How many tasks are in each status (statuses with none are left out). */
    countByStatus(): Record<string, number> {
      const rows = orm
        .select({ status: tasks.status, n: count() })
        .from(tasks)
        .where(inActiveRepo(tasks.repo_id))
        .groupBy(tasks.status)
        .all();
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
    /** How many queued tasks each repo has (repos with none are left out). */
    countQueuedByRepo(): Map<number, number> {
      const rows = orm
        .select({ repo_id: tasks.repo_id, n: count() })
        .from(tasks)
        .where(and(eq(tasks.status, 'queued'), inActiveRepo(tasks.repo_id)))
        .groupBy(tasks.repo_id)
        .all();
      return new Map(rows.map((r) => [r.repo_id, r.n]));
    },
    /** Done tasks whose pull request is open: the ones waiting for a review. */
    countReview(): number {
      return countWhere(and(inReview, inActiveRepo(tasks.repo_id)));
    },
    /**
     * The tasks that wait on a person: blocked, in review, proposed, in active repos. One query: blocked first, then
     * review, then proposed, each by priority then id, at most `limit`.
     */
    attentionTasks(limit: number): AttentionCandidate[] {
      // guard: the builder has no CASE; one query orders blocked, review and proposed tasks and labels each
      const why = sql<AttentionWhy>`CASE WHEN ${tasks.status} = 'blocked' THEN 'blocked' WHEN ${tasks.status} = 'proposed' THEN 'proposed' ELSE 'review' END`;
      // guard: the builder has no CASE; this ranks the three kinds in the order they are listed
      const rank = sql`CASE WHEN ${tasks.status} = 'blocked' THEN 0 WHEN ${tasks.status} = 'done' THEN 1 ELSE 2 END`;
      return orm
        .select({ id: tasks.id, title: tasks.title, priority: tasks.priority, why })
        .from(tasks)
        .where(and(or(inArray(tasks.status, ['blocked', 'proposed']), inReview), inActiveRepo(tasks.repo_id)))
        .orderBy(rank, desc(tasks.priority), asc(tasks.id))
        .limit(limit)
        .all();
    },
    /** Whether a task could be claimed (`claimable`). */
    hasQueued(): boolean {
      return !!orm.select({ id: t.id }).from(t).where(claimable()).limit(1).get();
    },
    /**
     * Blocked tasks in repos that have auto_unblock on and may start work (not paused, not archived), by priority then
     * age: the ones an unblock run may be for. Whether one may start is `unblockable`'s to say.
     */
    unblockCandidates(): BlockedTask[] {
      const unblocking = orm
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.auto_unblock, 1), isNull(repos.paused_reason), isNull(repos.archived_at)));
      return orm
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(and(eq(tasks.status, 'blocked'), inArray(tasks.repo_id, unblocking)))
        .orderBy(desc(tasks.priority), asc(tasks.id))
        .all()
        .map(toTask)
        .filter(isBlocked);
    },
    /**
     * Leave an unblock run's question on a blocked task, with an `unblock_ask` history row whose
     * reason is the question. Guarded like every task write: only a blocked task, so a retry or a cancel made while the
     * run went is never undone. Returns false if the task was not blocked.
     */
    recordQuestion(id: TaskId, question: UnblockQuestion, reason: string): boolean {
      return atomically(db, () => {
        const res = orm
          .update(tasks)
          .set({ ...columns(questionChanges(question)), updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), eq(tasks.status, 'blocked')))
          .run();
        if (!Number(res.changes)) return false;
        recordEvent(orm, id, 'unblock_ask', 'blocked', 'blocked', reason);
        return true;
      });
    },
    /**
     * Tasks without their prompt, newest first. Returns the `limit` newest tasks older than `before`
     * (all tasks when omitted). On the first page (no `before`) every active task is included on top
     * of the limit, so views of in-flight work stay complete. Later pages hold older tasks only.
     */
    listTaskSummaries(opts: { status?: TaskStatus; limit: number; before?: TaskId }): TaskSummary[] {
      const { status, limit, before } = opts;
      const ofStatus = status === undefined ? undefined : eq(tasks.status, status);
      const page = orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(ofStatus, inActiveRepo(tasks.repo_id), before === undefined ? undefined : lt(tasks.id, before)))
        .orderBy(desc(tasks.id))
        .limit(limit);
      return orm
        .select(SUMMARY_COLUMNS)
        .from(tasks)
        .where(
          and(
            ofStatus,
            inActiveRepo(tasks.repo_id),
            or(inArray(tasks.id, page), before === undefined ? inArray(tasks.status, OPEN_STATUSES) : undefined),
          ),
        )
        .orderBy(desc(tasks.id))
        .all()
        .map(toTaskSummary);
    },
    /**
     * Tasks whose pull request is still open, for the state refresh: done ones, and blocked or failed ones
     * (a conflict blocks a done task and keeps its PR; a retry that fails keeps it too).
     */
    openPrTasks(): Task[] {
      return orm
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(and(inArray(tasks.status, ['done', 'blocked', 'failed']), isNotNull(tasks.pr_url), prOpen, inActiveRepo(tasks.repo_id)))
        .all()
        .map(toTask);
    },
    /** Done tasks whose pull request failed to open, for the PR refresh to open again. */
    failedPrTasks(): Task[] {
      return orm
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(and(eq(tasks.status, 'done'), eq(tasks.pr_state, 'failed'), inActiveRepo(tasks.repo_id)))
        .orderBy(asc(tasks.id))
        .all()
        .map(toTask);
    },
    /**
     * Claim the next claimable task (`claimable`), by priority then id, or undefined if none: the claim goes through
     * applyEvent like every status change, trying the next task if its guarded write misses. The read and the claim are one
     * unit, so an unblock run cannot start between them.
     */
    claimNextTask(): Task | undefined {
      return atomically(db, () => {
        const ids = orm.select({ id: t.id }).from(t).where(claimable()).orderBy(desc(t.priority), asc(t.id)).all();
        for (const { id } of ids) {
          const claimed = applyEvent(id, { type: 'claim' });
          if (claimed) return claimed.task;
        }
        return undefined;
      });
    },
    /**
     * Change a task's editable fields. Guarded by status like every other task write: only a task
     * in EDITABLE_STATUSES can be edited. Returns the task, or undefined if it is missing or in another status.
     * `ownPlan` (a parsed plan's HTML) becomes the task's own plan in the same write, only when the edit went through,
     * and the edit names `plan`.
     */
    editTask(
      id: TaskId,
      fields: Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'model' | 'max_turns' | 'max_attempts'>> & {
        plan_task?: TaskId | null;
        plan_steps?: string[] | null;
      },
      opts: { ownPlan?: string } = {},
    ): Task | undefined {
      if (Object.keys(fields).length === 0 && opts.ownPlan === undefined) return getTask(id);
      return atomically(db, () => {
        const edited = mapFound(
          orm
            .update(tasks)
            .set({ ...given(stored(fields)), updated_at: NOW_SQL })
            .where(and(eq(tasks.id, id), inArray(tasks.status, EDITABLE_STATUSES)))
            .returning(TASK_COLUMNS)
            .get(),
          toTask,
        );
        if (!edited) return undefined;
        if (opts.ownPlan !== undefined) saveOwnPlan(db, orm, id, opts.ownPlan, 'attached');
        // The status stays; the row says what was edited, and `stats` counts an edit of a queued or blocked task.
        const what = [...Object.keys(fields), ...(opts.ownPlan !== undefined ? ['plan'] : [])].join(', ');
        recordEvent(orm, id, 'edit', edited.status, edited.status, what);
        return edited;
      });
    },
    /**
     * Attach or replace a task's own plan (a parsed plan's HTML) and record it as an `edit` naming `plan`, so a cut-off
     * session of the task or of a task following the plan starts afresh (`editsSinceCutOff`). Guarded: only a task in
     * PLAN_ATTACHABLE_STATUSES. Returns the stored plan, or undefined if the task is missing or in another status.
     */
    attachOwnPlan(id: TaskId, html: string): TaskPlan | undefined {
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          .set({ updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), inArray(tasks.status, PLAN_ATTACHABLE_STATUSES)))
          .returning({ status: tasks.status })
          .get() as { status: TaskStatus } | undefined;
        if (!row) return undefined;
        const saved = saveOwnPlan(db, orm, id, html, 'attached');
        recordEvent(orm, id, 'edit', row.status, row.status, 'plan');
        return saved;
      });
    },
    /** Where a task's work is checked out. Not a status, so unguarded. */
    setCheckout(id: TaskId, fields: { branch?: string | null; worktree?: string | null }): void {
      if (Object.keys(fields).length === 0) return;
      orm
        .update(tasks)
        .set({ ...given(fields), updated_at: NOW_SQL })
        .where(eq(tasks.id, id))
        .run();
    },
    /** Mark a sync of the task's branch as running (`syncing_since`), or clear the mark. Not a status, so unguarded. */
    setSyncing(id: TaskId, on: boolean): void {
      orm
        .update(tasks)
        .set({ syncing_since: on ? NOW_SQL : null })
        .where(eq(tasks.id, id))
        .run();
    },
    /** Whether a sync of the task's branch is marked as running, by any process. */
    hasSyncMarker(id: TaskId): boolean {
      const row = orm.select({ since: tasks.syncing_since }).from(tasks).where(eq(tasks.id, id)).get();
      return row?.since != null;
    },
    /** Whether the daemon may merge the task's PR on its own: true, false, or null for the repo's setting. Not a status, so unguarded. */
    setAutoMerge(id: TaskId, value: boolean | null): Task | undefined {
      return mapFound(
        orm
          .update(tasks)
          .set({ ...columns(autoMergeSettingChanges(value)), updated_at: NOW_SQL })
          .where(eq(tasks.id, id))
          .returning(TASK_COLUMNS)
          .get(),
        toTask,
      );
    },
    /**
     * Keep the PR refresh's latest auto-merge check (JSON { verdict, reasons }) on a task, or clear it with null.
     * Only a done task whose PR is open has one, so a merge or a close recorded meanwhile is never followed by a stale check.
     */
    setAutoMergeCheck(id: TaskId, check: AutoMergeCheck | null): boolean {
      const res = orm
        .update(tasks)
        .set(columns(autoMergeCheckChanges(check)))
        .where(and(eq(tasks.id, id), inReview))
        .run();
      return changed(res);
    },
    /**
     * Record a person's request to merge the task's PR once it is ready. Not a status, but guarded like the merge it asks
     * for: only a done task whose PR is open. A new request starts without a check. Returns false if it was not.
     */
    requestMerge(id: TaskId, method: MergeMethod): boolean {
      const res = orm
        .update(tasks)
        .set({ ...columns(mergeRequestChanges(method)), updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), inReview))
        .run();
      return changed(res);
    },
    /** Drop a task's merge request. Returns false if it had none. */
    clearMergeRequest(id: TaskId): boolean {
      const res = orm
        .update(tasks)
        .set({ ...columns(noMergeRequestChanges()), updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), isNotNull(tasks.merge_requested_at)))
        .run();
      return changed(res);
    },
    /**
     * Keep the PR refresh's latest merge request check (JSON { verdict, reasons }) on a task that still has the request.
     * Only a done task whose PR is open, like setAutoMergeCheck: a check finished after a conflict blocked it is dropped.
     */
    setMergeRequestCheck(id: TaskId, check: AutoMergeCheck): boolean {
      const res = orm
        .update(tasks)
        .set(columns(mergeRequestCheckChanges(check)))
        .where(and(eq(tasks.id, id), isNotNull(tasks.merge_requested_at), inReview))
        .run();
      return changed(res);
    },
    /**
     * Keep a done task's open PR's checks as they were the first time they settled (`pr_checks_opened`).
     * Written once: returns false when the PR is not open, or already has them.
     */
    recordPrChecksOpened(id: TaskId, checks: CheckCounts): boolean {
      const res = orm
        .update(tasks)
        .set(columns(prChecksOpenedChanges(checks)))
        .where(and(eq(tasks.id, id), inReview, isNull(tasks.pr_checks_opened)))
        .run();
      return changed(res);
    },
    /**
     * Keep the PR refresh's latest checks (JSON StoredChecks) on a task. Only a done task whose PR is open, like
     * setAutoMergeCheck: checks read while a merge or a close was recorded are dropped. Returns false if it was not.
     */
    setPrChecks(id: TaskId, checks: StoredChecks): boolean {
      const res = orm
        .update(tasks)
        .set(columns(prChecksChanges(checks)))
        .where(and(eq(tasks.id, id), inReview))
        .run();
      return changed(res);
    },
    /**
     * Record a change to a task's PR: `pr_state` (and `pr_url` when opened) and a 'pr' history row, together.
     * Guarded on the PR state the change starts from, like every task write: an opened or failed PR replaces anything
     * but an open one, a close or a sighting only moves an open PR. A merge recorded in between is therefore never
     * undone. A failure needs a done task; an opened PR does not: GitHub has it whatever the task did meanwhile (a
     * retry while it opened), and the task's next finish finds it. Returns false if the task was not in a state the
     * change applies to.
     */
    recordPr(id: TaskId, e: PrEvent): boolean {
      const notOpen = or(isNull(tasks.pr_state), not(prOpen));
      const isOpen = prOpen;
      const reason = prEventReason(e);
      const guard: SQL | undefined =
        e.type === 'opened'
          ? notOpen
          : e.type === 'failed'
            ? and(notOpen, eq(tasks.status, 'done'))
            : e.type === 'closed'
              ? isOpen
              : and(isOpen, ne(tasks.pr_state, e.state));
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          .set({ ...columns(prChanges(e)), updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), guard))
          .returning({ status: tasks.status })
          .get() as { status: TaskStatus } | undefined;
        if (!row) return false;
        recordEvent(orm, id, 'pr', row.status, row.status, reason);
        return true;
      });
    },
    /**
     * Record that a done task's PR was merged: the PR state, the method and a history row, together.
     * Guarded like every task write: only a done task whose PR is open. Returns false if it was not.
     */
    recordMerge(id: TaskId, method: MergeMethod, reason: string, checks?: CheckCounts): boolean {
      return atomically(db, () => {
        const res = orm
          .update(tasks)
          .set({ ...columns(mergedPrChanges(method, checks)), updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), inReview))
          .run();
        if (!changed(res)) return false;
        recordEvent(orm, id, 'merge', 'done', 'done', reason);
        return true;
      });
    },
    /**
     * Record a sync that changed a task's branch: a history row, no status change.
     * Guarded like every task write: only a running or done task. Returns false if it was not.
     */
    recordSync(id: TaskId, reason: string): boolean {
      return noteEvent(id, ['running', 'done'], 'sync', reason);
    },
    /**
     * Record that a run left linked plan steps unfinished: a history row, no status change. Only a running task.
     */
    recordPlanUnfinished(id: TaskId, reason: string): boolean {
      return noteEvent(id, ['running'], 'plan_unfinished', reason);
    },
    /**
     * After a crash, anything still marked running was orphaned: put it back in the queue,
     * unless restarts keep interrupting it. Stop its claude process (`reapOrphans`) first.
     * The unfinished runs of a requeued task end `interrupted`, keeping their session, so the next run resumes it; those
     * of a task that failed or was cancelled end so (`failed`, `cancelled`), so the run stats count them. Any other
     * unfinished run (a done task's resolve run, a blocked task's unblock run) ends `interrupted`. Returns how many were
     * requeued and the ids of those failed.
     */
    recoverOrphans(): { requeued: number; failed: TaskId[] } {
      // Syncs run only in the daemon, so any marker left over belongs to a sync that died with it.
      orm.update(tasks).set({ syncing_since: null }).where(isNotNull(tasks.syncing_since)).run();
      const endRuns = (outcome: RunOutcome, task_id?: TaskId) =>
        orm
          .update(runs)
          .set({ ended_at: NOW_SQL, outcome, result_text: 'daemon restarted' })
          .where(and(isNull(runs.ended_at), task_id === undefined ? undefined : eq(runs.task_id, task_id)))
          .run();
      orm
        .update(plannerRuns)
        .set({ ended_at: NOW_SQL, outcome: 'failed', note: 'daemon restarted' })
        .where(isNull(plannerRuns.ended_at))
        .run();
      let requeued = 0;
      const failed: TaskId[] = [];
      const orphans = orm
        .select({ id: tasks.id, restarts: tasks.restarts })
        .from(tasks)
        .where(inArray(tasks.status, RUNNING_STATUSES))
        .all();
      for (const o of orphans) {
        const reason = `the daemon restarted ${o.restarts + 1} times while this task was running`;
        atomically(db, () => {
          const task = applyEvent(o.id, { type: 'recover' }, { reason })?.task;
          if (task?.status === 'queued') requeued++;
          else if (task?.status === 'failed') failed.push(task.id);
          if (task?.status === 'failed' || task?.status === 'cancelled') endRuns(task.status, task.id);
        });
      }
      endRuns(INTERRUPTED);
      return { requeued, failed };
    },
  };
}
