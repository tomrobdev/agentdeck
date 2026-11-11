// Task links: a task depends on any number of others, each link a kind.

import type { TaskId } from '../../shared/index.ts';
import type { PullRequest } from '../../landing/index.ts';
import type { PrMode } from '../../repos/index.ts';
import type { TaskStatus } from '../lifecycle/lifecycle.ts';
import { isReview, stageOf } from '../task/stage.ts';
import type { DoneState } from '../task/task.ts';

export type LinkKind = 'builds_on' | 'after';

/** `task_id` depends on `on`. */
export interface Link {
  task_id: TaskId;
  on: TaskId;
  kind: LinkKind;
}

type DependencyState = DoneState | { status: Exclude<TaskStatus, 'done'> };

/** `pr_mode` is that of the dependency's repo: a done task in a repo that opens PRs isn't met until its PR is merged. */
export type Dependency = DependencyState & { pr: Pick<PullRequest, 'state'> | null; pr_mode: PrMode };

/** A task that depends on another, and the kind of that link. */
export interface Dependent {
  id: TaskId;
  status: TaskStatus;
  kind: LinkKind;
}

/** A task at the end of a link: what its link states are read from. */
export type LinkedTask = Dependency & { id: TaskId };

/** A dependency, and the links it has itself (stuck spreads down its builds-on links). */
export type LinkTarget = Dependency & { links: Link[] };

type Standing =
  { kind: 'met' } | { kind: 'waiting'; on: TaskId; reason: string } | { kind: 'stuck'; on: TaskId; reason: string; which: string };

function standing(on: TaskId, dependency: Dependency | undefined): Standing {
  const id = `#${on}`;
  const stuck = (reason: string, which: string): Standing => ({ kind: 'stuck', on, reason, which });
  if (!dependency) return stuck(`${id} no longer exists`, 'which no longer exists');
  switch (dependency.status) {
    case 'done':
      const state = dependency.pr?.state ?? null;
      if (state === 'merged') return { kind: 'met' };
      if (state === null && dependency.pr_mode === 'off') return { kind: 'met' };
      if (dependency.done_by === 'person' && state !== 'open') return { kind: 'met' };
      if (state === 'closed') return stuck(`${id}'s PR was closed without merging`, 'whose PR was closed without merging');
      if (state === 'failed') return stuck(`${id}'s PR could not be opened`, 'whose PR could not be opened');
      if (state === 'open') return { kind: 'waiting', on, reason: `${id}'s PR is not merged yet` };
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

function neverLands(dependency: Dependency | undefined): boolean {
  if (!dependency) return true;
  return dependency.status === 'cancelled' || (dependency.status === 'done' && dependency.pr?.state === 'closed');
}

/**
 * Where one link stands:
 * - builds_on: `met` (the other is done and merged), `waiting` (still on its way), or `stuck` (it won't get
 *   there on its own: failed, blocked, cancelled, its PR closed or not openable, or gone).
 * - after: `met` once the other has landed, or will never land (cancelled, its PR closed, or gone); otherwise
 *   `unlanded`, with the reason, and the task's merge waits. A failed or blocked task, or a PR that could not be opened,
 *   can still land after a retry, so those wait.
 * A dependency marked done by a person (`agentdeck done`) stays met: the person says the work is finished.
 */
export type LinkState =
  | { kind: 'met' }
  | { kind: 'waiting'; on: TaskId; reason: string }
  | { kind: 'stuck'; on: TaskId; reason: string }
  | { kind: 'unlanded'; on: TaskId; reason: string };

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
 * Mirrors `notWaiting` in db/work/tasks-status.ts.
 */
export type StartState =
  { kind: 'none' } | { kind: 'met' } | { kind: 'waiting'; on: TaskId[] } | { kind: 'stuck'; on: TaskId; reason: string };

export function startState(task: { id: TaskId }, links: Link[], lookup: (id: TaskId) => LinkTarget | undefined): StartState {
  const own = links.filter((l) => l.task_id === task.id && l.kind === 'builds_on');
  if (own.length === 0) return { kind: 'none' };
  const visited = new Set<TaskId>([task.id]);
  const root = (on: TaskId, via: TaskId[], dep: LinkTarget | undefined, s: Standing): { on: TaskId; reason: string } | null => {
    if (s.kind === 'stuck')
      return { on, reason: via.length ? `waits on #${on} (via ${via.map((v) => `#${v}`).join(', ')}), ${s.which}` : s.reason };
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
  const waiting: TaskId[] = [];
  for (const link of own) {
    const dep = lookup(link.on);
    const s = standing(link.on, dep);
    const r = root(link.on, [], dep, s);
    if (r) return { kind: 'stuck', ...r };
    if (s.kind === 'waiting') waiting.push(link.on);
  }
  return waiting.length ? { kind: 'waiting', on: waiting } : { kind: 'met' };
}

export function unlandedAfter(links: Link[], lookup: (id: TaskId) => Dependency | undefined): { on: TaskId; reason: string }[] {
  const unlanded: { on: TaskId; reason: string }[] = [];
  for (const link of links) {
    if (link.kind !== 'after') continue;
    const s = linkState(link, lookup(link.on));
    if (s.kind === 'unlanded') unlanded.push({ on: s.on, reason: s.reason });
  }
  return unlanded;
}

/**
 * What the link functions read: a task's links, the tasks that depend on it (through links of either kind) and a task as a
 * link's other end. application/work/dependencies.ts builds one that queries the database when asked (`liveLinks`), and one
 * from a single read of every link, for a list of tasks (`loadedLinks`).
 */
export interface LinkIndex {
  linksOf: (id: TaskId) => Link[];
  dependentsOf: (id: TaskId) => { id: TaskId; status: string; kind: LinkKind }[];
  target: (id: TaskId) => LinkTarget | undefined;
}

type Builder = { id: TaskId; status: string };

const buildingOn = (id: TaskId, l: LinkIndex): Builder[] => l.dependentsOf(id).filter((d) => d.kind === 'builds_on');

export function stuckOn(id: TaskId, l: LinkIndex): Builder[] {
  const stuck: Builder[] = [];
  const seen = new Set<TaskId>([id]);
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

export function releasedBy(id: TaskId, l: LinkIndex): Builder[] {
  const merged = (on: TaskId): LinkTarget | undefined => {
    const t = l.target(on);
    return on === id && t ? { ...t, status: 'done', done_by: null, pr: { state: 'merged' } } : t;
  };
  return buildingOn(id, l).filter((t) => t.status === 'queued' && startState(t, l.linksOf(t.id), merged).kind === 'met');
}

export function linkError(task: TaskId, on: TaskId, links: Link[]): string | null {
  if (task === on) return `#${task} can't depend on itself`;
  if (links.some((l) => l.task_id === task && l.on === on)) return `#${task} is already linked to #${on}`;
  const seen = new Set<TaskId>();
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

export function buildsOnError(task: TaskId, status: string, on: TaskId): string | null {
  if (status === 'proposed' || status === 'queued') return null;
  return `#${task} has started already, so it can't build on #${on}; make it an after link instead`;
}

export function buildsOnRepoError(on: TaskId, repo: { name: string; pr_mode: PrMode }): string | null {
  if (repo.pr_mode !== 'off') return null;
  return `#${on} is in ${repo.name}, which opens no PRs, so its work never reaches the base: make it an after link instead`;
}

export function prModeOffError(repo: string, unmet: TaskId[]): string | null {
  if (unmet.length === 0) return null;
  const names = unmet.map((id) => `#${id}`).join(', ');
  return `${repo} can't stop opening PRs while ${names} ${unmet.length === 1 ? 'builds' : 'build'} on a task that is not merged yet: wait for ${unmet.length === 1 ? 'it' : 'them'} to start, or cancel ${unmet.length === 1 ? 'it' : 'them'}`;
}

export function unblocksOf(task: Parameters<typeof stageOf>[0] & { id: TaskId }, links: LinkIndex): TaskId[] {
  if (!isReview(stageOf(task))) return [];
  return releasedBy(task.id, links).map((t) => t.id);
}

/** A task's link as views show it: the other task, the kind and where the link stands. */
export interface LinkView {
  on: TaskId;
  kind: LinkKind;
  state: LinkState['kind'];
}

export function linkViews(id: TaskId, links: LinkIndex): LinkView[] {
  return links.linksOf(id).map((l) => ({ on: l.on, kind: l.kind, state: linkState(l, links.target(l.on)).kind }));
}

export function dependentViews(id: TaskId, links: LinkIndex): { id: TaskId; kind: LinkKind }[] {
  return links.dependentsOf(id).map((d) => ({ id: d.id, kind: d.kind }));
}
