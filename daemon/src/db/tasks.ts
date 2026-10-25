// Tasks. Every status change goes through applyEvent (or claimNextTask), guarded by the current status.
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '../config.ts';
import type { MergeMethod } from '../domain/pull-request/merge.ts';
import { MAX_RESTARTS, type TaskEvent, type TaskStatus, fromStatuses, nextStatus } from '../domain/task/lifecycle.ts';
import type { TaskEventRow, TaskEventType } from '../domain/task/history.ts';
import { EDITABLE_STATUSES, OPEN_STATUSES, type Task, type TaskSummary } from '../domain/task/task.ts';
import { NOW, atomically } from './sql.ts';

const SUMMARY_COLUMNS =
  'id, repo_id, title, status, priority, model, max_turns, attempts, max_attempts, branch, worktree, stop_reason, source, restarts, pr_url, pr_state, merge_method, after_task, plan_path, plan_steps, needs, done_by, created_at, updated_at';

/** SQL list of fixed status literals, for `status IN (…)`. */
const statusList = (statuses: TaskStatus[]) => statuses.map((s) => `'${s}'`).join(', ');
const OPEN = statusList(OPEN_STATUSES);

/** SQL: the repo id column `col` belongs to a repo that isn't archived. Archived repos' tasks are left out of every list and count. */
const IN_ACTIVE_REPO = (col: string) => `${col} IN (SELECT id FROM repos WHERE archived_at IS NULL)`;

/**
 * SQL: tasks `d` that a dependent may build on: done, and merged unless their repo has pr_mode off.
 * A done task whose PR isn't opened yet (or failed to open) has pr_url NULL, so it must not count as met.
 * A task a person marked done counts as met unless its PR is open. Mirrors domain/task/dependency.ts.
 */
const DEPENDENCY_MET = `d.status = 'done' AND (d.pr_state = 'merged'
  OR (d.pr_url IS NULL AND d.pr_state IS NULL AND EXISTS (SELECT 1 FROM repos r WHERE r.id = d.repo_id AND r.pr_mode = 'off'))
  OR (d.done_by = 'person' AND (d.pr_state IS NULL OR d.pr_state <> 'open')))`;
/** SQL: the task row `t` is free to start (it has no dependency, or the dependency is met). */
const NOT_WAITING = `(t.after_task IS NULL OR EXISTS (SELECT 1 FROM tasks d WHERE d.id = t.after_task AND ${DEPENDENCY_MET}))`;

export function taskStore(db: DatabaseSync) {
  /** Append to a task's history. Callers run it in the same `atomically` block as the status change. */
  const recordEvent = (task_id: number, type: TaskEventType, from: TaskStatus | null, to: TaskStatus, reason: string | null = null) =>
    db
      .prepare('INSERT INTO task_events (task_id, type, from_status, to_status, reason) VALUES (?, ?, ?, ?, ?)')
      .run(task_id, type, from, to, reason);

  return {
    addTask(t: {
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
      plan_path?: string | null;
      plan_steps?: string | null;
    }): Task {
      const status = t.status ?? 'queued';
      const id = atomically(db, () => {
        const info = db
          .prepare(
            'INSERT INTO tasks (repo_id, title, prompt, priority, model, max_turns, max_attempts, status, source, after_task, plan_path, plan_steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            t.repo_id,
            t.title,
            t.prompt,
            t.priority ?? 0,
            t.model ?? DEFAULTS.model,
            t.max_turns ?? DEFAULTS.maxTurns,
            t.max_attempts ?? DEFAULTS.maxAttempts,
            status,
            t.source ?? 'manual',
            t.after_task ?? null,
            t.plan_path ?? null,
            t.plan_steps ?? null,
          );
        const id = Number(info.lastInsertRowid);
        recordEvent(id, 'created', null, status);
        return id;
      });
      return this.getTask(id)!;
    },
    /** A task's status changes, oldest first. Tasks from before migration step 6 have none. */
    eventsForTask(task_id: number): TaskEventRow[] {
      return db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id').all(task_id) as unknown as TaskEventRow[];
    },
    getTask(id: number): Task | undefined {
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    },
    listTasks(): Task[] {
      return db.prepare(`SELECT * FROM tasks WHERE ${IN_ACTIVE_REPO('repo_id')} ORDER BY id DESC`).all() as unknown as Task[];
    },
    tasksForRepo(repo_id: number, limit = 40): Task[] {
      return db.prepare('SELECT * FROM tasks WHERE repo_id = ? ORDER BY id DESC LIMIT ?').all(repo_id, limit) as unknown as Task[];
    },
    /** Tasks of a repo that still need work or a decision; the planner waits until there are none. */
    countOpen(repo_id: number): number {
      return (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE repo_id = ? AND status IN (${OPEN})`).get(repo_id) as { n: number }).n;
    },
    countRunning(): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running', 'cancel_requested')").get() as { n: number }).n;
    },
    /** How many tasks are in each status (statuses with none are left out). */
    countByStatus(): Record<string, number> {
      const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE ${IN_ACTIVE_REPO('repo_id')} GROUP BY status`).all() as {
        status: string;
        n: number;
      }[];
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
    /** Done tasks whose pull request is open: the ones waiting for a review. */
    countReview(): number {
      return (
        db
          .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND pr_state = 'open' AND ${IN_ACTIVE_REPO('repo_id')}`)
          .get() as {
          n: number;
        }
      ).n;
    },
    /** Whether a task could be claimed: queued, not waiting on a dependency, in a repo that isn't paused. */
    hasQueued(): boolean {
      const row = db
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.status = 'queued' AND ${NOT_WAITING}
             AND t.repo_id IN (SELECT id FROM repos WHERE paused_reason IS NULL AND archived_at IS NULL)) AS q`,
        )
        .get() as { q: number };
      return row.q === 1;
    },
    /**
     * Tasks without their prompt, newest first. Returns the `limit` newest tasks older than `before`
     * (all tasks when omitted). On the first page (no `before`) every active task is included on top
     * of the limit, so views of in-flight work stay complete. Later pages hold older tasks only.
     */
    listTaskSummaries(opts: { status?: TaskStatus; limit: number; before?: number }): TaskSummary[] {
      const { status = null, limit, before = null } = opts;
      return db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM tasks
           WHERE (? IS NULL OR status = ?) AND ${IN_ACTIVE_REPO('repo_id')}
             AND (id IN (SELECT id FROM tasks WHERE (? IS NULL OR status = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?)
                  OR (? IS NULL AND status IN (${OPEN})))
           ORDER BY id DESC`,
        )
        .all(status, status, status, status, before, before, limit, before) as unknown as TaskSummary[];
    },
    /** Queued tasks that wait on `id` with `--after`. */
    dependentsOf(id: number): Task[] {
      return db.prepare("SELECT * FROM tasks WHERE after_task = ? AND status = 'queued' ORDER BY id").all(id) as unknown as Task[];
    },
    /**
     * Tasks whose pull request is still open, for the state refresh: done ones, and blocked or failed ones
     * (a conflict blocks a done task and keeps its PR; a retry that fails keeps it too).
     */
    openPrTasks(): Task[] {
      return db
        .prepare(
          `SELECT * FROM tasks WHERE status IN ('done', 'blocked', 'failed') AND pr_url IS NOT NULL AND pr_state = 'open' AND ${IN_ACTIVE_REPO('repo_id')}`,
        )
        .all() as unknown as Task[];
    },
    /**
     * Atomically claim the next queued task of a repo that isn't paused, or undefined if none.
     * A task with `after_task` waits until that task is done and, if it has a PR, the PR is merged.
     */
    claimNextTask(): Task | undefined {
      const from = fromStatuses({ type: 'claim' });
      const marks = from.map(() => '?').join(', ');
      const to = nextStatus(from[0], { type: 'claim' })!;
      return atomically(db, () => {
        const row = db
          .prepare(
            `UPDATE tasks SET status = ?, attempts = attempts + 1, updated_at = ${NOW}
             WHERE status IN (${marks})
               AND id = (SELECT t.id FROM tasks t WHERE t.status IN (${marks}) AND ${NOT_WAITING}
                           AND t.repo_id IN (SELECT id FROM repos WHERE paused_reason IS NULL AND archived_at IS NULL)
                         ORDER BY t.priority DESC, t.id LIMIT 1)
             RETURNING *`,
          )
          .get(to, ...from, ...from) as Task | undefined;
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
      const keys = Object.keys(fields) as (keyof typeof fields)[];
      if (keys.length === 0) return this.getTask(id);
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      return db
        .prepare(
          `UPDATE tasks SET ${sets}, updated_at = ${NOW}
           WHERE id = ? AND status IN (${statusList(EDITABLE_STATUSES)}) RETURNING *`,
        )
        .get(...keys.map((k) => fields[k] ?? null), id) as Task | undefined;
    },
    updateTask(
      id: number,
      fields: Partial<Pick<Task, 'branch' | 'worktree' | 'stop_reason' | 'priority' | 'pr_url' | 'pr_state' | 'merge_method'>>,
    ): void {
      const keys = Object.keys(fields) as (keyof typeof fields)[];
      if (keys.length === 0) return;
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE tasks SET ${sets}, updated_at = ${NOW} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    },
    /**
     * Record that a done task's PR was merged: the PR state, the method and a history row, together.
     * Guarded like every task write: only a done task whose PR is open. Returns false if it was not.
     */
    recordMerge(id: number, method: MergeMethod, reason: string): boolean {
      return atomically(db, () => {
        const res = db
          .prepare(
            `UPDATE tasks SET pr_state = 'merged', merge_method = ?, updated_at = ${NOW}
             WHERE id = ? AND status = 'done' AND pr_state = 'open'`,
          )
          .run(method, id);
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
        const row = db
          .prepare(`UPDATE tasks SET updated_at = ${NOW} WHERE id = ? AND status IN ('running', 'done') RETURNING status`)
          .get(id) as { status: TaskStatus } | undefined;
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
        const res = db.prepare(`UPDATE tasks SET updated_at = ${NOW} WHERE id = ? AND status = 'running'`).run(id);
        if (!Number(res.changes)) return false;
        recordEvent(id, 'plan_unfinished', 'running', 'running', reason);
        return true;
      });
    },
    /** Done tasks whose latest run left linked plan steps unfinished: the ids, for the list's badge. */
    planUnfinishedIds(): Set<number> {
      const rows = db
        .prepare(
          `SELECT t.id FROM tasks t WHERE t.status = 'done' AND ${IN_ACTIVE_REPO('t.repo_id')} AND EXISTS (
             SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.type = 'plan_unfinished'
               AND e.id > COALESCE((SELECT MAX(c.id) FROM task_events c WHERE c.task_id = t.id AND c.type = 'claim'), 0))`,
        )
        .all() as { id: number }[];
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
        const to = nextStatus(cur.status, event);
        if (!to) return undefined;
        const environment = event.type === 'finish' && event.outcome === 'blocked' && event.environment === true;
        const sets = ['status = ?'];
        const params: (string | number | null)[] = [to];
        if (to !== 'cancelled') {
          const give = 'attempts = MAX(attempts - 1, 0)';
          if (event.type === 'claim') sets.push('attempts = attempts + 1');
          else if (event.type === 'retry')
            sets.push('max_attempts = attempts + 1'); // one more attempt on top of those used
          else if (event.type === 'rate_limited' || environment) sets.push(give);
          else if (event.type === 'recover') sets.push('restarts = restarts + 1', ...(to === 'queued' ? [give] : []));
          if ((event.type === 'finish' && event.outcome === 'done') || event.type === 'mark_done' || event.type === 'pr_merged')
            sets.push('stop_reason = NULL');
          if (event.type === 'mark_done' || event.type === 'pr_merged') sets.push('needs = NULL');
          if (event.type === 'mark_done') sets.push("done_by = 'person'");
          else if (cur.status === 'done') sets.push('done_by = NULL');
          if (to === 'queued') sets.push('needs = NULL');
          else if (event.type === 'finish' && event.outcome === 'blocked') {
            sets.push('needs = ?');
            params.push(opts.needs ?? null);
          }
          if (
            (event.type === 'finish' && (event.outcome === 'blocked' || event.outcome === 'failed')) ||
            (event.type === 'recover' && to === 'failed') ||
            event.type === 'conflict'
          ) {
            sets.push('stop_reason = ?');
            params.push(opts.reason ?? null);
          }
        }
        const row = atomically(db, () => {
          const row = db
            .prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ${NOW} WHERE id = ? AND status IN (?) RETURNING *`)
            .get(...params, id, cur.status) as Task | undefined;
          if (row) recordEvent(id, environment ? 'environment_block' : event.type, cur.status, to, opts.reason ?? null);
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
      db.prepare(`UPDATE runs SET ended_at = ${NOW}, outcome = 'failed', result_text = 'daemon restarted' WHERE ended_at IS NULL`).run();
      db.prepare(`UPDATE planner_runs SET ended_at = ${NOW}, outcome = 'failed', note = 'daemon restarted' WHERE ended_at IS NULL`).run();
      let requeued = 0;
      const failed: number[] = [];
      const orphans = db.prepare("SELECT id, restarts FROM tasks WHERE status IN ('running', 'cancel_requested')").all() as {
        id: number;
        restarts: number;
      }[];
      for (const o of orphans) {
        const exhausted = o.restarts + 1 >= MAX_RESTARTS;
        const reason = `the daemon restarted ${o.restarts + 1} times while this task was running`;
        const t = this.applyEvent(o.id, { type: 'recover', exhausted }, { reason });
        if (t?.status === 'queued') requeued++;
        else if (t?.status === 'failed') failed.push(t.id);
      }
      return { requeued, failed };
    },
  };
}
