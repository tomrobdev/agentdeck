// Filtering and sorting task lists, for `agentdeck ls`. Pure: no I/O.
// Mirrored by the dashboard in app/src/taskView.ts: keep the states, groups and sorts in step.
import type { TaskStatus } from './lifecycle.ts';
import type { TaskSummary } from './task.ts';

/** A task as listed: with where it stands on its `after_task` (as waitingFor reports it) and the tasks its open PR holds up. */
export type ListedTask = TaskSummary & { waiting: { on: number; stuck: string | null } | null; unblocks: number[] };

type Test = (t: ListedTask) => boolean;

const is =
  (...statuses: TaskStatus[]): Test =>
  (t) =>
    statuses.includes(t.status);
const waiting: Test = (t) => t.status === 'queued' && !!t.waiting && !t.waiting.stuck;
const stuck: Test = (t) => t.status === 'queued' && !!t.waiting?.stuck;

const review: Test = (t) => t.status === 'done' && t.pr_state === 'open';
const merged: Test = (t) => t.status === 'done' && t.pr_state === 'merged';

/** States finer than a status: a queued task may be waiting on --after or stuck, a done task may have a PR. */
const STATES: Record<string, Test> = {
  proposed: is('proposed'),
  queued: is('queued'),
  running: is('running', 'cancel_requested'),
  done: is('done'),
  blocked: is('blocked'),
  failed: is('failed'),
  cancelled: is('cancelled'),
  waiting,
  stuck,
  review,
  'pr-open': review,
  merged,
  'pr-closed': (t) => t.status === 'done' && t.pr_state === 'closed',
  'no-pr': (t) => t.status === 'done' && !t.pr_url,
};

/** Names for several states at once, matching the dashboard's groups. A stuck task needs you, so it isn't active. */
const GROUPS: Record<string, Test> = {
  active: (t) => STATES.running(t) || (t.status === 'queued' && !stuck(t)),
  'needs-you': (t) => ['blocked', 'failed', 'stuck'].some((s) => STATES[s](t)),
};

const STATE_NAMES = [...Object.keys(GROUPS), ...Object.keys(STATES)];

type Compare = (a: ListedTask, b: ListedTask) => number;

/** The dashboard's status groups in attention order: what needs you, review, proposals, running, queued, done (merged too), cancelled. */
function attentionRank(t: ListedTask): number {
  if (GROUPS['needs-you'](t)) return 0;
  if (review(t)) return 1;
  return { proposed: 2, running: 3, cancel_requested: 3, queued: 4, done: 5, cancelled: 6, blocked: 0, failed: 0 }[t.status];
}

export const SORTS: Record<string, Compare> = {
  // In review, the PRs that hold up other tasks come first.
  attention: (a, b) =>
    attentionRank(a) - attentionRank(b) || b.unblocks.length - a.unblocks.length || b.priority - a.priority || b.id - a.id,
  updated: (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id,
  newest: (a, b) => b.id - a.id,
  oldest: (a, b) => a.id - b.id,
  priority: (a, b) => b.priority - a.priority || b.id - a.id,
};

export interface ListFilter {
  /** State or group names; a task matching any of them is kept. Empty keeps every task. */
  states: string[];
  repo_id?: number;
  /** Matches `#id` or an id prefix, or text in the title, branch, model or blocked reason. */
  search?: string;
  sort: string;
}

function stateTest(name: string): Test {
  const test = GROUPS[name] ?? STATES[name];
  if (!test) throw new Error(`unknown state "${name}" (use ${STATE_NAMES.join(', ')})`);
  return test;
}

function matchesSearch(t: ListedTask, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const id = q.replace(/^#/, '');
  if (/^\d+$/.test(id)) return String(t.id).startsWith(id) || t.title.toLowerCase().includes(q);
  return [t.title, t.branch, t.model, t.stop_reason].some((s) => s?.toLowerCase().includes(q));
}

/** The tasks that pass the filter, sorted. Throws on an unknown state or sort, naming the valid ones. */
export function filterTasks<T extends ListedTask>(tasks: T[], filter: ListFilter): T[] {
  const compare = SORTS[filter.sort];
  if (!compare) throw new Error(`unknown sort "${filter.sort}" (use ${Object.keys(SORTS).join(', ')})`);
  const tests = filter.states.map(stateTest);
  return tasks
    .filter(
      (t) =>
        (filter.repo_id === undefined || t.repo_id === filter.repo_id) &&
        (!tests.length || tests.some((test) => test(t))) &&
        matchesSearch(t, filter.search ?? ''),
    )
    .sort(compare);
}
