// How the queue is filtered, grouped and sorted. Mirrors daemon/src/domain/task/listing.ts (the CLI's `ls`).
import type { Status, TaskStatus, TaskSummary } from './api';

type Test = (t: TaskSummary) => boolean;

const is =
  (...statuses: TaskStatus[]): Test =>
  (t) =>
    statuses.includes(t.status);
export const isStuck: Test = (t) => t.status === 'queued' && !!t.waiting?.stuck;
export const isWaiting: Test = (t) => t.status === 'queued' && !!t.waiting && !t.waiting.stuck;
/** A done task whose pull request waits on you. */
export const isReview: Test = (t) => t.status === 'done' && t.pr_state === 'open';

/** States to filter by, finer than a status. Same names as `agentdeck ls --status`. */
export const STATES: { key: string; label: string; test: Test }[] = [
  { key: 'running', label: 'Running', test: is('running', 'cancel_requested') },
  { key: 'queued', label: 'Queued', test: is('queued') },
  { key: 'waiting', label: 'Waiting', test: isWaiting },
  { key: 'stuck', label: 'Stuck', test: isStuck },
  { key: 'proposed', label: 'Proposed', test: is('proposed') },
  { key: 'blocked', label: 'Blocked', test: is('blocked') },
  { key: 'failed', label: 'Failed', test: is('failed') },
  { key: 'review', label: 'Review', test: isReview },
  { key: 'done', label: 'Done', test: is('done') },
  { key: 'pr-open', label: 'PR open', test: isReview },
  { key: 'merged', label: 'Merged', test: (t) => t.status === 'done' && t.pr_state === 'merged' },
  { key: 'pr-closed', label: 'PR closed', test: (t) => t.status === 'done' && t.pr_state === 'closed' },
  { key: 'no-pr', label: 'No PR', test: (t) => t.status === 'done' && !t.pr_url },
  { key: 'cancelled', label: 'Cancelled', test: is('cancelled') },
];

/** Status groups, in attention order. Every task is in exactly one; a stuck task needs you, so it isn't queued. */
export const STATUS_GROUPS = [
  { key: 'needs-you', label: 'Needs you' },
  { key: 'review', label: 'Review' },
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
    case 'done':
      return isReview(t) ? 'review' : 'done';
    default:
      return t.status;
  }
}

/** The tab a task opens on from the queue: a task in review is read as a diff. */
export const openingTab = (t: TaskSummary): 'overview' | 'changes' => (isReview(t) ? 'changes' : 'overview');

/** Tasks that wait on you: proposals to approve, blocked tasks and PRs to review. */
export const needYouCount = (s: Pick<Status, 'counts' | 'review'> | null | undefined): number =>
  (s?.counts.proposed ?? 0) + (s?.counts.blocked ?? 0) + (s?.review ?? 0);

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

const ATTENTION: Record<StatusGroup, number> = { 'needs-you': 0, review: 1, proposed: 2, running: 3, queued: 4, done: 5, cancelled: 6 };

type Compare = (a: TaskSummary, b: TaskSummary) => number;
export const SORTS: { key: string; label: string; compare: Compare }[] = [
  {
    key: 'attention',
    label: 'Needs attention',
    // In review, the PRs that hold up other tasks come first.
    compare: (a, b) =>
      ATTENTION[statusGroup(a)] - ATTENTION[statusGroup(b)] ||
      b.unblocks.length - a.unblocks.length ||
      b.priority - a.priority ||
      b.id - a.id,
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

/** What the daemon's lifecycle allows (domain/task/lifecycle.ts TRANSITIONS, task.ts EDITABLE_STATUSES). */
export const EDITABLE_STATUSES: TaskStatus[] = ['proposed', 'queued', 'blocked', 'failed'];
export const canEdit = (t: Pick<TaskSummary, 'status'>) => EDITABLE_STATUSES.includes(t.status);
export const canApprove = (t: Pick<TaskSummary, 'status'>) => t.status === 'proposed';
export const canRetry = (t: Pick<TaskSummary, 'status'>) => ['blocked', 'failed', 'done', 'cancelled'].includes(t.status);
export const canCancel = (t: Pick<TaskSummary, 'status'>) => ['queued', 'running', 'blocked', 'failed'].includes(t.status);
/** A done task whose PR is still open can be merged from its page (daemon application/pull-requests.ts mergeable). */
export const canMerge = (t: Pick<TaskSummary, 'status' | 'pr_url' | 'pr_state'>) =>
  t.status === 'done' && !!t.pr_url && t.pr_state === 'open';
/** The one-key retry in the queue is for work that went wrong, not for re-running finished work. */
export const quickRetry = (t: Pick<TaskSummary, 'status'>) => t.status === 'blocked' || t.status === 'failed';

export const statusLabel = (s: TaskStatus) => (s === 'cancel_requested' ? 'stopping' : s);

/** Board moves: which lifecycle event a drop from one status group to another means, if any. */
export type BoardMove = 'approve' | 'reject' | 'retry' | 'cancel';
export function boardMove(t: TaskSummary, to: StatusGroup): BoardMove | null {
  const from = statusGroup(t);
  if (from === to) return null;
  if (from === 'proposed') return to === 'queued' ? 'approve' : to === 'cancelled' ? 'reject' : null;
  if (to === 'queued' && canRetry(t)) return 'retry';
  // A running task is stopped from its page, never by a drop.
  if (to === 'cancelled' && canCancel(t) && t.status !== 'running') return 'cancel';
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
