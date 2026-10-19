// Plans attached to a task: collected from its branch after each run, or attached by a person.
import type { Db } from '../db/index.ts';
import { PLAN_LIMIT, type TaskPlan, isPlanPath, parsePlan, planName } from '../domain/plan/plan.ts';
import { ActionError } from './errors.ts';
import { taskChanges, taskFile } from './files.ts';

/**
 * Read the plans the task's branch added or changed under docs/plans/ and store them, dropping
 * branch plans that are gone. HTML files without the plan marker are not plans and are skipped.
 */
export async function collectPlans(db: Db, id: number): Promise<TaskPlan[]> {
  const { files } = await taskChanges(db, id);
  const found: { name: string; html: string }[] = [];
  for (const f of files) {
    if (f.status === 'D' || f.binary || !isPlanPath(f.path)) continue;
    const file = await taskFile(db, id, 'head', f.path);
    if (file.text === null || file.truncated || file.size > PLAN_LIMIT || !parsePlan(file.text)) continue;
    found.push({ name: f.path, html: file.text });
  }
  db.replaceBranchPlans(id, found);
  return db.plansForTask(id);
}

/** Attach a plan written anywhere (a file, another session) to a task. Same name replaces it. */
export function attachPlan(db: Db, id: number, input: { name?: unknown; html?: unknown }): TaskPlan {
  if (!db.getTask(id)) throw new ActionError('no such task');
  if (typeof input.html !== 'string' || !input.html.trim()) throw new ActionError('html is required');
  if (Buffer.byteLength(input.html) > PLAN_LIMIT) throw new ActionError(`a plan can be at most ${PLAN_LIMIT / 1024} KB`);
  if (!parsePlan(input.html)) {
    throw new ActionError('not an AgentDeck plan: its <html> tag needs data-agentdeck-plan="1" (see docs/plan-format.md)');
  }
  const name = planName(typeof input.name === 'string' ? input.name : '');
  db.savePlan(id, name, 'attached', input.html);
  return db.plansForTask(id).find((p) => p.name === name)!;
}

/** One plan's HTML, for the dashboard to show in full. */
export function planHtml(db: Db, id: number, planId: number): { html: string } {
  const html = db.planHtml(id, planId);
  if (html === undefined) throw new ActionError('no such plan');
  return { html };
}
