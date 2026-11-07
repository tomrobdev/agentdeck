// Plans: stored in AgentDeck per task, named after the task they belong to (`112-plans-in-agentdeck.html`). A task
// follows its linked plan (plan_task) or else its own; each run gets it in the worktree's plan file and gives it back.
import { readGivenPlan, readPlanFile, writeGivenPlan } from '../adapters/plan-file.ts';
import type { Db } from '../db/index.ts';
import { type OwnPlan, toPlan } from '../db/plans.ts';
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
import { hasPlanLink, otherPlanOwner } from '../domain/task/plan-link.ts';
import { PLAN_ATTACHABLE_STATUSES, type Task } from '../domain/task/task.ts';
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
export function followedPlan(db: Db, task: Pick<Task, 'id' | 'plan'>): (OwnPlan & { steps: string[] | null }) | null {
  if (task.plan !== null) {
    const plan = db.ownPlan(task.plan.task);
    return plan ? { ...plan, steps: task.plan.steps } : null;
  }
  const own = db.ownPlan(task.id);
  return own ? { ...own, steps: null } : null;
}

/** The plan a run follows, for its prompt. A linked plan that is gone comes back with html null. */
export function planForRun(db: Db, task: Task): PromptPlan | null {
  const plan = followedPlan(db, task);
  if (plan) return { name: plan.name, html: plan.html, steps: plan.steps };
  return task.plan !== null ? { name: `#${task.plan.task}'s plan`, html: null, steps: task.plan.steps } : null;
}

/**
 * After a run, whatever its outcome, and before every run (in case a restart cut the last one off before it got here):
 * store what the worker left in the plan file. What the stored plan becomes is planAfterRun's to decide: the whole file, or only the
 * linked steps the run changed. A task with no plan that wrote one gets it as its own plan. What was taken is then
 * recorded as the given copy, so taking the same file again changes nothing. Returns whether a plan changed.
 */
export async function takePlanFile(db: Db, task: Task, worktree: string): Promise<boolean> {
  const [written, given] = await Promise.all([readPlanFile(worktree), readGivenPlan(worktree)]);
  if (written === null || !parsePlan(written)) return false;
  const changed = storeWrittenPlan(db, task, written, given);
  await writeGivenPlan(worktree, written);
  return changed;
}

/** Store a plan file a run left: no await, so the read, merge and write of the stored plan happen in one go. */
function storeWrittenPlan(db: Db, task: Task, written: string, given: string | null): boolean {
  const plan = followedPlan(db, task);
  if (plan) {
    const own = otherPlanOwner(task) === null;
    const html = planAfterRun({ stored: plan.html, given, written, ids: plan.steps, own, followed: own && db.planShared(task.id) });
    if (html === plan.html) return false;
    db.updatePlanHtml(plan.id, html);
    return true;
  }
  if (hasPlanLink(task)) return false; // linked to a plan that is gone: nothing to write back into
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
    .map((f) => ({ id: f.id, steps: f.plan?.steps ?? null }));
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
  const steps = followedSteps(db, task);
  return plan && steps ? { name: plan.name, steps } : null;
}

/** The plans a task shows: the plan it follows when that belongs to another task, then its own, oldest first. */
export function plansShown(db: Db, task: Pick<Task, 'id' | 'plan'>): TaskPlan[] {
  const own = db.plansForTask(task.id);
  const owner = otherPlanOwner(task);
  const linked = owner === null ? undefined : db.ownPlan(owner);
  return linked ? [toPlan(linked), ...own] : own;
}

/**
 * Store or replace a task's own plan, under its numbered name (`<task id>-<slug>.html`). Not while the task runs: its
 * run's end would write the old plan back over it. The store checks that in the same write as the plan and the edit
 * it records, which tells a cut-off follower to start afresh.
 */
export function attachPlan(db: Db, id: number, input: { html?: unknown }): TaskPlan {
  const task = requireTask(db, id);
  const notNow = (status: string) => new ActionError(`#${id} is ${status}; a plan can't be attached while it runs`);
  if (!PLAN_ATTACHABLE_STATUSES.includes(task.status)) throw notNow(task.status);
  const { html, plan } = readPlanInput(object(input).html);
  checkFollowers(db, id, plan);
  const saved = db.attachOwnPlan(id, html);
  if (!saved) throw notNow(db.getTask(id)?.status ?? task.status);
  return saved;
}

/** One plan's HTML, for the dashboard to show in full. */
export function planHtml(db: Db, id: number, planId: number): { html: string } {
  const html = db.planHtml(id, planId);
  if (html === undefined) throw new ActionError('no such plan');
  return { html };
}
