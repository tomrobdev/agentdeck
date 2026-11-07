// Task links: a task depends on any number of others, each link a kind. Pure: no I/O. (docs/plans/task-links.html)
//
// - builds_on: the task uses the other's code, so it starts once the other is done and merged.
// - after: the task runs on its own and only its merge waits for the other's.

import type { PrMode } from '../pull-request/pr.ts';
import type { Task } from './task.ts';

export type LinkKind = 'builds_on' | 'after';

/** `task_id` depends on `on`. */
export interface Link {
  task_id: number;
  on: number;
  kind: LinkKind;
}

/** `pr_mode` is that of the dependency's repo: a done task in a repo that opens PRs isn't met until its PR is merged. */
export type Dependency = Pick<Task, 'status' | 'pr_url' | 'pr_state' | 'done_by'> & { pr_mode: PrMode };

/** A dependency, and the links it has itself (stuck spreads down its builds-on links). */
export type LinkTarget = Dependency & { links: Link[] };

/**
 * Where a link's other task stands. Mirrors `notWaiting` in db/tasks.ts. A stuck one carries its reason twice: as a
 * sentence ("#10 failed") and as the clause that follows a mention of it ("which failed"), for a chained reason.
 */
type Standing =
  { kind: 'met' } | { kind: 'waiting'; on: number; reason: string } | { kind: 'stuck'; on: number; reason: string; which: string };

function standing(on: number, dependency: Dependency | undefined): Standing {
  const id = `#${on}`;
  const stuck = (reason: string, which: string): Standing => ({ kind: 'stuck', on, reason, which });
  if (!dependency) return stuck(`${id} no longer exists`, 'which no longer exists');
  switch (dependency.status) {
    case 'done':
      // Done and merged; or done in a repo that opens no PRs; or a person said so and its PR is not open.
      if (dependency.pr_state === 'merged') return { kind: 'met' };
      if (dependency.pr_url === null && dependency.pr_state === null && dependency.pr_mode === 'off') return { kind: 'met' };
      if (dependency.done_by === 'person' && dependency.pr_state !== 'open') return { kind: 'met' };
      if (dependency.pr_state === 'closed') return stuck(`${id}'s PR was closed without merging`, 'whose PR was closed without merging');
      if (dependency.pr_state === 'failed') return stuck(`${id}'s PR could not be opened`, 'whose PR could not be opened');
      if (dependency.pr_state === 'open') return { kind: 'waiting', on, reason: `${id}'s PR is not merged yet` };
      return { kind: 'waiting', on, reason: `${id}'s PR is not opened yet` };
    case 'failed':
      return stuck(`${id} failed`, 'which failed');
    case 'blocked':
      return stuck(`${id} is blocked`, 'which is blocked');
    case 'cancelled':
      return stuck(`${id} was cancelled`, 'which was cancelled');
    default:
      return { kind: 'waiting', on, reason: `${id} is not done yet` };
  }
}

/** Whether the other task of an after link was rejected or is gone, so it will never land: cancelled, its PR closed, or deleted. */
function neverLands(dependency: Dependency | undefined): boolean {
  if (!dependency) return true;
  return dependency.status === 'cancelled' || (dependency.status === 'done' && dependency.pr_state === 'closed');
}

/**
 * Where one link stands:
 * - builds_on: `met` (the other is done and merged), `waiting` (still on its way), or `stuck` (it won't get
 *   there on its own: failed, blocked, cancelled, its PR closed or not openable, or gone).
 * - after: `met` once the other has landed, or will never land (cancelled, its PR closed, or gone); otherwise
 *   `unlanded`, with the reason, and the task's merge waits. A failed or blocked task, or a PR that could not be opened,
 *   can still land after a retry, so those wait.
 */
export type LinkState =
  | { kind: 'met' }
  | { kind: 'waiting'; on: number; reason: string }
  | { kind: 'stuck'; on: number; reason: string }
  | { kind: 'unlanded'; on: number; reason: string };

export function linkState(link: Pick<Link, 'on' | 'kind'>, dependency: Dependency | undefined): LinkState {
  const s = standing(link.on, dependency);
  if (link.kind === 'builds_on') return s.kind === 'stuck' ? { kind: 'stuck', on: s.on, reason: s.reason } : s;
  if (s.kind === 'met' || neverLands(dependency)) return { kind: 'met' };
  return { kind: 'unlanded', on: s.on, reason: s.reason };
}

/**
 * Whether a task may start, from its builds-on links (after links never stop a start):
 * - none: it builds on nothing
 * - met: everything it builds on is done and merged
 * - waiting: `on` lists what it builds on that is still on its way
 * - stuck: something it builds on, or something that builds on in turn and so on down, won't get there on its own.
 *   `on` is that root and `reason` is its reason: "#10 failed" when it builds on #10 itself, "waits on #10 (via #12),
 *   which failed" when the root is further down. A human has to act; retrying the root releases the chain.
 * Mirrors `notWaiting` in db/tasks.ts.
 */
export type StartState =
  { kind: 'none' } | { kind: 'met' } | { kind: 'waiting'; on: number[] } | { kind: 'stuck'; on: number; reason: string };

export function startState(task: { id: number }, links: Link[], lookup: (id: number) => LinkTarget | undefined): StartState {
  const own = links.filter((l) => l.task_id === task.id && l.kind === 'builds_on');
  if (own.length === 0) return { kind: 'none' };
  const visited = new Set<number>([task.id]);
  /** The stuck root at or below `on`, following builds-on links down through tasks that are not done; `via` is the way down. */
  const root = (on: number, via: number[], dep: LinkTarget | undefined, s: Standing): { on: number; reason: string } | null => {
    if (s.kind === 'stuck')
      return { on, reason: via.length ? `waits on #${on} (via ${via.map((v) => `#${v}`).join(', ')}), ${s.which}` : s.reason };
    // A task that is gone is stuck, so the walk is at a task that exists from here.
    const target = dep!;
    if (s.kind === 'met' || target.status === 'done' || visited.has(on)) return null;
    visited.add(on);
    for (const next of target.links) {
      if (next.kind !== 'builds_on') continue;
      const nextDep = lookup(next.on);
      const r = root(next.on, [...via, on], nextDep, standing(next.on, nextDep));
      if (r) return r;
    }
    return null;
  };
  const waiting: number[] = [];
  for (const link of own) {
    const dep = lookup(link.on);
    const s = standing(link.on, dep);
    const r = root(link.on, [], dep, s);
    if (r) return { kind: 'stuck', ...r };
    if (s.kind === 'waiting') waiting.push(link.on);
  }
  return waiting.length ? { kind: 'waiting', on: waiting } : { kind: 'met' };
}

/** The after links whose other task has not landed yet, each with why: the task's merge waits for them. */
export function unlandedAfter(links: Link[], lookup: (id: number) => Dependency | undefined): { on: number; reason: string }[] {
  const unlanded: { on: number; reason: string }[] = [];
  for (const link of links) {
    if (link.kind !== 'after') continue;
    const s = linkState(link, lookup(link.on));
    if (s.kind === 'unlanded') unlanded.push({ on: s.on, reason: s.reason });
  }
  return unlanded;
}

/**
 * What the link functions read: a task's links, the tasks that depend on it (through links of either kind) and a task as a
 * link's other end. application/task/dependencies.ts builds one that queries the database when asked, and one from a
 * single read of every link, for a list of tasks.
 */
export interface LinkIndex {
  linksOf: (id: number) => Link[];
  dependentsOf: (id: number) => { id: number; status: string; kind: LinkKind }[];
  target: (id: number) => LinkTarget | undefined;
}

/** A task that builds on another: one of LinkIndex's dependents through a builds-on link. */
type Builder = { id: number; status: string };

/** The tasks that depend on task `id` through a builds-on link. */
const buildingOn = (id: number, l: LinkIndex): Builder[] => l.dependentsOf(id).filter((d) => d.kind === 'builds_on');

/**
 * The queued tasks that can't start because of task `id`, however many builds-on links down: those whose own start
 * state is stuck on `id`, so retrying `id` releases them. One stuck on something else on the way (a cancelled task
 * between them) is left out: retrying `id` would not release it. The walk stops at done tasks, which started already.
 */
export function stuckOn(id: number, l: LinkIndex): Builder[] {
  const stuck: Builder[] = [];
  const seen = new Set<number>([id]);
  const stack = [id];
  while (stack.length) {
    for (const t of buildingOn(stack.pop()!, l)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (t.status === 'queued') {
        const s = startState(t, l.linksOf(t.id), l.target);
        if (s.kind === 'stuck' && s.on === id) stuck.push(t);
      }
      if (t.status !== 'done') stack.push(t.id);
    }
  }
  return stuck.sort((a, b) => a.id - b.id);
}

/**
 * The queued tasks that build on task `id` and that merging `id` leaves free to start. One that also waits on another
 * task it builds on, or is stuck on one, is left out.
 */
export function releasedBy(id: number, l: LinkIndex): Builder[] {
  const merged = (on: number): LinkTarget | undefined => {
    const t = l.target(on);
    return on === id && t ? { ...t, status: 'done', pr_state: 'merged' } : t;
  };
  return buildingOn(id, l).filter((t) => t.status === 'queued' && startState(t, l.linksOf(t.id), merged).kind === 'met');
}

/**
 * Why `task` may not get a link to `on`, or null if it may. `links` is every link there is: a link to `on` makes a
 * cycle when `on` already reaches `task` through links of either kind.
 */
export function linkError(task: number, on: number, links: Link[]): string | null {
  if (task === on) return `#${task} can't depend on itself`;
  if (links.some((l) => l.task_id === task && l.on === on)) return `#${task} is already linked to #${on}`;
  const seen = new Set<number>();
  const stack = [on];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === task) return `linking #${task} to #${on} would make a cycle`;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const l of links) if (l.task_id === at) stack.push(l.on);
  }
  return null;
}

/**
 * Why `task` (in `status`) may not build on `on`, or null if it may. A task builds on another's code from its first run, so
 * once it has started (running, done, or stopped after a run) a builds-on link would gate nothing; an after link still
 * orders its merge.
 */
export function buildsOnError(task: number, status: string, on: number): string | null {
  if (status === 'proposed' || status === 'queued') return null;
  return `#${task} has started already, so it can't build on #${on}; make it an after link instead`;
}
