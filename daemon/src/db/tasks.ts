// Tasks. Every status change goes through applyEvent (or claimNextTask), guarded by the current status.
import { type SQL, and, asc, count, desc, eq, exists, getColumns, gt, inArray, isNotNull, isNull, lt, max, or, sql } from 'drizzle-orm';
import { type AnySQLiteColumn, alias } from 'drizzle-orm/sqlite-core';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '../config.ts';
import type { MergeMethod } from '../domain/pull-request/merge.ts';
import { MAX_RESTARTS, type TaskEvent, type TaskStatus, fromStatuses, nextStatus, transition } from '../domain/task/lifecycle.ts';
import type { Link, LinkKind } from '../domain/task/link.ts';
import type { PrEvent, TaskEventRow, TaskEventType } from '../domain/task/history.ts';
import { EDITABLE_STATUSES, OPEN_STATUSES, type Task, type TaskSummary } from '../domain/task/task.ts';
import type { Orm } from './orm.ts';
import { NOW, atomically } from './sql.ts';
import { plannerRuns, repos, runs, taskEvents, taskLinks, tasks } from './tables.ts';

/** Every column but the prompt, for lists. */
const { prompt: _prompt, ...SUMMARY_COLUMNS } = getColumns(tasks);

/** The task row `t` in the claim and queue queries, which NOT_WAITING refers to by that name. */
const t = alias(tasks, 't');

/**
 * SQL: tasks `d` that a dependent may build on: done, and merged unless their repo has pr_mode off.
 * A done task whose PR isn't opened yet (or failed to open) has pr_url NULL, so it must not count as met.
 * A task a person marked done counts as met unless its PR is open. Mirrors domain/task/link.ts.
 */
const DEPENDENCY_MET = `d.status = 'done' AND (d.pr_state = 'merged'
  OR (d.pr_url IS NULL AND d.pr_state IS NULL AND EXISTS (SELECT 1 FROM repos r WHERE r.id = d.repo_id AND r.pr_mode = 'off'))
  OR (d.done_by = 'person' AND (d.pr_state IS NULL OR d.pr_state <> 'open')))`;
/** SQL: the task row `t` is free to start: every task it builds on is met. After links never hold a start. Mirrors startState. */
const NOT_WAITING = sql.raw(`NOT EXISTS (SELECT 1 FROM task_links l WHERE l.task_id = t.id AND l.kind = 'builds_on'
  AND NOT EXISTS (SELECT 1 FROM tasks d WHERE d.id = l.on_task AND ${DEPENDENCY_MET}))`);

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
      after_task?: number | null;
      /** Links the task starts with; the caller has checked them (a new task can't make a cycle). */
      links?: { on: number; kind: LinkKind }[];
      plan_path?: string | null;
      plan_steps?: string | null;
    }): Task {
      const status = n.status ?? 'queued';
      const links = [...(n.links ?? [])];
      if (n.after_task != null && !links.some((l) => l.on === n.after_task)) links.push({ on: n.after_task, kind: 'builds_on' });
      const first = links.find((l) => l.kind === 'builds_on')?.on ?? null;
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
            after_task: first, // legacy: the sidebar still shows it until it reads links; the links are what count
            plan_path: n.plan_path ?? null,
            plan_steps: n.plan_steps ?? null,
          })
          .run();
        const id = Number(info.lastInsertRowid);
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
    getTask(id: number): Task | undefined {
      // The cast narrows the plain string columns (status, pr_state, …); typed columns come later.
      return orm.select().from(tasks).where(eq(tasks.id, id)).get() as Task | undefined;
    },
    listTasks(): Task[] {
      return orm.select().from(tasks).where(inActiveRepo(tasks.repo_id)).orderBy(desc(tasks.id)).all() as Task[];
    },
    tasksForRepo(repo_id: number, limit = 40): Task[] {
      return orm.select().from(tasks).where(eq(tasks.repo_id, repo_id)).orderBy(desc(tasks.id)).limit(limit).all() as Task[];
    },
    /** Tasks of a repo that still need work or a decision; the planner waits until there are none. */
    countOpen(repo_id: number): number {
      return countWhere(and(eq(tasks.repo_id, repo_id), inArray(tasks.status, OPEN_STATUSES)));
    },
    countRunning(): number {
      return countWhere(inArray(tasks.status, ['running', 'cancel_requested']));
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
        .select({ one: sql`1` })
        .from(t)
        .where(and(eq(t.status, 'queued'), NOT_WAITING, inOpenRepo(t.repo_id)))
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
    /** The tasks that depend on `id` (of one kind, if given), in any status. */
    dependentsOf(id: number, kind?: LinkKind): Task[] {
      return orm
        .select(getColumns(tasks))
        .from(tasks)
        .innerJoin(taskLinks, eq(taskLinks.task_id, tasks.id))
        .where(and(eq(taskLinks.on_task, id), kind ? eq(taskLinks.kind, kind) : undefined))
        .orderBy(asc(tasks.id))
        .all() as Task[];
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
        .select()
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
        .where(and(inArray(t.status, from), NOT_WAITING, inOpenRepo(t.repo_id)))
        .orderBy(desc(t.priority), asc(t.id))
        .limit(1);
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          .set({ status: to, attempts: sql`${tasks.attempts} + 1`, updated_at: sql.raw(NOW) })
          .where(and(inArray(tasks.status, from), eq(tasks.id, next)))
          .returning()
          .get() as Task | undefined;
        // A claim is allowed from one status only (queued), so that is where the task came from.
        if (row) recordEvent(row.id, 'claim', from[0], to);
        return row;
      });
    },
    /**
     * Change a task's editable fields. Guarded by status like every other task write: only a task
     * in EDITABLE_STATUSES can be edited. Returns the task, or undefined if it is missing or in another status.
     */
    editTask(
      id: number,
      fields: Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'model' | 'max_turns' | 'max_attempts' | 'plan_path' | 'plan_steps'>>,
    ): Task | undefined {
      if (Object.keys(fields).length === 0) return this.getTask(id);
      return orm
        .update(tasks)
        .set({ ...given(fields), updated_at: sql.raw(NOW) })
        .where(and(eq(tasks.id, id), inArray(tasks.status, EDITABLE_STATUSES)))
        .returning()
        .get() as Task | undefined;
    },
    /** Where a task's work is checked out. Not a status, so unguarded. */
    setCheckout(id: number, fields: Partial<Pick<Task, 'branch' | 'worktree'>>): void {
      if (Object.keys(fields).length === 0) return;
      orm
        .update(tasks)
        .set({ ...given(fields), updated_at: sql.raw(NOW) })
        .where(eq(tasks.id, id))
        .run();
    },
    /** Whether the daemon may merge the task's PR on its own: 1, 0, or null for the repo's setting. Not a status, so unguarded. */
    setAutoMerge(id: number, value: 0 | 1 | null): Task | undefined {
      return orm
        .update(tasks)
        .set({ auto_merge: value, updated_at: sql.raw(NOW) })
        .where(eq(tasks.id, id))
        .returning()
        .get() as Task | undefined;
    },
    /**
     * Record a change to a task's PR: `pr_state` (and `pr_url` when opened) and a 'pr' history row, together.
     * Guarded on the PR state the change starts from, like every task write: an opened or failed PR replaces anything
     * but an open one (and needs a done task), a close or a sighting only moves an open PR. A merge recorded in
     * between is therefore never undone. Returns false if the task was not in a state the change applies to.
     */
    recordPr(id: number, e: PrEvent): boolean {
      const notOpenAndDone = and(sql`${tasks.pr_state} IS NOT 'open'`, eq(tasks.status, 'done'));
      const isOpen = eq(tasks.pr_state, 'open');
      const [set, guard, reason]: [Partial<typeof tasks.$inferInsert>, SQL | undefined, string] =
        e.type === 'opened'
          ? [{ pr_url: e.url, pr_state: 'open' }, notOpenAndDone, `opened ${e.url}`]
          : e.type === 'failed'
            ? [{ pr_state: 'failed' }, notOpenAndDone, `could not open the PR: ${e.error}`]
            : e.type === 'closed'
              ? [{ pr_state: 'closed' }, isOpen, 'closed without merging']
              : [{ pr_state: e.state }, and(isOpen, sql`${e.state} <> 'open'`), `PR is ${e.state}`];
      return atomically(db, () => {
        const row = orm
          .update(tasks)
          .set({ ...set, updated_at: sql.raw(NOW) })
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
    recordMerge(id: number, method: MergeMethod, reason: string): boolean {
      return atomically(db, () => {
        const res = orm
          .update(tasks)
          .set({ pr_state: 'merged', merge_method: method, updated_at: sql.raw(NOW) })
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
          .set({ updated_at: sql.raw(NOW) })
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
          .set({ updated_at: sql.raw(NOW) })
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
        .select({ one: sql`1` })
        .from(e)
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
     * undefined if the task is missing or the event isn't allowed.
     */
    applyEvent(id: number, event: TaskEvent, opts: { reason?: string | null; needs?: string | null } = {}): Task | undefined {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = this.getTask(id);
        if (!cur) return undefined;
        const next = transition(cur, event, opts);
        if (!next) return undefined;
        const row = atomically(db, () => {
          // Guarded on the status and on the counters the changes were computed from.
          const row = orm
            .update(tasks)
            .set({ status: next.to, ...given(next.changes), updated_at: sql.raw(NOW) })
            .where(and(eq(tasks.id, id), eq(tasks.status, cur.status), eq(tasks.attempts, cur.attempts), eq(tasks.restarts, cur.restarts)))
            .returning()
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
     * Returns how many were requeued and the ids of those failed.
     */
    recoverOrphans(): { requeued: number; failed: number[] } {
      orm
        .update(runs)
        .set({ ended_at: sql.raw(NOW), outcome: 'failed', result_text: 'daemon restarted' })
        .where(isNull(runs.ended_at))
        .run();
      orm
        .update(plannerRuns)
        .set({ ended_at: sql.raw(NOW), outcome: 'failed', note: 'daemon restarted' })
        .where(isNull(plannerRuns.ended_at))
        .run();
      let requeued = 0;
      const failed: number[] = [];
      const orphans = orm
        .select({ id: tasks.id, restarts: tasks.restarts })
        .from(tasks)
        .where(inArray(tasks.status, ['running', 'cancel_requested']))
        .all();
      for (const o of orphans) {
        const exhausted = o.restarts + 1 >= MAX_RESTARTS;
        const reason = `the daemon restarted ${o.restarts + 1} times while this task was running`;
        const task = this.applyEvent(o.id, { type: 'recover', exhausted }, { reason });
        if (task?.status === 'queued') requeued++;
        else if (task?.status === 'failed') failed.push(task.id);
      }
      return { requeued, failed };
    },
  };
}
