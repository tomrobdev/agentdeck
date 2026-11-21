import type { AutoMergeView, Needs, Status, TaskStatus, TaskSummary } from '#api/types.ts';
import { personEvents } from '#daemon/domain/work/index.ts';
import { DECISION_STATES, FILTER_STATES, SORT_OPTIONS, filterTasks } from '#daemon/domain/work/index.ts';
import { type UnblockQuestion, depsRequest } from '#daemon/domain/work/index.ts';
import { STATUS_GROUPS, isReview, statusGroup } from '#daemon/domain/work/index.ts';
import { EDITABLE_STATUSES } from '#daemon/domain/work/index.ts';
import { parseTextList } from '#daemon/domain/shared/index.ts';
import type { GroupBy } from '#lib/work/queue/queue-display.ts';
import { needsOf, questionOf } from '#lib/shared/wire.ts';

export const openingTab = (t: TaskSummary): 'overview' | 'changes' | 'runs' =>
  t.status === 'running' || t.sync?.resolving ? 'runs' : isReview(t) ? 'changes' : 'overview';

export const NEED_YOU_STATES = DECISION_STATES;
export const needYouCount = (s: Pick<Status, 'headline'> | null | undefined): number => s?.headline.need_you ?? 0;

export const PRIORITY_LEVELS = [
  { key: 'urgent', label: 'Urgent', min: 60 },
  { key: 'high', label: 'High', min: 40 },
  { key: 'medium', label: 'Medium', min: 20 },
  { key: 'low', label: 'Low', min: 1 },
  { key: 'none', label: 'No priority', min: -Infinity },
] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number]['key'];

export const levelPriority = (l: (typeof PRIORITY_LEVELS)[number]): number => (Number.isFinite(l.min) ? l.min : 0);

const NO_PRIORITY = PRIORITY_LEVELS[PRIORITY_LEVELS.length - 1];

export const priorityLevel = (p: number): PriorityLevel => (PRIORITY_LEVELS.find((l) => p >= l.min) ?? NO_PRIORITY).key;

export const levelOf = (key: PriorityLevel): (typeof PRIORITY_LEVELS)[number] => PRIORITY_LEVELS.find((l) => l.key === key) ?? NO_PRIORITY;

export const autoMergeTip = (v: AutoMergeView): string => [v.label, ...v.reasons].join('\n');

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

export function applyFilters(tasks: TaskSummary[], f: Filters): TaskSummary[] {
  const states = f.states.filter((k) => FILTER_STATES.some((s) => s.key === k));
  return filterTasks(tasks, { states, repos: f.repos, source: f.source, search: f.search, sort: 'newest' });
}

export interface Group {
  key: string;
  label: string;
  tasks: TaskSummary[];
}

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
    case 'none':
      return [{ key: 'all', label: 'All tasks', tasks: sorted }];
  }
}

export const canEdit = (t: Pick<TaskSummary, 'status'>) => EDITABLE_STATUSES.includes(t.status);
export const canFixChecks = (t: Pick<TaskSummary, 'status' | 'pr_state' | 'checks'>) => isReview(t) && (t.checks?.failing ?? 0) > 0;
export const canFix = (t: Pick<TaskSummary, 'status' | 'pr_state'> & { waiting?: TaskSummary['waiting'] }) =>
  ['needs-you', 'review'].includes(statusGroup(t));
export const quickRetry = (t: Pick<TaskSummary, 'status' | 'waiting' | 'pr_state'>) =>
  personEvents(t).includes('retry') && statusGroup(t) === 'needs-you';

export const readNeeds = (t: Pick<TaskSummary, 'status' | 'needs'>): Needs | null => (t.status === 'blocked' ? needsOf(t.needs) : null);

export const readTaskQuestion = (t: Pick<TaskSummary, 'status' | 'question'>): UnblockQuestion | null =>
  t.status === 'blocked' ? questionOf(t.question) : null;

export const answerNote = (q: UnblockQuestion, option: string): string => `${q.question} ${option}`;

export const depsPackages = (n: Needs) => depsRequest(n.items).packages;
export const depsAreDev = (n: Needs) => depsRequest(n.items).dev;

export function withHost(networkJson: string, host: string): string[] {
  const hosts = parseTextList(networkJson);
  return hosts.includes(host) ? hosts : [...hosts, host];
}

export const statusLabel = (s: TaskStatus) => (s === 'cancel_requested' ? 'stopping' : s);

export const TASK_SOURCE: Record<TaskSummary['source'], { label: string; author: string }> = {
  manual: { label: 'Added by you', author: 'You' },
  planner: { label: 'Planner', author: 'The planner' },
  issue: { label: 'GitHub issue', author: 'Its GitHub issue' },
};
