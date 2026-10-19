// Filtering and sorting task lists, for `agentdeck ls`. Pure: no I/O.
// The dashboard's task list (app/src/components/TaskList.vue) uses the same groups, states and sorts.
import type { TaskStatus } from './lifecycle.ts';
import type { TaskSummary } from './task.ts';

/** A task as listed: with where it stands on its `after_task`, as waitingFor reports it. */
export type ListedTask = TaskSummary & { waiting: { on: number; stuck: string | null } | null };

type Test = (t: ListedTask) => boolean;

const is =
  (...statuses: TaskStatus[]): Test =>
  (t) =>
    statuses.includes(t.status);
const waiting: Test = (t) => t.status === 'queued' && !!t.waiting && !t.waiting.stuck;
const stuck: Test = (t) => t.status === 'queued' && !!t.waiting?.stuck;

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
  'pr-open': (t) => t.status === 'done' && t.pr_state === 'open',
  merged: (t) => t.status === 'done' && t.pr_state === 'merged',
  'pr-closed': (t) => t.status === 'done' && t.pr_state === 'closed',
  'no-pr': (t) => t.status === 'done' && !t.pr_url,
};

/** Names for several states at once, matching the dashboard's tabs. A stuck task needs you, so it isn't active. */
const GROUPS: Record<string, Test> = {
  active: (t) => STATES.running(t) || (t.status === 'queued' && !stuck(t)),
  'needs-you': (t) => ['proposed', 'blocked', 'failed', 'stuck'].some((s) => STATES[s](t)),
};

export const STATE_NAMES = [...Object.keys(GROUPS), ...Object.keys(STATES)];

type Compare = (a: ListedTask, b: ListedTask) => number;

/** Running first, then what needs a decision, then the queue, then finished work. */
const ATTENTION: Record<TaskStatus, number> = {
  running: 0,
  cancel_requested: 0,
  proposed: 1,
  blocked: 2,
  failed: 3,
  queued: 4,
  done: 5,
  cancelled: 6,
};

export const SORTS: Record<string, Compare> = {
  attention: (a, b) => ATTENTION[a.status] - ATTENTION[b.status] || b.priority - a.priority || b.id - a.id,
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
  return [t.title, t.branch, t.model, t.blocked_reason].some((s) => s?.toLowerCase().includes(q));
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
