// Plans: stored in AgentDeck per task, named after the task they belong to (`112-plans-in-agentdeck.html`). A task
// follows its linked plan (plan_task) or else its own; each run gets it in the worktree's plan file and gives it back.
import { readGivenPlan, readPlanFile, writeGivenPlan, writePlanFile } from '../adapters/plan-file.ts';
import type { Db } from '../db/index.ts';
import type { OwnPlan } from '../db/plans.ts';
import {
  PLAN_LIMIT,
  type ParsedPlan,
  type TaskPlan,
  linkedSteps,
  missingFollowedSteps,
  parsePlan,
  planAfterRun,
} from '../domain/plan/plan.ts';
import type { PrPlan } from '../domain/pull-request/pr.ts';
import type { PromptPlan } from '../domain/run/prompt.ts';
import { EDITABLE_STATUSES, type Task, planStepIds } from '../domain/task/task.ts';
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

/**
 * Put the run's plan in the worktree's plan file (or clear the file when there is none), for the worker to update,
 * with a copy of it as given to the run beside it.
 */
export async function putPlanFile(worktree: string, plan: PromptPlan | null): Promise<void> {
  await writePlanFile(worktree, plan?.html ?? null);
}

/**
 * After a run, whatever its outcome, and before the next run of a task whose last run a restart cut off: store what the
 * worker left in the plan file. What the stored plan becomes is planAfterRun's to decide: the whole file, or only the
 * linked steps the run changed. A task with no plan that wrote one gets it as its own plan. What was taken is then
 * recorded as the given copy, so taking the same file again changes nothing. Returns whether a plan changed.
 */
export async function takePlanFile(db: Db, task: Task, worktree: string): Promise<boolean> {
  const [written, given] = await Promise.all([readPlanFile(worktree), readGivenPlan(worktree)]);
  if (written === null || Buffer.byteLength(written) > PLAN_LIMIT || !parsePlan(written)) return false;
  const changed = storeWrittenPlan(db, task, written, given);
  await writeGivenPlan(worktree, written);
  return changed;
}

/** Store a plan file a run left: no await, so the read, merge and write of the stored plan happen in one go. */
function storeWrittenPlan(db: Db, task: Task, written: string, given: string | null): boolean {
  const plan = followedPlan(db, task);
  if (plan) {
    const own = task.plan_task === null || task.plan_task === task.id;
    const html = planAfterRun({ stored: plan.html, given, written, ids: plan.steps, own, followed: own && db.planShared(task.id) });
    if (html === plan.html) return false;
    db.updatePlanHtml(plan.id, html);
    return true;
  }
  if (task.plan_task !== null) return false; // linked to a plan that is gone: nothing to write back into
  db.saveOwnPlan(task.id, written, 'worker');
  return true;
}

/**
 * Refuse `plan` as the new plan of task `owner` when a task following its plan (and not yet done or cancelled) links a
 * step id the new plan doesn't have: that task would be left with no steps to do. `skip` leaves out a task whose
 * steps are checked on their own.
 */
export function checkFollowers(db: Db, owner: number, plan: ParsedPlan, skip?: number): void {
  const followers = db
    .planFollowers(owner)
    .filter((f) => f.id !== skip)
    .map((f) => ({ id: f.id, steps: planStepIds(f) }));
  const missing = missingFollowedSteps(plan, followers);
  if (missing.length) {
    const list = missing.map((m) => `#${m.id} (${m.missing.join(', ')})`).join(', ');
    throw new ActionError(`the new plan drops steps that tasks following it link: ${list}`);
  }
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

/**
 * Store or replace a task's own plan, under its numbered name (`<task id>-<slug>.html`). Not while the task runs: its
 * run's end would write the old plan back over it.
 */
export function attachPlan(db: Db, id: number, input: { html?: unknown }): TaskPlan {
  const task = requireTask(db, id);
  if (task.status === 'running' || task.status === 'cancel_requested') {
    throw new ActionError(`#${id} is ${task.status}; only ${EDITABLE_STATUSES.join(', ')} tasks can be edited`);
  }
  const { html, plan } = readPlanInput(object(input).html);
  checkFollowers(db, id, plan);
  return db.saveOwnPlan(id, html, 'attached');
}

/** One plan's HTML, for the dashboard to show in full. */
export function planHtml(db: Db, id: number, planId: number): { html: string } {
  const html = db.planHtml(id, planId);
  if (html === undefined) throw new ActionError('no such plan');
  return { html };
}
