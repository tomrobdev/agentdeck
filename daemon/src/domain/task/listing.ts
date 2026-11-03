// Filtering and sorting task lists: `agentdeck ls` and the dashboard's queue share it. Pure: no I/O.
import { STATUS_GROUPS, isMerged, isReview, isStuck, isWaiting, statusGroup } from './stage.ts';
import type { TaskStatus } from './lifecycle.ts';
import { RUNNING_STATUSES, type TaskSummary } from './task.ts';

/**
 * A task as listed: with where it stands on its builds-on links (as waitingFor reports it), the tasks merging its open PR lets
 * start and, from the API, its repo's name. A daemon from before `unblocks` existed sends none, which reads as empty.
 */
export type ListedTask = TaskSummary & { waiting: { on: number[]; stuck: string | null } | null; unblocks: number[] };
export type Listable = Pick<
  ListedTask,
  | 'id'
  | 'repo_id'
  | 'title'
  | 'status'
  | 'priority'
  | 'branch'
  | 'model'
  | 'stop_reason'
  | 'source'
  | 'pr_url'
  | 'pr_state'
  | 'waiting'
  | 'updated_at'
> & { repo?: string | null; unblocks?: number[] };

type Test = (t: Listable) => boolean;

const is =
  (...statuses: TaskStatus[]): Test =>
  (t) =>
    statuses.includes(t.status);

/** States finer than a status: a queued task may be waiting on --after or stuck, a done task may have a PR. In the dashboard's order. */
export const FILTER_STATES: { key: string; label: string; test: Test }[] = [
  { key: 'running', label: 'Running', test: is(...RUNNING_STATUSES) },
  { key: 'queued', label: 'Queued', test: is('queued') },
  { key: 'waiting', label: 'Waiting', test: isWaiting },
  { key: 'stuck', label: 'Stuck', test: isStuck },
  { key: 'proposed', label: 'Proposed', test: is('proposed') },
  { key: 'blocked', label: 'Blocked', test: is('blocked') },
  { key: 'failed', label: 'Failed', test: is('failed') },
  { key: 'review', label: 'Review', test: isReview },
  { key: 'done', label: 'Done', test: is('done') },
  { key: 'pr-open', label: 'PR open', test: isReview },
  { key: 'merged', label: 'Merged', test: isMerged },
  { key: 'pr-closed', label: 'PR closed', test: (t) => t.status === 'done' && t.pr_state === 'closed' },
  { key: 'no-pr', label: 'No PR', test: (t) => t.status === 'done' && !t.pr_url },
  { key: 'cancelled', label: 'Cancelled', test: is('cancelled') },
];

const stateTests = (keys: string[]): Test => {
  const tests = FILTER_STATES.filter((s) => keys.includes(s.key)).map((s) => s.test);
  return (t) => tests.some((test) => test(t));
};

/** Names for several states at once, for the CLI. A stuck task needs you, so it isn't active. */
const GROUPS: Record<string, Test> = {
  active: (t) => stateTests(['running'])(t) || (t.status === 'queued' && !isStuck(t)),
  'needs-you': stateTests(['blocked', 'failed', 'stuck']),
};

/** What the dashboard's "need you" chip filters by: proposals to approve, blocked tasks and PRs to review. Not the `needs-you` group. */
export const DECISION_STATES = ['proposed', 'blocked', 'review'];

const STATE_NAMES = [...Object.keys(GROUPS), ...FILTER_STATES.map((s) => s.key)];

type Compare = (a: Listable, b: Listable) => number;

/** Where a task sits in attention order: the index of its status group in STATUS_GROUPS. */
export const attentionRank = (t: Pick<Listable, 'status' | 'pr_state' | 'waiting'>): number =>
  STATUS_GROUPS.findIndex((g) => g.key === statusGroup(t));

const unblocks = (t: Listable) => t.unblocks?.length ?? 0;

export const SORT_OPTIONS: { key: string; label: string; compare: Compare }[] = [
  {
    key: 'attention',
    label: 'Needs attention',
    // In review, the PRs that hold up other tasks come first.
    compare: (a, b) => attentionRank(a) - attentionRank(b) || unblocks(b) - unblocks(a) || b.priority - a.priority || b.id - a.id,
  },
  { key: 'updated', label: 'Recently updated', compare: (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id },
  { key: 'newest', label: 'Newest', compare: (a, b) => b.id - a.id },
  { key: 'oldest', label: 'Oldest', compare: (a, b) => a.id - b.id },
  { key: 'priority', label: 'Priority', compare: (a, b) => b.priority - a.priority || b.id - a.id },
];

export interface ListFilter {
  /** State or group names; a task matching any of them is kept. Empty keeps every task. */
  states: string[];
  repo_id?: number;
  /** Repo names (`?` for a task without one); a task in any of them is kept. Empty keeps every task. */
  repos?: string[];
  source?: string | null;
  /** Matches `#id` or an id prefix, or text in the title, repo, branch, model or blocked reason. */
  search?: string;
  sort: string;
}

function stateTest(name: string): Test {
  const test = GROUPS[name] ?? FILTER_STATES.find((s) => s.key === name)?.test;
  if (!test) throw new Error(`unknown state "${name}" (use ${STATE_NAMES.join(', ')})`);
  return test;
}

function matchesSearch(t: Listable, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const id = q.replace(/^#/, '');
  if (/^\d+$/.test(id)) return String(t.id).startsWith(id) || t.title.toLowerCase().includes(q);
  return [t.title, t.repo, t.branch, t.model, t.stop_reason].some((s) => s?.toLowerCase().includes(q));
}

/** The tasks that pass the filter, sorted. Throws on an unknown state or sort, naming the valid ones. */
export function filterTasks<T extends Listable>(tasks: T[], filter: ListFilter): T[] {
  const compare = SORT_OPTIONS.find((s) => s.key === filter.sort)?.compare;
  if (!compare) throw new Error(`unknown sort "${filter.sort}" (use ${SORT_OPTIONS.map((s) => s.key).join(', ')})`);
  const tests = filter.states.map(stateTest);
  return tasks
    .filter(
      (t) =>
        (filter.repo_id === undefined || t.repo_id === filter.repo_id) &&
        (!filter.repos?.length || filter.repos.includes(t.repo ?? '?')) &&
        (!filter.source || t.source === filter.source) &&
        (!tests.length || tests.some((test) => test(t))) &&
        matchesSearch(t, filter.search ?? ''),
    )
    .sort(compare);
}
