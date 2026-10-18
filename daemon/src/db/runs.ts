// Task runs: one row per worker claude process.
import type { DatabaseSync } from 'node:sqlite';
import type { Run } from '../domain/run/run.ts';
import { NOW } from './sql.ts';

export function runStore(db: DatabaseSync) {
  return {
    startRun(task_id: number, attempt: number, log_path: string): number {
      const info = db.prepare('INSERT INTO runs (task_id, attempt, log_path) VALUES (?, ?, ?)').run(task_id, attempt, log_path);
      return Number(info.lastInsertRowid);
    },
    setRunPid(id: number, pid: number): void {
      db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, id);
    },
    finishRun(id: number, r: Partial<Omit<Run, 'id' | 'task_id' | 'attempt' | 'started_at' | 'log_path'>>): void {
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
