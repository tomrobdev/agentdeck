// Tasks. Every status change goes through applyEvent (or claimNextTask), guarded by the current status.
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { type AnySQLiteColumn, alias } from 'drizzle-orm/sqlite-core';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '../config.ts';
import type { CheckCounts, MergeMethod } from '../domain/pull-request/merge.ts';
import { INTERRUPTED } from '../domain/run/run.ts';
import { MAX_RESTARTS, type TaskEvent, type TaskStatus, fromStatuses, nextStatus, transition } from '../domain/task/lifecycle.ts';
import type { Link, LinkKind } from '../domain/task/link.ts';
import type { PrEvent, TaskEventRow, TaskEventType } from '../domain/task/history.ts';
import type { TaskPlan } from '../domain/plan/plan.ts';
import {
  EDITABLE_STATUSES,
  OPEN_STATUSES,
  PLAN_ATTACHABLE_STATUSES,
  RUNNING_STATUSES,
  type Task,
  type TaskSummary,
} from '../domain/task/task.ts';
import type { Orm } from './orm.ts';
import { insertOwnPlan, saveOwnPlan } from './plans.ts';
import { NOW_SQL, atomically } from './sql.ts';
import { plannerRuns, repos, runs, taskEvents, taskLinks, tasks } from './tables.ts';

/** A task's columns: every one but the legacy `after_task`, which migration 18 copied into task_links and nothing reads. */
const { after_task: _after_task, ...TASK_COLUMNS } = getColumns(tasks);
/** Every column but the prompt, for lists. */
const { prompt: _prompt, ...SUMMARY_COLUMNS } = TASK_COLUMNS;

/** A task that depends on another, and the kind of that link. */
export interface Dependent {
  id: number;
  status: TaskStatus;
  kind: LinkKind;
}

/** A task at the end of a link: what its link states are read from. */
export interface LinkedTask {
  id: number;
  status: TaskStatus;
  pr_url: string | null;
  pr_state: string | null;
  done_by: string | null;
  pr_mode: string | null;
}

/** The columns of a task with no merge request. */
const NO_MERGE_REQUEST = { merge_requested_at: null, merge_request_method: null, merge_request_check: null };
/** The columns of a task with no auto-merge check. */
const NO_AUTO_MERGE_CHECK = { auto_merge_check: null, auto_merge_checked_at: null };

/** The task row `t` in the claim and queue queries, which NOT_WAITING refers to. */
const t = alias(tasks, 't');
/** A builds-on link of `t`, the task `d` it builds on, and `d`'s repo `r`: what NOT_WAITING looks through. */
const buildsOn = alias(taskLinks, 'l');
const dep = alias(tasks, 'd');
const depRepo = alias(repos, 'r');

/** Unset fields are left alone by Drizzle; these writes have always stored a given-as-undefined field as NULL. */
const given = <T extends object>(fields: T) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v ?? null])) as { [K in keyof T]-?: Exclude<T[K], undefined> };

export function taskStore(db: DatabaseSync, orm: Orm) {
  /** The repo id column `col` belongs to a repo that isn't archived. Archived repos' tasks are left out of every list and count. */
  const inActiveRepo = (col: AnySQLiteColumn) => inArray(col, orm.select({ id: repos.id }).from(repos).where(isNull(repos.archived_at)));
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
   * A done task whose PR isn't opened yet (or failed to open) has pr_url NULL, so it must not count as met.
   * A task a person marked done counts as met unless its PR is open. After links never stop a start.
   * Mirrors startState and domain/task/link.ts.
   */
  const notWaiting = () => {
    const met = and(
      eq(dep.status, 'done'),
      or(
        eq(dep.pr_state, 'merged'),
        and(
          isNull(dep.pr_url),
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
  const countWhere = (where: SQL | undefined) => orm.select({ n: count() }).from(tasks).where(where).get()?.n ?? 0;

  /** Append to a task's history. Callers run it in the same `atomically` block as the status change. */
  const recordEvent = (task_id: number, type: TaskEventType, from: TaskStatus | null, to: TaskStatus, reason: string | null = null) =>
    orm.insert(taskEvents).values({ task_id, type, from_status: from, to_status: to, reason }).run();

  return {
    addTask(n: {
      repo_id: number;
      title: string;
      prompt: string;
      priority?: number;
      model?: string;
      max_turns?: number;
      max_attempts?: number;
      status?: 'queued' | 'proposed';
      source?: 'manual' | 'planner';
      /** Shorthand for one builds-on link to that task. */
      after_task?: number | null;
      /** Links the task starts with; the caller has checked them (a new task can't make a cycle). */
      links?: { on: number; kind: LinkKind }[];
      /** The task whose plan this one follows. */
      plan_task?: number | null;
      plan_steps?: string | null;
      /** A plan for the new task to own and follow (the caller has parsed it): stored under its numbered name, and linked. */
      own_plan?: string;
    }): Task {
      const status = n.status ?? 'queued';
      const links = [...(n.links ?? [])];
      if (n.after_task != null && !links.some((l) => l.on === n.after_task)) links.push({ on: n.after_task, kind: 'builds_on' });
      const id = atomically(db, () => {
        const info = orm
          .insert(tasks)
          .values({
            repo_id: n.repo_id,
            title: n.title,
            prompt: n.prompt,
            priority: n.priority ?? 0,
            model: n.model ?? DEFAULTS.model,
            max_turns: n.max_turns ?? DEFAULTS.maxTurns,
            max_attempts: n.max_attempts ?? DEFAULTS.maxAttempts,
            status,
            source: n.source ?? 'manual',
            plan_task: n.plan_task ?? null,
            plan_steps: n.plan_steps ?? null,
          })
          .run();
        const id = Number(info.lastInsertRowid);
        if (n.own_plan !== undefined) {
          insertOwnPlan(orm, id, n.own_plan, 'attached');
          orm.update(tasks).set({ plan_task: id }).where(eq(tasks.id, id)).run();
        }
        for (const l of links) orm.insert(taskLinks).values({ task_id: id, on_task: l.on, kind: l.kind }).run();
        recordEvent(id, 'created', null, status);
        return id;
      });
      return this.getTask(id)!;
    },
    /** A task's status changes, oldest first. Tasks from before migration step 6 have none. */
    eventsForTask(task_id: number): TaskEventRow[] {
      return orm.select().from(taskEvents).where(eq(taskEvents.task_id, task_id)).orderBy(asc(taskEvents.id)).all() as TaskEventRow[];
    },
    /** The newest history row's id, 0 when there is none: a cursor for `eventsAfter`. */
    lastEventId(): number {
      return (
        orm
          .select({ id: max(taskEvents.id) })
          .from(taskEvents)
          .get()?.id ?? 0
      );
    },
    /** A repo's history rows after `after`, up to `upTo` inclusive, oldest first, each with its task's title. */
    eventsAfter(after: number, upTo: number, repo_id: number): (TaskEventRow & { title: string })[] {
      return orm
        .select({ ...getColumns(taskEvents), title: tasks.title })
        .from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.task_id))
        .where(and(gt(taskEvents.id, after), lte(taskEvents.id, upTo), eq(tasks.repo_id, repo_id)))
        .orderBy(asc(taskEvents.id))
        .all() as (TaskEventRow & { title: string })[];
    },
    getTask(id: number): Task | undefined {
      // The cast narrows the plain string columns (status, pr_state, …); typed columns come later.
      return orm.select(TASK_COLUMNS).from(tasks).where(eq(tasks.id, id)).get() as Task | undefined;
    },
    listTasks(): Task[] {
      return orm.select(TASK_COLUMNS).from(tasks).where(inActiveRepo(tasks.repo_id)).orderBy(desc(tasks.id)).all() as Task[];
    },
    tasksForRepo(repo_id: number, limit = 40): Task[] {
      return orm.select(TASK_COLUMNS).from(tasks).where(eq(tasks.repo_id, repo_id)).orderBy(desc(tasks.id)).limit(limit).all() as Task[];
    },
    /** Tasks of a repo that still need work or a decision; the planner waits until there are none. */
    countOpen(repo_id: number): number {
      return countWhere(and(eq(tasks.repo_id, repo_id), inArray(tasks.status, OPEN_STATUSES)));
    },
    countRunning(): number {
      return countWhere(inArray(tasks.status, RUNNING_STATUSES));
    },
    /** The tasks with a live run, oldest first: what a restart at once would requeue. */
    runningTasks(): { id: number; title: string }[] {
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
    /** Done tasks whose pull request is open: the ones waiting for a review. */
    countReview(): number {
      return countWhere(and(eq(tasks.status, 'done'), eq(tasks.pr_state, 'open'), inActiveRepo(tasks.repo_id)));
    },
    /** Whether a task could be claimed: queued, not waiting on a dependency, in a repo that isn't paused. */
    hasQueued(): boolean {
      return !!orm
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.status, 'queued'), notWaiting(), inOpenRepo(t.repo_id)))
        .limit(1)
        .get();
    },
    /**
     * Tasks without their prompt, newest first. Returns the `limit` newest tasks older than `before`
     * (all tasks when omitted). On the first page (no `before`) every active task is included on top
     * of the limit, so views of in-flight work stay complete. Later pages hold older tasks only.
     */
    listTaskSummaries(opts: { status?: TaskStatus; limit: number; before?: number }): TaskSummary[] {
      const { status, limit, before } = opts;
      const ofStatus = status === undefined ? undefined : eq(tasks.status, status);
      const page = orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(ofStatus, before === undefined ? undefined : lt(tasks.id, before)))
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
        .all() as TaskSummary[];
    },
    /** The links a task has: what it depends on. */
    linksOf(id: number): Link[] {
      return orm
        .select({ task_id: taskLinks.task_id, on: taskLinks.on_task, kind: taskLinks.kind })
        .from(taskLinks)
        .where(eq(taskLinks.task_id, id))
        .orderBy(asc(taskLinks.on_task))
        .all() as Link[];
    },
    /** Every link there is, for checking a new one for cycles. */
    allLinks(): Link[] {
      return orm.select({ task_id: taskLinks.task_id, on: taskLinks.on_task, kind: taskLinks.kind }).from(taskLinks).all() as Link[];
    },
    /** The tasks that depend on `id` (of one kind, if given), in any status: each one's id, status and the kind of its link. */
    dependentsOf(id: number, kind?: LinkKind): Dependent[] {
      return orm
        .select({ id: tasks.id, status: tasks.status, kind: taskLinks.kind })
        .from(tasks)
        .innerJoin(taskLinks, eq(taskLinks.task_id, tasks.id))
        .where(and(eq(taskLinks.on_task, id), kind ? eq(taskLinks.kind, kind) : undefined))
        .orderBy(asc(tasks.id))
        .all() as Dependent[];
    },
    /** Every task at either end of a link, with its repo's pr_mode (null when the repo is gone): what link states are read from. */
    linkedTasks(): LinkedTask[] {
      const ends = orm
        .select({ id: taskLinks.task_id })
        .from(taskLinks)
        .union(orm.select({ id: taskLinks.on_task }).from(taskLinks));
      return orm
        .select({
          id: tasks.id,
          status: tasks.status,
          pr_url: tasks.pr_url,
          pr_state: tasks.pr_state,
          done_by: tasks.done_by,
          pr_mode: repos.pr_mode,
        })
        .from(tasks)
        .leftJoin(repos, eq(repos.id, tasks.repo_id))
        .where(inArray(tasks.id, ends))
        .all() as LinkedTask[];
    },
    /** Link `link.task_id` to `link.on`. Whether that is allowed (a cycle, a duplicate) is the caller's to check with linkError. */
    addLink(link: Link): void {
      orm.insert(taskLinks).values({ task_id: link.task_id, on_task: link.on, kind: link.kind }).run();
    },
    /** Remove the link from `task_id` to `on`; false if there was none. */
    removeLink(task_id: number, on: number): boolean {
      return (
        orm
          .delete(taskLinks)
          .where(and(eq(taskLinks.task_id, task_id), eq(taskLinks.on_task, on)))
          .run().changes > 0
      );
    },
    /**
     * Tasks whose pull request is still open, for the state refresh: done ones, and blocked or failed ones
     * (a conflict blocks a done task and keeps its PR; a retry that fails keeps it too).
     */
    openPrTasks(): Task[] {
      return orm
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(
          and(
            inArray(tasks.status, ['done', 'blocked', 'failed']),
            isNotNull(tasks.pr_url),
            eq(tasks.pr_state, 'open'),
            inActiveRepo(tasks.repo_id),
          ),
        )
        .all() as Task[];
    },
    /**
     * Atomically claim the next queued task of a repo that isn't paused, or undefined if none.
     * A task waits until every task it builds on is done and, if that has a PR, the PR is merged.
     */
    claimNextTask(): Task | undefined {
      const from = fromStatuses({ type: 'claim' });
      const to = nextStatus(from[0], { type: 'claim' })!;
      const next = orm
        .select({ id: t.id })
        .from(t)
        .where(and(inArray(t.status, from), notWaiting(), inOpenRepo(t.repo_id)))
        .orderBy(desc(t.priority), asc(t.id))
        .limit(1);
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          // guard: the builder has no column arithmetic, and the attempt must count in the same guarded write as the claim
          .set({ status: to, attempts: sql`${tasks.attempts} + 1`, updated_at: NOW_SQL })
          .where(and(inArray(tasks.status, from), eq(tasks.id, next)))
          .returning(TASK_COLUMNS)
          .get() as Task | undefined;
        // A claim is allowed from one status only (queued), so that is where the task came from.
        if (row) recordEvent(row.id, 'claim', from[0], to);
        return row;
      });
    },
    /**
     * Change a task's editable fields. Guarded by status like every other task write: only a task
     * in EDITABLE_STATUSES can be edited. Returns the task, or undefined if it is missing or in another status.
     * `ownPlan` (a parsed plan's HTML) becomes the task's own plan in the same write, only when the edit went through,
     * and the edit names `plan`.
     */
    editTask(
      id: number,
      fields: Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'model' | 'max_turns' | 'max_attempts' | 'plan_task' | 'plan_steps'>>,
      opts: { ownPlan?: string } = {},
    ): Task | undefined {
      if (Object.keys(fields).length === 0 && opts.ownPlan === undefined) return this.getTask(id);
      return atomically(db, () => {
        const edited = orm
          .update(tasks)
          .set({ ...given(fields), updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), inArray(tasks.status, EDITABLE_STATUSES)))
          .returning(TASK_COLUMNS)
          .get() as Task | undefined;
        if (!edited) return undefined;
        if (opts.ownPlan !== undefined) saveOwnPlan(db, orm, id, opts.ownPlan, 'attached');
        // The status stays; the row says what was edited, and `stats` counts an edit of a queued or blocked task.
        const what = [...Object.keys(fields), ...(opts.ownPlan !== undefined ? ['plan'] : [])].join(', ');
        recordEvent(id, 'edit', edited.status, edited.status, what);
        return edited;
      });
    },
    /**
     * Attach or replace a task's own plan (a parsed plan's HTML) and record it as an `edit` naming `plan`, so a cut-off
     * session of the task or of a task following the plan starts afresh (`editsSinceCutOff`). Guarded: only a task in
     * PLAN_ATTACHABLE_STATUSES. Returns the stored plan, or undefined if the task is missing or in another status.
     */
    attachOwnPlan(id: number, html: string): TaskPlan | undefined {
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          .set({ updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), inArray(tasks.status, PLAN_ATTACHABLE_STATUSES)))
          .returning({ status: tasks.status })
          .get() as { status: TaskStatus } | undefined;
        if (!row) return undefined;
        const saved = saveOwnPlan(db, orm, id, html, 'attached');
        recordEvent(id, 'edit', row.status, row.status, 'plan');
        return saved;
      });
    },
    /** Where a task's work is checked out. Not a status, so unguarded. */
    setCheckout(id: number, fields: Partial<Pick<Task, 'branch' | 'worktree'>>): void {
      if (Object.keys(fields).length === 0) return;
      orm
        .update(tasks)
        .set({ ...given(fields), updated_at: NOW_SQL })
        .where(eq(tasks.id, id))
        .run();
    },
    /** Mark a sync of the task's branch as running (`syncing_since`), or clear the mark. Not a status, so unguarded. */
    setSyncing(id: number, on: boolean): void {
      orm
        .update(tasks)
        .set({ syncing_since: on ? NOW_SQL : null })
        .where(eq(tasks.id, id))
        .run();
    },
    /** Whether a sync of the task's branch is marked as running, by any process. */
    hasSyncMarker(id: number): boolean {
      const row = orm.select({ since: tasks.syncing_since }).from(tasks).where(eq(tasks.id, id)).get();
      return row?.since != null;
    },
    /** Whether the daemon may merge the task's PR on its own: 1, 0, or null for the repo's setting. Not a status, so unguarded. */
    setAutoMerge(id: number, value: 0 | 1 | null): Task | undefined {
      return (
        orm
          .update(tasks)
          // The stored check was made for the old setting, so it goes with it.
          .set({ auto_merge: value, ...NO_AUTO_MERGE_CHECK, updated_at: NOW_SQL })
          .where(eq(tasks.id, id))
          .returning(TASK_COLUMNS)
          .get() as Task | undefined
      );
    },
    /**
     * Keep the PR refresh's latest auto-merge check (JSON { verdict, reasons }) on a task, or clear it with null.
     * Only a done task whose PR is open has one, so a merge or a close recorded meanwhile is never followed by a stale check.
     */
    setAutoMergeCheck(id: number, check: string | null): boolean {
      const res = orm
        .update(tasks)
        .set({ auto_merge_check: check, auto_merge_checked_at: check === null ? null : NOW_SQL })
        .where(and(eq(tasks.id, id), eq(tasks.status, 'done'), eq(tasks.pr_state, 'open')))
        .run();
      return Number(res.changes) > 0;
    },
    /**
     * Record a person's request to merge the task's PR once it is ready. Not a status, but guarded like the merge it asks
     * for: only a done task whose PR is open. A new request starts without a check. Returns false if it was not.
     */
    requestMerge(id: number, method: MergeMethod): boolean {
      const res = orm
        .update(tasks)
        .set({ merge_requested_at: NOW_SQL, merge_request_method: method, merge_request_check: null, updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), eq(tasks.status, 'done'), eq(tasks.pr_state, 'open')))
        .run();
      return Number(res.changes) > 0;
    },
    /** Drop a task's merge request. Returns false if it had none. */
    clearMergeRequest(id: number): boolean {
      const res = orm
        .update(tasks)
        .set({ ...NO_MERGE_REQUEST, updated_at: NOW_SQL })
        .where(and(eq(tasks.id, id), isNotNull(tasks.merge_requested_at)))
        .run();
      return Number(res.changes) > 0;
    },
    /**
     * Keep the PR refresh's latest merge request check (JSON { verdict, reasons }) on a task that still has the request.
     * Only a done task whose PR is open, like setAutoMergeCheck: a check finished after a conflict blocked it is dropped.
     */
    setMergeRequestCheck(id: number, check: string): boolean {
      const res = orm
        .update(tasks)
        .set({ merge_request_check: check })
        .where(and(eq(tasks.id, id), isNotNull(tasks.merge_requested_at), eq(tasks.status, 'done'), eq(tasks.pr_state, 'open')))
        .run();
      return Number(res.changes) > 0;
    },
    /**
     * Keep a done task's open PR's checks as they were the first time they settled (`pr_checks_opened`).
     * Written once: returns false when the PR is not open, or already has them.
     */
    recordPrChecksOpened(id: number, checks: CheckCounts): boolean {
      const res = orm
        .update(tasks)
        .set({ pr_checks_opened: JSON.stringify(checks) })
        .where(and(eq(tasks.id, id), eq(tasks.status, 'done'), eq(tasks.pr_state, 'open'), isNull(tasks.pr_checks_opened)))
        .run();
      return Number(res.changes) > 0;
    },
    /**
     * Keep the PR refresh's latest checks (JSON StoredChecks) on a task. Only a done task whose PR is open, like
     * setAutoMergeCheck: checks read while a merge or a close was recorded are dropped. Returns false if it was not.
     */
    setPrChecks(id: number, checks: string): boolean {
      const res = orm
        .update(tasks)
        .set({ pr_checks: checks })
        .where(and(eq(tasks.id, id), eq(tasks.status, 'done'), eq(tasks.pr_state, 'open')))
        .run();
      return Number(res.changes) > 0;
    },
    /**
     * Record a change to a task's PR: `pr_state` (and `pr_url` when opened) and a 'pr' history row, together.
     * Guarded on the PR state the change starts from, like every task write: an opened or failed PR replaces anything
     * but an open one (and needs a done task), a close or a sighting only moves an open PR. A merge recorded in
     * between is therefore never undone. Returns false if the task was not in a state the change applies to.
     */
    recordPr(id: number, e: PrEvent): boolean {
      const notOpenAndDone = and(or(isNull(tasks.pr_state), ne(tasks.pr_state, 'open')), eq(tasks.status, 'done'));
      const isOpen = eq(tasks.pr_state, 'open');
      const [set, guard, reason]: [Partial<typeof tasks.$inferInsert>, SQL | undefined, string] =
        e.type === 'opened'
          ? [{ pr_url: e.url, pr_state: 'open' }, notOpenAndDone, `opened ${e.url}`]
          : e.type === 'failed'
            ? [{ pr_state: 'failed' }, notOpenAndDone, `could not open the PR: ${e.error}`]
            : e.type === 'closed'
              ? [{ pr_state: 'closed' }, isOpen, 'closed without merging']
              : [{ pr_state: e.state }, and(isOpen, ne(tasks.pr_state, e.state)), `PR is ${e.state}`];
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          // A PR that is no longer open has no auto-merge check; a reopened one gets its first at the next refresh.
          .set({
            ...set,
            // A newly opened PR has its own checks to record.
            ...(e.type === 'opened' ? { pr_checks_opened: null, pr_checks_merged: null, pr_checks: null } : {}),
            ...NO_AUTO_MERGE_CHECK,
            ...NO_MERGE_REQUEST,
            updated_at: NOW_SQL,
          })
          .where(and(eq(tasks.id, id), guard))
          .returning({ status: tasks.status })
          .get() as { status: TaskStatus } | undefined;
        if (!row) return false;
        recordEvent(id, 'pr', row.status, row.status, reason);
        return true;
      });
    },
    /**
     * Record that a done task's PR was merged: the PR state, the method and a history row, together.
     * Guarded like every task write: only a done task whose PR is open. Returns false if it was not.
     */
    recordMerge(id: number, method: MergeMethod, reason: string, checks?: CheckCounts): boolean {
      return atomically(db, () => {
        const res = orm
          .update(tasks)
          .set({
            pr_state: 'merged',
            merge_method: method,
            ...(checks ? { pr_checks_merged: JSON.stringify(checks) } : {}),
            ...NO_AUTO_MERGE_CHECK,
            ...NO_MERGE_REQUEST,
            updated_at: NOW_SQL,
          })
          .where(and(eq(tasks.id, id), eq(tasks.status, 'done'), eq(tasks.pr_state, 'open')))
          .run();
        if (!Number(res.changes)) return false;
        recordEvent(id, 'merge', 'done', 'done', reason);
        return true;
      });
    },
    /**
     * Record that the base branch was brought into a task's branch: a history row, no status change.
     * Guarded like every task write: only a running or done task. Returns false if it was not.
     */
    recordSync(id: number, reason: string): boolean {
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          .set({ updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), inArray(tasks.status, ['running', 'done'])))
          .returning({ status: tasks.status })
          .get() as { status: TaskStatus } | undefined;
        if (!row) return false;
        recordEvent(id, 'sync', row.status, row.status, reason);
        return true;
      });
    },
    /**
     * Record that a run left linked plan steps unfinished: a history row, no status change. Only a running task.
     */
    recordPlanUnfinished(id: number, reason: string): boolean {
      return atomically(db, () => {
        const res = orm
          .update(tasks)
          .set({ updated_at: NOW_SQL })
          .where(and(eq(tasks.id, id), eq(tasks.status, 'running')))
          .run();
        if (!Number(res.changes)) return false;
        recordEvent(id, 'plan_unfinished', 'running', 'running', reason);
        return true;
      });
    },
    /** Done tasks whose latest run left linked plan steps unfinished: the ids, for the list's badge. */
    planUnfinishedIds(): Set<number> {
      const e = alias(taskEvents, 'e');
      const c = alias(taskEvents, 'c');
      const lastClaim = orm
        .select({ id: max(c.id) })
        .from(c)
        .where(and(eq(c.task_id, tasks.id), eq(c.type, 'claim')));
      const unfinishedSince = orm
        .select({ id: e.id })
        .from(e)
        // guard: the builder has no COALESCE; a task never claimed has no claim row, so the cursor is 0
        .where(and(eq(e.task_id, tasks.id), eq(e.type, 'plan_unfinished'), gt(e.id, sql`COALESCE(${lastClaim}, 0)`)));
      const rows = orm
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.status, 'done'), inActiveRepo(tasks.repo_id), exists(unfinishedSince)))
        .all();
      return new Set(rows.map((r) => r.id));
    },
    /**
     * The only way to change a task's status. Asks the lifecycle whether `event` is allowed from the
     * task's current status and writes the result guarded by that status, so a concurrent change
     * (say, a cancel arriving as a run finishes) is never overwritten. Returns the updated task, or
     * undefined if the task is missing or the event isn't allowed. `onlyFrom` narrows it further: the write also
     * requires the task to be in one of those statuses, so a caller that checked a status before a long wait
     * does not undo a change made meanwhile.
     */
    applyEvent(
      id: number,
      event: TaskEvent,
      opts: { reason?: string | null; needs?: string | null; onlyFrom?: TaskStatus[] } = {},
    ): Task | undefined {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = this.getTask(id);
        if (!cur) return undefined;
        if (opts.onlyFrom && !opts.onlyFrom.includes(cur.status)) return undefined;
        const next = transition(cur, event, opts);
        if (!next) return undefined;
        const row = atomically(db, () => {
          // Guarded on the status and on the counters the changes were computed from.
          const row = orm
            .update(tasks)
            .set({ status: next.to, ...given(next.changes), updated_at: NOW_SQL })
            .where(and(eq(tasks.id, id), eq(tasks.status, cur.status), eq(tasks.attempts, cur.attempts), eq(tasks.restarts, cur.restarts)))
            .returning(TASK_COLUMNS)
            .get() as Task | undefined;
          if (row) recordEvent(id, next.history, cur.status, next.to, opts.reason ?? null);
          return row;
        });
        if (row) return row;
      }
      return undefined;
    },
    /**
     * After a crash, anything still marked running was orphaned: put it back in the queue,
     * unless restarts keep interrupting it. Stop its claude process (`reapOrphans`) first.
     * The unfinished runs of a requeued task end `interrupted`, keeping their session, so the next run resumes it; those
     * of a task that failed or was cancelled end so (`failed`, `cancelled`), so the run stats count them. Any other
     * unfinished run (a done task's sync) ends `interrupted`. Returns how many were requeued and the ids of those failed.
     */
    recoverOrphans(): { requeued: number; failed: number[] } {
      // Syncs run only in the daemon, so any marker left over belongs to a sync that died with it.
      orm.update(tasks).set({ syncing_since: null }).where(isNotNull(tasks.syncing_since)).run();
      const endRuns = (outcome: string, task_id?: number) =>
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
      const failed: number[] = [];
      const orphans = orm
        .select({ id: tasks.id, restarts: tasks.restarts })
        .from(tasks)
        .where(inArray(tasks.status, RUNNING_STATUSES))
        .all();
      for (const o of orphans) {
        const exhausted = o.restarts + 1 >= MAX_RESTARTS;
        const reason = `the daemon restarted ${o.restarts + 1} times while this task was running`;
        atomically(db, () => {
          const task = this.applyEvent(o.id, { type: 'recover', exhausted }, { reason });
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
