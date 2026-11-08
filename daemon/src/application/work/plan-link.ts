// The plan link a task request asks for: its steps, the plan it follows, and the checks on both.
import type { Repositories as Db } from '../ports/repositories.ts';
import { type TaskId, parseId } from '../../domain/shared/index.ts';
import { type ParsedPlan, parsePlan } from '../../domain/work/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { stepsNeedPlanError } from '../../domain/work/index.ts';
import { ActionError, refuse } from '../shared/input.ts';
import { readPlanInput } from './plans.ts';

/** Step ids as the CLI types them (a,b) or the API sends them (an array); null when none are named. */
export function stepList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  const list = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) throw new ActionError('plan_steps must be a list of step ids');
  const ids = [...new Set(list.map((id: string) => id.trim()).filter(Boolean))];
  return ids.length ? ids : null;
}

/** Refuse step ids that are not steps of the plan. */
function checkSteps(name: string, plan: ParsedPlan, steps: string[] | null): void {
  const have = new Set(plan.steps.map((step) => step.id));
  const unknown = (steps ?? []).filter((id) => !have.has(id));
  if (unknown.length) {
    const ids = plan.steps.flatMap((step) => (step.id ? [step.id] : []));
    throw new ActionError(`plan: ${name} has no step ${unknown.join(', ')} (it has ${ids.join(', ') || 'no steps with an id'})`);
  }
}

/**
 * The task whose plan `--plan <number>` links: that task, which must be in the same repo, if it has a plan of its own;
 * else the task whose plan it follows. Refused when there is no plan to follow.
 */
function planOwner(db: Db, repo: Repo, on: TaskId): { owner: TaskId; name: string; plan: ParsedPlan } {
  const target = db.getTask(on);
  if (!target) throw new ActionError(`plan: there is no task #${on}`);
  if (target.repo_id !== repo.id) {
    throw new ActionError(`plan: #${on} is in ${db.getRepo(target.repo_id)?.name ?? 'another repo'}, not ${repo.name}`);
  }
  for (const owner of [on, target.plan?.task ?? null]) {
    const own = owner === null ? undefined : db.ownPlan(owner);
    const plan = own && parsePlan(own.html);
    if (owner !== null && own && plan) return { owner, name: own.name, plan };
  }
  throw new ActionError(`plan: #${on} has no plan`);
}

/** The plan link a request asks for: a task number (`plan_task`, null to clear) or a parsed plan (`plan_html`); undefined when it names neither. */
export type PlanRequest = { task: TaskId | null } | { html: string; plan: ParsedPlan };

export function planRequest(body: Record<string, unknown>): PlanRequest | undefined {
  const { plan_task, plan_html } = body;
  if (plan_task !== undefined && plan_html !== undefined) throw new ActionError('give a plan or a task number, not both');
  if (plan_html !== undefined) return readPlanInput(plan_html);
  if (plan_task === undefined) return undefined;
  if (plan_task === null || plan_task === '') return { task: null };
  const task = typeof plan_task === 'number' ? parseId<TaskId>(plan_task) : null;
  if (task === null) throw new ActionError('plan_task must be a task number');
  return { task };
}

/**
 * Check a plan link against its steps: a plan of its own (`ownPlan`, to be stored with the task), or the task whose plan
 * is followed (`owner`, null for no link, which can't have steps). `repo` is read only when another task's plan is linked.
 */
export function checkPlanLink(
  db: Db,
  repo: () => Repo,
  asked: PlanRequest,
  steps: string[] | null,
): { ownPlan: string; plan: ParsedPlan } | { owner: TaskId | null } {
  if ('html' in asked) {
    checkSteps('the plan', asked.plan, steps);
    return { ownPlan: asked.html, plan: asked.plan };
  }
  refuse(stepsNeedPlanError(asked.task, steps));
  if (asked.task === null) return { owner: null };
  const linked = planOwner(db, repo(), asked.task);
  checkSteps(linked.name, linked.plan, steps);
  return { owner: linked.owner };
}
