// Use cases for tasks: add, edit, list them and remove their worktrees.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { archivedRepoError, maxAttemptsError, maxTurnsError, modelError, priorityError } from '#domain/work/index.ts';
import { missingTargetError, planOwnerOf, targetChangeError } from '#domain/work/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import { type ModelSource, newTaskModel } from '#domain/work/index.ts';
import { EDITABLE_STATUSES, type Task, WORKTREE_REMOVABLE_STATUSES, defaultTitle, promptGoal, shapePrompt } from '#domain/work/index.ts';
import { refuseWhileSyncing } from '#application/work/checkout-locks.ts';
import { newLinks, refuseCrossTargets, targetEnd } from '#application/work/links.ts';
import { ActionError, flag, object, refuse, requireTask, requireTaskRepo, text, textOrNull, whole } from '#application/shared/input.ts';
import { checkFollowers } from '#application/work/plans.ts';
import { checkPlanLink, planRequest, stepList } from '#application/work/plan-link.ts';

async function checkedTarget(app: App, repo: Repo, asked: string | null): Promise<string | null> {
  if (!asked || asked === repo.base_branch) return null;
  const facts = await app.workspace.inspectRepo(repo.path, asked);
  if (!facts?.base) throw new ActionError(missingTargetError(asked), undefined, 'not_found');
  return asked;
}

export async function addTask(
  app: App,
  input: {
    repo?: string;
    prompt: string;
    title?: string;
    priority?: number;
    model?: string;
    target?: string | null;
    max_turns?: number;
    max_attempts?: number;
    builds_on?: TaskId[];
    after?: TaskId[];
    plan_task?: TaskId;
    plan_html?: string;
    plan_steps?: string[] | string;
    propose?: boolean;
  },
): Promise<Task & { model_source: ModelSource }> {
  const body = object(input);
  const propose = flag(body, 'propose');
  const written = text(body, 'prompt', { empty: true });
  if (!written) throw new ActionError('a prompt is required');
  const prompt = shapePrompt(written).prompt;
  const title = text(body, 'title', { empty: true });
  const model = text(body, 'model', { empty: true });
  refuse(modelError(model));
  const repoName = text(body, 'repo', { empty: true });
  const priority = whole(body, 'priority', priorityError);
  const max_turns = whole(body, 'max_turns', maxTurnsError);
  const max_attempts = whole(body, 'max_attempts', maxAttemptsError);
  const planAsked = planRequest(body);
  const links = newLinks(app, input);
  const repos = app.listRepos();
  const repo = repoName ? app.findRepo(repoName) : repos.length === 1 ? repos[0] : undefined;
  if (!repo)
    throw new ActionError(
      repoName ? `no repo "${repoName}"` : 'choose a repo (more than one is registered)',
      undefined,
      repoName ? 'not_found' : 'invalid',
    );
  refuse(archivedRepoError(repo));
  const target = await checkedTarget(app, repo, textOrNull(body, 'target') ?? null);
  refuseCrossTargets(
    app,
    { id: null, repo_id: repo.id, target, base_branch: repo.base_branch },
    links.filter((l) => l.kind === 'builds_on').map((l) => l.on),
  );
  const steps = stepList(input.plan_steps);
  const checked = checkPlanLink(app, () => repo, planAsked ?? { task: null }, steps);
  const own_plan = 'ownPlan' in checked ? checked.ownPlan : undefined;
  const owner = 'owner' in checked ? checked.owner : null;
  const linked = owner !== null || own_plan !== undefined;
  const chosen = newTaskModel(model, repo, app.modelSettings().default_model);
  const task = app.addTask({
    repo_id: repo.id,
    title: title || defaultTitle(promptGoal(prompt) || prompt),
    prompt,
    priority,
    model: chosen.model,
    max_turns,
    max_attempts,
    target,
    links,
    plan_task: owner,
    own_plan,
    plan_steps: linked && steps ? steps : null,
    status: propose ? 'proposed' : 'queued',
  });
  return { ...task, model_source: chosen.source };
}

export async function editTask(
  app: App,
  id: TaskId,
  patch: {
    title?: string;
    prompt?: string;
    priority?: number;
    model?: string;
    max_turns?: number;
    max_attempts?: number;
    target?: string | null;
    plan_task?: TaskId | null;
    plan_html?: string;
    plan_steps?: string[] | string | null;
  },
): Promise<Task> {
  const task = requireTask(app, id);
  const fields: Parameters<App['editTask']>[1] = {};

  const body = object(patch);
  for (const key of ['title', 'prompt', 'model'] as const) {
    const value = text(body, key);
    if (value !== undefined) fields[key] = value;
  }
  if (fields.prompt) fields.prompt = shapePrompt(fields.prompt).prompt;
  refuse(modelError(fields.model));
  for (const [key, rule] of [
    ['priority', priorityError],
    ['max_turns', maxTurnsError],
    ['max_attempts', maxAttemptsError],
  ] as const) {
    const value = whole(body, key, rule);
    if (value !== undefined) fields[key] = value;
  }

  const askedTarget = textOrNull(body, 'target');
  if (askedTarget !== undefined) {
    const repo = requireTaskRepo(app, task);
    const target = await checkedTarget(app, repo, askedTarget);
    if (target !== task.target) {
      refuse(targetChangeError(task), undefined, 'conflict');
      refuseCrossTargets(
        app,
        targetEnd(app, { ...task, target }),
        app
          .linksOf(id)
          .filter((l) => l.kind === 'builds_on')
          .map((l) => l.on),
        app.dependentsOf(id, 'builds_on').map((d) => d.id),
      );
      fields.target = target;
    }
  }

  const planAsked = planRequest(body);
  let ownPlan: string | undefined;
  if (planAsked !== undefined || patch.plan_steps !== undefined) {
    const steps = patch.plan_steps !== undefined ? stepList(patch.plan_steps) : planAsked === undefined ? (task.plan?.steps ?? null) : null;
    const asked = planAsked ?? { task: task.plan?.task ?? null };
    if (planAsked !== undefined && 'task' in asked && asked.task === null && planOwnerOf(task) === id && app.ownPlan(id)) {
      throw new ActionError(
        `#${id} has a plan of its own, which can't be cleared: replace it with --plan <file>, or follow another task's plan with --plan <task number>`,
      );
    }
    const checked = checkPlanLink(app, () => requireTaskRepo(app, task), asked, steps);
    let link: TaskId | null;
    if ('ownPlan' in checked) {
      checkFollowers(app, id, checked.plan, id);
      link = id;
      ownPlan = checked.ownPlan;
    } else link = checked.owner;
    fields.plan_task = link;
    fields.plan_steps = link !== null && steps ? steps : null;
  }

  if (!Object.keys(fields).length) throw new ActionError('nothing to change');
  const edited = app.editTask(id, fields, { ownPlan });
  if (!edited) {
    const latest = app.getTask(id);
    if (fields.target !== undefined && latest) refuse(targetChangeError(latest), undefined, 'conflict');
    const now = latest?.status ?? task.status;
    throw new ActionError(`#${id} is ${now}; only ${EDITABLE_STATUSES.join(', ')} tasks can be edited`, undefined, 'conflict');
  }
  return edited;
}

export async function removeTaskWorktree(app: App, id: TaskId): Promise<{ branch: string | null }> {
  const t = requireTask(app, id);
  if (!WORKTREE_REMOVABLE_STATUSES.includes(t.status))
    throw new ActionError(t.status === 'queued' ? 'task is queued' : 'task is running', undefined, 'conflict');
  const worktree = t.checkout?.worktree;
  if (!worktree) throw new ActionError('task has no worktree');
  refuseWhileSyncing(app, id);
  if (app.runsForTask(id).some((r) => !r.ended_at))
    throw new ActionError(`#${id} has a run going in its worktree; try again when it has ended`, undefined, 'conflict');
  await app.workspace.removeCheckout(requireTaskRepo(app, t), { worktree });
  app.setCheckout(t.id, { worktree: null });
  return { branch: t.checkout?.branch ?? null };
}

export const findTask = (app: App, id: TaskId): Task | undefined => app.getTask(id);

export const taskRuns = (app: App, id: TaskId) => app.runsForTask(id);

export const listTasks = (app: App): Task[] => app.listTasks();

export const openPrTasks = (app: App): Task[] => app.openPrTasks();
