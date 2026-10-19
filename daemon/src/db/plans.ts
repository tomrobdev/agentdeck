// Plans attached to tasks: the HTML as written, parsed into steps when read.
import type { DatabaseSync } from 'node:sqlite';
import { type PlanSource, type TaskPlan, parsePlan } from '../domain/plan/plan.ts';
import { NOW, atomically } from './sql.ts';

interface PlanRow {
  id: number;
  task_id: number;
  name: string;
  source: PlanSource;
  html: string;
  created_at: string;
  updated_at: string;
}

/** A row as the API shows it. A row that no longer parses (it always did when saved) reads as untitled. */
function toPlan({ html, ...row }: PlanRow): TaskPlan {
  return { ...row, ...(parsePlan(html) ?? { version: '1', title: 'Untitled plan', summary: null, steps: [] }) };
}

export function planStore(db: DatabaseSync) {
  /** Insert or replace by name; updated_at moves only when the HTML changed. */
  const upsert = (task_id: number, name: string, source: PlanSource, html: string) =>
    db
      .prepare(
        `INSERT INTO task_plans (task_id, name, source, html) VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id, name) DO UPDATE SET source = excluded.source, html = excluded.html, updated_at = ${NOW}
         WHERE task_plans.html IS NOT excluded.html OR task_plans.source IS NOT excluded.source`,
      )
      .run(task_id, name, source, html);

  return {
    savePlan(task_id: number, name: string, source: PlanSource, html: string): void {
      upsert(task_id, name, source, html);
    },
    /** Make the task's branch plans exactly `plans`: upsert each, drop branch plans no longer there. */
    replaceBranchPlans(task_id: number, plans: { name: string; html: string }[]): void {
      atomically(db, () => {
        for (const p of plans) upsert(task_id, p.name, 'branch', p.html);
        const keep = plans.map((p) => p.name);
        db.prepare(
          `DELETE FROM task_plans WHERE task_id = ? AND source = 'branch' AND name NOT IN (${keep.map(() => '?').join(', ')})`,
        ).run(task_id, ...keep);
      });
    },
    /** The task's plans, oldest first, without their HTML. */
    plansForTask(task_id: number): TaskPlan[] {
      return (db.prepare('SELECT * FROM task_plans WHERE task_id = ? ORDER BY id').all(task_id) as unknown as PlanRow[]).map(toPlan);
    },
    planHtml(task_id: number, id: number): string | undefined {
      return (db.prepare('SELECT html FROM task_plans WHERE task_id = ? AND id = ?').get(task_id, id) as { html: string } | undefined)
        ?.html;
    },
  };
}
