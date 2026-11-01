// Task links: a task depends on any number of others, each link a kind. Pure: no I/O. (docs/plans/task-links.html)
//
// - builds_on: the task uses the other's code, so it starts once the other is done and merged.
// - after: the task runs on its own and only its merge waits for the other's.

export type LinkKind = 'builds_on' | 'after';

/** `task_id` depends on `on`. */
export interface Link {
  task_id: number;
  on: number;
  kind: LinkKind;
}

/** `pr_mode` is that of the dependency's repo: a done task in a repo that opens PRs isn't met until its PR is merged. */
export type Dependency = { status: string; pr_url: string | null; pr_state: string | null; pr_mode: string; done_by: string | null };

/** A dependency, and the links it has itself (stuck spreads down its builds-on links). */
export type LinkTarget = Dependency & { links: Link[] };

/** Where a link's other task stands. Mirrors DEPENDENCY_MET in db/tasks.ts. */
type Standing = { kind: 'met' } | { kind: 'waiting'; on: number; reason: string } | { kind: 'stuck'; on: number; reason: string };

function standing(on: number, dependency: Dependency | undefined): Standing {
  const id = `#${on}`;
  if (!dependency) return { kind: 'stuck', on, reason: `${id} no longer exists` };
  switch (dependency.status) {
    case 'done':
      // Done and merged; or done in a repo that opens no PRs; or a person said so and its PR is not open.
      if (dependency.pr_state === 'merged') return { kind: 'met' };
      if (dependency.pr_url === null && dependency.pr_state === null && dependency.pr_mode === 'off') return { kind: 'met' };
      if (dependency.done_by === 'person' && dependency.pr_state !== 'open') return { kind: 'met' };
      if (dependency.pr_state === 'closed') return { kind: 'stuck', on, reason: `${id}'s PR was closed without merging` };
      if (dependency.pr_state === 'failed') return { kind: 'stuck', on, reason: `${id}'s PR could not be opened` };
      if (dependency.pr_state === 'open') return { kind: 'waiting', on, reason: `${id}'s PR is not merged yet` };
      return { kind: 'waiting', on, reason: `${id}'s PR is not opened yet` };
    case 'failed':
      return { kind: 'stuck', on, reason: `${id} failed` };
    case 'blocked':
      return { kind: 'stuck', on, reason: `${id} is blocked` };
    case 'cancelled':
      return { kind: 'stuck', on, reason: `${id} was cancelled` };
    default:
      return { kind: 'waiting', on, reason: `${id} is not done yet` };
  }
}

/**
 * Where one link stands:
 * - builds_on: `met` (the other is done and merged), `waiting` (still on its way), or `stuck` (it won't get
 *   there on its own: failed, blocked, cancelled, its PR closed or not openable, or gone).
 * - after: `met` once the other has landed, or is gone; otherwise `holding` the task's merge, with the reason.
 */
export type LinkState =
  | { kind: 'met' }
  | { kind: 'waiting'; on: number; reason: string }
  | { kind: 'stuck'; on: number; reason: string }
  | { kind: 'holding'; on: number; reason: string };

export function linkState(link: Pick<Link, 'on' | 'kind'>, dependency: Dependency | undefined): LinkState {
  const s = standing(link.on, dependency);
  if (link.kind === 'builds_on') return s;
  // An after link has no start to hold, so a task that is gone is nothing to wait for.
  if (s.kind === 'met' || !dependency) return { kind: 'met' };
  return { kind: 'holding', on: s.on, reason: s.reason };
}

/**
 * Whether a task may start, from its builds-on links (after links never hold a start):
 * - none: it builds on nothing
 * - met: everything it builds on is done and merged
 * - waiting: `on` lists what it builds on that is still on its way
 * - stuck: something it builds on, or something that builds on in turn and so on down, won't get there on its own.
 *   `on` is that root and `reason` is its reason. A human has to act; retrying the root releases the chain.
 * Mirrors NOT_WAITING in db/tasks.ts.
 */
export type StartState =
  { kind: 'none' } | { kind: 'met' } | { kind: 'waiting'; on: number[] } | { kind: 'stuck'; on: number; reason: string };

export function startState(task: { id: number }, links: Link[], lookup: (id: number) => LinkTarget | undefined): StartState {
  const own = links.filter((l) => l.task_id === task.id && l.kind === 'builds_on');
  if (own.length === 0) return { kind: 'none' };
  const visited = new Set<number>([task.id]);
  /** The stuck root at or below `on`, following builds-on links down through tasks that are not done. */
  const root = (on: number): { on: number; reason: string } | null => {
    const dep = lookup(on);
    const s = standing(on, dep);
    if (s.kind === 'stuck') return s;
    if (s.kind === 'met' || !dep || dep.status === 'done' || visited.has(on)) return null;
    visited.add(on);
    for (const next of dep.links) {
      if (next.kind !== 'builds_on') continue;
      const r = root(next.on);
      if (r) return r;
    }
    return null;
  };
  for (const link of own) {
    const r = root(link.on);
    if (r) return { kind: 'stuck', ...r };
  }
  const waiting = own.filter((l) => standing(l.on, lookup(l.on)).kind === 'waiting').map((l) => l.on);
  return waiting.length ? { kind: 'waiting', on: waiting } : { kind: 'met' };
}

/** The after links that still hold a task's merge, each with why. */
export function mergeHold(links: Link[], lookup: (id: number) => Dependency | undefined): { on: number; reason: string }[] {
  const held: { on: number; reason: string }[] = [];
  for (const link of links) {
    if (link.kind !== 'after') continue;
    const s = linkState(link, lookup(link.on));
    if (s.kind === 'holding') held.push({ on: s.on, reason: s.reason });
  }
  return held;
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
