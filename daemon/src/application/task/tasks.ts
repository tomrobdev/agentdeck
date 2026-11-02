// Use cases for tasks: add, edit, and move them through the lifecycle on a person's request.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commitFiles, removeWorktree } from '../../adapters/git.ts';
import { runProgram } from '../../adapters/shell.ts';
import type { Db } from '../../db/index.ts';
import { type ParsedPlan, parsePlan } from '../../domain/plan/plan.ts';
import type { Repo } from '../../domain/repo/repo.ts';
import { INSTALL_NOTE, readNeeds } from '../../domain/task/needs.ts';
import { hasOpenPr } from '../../domain/task/stage.ts';
import {
  archivedRepoError,
  maxAttemptsError,
  maxTurnsError,
  modelError,
  priorityError,
  stepsNeedPlanError,
} from '../../domain/task/rules.ts';
import { EDITABLE_STATUSES, type Task, defaultTitle, planStepIds } from '../../domain/task/task.ts';
import { lastLine } from '../../domain/text.ts';
import { isSyncing } from '../sync.ts';
import { warnStuckDependents } from './dependencies.ts';
import { newLinks } from './links.ts';
import { ActionError, flag, object, refuse, requireTask, requireTaskRepo, text, whole } from '../input.ts';
import { closePullRequest } from '../pull-request/pull-requests.ts';
import { checkFollowers, readPlanInput } from '../plans.ts';

/** Step ids as the CLI types them (a,b) or the API sends them (an array); null when none are named. */
function stepList(value: unknown): string[] | null {
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
function planOwner(db: Db, repo: Repo, on: number): { owner: number; name: string; plan: ParsedPlan } {
  const target = db.getTask(on);
  if (!target) throw new ActionError(`plan: there is no task #${on}`);
  if (target.repo_id !== repo.id) {
    throw new ActionError(`plan: #${on} is in ${db.getRepo(target.repo_id)?.name ?? 'another repo'}, not ${repo.name}`);
  }
  for (const owner of [on, target.plan_task]) {
    const own = owner === null ? undefined : db.ownPlan(owner);
    const plan = own && parsePlan(own.html);
    if (owner !== null && own && plan) return { owner, name: own.name, plan };
  }
  throw new ActionError(`plan: #${on} has no plan`);
}

/** The plan link a request asks for: a task number (`plan_task`, null to clear) or a plan's HTML (`plan_html`); undefined when it names neither. */
function planRequest(body: Record<string, unknown>): { task: number | null } | { html: string } | undefined {
  const { plan_task, plan_html } = body;
  if (plan_task !== undefined && plan_html !== undefined) throw new ActionError('give a plan or a task number, not both');
  if (plan_html !== undefined) return { html: readPlanInput(plan_html).html };
  if (plan_task === undefined) return undefined;
  if (plan_task === null || plan_task === '') return { task: null };
  if (typeof plan_task !== 'number' || !Number.isInteger(plan_task) || plan_task < 1) {
    throw new ActionError('plan_task must be a task number');
  }
  return { task: plan_task };
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
    /** Tasks this one builds on (it starts once they are done and merged). */
    builds_on?: number[];
    /** Tasks this one lands after (it runs at once; only its merge waits). */
    after?: number[];
    /** The task whose plan this one follows (that task's own plan, or the one it follows), in the same repo. */
    plan_task?: number;
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
  let plan_task: number | null = null;
  let own_plan: string | undefined;
  if (planAsked && 'html' in planAsked) {
    checkSteps('the plan', parsePlan(planAsked.html)!, steps);
    own_plan = planAsked.html;
  } else if (planAsked?.task) {
    const linked = planOwner(db, repo, planAsked.task);
    checkSteps(linked.name, linked.plan, steps);
    plan_task = linked.owner;
  } else refuse(stepsNeedPlanError(null, steps));
  const linked = plan_task !== null || own_plan !== undefined;
  return db.addTask({
    repo_id: repo.id,
    title: title || defaultTitle(prompt),
    prompt,
    priority,
    model: model || undefined,
    max_turns,
    max_attempts,
    links,
    plan_task,
    own_plan,
    plan_steps: linked && steps ? JSON.stringify(steps) : null,
    status: propose ? 'proposed' : 'queued',
  });
}

/**
 * Change a waiting or unsuccessful task's title, prompt, priority, model, turn limit, attempt limit or plan link.
 * `plan_task` null clears the link (and its steps); a new link, by `plan_task` or `plan_html` (which becomes the task's
 * own plan, replacing any it had), drops the old steps unless `plan_steps` names some; `plan_steps` null or '' means
 * every unfinished step.
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
    plan_task?: number | null;
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
    const steps = patch.plan_steps !== undefined ? stepList(patch.plan_steps) : planAsked === undefined ? planStepIds(task) : null;
    let link: number | null;
    if (planAsked && 'html' in planAsked) {
      const plan = parsePlan(planAsked.html)!;
      checkSteps('the plan', plan, steps);
      // The task's own steps are the ones just checked; the tasks following its plan keep theirs.
      checkFollowers(db, id, plan, id);
      link = id;
      ownPlan = planAsked.html;
    } else {
      link = planAsked === undefined ? task.plan_task : planAsked.task;
      refuse(stepsNeedPlanError(link, steps));
      if (link !== null) {
        const linked = planOwner(db, requireTaskRepo(db, task), link);
        checkSteps(linked.name, linked.plan, steps);
        link = linked.owner;
      }
    }
    fields.plan_task = link;
    fields.plan_steps = link !== null && steps ? JSON.stringify(steps) : null;
  }

  if (!Object.keys(fields).length) throw new ActionError('nothing to change');
  // The task's own plan is stored first, so it is there when the task can next run; not for a task that can't be edited.
  if (ownPlan !== undefined) {
    if (!EDITABLE_STATUSES.includes(task.status))
      throw new ActionError(`#${id} is ${task.status}; only ${EDITABLE_STATUSES.join(', ')} tasks can be edited`);
    db.saveOwnPlan(id, ownPlan, 'attached');
  }
  const edited = db.editTask(id, fields, { plan: ownPlan !== undefined });
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
  const t = requireTask(db, id);
  if (isSyncing(db, id)) throw new ActionError(`#${id} is being brought up to date with its base branch; try again when that is done`);
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  // One more attempt on top of what has been used.
  if (!db.applyEvent(id, { type: 'retry' }, { reason: note?.trim() || null })) throw new ActionError(`#${id} is ${t.status}`);
}

/**
 * A person finished or landed a blocked or failed task's work themselves. The optional `note` goes on the timeline.
 * Done releases the tasks waiting on it (unless its PR is open: they wait for the merge), so no warnStuckDependents.
 */
export function markDone(db: Db, id: number, note?: string): void {
  const t = requireTask(db, id);
  if (note !== undefined && typeof note !== 'string') throw new ActionError('note must be text');
  if (!db.applyEvent(id, { type: 'mark_done' }, { reason: note?.trim() || null }))
    throw new ActionError(`#${id} is ${db.getTask(id)?.status ?? t.status}; only blocked or failed tasks can be marked done`);
}

const INSTALLERS = ['pnpm', 'yarn', 'npm'];
const LOCKFILES: Record<string, string> = { pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', npm: 'package-lock.json' };
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** An npm package spec: `name`, `@scope/name` or either with `@version-or-tag`. No shell metacharacters, no leading dash. */
const PACKAGE_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._^~*+-]*)?$/;

/** The packages a deps request names and whether they go in devDependencies (`--dev` or `-D` among the items). */
export function parseDepsRequest(items: string[]): { packages: string[]; dev: boolean } {
  const dev = items.some((i) => i === '--dev' || i === '-D');
  const packages = items.filter((i) => i !== '--dev' && i !== '-D');
  if (!packages.length) throw new ActionError('the request names no packages');
  const bad = packages.filter((p) => !PACKAGE_SPEC.test(p));
  if (bad.length) throw new ActionError(`not a valid package name: ${bad.join(' ')}`);
  return { packages, dev };
}

/**
 * Install the packages a blocked task asked for (NEEDS deps) on its branch, then retry it. Only a person's request
 * gets here (the API and the CLI); the worker and scheduler never call it. The package manager runs in the task's
 * worktree through the daemon, outside the worker's sandbox. On failure the task stays blocked.
 */
export async function installNeeds(db: Db, id: number): Promise<{ packages: string[]; dev: boolean }> {
  const task = requireTask(db, id);
  if (task.status !== 'blocked') throw new ActionError(`#${id} is ${task.status}, not blocked`);
  const needs = readNeeds(task.needs);
  if (needs?.kind !== 'deps') throw new ActionError(`#${id} has not asked for packages`);
  const repo = requireTaskRepo(db, task);
  const toolchain = repo.toolchain ?? '';
  if (!INSTALLERS.includes(toolchain))
    throw new ActionError(
      `${repo.name} uses ${toolchain || 'no detected toolchain'}: install ${needs.items.join(' ')} on the branch yourself, then retry`,
    );
  const { packages, dev } = parseDepsRequest(needs.items);
  if (!task.worktree || !existsSync(task.worktree)) throw new ActionError(`#${id} has no worktree to install into`);
  if (isSyncing(db, id)) throw new ActionError(`#${id} is being brought up to date with its base branch; try again when that is done`);

  const args = toolchain === 'npm' ? ['install', dev ? '--save-dev' : '--save', ...packages] : ['add', ...(dev ? ['-D'] : []), ...packages];
  const result = await runProgram(toolchain, args, task.worktree, INSTALL_TIMEOUT_MS);
  if (!result.passed) {
    throw new ActionError(`${toolchain} ${args[0]} failed: ${lastLine(result.output)}`);
  }
  const files = ['package.json', LOCKFILES[toolchain]].filter((f) => existsSync(join(task.worktree!, f)));
  try {
    await commitFiles(task.worktree, files, `agentdeck: add ${packages.join(' ')} for task #${id}`);
  } catch (err) {
    throw new ActionError(`installed, but could not commit: ${lastLine((err as Error).message)}`);
  }
  retryTask(db, id, `${INSTALL_NOTE} ${packages.join(' ')}${dev ? ' (dev)' : ''} on the branch at the person's request.`);
  return { packages, dev };
}

/** Close a task's open PR without merging it. Tasks waiting on it become stuck. */
export async function closeTaskPr(db: Db, id: number): Promise<void> {
  const t = requireTask(db, id);
  if (!t.pr_url || !hasOpenPr(t)) throw new ActionError(`#${id} has no open pull request`);
  try {
    await closePullRequest(db, t);
  } catch (err) {
    throw new ActionError(`could not close the PR: ${(err as Error).message}`);
  }
}

/** Remove a task's worktree; its branch is kept. Not while the task is running. */
export async function removeTaskWorktree(db: Db, id: number): Promise<{ branch: string | null }> {
  const t = requireTask(db, id);
  if (t.status === 'running' || t.status === 'cancel_requested') throw new ActionError('task is running');
  if (!t.worktree) throw new ActionError('task has no worktree');
  await removeWorktree(requireTaskRepo(db, t), t.worktree);
  db.setCheckout(t.id, { worktree: null });
  return { branch: t.branch };
}
