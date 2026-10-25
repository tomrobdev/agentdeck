// Task runs: one row per worker claude process.
import type { DatabaseSync } from 'node:sqlite';
import type { Run, RunKind } from '../domain/run/run.ts';
import { NOW } from './sql.ts';

export function runStore(db: DatabaseSync) {
  return {
    startRun(task_id: number, attempt: number, log_path: string, kind: RunKind = 'work'): number {
      const info = db
        .prepare('INSERT INTO runs (task_id, attempt, log_path, kind) VALUES (?, ?, ?, ?)')
        .run(task_id, attempt, log_path, kind);
      return Number(info.lastInsertRowid);
    },
    setRunPid(id: number, pid: number): void {
      db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, id);
    },
    finishRun(id: number, r: Partial<Omit<Run, 'id' | 'task_id' | 'kind' | 'attempt' | 'started_at' | 'log_path'>>): void {
      const keys = Object.keys(r) as (keyof typeof r)[];
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE runs SET ${sets}${keys.length ? ', ' : ''}ended_at = ${NOW} WHERE id = ?`).run(
        ...keys.map((k) => r[k] ?? null),
        id,
      );
    },
    runsForTask(task_id: number): Run[] {
      return db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id').all(task_id) as unknown as Run[];
    },
    /** Resolve runs still going, in any daemon process. */
    countRunningResolves(): number {
      return Number((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'resolve' AND ended_at IS NULL").get() as { n: number }).n);
    },
    /**
     * Slots in use, counted from the db so every process sees the same number: a task that is running (or being
     * cancelled), a task not running that has an unfinished resolve run (a task whose sync started one counts once),
     * and an unfinished planner run. A clean sync runs no claude and takes none.
     */
    slotsUsed(): number {
      const row = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM tasks WHERE status IN ('running', 'cancel_requested'))
             + (SELECT COUNT(*) FROM tasks t WHERE t.status NOT IN ('running', 'cancel_requested')
                  AND EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.kind = 'resolve' AND r.ended_at IS NULL))
             + (SELECT COUNT(*) FROM planner_runs WHERE ended_at IS NULL) AS n`,
        )
        .get() as { n: number };
      return Number(row.n);
    },
    /** Whether a resolve run of this task has not finished. */
    hasRunningResolve(task_id: number): boolean {
      return !!db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND kind = 'resolve' AND ended_at IS NULL LIMIT 1").get(task_id);
    },
    /** Claude processes recorded on runs that never finished: a previous daemon died mid-run. */
    unfinishedPids(): { pid: number; started_at: string }[] {
      return db
        .prepare(
          `SELECT pid, started_at FROM runs WHERE ended_at IS NULL AND pid IS NOT NULL
           UNION ALL SELECT pid, started_at FROM planner_runs WHERE ended_at IS NULL AND pid IS NOT NULL`,
        )
        .all() as never;
    },
  };
}
