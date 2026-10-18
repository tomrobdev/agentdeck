// Planner runs: one row per planner claude process.
import type { DatabaseSync } from 'node:sqlite';
import type { PlannerRun } from '../domain/planner/plan.ts';
import { NOW } from './sql.ts';

export function plannerRunStore(db: DatabaseSync) {
  return {
    startPlannerRun(repo_id: number, log_path: string): number {
      db.prepare(`UPDATE repos SET planned_at = ${NOW} WHERE id = ?`).run(repo_id);
      return Number(db.prepare('INSERT INTO planner_runs (repo_id, log_path) VALUES (?, ?)').run(repo_id, log_path).lastInsertRowid);
    },
    setPlannerRunPid(id: number, pid: number): void {
      db.prepare('UPDATE planner_runs SET pid = ? WHERE id = ?').run(pid, id);
    },
    finishPlannerRun(id: number, outcome: string, proposed: number, note: string | null): void {
      db.prepare(`UPDATE planner_runs SET ended_at = ${NOW}, outcome = ?, proposed = ?, note = ? WHERE id = ?`).run(
        outcome,
        proposed,
        note,
        id,
      );
    },
    plannerRuns(repo_id?: number, limit = 10): PlannerRun[] {
      return (repo_id
        ? db.prepare('SELECT * FROM planner_runs WHERE repo_id = ? ORDER BY id DESC LIMIT ?').all(repo_id, limit)
        : db.prepare('SELECT * FROM planner_runs ORDER BY id DESC LIMIT ?').all(limit)) as unknown as PlannerRun[];
    },
  };
}
