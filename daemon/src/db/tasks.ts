// Tasks. Every status change goes through applyEvent (or claimNextTask), guarded by the current status.
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '../config.ts';
import { MAX_RESTARTS, type TaskEvent, type TaskStatus, fromStatuses, nextStatus } from '../domain/task/lifecycle.ts';
import type { TaskEventRow, TaskEventType } from '../domain/task/history.ts';
import { EDITABLE_STATUSES, OPEN_STATUSES, type Task, type TaskSummary } from '../domain/task/task.ts';
import { NOW, atomically } from './sql.ts';

const SUMMARY_COLUMNS =
  'id, repo_id, title, status, priority, model, max_turns, attempts, max_attempts, branch, worktree, blocked_reason, source, restarts, pr_url, pr_state, after_task, created_at, updated_at';

/** SQL list of fixed status literals, for `status IN (…)`. */
const statusList = (statuses: TaskStatus[]) => statuses.map((s) => `'${s}'`).join(', ');
const OPEN = statusList(OPEN_STATUSES);

/** SQL: tasks `d` that a dependent may build on: done, and merged if they have a PR. Mirrors domain/task/dependency.ts. */
const DEPENDENCY_MET = "d.status = 'done' AND (d.pr_url IS NULL OR d.pr_state = 'merged')";
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
    }): Task {
      const status = t.status ?? 'queued';
      const id = atomically(db, () => {
        const info = db
          .prepare(
            'INSERT INTO tasks (repo_id, title, prompt, priority, model, max_turns, max_attempts, status, source, after_task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all() as unknown as Task[];
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
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as { status: string; n: number }[];
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
    /** Whether a task could be claimed: queued, not waiting on a dependency, in a repo that isn't paused. */
    hasQueued(): boolean {
      const row = db
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.status = 'queued' AND ${NOT_WAITING}
             AND t.repo_id IN (SELECT id FROM repos WHERE paused_reason IS NULL)) AS q`,
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
           WHERE (? IS NULL OR status = ?)
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
    /** Done tasks whose pull request is still open, for the state refresh. */
    openPrTasks(): Task[] {
      return db
        .prepare("SELECT * FROM tasks WHERE status = 'done' AND pr_url IS NOT NULL AND pr_state = 'open'")
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
                           AND t.repo_id IN (SELECT id FROM repos WHERE paused_reason IS NULL)
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
      fields: Partial<Pick<Task, 'title' | 'prompt' | 'priority' | 'model' | 'max_turns' | 'max_attempts'>>,
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
      fields: Partial<Pick<Task, 'branch' | 'worktree' | 'blocked_reason' | 'priority' | 'pr_url' | 'pr_state'>>,
    ): void {
      const keys = Object.keys(fields) as (keyof typeof fields)[];
      if (keys.length === 0) return;
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE tasks SET ${sets}, updated_at = ${NOW} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    },
    /**
     * The only way to change a task's status. Asks the lifecycle whether `event` is allowed from the
     * task's current status and writes the result guarded by that status, so a concurrent change
     * (say, a cancel arriving as a run finishes) is never overwritten. Returns the updated task, or
     * undefined if the task is missing or the event isn't allowed.
     */
    applyEvent(id: number, event: TaskEvent, opts: { reason?: string | null } = {}): Task | undefined {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = this.getTask(id);
        if (!cur) return undefined;
        const to = nextStatus(cur.status, event);
        if (!to) return undefined;
        const sets = ['status = ?'];
        const params: (string | number | null)[] = [to];
        if (to !== 'cancelled') {
          const give = 'attempts = MAX(attempts - 1, 0)';
          if (event.type === 'claim') sets.push('attempts = attempts + 1');
          else if (event.type === 'retry')
            sets.push('max_attempts = attempts + 1'); // one more attempt on top of those used
          else if (event.type === 'rate_limited') sets.push(give);
          else if (event.type === 'recover') sets.push('restarts = restarts + 1', ...(to === 'queued' ? [give] : []));
          if (event.type === 'finish' && event.outcome === 'done') sets.push('blocked_reason = NULL');
          if (
            (event.type === 'finish' && (event.outcome === 'blocked' || event.outcome === 'failed')) ||
            (event.type === 'recover' && to === 'failed')
          ) {
            sets.push('blocked_reason = ?');
            params.push(opts.reason ?? null);
          }
        }
        const row = atomically(db, () => {
          const row = db
            .prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ${NOW} WHERE id = ? AND status IN (?) RETURNING *`)
            .get(...params, id, cur.status) as Task | undefined;
          if (row) recordEvent(id, event.type, cur.status, to, opts.reason ?? null);
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
