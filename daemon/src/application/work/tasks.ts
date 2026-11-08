// Use cases for tasks: add, edit, and move them through the lifecycle on a person's request.
import { removeWorktree } from '../../adapters/git.ts';
import type { Db } from '../../db/index.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import type { TaskStatus } from '../../domain/work/index.ts';
import { archivedRepoError, maxAttemptsError, maxTurnsError, modelError, priorityError } from '../../domain/work/index.ts';
import { planOwnerOf } from '../../domain/work/index.ts';
import { EDITABLE_STATUSES, RUNNING_STATUSES, type Task, defaultTitle } from '../../domain/work/index.ts';
import { refuseWhileSyncing } from './checkout-locks.ts';
import { warnStuckDependents } from './dependencies.ts';
import { newLinks } from './links.ts';
import { ActionError, flag, object, refuse, requireTask, requireTaskRepo, text, whole } from '../shared/input.ts';
import { checkFollowers } from './plans.ts';
import { checkPlanLink, planRequest, stepList } from './plan-link.ts';

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
    /** Tasks this one builds on (it starts once they are done and merged). */
    builds_on?: TaskId[];
    /** Tasks this one lands after (it runs at once; only its merge waits). */
    after?: TaskId[];
    /** The task whose plan this one follows (that task's own plan, or the one it follows), in the same repo. */
    plan_task?: TaskId;
    /** A plan for the new task to own and follow, stored as `<task id>-<slug>.html`. Not with plan_task. */
    plan_html?: string;
    plan_steps?: string[] | string;
    /** File it as a proposal, waiting for a person to approve it, instead of queueing it. */
    propose?: boolean;
  },
): Promise<Task> {
  const body = object(input);
  const propose = flag(body, 'propose');
  const prompt = text(body, 'prompt', { empty: true });
  if (!prompt) throw new ActionError('a prompt is required');
  const title = text(body, 'title', { empty: true });
  const model = text(body, 'model', { empty: true });
  refuse(modelError(model));
  const repoName = text(body, 'repo', { empty: true });
  const priority = whole(body, 'priority', priorityError);
  const max_turns = whole(body, 'max_turns', maxTurnsError);
  const max_attempts = whole(body, 'max_attempts', maxAttemptsError);
  const planAsked = planRequest(body);
  const links = newLinks(db, input);
  const repos = db.listRepos();
  const repo = repoName ? db.findRepo(repoName) : repos.length === 1 ? repos[0] : undefined;
  if (!repo) throw new ActionError(repoName ? `no repo "${repoName}"` : 'choose a repo (more than one is registered)');
  refuse(archivedRepoError(repo));
  const steps = stepList(input.plan_steps);
  const checked = checkPlanLink(db, () => repo, planAsked ?? { task: null }, steps);
  const own_plan = 'ownPlan' in checked ? checked.ownPlan : undefined;
  const owner = 'owner' in checked ? checked.owner : null;
  const linked = owner !== null || own_plan !== undefined;
  return db.addTask({
    repo_id: repo.id,
    title: title || defaultTitle(prompt),
    prompt,
    priority,
    model: model || undefined,
    max_turns,
    max_attempts,
    links,
    plan_task: owner,
    own_plan,
    plan_steps: linked && steps ? steps : null,
    status: propose ? 'proposed' : 'queued',
  });
}

/**
 * Change a waiting or unsuccessful task's title, prompt, priority, model, turn limit, attempt limit or plan link.
 * `plan_task` null clears the link to another task's plan (and its steps), refused for a task that follows its own plan,
 * which can only be replaced; a new link, by `plan_task` or `plan_html` (which becomes the task's
 * own plan, replacing any it had), drops the old steps unless `plan_steps` names some; `plan_steps` null or '' means
 * every unfinished step.
 */
export async function editTask(
  db: Db,
  id: TaskId,
  patch: {
    title?: string;
    prompt?: string;
    priority?: number;
    model?: string;
    max_turns?: number;
    max_attempts?: number;
    plan_task?: TaskId | null;
    plan_html?: string;
    plan_steps?: string[] | string | null;
  },
): Promise<Task> {
  const task = requireTask(db, id);
  const fields: Parameters<Db['editTask']>[1] = {};

  const body = object(patch);
  for (const key of ['title', 'prompt', 'model'] as const) {
    const value = text(body, key);
    if (value !== undefined) fields[key] = value;
  }
  refuse(modelError(fields.model));
  for (const [key, rule] of [
    ['priority', priorityError],
    ['max_turns', maxTurnsError],
    ['max_attempts', maxAttemptsError],
  ] as const) {
    const value = whole(body, key, rule);
    if (value !== undefined) fields[key] = value;
  }

  const planAsked = planRequest(body);
  let ownPlan: string | undefined;
  if (planAsked !== undefined || patch.plan_steps !== undefined) {
    const steps = patch.plan_steps !== undefined ? stepList(patch.plan_steps) : planAsked === undefined ? (task.plan?.steps ?? null) : null;
    const asked = planAsked ?? { task: task.plan?.task ?? null };
    // A null link means "follow its own plan", so clearing it would keep the plan and widen its steps to all of them.
    if (planAsked !== undefined && 'task' in asked && asked.task === null && planOwnerOf(task) === id && db.ownPlan(id)) {
      throw new ActionError(
        `#${id} has a plan of its own, which can't be cleared: replace it with --plan <file>, or follow another task's plan with --plan <task number>`,
      );
    }
    const checked = checkPlanLink(db, () => requireTaskRepo(db, task), asked, steps);
    let link: TaskId | null;
    if ('ownPlan' in checked) {
      // The task's own steps are the ones just checked; the tasks following its plan keep theirs.
      checkFollowers(db, id, checked.plan, id);
      link = id;
      ownPlan = checked.ownPlan;
    } else link = checked.owner;
    fields.plan_task = link;
    fields.plan_steps = link !== null && steps ? steps : null;
  }

  if (!Object.keys(fields).length) throw new ActionError('nothing to change');
  // The task's own plan is stored in the same guarded write, so a task the daemon claimed meanwhile keeps its plan.
  const edited = db.editTask(id, fields, { ownPlan });
  if (!edited) {
    const now = db.getTask(id)?.status ?? task.status;
    throw new ActionError(`#${id} is ${now}; only ${EDITABLE_STATUSES.join(', ')} tasks can be edited`);
  }
  return edited;
}

/** Returns 'cancelled' for idle tasks, 'stopping' when a running worker has been asked to stop. */
export function cancelTask(db: Db, id: TaskId): 'cancelled' | 'stopping' {
  const t = db.applyEvent(id, { type: 'cancel' });
  if (!t) throw new ActionError(`#${id} can't be cancelled from its current state`);
  warnStuckDependents(db, id);
  return t.status === 'cancel_requested' ? 'stopping' : 'cancelled';
}

/** Accept a planner proposal into the queue. */
export function approveTask(db: Db, id: TaskId): void {
  if (!db.applyEvent(id, { type: 'approve' })) throw new ActionError(`#${id} is not a proposal`);
}

export function rejectTask(db: Db, id: TaskId): void {
  if (!db.applyEvent(id, { type: 'reject' })) throw new ActionError(`#${id} is not a proposal`);
  warnStuckDependents(db, id);
}

/** Another attempt. A `note` ("request changes") is kept on the timeline and goes first in the next run's prompt. */
export function retryTask(db: Db, id: TaskId, note?: string, onlyFrom?: TaskStatus[]): void {
  const t = requireTask(db, id);
  refuseWhileSyncing(db, id);
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  // One more attempt on top of what has been used.
  if (!db.applyEvent(id, { type: 'retry' }, { reason: note?.trim() || null, onlyFrom }))
    throw new ActionError(`#${id} is ${db.getTask(id)?.status ?? t.status}`);
}

/**
 * A person finished or landed a blocked or failed task's work themselves. The optional `note` goes on the timeline.
 * Done releases the tasks waiting on it (unless its PR is open: they wait for the merge), so no warnStuckDependents.
 */
export function markDone(db: Db, id: TaskId, note?: string): void {
  const t = requireTask(db, id);
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  if (!db.applyEvent(id, { type: 'mark_done' }, { reason: note?.trim() || null }))
    throw new ActionError(`#${id} is ${db.getTask(id)?.status ?? t.status}; only blocked or failed tasks can be marked done`);
}

/** Remove a task's worktree; its branch is kept. Not while the task is running, or queued (it is about to run in it). */
export async function removeTaskWorktree(db: Db, id: TaskId): Promise<{ branch: string | null }> {
  const t = requireTask(db, id);
  if (RUNNING_STATUSES.includes(t.status)) throw new ActionError('task is running');
  if (t.status === 'queued') throw new ActionError('task is queued');
  const worktree = t.checkout?.worktree;
  if (!worktree) throw new ActionError('task has no worktree');
  refuseWhileSyncing(db, id);
  await removeWorktree(requireTaskRepo(db, t), worktree);
  db.setCheckout(t.id, { worktree: null });
  return { branch: t.checkout?.branch ?? null };
}
