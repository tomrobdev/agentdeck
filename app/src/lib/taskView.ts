// How the queue is grouped and shown. What a person may do with a task, how the queue is filtered and sorted and what a blocked
// task needs are the daemon's domain (task/lifecycle.ts, listing.ts, needs.ts, stage.ts); this file re-exports what the views use.
import type { AutoMergeView, Needs, Status, TaskStatus, TaskSummary } from '../api';
import { type PersonEvent, personEvents } from '../../../daemon/src/domain/task/lifecycle.ts';
import { DECISION_STATES, FILTER_STATES, SORT_OPTIONS, filterTasks } from '../../../daemon/src/domain/task/listing.ts';
import { canInstallWith, depsRequest, readNeeds as readNeedsJson } from '../../../daemon/src/domain/task/needs.ts';
import {
  STATUS_GROUPS,
  type StatusGroup,
  canStartMerge,
  hasOpenPr,
  isMerged,
  isReview,
  isStuck,
  isWaiting,
  statusGroup,
} from '../../../daemon/src/domain/task/stage.ts';
import { EDITABLE_STATUSES, MODELS } from '../../../daemon/src/domain/task/task.ts';
import type { GroupBy } from './queueDisplay.ts';

// The board's move rule is in boardMove.ts, which the daemon's tests import.
export { STATUS_GROUPS, type StatusGroup, canStartMerge, hasOpenPr, isMerged, isReview, isStuck, isWaiting, statusGroup };
export { FILTER_STATES, MODELS, SORT_OPTIONS, type PersonEvent, personEvents };
export * from './boardMove';

/**
 * The tab a task opens on from the queue: a running task, or one with a resolve run under way, on its live log (the latest
 * run); a task in review as a diff.
 */
export const openingTab = (t: TaskSummary): 'overview' | 'changes' | 'runs' =>
  t.status === 'running' || t.sync?.resolving ? 'runs' : isReview(t) ? 'changes' : 'overview';

/** Tasks that wait on you: proposals to approve, blocked tasks and PRs to review. The queue filter that shows them. */
export const NEED_YOU_STATES = DECISION_STATES;
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

/** The integer a level is set to from a menu: its lower bound, and 0 for no priority. */
export const levelPriority = (l: (typeof PRIORITY_LEVELS)[number]): number => (Number.isFinite(l.min) ? l.min : 0);

export const priorityLevel = (p: number): PriorityLevel => PRIORITY_LEVELS.find((l) => p >= l.min)!.key;

/** A tooltip for the auto-merge mark: the daemon's label, then its reasons, one to a line. */
export const autoMergeTip = (v: AutoMergeView): string => [v.label, ...v.reasons].join('\n');

export type { GroupBy };
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

/** The tasks that pass the filters (sorting is groupTasks'). */
export function applyFilters(tasks: TaskSummary[], f: Filters): TaskSummary[] {
  // A state the daemon no longer has (kept in a saved view) filters nothing.
  const states = f.states.filter((k) => FILTER_STATES.some((s) => s.key === k));
  return filterTasks(tasks, { states, repos: f.repos, source: f.source, search: f.search, sort: 'newest' });
}

export interface Group {
  key: string;
  label: string;
  tasks: TaskSummary[];
}

/** Split sorted tasks into groups, in a stable order; empty status and priority groups are kept so they can be shown. */
export function groupTasks(tasks: TaskSummary[], by: GroupBy, sort: string): Group[] {
  const compare = (SORT_OPTIONS.find((s) => s.key === sort) ?? SORT_OPTIONS[0]).compare;
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

export { branchName } from '../../../daemon/src/domain/branch/branch.ts';

export const canEdit = (t: Pick<TaskSummary, 'status'>) => EDITABLE_STATUSES.includes(t.status);
/** A done task's open PR has failing checks: they can be sent back to the worker (POST /api/tasks/:id/fix-checks). */
export const canFixChecks = (t: Pick<TaskSummary, 'status' | 'pr_state' | 'checks'>) => isReview(t) && (t.checks?.failing ?? 0) > 0;
/** The one-key retry in the queue is for work that went wrong, not for re-running finished work. */
export const quickRetry = (t: Pick<TaskSummary, 'status' | 'waiting' | 'pr_state'>) =>
  personEvents(t).includes('retry') && statusGroup(t) === 'needs-you';

/** What a blocked task's worker said it needs; null for any other task or an unreadable value. */
export const readNeeds = (t: Pick<TaskSummary, 'status' | 'needs'>): Needs | null =>
  t.status === 'blocked' ? readNeedsJson(t.needs ?? null) : null;

/** The package names of a deps request, without its `--dev` flag. */
export const depsPackages = (n: Needs) => depsRequest(n.items).packages;
export const depsAreDev = (n: Needs) => depsRequest(n.items).dev;

export { canInstallWith };

/** A repo's network setting with a host added once. */
export function withHost(networkJson: string, host: string): string[] {
  let hosts: string[] = [];
  try {
    const parsed: unknown = JSON.parse(networkJson);
    if (Array.isArray(parsed)) hosts = parsed.filter((h): h is string => typeof h === 'string');
  } catch {
    // an unreadable setting counts as none
  }
  return hosts.includes(host) ? hosts : [...hosts, host];
}

export const statusLabel = (s: TaskStatus) => (s === 'cancel_requested' ? 'stopping' : s);
