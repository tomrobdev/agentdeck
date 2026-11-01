// Plans: stored in AgentDeck per task, named after the task they belong to (`112-plans-in-agentdeck.html`). A task
// follows its linked plan (plan_task) or else its own; each run gets it in the worktree's plan file and gives it back.
import { readPlanFile, writePlanFile } from '../adapters/plan-file.ts';
import type { Db } from '../db/index.ts';
import type { OwnPlan } from '../db/plans.ts';
import { PLAN_LIMIT, type ParsedPlan, type TaskPlan, linkedSteps, mergePlanSteps, parsePlan } from '../domain/plan/plan.ts';
import type { PrPlan } from '../domain/pull-request/pr.ts';
import type { PromptPlan } from '../domain/run/prompt.ts';
import { type Task, planStepIds } from '../domain/task/task.ts';
import { ActionError, object, requireTask } from './input.ts';

/** HTML a person gives as a plan: refused unless it is a plan and small enough. */
export function readPlanInput(html: unknown): { html: string; plan: ParsedPlan } {
  if (typeof html !== 'string' || !html.trim()) throw new ActionError('the plan is empty');
  if (Buffer.byteLength(html) > PLAN_LIMIT) throw new ActionError(`a plan can be at most ${PLAN_LIMIT / 1024} KB`);
  const plan = parsePlan(html);
  if (!plan) throw new ActionError('not an AgentDeck plan: its <html> tag needs data-agentdeck-plan="1" (see docs/plan-format.md)');
  return { html, plan };
}

/** The plan a task follows: the linked task's plan, or else its own. `steps` are the linked step ids, null for every step. */
export function followedPlan(db: Db, task: Pick<Task, 'id' | 'plan_task' | 'plan_steps'>): (OwnPlan & { steps: string[] | null }) | null {
  if (task.plan_task !== null) {
    const plan = db.ownPlan(task.plan_task);
    return plan ? { ...plan, steps: planStepIds(task) } : null;
  }
  const own = db.ownPlan(task.id);
  return own ? { ...own, steps: null } : null;
}

/** The plan a run follows, for its prompt. A linked plan that is gone comes back with html null. */
export function planForRun(db: Db, task: Task): PromptPlan | null {
  const plan = followedPlan(db, task);
  if (plan) return { name: plan.name, html: plan.html, steps: plan.steps };
  return task.plan_task !== null ? { name: `#${task.plan_task}'s plan`, html: null, steps: planStepIds(task) } : null;
}

/** Put the run's plan in the worktree's plan file (or clear the file when there is none), for the worker to update. */
export async function putPlanFile(worktree: string, plan: PromptPlan | null): Promise<void> {
  await writePlanFile(worktree, plan?.html ?? null);
}

/**
 * After a run, whatever its outcome: store what the worker left in the plan file. A task that follows a plan writes back
 * only its linked steps (mergePlanSteps), since sibling tasks on that plan may be running too; one that follows its own
 * plan with no other task on it keeps the whole file. A task with no plan that wrote one gets it as its own plan.
 * Returns whether a plan changed.
 */
export async function takePlanFile(db: Db, task: Task, worktree: string): Promise<boolean> {
  const written = await readPlanFile(worktree);
  // From here on no await: the read, merge and write of the stored plan happen in one go.
  if (written === null || Buffer.byteLength(written) > PLAN_LIMIT || !parsePlan(written)) return false;
  const plan = followedPlan(db, task);
  if (plan) {
    const whole = task.plan_task === null && !db.planShared(task.id);
    const html = whole ? written : mergePlanSteps(plan.html, written, plan.steps);
    if (html === plan.html) return false;
    db.updatePlanHtml(plan.id, html);
    return true;
  }
  if (task.plan_task !== null) return false; // linked to a plan that is gone: nothing to write back into
  db.saveOwnPlan(task.id, written, 'worker');
  return true;
}

/** The linked steps of the plan a task follows, as AgentDeck stores them. Null when it follows none. */
export function followedSteps(db: Db, task: Task): ReturnType<typeof linkedSteps> {
  const plan = followedPlan(db, task);
  return plan && linkedSteps(plan.html, plan.steps);
}

/** The plan a task follows and its linked steps, for the PR body. Null when it follows none. */
export function prPlanFor(db: Db, task: Task): PrPlan | null {
  const plan = followedPlan(db, task);
  const steps = plan && linkedSteps(plan.html, plan.steps);
  return plan && steps ? { name: plan.name, steps } : null;
}

/** The plans a task shows: the plan it follows when that belongs to another task, then its own, oldest first. */
export function plansShown(db: Db, task: Pick<Task, 'id' | 'plan_task'>): TaskPlan[] {
  const own = db.plansForTask(task.id);
  if (task.plan_task === null || task.plan_task === task.id) return own;
  const linked = db.ownPlan(task.plan_task);
  const shown = linked && db.plansForTask(task.plan_task).find((p) => p.id === linked.id);
  return shown ? [shown, ...own] : own;
}

/** Store or replace a task's own plan, under its numbered name (`<task id>-<slug>.html`). */
export function attachPlan(db: Db, id: number, input: { html?: unknown }): TaskPlan {
  requireTask(db, id);
  const { html } = readPlanInput(object(input).html);
  return db.saveOwnPlan(id, html, 'attached');
}

/** One plan's HTML, for the dashboard to show in full. */
export function planHtml(db: Db, id: number, planId: number): { html: string } {
  const html = db.planHtml(id, planId);
  if (html === undefined) throw new ActionError('no such plan');
  return { html };
}
