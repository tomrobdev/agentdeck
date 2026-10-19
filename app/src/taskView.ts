// How the queue is filtered, grouped and sorted. Mirrors daemon/src/domain/task/listing.ts (the CLI's `ls`).
import type { TaskStatus, TaskSummary } from './api';

type Test = (t: TaskSummary) => boolean;

const is =
  (...statuses: TaskStatus[]): Test =>
  (t) =>
    statuses.includes(t.status);
export const isStuck: Test = (t) => t.status === 'queued' && !!t.waiting?.stuck;
export const isWaiting: Test = (t) => t.status === 'queued' && !!t.waiting && !t.waiting.stuck;

/** States to filter by, finer than a status. Same names as `agentdeck ls --status`. */
export const STATES: { key: string; label: string; test: Test }[] = [
  { key: 'running', label: 'Running', test: is('running', 'cancel_requested') },
  { key: 'queued', label: 'Queued', test: is('queued') },
  { key: 'waiting', label: 'Waiting', test: isWaiting },
  { key: 'stuck', label: 'Stuck', test: isStuck },
  { key: 'proposed', label: 'Proposed', test: is('proposed') },
  { key: 'blocked', label: 'Blocked', test: is('blocked') },
  { key: 'failed', label: 'Failed', test: is('failed') },
  { key: 'done', label: 'Done', test: is('done') },
  { key: 'pr-open', label: 'PR open', test: (t) => t.status === 'done' && t.pr_state === 'open' },
  { key: 'merged', label: 'Merged', test: (t) => t.status === 'done' && t.pr_state === 'merged' },
  { key: 'pr-closed', label: 'PR closed', test: (t) => t.status === 'done' && t.pr_state === 'closed' },
  { key: 'no-pr', label: 'No PR', test: (t) => t.status === 'done' && !t.pr_url },
  { key: 'cancelled', label: 'Cancelled', test: is('cancelled') },
];

/** Status groups, in attention order. Every task is in exactly one; a stuck task needs you, so it isn't queued. */
export const STATUS_GROUPS = [
  { key: 'needs-you', label: 'Needs you' },
  { key: 'proposed', label: 'Proposed' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'done', label: 'Done' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number]['key'];

export function statusGroup(t: TaskSummary): StatusGroup {
  switch (t.status) {
    case 'blocked':
    case 'failed':
      return 'needs-you';
    case 'queued':
      return isStuck(t) ? 'needs-you' : 'queued';
    case 'cancel_requested':
      return 'running';
    default:
      return t.status;
  }
}

/** Priority stays an integer (the scheduler orders by it); the UI shows it as one of five levels. */
export const PRIORITY_LEVELS = [
  { key: 'urgent', label: 'Urgent', min: 60 },
  { key: 'high', label: 'High', min: 40 },
  { key: 'medium', label: 'Medium', min: 20 },
  { key: 'low', label: 'Low', min: 1 },
  { key: 'none', label: 'No priority', min: -Infinity },
] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number]['key'];

export const priorityLevel = (p: number): PriorityLevel => PRIORITY_LEVELS.find((l) => p >= l.min)!.key;

const ATTENTION: Record<StatusGroup, number> = { 'needs-you': 0, proposed: 1, running: 2, queued: 3, done: 4, cancelled: 5 };

type Compare = (a: TaskSummary, b: TaskSummary) => number;
export const SORTS: { key: string; label: string; compare: Compare }[] = [
  {
    key: 'attention',
    label: 'Needs attention',
    compare: (a, b) => ATTENTION[statusGroup(a)] - ATTENTION[statusGroup(b)] || b.priority - a.priority || b.id - a.id,
  },
  { key: 'updated', label: 'Recently updated', compare: (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id },
  { key: 'newest', label: 'Newest', compare: (a, b) => b.id - a.id },
  { key: 'oldest', label: 'Oldest', compare: (a, b) => a.id - b.id },
  { key: 'priority', label: 'Priority', compare: (a, b) => b.priority - a.priority || b.id - a.id },
];

export type GroupBy = 'status' | 'repo' | 'priority' | 'none';
export const GROUP_BYS: { key: GroupBy; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'repo', label: 'Repo' },
  { key: 'priority', label: 'Priority' },
  { key: 'none', label: 'No grouping' },
];

export interface Filters {
  states: string[];
  repos: string[];
  source: 'manual' | 'planner' | null;
  search: string;
}

export const emptyFilters = (): Filters => ({ states: [], repos: [], source: null, search: '' });

export const hasFilters = (f: Filters) => !!(f.states.length || f.repos.length || f.source || f.search.trim());

function matchesSearch(t: TaskSummary, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const id = q.replace(/^#/, '');
  if (/^\d+$/.test(id)) return String(t.id).startsWith(id) || t.title.toLowerCase().includes(q);
  return [t.title, t.repo, t.branch, t.model, t.blocked_reason].some((s) => s?.toLowerCase().includes(q));
}

export function applyFilters(tasks: TaskSummary[], f: Filters): TaskSummary[] {
  const tests = STATES.filter((s) => f.states.includes(s.key)).map((s) => s.test);
  return tasks.filter(
    (t) =>
      (!tests.length || tests.some((test) => test(t))) &&
      (!f.repos.length || f.repos.includes(t.repo ?? '?')) &&
      (!f.source || t.source === f.source) &&
      matchesSearch(t, f.search),
  );
}

export interface Group {
  key: string;
  label: string;
  tasks: TaskSummary[];
}

/** Split sorted tasks into groups, in a stable order; empty status and priority groups are kept so they can be shown. */
export function groupTasks(tasks: TaskSummary[], by: GroupBy, sort: string): Group[] {
  const compare = SORTS.find((s) => s.key === sort)?.compare ?? SORTS[0].compare;
  const sorted = [...tasks].sort(compare);
  const bucket = (defs: { key: string; label: string }[], keyOf: (t: TaskSummary) => string): Group[] =>
    defs.map((d) => ({ key: d.key, label: d.label, tasks: sorted.filter((t) => keyOf(t) === d.key) }));
  switch (by) {
    case 'status':
      return bucket([...STATUS_GROUPS], statusGroup);
    case 'priority':
      return bucket([...PRIORITY_LEVELS], (t) => priorityLevel(t.priority));
    case 'repo': {
      const names = [...new Set(sorted.map((t) => t.repo ?? '?'))].sort();
      return bucket(
        names.map((n) => ({ key: n, label: n })),
        (t) => t.repo ?? '?',
      );
    }
    default:
      return [{ key: 'all', label: 'All tasks', tasks: sorted }];
  }
}

/** Board moves: which lifecycle event a drop from one status group to another means, if any. */
export type BoardMove = 'approve' | 'reject' | 'retry' | 'cancel';
export function boardMove(t: TaskSummary, to: StatusGroup): BoardMove | null {
  const from = statusGroup(t);
  if (from === to) return null;
  if (from === 'proposed') return to === 'queued' ? 'approve' : to === 'cancelled' ? 'reject' : null;
  if (to === 'queued' && ['blocked', 'failed', 'done', 'cancelled'].includes(t.status)) return 'retry';
  if (to === 'cancelled' && ['queued', 'blocked', 'failed'].includes(t.status)) return 'cancel';
  return null;
}

/** Per-browser view settings. Reads and writes never throw: storage can be missing or full. */
export function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`agentdeck.${key}`);
    if (raw === null) return fallback;
    const v = JSON.parse(raw);
    return typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback) ? { ...fallback, ...v } : v;
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: unknown): void {
  try {
    localStorage.setItem(`agentdeck.${key}`, JSON.stringify(value));
  } catch {
    // The view just won't be remembered.
  }
}
