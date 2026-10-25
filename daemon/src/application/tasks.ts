// Use cases for tasks: add, edit, and move them through the lifecycle on a person's request.
import { readFile, resolveCommit } from '../adapters/git.ts';
import type { Db } from '../db/index.ts';
import { PLAN_LIMIT, isPlanPath, parsePlan } from '../domain/plan/plan.ts';
import type { Repo } from '../domain/repo/repo.ts';
import { EDITABLE_STATUSES, type Task, defaultTitle, planStepIds } from '../domain/task/task.ts';
import { isSyncing } from './conflicts.ts';
import { warnStuckDependents } from './dependencies.ts';
import { ActionError } from './errors.ts';
import { closePullRequest } from './pull-requests.ts';

/** Step ids as the CLI types them (a,b) or the API sends them (an array); null when none are named. */
function stepList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  const list = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) throw new ActionError('plan_steps must be a list of step ids');
  const ids = [...new Set(list.map((id: string) => id.trim()).filter(Boolean))];
  return ids.length ? ids : null;
}

/**
 * Refuse a plan link that doesn't hold: the plan must be a plan file on the repo's base branch (plans are
 * committed there before their tasks are queued) and every step id must be one of its steps.
 */
async function checkPlanLink(repo: Repo, path: string, steps: string[] | null): Promise<void> {
  if (!isPlanPath(path) || path.split('/').includes('..'))
    throw new ActionError(`plan: ${path} is not a plan path (an .html file under docs/plans/)`);
  const commit = (await resolveCommit(repo.path, repo.base_branch)) ?? (await resolveCommit(repo.path, `origin/${repo.base_branch}`));
  if (!commit) throw new ActionError(`plan: base branch "${repo.base_branch}" of ${repo.name} has no commits`);
  const file = await readFile(repo.path, commit, path, PLAN_LIMIT + 1);
  if (!file) throw new ActionError(`plan: ${path} is not on ${repo.name}'s base branch "${repo.base_branch}"; commit the plan there first`);
  const plan = file.truncated || file.size > PLAN_LIMIT ? null : parsePlan(file.bytes.toString('utf8'));
  if (!plan) throw new ActionError(`plan: ${path} is not an AgentDeck plan (see docs/plan-format.md)`);
  const have = new Set(plan.steps.map((step) => step.id));
  const unknown = (steps ?? []).filter((id) => !have.has(id));
  if (unknown.length) {
    const ids = plan.steps.flatMap((step) => (step.id ? [step.id] : []));
    throw new ActionError(`plan: ${path} has no step ${unknown.join(', ')} (it has ${ids.join(', ') || 'no steps with an id'})`);
  }
}

export async function addTask(
  db: Db,
  input: {
    repo?: string;
    prompt: string;
    title?: string;
    priority?: number;
    model?: string;
    max_turns?: number;
    max_attempts?: number;
    after_task?: number;
    plan_path?: string;
    plan_steps?: string[] | string;
  },
): Promise<Task> {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new ActionError('a prompt is required');
  if (input.after_task !== undefined && (!Number.isInteger(input.after_task) || !db.getTask(input.after_task)))
    throw new ActionError(`--after: no task #${input.after_task}`);
  const repos = db.listRepos();
  const repo = input.repo ? db.findRepo(input.repo) : repos.length === 1 ? repos[0] : undefined;
  if (!repo) throw new ActionError(input.repo ? `no repo "${input.repo}"` : 'choose a repo (more than one is registered)');
  if (repo.archived_at) throw new ActionError(`${repo.name} is archived; unarchive it first`);
  const plan_path = typeof input.plan_path === 'string' ? input.plan_path.trim() : '';
  const steps = stepList(input.plan_steps);
  if (plan_path) await checkPlanLink(repo, plan_path, steps);
  else if (steps) throw new ActionError('--steps needs --plan');
  return db.addTask({
    repo_id: repo.id,
    title: input.title?.trim() || defaultTitle(prompt),
    prompt,
    priority: input.priority,
    model: input.model || undefined,
    max_turns: input.max_turns,
    max_attempts: input.max_attempts,
    after_task: input.after_task,
    plan_path: plan_path || null,
    plan_steps: plan_path && steps ? JSON.stringify(steps) : null,
  });
}

/**
 * Change a waiting or unsuccessful task's title, prompt, priority, model, turn limit, attempt limit or plan link.
 * `plan_path` null or '' clears the link (and its steps); a new `plan_path` drops the old steps unless `plan_steps` names some;
 * `plan_steps` null or '' means every unfinished step.
 */
export async function editTask(
  db: Db,
  id: number,
  patch: {
    title?: string;
    prompt?: string;
    priority?: number;
    model?: string;
    max_turns?: number;
    max_attempts?: number;
    plan_path?: string | null;
    plan_steps?: string[] | string | null;
  },
): Promise<Task> {
  const task = db.getTask(id);
  if (!task) throw new ActionError('no such task');
  const fields: Parameters<Db['editTask']>[1] = {};

  const text = (key: 'title' | 'prompt' | 'model') => {
    const value = patch[key];
    if (value === undefined) return;
    if (typeof value !== 'string' || !value.trim()) throw new ActionError(`${key} cannot be empty`);
    fields[key] = value.trim();
  };
  const whole = (key: 'priority' | 'max_turns' | 'max_attempts', min: number, max: number) => {
    const value = patch[key];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      throw new ActionError(`${key} must be a whole number from ${min} to ${max}`);
    fields[key] = value;
  };
  text('title');
  text('prompt');
  text('model');
  whole('priority', -1000, 1000);
  whole('max_turns', 1, 500);
  whole('max_attempts', 1, 20);

  if (patch.plan_path !== undefined || patch.plan_steps !== undefined) {
    if (patch.plan_path !== null && patch.plan_path !== undefined && typeof patch.plan_path !== 'string')
      throw new ActionError('plan_path must be text');
    const given = typeof patch.plan_path === 'string' ? patch.plan_path.trim() : patch.plan_path;
    const path = given === undefined ? task.plan_path : given || null;
    const steps = patch.plan_steps !== undefined ? stepList(patch.plan_steps) : given === undefined ? planStepIds(task) : null;
    if (path === null && steps) throw new ActionError('--steps needs --plan');
    if (path !== null) {
      const repo = db.getRepo(task.repo_id);
      if (!repo) throw new ActionError('the task has no repo');
      await checkPlanLink(repo, path, steps);
    }
    fields.plan_path = path;
    fields.plan_steps = path && steps ? JSON.stringify(steps) : null;
  }

  if (!Object.keys(fields).length) throw new ActionError('nothing to change');
  const edited = db.editTask(id, fields);
  if (!edited) {
    const now = db.getTask(id)?.status ?? task.status;
    throw new ActionError(`#${id} is ${now}; only ${EDITABLE_STATUSES.join(', ')} tasks can be edited`);
  }
  return edited;
}

/** Returns 'cancelled' for idle tasks, 'stopping' when a running worker has been asked to stop. */
export function cancelTask(db: Db, id: number): 'cancelled' | 'stopping' {
  const t = db.applyEvent(id, { type: 'cancel' });
  if (!t) throw new ActionError(`#${id} can't be cancelled from its current state`);
  warnStuckDependents(db, id);
  return t.status === 'cancel_requested' ? 'stopping' : 'cancelled';
}

/** Accept a planner proposal into the queue. */
export function approveTask(db: Db, id: number): void {
  if (!db.applyEvent(id, { type: 'approve' })) throw new ActionError(`#${id} is not a proposal`);
}

export function rejectTask(db: Db, id: number): void {
  if (!db.applyEvent(id, { type: 'reject' })) throw new ActionError(`#${id} is not a proposal`);
  warnStuckDependents(db, id);
}

/** Another attempt. A `note` ("request changes") is kept on the timeline and goes first in the next run's prompt. */
export function retryTask(db: Db, id: number, note?: string): void {
  const t = db.getTask(id);
  if (!t) throw new ActionError('no such task');
  if (isSyncing(id)) throw new ActionError(`#${id} is being brought up to date with its base branch; try again when that is done`);
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  // One more attempt on top of what has been used.
  if (!db.applyEvent(id, { type: 'retry' }, { reason: note?.trim() || null })) throw new ActionError(`#${id} is ${t.status}`);
}

/** Close a task's open PR without merging it. Tasks waiting on it become stuck. */
export async function closeTaskPr(db: Db, id: number): Promise<void> {
  const t = db.getTask(id);
  if (!t) throw new ActionError('no such task');
  if (!t.pr_url || t.pr_state !== 'open') throw new ActionError(`#${id} has no open pull request`);
  try {
    await closePullRequest(db, t);
  } catch (err) {
    throw new ActionError(`could not close the PR: ${(err as Error).message}`);
  }
}
